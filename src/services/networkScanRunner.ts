/**
 * src/services/networkScanRunner.ts — executes one network **Discovery**.
 *
 * A Discovery sweeps operator-supplied address ranges, works out what answers,
 * and records the responders as `NetworkScanRun.hits` for the wizard's Results
 * step to offer for adoption. See business rule 34 for the posture; this file
 * is the mechanism.
 *
 * Shape of a run:
 *
 *   1. Expand the targets (`expandScanTargets` — all IP math lives in
 *      utils/cidr) and subtract the addresses an Asset already carries. That
 *      subtraction happens BEFORE any packet: "new addresses only" means the
 *      scan has no reason to touch a device Polaris already knows, and not
 *      probing it is both cheaper and quieter. The count is reported so
 *      "nothing new" stays distinguishable from "nothing there".
 *   2. **Liveness** — up to two ICMP echoes per address (the second only if
 *      the first went unanswered — see SCAN_PING_ATTEMPTS), when the operator
 *      enabled ICMP. This is the cheap filter that keeps a /16 of empty space
 *      from costing an authentication attempt per address. A ping that could
 *      not RUN is counted apart from a silent address and reported on the run.
 *   3. **Identification** — for each live address, the enabled methods in the
 *      operator's order, each against its credentials in order, stopping at
 *      the first that answers. SNMP additionally walks the system group (who
 *      is this?) and the interface + storage inventory (what can be pinned?).
 *
 * Three properties worth stating, because they are the ones a future change
 * could quietly break:
 *
 *   - **Nothing here calls `withSnmpGate` directly, and that is correct.**
 *     Both SNMP entry points it uses — `probeCredentialAgainstHost("snmp")`
 *     and `snmpWalkRaw` — acquire the per-(host, port) gate internally, so the
 *     scan already FIFOs behind the monitor loop on any host Polaris polls.
 *     Wrapping again would deadlock against a gate the callee also wants.
 *   - **A run never throws out of `runScan`.** A failed address is a recorded
 *     error on that address, not an aborted sweep; a failed run is a `status`
 *     of "error" with the reason on the row, because the wizard's only view of
 *     the run is that row.
 *   - **Progress is written on a throttle, not per address.** A /16 would
 *     otherwise be 65k UPDATEs on a table the wizard polls every 2s.
 */

import { prisma } from "../db.js";
import { logger } from "../utils/logger.js";
import { logEvent } from "./eventLogService.js";
import { getCredential } from "./credentialService.js";
import { mapSettledWithConcurrency } from "../utils/concurrency.js";
import { pingHost } from "../utils/icmpPing.js";
import { probeCredentialAgainstHost, snmpWalkRaw } from "./monitoringService.js";
import { expandScanTargets, type ScanTarget } from "../utils/cidr.js";
import { parseSnmpIdentity, hasSnmpIdentity, type SnmpIdentity } from "../utils/snmpIdentity.js";
import {
  parseScanInterfaces,
  parseScanStorage,
  INVENTORY_OIDS,
  type ScanInterface,
  type ScanStorageMount,
  type SnmpRow,
} from "../utils/snmpInventory.js";

// ─── Vocabulary ─────────────────────────────────────────────────────────────

/**
 * The methods a Discovery may try. ICMP carries no credentials (the store has
 * no "icmp" type by design); the other four each name credentials to try in
 * order. Deliberately NOT the `http` check type in v1 — an HTTP check is
 * defined per-path against a device you already know, which is the opposite of
 * "what is at this address".
 */
export const SCAN_METHODS = ["icmp", "snmp", "restapi", "ssh", "winrm"] as const;
export type ScanMethodType = (typeof SCAN_METHODS)[number];

export interface ScanMethod {
  type: ScanMethodType;
  /** Tried in array order. Empty (and required empty) for icmp. */
  credentialIds?: string[];
}

/** One responder. */
export interface ScanHit {
  address: string;
  /** Every method that answered, in the order they were tried. */
  respondedTo: ScanMethodType[];
  /** The method whose credential produced the identity, when one did. */
  identifiedBy?: ScanMethodType;
  credentialId?: string;
  credentialName?: string;
  responseTimeMs?: number;
  identity?: SnmpIdentity;
  interfaces?: ScanInterface[];
  storage?: ScanStorageMount[];
  /** The inventory hit its cap — the picker is showing a partial list. */
  inventoryTruncated?: boolean;
  /**
   * Per-method failure reason for an address that answered SOMETHING. Kept
   * because "answered ICMP, refused every SNMP community" is the single most
   * common shape and the operator needs to see which credential to fix.
   */
  errors?: Partial<Record<ScanMethodType, string>>;
}

