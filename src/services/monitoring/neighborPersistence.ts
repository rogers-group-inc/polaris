/**
 * src/services/monitoring/neighborPersistence.ts — persisting what a system-info pass found next to the device (CQ-B061, moved
 * verbatim from monitoringService.ts): Application Map process connections, LLDP
 * neighbours (incl. managed APs) and wireless stations.
 */

import { chunkArray } from "../../utils/chunk.js";
import { randomUUID } from "node:crypto";
import { prisma } from "../../db.js";
import { retryOnDeadlock } from "../../utils/dbRetry.js";
import { loadInterfaceIdentity } from "../interfaceInventoryService.js";
import { canonicalInterfaceName } from "../../utils/interfaceIdentity.js";
import { logEventsBatch, buildConnectionChangedEvent } from "../eventLogService.js";
import { maybeEmitChangeEvents, wirelessRoamEventsWanted, type ChangeItem } from "../notificationChangeEvents.js";
import { logger } from "../../utils/logger.js";
import { normalizeFortiapInterfaceName, fortiapInterfaceAliases } from "../../utils/fortiapInterfaceAlias.js";
import type { ApLldpNeighborSample } from "../../utils/fortiapLldp.js";
import { pickLldpHostnameMatch } from "../../utils/lldpHostnameMatch.js";
import { PROBE_ASSET_OMIT, resolveMonitorSettings } from "./monitorSettings.js";
import { LldpNeighborSample, WirelessStationSample } from "./types.js";
import { startPhase } from "./common.js";
import { getLldpAssetMatchIndex } from "./lldpMatchIndex.js";

// ─── Application Map: process connection persistence ─────────────────────────

type ProcessConnectionKind = "listen" | "outbound" | "inbound";

export interface ProcessConnectionInput {
  /** AssetProcess.name key — same program-name space as the pin arrays. */
  processName: string;
  kind:  ProcessConnectionKind;
  proto: "tcp" | "udp";
  localAddr?:  string | null;
  localPort?:  number | null;
  remoteIp?:   string | null;
  remotePort?: number | null;
  /** Owning systemd unit / Windows service (Phase 3). Attribute-only — NOT in
   *  the business key; set on insert, never bumped on conflict. */
  unit?: string | null;
}

// Per-(processName, kind) row caps. Also enforced on-agent and in the agentless
// parsers before transmit — this copy is the defensive last line against
// old/hand-rolled agents pushing unbounded sets.
const PROCESS_CONN_CAPS: Record<ProcessConnectionKind, number> = {
  listen:   200,
  outbound: 500,
  inbound:  200,
};

// 12 params/row; 2000 rows/statement stays well under the 65535 param ceiling.
const PROCESS_CONN_CHUNK = 2000;

// lastSeen churn gate: a row seen every 60s only takes a real tuple update once
// per window — ~5× less dead-tuple churn, and with lastSeen unindexed those
// updates stay HOT. Reads can see lastSeen up to this much stale, irrelevant
// against the 30-day retention window.
const PROCESS_CONN_BUMP_MINUTES = 5;

function processConnSentinels(r: ProcessConnectionInput): {
  localAddr: string; localPort: number; remoteIp: string; remotePort: number;
} {
  return {
    localAddr:  r.localAddr ?? "",
    localPort:  Number.isInteger(r.localPort)  && (r.localPort  as number) >= 0 ? (r.localPort  as number) : 0,
    remoteIp:   r.remoteIp ?? "",
    remotePort: Number.isInteger(r.remotePort) && (r.remotePort as number) >= 0 ? (r.remotePort as number) : 0,
  };
}

/**
 * ACCUMULATE + AGE upsert of connection facts for one asset's MAPPED processes.
 * NOT delete-replace: each row is keyed on the business tuple; a re-observed
 * row bumps lastSeen (behind the churn gate) and keeps firstSeen, an absent row
 * is left alone to age out via pruneProcessConnections. An empty `rows` push is
 * therefore a no-op by design — short-lived connections must not flicker off
 * the Application Map between scrapes.
 *
 * Caller contract: `rows` should already be filtered to the asset's
 * mappedProcesses (the agent ingest arm and the agentless collectors both do);
 * this function only normalizes, dedups, and caps.
 */
