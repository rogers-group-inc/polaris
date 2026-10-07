/**
 * src/services/workloadActionService.ts
 *
 * Start / stop / restart / update a VM or a container (TrueNAS: an App) on an
 * Unraid or TrueNAS SCALE host, through the integration that discovered it.
 * Business rule 94.
 *
 * Polaris is causing the downtime here, so it must not page anyone about it:
 *
 *   restart / update — a rule-80 maintenance HOLD (`workload-restart` /
 *                      `workload-update`) for the length of the call, released
 *                      when the platform reports the action done (success or
 *                      failure). The hold's TTL is the cap for the path where
 *                      nothing releases it.
 *   stop             — an operator stopping a workload means "this is meant to
 *                      be off", for as long as it takes; a TTL'd hold would
 *                      start paging the moment it expired. So a stop instead
 *                      PAUSES monitoring (monitored=false, the override
 *                      recomputed), records that it did, and the matching
 *                      start resumes it. An operator can opt out of the pause.
 *   start            — resumes what a Polaris stop paused, nothing else.
 *
 * Every attempt — refused, failed or done — writes an `asset.workload.<verb>`
 * Event. The platform handle is resolved FRESH from the host (the Unraid
 * container id changes on every recreate, so the one on the source row may
 * already be stale), and the snapshot cache is invalidated afterwards so the
 * next probe sees the new state.
 */

import { prisma } from "../db.js";
import { AppError } from "../utils/errors.js";
import { logEvent } from "./eventLogService.js";
import { openMaintenanceHold, releaseMaintenanceHold } from "./maintenanceScheduleService.js";
import { recomputeMonitorOverrideForAssets } from "./monitorOverrideService.js";
import { fetchWorkloadSnapshotCached, invalidateWorkloadSnapshot } from "./workloadMonitorService.js";
import * as unraid from "./unraidService.js";
import * as truenas from "./truenasService.js";
import {
  ALL_WORKLOAD_SOURCE_KINDS,
  parseWorkloadSourceKind,
  workloadPlatformLabel,
  type WorkloadPlatform,
} from "../utils/workloadSources.js";
import type { WorkloadContainer, WorkloadVm } from "./discovery/workloadSync.js";

export type WorkloadVerb = "start" | "stop" | "restart" | "update";
export const WORKLOAD_VERBS: readonly WorkloadVerb[] = ["start", "stop", "restart", "update"];

/** The flag a Polaris stop leaves on Asset.virtualization, carried across syncs. */
export const PAUSED_BY_STOP_KEY = "monitoringPausedByStop";

interface Target {
  asset: { id: string; hostname: string | null; monitored: boolean; virtualization: Record<string, unknown> | null };
  platform: WorkloadPlatform;
  role: "vm" | "container";
  integration: { id: string; name: string; type: WorkloadPlatform; config: Record<string, unknown> };
  externalId: string;
}

async function loadTarget(assetId: string): Promise<Target> {
  const asset = await prisma.asset.findUnique({
    where: { id: assetId },
    select: { id: true, hostname: true, monitored: true, virtualization: true },
  });
  if (!asset) throw new AppError(404, "Asset not found");
  const source = await prisma.assetSource.findFirst({
    where: { assetId, sourceKind: { in: [...ALL_WORKLOAD_SOURCE_KINDS] } },
    select: { sourceKind: true, externalId: true, integration: { select: { id: true, name: true, type: true, config: true, enabled: true } } },
  });
  const parsed = parseWorkloadSourceKind(source?.sourceKind);
  if (!source || !parsed) throw new AppError(400, "Only a VM or container discovered by an Unraid or TrueNAS SCALE integration can be controlled");
  if (parsed.role === "host") throw new AppError(400, "Start / stop / restart / update apply to VMs and containers, not to the host");
  if (!source.integration || source.integration.type !== parsed.platform) {
    throw new AppError(409, `The asset's ${workloadPlatformLabel(parsed.platform)} source is not linked to an integration`);
  }
  if (source.integration.enabled === false) {
    throw new AppError(409, `The ${workloadPlatformLabel(parsed.platform)} integration "${source.integration.name}" is disabled`);
  }
  return {
    asset: { ...asset, virtualization: (asset.virtualization ?? null) as Record<string, unknown> | null },
    platform: parsed.platform,
    role: parsed.role,
    integration: {
      id: source.integration.id,
      name: source.integration.name,
      type: parsed.platform,
      config: (source.integration.config ?? {}) as Record<string, unknown>,
    },
    externalId: source.externalId,
  };
}