// ─── Pacing ─────────────────────────────────────────────────────────────────
//
// Deliberately constants rather than env vars: a Discovery is an explicit,
// operator-initiated, cancellable action with visible progress, so there is no
// steady-state tuning problem to expose. They are exported for the tests.

/**
 * ICMP echoes in flight. Higher than presenceVerification's 16 because this is
 * a deliberate sweep rather than a background pass, and the liveness stage is
 * what decides whether a /16 takes 25 minutes or four hours.
 */
export const SCAN_PING_CONCURRENCY = 64;
/** ICMP timeout. Short: a live host on a local segment answers in ms. */
export const SCAN_PING_TIMEOUT_MS = 1500;
/**
 * Echoes sent to an address before it is called silent. Two, not one: the first
 * echo to a quiet host on a ROUTED subnet is routinely lost while the gateway
 * ARPs for it (a FortiGate or a Cisco drops it rather than queueing it), and a
 * single-echo sweep reads every such host as empty space. The monitor never
 * shows that loss, because its pings repeat and the gateway has learned the
 * host by the second — which is exactly how a device could answer its ICMP
 * monitor and still be missing from a Discovery of its own network. The retry
 * goes out immediately, while the ARP entry the first echo caused is fresh,
 * and only a silent address pays for it.
 */
export const SCAN_PING_ATTEMPTS = 2;

// ─── Liveness ───────────────────────────────────────────────────────────────

/**
 * What one address's liveness check found.
 *
 * `toolError` is set when `ping` itself could not run — not installed, no
 * CAP_NET_RAW, no route out of this server — which is a fact about the SERVER,
 * not the address. It is kept apart from a silent address so a sweep where
 * ping never worked can say so instead of reporting a quiet network.
 */
export interface LivenessResult {
  alive: boolean;
  toolError?: string;
}

/**
 * Does this `pingHost` failure mean "no reply"? iputils and Windows both exit 1
 * when the echo went out and nothing came back; pingHost's own wall-clock timer
 * is the same verdict. Anything else — a spawn error (ENOENT, EPERM), exit 2
 * ("socket: Operation not permitted", "Network is unreachable") — means the
 * probe never really happened.
 */
export function isNoReply(error: string | undefined): boolean {
  return error === "ping exit 1" || error === "ping timed out";
}

/**
 * Ping one address up to SCAN_PING_ATTEMPTS times, stopping at the first reply.
 * A tool failure is not retried: it will fail the same way again.
 */
export async function checkLiveness(
  address: string,
  ping: (host: string, timeoutMs: number) => Promise<{ success: boolean; error?: string }> = pingHost,
): Promise<LivenessResult> {
  for (let attempt = 0; attempt < SCAN_PING_ATTEMPTS; attempt++) {
    const res = await ping(address, SCAN_PING_TIMEOUT_MS);
    if (res.success) return { alive: true };
    if (!isNoReply(res.error)) return { alive: false, toolError: res.error || "ping failed" };
  }
  return { alive: false };
}
/**
 * Identification attempts in flight. Much lower than the ping stage — each one
 * is an authentication attempt plus (for SNMP) three walks, and this is the
 * stage that shows up on an IDS.
 */
export const SCAN_IDENTIFY_CONCURRENCY = 12;
/** Rows per inventory walk. Bounded again by the parser's own caps. */
export const SCAN_WALK_MAX_ROWS = 800;
/** Hits recorded on the run row. Beyond this the operator has bigger problems. */
export const SCAN_MAX_HITS = 2000;
/** Minimum gap between progress UPDATEs on the run row. */
export const SCAN_PROGRESS_FLUSH_MS = 2000;

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Normalize whatever is stored in `NetworkScan.targets`. */
export function parseStoredTargets(raw: unknown): ScanTarget[] {
  if (!Array.isArray(raw)) return [];
  const out: ScanTarget[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const kind = (item as Record<string, unknown>).kind;
    const value = (item as Record<string, unknown>).value;
    if (kind !== "cidr" && kind !== "range" && kind !== "single") continue;
    if (typeof value !== "string") continue;
    out.push({ kind, value });
  }
  return out;
}

