/**
 * src/services/connectivityIngestService.ts — the server half of the agent's
 * two connectivity streams (POST /agents/samples, stream "connectivity" and
 * "connectivityTraceroute").
 *
 * WHAT IS AND IS NOT TRUSTED FROM THE WIRE
 *  - The subject is the PUSHING agent's own asset (req.managedAgent.assetId);
 *    nothing in the body can name another host.
 *  - A sample naming a check this host is not a source of is REJECTED, not
 *    stored — a stolen bearer cannot write results under someone else's check.
 *  - The body-excerpt policy is ENFORCED here: an excerpt survives only on a
 *    failed run, or when the check keeps excerpts, and is re-cut to
 *    MAX_EXCERPT_CHARS. A misbehaving agent cannot make the database a copy of
 *    every response body it sees.
 *
 * WHAT NEVER HAPPENS HERE
 *  Nothing touches `monitorStatus`, `consecutiveFailures`, `lastMonitorAt` or
 *  the responseTime stream. A connectivity result describes the path from this
 *  host to a target; the host's own health is the responseTime stream's job.
 *
 * SCALE
 *  Per push: one source-row read for the pushing host (≤ MAX_CHECKS_PER_AGENT
 *  rows), one buffered enqueue, ≤ MAX_CHECKS_PER_AGENT tiny updates batched in
 *  one $transaction. A traceroute push adds ONE hop-resolution query for every
 *  hop IP in the batch — never a query per hop. At 2000 hosts × 60 s that is
 *  ~33 pushes/s, each a handful of indexed statements.
 */

import { createHash } from "node:crypto";
import { prisma } from "../db.js";
import { isValidIpAddress } from "../utils/cidr.js";
import { MAX_EXCERPT_CHARS } from "../utils/httpCheck.js";
import { logEvent } from "./eventLogService.js";
import { enqueueConnectivitySamples, type ConnectivitySampleRow } from "./sampleWriteBuffer.js";
import { recordConnectivitySamples, recordConnectivityPathChange } from "../metrics.js";

/** A path change within this long of the last one for the same (host, check)
 *  is recorded (the traceroute row keeps it) but writes no second Event — ECMP
 *  flapping between two equal-cost paths must not flood the Event table. */
export const PATH_CHANGE_EVENT_FLOOR_MS = 10 * 60_000;

export interface IngestResult {
  accepted: number;
  rejected: number;
}

export interface ConnectivitySampleInput {
  checkId: string;
  timestamp?: string;
  ok: boolean;
  latencyMs?: number | null;
  dnsMs?: number | null;
  connectMs?: number | null;
  tlsMs?: number | null;
  ttfbMs?: number | null;
  httpStatus?: number | null;
  bodyMatched?: boolean | null;
  bodySha256?: string | null;
  bodyBytes?: number | null;
  bodyExcerpt?: string | null;
  error?: string | null;
  resolvedIp?: string | null;
  tlsNotAfter?: string | null;
  tlsIssuer?: string | null;
  tracerouteRan?: boolean;
}

export interface TracerouteHopInput {
  ttl: number;
  ip?: string | null;
  rdns?: string | null;
  rttMs: number[];
}

export interface ConnectivityTracerouteInput {
  checkId: string;
  timestamp?: string;
  destinationIp?: string | null;
  complete: boolean;
  reason?: "scheduled" | "transition";
  note?: string | null;
  hops: TracerouteHopInput[];
}

/** A hop as stored: the agent's reading plus what Polaris knows about the IP. */
export interface StoredHop {
  ttl: number;
  ip: string | null;
  rdns: string | null;
  rttMs: number[];
  assetId?: string;
  hostname?: string | null;
  monitorStatus?: string | null;
  interfaceName?: string | null;
  subnetCidr?: string | null;
}

// ─── Pure helpers ───────────────────────────────────────────────────────────

/** A timestamp the agent sent, clamped to "not in the future" (clock skew). */
export function sampleTime(raw: string | undefined, now: Date): Date {
  if (!raw) return now;
  const t = new Date(raw);
  if (Number.isNaN(t.getTime())) return now;
  return t.getTime() > now.getTime() ? now : t;
}

/**
 * The excerpt Polaris keeps, or null. Hash and byte count are always kept; the
 * text only when the run failed (so the operator can see what came back) or
 * the check explicitly keeps it.
 */
