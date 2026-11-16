/**
 * src/services/fortinetLinkStateService.ts
 *
 * Controller link state for FortiGate-managed FortiSwitches and FortiAPs —
 * business rule 59.
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
 * ── When a device is read: its interface cadence (rule 59(a)) ─────────────
 * The FortiLink session / CAPWAP tunnel is, in effect, a virtual interface
 * between the controller and the device, so it is read on the device's
 * INTERFACE cadence and only while interface polling is on (operator decision
 * 2026-11-16). Per device, through the same monitor-settings hierarchy the
 * system-info pass resolves:
 *  - DUE when `fortilinkCheckedAt` is null or at least one resolved
 *    `systemInfoIntervalSeconds` old (default 600 s);
 *  - OFF when the resolved `interfacesPolling` is null or "disabled", the
 *    interval is 0, or the asset is unmonitored (`monitored = false` stops the
 *    system-info pass too). An OFF device is not swept and its status / raw
 *    word / changedAt are cleared to null ONCE, so an automation sees no
 *    reading rather than a stale "up" — no Event, it is not a link change;
 *  - a device in maintenance is neither swept nor cleared (the system-info
 *    pass pauses for it too); its value goes stale and resumes afterwards.
 * Unlike the system-info pass, a device that is DOWN is still swept: the
 * controller's view is most useful exactly when the device is not answering.
 *
 * ── What it costs ──────────────────────────────────────────────────────────
 * A controller is asked only when at least one of its devices is due, through
 * monitoringService's `fetchFortinetControllerInventory` and its 30s
 * per-controller cache — so cost scales with CONTROLLER count, not fleet size:
 * at most 2 calls per controller (switches + APs) per interface interval,
 * whether it manages 3 devices or 300. Devices first swept together stay in
 * phase (one `now` per pass); a device that joins later can put a second phase
 * on its controller, which at worst doubles that controller's rate — still a
 * fifth of the 60 s sweep this replaced (at the default 10-min interval). A controller that cannot be read
 * writes nothing (refusal 1 below), so its devices stay due and it is retried
 * on every 60 s tick until it answers — the same rate the old sweep paid.
 *
 * Writes are diffed in memory and issued as at most three `updateMany`s per
 * pass (one per destination value) plus one timestamp refresh and one clear,
 * so a steady fleet of 2000 devices issues a handful of statements per tick
 * rather than one per asset. Settings resolution is memoized per pass on
 * (integration, assetType, the per-asset overrides that change the answer),
 * and the resolver itself caches its tiers: no per-asset DB await.
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
 *
 * ── A second reading off the same rows ─────────────────────────────────────
 * Each controller row also names the firmware the device runs (`os_version`).
 * The sweep hands those to `fortinetLiveVersionService`, which keeps
 * `Asset.osVersion` current between discoveries — so the Firmware card stops
 * offering an upgrade the device has already taken. No extra controller call;
 * an in-memory compare per device, DB work only where the firmware moved. It
 * rides the due devices only, so it refreshes at the same interface cadence.
 */

import { prisma } from "../db.js";
import { logger } from "../utils/logger.js";
import { isFortinetIntegrationType } from "../utils/pollingCompatibility.js";
import { isFortiapStatusOnline } from "../utils/fortiapMonitorRow.js";
import { fetchFortinetControllerInventory, resolveMonitorSettings } from "./monitoringService.js";
import { buildFortilinkChangedEvent, logEventsBatch } from "./eventLogService.js";
import { recordFortilinkState } from "../metrics.js";
import { reconcileFortinetLiveVersions, type FortinetLiveVersionReading } from "./fortinetLiveVersionService.js";

/** The three values `Asset.fortilinkStatus` can hold. null = never swept. */
type FortilinkStatus = "up" | "down" | "unknown";

/** Upstream timeout for one controller inventory call. Matches the probe. */
const CONTROLLER_TIMEOUT_MS = 20_000;

/**
 * Slack on the due check. The job ticks every 60 s and stamps `checkedAt` with
 * the pass's start time, so a device read at T is next due at T + interval —
 * exactly on a tick. A timer that fires a few ms early would otherwise push the
 * read a whole extra tick late.
 */
const DUE_GRACE_MS = 5_000;

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
  fortilinkCheckedAt: Date | null;
  discoveredByIntegrationId: string | null;
  osVersion: string | null;
  monitored: boolean;
  // Settings-resolver inputs (the system-info cadence and the interfaces
  // polling method are what this sweep reads off the resolved settings).
  monitorIntervalSec: number | null;
  cpuMemoryIntervalSec: number | null;
  temperatureIntervalSec: number | null;
  systemInfoIntervalSec: number | null;
  probeTimeoutMs: number | null;
  interfacesPolling: string | null;
  interfacesCredentialId: string | null;
}

/** What the monitor-settings hierarchy says about one device's interface stream. */
interface InterfaceCadence {
  /** Interface polling is on (resolved method not null / "disabled", interval > 0). */
  enabled: boolean;
  /** The resolved system-info (interface) interval, seconds. */
  intervalSec: number;
}

