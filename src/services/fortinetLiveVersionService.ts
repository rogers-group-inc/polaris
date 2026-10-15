/**
 * src/services/fortinetLiveVersionService.ts
 *
 * The firmware a FortiGate, FortiSwitch or FortiAP reports about ITSELF on the
 * monitor path, kept current between discoveries.
 *
 * Without this, `Asset.osVersion` for Fortinet gear moved only when an
 * integration's discovery ran — so a device flashed from the Firmware card (or
 * upgraded on the box) kept reading its old version, and the Firmware card kept
 * offering an upgrade that had already happened, until the next discovery.
 * The monitor path already holds the live answer for free:
 *
 *  - the FortiLink / CAPWAP sweep (`fortinetLinkStateService`) reads every
 *    FortiGate-managed switch's and AP's controller row once a minute, and
 *    that row carries `os_version`;
 *  - the REST response-time probe of a Fortinet-discovered FortiGate reads
 *    `/monitor/system/status`, whose envelope carries `version`.
 *
 * Neither reader issues a call for this; it rides what they already fetched.
 *
 * ── How the reading lands ──────────────────────────────────────────────────
 * Through an ENRICHMENT `AssetSource` row (`fortinet-live`, externalId = the
 * assetId) and the projection — never a direct write of `Asset.osVersion`,
 * the `snmp-sysdescr` precedent. The projection ranks it directly above the
 * discovery kinds (`fortigate-firewall` / `fortiswitch` / `fortiap`) for
 * osVersion only: the device's own current answer beats an inventory copy that
 * is as old as the last discovery (and, for FortiManager's dvmdb, older still).
 *
 * ── Steady state costs nothing ─────────────────────────────────────────────
 * A reading is acted on only when it MATERIALLY differs from the version the
 * asset already shows (`compareFirmwareVersions`, which skips components one
 * side lacks — so FortiManager's "7.4.5" and the box's "v7.4.5" agree, and a
 * format difference never writes, never projects, never audits). A fleet of
 * 2000 unchanged devices costs an in-memory compare per device per pass. The
 * writes happen once per real firmware change.
 *
 * A second in-memory guard covers the one case that would not converge — a
 * higher-priority source owning osVersion, so the projection keeps choosing a
 * value other than ours: once we have recorded a reading we do not re-record
 * the same string until it changes (or the process restarts).
 */

import { prisma } from "../db.js";
import { logger } from "../utils/logger.js";
import { projectAssetFromSources } from "../utils/assetProjection.js";
import { compareFirmwareVersions, parseFirmwareVersion } from "../utils/firmwareVersion.js";
import { buildFirmwareChangedEvent, logEvent } from "./eventLogService.js";

export const FORTINET_LIVE_SOURCE_KIND = "fortinet-live";

/** One device's live answer, plus what the asset row shows right now. */
export interface FortinetLiveVersionReading {
  assetId: string;
  hostname: string | null;
  /** `Asset.osVersion` as the caller loaded it. */
  currentOsVersion: string | null;
  /** The string the device reported, in its integration's discovery format. */
  liveVersion: string | null | undefined;
  /** Who read it — lands in the firmware-changed Event's `source`. */
  reader: "fortilink-sweep" | "fortios-probe";
}

/** assetId → the live string last recorded. Bounds the non-converging case. */
const lastRecorded = new Map<string, string>();

/** Test hook. */
export function resetFortinetLiveVersionCache(): void {
  lastRecorded.clear();
}

/**
 * True when `live` is a readable version that materially differs from
 * `current`. An unreadable live string is never a reading; an unreadable or
 * empty current value is filled by any readable live one.
 */
export function liveVersionDiffers(current: string | null | undefined, live: string | null | undefined): boolean {
  const l = parseFirmwareVersion(live);
  if (!l) return false;
  const c = parseFirmwareVersion(current);
  if (!c) return true;
  return compareFirmwareVersions(l, c) !== 0;
}

/**
 * FortiGate `system/status` answers "v7.4.5". FortiManager discovery stores
 * "7.4.5" (rebuilt from dvmdb's os_ver/mr/patch) and standalone FortiGate
 * discovery stores the envelope value verbatim — match whichever this
 * integration's discovery writes, so the Sources tab reads one format.
 */
export function fortigateLiveVersionFor(integrationType: string, envelopeVersion: string | null | undefined): string | null {
  const v = (envelopeVersion ?? "").trim();
  if (!v) return null;
  return integrationType === "fortimanager" ? v.replace(/^v/i, "") : v;
}

/**
 * Reconcile a batch of live readings. Pure in-memory filtering first; DB work
 * only for the devices whose firmware actually moved. Best-effort per device —
 * one failure is logged and never stops the rest, and never fails the caller.
 */
export async function reconcileFortinetLiveVersions(readings: FortinetLiveVersionReading[]): Promise<number> {
  const due = readings.filter((r) => {
    const live = (r.liveVersion ?? "").trim();
    if (!live) return false;
    if (!liveVersionDiffers(r.currentOsVersion, live)) return false;
    return lastRecorded.get(r.assetId) !== live;
  });
  if (due.length === 0) return 0;
  const outcomes = await Promise.allSettled(due.map((r) => recordOne(r, (r.liveVersion ?? "").trim())));
  let written = 0;
  outcomes.forEach((o, i) => {
    if (o.status === "fulfilled") {
      if (o.value) written++;
    } else {
      logger.debug({ assetId: due[i].assetId, err: (o.reason as Error)?.message }, "fortinet live version reconcile failed");
    }
  });
  return written;
}

async function recordOne(r: FortinetLiveVersionReading, live: string): Promise<boolean> {
  const now = new Date();
  const observed = { osVersion: live, reader: r.reader };
  await prisma.assetSource.upsert({
    where: { sourceKind_externalId: { sourceKind: FORTINET_LIVE_SOURCE_KIND, externalId: r.assetId } },
    create: { assetId: r.assetId, sourceKind: FORTINET_LIVE_SOURCE_KIND, externalId: r.assetId, observed, syncedAt: now, lastSeen: now },
    update: { assetId: r.assetId, observed, syncedAt: now, lastSeen: now },
  });
  lastRecorded.set(r.assetId, live);

  // Whether the device's word WINS is the priority list's call. Only osVersion
  // is applied: this source speaks to nothing else, and applying the whole
  // projection would make the monitor path a general projection writer.
  const sources = await prisma.assetSource.findMany({
    where: { assetId: r.assetId },
    select: { sourceKind: true, inferred: true, observed: true, lastSeen: true },
  });
  const { projected } = projectAssetFromSources(
    sources.map((s) => ({
      sourceKind: s.sourceKind,
      inferred: s.inferred,
      observed: s.observed as Record<string, unknown> | null,
      lastSeen: s.lastSeen,
    })),
  );
  const next = projected.osVersion;
  if (next === null || next === r.currentOsVersion) return false;
  await prisma.asset.update({ where: { id: r.assetId }, data: { osVersion: next } });

  const ev = buildFirmwareChangedEvent(
    { assetId: r.assetId, assetName: r.hostname, actor: "system:monitor", source: FORTINET_LIVE_SOURCE_KIND },
    { osVersion: r.currentOsVersion },
    { osVersion: next },
  );
  if (ev) await logEvent(ev);
  return true;
}
