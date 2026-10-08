/**
 * src/services/interfaceInventoryService.ts
 *
 * CURRENT-STATE interface inventory (`asset_interfaces`) — one row per
 * (asset, ifName), full-replaced per scrape. The delete-replace pattern used by
 * `persistPhysicalEntities` / `persistMacTable` / `persistMclagPeers`.
 *
 * WHY THIS TABLE EXISTS
 * Every all-interface consumer wants CURRENT STATE, not history: the System tab
 * renders exactly one timestamp, and topology inference, auto-monitor's pin
 * candidate list and the FortiAP lan1/eth0 name normalization all want "the
 * latest row per (assetId, ifName)". Expressed against the hypertable that is a
 * DISTINCT ON which had to be time-bounded after being measured at 13.5 minutes
 * / 90M rows / 9 GB of I/O on prod (see interfaceTopologyService). Here each of
 * those reads is an indexed lookup over roughly one row per interface.
 *
 * It is also what lets `asset_interface_samples` carry ONLY operator-pinned
 * interfaces. The unpinned sample rows existed solely to answer the
 * current-state question above, and they were the worst-value rows Polaris
 * wrote: never compressed (deleted at 24h while the selection-aware compression
 * floor is 2 days), never rolled up, and removed by a row-level DELETE — the
 * operation behind the 2026-06-08 and 2026-06-17 compressed-chunk bloat
 * incidents.
 *
 * SINGLE WRITER CADENCE — load-bearing
 * Only the FULL system-info pass and the Polaris Agent push may call
 * `persistInterfaces`. `recordFastFilteredResult` must NOT: the fast pass sees
 * only pinned interfaces (`collectFastFiltered` filters the scrape), so a
 * per-asset delete-replace from it would wipe every unpinned interface's row on
 * every probe tick. It also writes ifType/ifParent/vlanId as NULL, which is
 * precisely the topology-column loss this table exists to prevent.
 */
import { prisma } from "../db.js";
import { logger } from "../utils/logger.js";
import { logEvent } from "./eventLogService.js";
import {
  buildInterfaceIdentity,
  canonicalizeInterfacePins,
  EMPTY_INTERFACE_IDENTITY,
  type InterfaceIdentity,
} from "../utils/interfaceIdentity.js";
import { matchTrunkPeer, trunkPeerNameTail } from "../utils/fortiswitchTrunkMap.js";
import type { InterfaceSample } from "./monitoringService.js";

/**
 * Cap per asset. A stacked chassis can legitimately report several hundred
 * interfaces (48 ports × N members, plus VLANs, aggregates and tunnels), so the
 * cap is generous — it exists to bound a runaway walk, not to trim real
 * hardware. Truncation is WARNED rather than silent: a partial interface list
 * that looks complete would quietly hide ports from the System tab and, worse,
 * from the auto-monitor pin picker that is built from this table.
 */
export const INTERFACE_ROW_CAP = 2000;

/**
 * Row shape written to `asset_interfaces`, minus the columns this service owns
 * (`assetId`, `firstSeen`, `lastSeen`). The agent push already builds rows in
 * this shape for the sample table, so it can hand them straight to
 * `persistInterfaceRows` instead of re-mapping all 22 columns a second time.
 */
export type InterfaceInventoryRow = Omit<
  import("../generated/prisma/client.js").Prisma.AssetInterfaceCreateManyInput,
  "assetId" | "firstSeen" | "lastSeen"
>;

/**
 * Map a collector `InterfaceSample` onto the table's column set. Mirrors the
 * mapping in `persistInterfaceSampleStream` so the two representations of an
 * interface can't drift.
 */