/** Normalize whatever is stored in `NetworkScan.methods`. */
export function parseStoredMethods(raw: unknown): ScanMethod[] {
  if (!Array.isArray(raw)) return [];
  const out: ScanMethod[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const type = (item as Record<string, unknown>).type;
    if (typeof type !== "string" || !(SCAN_METHODS as readonly string[]).includes(type)) continue;
    if (seen.has(type)) continue; // one entry per method; the first wins
    seen.add(type);
    const rawIds = (item as Record<string, unknown>).credentialIds;
    const credentialIds = Array.isArray(rawIds)
      ? rawIds.filter((x): x is string => typeof x === "string" && x.length > 0)
      : [];
    out.push({ type: type as ScanMethodType, credentialIds });
  }
  return out;
}

/**
 * Every IPv4 address an Asset already carries — primary or associated.
 *
 * One query per run, not per address: at 65k targets a per-address existence
 * check would be 65k round trips. The associated-IP table is included because
 * a device's second NIC is still that device, and offering it as a new asset
 * would create the duplicate this exclusion exists to prevent.
 */
export async function loadKnownAddresses(): Promise<Set<string>> {
  const known = new Set<string>();
  const [primary, associated] = await Promise.all([
    prisma.asset.findMany({ where: { ipAddress: { not: null } }, select: { ipAddress: true } }),
    // NB the column is `ip` on this table, not `ipAddress`.
    prisma.assetAssociatedIp.findMany({ select: { ip: true } }),
  ]);
  for (const row of primary) if (row.ipAddress) known.add(row.ipAddress.trim());
  for (const row of associated) if (row.ip) known.add(row.ip.trim());
  return known;
}

/** Load the credentials a scan's methods name, keeping the operator's order. */
async function loadScanCredentials(
  methods: ScanMethod[],
): Promise<Map<string, { id: string; name: string; type: string; config: Record<string, unknown> }>> {
  const ids = new Set<string>();
  for (const m of methods) for (const id of m.credentialIds ?? []) ids.add(id);
  const out = new Map<string, { id: string; name: string; type: string; config: Record<string, unknown> }>();
  await Promise.all(
    Array.from(ids).map(async (id) => {
      try {
        const cred = await getCredential(id, { revealSecrets: true });
        out.set(id, {
          id: cred.id,
          name: cred.name,
          type: String(cred.type),
          config: (cred.config ?? {}) as Record<string, unknown>,
        });
      } catch {
        // A deleted credential is a configuration problem the operator will
        // see as "every attempt failed", not a reason to refuse the run.
      }
    }),
  );
  return out;
}

/**
 * Walk the system group + inventory for an address SNMP just answered.
 *
 * Best-effort per walk: a device that answers the system group but publishes no
 * hrStorageTable is the normal case for a switch, and one failed walk must not
 * cost the identity. `snmpWalkRaw` acquires the per-host SNMP gate itself.
 */
async function collectSnmpDetail(
  host: string,
  config: Record<string, unknown>,
): Promise<{
  identity?: SnmpIdentity;
  interfaces?: ScanInterface[];
  storage?: ScanStorageMount[];
  truncated: boolean;
}> {
  const walk = async (baseOid: string): Promise<SnmpRow[]> => {
    try {
      const res = await snmpWalkRaw(host, config, baseOid, SCAN_WALK_MAX_ROWS);
      return res.rows as SnmpRow[];
    } catch {
      return [];
    }
  };

  // The system group first and on its own: it is the walk that decides whether
  // this hit has an identity at all, and it is one small subtree.
  const systemRows = await walk("1.3.6.1.2.1.1");
  const identity = parseSnmpIdentity(systemRows);

  // Inventory columns. Serial rather than parallel because they all queue on
  // the same per-host SNMP gate anyway — issuing them together would just fill
  // that queue and risk the gate's wait timeout.
  const ifName = await walk(INVENTORY_OIDS.ifName);
  const ifDescr = await walk(INVENTORY_OIDS.ifDescr);
  const ifType = await walk(INVENTORY_OIDS.ifType);
  const ifOperStatus = await walk(INVENTORY_OIDS.ifOperStatus);
  const hrStorageDescr = await walk(INVENTORY_OIDS.hrStorageDescr);
  const hrStorageType = await walk(INVENTORY_OIDS.hrStorageType);

  const ifs = parseScanInterfaces({ ifName, ifDescr, ifType, ifOperStatus });
  const st = parseScanStorage({ hrStorageDescr, hrStorageType });

  return {
    identity: hasSnmpIdentity(identity) ? identity : undefined,
    interfaces: ifs.interfaces.length ? ifs.interfaces : undefined,
    storage: st.storage.length ? st.storage : undefined,
    truncated: ifs.truncated || st.truncated,
  };
}