/** The workload as the host reports it NOW (cache dropped first). */
async function liveWorkload(t: Target): Promise<WorkloadVm | WorkloadContainer> {
  invalidateWorkloadSnapshot(t.integration.id);
  let entry;
  try {
    entry = await fetchWorkloadSnapshotCached(t.integration);
  } catch (err: any) {
    throw new AppError(502, `Could not reach ${workloadPlatformLabel(t.platform)}: ${err?.message || "unknown error"}`);
  }
  const hit = t.role === "vm" ? entry.vmsById.get(t.externalId) : entry.containersById.get(t.externalId);
  if (!hit) throw new AppError(404, `The ${t.role === "vm" ? "VM" : "container"} is no longer on the ${workloadPlatformLabel(t.platform)} host`);
  return hit;
}

/** Which verbs make sense for a workload in its current state. */
export function allowedVerbs(role: "vm" | "container", state: string, updateAvailable: boolean | null | undefined): WorkloadVerb[] {
  const out: WorkloadVerb[] = [];
  if (state !== "running") out.push("start");
  if (state === "running" || state === "paused") out.push("stop");
  if (state === "running") out.push("restart");
  if (role === "container" && updateAvailable === true) out.push("update");
  return out;
}

export interface WorkloadStatus {
  platform: WorkloadPlatform;
  role: "vm" | "container";
  integrationName: string;
  state: string;
  rawState: string | null;
  updateAvailable: boolean | null;
  version: string | null;
  latestVersion: string | null;
  monitoringPausedByStop: boolean;
  verbs: WorkloadVerb[];
}

/** The asset page's Workload card: live state + the verbs it offers. */
export async function getWorkloadStatus(assetId: string): Promise<WorkloadStatus> {
  const t = await loadTarget(assetId);
  const w = await liveWorkload(t);
  const c = t.role === "container" ? (w as WorkloadContainer) : null;
  return {
    platform: t.platform,
    role: t.role,
    integrationName: t.integration.name,
    state: w.state,
    rawState: w.rawState,
    updateAvailable: c?.updateAvailable ?? null,
    version: c?.version ?? null,
    latestVersion: c?.latestVersion ?? null,
    monitoringPausedByStop: t.asset.virtualization?.[PAUSED_BY_STOP_KEY] === true,
    verbs: allowedVerbs(t.role, w.state, c?.updateAvailable),
  };
}

const HOLD_KIND: Partial<Record<WorkloadVerb, "workload-restart" | "workload-update">> = {
  restart: "workload-restart",
  update: "workload-update",
};

async function dispatch(t: Target, platformId: string, verb: WorkloadVerb): Promise<void> {
  if (t.platform === "unraid") {
    const cfg = t.integration.config as unknown as unraid.UnraidConfig;
    if (t.role === "vm") {
      if (verb === "update") throw new AppError(400, "VMs have no update action");
      return unraid.vmAction(cfg, platformId, verb);
    }
    return unraid.containerAction(cfg, platformId, verb);
  }
  const cfg = t.integration.config as unknown as truenas.TrueNasConfig;
  if (t.role === "vm") {
    if (verb === "update") throw new AppError(400, "VMs have no update action");
    return truenas.vmAction(cfg, platformId, verb);
  }
  return truenas.appAction(cfg, platformId, verb);
}

export interface RunWorkloadActionInput {
  assetId: string;
  verb: WorkloadVerb;
  actor: string;
  /** Stop only: pause monitoring until a start (default true). */
  pauseMonitoring?: boolean;
}

