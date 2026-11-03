/**
 * src/services/assetSightingService.ts — Asset → FortiGate sighting log
 *
 * Records every (asset, FortiGate) pair where discovery has handed out a DHCP
 * lease/reservation to the asset. Drives the quarantine fan-out:
 * `assetQuarantineService` reads this log to pick which FortiGates to push
 * the asset's MACs to. Only DHCP-level evidence is recorded — transit
 * sightings via the System tab's interface scrape are intentionally
 * excluded so we don't quarantine an asset on a FortiGate that just
 * happened to ARP for its IP.
 *
 * Settings:
 *   quarantine.sightingMaxAgeDays — default 180. Sightings whose `lastSeen`
 *     is older than this are filtered out by `getQuarantineCandidates` so a
 *     laptop that hasn't been at a site for 6+ months doesn't push to that
 *     site's FortiGate. 0 disables the filter (every recorded sighting is
 *     a candidate forever). Stored rows are not deleted by this setting —
 *     pruning is a separate operation if/when we add it.
 */

import { prisma } from "../db.js";
import { bareFortinetDeviceName } from "../utils/assetSourceLocation.js";
import { buildFirewallChangedEvent, logEventsBatch, type LogEventInput } from "./eventLogService.js";

export type SightingSource = "dhcp_lease" | "dhcp_reservation";

export interface SightingInput {
  assetId: string;
  fortigateDevice: string;
  source: SightingSource;
  integrationId?: string | null;
  /** IP address observed on this FortiGate at sighting time. */
  ipAddress?: string | null;
  /** Defaults to now. */
  seenAt?: Date;
  /**
   * Asset hostname for the gateway-change audit event's resourceName. Supplied
   * by the caller (which already holds the row) so this service never has to
   * query assets to name them.
   */
  assetHostname?: string | null;
}

const SETTINGS_KEY = "quarantineSightingSettings";

export interface SightingSettings {
  /** Sightings older than this are excluded from quarantine fan-out. 0 = forever. */
  sightingMaxAgeDays: number;
}

const DEFAULTS: SightingSettings = { sightingMaxAgeDays: 180 };

export async function getSightingSettings(): Promise<SightingSettings> {
  const row = await prisma.setting.findUnique({ where: { key: SETTINGS_KEY } });
  if (!row) return { ...DEFAULTS };
  const v = row.value as any;
  const d = Number(v?.sightingMaxAgeDays);
  return {
    sightingMaxAgeDays:
      Number.isFinite(d) && d >= 0 ? Math.floor(d) : DEFAULTS.sightingMaxAgeDays,
  };
}

export async function updateSightingSettings(
  settings: SightingSettings,
): Promise<void> {
  await prisma.setting.upsert({
    where: { key: SETTINGS_KEY },
    update: { value: settings as any },
    create: { key: SETTINGS_KEY, value: settings as any },
  });
}

export interface FreshestGateChange {
  assetId: string;
  from: string;
  to: string;
}

/**
 * Which assets' FRESHEST FortiGate sighting is about to change gate — i.e.
 * "this device moved from behind gate A to behind gate B".
 *
 * Freshest = max lastSeen across the asset's sighting rows, the same rule
 * `syncEndpointDependencyEdges` uses to pick an endpoint's parent gate, so this
 * event tracks the value that actually drives dependency suppression. A gate
 * move inserts a NEW row rather than updating one (the unique key includes
 * fortigateDevice) and nothing prunes the old row, which is why "freshest"
 * rather than "only" is the question.
 *
 * Pure — the caller supplies the current rows and the incoming batch.
 *
 * Three deliberate silences:
 *  - An asset with no current rows is a FIRST sighting, not a move.
 *  - Devices compare after `bareFortinetDeviceName` + case folding, so the same
 *    gate written with and without an integration prefix isn't a change.
 *  - THE TAKEOVER GUARD: nothing is reported while the incumbent gate is ALSO
 *    being refreshed in this same batch. A device with a live lease on one gate
 *    and a not-yet-expired lease on another has both rows stamped to ~now every
 *    run, so "freshest" tie-flips every cycle and would emit forever. Requiring
 *    the incumbent to fall silent means a real move is reported once the old
 *    gate stops handing the device an address — later than the move itself (by
 *    up to the old lease's life), but the alternative is a permanent flap.
 */