export async function persistProcessConnections(
  assetId: string,
  rows: ProcessConnectionInput[],
): Promise<void> {
  if (rows.length === 0) return;

  interface NormalizedConnRow {
    processName: string; kind: ProcessConnectionKind; proto: "tcp" | "udp";
    localAddr: string; localPort: number; remoteIp: string; remotePort: number;
    unit: string;
  }
  // Normalize + validate + dedup by business key. Two identical tuples inside
  // one INSERT ... ON CONFLICT raise "cannot affect row a second time", so the
  // JS-side dedup is mandatory, not an optimization.
  const byKey = new Map<string, NormalizedConnRow>();
  for (const r of rows) {
    const kind  = String(r.kind).toLowerCase()  as ProcessConnectionKind;
    const proto = String(r.proto).toLowerCase() as "tcp" | "udp";
    if (kind !== "listen" && kind !== "outbound" && kind !== "inbound") continue;
    if (proto !== "tcp" && proto !== "udp") continue;
    const name = (r.processName ?? "").trim();
    if (!name) continue;
    const s = processConnSentinels(r);
    if (s.localPort > 65535 || s.remotePort > 65535) continue;
    const key = JSON.stringify([name, kind, proto, s.localAddr, s.localPort, s.remoteIp, s.remotePort]);
    // unit is attribute-only (not in the key) — first occurrence wins, matching
    // the agent's dedup + the insert-only ON CONFLICT below.
    if (!byKey.has(key)) byKey.set(key, { processName: name, kind, proto, ...s, unit: (r.unit ?? "").trim() });
  }

  // Per-(processName, kind) caps, deterministic order so truncation is stable
  // across scrapes (a capped set shouldn't churn membership between pushes).
  const grouped = new Map<string, { kind: ProcessConnectionKind; list: NormalizedConnRow[] }>();
  for (const row of byKey.values()) {
    // kind is a fixed token, so "kind:name" can't collide across groups.
    const gk = `${row.kind}:${row.processName}`;
    let g = grouped.get(gk);
    if (!g) { g = { kind: row.kind, list: [] }; grouped.set(gk, g); }
    g.list.push(row);
  }
  const capped: NormalizedConnRow[] = [];
  for (const g of grouped.values()) {
    g.list.sort((a, b) =>
      a.proto.localeCompare(b.proto) ||
      a.remoteIp.localeCompare(b.remoteIp) ||
      (a.remotePort - b.remotePort) ||
      a.localAddr.localeCompare(b.localAddr) ||
      (a.localPort - b.localPort));
    capped.push(...g.list.slice(0, PROCESS_CONN_CAPS[g.kind]));
  }
  if (capped.length === 0) return;

  const nowIso = new Date().toISOString();
  for (const chunk of chunkArray(capped, PROCESS_CONN_CHUNK)) {
    const params: unknown[] = [];
    const tuples: string[] = [];
    let p = 1;
    for (const r of chunk) {
      tuples.push(`($${p++}::uuid, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}::int, $${p++}, $${p++}::int, $${p++}, $${p++}::timestamp, $${p++}::timestamp)`);
      params.push(
        randomUUID(), assetId, r.processName, r.kind, r.proto,
        r.localAddr, r.localPort, r.remoteIp, r.remotePort, r.unit,
        nowIso, nowIso,
      );
    }
    const sql =
      `INSERT INTO "asset_process_connections" (` +
      `"id", "assetId", "processName", "kind", "proto", ` +
      `"localAddr", "localPort", "remoteIp", "remotePort", "unit", "firstSeen", "lastSeen"` +
      `) VALUES ${tuples.join(", ")} ` +
      `ON CONFLICT ("assetId", "processName", "kind", "proto", "localAddr", "localPort", "remoteIp", "remotePort") ` +
      // unit is BACKFILL-ONLY: an empty stored unit adopts the incoming one, a
      // non-empty one is never overwritten. Backfill matters because unit is not
      // in the business key — a tuple first inserted before its unit was mapped
      // (program mapped as a process first, row predating the unit column, or an
      // agentless push that can't resolve units) would otherwise keep unit=''
      // forever, and applicationMapService.ownerNodeIds needs a non-empty unit to
      // attribute the row to its mapped service. Never overwriting keeps Windows
      // svchost first-service flapping and the agentless-vs-agent insert race from
      // churning the column.
      `DO UPDATE SET ` +
        `"lastSeen" = GREATEST("asset_process_connections"."lastSeen", EXCLUDED."lastSeen"), ` +
        `"unit" = CASE WHEN "asset_process_connections"."unit" = '' ` +
                     `THEN EXCLUDED."unit" ELSE "asset_process_connections"."unit" END ` +
      // The OR arm is what lets a backfill land INSIDE the churn gate. It can only
      // fire once per row (afterwards unit <> ''), so the dead-tuple budget the
      // gate protects is unaffected.
      `WHERE "asset_process_connections"."lastSeen" < EXCLUDED."lastSeen" - interval '${PROCESS_CONN_BUMP_MINUTES} minutes' ` +
        `OR ("asset_process_connections"."unit" = '' AND EXCLUDED."unit" <> '')`;
    await retryOnDeadlock(() => prisma.$executeRawUnsafe(sql, ...params));
  }
}

/**
 * Replace the asset's LLDP neighbor rows with the latest scrape. Idempotent:
 * existing rows that match (assetId, localIfName, chassisId, portId) are
 * upserted in place so `firstSeen` survives across scrapes; rows in the table
 * that aren't in this scrape are deleted.
 *
 * `matchedAssetId` is resolved here by joining each neighbor against the asset
 * inventory by management IP, chassis MAC, and system name. The Device Map
 * topology endpoint reads this back to draw real edges to non-Fortinet gear
 * (LLDP catches what fortinetTopology can't see).
 */
// LLDP stickiness window — one contract, two readers: persistLldpNeighbors
// keeps a vanished neighbor row this long before deleting it, and
// persistManagedApLldpNeighbors treats another writer's row younger than
// this as "fresh" when deciding ownership. They must agree.
const LLDP_STICKY_WINDOW_MS = 48 * 60 * 60 * 1000;

