/**
 * src/services/firmwareUpgradeService.ts — one asset, one flash (business
 * rule 87). The orchestration half: what may start, the run row, the
 * maintenance hold, the Events, the result. The protocol half is an ENGINE
 * under ./firmwareEngines/, handed a host, a login and an image on disk.
 *
 * Copies the shape of `agentInstallService.startUpgrade`: every refusal is
 * SYNCHRONOUS and answered to the click; then the run row exists, the kickoff
 * Event is written, the hold is taken, and the runner is scheduled on this
 * web process with `setImmediate`. There is no queue — the image is on this
 * host's disk (uploads land here), and pg-boss is optional anyway.
 *
 * The gates, in order, each an AppError:
 *   404  asset
 *   400  no engine for this manufacturer / type / serial; no address
 *   400  serial names no platform (rule 84 placeholder, too short)
 *   409  nothing to offer (current, no images, platform unmatched)
 *   400  the approved imageId is not the offered primary or its eligible backup
 *   409  health: down / warning / recovering / dependency-suppressed /
 *        unmonitorable status (rule 10). `maintenance` is allowed — a window
 *        is exactly when you flash. Unmonitored is allowed (the hold then
 *        no-ops, as it does for an agent upgrade).
 *   400  no device-admin login bound at any of the three scopes
 *   409  a live run on this asset, on an ancestor or descendant on its
 *        connection path, or on its MCLAG peer (fortiupgrade's ordering rule
 *        reduced to one device); then the partial unique index answers the
 *        race.
 *
 * What it never does: write `Asset.osVersion`. Projection owns that (the
 * Fortinet-infra `os`/`osVersion` rule in asset-source-projection). A
 * successful run records what the device reported on `verifiedVersion` and
 * asks for a scoped rediscover, which is what makes the asset record — and
 * the firmware-changed Event — say the new version.
 */

import { stat } from "node:fs/promises";
import { prisma } from "../db.js";
import { AppError } from "../utils/errors.js";
import { logger } from "../utils/logger.js";
import { UNMONITORABLE_STATUSES } from "../utils/assetInvariants.js";
import { platformFromSerial, formatFirmwareVersion } from "../utils/firmwareVersion.js";
import { logEvent } from "./eventLogService.js";
import { openMaintenanceHold, releaseMaintenanceHold } from "./maintenanceScheduleService.js";
import { resolveConnectionPath } from "./connectionPathService.js";
import { engineFor, engineByKind } from "./firmwareEngines/index.js";
import { DEFAULT_FIRMWARE_TIMEOUTS, type FirmwareEngineContext, type FirmwareEngineTimeouts, type FirmwareProgress, type FirmwareRunStage } from "./firmwareEngines/types.js";
import {
  findUpgradeCandidates,
  resolveFirmwareCredential,
  resolveImagePath,
  getImage,
  type EffectiveBinding,
  type FirmwareImageRow,
  type ResolvedFirmwareCredential,
  type UpgradeCandidates,
} from "./firmwareRepositoryService.js";

const HOLD_KIND = "firmware-upgrade" as const;
const ACTIVE_STATUSES = ["queued", "running"] as const;
const LOG_CAP = 500;
const WRITE_THROTTLE_MS = 5_000;

export type UpgradeAvailabilityState =
  | "unsupported"       // no engine for this manufacturer / type / serial
  | "no-serial"
  | "no-version"
  | "no-image"
  | "no-credential"
  | "up-to-date"
  | "pending-discovery" // last run flashed this version; the asset record has not caught up
  | "blocked"           // an image is offered but a gate refuses right now
  | "running"
  | "available";

export interface RunSummary {
  id: string;
  assetId: string;
  imageId: string | null;
  platform: string;
  fromVersion: string | null;
  toVersion: string;
  engine: string;
  status: string;
  stage: string | null;
  progress: FirmwareProgress | null;
  result: string | null;
  error: string | null;
  verifiedVersion: string | null;
  startedBy: string;
  startedAt: Date;
  finishedAt: Date | null;
  heartbeatAt: Date | null;
}