export function excerptToKeep(sample: { ok: boolean; bodyExcerpt?: string | null }, keepBodyExcerpt: boolean): string | null {
  const text = sample.bodyExcerpt;
  if (!text) return null;
  if (sample.ok && !keepBodyExcerpt) return null;
  return text.length > MAX_EXCERPT_CHARS ? text.slice(0, MAX_EXCERPT_CHARS) : text;
}

/** Normalize a hop's IP: "" / "*" / an unparseable string → null (a silent hop). */
export function hopIp(ip: string | null | undefined): string | null {
  const v = (ip ?? "").trim();
  if (!v || v === "*") return null;
  return isValidIpAddress(v) ? v : null;
}

/**
 * sha256 over the hop IP sequence, "*" for a silent hop. RTTs are excluded on
 * purpose — the same path at a different latency is the same path. Trailing
 * silent hops after the last responder are dropped first: an incomplete trace
 * that times out at TTL 12 versus TTL 14 is the same path, not a change.
 */
export function pathHashOf(hops: ReadonlyArray<{ ip: string | null }>): string {
  const seq = hops.map((h) => h.ip ?? "*");
  while (seq.length && seq[seq.length - 1] === "*") seq.pop();
  return createHash("sha256").update(seq.join(",")).digest("hex");
}

// ─── Hop resolution ─────────────────────────────────────────────────────────

export interface HopContext {
  assetId: string | null;
  hostname: string | null;
  monitorStatus: string | null;
  interfaceName: string | null;
  subnetCidr: string | null;
}

/**
 * Resolve every hop IP in one round trip: the asset whose PRIMARY address it
 * is, else the asset carrying it as an associated IP (a FortiGate interface
 * address lands here, with the port name), and the most specific non-
 * deprecated subnet containing it (the subnetService.buildIpContexts idiom).
 * Decommissioned assets are skipped. AssetIpHistory is deliberately NOT read —
 * it has no index on ip, and "who held this address last month" is not what a
 * hop on a live path is.
 */
export async function resolveHopContexts(ips: readonly string[]): Promise<Map<string, HopContext>> {
  const distinct = [...new Set(ips.filter((ip) => !!ip && isValidIpAddress(ip)))];
  const out = new Map<string, HopContext>();
  if (distinct.length === 0) return out;
  const rows = await prisma.$queryRaw<Array<{
    ip: string;
    primary_id: string | null; primary_hostname: string | null; primary_status: string | null;
    assoc_id: string | null; assoc_hostname: string | null; assoc_status: string | null; assoc_iface: string | null;
    subnet_cidr: string | null;
  }>>`
    WITH input_ips(ip) AS (SELECT unnest(${distinct}::text[]))
    SELECT
      i.ip                  AS ip,
      pa.id                 AS primary_id,
      pa.hostname           AS primary_hostname,
      pa."monitorStatus"    AS primary_status,
      xa.id                 AS assoc_id,
      xa.hostname           AS assoc_hostname,
      xa."monitorStatus"    AS assoc_status,
      xa.iface              AS assoc_iface,
      sn.cidr               AS subnet_cidr
    FROM input_ips i
    LEFT JOIN LATERAL (
      SELECT a.id, a.hostname, a."monitorStatus"
        FROM assets a
       WHERE a."ipAddress" = i.ip AND a.status::text <> 'decommissioned'
       ORDER BY a."updatedAt" DESC
       LIMIT 1
    ) pa ON true
    LEFT JOIN LATERAL (
      SELECT a.id, a.hostname, a."monitorStatus", x."interfaceName" AS iface
        FROM asset_associated_ips x
        JOIN assets a ON a.id = x."assetId"
       WHERE x.ip = i.ip AND a.status::text <> 'decommissioned'
       LIMIT 1
    ) xa ON true
    LEFT JOIN LATERAL (
      SELECT s.cidr
        FROM subnets s
       WHERE s.status <> 'deprecated' AND s.cidr::cidr >>= i.ip::inet
       ORDER BY masklen(s.cidr::cidr) DESC
       LIMIT 1
    ) sn ON true
  `;
  for (const r of rows) {
    const usePrimary = r.primary_id !== null;
    out.set(r.ip, {
      assetId: usePrimary ? r.primary_id : r.assoc_id,
      hostname: usePrimary ? r.primary_hostname : r.assoc_hostname,
      monitorStatus: usePrimary ? r.primary_status : r.assoc_status,
      interfaceName: usePrimary ? null : r.assoc_iface,
      subnetCidr: r.subnet_cidr,
    });
  }
  return out;
}