export async function persistLldpNeighbors(
  assetId: string,
  neighbors: LldpNeighborSample[],
  now: Date,
  defaultSource: "fortios" | "snmp" | string,
): Promise<void> {
  // `localIfName` is a JOIN KEY, not a caption: the System tab's Neighbor
  // column, the alert email's LLDP block and auto-monitor's By-LLDP rule all
  // look up interfaces by it. LLDP-MIB hands us whatever `lldpLocPortId` /
  // `lldpLocPortDesc` say, which on a FortiSwitch is the operator's port
  // DESCRIPTION — so rows arrived keyed "MORGAN-221E-1" and "Tim Smith"
  // instead of port9 and port12, duplicating the same neighbour under two
  // names and teaching By-LLDP to pin a port that doesn't exist (prod
  // 2026-08-25). Map every label back onto the port that carries it.
  const identity = await loadInterfaceIdentity(assetId);
  let lldpRelabeled = 0;
  if (identity.labelToName.size > 0 && neighbors.length > 0) {
    const deduped: LldpNeighborSample[] = [];
    const byKey = new Set<string>();
    for (const n of neighbors) {
      const canon = canonicalInterfaceName(n.localIfName, identity);
      const row = canon && canon !== n.localIfName ? { ...n, localIfName: canon } : n;
      if (canon && canon !== n.localIfName) lldpRelabeled++;
      // Renaming can collide with the same neighbour already reported under
      // the real port name — the bulk upsert targets the business key, so a
      // duplicate would be two INSERTs for one row.
      const k = `${row.localIfName}${row.chassisId ?? ""}${row.portId ?? ""}`;
      if (byKey.has(k)) continue;
      byKey.add(k);
      deduped.push(row);
    }
    if (lldpRelabeled > 0) {
      logger.warn(
        { assetId, relabeled: lldpRelabeled, collapsed: neighbors.length - deduped.length },
        "LLDP local port labels were port descriptions — keyed to the ports they describe",
      );
    }
    neighbors = deduped;
  }
  const endMatch = startPhase("systeminfo.persist.lldp_match_index");
  const matchIndex = await getLldpAssetMatchIndex();
  endMatch();
  const matchedFor = (n: LldpNeighborSample): string | null => {
    if (n.managementIp) {
      const m = matchIndex.byIp.get(n.managementIp);
      if (m && m !== assetId) return m;
    }
    if (n.chassisIdSubtype === "macAddress" && n.chassisId) {
      const mac = n.chassisId.toUpperCase();
      const m = matchIndex.byMac.get(mac);
      if (m && m !== assetId) return m;
    }
    // Workstation LLDP agents (Windows native, FortiClient, etc.) commonly
    // put the Ethernet MAC in portId(macAddress) rather than chassisId, so
    // the MAC arm above misses them. Try portId against the MAC index too.
    if (n.portIdSubtype === "macAddress" && n.portId) {
      const mac = n.portId.toUpperCase();
      const m = matchIndex.byMac.get(mac);
      if (m && m !== assetId) return m;
    }
    // Hostname arms (business rule 91): a name several assets share — the
    // per-site switch-id of a FortiLink fleet — is matched only to the
    // candidate under the same gate as this asset, else to nothing. The
    // belt-and-suspenders FQDN → leftmost-label retry is kept: the index
    // builder already adds short forms when it sees FQDNs, but both
    // directions are defended.
    const byName = (lower: string): string | null => {
      let m = pickLldpHostnameMatch(matchIndex, assetId, lower);
      if (!m && lower.includes(".")) m = pickLldpHostnameMatch(matchIndex, assetId, lower.split(".")[0]);
      return m;
    };
    if (n.systemName) {
      const m = byName(n.systemName.toLowerCase());
      if (m) return m;
    }
    // Some LLDP implementations leave systemName empty and put the hostname
    // in chassisId with subtype local(7) or chassisComponent(1). Treat any
    // non-MAC chassisId as a possible hostname when it looks printable.
    if (n.chassisId && n.chassisIdSubtype !== "macAddress") {
      const raw = String(n.chassisId).trim();
      // Skip values that look like MACs or contain whitespace — those won't
      // match a hostname index entry anyway, and we don't want to pollute
      // logs with bogus lookups.
      if (raw && !/\s/.test(raw) && !/^([0-9a-f]{2}[:-]){5}[0-9a-f]{2}$/i.test(raw)) {
        const m = byName(raw.toLowerCase());
        if (m) return m;
      }
    }
    return null;
  };

  // Existing rows for diffing. Keyed the same way the unique index is —
  // (localIfName, chassisId ?? "", portId ?? "") to handle Postgres-distinct nulls.
  const endFind = startPhase("systeminfo.persist.lldp_find_existing");
  const existing = await prisma.assetLldpNeighbor.findMany({ where: { assetId } });
  endFind({ rows: existing.length });
  const seen = new Set<string>();
  const keyOf = (li: string, ci: string | null | undefined, pi: string | null | undefined) =>
    `${li}\u0001${ci ?? ""}\u0001${pi ?? ""}`;
  const existingByKey = new Map<string, typeof existing[number]>();
  for (const e of existing) existingByKey.set(keyOf(e.localIfName, e.chassisId, e.portId), e);

  // Build a unified upsert list. Existing rows reuse their prior id (so the
  // ON CONFLICT (id) DO UPDATE branch fires and firstSeen survives); new rows
  // get a fresh randomUUID() so they don't collide and take the INSERT branch.
  // Both flow through one bulk statement — see bulkUpsertLldpNeighbors below
  // for why we target the PK instead of the (assetId, localIfName, chassisId,
  // portId) business key.
  const toUpsert: LldpUpsertRow[] = [];

  for (const n of neighbors) {
    const k = keyOf(n.localIfName, n.chassisId ?? null, n.portId ?? null);
    seen.add(k);
    const matched = matchedFor(n);
    const prior = existingByKey.get(k);
    toUpsert.push({
      id: prior?.id ?? randomUUID(),
      data: {
        localIfName:       n.localIfName,
        chassisIdSubtype:  n.chassisIdSubtype ?? null,
        chassisId:         n.chassisId ?? null,
        portIdSubtype:     n.portIdSubtype ?? null,
        portId:            n.portId ?? null,
        portDescription:   n.portDescription ?? null,
        systemName:        n.systemName ?? null,
        systemDescription: n.systemDescription ?? null,
        managementIp:      n.managementIp ?? null,
        capabilities:      n.capabilities ?? [],
        matchedAssetId:    matched,
        source:            defaultSource,
      },
    });
  }

  // Stickiness rule for stale rows. LLDP advertisements get missed
  // intermittently — a packet drops, a switch reboots, a peer briefly
  // unplugs — and a hard "delete on every scrape that doesn't see them"
  // rule made the operator-visible Neighbor column flap empty for those
  // gaps. Instead, keep the prior row for a 48-hour grace period UNLESS
  // a fresh scrape just learned a DIFFERENT neighbor on the same local
  // port (in which case the new value supersedes immediately — that's
  // a real topology change, not a missed advertisement).
  const STALE_AFTER_MS = LLDP_STICKY_WINDOW_MS;
  const portsWithFreshNeighbor = new Set<string>();
  for (const n of neighbors) portsWithFreshNeighbor.add(n.localIfName);
  const toDelete: string[] = [];
  for (const e of existing) {
    const k = keyOf(e.localIfName, e.chassisId, e.portId);
    if (seen.has(k)) continue; // refreshed by this scrape — keep
    // Same port saw a different neighbor → real change, drop the old.
    if (portsWithFreshNeighbor.has(e.localIfName)) {
      toDelete.push(e.id);
      continue;
    }
    // A row keyed by a port DESCRIPTION is the same port under a label (see
    // the canonicalization at the top) — it is a duplicate by construction,
    // not a missed advertisement, so the 48h grace period doesn't apply to
    // it. Without this, every mislabeled row lingers for two days and keeps
    // answering interface lookups under the wrong name.
    const canon = canonicalInterfaceName(e.localIfName, identity);
    if (canon && canon !== e.localIfName) {
      toDelete.push(e.id);
      continue;
    }
    // No fresh neighbor on this port; honor the 48h grace period before
    // declaring the row stale.
    const ageMs = now.getTime() - new Date(e.lastSeen).getTime();
    if (ageMs > STALE_AFTER_MS) {
      toDelete.push(e.id);
    }
  }
  // Single bulk upsert covers both creates and in-place updates — one SQL
  // round-trip instead of the legacy createMany + $transaction([per-row
  // updates]) pair (which held a connection for the duration of N pipelined
  // updates inside a BEGIN/COMMIT). On a switch with 40 LLDP neighbors that
  // collapses ~42 statements into 1.
  if (toUpsert.length > 0) {
    const endUpsert = startPhase("systeminfo.persist.lldp_upsert");
    await bulkUpsertLldpNeighbors(assetId, toUpsert, now);
    endUpsert({ rows: toUpsert.length });
  }
  if (toDelete.length > 0) {
    const endDelete = startPhase("systeminfo.persist.lldp_deleteMany");
    await retryOnDeadlock(() =>
      prisma.assetLldpNeighbor.deleteMany({ where: { id: { in: toDelete } } }),
    );
    endDelete({ rows: toDelete.length });
  }

  // Change detection → notification engine (gated; no-op when unsubscribed).
  // Added = neighbor keys not previously present; removed = rows just deleted.
  const added: ChangeItem[] = [];
  for (const n of neighbors) {
    if (!existingByKey.has(keyOf(n.localIfName, n.chassisId ?? null, n.portId ?? null))) {
      added.push({ label: `${n.systemName || n.chassisId || "neighbor"} on ${n.localIfName}`, details: { localIfName: n.localIfName, systemName: n.systemName, chassisId: n.chassisId } });
    }
  }
  const removed: ChangeItem[] = [];
  const deleteSet = new Set(toDelete);
  for (const e of existing) {
    if (deleteSet.has(e.id)) {
      removed.push({ label: `${e.systemName || e.chassisId || "neighbor"} on ${e.localIfName}`, details: { localIfName: e.localIfName, systemName: e.systemName, chassisId: e.chassisId } });
    }
  }
  if (added.length || removed.length) {
    const assetName = (await prisma.asset.findUnique({ where: { id: assetId }, select: { hostname: true } }))?.hostname ?? null;
    await maybeEmitChangeEvents("change.lldp.neighbor_added", assetId, assetName, added);
    await maybeEmitChangeEvents("change.lldp.neighbor_removed", assetId, assetName, removed);
  }
}