function toRow(i: InterfaceSample): InterfaceInventoryRow {
  return {
    ifName:      i.ifName,
    adminStatus: i.adminStatus ?? null,
    operStatus:  i.operStatus ?? null,
    speedBps:    i.speedBps != null ? BigInt(Math.round(i.speedBps)) : null,
    ipAddress:   i.ipAddress ?? null,
    macAddress:  i.macAddress ?? null,
    inOctets:    i.inOctets  != null ? BigInt(Math.round(i.inOctets))  : null,
    outOctets:   i.outOctets != null ? BigInt(Math.round(i.outOctets)) : null,
    inErrors:    i.inErrors  != null ? BigInt(Math.round(i.inErrors))  : null,
    outErrors:   i.outErrors != null ? BigInt(Math.round(i.outErrors)) : null,
    ifType:      i.ifType   ?? null,
    ifParent:    i.ifParent ?? null,
    vlanId:      i.vlanId   ?? null,
    nativeVlan:  i.nativeVlan ?? null,
    taggedVlans: i.taggedVlans ?? [],
    trunksAllVlans: i.trunksAllVlans === true,
    alias:       i.alias       ?? null,
    description: i.description ?? null,
    addressingMode: i.addressingMode ?? null,
    poeStatus:   i.poeStatus ?? null,
    poeClass:    i.poeClass  ?? null,
  };
}

/**
 * Collapse duplicate ifNames, keeping the FIRST occurrence, and cap the list.
 *
 * `(assetId, ifName)` is unique, so a scrape that reports the same name twice
 * would abort the whole transaction. A duplicate is a collector/device quirk,
 * not something worth failing an otherwise-good scrape over — but it is worth
 * saying out loud, because a silently-dropped port looks identical to a port
 * that isn't there.
 *
 * Exported for unit testing; pure.
 */
export function dedupeAndCapInterfaces<T extends { ifName: string }>(
  interfaces: T[],
): { rows: T[]; duplicates: number; dropped: number } {
  const seen = new Set<string>();
  const rows: T[] = [];
  let duplicates = 0;
  let dropped = 0;
  for (const i of interfaces) {
    if (!i?.ifName) continue;
    if (seen.has(i.ifName)) { duplicates++; continue; }
    if (rows.length >= INTERFACE_ROW_CAP) { dropped++; continue; }
    seen.add(i.ifName);
    rows.push(i);
  }
  return { rows, duplicates, dropped };
}

/**
 * Statuses under which a trunk peer still counts as "present" for the
 * preservation pass below. A decommissioned / disabled / shelved peer means
 * the trunk is legitimately gone and its interface row should go with it;
 * a peer merely in a maintenance window is still cabled to this switch.
 */
const TRUNK_PEER_PRESENT_STATUSES = ["active", "maintenance"];

/**
 * Which of an asset's about-to-be-dropped interface rows are FortiLink trunk
 * interfaces whose peer still exists — and should therefore be PRESERVED.
 *
 * FortiSwitchOS names its auto-created FortiLink trunk aggregates after the
 * PEER's serial ("8EF5920000001-0", see utils/fortiswitchTrunkMap.ts) — and
 * removes the aggregate from the ifTable entirely while the link is down. To
 * the delete-replace scrape that is indistinguishable from a port that never
 * existed, so a downed inter-switch trunk vanished from the inventory, the
 * System tab and the pin picker at exactly the moment an operator was looking
 * for it (the down alert it fired names an interface that "doesn't exist").
 *
 * A dropped row is preserved only when BOTH ends still vouch for the trunk:
 *   1. its name resolves (serial suffix-match, ambiguity refuses) to exactly
 *      one OTHER asset that is still active / in maintenance, and
 *   2. that peer's own interface inventory carries a reciprocal trunk row
 *      naming THIS asset's serial.
 * The reciprocity check is stable across the outage because preserved rows
 * stay in the table: whichever side scrapes first still sees the other side's
 * row, and from then on each side's preserved row satisfies the other's
 * check. Decommissioning either switch (or unpairing them) breaks a
 * condition and the row ages out on the next full scrape.
 *
 * Best-effort: a failed read falls back to the plain delete-replace rather
 * than failing the scrape.
 */