export async function runWorkloadAction(input: RunWorkloadActionInput): Promise<{ ok: true; message: string }> {
  const t = await loadTarget(input.assetId);
  const label = workloadPlatformLabel(t.platform);
  const what = t.role === "vm" ? "VM" : t.platform === "truenas" ? "App" : "container";
  const name = t.asset.hostname || t.asset.id;
  const audit = (level: "info" | "warning" | "error", message: string, details: Record<string, unknown> = {}) =>
    logEvent({
      action: `asset.workload.${input.verb}`,
      resourceType: "asset",
      resourceId: t.asset.id,
      resourceName: name,
      actor: input.actor,
      level,
      message,
      details: { platform: t.platform, role: t.role, integrationId: t.integration.id, integrationName: t.integration.name, ...details },
    });

  let live: WorkloadVm | WorkloadContainer;
  try {
    live = await liveWorkload(t);
  } catch (err: any) {
    audit("warning", `${what} ${input.verb} on "${name}" refused — ${err.message}`);
    throw err;
  }
  const verbs = allowedVerbs(t.role, live.state, t.role === "container" ? (live as WorkloadContainer).updateAvailable : null);
  if (!verbs.includes(input.verb)) {
    const reason = input.verb === "update"
      ? "no update is available"
      : `it is ${live.rawState ?? live.state}`;
    audit("warning", `${what} ${input.verb} on "${name}" refused — ${reason}`);
    throw new AppError(409, `Cannot ${input.verb} "${name}": ${reason}`);
  }

  const holdKind = HOLD_KIND[input.verb];
  let held = false;
  if (holdKind) {
    held = await openMaintenanceHold({ assetId: t.asset.id, kind: holdKind, actor: input.actor }).catch(() => false);
  }
  const started = Date.now();
  try {
    await dispatch(t, live.platformId, input.verb);
  } catch (err: any) {
    audit("error", `${what} ${input.verb} on "${name}" failed — ${err?.message || "unknown error"}`, { durationMs: Date.now() - started });
    throw err instanceof AppError ? err : new AppError(502, err?.message || `${label} ${input.verb} failed`);
  } finally {
    if (held && holdKind) await releaseMaintenanceHold({ assetId: t.asset.id, kind: holdKind }).catch(() => false);
    invalidateWorkloadSnapshot(t.integration.id);
  }

  // Monitoring pause / resume, and the optimistic state the next sync confirms.
  const virt: Record<string, unknown> = { ...(t.asset.virtualization ?? {}) };
  let monitoredChange: boolean | null = null;
  if (input.verb === "stop" && input.pauseMonitoring !== false && t.asset.monitored) {
    virt[PAUSED_BY_STOP_KEY] = true;
    monitoredChange = false;
  }
  if (input.verb === "start" && virt[PAUSED_BY_STOP_KEY] === true) {
    delete virt[PAUSED_BY_STOP_KEY];
    monitoredChange = true;
  }
  if (input.verb === "update") virt.updateAvailable = false;
  await prisma.asset.update({
    where: { id: t.asset.id },
    data: {
      virtualization: virt as any,
      ...(monitoredChange !== null ? { monitored: monitoredChange } : {}),
    },
  });
  if (monitoredChange !== null) await recomputeMonitorOverrideForAssets(prisma, [t.asset.id]);

  const pausedNote = monitoredChange === false ? " Monitoring paused until it is started from Polaris."
    : monitoredChange === true ? " Monitoring resumed." : "";
  const message = `${what} "${name}" ${input.verb === "update" ? "updated" : input.verb === "stop" ? "stopped" : input.verb === "start" ? "started" : "restarted"} on ${label}.${pausedNote}`;
  audit("info", message, { durationMs: Date.now() - started, monitoringPaused: monitoredChange === false, monitoringResumed: monitoredChange === true });
  return { ok: true, message };
}

/**
 * Ask the host to re-check for updates, then return the refreshed status. The
 * flag the asset list shows is written by the next discovery run; this answers
 * the card immediately from a fresh read.
 */
export async function checkWorkloadUpdates(assetId: string, actor: string): Promise<WorkloadStatus> {
  const t = await loadTarget(assetId);
  if (t.role !== "container") throw new AppError(400, "Update checks apply to containers / Apps");
  try {
    if (t.platform === "unraid") await unraid.refreshUpdateChecks(t.integration.config as unknown as unraid.UnraidConfig);
    else await truenas.refreshUpdateChecks(t.integration.config as unknown as truenas.TrueNasConfig);
  } catch (err: any) {
    // The status below still reports the host's own last check.
    logEvent({
      action: "asset.workload.check_updates", resourceType: "asset", resourceId: t.asset.id, resourceName: t.asset.hostname ?? undefined,
      actor, level: "warning", message: `Update re-check on "${t.asset.hostname || t.asset.id}" failed — ${err?.message || "unknown error"}`,
    });
  }
  const status = await getWorkloadStatus(assetId);
  if (status.updateAvailable !== null) {
    const virt: Record<string, unknown> = { ...(t.asset.virtualization ?? {}), updateAvailable: status.updateAvailable, updateCheckedAt: new Date().toISOString() };
    await prisma.asset.update({ where: { id: t.asset.id }, data: { virtualization: virt as any } });
  }
  return status;
}