/**
 * Persist the LLDP neighbor table a managed FortiAP reported through its
 * parent FortiGate's /api/v2/monitor/wifi/managed_ap response (parsed by
 * utils/fortiapLldp.parseApLldpNeighbors, carried on
 * DiscoveredFortiAP.lldpNeighbors). Called from the FMG/FortiGate discovery
 * sync layer per online AP — this is how APs get REAL AssetLldpNeighbor rows
 * (source "managed-ap"), since the agentless LLDP streams can't reach them:
 * rest_api targets the asset's own IP with a FortiOS endpoint APs don't
 * serve, and SNMP LLDP-MIB on the AP itself is usually disabled.
 *
 * Ownership guard: skips (returns "skipped") when the asset is monitored,
 * its resolved lldpPolling is "snmp", AND that stream is actually delivering
 * — i.e. rows from another writer (source != "managed-ap") were refreshed
 * within the 48h stickiness window. A live SNMP LLDP stream owns the table
 * (two full-replace writers would alternate row sets), but a configured-yet-
 * dead one must not: FortiAPs usually don't expose LLDP-MIB, so an AP class
 * whose lldpPolling resolves to snmp (e.g. inherited from the interfaces
 * transport at some tier) would otherwise defer forever to a stream that
 * never writes, leaving the table empty. rest_api is deliberately NOT
 * treated as an owner either (it can never succeed against an AP).
 *
 * Local port names are normalized against the AP's most recent interface
 * samples (lan1 ↔ eth0, see utils/fortiapInterfaceAlias.ts) so rows line up
 * with the System-tab interface table and dedupe against the peer-inferred
 * synthesizer, which normalizes the same way.
 */