async function resolvePreservedTrunkNames(
  assetId: string,
  droppedNames: string[],
): Promise<string[]> {
  const candidates = droppedNames
    .map((name) => ({ name, tail: trunkPeerNameTail(name) }))
    .filter((c): c is { name: string; tail: string } => c.tail != null);
  if (candidates.length === 0) return [];

  try {
    // Same fleet-wide serial scan persistTrunkMembers runs — only reached
    // when a full scrape actually drops a serial-shaped interface name.
    const assets = await prisma.asset.findMany({
      where: { serialNumber: { not: null } },
      select: { id: true, serialNumber: true, status: true },
    });
    // Without our own serial the peer can't have a reciprocal row naming us.
    const selfSerial = assets.find((a) => a.id === assetId)?.serialNumber ?? null;
    if (!selfSerial) return [];

    const serialToAssetId = new Map<string, string>();
    for (const a of assets) {
      if (a.id === assetId || !a.serialNumber) continue;
      if (!TRUNK_PEER_PRESENT_STATUSES.includes(a.status)) continue;
      serialToAssetId.set(a.serialNumber, a.id);
    }

    const peerByName = new Map<string, string>();
    for (const c of candidates) {
      const peerId = matchTrunkPeer(c.tail, serialToAssetId);
      if (peerId) peerByName.set(c.name, peerId);
    }
    if (peerByName.size === 0) return [];

    const peerIfaces = await prisma.assetInterface.findMany({
      where: { assetId: { in: [...new Set(peerByName.values())] } },
      select: { assetId: true, ifName: true },
    });
    const selfAsPeerMap = new Map([[selfSerial, assetId]]);
    const reciprocated = new Set<string>();
    for (const row of peerIfaces) {
      const tail = trunkPeerNameTail(row.ifName);
      if (tail && matchTrunkPeer(tail, selfAsPeerMap) === assetId) {
        reciprocated.add(row.assetId);
      }
    }

    return candidates
      .filter((c) => {
        const peerId = peerByName.get(c.name);
        return peerId != null && reciprocated.has(peerId);
      })
      .map((c) => c.name);
  } catch (err) {
    logger.warn({ err, assetId }, "trunk-interface preservation check failed — falling back to plain replace");
    return [];
  }
}

/**
 * Full-replace an asset's current-state interface inventory.
 *
 * Contract (the LLDP / physical-entity contract, enforced by the CALLER):
 *   - a collector that can't supply interfaces → don't call this at all, stored
 *     rows stay.
 *   - `[]` → wipes the asset's rows.
 *   - EXCEPTION: a FortiLink trunk interface whose peer switch still exists
 *     (and reciprocates) survives the replace even when absent from the
 *     scrape, marked `operStatus="down"` — see resolvePreservedTrunkNames.
 *
 * NOTE the system-info caller deliberately does NOT call this on an empty
 * array. Unlike LLDP, an empty interface list is ambiguous: a FortiOS token
 * without monitor scope (and other transient states) answers 200 OK with empty
 * results, and the pre-existing `lastSystemInfoAt` guard in
 * `recordSystemInfoResult` already treats that as "preserve the prior set
 * rather than display nothing while the device is online". Wiping here on empty
 * would blank the System tab for exactly those cases.
 *
 * `firstSeen` is preserved for an interface still present in the scrape, so
 * "this port has existed since March" survives a re-scrape; a name that
 * disappears and later returns correctly resets it — except a preserved trunk
 * row, which never left the table and keeps its history across the outage.
 *
 * Delete + insert run in ONE transaction so a concurrent reader sees the old
 * set or the new set, never an empty intermediate — this table backs the System
 * tab, so an empty read would render as "this device has no interfaces".
 */
export async function persistInterfaces(
  assetId: string,
  interfaces: InterfaceSample[],
  now: Date = new Date(),
): Promise<void> {
  await persistInterfaceRows(assetId, interfaces.map(toRow), now);
}