/**
 * Try every enabled method against one address, in the operator's order.
 *
 * Returns null when nothing answered — the common case for most of a range,
 * and the reason this returns rather than throwing.
 */
export async function identifyAddress(
  address: string,
  methods: ScanMethod[],
  creds: Map<string, { id: string; name: string; type: string; config: Record<string, unknown> }>,
  opts?: { icmpAlreadyAnswered?: boolean },
): Promise<ScanHit | null> {
  const hit: ScanHit = { address, respondedTo: [] };
  if (opts?.icmpAlreadyAnswered) hit.respondedTo.push("icmp");
  let anyAnswer = opts?.icmpAlreadyAnswered === true;

  for (const method of methods) {
    if (method.type === "icmp") continue; // already decided by the liveness pass
    const ids = method.credentialIds ?? [];
    if (!ids.length) {
      // A credentialed method with no credential can't be attempted. Say so
      // once, on the hit, rather than silently reporting the address as
      // SNMP-silent when nothing ever asked it.
      hit.errors = { ...(hit.errors ?? {}), [method.type]: "No credential selected for this method" };
      continue;
    }
    let answered = false;
    let lastError = "";
    for (const id of ids) {
      const cred = creds.get(id);
      if (!cred) { lastError = "Credential not found"; continue; }
      const result = await probeCredentialAgainstHost(address, method.type, cred.config);
      if (!result.success) { lastError = result.error || "No response"; continue; }

      answered = true;
      anyAnswer = true;
      hit.respondedTo.push(method.type);
      if (hit.responseTimeMs == null) hit.responseTimeMs = result.responseTimeMs;

      // The FIRST method that answers with a credential owns the identity —
      // later methods still record that they answered, but they do not
      // overwrite what the operator's higher-priority method established.
      if (!hit.identifiedBy) {
        hit.identifiedBy = method.type;
        hit.credentialId = cred.id;
        hit.credentialName = cred.name;
      }
      if (method.type === "snmp" && !hit.identity) {
        const detail = await collectSnmpDetail(address, cred.config);
        if (detail.identity) hit.identity = detail.identity;
        if (detail.interfaces) hit.interfaces = detail.interfaces;
        if (detail.storage) hit.storage = detail.storage;
        if (detail.truncated) hit.inventoryTruncated = true;
      }
      break; // stop at the first credential that works for this method
    }
    if (!answered && lastError) {
      hit.errors = { ...(hit.errors ?? {}), [method.type]: lastError };
    }
  }

  if (!anyAnswer) return null;
  return hit;
}

// ─── Run state ──────────────────────────────────────────────────────────────

interface Progress {
  scannedCount: number;
  hitCount: number;
}

/** Throttled writer for the run row's counters + heartbeat. */
class ProgressWriter {
  private lastFlush = 0;
  private dirty = false;
  constructor(private readonly runId: string, private readonly progress: Progress) {}

  bump(scanned: number, hits: number): void {
    this.progress.scannedCount += scanned;
    this.progress.hitCount += hits;
    this.dirty = true;
  }

  /** Write if the throttle has elapsed (or `force`). Never throws. */
  async flush(now: number, force = false): Promise<void> {
    if (!force && (!this.dirty || now - this.lastFlush < SCAN_PROGRESS_FLUSH_MS)) return;
    this.lastFlush = now;
    this.dirty = false;
    try {
      await prisma.networkScanRun.update({
        where: { id: this.runId },
        data: {
          scannedCount: this.progress.scannedCount,
          hitCount: this.progress.hitCount,
          workerHeartbeatAt: new Date(),
        },
      });
    } catch (err) {
      logger.warn({ err, runId: this.runId }, "network scan progress write failed");
    }
  }
}

/** Has the web role asked this run to stop? Never throws. */
async function isCancelRequested(runId: string): Promise<boolean> {
  try {
    const row = await prisma.networkScanRun.findUnique({
      where: { id: runId },
      select: { cancelRequested: true },
    });
    return row?.cancelRequested === true;
  } catch {
    return false;
  }
}

/**
 * Execute a run.
 *
 * Invoked by the pg-boss scan worker (discovery role) or in-process by the
 * cursor-mode fallback — the `triggerDiscovery` dispatch shape. Owns every
 * transition on the run row, so it must not throw: the row IS the wizard's
 * view of the run.
 */