export function computeFreshestGateChanges(
  current: Array<{ assetId: string; fortigateDevice: string; lastSeen: Date }>,
  incoming: Array<{ assetId: string; fortigateDevice: string; seenAt: Date }>,
): FreshestGateChange[] {
  const norm = (d: string) => bareFortinetDeviceName((d ?? "").trim()).toLowerCase();

  // Current rows per asset + the incumbent (max lastSeen; tie → lexicographic
  // device so the pick is deterministic across runs).
  const currentByAsset = new Map<string, Array<{ device: string; at: number }>>();
  for (const row of current) {
    if (!row.assetId || !row.fortigateDevice) continue;
    const list = currentByAsset.get(row.assetId);
    const entry = { device: row.fortigateDevice, at: row.lastSeen?.getTime?.() ?? 0 };
    if (list) list.push(entry);
    else currentByAsset.set(row.assetId, [entry]);
  }
  const pickFreshest = (list: Array<{ device: string; at: number }>) =>
    list.reduce((best, e) =>
      e.at > best.at || (e.at === best.at && e.device < best.device) ? e : best,
    );

  const incomingByAsset = new Map<string, Array<{ device: string; at: number }>>();
  for (const row of incoming) {
    if (!row.assetId || !row.fortigateDevice) continue;
    const list = incomingByAsset.get(row.assetId);
    const entry = { device: row.fortigateDevice, at: row.seenAt?.getTime?.() ?? 0 };
    if (list) list.push(entry);
    else incomingByAsset.set(row.assetId, [entry]);
  }

  const changes: FreshestGateChange[] = [];
  for (const [assetId, incomingRows] of incomingByAsset) {
    const currentRows = currentByAsset.get(assetId);
    if (!currentRows || currentRows.length === 0) continue; // first sighting
    const incumbent = pickFreshest(currentRows);

    // Takeover guard — incumbent still being refreshed ⇒ not a move.
    if (incomingRows.some((r) => norm(r.device) === norm(incumbent.device))) continue;

    // Post-write state: existing rows, with the incoming ones folded in
    // (a refreshed pair takes max(existing, incoming)).
    const post = new Map<string, { device: string; at: number }>();
    for (const e of currentRows) {
      const k = norm(e.device);
      const prev = post.get(k);
      if (!prev || e.at > prev.at) post.set(k, e);
    }
    for (const e of incomingRows) {
      const k = norm(e.device);
      const prev = post.get(k);
      if (!prev || e.at > prev.at) post.set(k, e);
    }
    const winner = pickFreshest([...post.values()]);
    if (norm(winner.device) !== norm(incumbent.device)) {
      changes.push({ assetId, from: incumbent.device, to: winner.device });
    }
  }
  return changes;
}

/**
 * Batch-upsert sightings. Uses INSERT ... ON CONFLICT to bump lastSeen +
 * source + integrationId on the existing row, or insert a fresh one.
 *
 * Empty input → no-op. Inputs are deduped on (assetId, fortigateDevice,
 * source) keeping the latest seenAt per key: a gate that holds both a lease
 * and a reservation for the device keeps a row for each (2026-11-03 — before,
 * the reservation won the tie and the lease, often the address the device is
 * actually using, never showed).
 *
 * Also emits `asset.gateway_firewall.changed` for any asset whose freshest
 * sighting moves to a different gate — see computeFreshestGateChanges.
 */