export interface UpgradeAvailability {
  state: UpgradeAvailabilityState;
  available: boolean;
  /** Operator-facing sentence for every non-available state. */
  reason: string | null;
  engine: string | null;
  platform: string | null;
  current: string | null;
  image: FirmwareImageRow | null;
  backupImage: FirmwareImageRow | null;
  credential: EffectiveBinding | null;
  blockers: string[];
  activeRun: RunSummary | null;
  lastRun: RunSummary | null;
}

const ASSET_SELECT = {
  id: true, hostname: true, ipAddress: true, dnsName: true, serialNumber: true, manufacturer: true, assetType: true,
  model: true, osVersion: true, status: true, monitored: true, monitorStatus: true, dependencySuppressed: true,
} as const;
type AssetRow = {
  id: string; hostname: string | null; ipAddress: string | null; dnsName: string | null; serialNumber: string | null;
  manufacturer: string | null; assetType: string; model: string | null; osVersion: string | null; status: string;
  monitored: boolean; monitorStatus: string | null; dependencySuppressed: boolean;
};

function summarize(r: {
  id: string; assetId: string; imageId: string | null; platform: string; fromVersion: string | null; toVersion: string; engine: string;
  status: string; stage: string | null; progress: unknown; result: string | null; error: string | null; verifiedVersion: string | null;
  startedBy: string; startedAt: Date; finishedAt: Date | null; heartbeatAt: Date | null;
}): RunSummary {
  return {
    id: r.id, assetId: r.assetId, imageId: r.imageId, platform: r.platform, fromVersion: r.fromVersion, toVersion: r.toVersion,
    engine: r.engine, status: r.status, stage: r.stage, progress: (r.progress as FirmwareProgress | null) ?? null, result: r.result,
    error: r.error, verifiedVersion: r.verifiedVersion, startedBy: r.startedBy, startedAt: r.startedAt, finishedAt: r.finishedAt,
    heartbeatAt: r.heartbeatAt,
  };
}

function assetLabel(a: { hostname: string | null; ipAddress: string | null }): string | undefined {
  return a.hostname || a.ipAddress || undefined;
}

/** The gates that read the asset's STATE (not its images). Empty = clear to flash. */
function healthBlockers(a: AssetRow): string[] {
  const out: string[] = [];
  if ((UNMONITORABLE_STATUSES as readonly string[]).includes(a.status)) out.push(`the asset is ${a.status}`);
  if (a.monitored && a.monitorStatus && ["down", "warning", "recovering"].includes(a.monitorStatus)) {
    out.push(`the device is ${a.monitorStatus} — an upgrade needs a device that is answering`);
  }
  if (a.dependencySuppressed) out.push("the device is behind a parent that is down (dependency-suppressed)");
  if (!a.ipAddress && !a.dnsName) out.push("the asset has no IP address to reach the web UI at");
  return out;
}

async function activeRunFor(assetId: string) {
  return prisma.firmwareUpgradeRun.findFirst({ where: { assetId, status: { in: [...ACTIVE_STATUSES] } }, orderBy: { startedAt: "desc" } });
}

async function lastRunFor(assetId: string) {
  return prisma.firmwareUpgradeRun.findFirst({ where: { assetId, status: { notIn: [...ACTIVE_STATUSES] } }, orderBy: { startedAt: "desc" } });
}