/**
 * The core of `persistInterfaces`, taking rows already in table shape.
 *
 * Exists so the Polaris Agent push — which already maps its NIC table into
 * exactly these columns for the sample write — can reuse them instead of
 * re-mapping all 22 fields, which would be a second place for the two
 * representations of an interface to drift.
 */
export async function persistInterfaceRows(
  assetId: string,
  incoming: InterfaceInventoryRow[],
  now: Date = new Date(),
): Promise<void> {
  const { rows, duplicates, dropped } = dedupeAndCapInterfaces(incoming);
  if (duplicates > 0) {
    logger.warn({ assetId, duplicates }, "duplicate ifName in interface scrape — keeping first occurrence");
  }
  if (dropped > 0) {
    logger.warn({ assetId, dropped, cap: INTERFACE_ROW_CAP }, "interface inventory truncated");
  }

  const existing = await prisma.assetInterface.findMany({
    where: { assetId },
    select: { ifName: true, firstSeen: true },
  });
  const priorFirstSeen = new Map(existing.map((e) => [e.ifName, e.firstSeen]));

  // A FortiLink trunk aggregate leaves the ifTable while its link is down, so
  // "absent from the scrape" does not always mean "gone". Preserve trunk rows
  // both ends still vouch for, marked down (see resolvePreservedTrunkNames).
  const incomingNames = new Set(rows.map((r) => r.ifName));
  const droppedNames = existing.map((e) => e.ifName).filter((n) => !incomingNames.has(n));
  const preserved = droppedNames.length > 0
    ? await resolvePreservedTrunkNames(assetId, droppedNames)
    : [];

  const results = await prisma.$transaction([
    prisma.assetInterface.deleteMany({
      where: preserved.length > 0
        ? { assetId, ifName: { notIn: preserved } }
        : { assetId },
    }),
    ...(rows.length > 0
      ? [prisma.assetInterface.createMany({
          data: rows.map((r) => ({
            assetId,
            ...r,
            firstSeen: priorFirstSeen.get(r.ifName) ?? now,
            lastSeen:  now,
          })),
        })]
      : []),
    // The device stating nothing about the trunk IS the down signal — the
    // aggregate only leaves the ifTable when the link is down. Edge-triggered:
    // a trunk already marked down issues no write on later scrapes. lastSeen
    // deliberately stays at the last real sighting.
    ...(preserved.length > 0
      ? [prisma.assetInterface.updateMany({
          where: {
            assetId,
            ifName: { in: preserved },
            OR: [{ operStatus: null }, { operStatus: { not: "down" } }],
          },
          data: { operStatus: "down" },
        })]
      : []),
  ]);
  if (preserved.length > 0) {
    const flipped = (results[results.length - 1] as { count: number }).count;
    if (flipped > 0) {
      logger.info(
        { assetId, preserved },
        "FortiLink trunk interface absent from scrape — preserved as down (peer switch still active with a reciprocal trunk)",
      );
    }
  }
  // The identity map is derived from exactly these rows.
  invalidateInterfaceIdentity(assetId);
}

// ─── Interface identity (name-vs-label reconciliation) ──────────────────────
// See utils/interfaceIdentity.ts for WHY this exists: a scrape that answered
// `ifDescr`-only renames a port to its DESCRIPTION, and that name then becomes
// an identity in the pin list, the sample table and every alert dimension.
// This table is the identity of record, so it is what the reconciliation reads.

/**
 * TTL for the per-asset identity cache. The map only changes when the FULL
 * system-info pass rewrites the inventory (`pollInterval`-linked, minutes to
 * 24h) and that write invalidates the entry directly — so this bound exists
 * only to age out assets nothing is scraping any more. Sized so the 60s fast
 * cadence costs one read per asset per five minutes instead of one per tick,
 * which at 2000 monitored assets is the difference between ~33/s and ~7/min.
 */
