/**
 * src/services/fortinetLinkStateService.ts
 *
 * Controller link state for FortiGate-managed FortiSwitches and FortiAPs —
 * business rule 58.
 *
 * What it answers: does the parent FortiGate currently have a session to this
 * device? The FortiLink session for a managed FortiSwitch, the CAPWAP tunnel
 * for a managed FortiAP. Both are reported by the same two controller tables
 * the REST probe already reads (`switch-controller/managed-switch/status` and
 * `wifi/managed_ap`), and both transports have always parsed the field — it
 * simply had no projected home, so it reached the Sources tab inside the
 * AssetSource observed blob and nowhere an operator or an automation could use
 * it.
 *
 * ── Why a sweep and not the probe ──────────────────────────────────────────
 * `probeFortinetController` already turns exactly this signal into up/down,
 * but only for assets whose resolved `responseTimePolling` is `rest_api`. For
 * those, the link state IS their monitorStatus and a separate field would say
 * nothing new. The devices where it says something new are the ones polled by
 * ICMP or SNMP: a switch that answers every ping while its FortiLink session
 * is dead is a real fault that the monitor loop is structurally unable to see,
 * because it is asking the switch, and the switch is fine. Only the controller
 * knows. So the sweep runs over every FortiGate-managed switch and AP
 * regardless of polling method.
 *
 * ── What it costs ──────────────────────────────────────────────────────────
 * It calls monitoringService's `fetchFortinetControllerInventory`, sharing its
 * 30s per-controller cache — so cost scales with CONTROLLER count, not fleet
 * size. That is the same property that makes the probe path survive FMG proxy
 * mode at concurrency 1, and it is the ceiling that matters: 2 calls per
 * controller per tick (switches + APs), whether that controller manages 3
 * devices or 300.
 *
 * Be precise about the overlap with the probe path, because it is tempting to
 * claim more than it delivers. The sweep and the monitor loop run on separate
 * 60s timers with a 30s cache between them, so their ticks coalesce only when
 * they happen to land in the same window — roughly half the time, drifting.
 * A controller already serving REST-probed devices therefore goes from ~1 call
 * per minute per kind to ~1.5, NOT to 1 and not to 2. A controller serving
 * only ICMP/SNMP-polled devices was being asked nothing and now costs the full
 * 2 per tick. Raise `POLARIS_FORTILINK_SWEEP_SEC` on an install where that
 * matters; the FMG-proxy arithmetic is in the job file.
 *
 * Writes are diffed in memory and issued as at most three `updateMany`s per
 * controller (one per destination value) plus one timestamp refresh, so a
 * steady fleet of 2000 devices issues a handful of statements per tick rather
 * than one per asset.
 *
 * ── Three refusals that keep it from crying wolf ───────────────────────────
 *  1. A controller we could not READ writes nothing. Not "down" for every
 *     device behind it — a dark FMG or an expired token would otherwise
 *     report a fleet-wide link outage, which is the single loudest false
 *     alarm this feature could produce. Same contract as `ProbeResult.skipped`.
 *  2. A device the controller answered about but did NOT list reads `unknown`,
 *     not `down`. The probe path treats absent as failure, and for a probe
 *     that is right; here it is not, because a brief post-config-push window
 *     looks identical (the same reason discovery's decommission sweep trusts
 *     the CMDB roster over the live status query), and down-detection
 *     authority belongs to rule 36.
 *  3. It never touches `monitorStatus`, `consecutiveFailures`, or anything
 *     else the five-state machine owns. The value of this column is precisely
 *     that it can DISAGREE with monitorStatus; folding it in would erase the
 *     disagreement.
 */

import { prisma } from "../db.js";
import { logger } from "../utils/logger.js";
import { isFortinetIntegrationType } from "../utils/pollingCompatibility.js";
import { isFortiapStatusOnline } from "../utils/fortiapMonitorRow.js";
import { fetchFortinetControllerInventory } from "./monitoringService.js";
import { buildFortilinkChangedEvent, logEventsBatch } from "./eventLogService.js";
import { recordFortilinkState } from "../metrics.js";

/** The three values `Asset.fortilinkStatus` can hold. null = never swept. */
export type FortilinkStatus = "up" | "down" | "unknown";

/** Upstream timeout for one controller inventory call. Matches the probe. */
const CONTROLLER_TIMEOUT_MS = 20_000;

export interface FortilinkSweepResult {
  /** Controllers we successfully read (one count per switch/AP table). */
  controllersRead: number;
  /** Controllers whose read failed — their devices were left untouched. */
  controllersFailed: number;
  /** Devices whose stored value moved this pass (one Event each). */
  transitions: number;
  /** Devices the sweep confirmed without a change. */
  unchanged: number;
}

/** One asset the sweep can speak about. */
interface LinkStateAssetRow {
  id: string;
  hostname: string | null;
  ipAddress: string | null;
  assetType: string;
  serialNumber: string | null;
  fortinetTopology: unknown;
  fortilinkStatus: string | null;
  fortilinkStatusRaw: string | null;
  discoveredByIntegrationId: string | null;
}