function reasonFor(c: UpgradeCandidates, a: AssetRow): { state: UpgradeAvailabilityState; reason: string } {
  switch (c.reason) {
    case "no-engine":
      return { state: "unsupported", reason: `No upgrade engine for ${a.manufacturer ?? "this manufacturer"} ${a.assetType === "access_point" ? "access points" : "switches"} — images can be stored in the Repository but Polaris cannot apply them.` };
    case "no-serial":
      return { state: "no-serial", reason: "The asset has no usable serial number, so no image can be matched to its platform." };
    case "no-version":
      return { state: "no-version", reason: "The asset's firmware version is unknown; an upgrade is offered only forward from a known version." };
    case "no-images":
      return { state: "no-image", reason: `No firmware is in the Repository for ${a.manufacturer} ${a.assetType === "access_point" ? "access points" : "switches"}.` };
    case "platform-unmatched":
      return { state: "no-image", reason: `The Repository holds ${a.manufacturer} images, but none for platform ${c.platform} (the first six characters of this device's serial).` };
    case "current":
      return { state: "up-to-date", reason: `No Repository image is newer than ${c.current ? formatFirmwareVersion(c.current) : a.osVersion}.` };
    default:
      return { state: "available", reason: "" };
  }
}

/**
 * Everything the asset card needs in one read: 3–4 indexed point queries, and
 * ZERO image queries when no engine exists for the device.
 */
export async function getUpgradeAvailability(assetId: string): Promise<UpgradeAvailability> {
  const a = await prisma.asset.findUnique({ where: { id: assetId }, select: ASSET_SELECT }) as AssetRow | null;
  if (!a) throw new AppError(404, "Asset not found");
  const candidates = await findUpgradeCandidates(a);
  const [active, last] = await Promise.all([activeRunFor(a.id), lastRunFor(a.id)]);
  const base: UpgradeAvailability = {
    state: "available",
    available: false,
    reason: null,
    engine: candidates.engine,
    platform: candidates.platform,
    current: a.osVersion,
    image: null,
    backupImage: null,
    credential: null,
    blockers: [],
    activeRun: active ? summarize(active) : null,
    lastRun: last ? summarize(last) : null,
  };
  if (active) return { ...base, state: "running", reason: "A firmware upgrade is running on this device." };
  if (candidates.reason !== "ok") {
    const r = reasonFor(candidates, a);
    return { ...base, state: r.state, reason: r.reason };
  }
  const primary = candidates.primary!;
  // The last run flashed exactly this version and succeeded, but discovery
  // has not rewritten osVersion yet — do not re-offer a flash that already
  // happened.
  if (last && last.status === "succeeded" && last.verifiedVersion && last.imageId === primary.id) {
    return { ...base, state: "pending-discovery", image: primary, reason: `The last run flashed ${primary.versionLabel} and the device confirmed it; the asset record updates on the next discovery.` };
  }
  const credential = (await resolveFirmwareCredential(a, { revealSecrets: false })) as EffectiveBinding | null;
  const blockers = healthBlockers(a);
  if (!credential) {
    return { ...base, state: "no-credential", image: primary, backupImage: candidates.backup, blockers, reason: `${primary.versionLabel} is available, but no device admin login is bound for ${a.manufacturer} at the model, device-type or manufacturer level (Server Settings → Repository).` };
  }
  if (blockers.length > 0) {
    return { ...base, state: "blocked", image: primary, backupImage: candidates.backup, credential, blockers, reason: `${primary.versionLabel} is available, but ${blockers[0]}.` };
  }
  return { ...base, state: "available", available: true, image: primary, backupImage: candidates.backup, credential, blockers };
}

/**
 * Live runs that must hold this device back: its own, any on a device above or
 * below it on the connection path, and any on its MCLAG peer. Active runs are
 * a tiny set (partial index), so this is one small read plus one path walk per
 * active run.
 */
