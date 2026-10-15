// Persistence of each FortiGate's layer-3 neighbour cache into
// `AssetArpEntry`, the current-state table behind the firewall asset's ARP
// Table tab.
//
// The rows are not collected here — they already arrive on every FMG /
// standalone-FortiGate discovery cycle (`DiscoveryResult.arpTable`, read by
// fgtChainArp / fmgStepArp) and, before this, were consumed in memory by three
// passes and thrown away: empty-`ipAddress` enrichment, the Phase 7.6
// `Reservation.lastSeenArp` presence stamp, and Phase 7.7 placeholder-MAC
// adoption. This writer is the fourth consumer and the only one that keeps
// them, so the operator can read the same table the gate answered with.
//
// ── Contract ───────────────────────────────────────────────────────────────
// Delete-replace per gate, but ONLY for a gate whose ARP query answered this
// cycle (`answeredDevices`, from the per-device `didArpQuery` flag). This is
// the AssetLldpNeighbor rule — `undefined` preserves stored rows, `[]` wipes —
// and it matters more here than usual, because the ARP read is a live monitor
// call that fails routinely: an FMG-proxied read to an offline gate, a device
// whose admin profile lacks monitor scope, a run aborted mid-fleet. Every one
// of those returns nothing, and treating nothing as an empty neighbour cache
// would blank the tab for a healthy gate on the next cycle.
//
// ── Which asset ────────────────────────────────────────────────────────────
// An ARP row names its gate by FortiManager DEVICE NAME, which is emphatically
// not the firewall's hostname (see utils/fortinetParentKey.ts for what that
// conflation has cost). The hop is name → serial (from the run's own
// DiscoveredDevice list) → assetId (the `fortigate-firewall` AssetSource row
// discovery just wrote, whose externalId IS the serial). A gate with no
// resolvable asset is skipped rather than guessed at.

import { prisma } from "../db.js";
import { logger } from "../utils/logger.js";
import { chunkArray } from "../utils/chunk.js";
import { randomUUID } from "node:crypto";
import {
  prepareArpRows,
  groupArpRowsByDevice,
  ARP_ROWS_PER_ASSET_CAP,
  type PreparedArpRow,
  type RawArpRow,
} from "../utils/arpTable.js";
import type { ArpNeighborEntry } from "../utils/arpNeighbors.js";

/** Rows per `createMany` statement — well inside Postgres' 65535-parameter cap. */
const INSERT_CHUNK = 1000;

export interface ArpRowForPersist {
  fortigateDevice: string;
  ip: string;
  mac: string;
  interface: string;
  age?: number;
}

export interface PersistArpTablesOpts {
  integrationId: string;
  /** Every ARP row this run collected, across every gate. */
  rows: readonly ArpRowForPersist[];
  /**
   * FortiManager device names whose ARP query ANSWERED this cycle. A gate
   * absent from this list keeps whatever it had stored.
   */
  answeredDevices: readonly string[];
  /** Device name → serial, from the run's own DiscoveredDevice list. */
  deviceSerials: ReadonlyMap<string, string>;
  /**
   * MAC → assetId, resolved against the run's asset index. MAC only, never the
   * IP: an ARP row asserting that address belongs to that MAC is precisely the
   * evidence that an asset still carrying the address under a different MAC is
   * stale, so joining on the IP would attribute the row to the device it
   * disproves.
   */
  matchAssetByMac: (mac: string) => string | null | undefined;
  /** Discovery's own progress logger, so the counts land in the run log. */
  log?: (level: "info" | "warning", message: string) => void;
}

/**
 * Accumulate one asset's neighbour rows: bump what is still there, insert what
 * is new, touch nothing else.
 *
 * ONE round-trip regardless of row count. `INSERT … ON CONFLICT DO UPDATE` is
 * what makes two writers on different cadences safe — the monitor pass and
 * discovery can both land the same binding and the second is a no-op bump
 * rather than a duplicate or a wipe. `firstSeen` is deliberately NOT in the
 * update list, so "this address has been on this gate since…" survives.
 *
 * `ifName` is "" (never NULL) for an unattributed row because it is part of
 * the conflict target and Postgres treats NULLs as distinct — a nullable column
 * would insert a fresh duplicate per scrape for exactly those rows.
 */