/**
 * Is a device's controller link due a read? Null `checkedAt` = never read =
 * due at once; otherwise due once one interface interval has passed.
 */
function linkDue(checkedAt: Date | null, intervalSec: number, now: Date): boolean {
  if (!checkedAt) return true;
  return now.getTime() - checkedAt.getTime() >= intervalSec * 1000 - DUE_GRACE_MS;
}

/**
 * Resolve each device's interface cadence through the monitor-settings
 * hierarchy, memoized for the pass on the inputs that can change the answer —
 * (integration, assetType) plus the per-asset interval / method / credential
 * overrides. A fleet with no per-asset overrides resolves once per
 * (integration, assetType); the resolver's own tier cache keeps even those
 * calls off the DB after the first. A device whose settings will not resolve
 * answers null: left untouched this pass — neither swept at a guessed cadence
 * nor cleared on a resolver hiccup.
 */
function makeCadenceResolver(integrationTypeById: Map<string, string>) {
  const memo = new Map<string, Promise<InterfaceCadence | null>>();
  return (a: LinkStateAssetRow): Promise<InterfaceCadence | null> => {
    const key = [
      a.discoveredByIntegrationId, a.assetType, a.systemInfoIntervalSec ?? "",
      a.interfacesPolling ?? "", a.interfacesCredentialId ? "cred" : "",
    ].join("|");
    let hit = memo.get(key);
    if (!hit) {
      hit = (async () => {
        try {
          const eff = await resolveMonitorSettings({
            assetType: a.assetType,
            ipAddress: a.ipAddress,
            discoveredByIntegrationId: a.discoveredByIntegrationId,
            discoveredByIntegrationType: a.discoveredByIntegrationId ? integrationTypeById.get(a.discoveredByIntegrationId) ?? null : null,
            monitorIntervalSec: a.monitorIntervalSec,
            cpuMemoryIntervalSec: a.cpuMemoryIntervalSec,
            temperatureIntervalSec: a.temperatureIntervalSec,
            systemInfoIntervalSec: a.systemInfoIntervalSec,
            probeTimeoutMs: a.probeTimeoutMs,
            interfacesPolling: a.interfacesPolling,
            interfacesCredentialId: a.interfacesCredentialId,
          });
          const intervalSec = Number(eff.systemInfoIntervalSeconds) || 0;
          const method = eff.interfacesPolling;
          return { enabled: method != null && method !== "disabled" && intervalSec > 0, intervalSec };
        } catch (err: any) {
          logger.debug({ err: err?.message, assetType: a.assetType }, "fortilink sweep: settings did not resolve");
          return null;
        }
      })();
      memo.set(key, hit);
    }
    return hit;
  };
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
 * Load every FortiGate-managed switch/AP, decide per device whether it is due,
 * off, or neither, and bucket the DUE ones by (integration, controller, kind).
 * Returns the groups to read and the ids to clear (OFF devices that still hold
 * a value — once cleared they drop out of that list, so the clear is one write,
 * not one per tick).
 *
 * The `select` is tight on purpose: this runs on a 60s tick against a table
 * that can hold 2000+ rows, and `fortinetTopology` is already the one wide
 * column we cannot avoid (the controller name lives in it). Everything else is
 * a scalar the due decision or the settings resolver reads.
 *
 * Decommissioned assets are excluded — they have no live link to report and
 * including them would resurrect a link-down alert on hardware that was
 * deliberately retired. Assets in maintenance are excluded too: the
 * system-info pass pauses for them, and they keep their last value. Unmonitored
 * assets are LOADED but never swept — with monitoring off, interface polling is
 * off, so their value is cleared like any other OFF device (rule 59(a)).
 */
async function loadControllerGroups(now: Date): Promise<{ groups: ControllerGroup[]; clearIds: string[] }> {
  const integrations = await prisma.integration.findMany({
    where: { type: { in: ["fortimanager", "fortigate"] }, enabled: true },
    select: { id: true, type: true, name: true, config: true },
  });
  if (integrations.length === 0) return { groups: [], clearIds: [] };
  const byId = new Map(integrations.map((i) => [i.id, i]));

  const assets: LinkStateAssetRow[] = await prisma.asset.findMany({
    where: {
      assetType: { in: ["switch", "access_point"] },
      status: { notIn: ["decommissioned", "maintenance"] },
      discoveredByIntegrationId: { in: integrations.map((i) => i.id) },
      serialNumber: { not: null },
    },
    select: {
      id: true, hostname: true, ipAddress: true, assetType: true, serialNumber: true,
      fortinetTopology: true, fortilinkStatus: true, fortilinkStatusRaw: true, fortilinkCheckedAt: true,
      discoveredByIntegrationId: true, osVersion: true, monitored: true,
      monitorIntervalSec: true, cpuMemoryIntervalSec: true, temperatureIntervalSec: true,
      systemInfoIntervalSec: true, probeTimeoutMs: true, interfacesPolling: true, interfacesCredentialId: true,
    },
  });

  const cadenceFor = makeCadenceResolver(new Map(integrations.map((i) => [i.id, i.type])));
  const cadences = await Promise.all(assets.map((a) => (a.monitored ? cadenceFor(a) : Promise.resolve<InterfaceCadence>({ enabled: false, intervalSec: 0 }))));

  const groups = new Map<string, ControllerGroup>();
  const clearIds: string[] = [];
  assets.forEach((asset, idx) => {
    const integration = asset.discoveredByIntegrationId ? byId.get(asset.discoveredByIntegrationId) : undefined;
    if (!integration || !isFortinetIntegrationType(integration.type)) return;
    const cadence = cadences[idx];
    // Settings did not resolve: leave the device exactly as it is this pass.
    if (!cadence) return;
    if (!cadence.enabled) {
      if (asset.fortilinkStatus != null || asset.fortilinkStatusRaw != null) clearIds.push(asset.id);
      return;
    }
    if (!linkDue(asset.fortilinkCheckedAt, cadence.intervalSec, now)) return;
    const config = (integration.config ?? {}) as Record<string, unknown>;
    const deviceName = controllerNameFor(asset, integration.type, config);
    // No controller recorded = nothing to ask. A switch discovered before the
    // topology stamp existed self-heals on the next discovery cycle.
    if (!deviceName) return;
    const kind: "switches" | "aps" = asset.assetType === "access_point" ? "aps" : "switches";
    const key = `${integration.id}::${deviceName}::${kind}`;
    let group = groups.get(key);
    if (!group) {
      group = { integration: { ...integration, config }, deviceName, kind, assets: [] };
      groups.set(key, group);
    }
    group.assets.push(asset);
  });
  return { groups: Array.from(groups.values()), clearIds };
}

/**
 * One sweep pass: clear the devices whose interface polling is off, read each
 * controller with at least one DUE device once, diff its answer against what
 * those devices currently store, and write only what moved.
 *
 * Controllers are read in PARALLEL across groups but the shared 30s cache and
 * the in-flight coalescing inside `fetchFortinetControllerInventory` mean a
 * burst here collapses to one upstream call per (controller, kind) — the same
 * protection the monitor tick relies on. Per-group failures are isolated:
 * one unreachable FortiGate must not stop the other 49 from being swept.
 */
export async function sweepFortinetLinkState(): Promise<FortilinkSweepResult> {
  const now = new Date();
  const { groups, clearIds } = await loadControllerGroups(now);
  const result: FortilinkSweepResult = { controllersRead: 0, controllersFailed: 0, transitions: 0, unchanged: 0 };
  if (clearIds.length > 0) {
    // Interface polling is off for these (rule 59(a)): no reading at all
    // rather than a stale one. Not an `asset.fortilink.changed` — the link did
    // not change, Polaris stopped asking. `checkedAt` is left as the record of
    // the last read; with status null it is never used as a reading anchor.
    await prisma.asset.updateMany({
      where: { id: { in: clearIds } },
      data: { fortilinkStatus: null, fortilinkStatusRaw: null, fortilinkChangedAt: null },
    });
  }
  if (groups.length === 0) return result;

  // assetId sets keyed by destination value, so the writes below are three
  // updateMany calls for the whole fleet instead of one per asset.
  const moved = new Map<FortilinkStatus, string[]>([["up", []], ["down", []], ["unknown", []]]);
  // Raw status differs per asset, so those can't share an updateMany. Only
  // assets that MOVED get one, which keeps this list to the size of the
  // transition set rather than the fleet.
  const rawWrites: Array<{ id: string; raw: string | null }> = [];
  const confirmed: string[] = [];
  const events: ReturnType<typeof buildFortilinkChangedEvent>[] = [];
  // The controller row also carries the firmware each device runs. Collected
  // here, reconciled after the link writes (fortinetLiveVersionService) — an
  // in-memory compare per device, DB work only for a device whose firmware
  // actually moved.
  const versionReadings: FortinetLiveVersionReading[] = [];

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
      if (entry?.osVersion) {
        versionReadings.push({
          assetId: asset.id,
          hostname: asset.hostname || asset.ipAddress,
          currentOsVersion: asset.osVersion,
          liveVersion: entry.osVersion,
          reader: "fortilink-sweep",
        });
      }
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

  if (versionReadings.length > 0) {
    try {
      await reconcileFortinetLiveVersions(versionReadings);
    } catch (err: any) {
      logger.debug({ err: err?.message }, "fortinet live version reconcile failed");
    }
  }

  recordFortilinkState(result.controllersRead, result.controllersFailed, result.transitions);
  if (result.transitions > 0 || result.controllersFailed > 0) {
    logger.info(result, "fortinet controller link sweep complete");
  }
  return result;
}