// ─── Ingest ─────────────────────────────────────────────────────────────────

interface SourceRow {
  id: string;
  checkId: string;
  lastOk: boolean | null;
  lastPathHash: string | null;
  lastPathChangeEventAt: Date | null;
  lastSampleAt: Date | null;
  check: { name: string; keepBodyExcerpt: boolean };
}

async function sourcesFor(assetId: string, checkIds: readonly string[]): Promise<Map<string, SourceRow>> {
  const rows = await prisma.connectivityCheckSource.findMany({
    where: { assetId, checkId: { in: [...new Set(checkIds)] } },
    select: {
      id: true, checkId: true, lastOk: true, lastPathHash: true, lastPathChangeEventAt: true, lastSampleAt: true,
      check: { select: { name: true, keepBodyExcerpt: true } },
    },
  });
  return new Map(rows.map((r) => [r.checkId, r]));
}

function parseTlsNotAfter(raw: string | null | undefined): Date | null {
  if (!raw) return null;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
}

export async function ingestConnectivitySamples(
  assetId: string,
  samples: readonly ConnectivitySampleInput[],
  now: Date,
): Promise<IngestResult> {
  const sources = await sourcesFor(assetId, samples.map((s) => s.checkId));
  const rows: ConnectivitySampleRow[] = [];
  let rejected = 0;
  // Newest sample per check drives the source's latest-result columns.
  const newest = new Map<string, { row: ConnectivitySampleRow }>();
  for (const s of samples) {
    const src = sources.get(s.checkId);
    if (!src) { rejected++; continue; }
    const row: ConnectivitySampleRow = {
      assetId,
      timestamp: sampleTime(s.timestamp, now),
      cadence: "fast",
      checkId: s.checkId,
      ok: s.ok,
      latencyMs: s.latencyMs ?? null,
      dnsMs: s.dnsMs ?? null,
      connectMs: s.connectMs ?? null,
      tlsMs: s.tlsMs ?? null,
      ttfbMs: s.ttfbMs ?? null,
      httpStatus: s.httpStatus ?? null,
      bodyMatched: s.bodyMatched ?? null,
      bodySha256: s.bodySha256 ? s.bodySha256.toLowerCase() : null,
      bodyBytes: s.bodyBytes ?? null,
      bodyExcerpt: excerptToKeep(s, src.check.keepBodyExcerpt),
      error: s.error ? s.error.slice(0, 512) : null,
      resolvedIp: s.resolvedIp ?? null,
      tlsNotAfter: parseTlsNotAfter(s.tlsNotAfter),
      tlsIssuer: s.tlsIssuer ?? null,
      hopCount: null,
    };
    rows.push(row);
    const prev = newest.get(s.checkId);
    if (!prev || prev.row.timestamp < row.timestamp) newest.set(s.checkId, { row });
  }
  enqueueConnectivitySamples(rows);

  const updates = [];
  for (const [checkId, { row }] of newest) {
    const src = sources.get(checkId)!;
    // A late-arriving older push must not overwrite a newer latest result.
    if (src.lastSampleAt && src.lastSampleAt > row.timestamp) continue;
    updates.push(prisma.connectivityCheckSource.update({
      where: { id: src.id },
      data: {
        lastOk: row.ok,
        lastSampleAt: row.timestamp,
        lastLatencyMs: row.latencyMs,
        lastHttpStatus: row.httpStatus,
        lastError: row.error,
        lastResolvedIp: row.resolvedIp,
        ...(row.ok ? {} : { lastFailAt: row.timestamp }),
      },
    }));
  }
  if (updates.length) await prisma.$transaction(updates);

  const okN = rows.filter((r) => r.ok).length;
  recordConnectivitySamples("ok", okN);
  recordConnectivitySamples("fail", rows.length - okN);
  recordConnectivitySamples("rejected", rejected);
  return { accepted: rows.length, rejected };
}