export async function upsertArpNeighbors(
  assetId: string,
  rows: readonly PreparedArpRow[],
  matchAssetByMac?: (mac: string) => string | null | undefined,
): Promise<number> {
  if (rows.length === 0) return 0;

  let written = 0;
  // One stamp for the whole read, not one per chunk: the tab's "Current" view
  // is "the rows the newest read touched", resolved by lastSeen, so a
  // multi-chunk read must not split across several instants.
  const now = new Date().toISOString();
  for (const batch of chunkArray(rows, INSERT_CHUNK)) {
    const params: unknown[] = [assetId, now];
    const groups: string[] = [];
    for (const r of batch) {
      const idP    = params.push(randomUUID());
      const ipP    = params.push(r.ipAddress);
      const macP   = params.push(r.macAddress);
      const ifP    = params.push(r.ifName ?? "");
      const ageP   = params.push(r.ageSec);
      const matchP = params.push(matchAssetByMac?.(r.macAddress) ?? null);
      groups.push(`($${idP}, $1, $${ipP}, $${macP}, $${ifP}, $${ageP}::int, $${matchP}, $2::timestamp, $2::timestamp)`);
    }
    try {
      await prisma.$executeRawUnsafe(
        `INSERT INTO "asset_arp_entries"
           ("id", "assetId", "ipAddress", "macAddress", "ifName", "ageSec", "matchedAssetId", "firstSeen", "lastSeen")
         VALUES ${groups.join(", ")}
         ON CONFLICT ("assetId", "ipAddress", "macAddress", "ifName") DO UPDATE SET
           "lastSeen"       = EXCLUDED."lastSeen",
           "ageSec"         = EXCLUDED."ageSec",
           -- Only ever fill in a match, never clear one: the resolver is fed
           -- from whichever caller is running, and discovery's index is warm
           -- while the monitor pass may not resolve the same MAC.
           "matchedAssetId" = COALESCE(EXCLUDED."matchedAssetId", "asset_arp_entries"."matchedAssetId")`,
        ...params,
      );
      written += batch.length;
    } catch (err: any) {
      logger.warn(
        { phase: "arp_table.upsert_failed", assetId, rows: batch.length, err: err?.message },
        "ARP neighbour upsert failed",
      );
    }
  }
  return written;
}

/**
 * Persist one asset's freshly-collected neighbour cache. The monitor-cadence
 * entry point (system-info pass, REST or SNMP); discovery goes through
 * `persistFortigateArpTables`, which resolves gates to assets first and then
 * lands here per gate.
 */
export async function persistAssetArpNeighbors(
  assetId: string,
  rows: readonly ArpNeighborEntry[],
  matchAssetByMac?: (mac: string) => string | null | undefined,
): Promise<{ written: number; truncated: number }> {
  // Back onto the raw shape so the collector path gets the same normalization,
  // freshest-wins dedupe, ordering and cap the discovery path does -- one
  // definition of what a stored row looks like, not two.
  const raw: RawArpRow[] = rows.map((r) => ({
    ip:        r.ipAddress,
    mac:       r.macAddress,
    interface: r.ifName ?? "",
    age:       r.ageSec ?? undefined,
  }));
  const { entries, truncated } = prepareArpRows(raw, ARP_ROWS_PER_ASSET_CAP);
  if (truncated > 0) {
    logger.warn(
      { phase: "arp_table.truncated", assetId, kept: entries.length, dropped: truncated },
      "ARP table truncated at the per-asset cap",
    );
  }
  const written = await upsertArpNeighbors(assetId, entries, matchAssetByMac);
  return { written, truncated };
}

export interface PersistArpTablesResult {
  /** Firewall assets whose table was replaced. */
  assetsWritten:  number;
  entriesWritten: number;
  /** Rows dropped by the per-asset cap, summed across gates. */
  truncated:      number;
  /** Answering gates whose firewall asset could not be resolved. */
  unresolvedDevices: string[];
}

/**
 * Replace the stored ARP table of every gate that answered this cycle.
 *
 * Scale note: one `findMany` for the AssetSource rows and one `findMany` for
 * the existing `firstSeen` values across the WHOLE batch — not per gate — then
 * one transaction per gate. At 2000 assets the fleet-wide reads are the two
 * indexed queries below; the write cost tracks the number of FIREWALLS in the
 * integration (tens), not the asset count.
 */