const IDENTITY_TTL_MS = 5 * 60 * 1000;

/** Entries before the cache is cleared wholesale (the poeAbsentCache pattern). */
const IDENTITY_CACHE_MAX = 5000;

const identityCache = new Map<string, { at: number; identity: InterfaceIdentity }>();

/** Drop an asset's cached identity — call after any write to its inventory. */
export function invalidateInterfaceIdentity(assetId: string): void {
  identityCache.delete(assetId);
}

/** Test seam: forget every cached identity. */
export function clearInterfaceIdentityCache(): void {
  identityCache.clear();
}

/**
 * The asset's interface identity, from the current-state inventory.
 *
 * An asset with no inventory rows yields the EMPTY identity, which makes every
 * canonicalization a no-op — the right answer for a device that hasn't
 * completed a full scrape yet, since we have nothing to reconcile against and
 * must not drop or rename what it reports.
 */
export async function loadInterfaceIdentity(assetId: string): Promise<InterfaceIdentity> {
  const hit = identityCache.get(assetId);
  if (hit && Date.now() - hit.at < IDENTITY_TTL_MS) return hit.identity;
  try {
    const rows = await prisma.assetInterface.findMany({
      where: { assetId },
      select: { ifName: true, alias: true, description: true },
    });
    const identity = buildInterfaceIdentity(rows);
    if (identityCache.size >= IDENTITY_CACHE_MAX) identityCache.clear();
    identityCache.set(assetId, { at: Date.now(), identity });
    return identity;
  } catch (err) {
    // Best-effort: a failed read must never fail the scrape it was enriching.
    logger.warn({ err, assetId }, "interface identity read failed — collecting names as reported");
    return EMPTY_INTERFACE_IDENTITY;
  }
}

/**
 * Rewrite an asset's interface pins that name a port DESCRIPTION rather than a
 * port, collapsing them onto the port they describe.
 *
 * Runs on the full pass, where the inventory it reconciles against was just
 * written. Edge-triggered — a steady-state asset issues no write at all — and
 * audited, because a pin is an operator-visible statement about what is
 * monitored and this silently changes one.
 */
export async function repairInterfacePins(
  assetId: string,
  identity: InterfaceIdentity,
  pins: readonly string[] | null | undefined,
  hostname?: string | null,
): Promise<void> {
  if (!pins || pins.length === 0) return;
  const fixed = canonicalizeInterfacePins(pins, identity);
  if (!fixed || fixed.renamed.length === 0) return;
  try {
    await prisma.asset.update({
      where: { id: assetId },
      data: { monitoredInterfaces: fixed.pins },
    });
  } catch (err) {
    logger.warn({ err, assetId }, "interface pin repair failed");
    return;
  }
  // The audit names the PORTS, never the labels the pins used to carry. A port
  // description is operator-authored free text and in the field it is often a
  // person ("Tim Smith" on a desk port) — Events are readable by anyone with
  // events access AND shipped off-host by the syslog / SFTP archivers, which
  // is the same reasoning business rule 35(e) applies to directory PII. The
  // label adds nothing actionable anyway: it is on the port's own row in-app.
  const ports = fixed.renamed.map((r) => r.to).join(", ");
  // Awaited, unlike the fire-and-forget logEvent calls on the scrape hot path:
  // this only runs when a pin actually moved (a handful of assets, once), and
  // a silent pin change with no audit row is the failure worth avoiding.
  await logEvent({
    action: "asset.interface_pin.canonicalized",
    resourceType: "asset",
    resourceId: assetId,
    resourceName: hostname || undefined,
    level: "info",
    message:
      `Monitored interface pin${fixed.renamed.length === 1 ? "" : "s"} named a port description rather than ` +
      `the port on ${hostname || assetId} — rewritten onto ${ports}`,
    details: { ports: fixed.renamed.map((r) => r.to), renamed: fixed.renamed.length, pins: fixed.pins },
  });
}