export async function ingestConnectivityTraceroutes(
  assetId: string,
  items: readonly ConnectivityTracerouteInput[],
  now: Date,
): Promise<IngestResult> {
  const sources = await sourcesFor(assetId, items.map((t) => t.checkId));
  const accepted = items.filter((t) => sources.has(t.checkId));
  const rejected = items.length - accepted.length;
  if (accepted.length === 0) return { accepted: 0, rejected };

  const allIps: string[] = [];
  for (const t of accepted) for (const h of t.hops) {
    const ip = hopIp(h.ip);
    if (ip) allIps.push(ip);
  }
  const [contexts, asset] = await Promise.all([
    resolveHopContexts(allIps),
    prisma.asset.findUnique({ where: { id: assetId }, select: { hostname: true, ipAddress: true } }),
  ]);
  const hostLabel = asset?.hostname || asset?.ipAddress || assetId;

  // Oldest first so each item is compared against the one before it.
  const ordered = [...accepted].sort((a, b) => sampleTime(a.timestamp, now).getTime() - sampleTime(b.timestamp, now).getTime());
  const creates: Parameters<typeof prisma.assetConnectivityTraceroute.createMany>[0]["data"] = [];
  const state = new Map<string, { hash: string | null; hops: StoredHop[] | null; lastEventAt: Date | null; lastAt: Date | null; complete: boolean | null; hopCount: number | null }>();
  const events: Promise<void>[] = [];

  for (const t of ordered) {
    const src = sources.get(t.checkId)!;
    const ts = sampleTime(t.timestamp, now);
    const hops: StoredHop[] = [...t.hops]
      .sort((a, b) => a.ttl - b.ttl)
      .map((h) => {
        const ip = hopIp(h.ip);
        const ctx = ip ? contexts.get(ip) : undefined;
        const stored: StoredHop = { ttl: h.ttl, ip, rdns: h.rdns?.trim() || null, rttMs: h.rttMs };
        if (ctx) {
          if (ctx.assetId) {
            stored.assetId = ctx.assetId;
            stored.hostname = ctx.hostname;
            stored.monitorStatus = ctx.monitorStatus;
            if (ctx.interfaceName) stored.interfaceName = ctx.interfaceName;
          }
          if (ctx.subnetCidr) stored.subnetCidr = ctx.subnetCidr;
        }
        return stored;
      });
    const hash = pathHashOf(hops);
    const st = state.get(t.checkId) ?? {
      hash: src.lastPathHash, hops: null, lastEventAt: src.lastPathChangeEventAt, lastAt: null, complete: null, hopCount: null,
    };
    const changed = st.hash !== null && st.hash !== hash;
    if (changed && (!st.lastEventAt || ts.getTime() - st.lastEventAt.getTime() >= PATH_CHANGE_EVENT_FLOOR_MS)) {
      st.lastEventAt = ts;
      recordConnectivityPathChange();
      events.push(logEvent({
        action: "connectivity.path_changed",
        resourceType: "asset",
        resourceId: assetId,
        resourceName: hostLabel,
        level: "warning",
        message: `Path from ${hostLabel} for connectivity check "${src.check.name}" changed (${hops.length} hops${t.complete ? "" : ", incomplete"})`,
        details: {
          checkId: t.checkId,
          checkName: src.check.name,
          destinationIp: t.destinationIp ?? null,
          previousHops: st.hops ? st.hops.map((h) => h.ip) : null,
          hops: hops.map((h) => h.ip),
          previousPathHash: st.hash,
          pathHash: hash,
        },
      }));
    }
    st.hash = hash;
    st.hops = hops;
    st.lastAt = ts;
    st.complete = t.complete;
    st.hopCount = hops.length;
    state.set(t.checkId, st);
    creates.push({
      assetId,
      timestamp: ts,
      checkId: t.checkId,
      destinationIp: t.destinationIp ?? null,
      complete: t.complete,
      hopCount: hops.length,
      hops: hops as unknown as object,
      pathHash: hash,
      reason: t.reason ?? "scheduled",
      note: t.note ?? null,
    });
  }

  await prisma.$transaction([
    prisma.assetConnectivityTraceroute.createMany({ data: creates }),
    ...[...state].map(([checkId, st]) => prisma.connectivityCheckSource.update({
      where: { id: sources.get(checkId)!.id },
      data: {
        lastPathHash: st.hash,
        lastTracerouteAt: st.lastAt,
        lastHopCount: st.hopCount,
        lastTracerouteComplete: st.complete,
        lastPathChangeEventAt: st.lastEventAt,
      },
    })),
  ]);
  await Promise.all(events);
  return { accepted: accepted.length, rejected };
}