async function topologyConflicts(a: AssetRow): Promise<string[]> {
  const others = await prisma.firmwareUpgradeRun.findMany({
    where: { status: { in: [...ACTIVE_STATUSES] }, assetId: { not: a.id } },
    select: { assetId: true, asset: { select: { hostname: true, ipAddress: true } } },
  });
  if (others.length === 0) return [];
  const otherIds = new Set(others.map((o) => o.assetId));
  const related = new Set<string>();
  const mine = await resolveConnectionPath(a.id).catch(() => null);
  for (const hop of mine?.hops ?? []) if (otherIds.has(hop.id)) related.add(hop.id);
  for (const o of others) {
    if (related.has(o.assetId)) continue;
    const theirs = await resolveConnectionPath(o.assetId).catch(() => null);
    if (theirs?.hops.some((h) => h.id === a.id)) related.add(o.assetId);
  }
  const peers = await prisma.assetMclagPeer.findMany({ where: { assetId: a.id, matchedAssetId: { not: null } }, select: { matchedAssetId: true } });
  for (const p of peers) if (p.matchedAssetId && otherIds.has(p.matchedAssetId)) related.add(p.matchedAssetId);
  return others.filter((o) => related.has(o.assetId)).map((o) => o.asset.hostname || o.asset.ipAddress || o.assetId);
}

export interface StartUpgradeInput {
  assetId: string;
  /** The image the operator APPROVED by name — required. */
  imageId: string;
  actor: string;
  /** Tests: a fake device and short clocks. */
  overrides?: { scheme?: "https" | "http"; port?: number; timeouts?: Partial<FirmwareEngineTimeouts> };
}

export async function startFirmwareUpgrade(input: StartUpgradeInput): Promise<RunSummary> {
  const a = await prisma.asset.findUnique({ where: { id: input.assetId }, select: ASSET_SELECT }) as AssetRow | null;
  if (!a) throw new AppError(404, "Asset not found");

  const engine = engineFor(a.manufacturer, a.assetType, a.serialNumber);
  if (!engine) throw new AppError(400, `No upgrade engine for ${a.manufacturer ?? "this manufacturer"} ${a.assetType} devices`);
  if (!a.ipAddress && !a.dnsName) throw new AppError(400, "The asset has no IP address to reach the web UI at");
  const platform = platformFromSerial(a.serialNumber);
  if (!platform) throw new AppError(400, "The asset has no usable serial number, so no image can be matched to its platform");

  const candidates = await findUpgradeCandidates(a);
  if (candidates.reason !== "ok" || !candidates.primary) {
    const r = reasonFor(candidates, a);
    throw new AppError(409, r.reason);
  }
  if (!input.imageId) throw new AppError(400, "imageId is required — approve the image to push");
  const approved = input.imageId === candidates.primary.id ? candidates.primary
    : candidates.backup && input.imageId === candidates.backup.id ? candidates.backup
    : null;
  if (!approved) {
    throw new AppError(400, `Image ${input.imageId} is not offered for this device — only the model's primary image (${candidates.primary.versionLabel})${candidates.backup ? ` or its backup (${candidates.backup.versionLabel})` : ""} can be pushed, and never a downgrade`);
  }

  const blockers = healthBlockers(a);
  if (blockers.length > 0) throw new AppError(409, `Cannot start: ${blockers.join("; ")}`);

  const cred = (await resolveFirmwareCredential(a, { revealSecrets: true })) as ResolvedFirmwareCredential | null;
  if (!cred) throw new AppError(400, `No device admin login is bound for ${a.manufacturer} at the model, device-type or manufacturer level — bind one under Server Settings → Repository`);

  if (await activeRunFor(a.id)) throw new AppError(409, "A firmware upgrade is already running on this device");
  const conflicts = await topologyConflicts(a);
  if (conflicts.length > 0) {
    throw new AppError(409, `A firmware upgrade is running on ${conflicts.join(", ")}, which is above, below or paired with this device — wait for it to finish`);
  }

  const imagePath = resolveImagePath(`${approved.id}.out`);
  let size: number;
  try {
    size = (await stat(imagePath)).size;
  } catch {
    throw new AppError(409, `The image file for ${approved.versionLabel} is missing from disk — upload it again`);
  }

  let run;
  try {
    run = await prisma.firmwareUpgradeRun.create({
      data: {
        assetId: a.id,
        imageId: approved.id,
        platform,
        fromVersion: a.osVersion,
        toVersion: approved.versionLabel,
        engine: engine.kind,
        status: "queued",
        startedBy: input.actor,
        heartbeatAt: new Date(),
      },
    });
  } catch (err: any) {
    if (err?.code === "P2002") throw new AppError(409, "A firmware upgrade is already running on this device");
    throw err;
  }

  await logEvent({
    action: "firmware.upgrade_started",
    resourceType: "asset",
    resourceId: a.id,
    resourceName: assetLabel(a),
    actor: input.actor,
    level: "info",
    message: `Firmware upgrade started: ${a.osVersion ?? "unknown"} → ${approved.versionLabel} (${approved.role} image for ${approved.model}) via ${engine.label}, signing in with "${cred.credentialName}" (${cred.scope} binding)`,
    details: { runId: run.id, imageId: approved.id, platform, fromVersion: a.osVersion, toVersion: approved.versionLabel, engine: engine.kind, credentialId: cred.credentialId, credentialScope: cred.scope, imageRole: approved.role },
  });

  // Best-effort, like takeAgentHold: a hold failure must never be the reason a
  // flash does not run. The window it opens suppresses everything behind a
  // switch (rule 38), which is exactly what a reboot is about to do to them.
  try {
    await openMaintenanceHold({ assetId: a.id, kind: HOLD_KIND, actor: input.actor });
  } catch (err) {
    logger.warn({ err, assetId: a.id }, "Could not hold the asset in maintenance for the firmware upgrade");
  }

  setImmediate(() => {
    runUpgrade(run.id, a, approved, cred, imagePath, size, input.overrides).catch((err) => {
      logger.error({ err, runId: run.id }, "Firmware upgrade runner crashed unexpectedly");
    });
  });
  return summarize(run);
}