export async function persistManagedApLldpNeighbors(
  assetId: string,
  neighbors: ApLldpNeighborSample[],
  now: Date,
): Promise<"persisted" | "skipped"> {
  const asset = await prisma.asset.findUnique({
    where: { id: assetId },
    omit: PROBE_ASSET_OMIT,
    include: { discoveredByIntegration: { select: { type: true } } },
  });
  if (!asset) return "skipped";
  if (asset.monitored) {
    const effective = await resolveMonitorSettings({
      ...asset,
      discoveredByIntegrationType: asset.discoveredByIntegration?.type ?? null,
    });
    if (effective.lldpPolling === "snmp") {
      const otherWriterFresh = await prisma.assetLldpNeighbor.findFirst({
        where: {
          assetId,
          source: { not: "managed-ap" },
          lastSeen: { gte: new Date(now.getTime() - LLDP_STICKY_WINDOW_MS) },
        },
        select: { id: true },
      });
      if (otherWriterFresh) return "skipped";
    }
  }
  // The AP's own interface names, from the CURRENT-STATE inventory. This needs
  // the FULL set (an unpinned eth0 is exactly the case being normalized), which
  // is why it can't read the pinned-only sample table. Also replaces a
  // timestamp-ordered `take: 64` scan with a scoped indexed read.
  const ifRows = await prisma.assetInterface.findMany({
    where: { assetId },
    select: { ifName: true },
  });
  const knownIfNames = new Set(ifRows.map((r) => r.ifName));
  const normalized: LldpNeighborSample[] = neighbors.map((n) => ({
    ...n,
    localIfName: normalizeFortiapInterfaceName(n.localIfName, knownIfNames),
  }));
  // Drop rows sitting on an ALIAS of a fresh row's port (lan1 vs eth0 name
  // the same NIC). The normalization outcome can flip between runs — a new
  // AP persists as "lan1" before its first SNMP interface samples exist,
  // then "eth0" after — and the stickiness grace in persistLldpNeighbors
  // would otherwise keep the old-named rows as duplicates for 48 hours.
  // Safe because this writer owns the AP's table (see the snmp guard above).
  const aliasPorts = new Set<string>();
  for (const n of normalized) {
    for (const a of fortiapInterfaceAliases(n.localIfName)) {
      if (a !== n.localIfName) aliasPorts.add(a);
    }
  }
  if (aliasPorts.size > 0) {
    await prisma.assetLldpNeighbor.deleteMany({
      where: { assetId, localIfName: { in: [...aliasPorts] } },
    });
  }
  await persistLldpNeighbors(assetId, normalized, now, "managed-ap");
  return "persisted";
}

type LldpUpsertRow = {
  id: string;
  data: {
    localIfName: string;
    chassisIdSubtype: string | null;
    chassisId: string | null;
    portIdSubtype: string | null;
    portId: string | null;
    portDescription: string | null;
    systemName: string | null;
    systemDescription: string | null;
    managementIp: string | null;
    capabilities: readonly string[];
    matchedAssetId: string | null;
    source: string;
  };
};