interface ControllerGroup {
  integration: { id: string; type: string; name: string; config: Record<string, unknown> };
  deviceName: string;
  kind: "switches" | "aps";
  assets: LinkStateAssetRow[];
}

/**
 * Resolve the controller FortiGate's name for one managed device, exactly the
 * way `probeFortinetController` does: the topology stamp, falling back to the
 * integration's own host for a standalone FortiGate (where the integration IS
 * the one controller, whatever the blob happens to say).
 *
 * Deliberately the device NAME and not `fortinetParentKey`'s serial-first
 * resolution — this is not parent resolution, it is the key FortiOS/FMG
 * addresses the controller by on the wire, and it is the same key the shared
 * inventory cache is bucketed on. Resolving it any other way would miss the
 * cache and double the upstream rate.
 */
function controllerNameFor(asset: LinkStateAssetRow, integrationType: string, config: Record<string, unknown>): string {
  const topo = (asset.fortinetTopology ?? {}) as Record<string, unknown>;
  const stamped = typeof topo.controllerFortigate === "string" ? topo.controllerFortigate.trim() : "";
  if (stamped) return stamped;
  if (integrationType === "fortigate") return String(config.host || "").trim();
  return "";
}

/**
 * Normalize one controller row into the stored vocabulary.
 *
 * Switches report "Connected" / "Disconnected"; APs report "online" /
 * "connected" / "offline" / "discovered" with the firmware variance
 * `isFortiapStatusOnline` already absorbs for the probe path. Reusing that
 * helper rather than re-deriving the online set is what keeps the sweep and
 * the probe from disagreeing about the same AP on the same firmware.
 */
function normalizeEntry(kind: "switches" | "aps", entry: { connected: boolean; status: string }): FortilinkStatus {
  if (kind === "aps") return isFortiapStatusOnline(entry.status) ? "up" : "down";
  return entry.connected ? "up" : "down";
}

/**
 * Load every FortiGate-managed switch/AP and bucket it by (integration,
 * controller, kind).
 *
 * The `select` is tight on purpose: this runs on a 60s tick against a table
 * that can hold 2000+ monitored rows, and `fortinetTopology` is already the
 * one wide column we cannot avoid (the controller name lives in it).
 *
 * Decommissioned assets are excluded — they have no live link to report and
 * including them would resurrect a link-down alert on hardware that was
 * deliberately retired. Unmonitored assets are deliberately INCLUDED: the
 * controller call is per-controller either way, so the row costs nothing
 * extra, and the asset-details row should be right even on a device nobody
 * polls. Whether it can ALERT is rule 37's question, answered downstream by
 * the automation engine's own `monitored` gate, not here.
 */
async function loadControllerGroups(): Promise<ControllerGroup[]> {
  const integrations = await prisma.integration.findMany({
    where: { type: { in: ["fortimanager", "fortigate"] }, enabled: true },
    select: { id: true, type: true, name: true, config: true },
  });
  if (integrations.length === 0) return [];
  const byId = new Map(integrations.map((i) => [i.id, i]));

  const assets = await prisma.asset.findMany({
    where: {
      assetType: { in: ["switch", "access_point"] },
      status: { not: "decommissioned" },
      discoveredByIntegrationId: { in: integrations.map((i) => i.id) },
      serialNumber: { not: null },
    },
    select: {
      id: true, hostname: true, ipAddress: true, assetType: true, serialNumber: true,
      fortinetTopology: true, fortilinkStatus: true, fortilinkStatusRaw: true,
      discoveredByIntegrationId: true,
    },
  });

  const groups = new Map<string, ControllerGroup>();
  for (const asset of assets) {
    const integration = asset.discoveredByIntegrationId ? byId.get(asset.discoveredByIntegrationId) : undefined;
    if (!integration || !isFortinetIntegrationType(integration.type)) continue;
    const config = (integration.config ?? {}) as Record<string, unknown>;
    const deviceName = controllerNameFor(asset as LinkStateAssetRow, integration.type, config);
    // No controller recorded = nothing to ask. A switch discovered before the
    // topology stamp existed self-heals on the next discovery cycle.
    if (!deviceName) continue;
    const kind: "switches" | "aps" = asset.assetType === "access_point" ? "aps" : "switches";
    const key = `${integration.id}::${deviceName}::${kind}`;
    let group = groups.get(key);
    if (!group) {
      group = { integration: { ...integration, config }, deviceName, kind, assets: [] };
      groups.set(key, group);
    }
    group.assets.push(asset as LinkStateAssetRow);
  }
  return Array.from(groups.values());
}