export async function runScan(runId: string, actor: string): Promise<void> {
  const run = await prisma.networkScanRun.findUnique({
    where: { id: runId },
    include: { scan: true },
  });
  if (!run) {
    logger.warn({ runId }, "network scan run vanished before it started");
    return;
  }
  const scan = run.scan;
  const startedAt = new Date();

  const fail = async (message: string): Promise<void> => {
    await prisma.networkScanRun
      .update({
        where: { id: runId },
        data: { status: "error", error: message.slice(0, 500), finishedAt: new Date() },
      })
      .catch(() => {});
    await logEvent({
      action: "network_scan.error",
      resourceType: "network_scan",
      resourceId: scan.id,
      resourceName: scan.name,
      actor,
      level: "error",
      message: `Discovery "${scan.name}" failed: ${message}`,
    });
  };

  try {
    const targets = parseStoredTargets(scan.targets);
    const methods = parseStoredMethods(scan.methods);
    if (!targets.length) return await fail("No targets configured");
    if (!methods.length) return await fail("No probe methods configured");

    const expanded = expandScanTargets(targets);
    if (!expanded.total) {
      return await fail(
        expanded.dropped
          ? `Every address was excluded (${expanded.dropped} dropped: ${expanded.droppedBy.invalid} invalid, ` +
            `${expanded.droppedBy.excluded} reserved, ${expanded.droppedBy.cap} over the cap)`
          : "The targets expand to no addresses",
      );
    }

    // New addresses only — subtract before probing (see the file header).
    const known = await loadKnownAddresses();
    const addresses = expanded.addresses.filter((a) => !known.has(a));
    const skippedKnown = expanded.total - addresses.length;

    await prisma.networkScanRun.update({
      where: { id: runId },
      data: {
        status: "running",
        startedAt,
        workerHeartbeatAt: startedAt,
        totalTargets: addresses.length,
        droppedTargetCount: expanded.dropped,
        skippedKnownCount: skippedKnown,
        scannedCount: 0,
        hitCount: 0,
      },
    });
    await logEvent({
      action: "network_scan.started",
      resourceType: "network_scan",
      resourceId: scan.id,
      resourceName: scan.name,
      actor,
      message:
        `Discovery "${scan.name}" started: ${addresses.length} address(es) to scan` +
        (skippedKnown ? `, ${skippedKnown} already in inventory` : "") +
        (expanded.dropped ? `, ${expanded.dropped} dropped` : ""),
      details: {
        methods: methods.map((m) => m.type),
        totalTargets: addresses.length,
        skippedKnown,
        dropped: expanded.droppedBy,
      },
    });

    const creds = await loadScanCredentials(methods);
    const progress: Progress = { scannedCount: 0, hitCount: 0 };
    const writer = new ProgressWriter(runId, progress);
    const hits: ScanHit[] = [];
    let aborted = false;
    let hitsTruncated = false;
    // Per-RUN, not module-scope: two concurrent Discoveries must not share a
    // cancel-check clock, or one run's tick suppresses the other's.
    let lastCancelCheck = Date.now();

    const icmpEnabled = methods.some((m) => m.type === "icmp");

    // ── The counters mean ONE thing for the whole run ────────────────────
    // `totalTargets` is the address count after exclusions, written once and
    // never rewritten; `scannedCount` counts addresses FULLY processed, so it
    // rises monotonically to totalTargets; `hitCount` counts responders.
    //
    // That matters because the two stages cover different sets. An earlier
    // shape re-pointed the counters at the identification pass — resetting
    // totalTargets to the live count — which made the wizard's "N of M" jump
    // backwards mid-run and, on a sweep where nothing answered, left the
    // finished row reading "0 of 0 scanned" after sweeping a whole /29.
    // A dead address is fully processed the moment its ping fails (nothing
    // else will touch it); a live one is not fully processed until
    // identification has run, so it is counted there.

    // ── Stage 1: liveness ────────────────────────────────────────────────
    // Without ICMP every address goes to identification, which is the
    // operator's choice to make: a range where ICMP is firewalled off is
    // exactly the case where the cheap filter would hide every device.
    let candidates: { address: string; icmpAnswered: boolean }[];
    // Addresses ping could not even be attempted against, and one example
    // reason — a server-side fault that must not read as an empty network.
    let pingToolFailures = 0;
    let pingToolError: string | null = null;
    if (icmpEnabled) {
      const live: { address: string; icmpAnswered: boolean }[] = [];
      await mapSettledWithConcurrency(addresses, SCAN_PING_CONCURRENCY, async (address) => {
        if (aborted) return;
        const res = await checkLiveness(address);
        if (res.toolError) {
          pingToolFailures += 1;
          pingToolError ??= res.toolError;
        }
        if (res.alive) {
          live.push({ address, icmpAnswered: true });
          // A responder, but not yet fully processed — stage 2 counts it as
          // scanned. It is already a HIT: identifyAddress always returns one
          // for an address whose ICMP answered.
          writer.bump(0, 1);
        } else {
          writer.bump(1, 0);
        }
        const now = Date.now();
        await writer.flush(now);
        // Cancel is checked on the throttle tick rather than per address so a
        // /16 doesn't add 65k SELECTs.
        if (now - lastCancelCheck > SCAN_PROGRESS_FLUSH_MS) {
          lastCancelCheck = now;
          if (await isCancelRequested(runId)) aborted = true;
        }
      });
      candidates = live;
    } else {
      candidates = addresses.map((address) => ({ address, icmpAnswered: false }));
    }

    // ── Stage 2: identification ──────────────────────────────────────────
    if (!aborted) {
      await mapSettledWithConcurrency(candidates, SCAN_IDENTIFY_CONCURRENCY, async (candidate) => {
        if (aborted) return;
        let hit: ScanHit | null = null;
        try {
          hit = await identifyAddress(candidate.address, methods, creds, {
            icmpAlreadyAnswered: candidate.icmpAnswered,
          });
        } catch (err) {
          // A per-address failure is a recorded nothing, never an aborted run.
          logger.debug({ err, address: candidate.address, runId }, "network scan identify failed");
        }
        if (hit) {
          if (hits.length < SCAN_MAX_HITS) hits.push(hit);
          else hitsTruncated = true;
        }
        // Scanned now (stage 1 deliberately didn't count these); the hit was
        // already counted there when ICMP is what found it.
        writer.bump(1, !icmpEnabled && hit ? 1 : 0);
        const now = Date.now();
        await writer.flush(now);
        if (now - lastCancelCheck > SCAN_PROGRESS_FLUSH_MS) {
          lastCancelCheck = now;
          if (await isCancelRequested(runId)) aborted = true;
        }
      });
    }

    if (hitsTruncated) {
      logger.warn(
        { runId, scanId: scan.id, cap: SCAN_MAX_HITS },
        "network scan hit cap reached — later responders were not recorded",
      );
    }

    // Stays a COMPLETED run — the addresses that did answer are real results —
    // but the error line on the Run step says why the rest read as silent.
    const pingNote = pingToolFailures
      ? `ping could not run from this server for ${pingToolFailures} of ${addresses.length} address(es) ` +
        `(${pingToolError}) — those were not tested, not found silent`
      : null;
    if (pingNote) logger.warn({ runId, scanId: scan.id, pingToolFailures, pingToolError }, "network scan: ping could not run");

    await prisma.networkScanRun.update({
      where: { id: runId },
      data: {
        status: aborted ? "aborted" : "completed",
        ...(pingNote ? { error: pingNote } : {}),
        scannedCount: progress.scannedCount,
        hitCount: hits.length,
        hits: hits as unknown as object,
        finishedAt: new Date(),
        workerHeartbeatAt: new Date(),
      },
    });
    await prisma.networkScan.update({ where: { id: scan.id }, data: { lastRunAt: new Date() } }).catch(() => {});

    await logEvent({
      action: aborted ? "network_scan.aborted" : "network_scan.completed",
      resourceType: "network_scan",
      resourceId: scan.id,
      resourceName: scan.name,
      actor,
      level: aborted || pingNote ? "warning" : "info",
      message:
        `Discovery "${scan.name}" ${aborted ? "aborted" : "completed"}: ` +
        `${hits.length} responder(s) from ${progress.scannedCount} address(es) scanned` +
        (pingNote ? ` — ${pingNote}` : ""),
      details: {
        hits: hits.length,
        scanned: progress.scannedCount,
        skippedKnown,
        hitsTruncated,
        pingToolFailures,
        durationMs: Date.now() - startedAt.getTime(),
      },
    });
  } catch (err) {
    await fail(err instanceof Error ? err.message : String(err));
  }
}