/**
 * Single-statement bulk upsert into asset_lldp_neighbors. Conflict target
 * is the primary key (id), NOT the (assetId, localIfName, chassisId, portId)
 * business-key unique constraint — Postgres treats NULL as distinct in
 * unique indexes, so a row with chassisId IS NULL would never match an
 * ON CONFLICT on the business key. The caller (persistLldpNeighbors) pre-
 * assigns ids by looking up prior rows in JS, so we know which inserts
 * should land as updates.
 *
 * `capabilities` (text[]) is encoded as an explicit ARRAY[$N,$N,$N]::text[]
 * expression per row rather than passing the JS array as a single bound
 * parameter — pg adapter behavior with array-typed parameters via
 * $executeRawUnsafe is undocumented in this codebase, so we stay on the
 * unambiguous path. For typical LLDP rows with 1-4 capability tokens this
 * adds a handful of extra parameter slots per row, well inside the 65535
 * parameter ceiling even for switches with hundreds of neighbors.
 */
async function bulkUpsertLldpNeighbors(
  assetId: string,
  rows: readonly LldpUpsertRow[],
  now: Date,
): Promise<void> {
  if (rows.length === 0) return;
  const params: unknown[] = [];
  const tuples: string[] = [];
  let p = 1;
  const nowIso = now.toISOString();
  for (const r of rows) {
    const d = r.data;
    const capPlaceholders: string[] = [];
    for (const cap of d.capabilities) {
      params.push(cap);
      capPlaceholders.push(`$${p++}`);
    }
    const capExpr =
      capPlaceholders.length > 0
        ? `ARRAY[${capPlaceholders.join(",")}]::text[]`
        : `ARRAY[]::text[]`;
    const tupleParts = [
      `$${p++}::uuid`,            // id
      `$${p++}`,                  // assetId
      `$${p++}`,                  // localIfName
      `$${p++}`,                  // chassisIdSubtype
      `$${p++}`,                  // chassisId
      `$${p++}`,                  // portIdSubtype
      `$${p++}`,                  // portId
      `$${p++}`,                  // portDescription
      `$${p++}`,                  // systemName
      `$${p++}`,                  // systemDescription
      `$${p++}`,                  // managementIp
      capExpr,                    // capabilities
      `$${p++}`,                  // matchedAssetId
      `$${p++}`,                  // source
      `$${p++}::timestamp`,       // firstSeen
      `$${p++}::timestamp`,       // lastSeen
    ];
    tuples.push(`(${tupleParts.join(", ")})`);
    params.push(
      r.id,
      assetId,
      d.localIfName,
      d.chassisIdSubtype,
      d.chassisId,
      d.portIdSubtype,
      d.portId,
      d.portDescription,
      d.systemName,
      d.systemDescription,
      d.managementIp,
      d.matchedAssetId,
      d.source,
      nowIso,
      nowIso,
    );
  }
  const sql =
    `INSERT INTO "asset_lldp_neighbors" (` +
    `"id", "assetId", "localIfName", ` +
    `"chassisIdSubtype", "chassisId", "portIdSubtype", "portId", ` +
    `"portDescription", "systemName", "systemDescription", "managementIp", ` +
    `"capabilities", "matchedAssetId", "source", "firstSeen", "lastSeen"` +
    `) VALUES ${tuples.join(", ")} ` +
    `ON CONFLICT ("id") DO UPDATE SET ` +
    `"chassisIdSubtype"  = EXCLUDED."chassisIdSubtype", ` +
    `"chassisId"         = EXCLUDED."chassisId", ` +
    `"portIdSubtype"     = EXCLUDED."portIdSubtype", ` +
    `"portId"            = EXCLUDED."portId", ` +
    `"portDescription"   = EXCLUDED."portDescription", ` +
    `"systemName"        = EXCLUDED."systemName", ` +
    `"systemDescription" = EXCLUDED."systemDescription", ` +
    `"managementIp"      = EXCLUDED."managementIp", ` +
    `"capabilities"      = EXCLUDED."capabilities", ` +
    `"matchedAssetId"    = EXCLUDED."matchedAssetId", ` +
    `"source"            = EXCLUDED."source", ` +
    `"lastSeen"          = EXCLUDED."lastSeen"`;
  await retryOnDeadlock(() => prisma.$executeRawUnsafe(sql, ...params));
}

/**
 * Persist a fapStationTable scrape into `AssetWirelessStation`. Full-replace
 * semantics per (apAssetId, staMacAddr): every row that's in the fresh
 * scrape is upserted (timestamps + ssid/signal/etc bumped), every stored
 * row absent from the fresh scrape is deleted. **No 48h stickiness** —
 * wireless clients are transient by design; a station that roamed or
 * disconnected should drop from the table immediately.
 *
 * `matchedAssetId` is resolved by MAC lookup against the endpoint
 * inventory using the same cached index LLDP uses. When a match lands,
 * the endpoint's `Asset.lastSeenAp` is bumped to the AP's hostname so the
 * endpoint's asset details page shows which AP last saw it.
 */