async function runUpgrade(
  runId: string,
  a: AssetRow,
  image: FirmwareImageRow,
  cred: ResolvedFirmwareCredential,
  imagePath: string,
  imageSize: number,
  overrides?: StartUpgradeInput["overrides"],
): Promise<void> {
  const engine = engineByKind((await prisma.firmwareUpgradeRun.findUnique({ where: { id: runId }, select: { engine: true } }))?.engine ?? "");
  const startedAt = Date.now();
  const log: Array<{ t: string; level: string; msg: string }> = [];
  let stage: FirmwareRunStage | null = null;
  let progress: FirmwareProgress | null = null;
  let dirty = false;
  let lastWrite = 0;
  let writing: Promise<void> | null = null;

  const push = (level: "info" | "warn" | "error", msg: string) => {
    log.push({ t: new Date().toISOString(), level, msg });
    if (log.length > LOG_CAP) log.splice(0, log.length - LOG_CAP);
    dirty = true;
  };
  const flush = async (force = false) => {
    if (!dirty && !force) return;
    if (!force && Date.now() - lastWrite < WRITE_THROTTLE_MS) return;
    if (writing) return;
    dirty = false;
    lastWrite = Date.now();
    writing = prisma.firmwareUpgradeRun.update({
      where: { id: runId },
      data: { status: "running", stage, progress: progress as object | undefined, log: log as object[], heartbeatAt: new Date() },
    }).then(() => undefined).catch((err) => logger.warn({ err, runId }, "firmware run progress write failed")).finally(() => { writing = null; });
    await writing;
  };
  const ticker = setInterval(() => { void flush(); }, WRITE_THROTTLE_MS);

  const finish = async (status: "succeeded" | "failed" | "unverified", result: string, extra: { error?: string; verifiedVersion?: string }) => {
    clearInterval(ticker);
    if (writing) await writing;
    await prisma.firmwareUpgradeRun.update({
      where: { id: runId },
      data: { status, result, stage, progress: progress as object | undefined, log: log as object[], error: extra.error ?? null, verifiedVersion: extra.verifiedVersion ?? null, finishedAt: new Date(), heartbeatAt: new Date() },
    }).catch((err) => logger.error({ err, runId }, "firmware run terminal write failed"));
  };

  try {
    push("info", `run started on ${a.hostname ?? a.ipAddress ?? a.id}: ${a.osVersion ?? "unknown"} → ${image.versionLabel} (${image.filename}, ${imageSize} bytes)`);
    await flush(true);
    if (!engine) throw new Error("engine vanished");
    const ctx: FirmwareEngineContext = {
      host: a.ipAddress || a.dnsName!,
      port: overrides?.port,
      scheme: overrides?.scheme ?? "https",
      credential: { username: cred.username, password: cred.password },
      imagePath,
      imageSize,
      image: { platform: image.platform ?? "", versionLabel: image.versionLabel, version: image.version ?? { major: 0 } },
      expectedSerial: a.serialNumber,
      timeouts: { ...DEFAULT_FIRMWARE_TIMEOUTS, ...(overrides?.timeouts ?? {}) },
      onStage: (s) => { stage = s; push("info", `stage: ${s}`); },
      onProgress: (p) => { progress = p; dirty = true; },
      onLog: push,
    };
    const res = await engine.run(ctx);

    // The engine proved the device back over its WEB UI; Polaris monitors it
    // over SNMP / ICMP / its own collectors, which routinely come up minutes
    // later (a FortiAP's HTTPS answered while its SNMP agent was still silent,
    // and the misses landed just outside the window). So a run that reached
    // the reboot keeps the hold open until the device's own monitoring probe
    // answers — bounded, so a device that never does is not silenced forever.
    // A FAILED run releases at once: a flash that went wrong is an incident.
    if (res.outcome === "upgraded" || res.outcome === "unverified") {
      await holdUntilMonitorAnswers(a.id, ctx.timeouts, {
        setStage: (s) => { stage = s; },
        push,
        flush,
      });
    }
    const durationMs = Date.now() - startedAt;

    // Release BEFORE the terminal Event so a covering automation can see the
    // failure (the rule-80a ordering agentInstallService.failUpgrade uses).
    await dropHold(a.id);

    if (res.outcome === "upgraded" || res.outcome === "already-current") {
      push("info", res.outcome === "upgraded" ? `upgraded; device reports ${res.verifiedVersion}` : `already current (${res.verifiedVersion})`);
      await finish("succeeded", res.outcome, { verifiedVersion: res.verifiedVersion });
      await logEvent({
        action: "firmware.upgrade_succeeded",
        resourceType: "asset",
        resourceId: a.id,
        resourceName: assetLabel(a),
        actor: "system:firmware",
        level: "info",
        message: res.outcome === "upgraded"
          ? `Firmware upgrade finished: the device reports ${res.verifiedVersion} (was ${a.osVersion ?? "unknown"}, ${Math.round(durationMs / 1000)} s)`
          : `Firmware upgrade skipped: the device already runs ${res.verifiedVersion}`,
        details: { runId, imageId: image.id, result: res.outcome, verifiedVersion: res.verifiedVersion, durationMs },
      });
      if (res.outcome === "upgraded") void requestRediscover(a.id);
      return;
    }
    if (res.outcome === "unverified") {
      push("warn", res.error ?? "unverified");
      await finish("unverified", "unverified", { error: res.error, verifiedVersion: res.verifiedVersion });
      await logEvent({
        action: "firmware.upgrade_unverified",
        resourceType: "asset",
        resourceId: a.id,
        resourceName: assetLabel(a),
        actor: "system:firmware",
        level: "warning",
        message: `Firmware upgrade unverified: ${res.error ?? "the device came back but its version could not be confirmed"} — check the device`,
        details: { runId, imageId: image.id, lastStage: stage, verifiedVersion: res.verifiedVersion ?? null, durationMs },
      });
      return;
    }
    push("error", res.error ?? "failed");
    await finish("failed", "failed", { error: res.error });
    await logEvent({
      action: "firmware.upgrade_failed",
      resourceType: "asset",
      resourceId: a.id,
      resourceName: assetLabel(a),
      actor: "system:firmware",
      level: "warning",
      message: `Firmware upgrade failed at ${stage ?? "start"}: ${res.error ?? "unknown error"}`,
      details: { runId, imageId: image.id, stage, error: res.error ?? null, durationMs },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    push("error", `runner error: ${msg}`);
    await dropHold(a.id);
    await finish("failed", "failed", { error: msg });
    await logEvent({
      action: "firmware.upgrade_failed",
      resourceType: "asset",
      resourceId: a.id,
      resourceName: assetLabel(a),
      actor: "system:firmware",
      level: "warning",
      message: `Firmware upgrade failed at ${stage ?? "start"}: ${msg}`,
      details: { runId, imageId: image.id, stage, error: msg },
    });
  }
}

/**
 * Keep the firmware maintenance hold open until the device answers Polaris's
 * own monitoring again: the first SUCCESSFUL `AssetMonitorSample` recorded
 * after the engine finished. That is the signal the status machine and every
 * automation read, so it is the one that says the misses are over — and it is
 * written by whichever process polls the device (the monitor role on a
 * split-role host), which is why this reads the table rather than asking.
 *
 * No hold (an unmonitored device — openMaintenanceHold declined) means nothing
 * polls it, so there is nothing to wait for. The hold's own expiry is pushed
 * out to cover the wait, and the wait is capped by `recoveryWaitMs`: a device
 * that never answers ends the window at the cap and is judged normally.
 *
 * Scale: one indexed point query per `recoveryPollMs` (15 s), per live run.
 */
async function holdUntilMonitorAnswers(
  assetId: string,
  timeouts: { recoveryWaitMs: number; recoveryPollMs: number },
  run: { setStage: (s: FirmwareRunStage) => void; push: (level: "info" | "warn" | "error", msg: string) => void; flush: (force?: boolean) => Promise<void> },
): Promise<void> {
  const hold = await prisma.maintenanceHold.findUnique({
    where: { assetId_kind: { assetId, kind: HOLD_KIND } },
    select: { expiresAt: true },
  }).catch(() => null);
  if (!hold) return;

  const since = new Date();
  const deadline = since.getTime() + timeouts.recoveryWaitMs;
  const mustLast = new Date(deadline + 60_000);
  if (hold.expiresAt < mustLast) {
    await prisma.maintenanceHold.update({
      where: { assetId_kind: { assetId, kind: HOLD_KIND } },
      data: { expiresAt: mustLast },
    }).catch((err) => logger.warn({ err, assetId }, "firmware upgrade: could not extend the maintenance hold for the recovery wait"));
  }
  run.setStage("recovering");
  run.push("info", `waiting for Polaris's own monitoring to answer before ending the maintenance window (up to ${Math.round(timeouts.recoveryWaitMs / 60_000)} min)`);
  await run.flush(true);

  while (Date.now() < deadline) {
    const answered = await prisma.assetMonitorSample.findFirst({
      where: { assetId, success: true, timestamp: { gt: since } },
      orderBy: { timestamp: "asc" },
      select: { timestamp: true },
    }).catch(() => null);
    if (answered) {
      run.push("info", `monitoring answered ${Math.max(0, Math.round((answered.timestamp.getTime() - since.getTime()) / 1000))} s after the device came back; ending the maintenance window`);
      return;
    }
    await new Promise((r) => setTimeout(r, Math.max(1, Math.min(timeouts.recoveryPollMs, deadline - Date.now()))));
    await run.flush();
  }
  run.push("warn", `monitoring did not answer within ${Math.round(timeouts.recoveryWaitMs / 60_000)} min of the device coming back; ending the maintenance window anyway — check the device`);
}

async function dropHold(assetId: string): Promise<void> {
  try {
    await releaseMaintenanceHold({ assetId, kind: HOLD_KIND });
  } catch (err) {
    logger.warn({ err, assetId }, "Could not release the firmware maintenance hold (it will expire on its own)");
  }
}

/**
 * Ask discovery to re-read the device so projection records the new version
 * and `logDiscoveryAssetUpdated` emits the firmware-changed Event. Best
 * effort: a device that no discovery owns simply keeps its old osVersion
 * until something else reads it, and the run row says what the device said.
 */
async function requestRediscover(assetId: string): Promise<void> {
  try {
    const { resolveDiscoveryScopeForAsset } = await import("./discovery/assetDiscoveryScope.js");
    const { triggerDiscovery } = await import("./discovery/discoveryEngine.js");
    const resolution = await resolveDiscoveryScopeForAsset(assetId);
    if (!resolution.ok) {
      logger.info({ assetId, reason: resolution.reason }, "firmware upgrade: no discovery to refresh the asset's version with");
      return;
    }
    const { integration, scope, deviceName } = resolution.resolved;
    const started = scope
      ? await triggerDiscovery(integration.id, "system:firmware", { scope, scopeLabel: deviceName })
      : await triggerDiscovery(integration.id, "system:firmware");
    if (!started) logger.info({ assetId }, "firmware upgrade: a discovery is already running; the version will land when it does");
  } catch (err) {
    logger.warn({ err, assetId }, "firmware upgrade: scoped rediscover could not be started");
  }
}

// ─── Reads ────────────────────────────────────────────────────────────────────

export async function getRun(id: string): Promise<RunSummary & { log: Array<{ t: string; level: string; msg: string }>; asset: { hostname: string | null; ipAddress: string | null; model: string | null } }> {
  const r = await prisma.firmwareUpgradeRun.findUnique({ where: { id }, include: { asset: { select: { hostname: true, ipAddress: true, model: true } } } });
  if (!r) throw new AppError(404, "Firmware upgrade run not found");
  return { ...summarize(r), log: (r.log as Array<{ t: string; level: string; msg: string }>) ?? [], asset: r.asset };
}

export async function listRunsForAsset(assetId: string, limit = 20): Promise<RunSummary[]> {
  const rows = await prisma.firmwareUpgradeRun.findMany({ where: { assetId }, orderBy: { startedAt: "desc" }, take: Math.min(Math.max(limit, 1), 100) });
  return rows.map(summarize);
}

/**
 * At web-process boot: a run this process was driving when it died can never
 * finish. Mark it failed and release its hold; the device may still be
 * flashing, and the message says to verify by hand.
 */
export async function failOrphanedFirmwareRuns(): Promise<number> {
  const orphans = await prisma.firmwareUpgradeRun.findMany({ where: { status: { in: [...ACTIVE_STATUSES] } }, select: { id: true, assetId: true, toVersion: true, asset: { select: { hostname: true, ipAddress: true } } } });
  for (const o of orphans) {
    const msg = "Polaris restarted during the upgrade; the device may still be flashing — verify its version by hand";
    await prisma.firmwareUpgradeRun.update({ where: { id: o.id }, data: { status: "failed", result: "failed", error: msg, finishedAt: new Date() } }).catch(() => undefined);
    await dropHold(o.assetId);
    await logEvent({
      action: "firmware.upgrade_failed",
      resourceType: "asset",
      resourceId: o.assetId,
      resourceName: assetLabel(o.asset),
      actor: "system:firmware",
      level: "warning",
      message: `Firmware upgrade to ${o.toVersion} orphaned: ${msg}`,
      details: { runId: o.id, orphaned: true },
    });
  }
  return orphans.length;
}

export { getImage as getFirmwareImage };