/**
 * One sweep pass: read each controller once, diff its answer against what the
 * assets currently store, and write only what moved.
 *
 * Controllers are read in PARALLEL across groups but the shared 30s cache and
 * the in-flight coalescing inside `fetchFortinetControllerInventory` mean a
 * burst here collapses to one upstream call per (controller, kind) — the same
 * protection the 60s monitor tick relies on. Per-group failures are isolated:
 * one unreachable FortiGate must not stop the other 49 from being swept.
 */
export async function sweepFortinetLinkState(): Promise<FortilinkSweepResult> {
  const groups = await loadControllerGroups();
  const result: FortilinkSweepResult = { controllersRead: 0, controllersFailed: 0, transitions: 0, unchanged: 0 };
  if (groups.length === 0) return result;

  const now = new Date();
  // assetId sets keyed by destination value, so the writes below are three
  // updateMany calls for the whole fleet instead of one per asset.
  const moved = new Map<FortilinkStatus, string[]>([["up", []], ["down", []], ["unknown", []]]);
  // Raw status differs per asset, so those can't share an updateMany. Only
  // assets that MOVED get one, which keeps this list to the size of the
  // transition set rather than the fleet.
  const rawWrites: Array<{ id: string; raw: string | null }> = [];
  const confirmed: string[] = [];
  const events: ReturnType<typeof buildFortilinkChangedEvent>[] = [];

  const outcomes = await Promise.allSettled(
    groups.map(async (group) => {
      const { inventory } = await fetchFortinetControllerInventory(
        group.integration,
        group.deviceName,
        group.kind,
        CONTROLLER_TIMEOUT_MS,
      );
      return { group, inventory };
    }),
  );

  for (const outcome of outcomes) {
    if (outcome.status === "rejected") {
      // Refusal 1: an unreadable controller writes NOTHING. Its devices keep
      // the last state the controller actually reported, and `checkedAt`
      // stops advancing — which is what the asset-details row reads to show
      // the value as stale rather than current.
      result.controllersFailed++;
      continue;
    }
    result.controllersRead++;
    const { group, inventory } = outcome.value;
    for (const asset of group.assets) {
      const serial = (asset.serialNumber || "").trim().toUpperCase();
      const entry = serial ? inventory.get(serial) : undefined;
      // Refusal 2: answered-but-absent is `unknown`, never `down`.
      const next: FortilinkStatus = entry ? normalizeEntry(group.kind, entry) : "unknown";
      const nextRaw = entry ? (entry.status || null) : null;
      if (asset.fortilinkStatus === next) {
        confirmed.push(asset.id);
        result.unchanged++;
        // The raw word can move while the normalized value holds (an AP going
        // "offline" → "discovered" is down throughout). Worth storing, not
        // worth an Event.
        if ((asset.fortilinkStatusRaw ?? null) !== nextRaw) rawWrites.push({ id: asset.id, raw: nextRaw });
        continue;
      }
      moved.get(next)!.push(asset.id);
      rawWrites.push({ id: asset.id, raw: nextRaw });
      result.transitions++;
      events.push(
        buildFortilinkChangedEvent(
          {
            assetId: asset.id,
            assetName: asset.hostname || asset.ipAddress,
            actor: "system:fortilink-sweep",
            source: group.integration.type,
            integrationId: group.integration.id,
            integrationName: group.integration.name,
          },
          asset.fortilinkStatus,
          next,
          nextRaw,
        ),
      );
    }
  }

  // ── Writes ────────────────────────────────────────────────────────────────
  // Three statements for every transition in the fleet, one for the confirmed
  // remainder, and one per asset whose raw word moved (a small set by
  // construction). Deliberately NOT a $transaction: these are independent
  // per-asset facts, a partial application is self-correcting on the next
  // tick, and holding a transaction open across the whole fleet on a 60s
  // cadence is the kind of lock pressure that shows up at 2000 assets.
  const writes: Array<Promise<unknown>> = [];
  for (const [value, ids] of moved) {
    if (ids.length === 0) continue;
    writes.push(
      prisma.asset.updateMany({
        where: { id: { in: ids } },
        data: { fortilinkStatus: value, fortilinkCheckedAt: now, fortilinkChangedAt: now },
      }),
    );
  }
  if (confirmed.length > 0) {
    // Confirmations refresh `checkedAt` ONLY. `changedAt` holding still is what
    // makes "down for 2h13m" on the asset row mean the outage length rather
    // than the age of the last poll.
    writes.push(
      prisma.asset.updateMany({ where: { id: { in: confirmed } }, data: { fortilinkCheckedAt: now } }),
    );
  }
  for (const { id, raw } of rawWrites) {
    writes.push(prisma.asset.update({ where: { id }, data: { fortilinkStatusRaw: raw } }));
  }
  await Promise.all(writes);
  if (events.length > 0) {
    await logEventsBatch(events.filter((e): e is NonNullable<typeof e> => e !== undefined));
  }

  recordFortilinkState(result.controllersRead, result.controllersFailed, result.transitions);
  if (result.transitions > 0 || result.controllersFailed > 0) {
    logger.info(result, "fortinet controller link sweep complete");
  }
  return result;
}