export async function persistWirelessStations(
  apAssetId: string,
  stations: WirelessStationSample[],
): Promise<void> {
  // Reuse the LLDP match index — same lookup shape (MAC → assetId) and the
  // 60 s TTL already covers the system-info cadence. Wireless rows only
  // match by MAC (the index also carries IP / hostname maps but those are
  // not relevant here — a station's MAC is the only stable identity in
  // the AP's view).
  const matchIndex = await getLldpAssetMatchIndex();

  // Look up the AP's hostname once so we can stamp every matched endpoint's
  // lastSeenAp without re-fetching per-station.
  const apRow = await prisma.asset.findUnique({
    where: { id: apAssetId },
    select: { hostname: true },
  });
  const apHostname = apRow?.hostname ?? null;

  // Existing rows for diffing. Keyed by MAC (the unique constraint half
  // that varies — apAssetId is fixed for this call).
  const existing = await prisma.assetWirelessStation.findMany({ where: { apAssetId } });
  const existingByMac = new Map<string, typeof existing[number]>();
  for (const e of existing) existingByMac.set(e.staMacAddr, e);

  const seen = new Set<string>();
  const toUpsert: WirelessUpsertRow[] = [];
  // Endpoint-side `lastSeenAp` stamps. One per matched station; deduplicated
  // by endpoint id so a single AP with N rooms-worth of clients still hits
  // each endpoint's row once.
  const endpointStamps = new Map<string, string>(); // assetId → apHostname

  for (const s of stations) {
    const mac = s.staMacAddr.toUpperCase();
    if (!/^([0-9A-F]{2}:){5}[0-9A-F]{2}$/.test(mac)) continue; // malformed; skip
    seen.add(mac);
    const matchedAssetId = matchIndex.byMac.get(mac) ?? null;
    if (matchedAssetId && matchedAssetId !== apAssetId && apHostname) {
      endpointStamps.set(matchedAssetId, apHostname);
    }
    const ex = existingByMac.get(mac);
    toUpsert.push({
      id: ex?.id ?? randomUUID(),
      data: {
        staMacAddr:     mac,
        staIpAddr:      s.staIpAddr ?? null,
        ssid:           s.ssid ?? null,
        radioId:        s.radioId ?? null,
        wlanId:         s.wlanId ?? null,
        band:           s.band ?? null,
        vlanId:         s.vlanId ?? null,
        bssid:          s.bssid ?? null,
        signalStrength: s.signalStrength ?? null,
        noise:          s.noise ?? null,
        bandwidthTx:    s.bandwidthTx ?? null,
        bandwidthRx:    s.bandwidthRx ?? null,
        idleSeconds:    s.idleSeconds ?? null,
        matchedAssetId,
        // Station identity comes from SNMP fapStationTable; signal/noise are an
        // optional FortiOS-REST overlay from the controller (wifi/client).
        source:         (s.signalStrength != null || s.noise != null) ? "snmp+rest" : "snmp",
      },
    });
  }

  // Anything stored but not in the fresh scrape → drop. Same semantics as
  // associatedIp's monitor-source rows: per-scrape full-replace, no grace
  // period.
  const toDelete: string[] = [];
  for (const e of existing) {
    if (!seen.has(e.staMacAddr)) toDelete.push(e.id);
  }

  if (toUpsert.length > 0) {
    await bulkUpsertWirelessStations(apAssetId, toUpsert, new Date());
  }
  if (toDelete.length > 0) {
    await retryOnDeadlock(() =>
      prisma.assetWirelessStation.deleteMany({ where: { id: { in: toDelete } } }),
    );
  }

  // Stamp each matched endpoint's lastSeenAp. Don't block the persist on
  // these — they're operator-visible breadcrumbs, not load-bearing data —
  // but await so the System tab sees the change on the next refresh.
  //
  // Deterministic lock ordering: sort the updates by asset id so EVERY
  // concurrent endpoint-stamp transaction acquires its `assets` row locks in
  // the same order. The PG deadlock log showed a 3-way cycle where all three
  // participants were exactly this lastSeenAp UPDATE — two/three APs whose
  // stations match an overlapping endpoint set were locking those rows in
  // different (Map-insertion) order. Sorting by id makes the cycle
  // impossible. `$transaction([...])` executes the array sequentially, so the
  // sort order IS the lock-acquisition order.
  //
  // retryOnDeadlock stays as a backstop for any residual collision (e.g. this
  // txn vs the probe-patch bulk Asset UPDATE, which locks in its own order).
  // The op is idempotent (last-write-wins stamp) so re-run is safe.
  if (endpointStamps.size > 0) {
    // Read the endpoints' current AP first, then write only the ones that
    // actually moved. Two payoffs: a steady set of stations stops issuing an
    // UPDATE per scrape (less write volume + less lock contention on exactly
    // the rows the deadlock note above is about), and the prior value is what
    // makes the roam event below reportable.
    const prior = await prisma.asset.findMany({
      where: { id: { in: [...endpointStamps.keys()] } },
      select: { id: true, lastSeenAp: true, hostname: true, ipAddress: true },
    });
    const priorById = new Map(prior.map((r) => [r.id, r]));
    const orderedStamps = [...endpointStamps.entries()]
      // Filtering preserves the sort below it — the id ordering is the
      // deadlock fix and must survive any change to this block.
      .filter(([endpointId, ap]) => {
        const p = priorById.get(endpointId);
        if (!p) return false; // asset vanished between match and stamp
        return (p.lastSeenAp ?? "").trim().toLowerCase() !== ap.trim().toLowerCase();
      })
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    if (orderedStamps.length > 0) {
      await retryOnDeadlock(() =>
        prisma.$transaction(
          orderedStamps.map(([endpointId, ap]) =>
            prisma.asset.update({ where: { id: endpointId }, data: { lastSeenAp: ap } }),
          ),
        ),
      );
      // Roam audit — AFTER the transaction commits, never inside it (an event
      // write must not extend the lock window these rows are contended on).
      // Written only while an automation uses the roam trigger: unconditional,
      // every client's every roam flooded the Events log (2026-11-09).
      const roamEvents = !(await wirelessRoamEventsWanted()) ? [] : orderedStamps.flatMap(([endpointId, ap]) => {
        const p = priorById.get(endpointId)!;
        const ev = buildConnectionChangedEvent(
          "ap",
          {
            assetId: endpointId,
            assetName: p.hostname || p.ipAddress || null,
            actor: "system:monitor",
            source: "wireless-scrape",
          },
          p.lastSeenAp,
          ap,
        );
        return ev ? [ev] : [];
      });
      if (roamEvents.length > 0) void logEventsBatch(roamEvents);
    }
  }
}