export async function recordSightings(rows: SightingInput[]): Promise<void> {
  if (rows.length === 0) return;

  // Dedupe by (assetId, fortigateDevice, source), keeping the latest seenAt.
  const dedupedMap = new Map<string, SightingInput>();
  for (const row of rows) {
    if (!row.assetId || !row.fortigateDevice) continue;
    const key = `${row.assetId}\u0000${row.fortigateDevice}\u0000${row.source}`;
    const existing = dedupedMap.get(key);
    if (!existing || (row.seenAt ?? new Date()).getTime() > (existing.seenAt ?? new Date()).getTime()) {
      dedupedMap.set(key, row);
    }
  }

  const deduped = Array.from(dedupedMap.values());

  // Gate-change detection needs the pre-write picture. One query over the
  // deduped asset ids (tens to low hundreds per run), returning that asset's
  // handful of gate rows — bounded well under the fleet size at 2000 assets.
  let gateChanges: FreshestGateChange[] = [];
  try {
    const assetIds = [...new Set(deduped.map((r) => r.assetId))];
    const currentRows = await prisma.assetFortigateSighting.findMany({
      where: { assetId: { in: assetIds } },
      select: { assetId: true, fortigateDevice: true, lastSeen: true },
    });
    gateChanges = computeFreshestGateChanges(
      currentRows,
      deduped.map((r) => ({
        assetId: r.assetId,
        fortigateDevice: r.fortigateDevice,
        seenAt: r.seenAt ?? new Date(),
      })),
    );
  } catch {
    // Audit detection must never break sighting recording.
  }

  // Run upserts in parallel (small N — typically tens to low hundreds per
  // discovery run). prisma.upsert is the cleanest expression of the desired
  // semantics (insert with onConflict-update lastSeen/source/integration);
  // a raw INSERT...ON CONFLICT is faster but adds maintenance cost we don't
  // need yet.
  const tasks = deduped.map((row) => {
    const seen = row.seenAt ?? new Date();
    return prisma.assetFortigateSighting.upsert({
      where: {
        assetId_fortigateDevice_source: {
          assetId: row.assetId,
          fortigateDevice: row.fortigateDevice,
          source: row.source,
        },
      },
      update: {
        lastSeen: seen,
        ...(row.integrationId !== undefined
          ? { integrationId: row.integrationId }
          : {}),
        ...(row.ipAddress !== undefined ? { ipAddress: row.ipAddress } : {}),
      },
      create: {
        assetId: row.assetId,
        fortigateDevice: row.fortigateDevice,
        source: row.source,
        integrationId: row.integrationId ?? null,
        ipAddress: row.ipAddress ?? null,
        firstSeen: seen,
        lastSeen: seen,
      },
    });
  });

  await Promise.allSettled(tasks);

  if (gateChanges.length > 0) {
    try {
      const nameByAsset = new Map<string, string | null>();
      for (const r of deduped) {
        if (r.assetHostname && !nameByAsset.get(r.assetId)) nameByAsset.set(r.assetId, r.assetHostname);
      }
      const events: LogEventInput[] = [];
      for (const c of gateChanges) {
        const ev = buildFirewallChangedEvent(
          {
            assetId: c.assetId,
            assetName: nameByAsset.get(c.assetId) ?? null,
            actor: "system:discovery",
            source: "dhcp-sighting",
          },
          c.from,
          c.to,
        );
        if (ev) events.push(ev);
      }
      if (events.length > 0) await logEventsBatch(events);
    } catch {
      // Never throw out of sighting recording.
    }
  }
}

export interface AssetSighting {
  id: string;
  assetId: string;
  integrationId: string | null;
  fortigateDevice: string;
  source: string;
  ipAddress: string | null;
  firstSeen: Date;
  lastSeen: Date;
}

export async function getSightingsForAsset(assetId: string): Promise<AssetSighting[]> {
  return prisma.assetFortigateSighting.findMany({
    where: { assetId },
    orderBy: { lastSeen: "desc" },
  });
}

/**
 * Return the FortiGates the asset has been seen on within the configured
 * sightingMaxAgeDays window. The quarantine service uses this to decide
 * which devices to push to.
 */
export async function getQuarantineCandidates(
  assetId: string,
): Promise<AssetSighting[]> {
  const settings = await getSightingSettings();
  // One candidate per GATE — the freshest of its rows (a gate holding both a
  // lease and a reservation has two), so a quarantine pushes once per gate.
  const byGate = new Map<string, AssetSighting>();
  for (const s of await getSightingsForAsset(assetId)) {
    if (!byGate.has(s.fortigateDevice)) byGate.set(s.fortigateDevice, s); // ordered lastSeen desc
  }
  const all = [...byGate.values()];
  if (settings.sightingMaxAgeDays <= 0) return all;
  const cutoff = Date.now() - settings.sightingMaxAgeDays * 86_400_000;
  return all.filter((s) => s.lastSeen.getTime() >= cutoff);
}