export async function persistFortigateArpTables(
  opts: PersistArpTablesOpts,
): Promise<PersistArpTablesResult> {
  const { integrationId, rows, answeredDevices, deviceSerials, matchAssetByMac, log } = opts;
  const empty: PersistArpTablesResult = {
    assetsWritten: 0, entriesWritten: 0, truncated: 0, unresolvedDevices: [],
  };

  const answered = new Set(answeredDevices.map((d) => d.trim().toLowerCase()).filter(Boolean));
  if (answered.size === 0) return empty;

  // Serial lookup, case-folded on the device name for the same reason the row
  // buckets are (FMG payloads disagree on case).
  const serialByDeviceKey = new Map<string, string>();
  for (const [name, serial] of deviceSerials) {
    if (name && serial) serialByDeviceKey.set(name.trim().toLowerCase(), serial);
  }

  const wantedSerials = [...answered]
    .map((key) => serialByDeviceKey.get(key))
    .filter((s): s is string => !!s);
  if (wantedSerials.length === 0) {
    return { ...empty, unresolvedDevices: [...answered] };
  }

  const sourceRows = await prisma.assetSource.findMany({
    where: { integrationId, sourceKind: "fortigate-firewall", externalId: { in: wantedSerials } },
    select: { assetId: true, externalId: true },
  });
  const assetIdBySerial = new Map(sourceRows.map((r) => [r.externalId, r.assetId]));

  const rowsByDevice = groupArpRowsByDevice(rows);

  // Resolve every answering gate to its asset up front, so the two batch reads
  // below cover the whole run.
  const targets: Array<{ deviceKey: string; assetId: string; prepared: PreparedArpRow[]; truncated: number }> = [];
  const unresolvedDevices: string[] = [];
  for (const deviceKey of answered) {
    const serial  = serialByDeviceKey.get(deviceKey);
    const assetId = serial ? assetIdBySerial.get(serial) : undefined;
    if (!assetId) { unresolvedDevices.push(deviceKey); continue; }
    const { entries, truncated } = prepareArpRows(rowsByDevice.get(deviceKey) ?? [], ARP_ROWS_PER_ASSET_CAP);
    targets.push({ deviceKey, assetId, prepared: entries, truncated });
  }
  if (targets.length === 0) return { ...empty, unresolvedDevices };

  // firstSeen carry-forward: "this address has been on this gate since..." has
  // to survive the delete-replace, so the existing rows are read once for the
  // whole batch. Nothing is read up front any more: the upsert preserves
  // firstSeen in SQL (it is simply absent from the DO UPDATE list), so the
  // read-then-carry-forward the delete-replace version needed is gone.
  let assetsWritten  = 0;
  let entriesWritten = 0;
  let truncatedTotal = 0;

  for (const target of targets) {
    const written = await upsertArpNeighbors(target.assetId, target.prepared, matchAssetByMac);
    if (written === 0 && target.prepared.length > 0) {
      // upsertArpNeighbors logs the cause; surface it in the run log too, since
      // a gate silently contributing nothing looks like a gate with no
      // neighbours.
      log?.("warning", `ARP table: write failed for ${target.deviceKey}`);
      continue;
    }

    assetsWritten++;
    entriesWritten += written;
    truncatedTotal += target.truncated;

    if (target.truncated > 0) {
      // Loud on purpose: a cut table reads on the tab as "Polaris has never
      // seen that address", which is a different and wrong conclusion.
      logger.warn(
        { phase: "arp_table.truncated", device: target.deviceKey, assetId: target.assetId,
          kept: written, dropped: target.truncated },
        "ARP table truncated at the per-asset cap",
      );
      log?.("warning", `ARP table: ${target.deviceKey} reported ${written + target.truncated} entries — stored ${written}, dropped ${target.truncated} at the cap`);
    }
  }

  if (assetsWritten > 0) {
    log?.("info", `ARP tables: ${entriesWritten} entr${entriesWritten === 1 ? "y" : "ies"} recorded across ${assetsWritten} FortiGate${assetsWritten === 1 ? "" : "s"}`);
  }
  return { assetsWritten, entriesWritten, truncated: truncatedTotal, unresolvedDevices };
}