type WirelessUpsertRow = {
  id: string;
  data: {
    staMacAddr: string;
    staIpAddr: string | null;
    ssid: string | null;
    radioId: number | null;
    wlanId: number | null;
    band: string | null;
    vlanId: number | null;
    bssid: string | null;
    signalStrength: number | null;
    noise: number | null;
    bandwidthTx: number | null;
    bandwidthRx: number | null;
    idleSeconds: number | null;
    matchedAssetId: string | null;
    source: string;
  };
};

/**
 * Single-statement bulk upsert into asset_wireless_stations. Same shape as
 * `bulkUpsertLldpNeighbors` — conflict target is the PK so callers control
 * insert-vs-update by pre-assigning ids. Replaces the legacy createMany +
 * $transaction([per-row updates]) pair (which held a connection across N
 * pipelined updates inside BEGIN/COMMIT). No text[] field to worry about,
 * so the per-row tuple is a straight parameter list.
 */
async function bulkUpsertWirelessStations(
  apAssetId: string,
  rows: readonly WirelessUpsertRow[],
  now: Date,
): Promise<void> {
  if (rows.length === 0) return;
  const params: unknown[] = [];
  const tuples: string[] = [];
  let p = 1;
  const nowIso = now.toISOString();
  for (const r of rows) {
    const d = r.data;
    const tupleParts = [
      `$${p++}::uuid`,            // id
      `$${p++}`,                  // apAssetId
      `$${p++}`,                  // staMacAddr
      `$${p++}`,                  // staIpAddr
      `$${p++}`,                  // ssid
      `$${p++}`,                  // radioId
      `$${p++}`,                  // wlanId
      `$${p++}`,                  // band
      `$${p++}`,                  // vlanId
      `$${p++}`,                  // bssid
      `$${p++}`,                  // signalStrength
      `$${p++}`,                  // noise
      `$${p++}`,                  // bandwidthTx
      `$${p++}`,                  // bandwidthRx
      `$${p++}`,                  // idleSeconds
      `$${p++}`,                  // matchedAssetId
      `$${p++}`,                  // source
      `$${p++}::timestamp`,       // firstSeen
      `$${p++}::timestamp`,       // lastSeen
    ];
    tuples.push(`(${tupleParts.join(", ")})`);
    params.push(
      r.id,
      apAssetId,
      d.staMacAddr,
      d.staIpAddr,
      d.ssid,
      d.radioId,
      d.wlanId,
      d.band,
      d.vlanId,
      d.bssid,
      d.signalStrength,
      d.noise,
      d.bandwidthTx,
      d.bandwidthRx,
      d.idleSeconds,
      d.matchedAssetId,
      d.source,
      nowIso,
      nowIso,
    );
  }
  const sql =
    `INSERT INTO "asset_wireless_stations" (` +
    `"id", "apAssetId", "staMacAddr", ` +
    `"staIpAddr", "ssid", "radioId", "wlanId", "band", "vlanId", ` +
    `"bssid", "signalStrength", "noise", "bandwidthTx", "bandwidthRx", ` +
    `"idleSeconds", "matchedAssetId", "source", "firstSeen", "lastSeen"` +
    `) VALUES ${tuples.join(", ")} ` +
    `ON CONFLICT ("id") DO UPDATE SET ` +
    `"staIpAddr"      = EXCLUDED."staIpAddr", ` +
    `"ssid"           = EXCLUDED."ssid", ` +
    `"radioId"        = EXCLUDED."radioId", ` +
    `"wlanId"         = EXCLUDED."wlanId", ` +
    `"band"           = EXCLUDED."band", ` +
    `"vlanId"         = EXCLUDED."vlanId", ` +
    `"bssid"          = EXCLUDED."bssid", ` +
    `"signalStrength" = EXCLUDED."signalStrength", ` +
    `"noise"          = EXCLUDED."noise", ` +
    `"bandwidthTx"    = EXCLUDED."bandwidthTx", ` +
    `"bandwidthRx"    = EXCLUDED."bandwidthRx", ` +
    `"idleSeconds"    = EXCLUDED."idleSeconds", ` +
    `"matchedAssetId" = EXCLUDED."matchedAssetId", ` +
    `"source"         = EXCLUDED."source", ` +
    `"lastSeen"       = EXCLUDED."lastSeen"`;
  await retryOnDeadlock(() => prisma.$executeRawUnsafe(sql, ...params));
}
