/**
 * src/services/fmgActivityService.ts — DB-backed heartbeat of FMG worker state.
 *
 * The FmgWorker instances live in the process that makes FMG calls (the
 * discovery role in split-role prod, or the single process in "all" mode).
 * The integrations UI is served by the web role, which doesn't have the
 * worker instances in memory. To bridge that, the process that runs FMG
 * traffic snapshots every worker's lane state into a Setting row every
 * HEARTBEAT_MS, and the web role's API endpoint reads it back.
 *
 * The Setting value carries `updatedAt` so the UI can render the snapshot
 * as stale (and the API can flag it) when the heartbeat process is down.
 */

import { prisma } from "../db.js";
import { getAllFmgWorkers, type FmgLaneState } from "./fmgWorker.js";
import { getRole, type PolarisRole } from "../utils/role.js";
import { logger } from "../utils/logger.js";

const SETTING_KEY = "fmgActivitySnapshot";
const HEARTBEAT_MS = 2_000;
// Snapshots older than this are reported as stale by the read API. Chosen as
// 5× HEARTBEAT_MS so a transient hiccup doesn't flap the UI between
// fresh/stale, but a genuinely-down heartbeat process surfaces inside ~10 s.
const STALENESS_MS = 10_000;

// The worker's own lane-state shape — see fmgWorker.FmgLaneState.
type FmgWorkerActivity = FmgLaneState;

interface FmgActivitySnapshot {
  updatedAt: string;
  role: PolarisRole;
  integrations: Record<string, FmgWorkerActivity>;
}

export interface FmgActivityReadout extends FmgWorkerActivity {
  updatedAt: string | null;
  role: PolarisRole | null;
  ageMs: number | null;
  fresh: boolean;
}

function buildSnapshot(): FmgActivitySnapshot {
  const integrations: Record<string, FmgWorkerActivity> = {};
  for (const w of getAllFmgWorkers()) {
    integrations[w.integrationId] = {
      proxyInFlightLabel: w.proxyInFlightLabel,
      proxyQueueDepth: w.proxyQueueDepth,
      nativeInFlightCount: w.nativeInFlightCount,
    };
  }
  return {
    updatedAt: new Date().toISOString(),
    role: getRole(),
    integrations,
  };
}

async function writeSnapshot(): Promise<void> {
  const snapshot = buildSnapshot();
  await prisma.setting.upsert({
    where: { key: SETTING_KEY },
    create: { key: SETTING_KEY, value: snapshot as unknown as object },
    update: { value: snapshot as unknown as object },
  });
}

let heartbeatTimer: NodeJS.Timeout | null = null;

/**
 * Start the heartbeat tick. Idempotent — repeat calls are no-ops. Called from
 * the boot path on roles that run FMG traffic (discovery or all).
 */
export function startFmgActivityHeartbeat(): void {
  if (heartbeatTimer) return;
  heartbeatTimer = setInterval(() => {
    writeSnapshot().catch((err) => {
      logger.warn({ err: (err as Error)?.message }, "fmg activity heartbeat write failed");
    });
  }, HEARTBEAT_MS);
  // Allow process to exit even if this timer is the only thing pending.
  heartbeatTimer.unref?.();
}

/**
 * Read the per-integration activity slice the web role serves from the
 * integrations API. Empty/missing entry returns a zeroed readout with
 * fresh=false so the UI can render "—".
 */
export async function getFmgActivityForIntegration(
  integrationId: string,
): Promise<FmgActivityReadout> {
  const row = await prisma.setting.findUnique({ where: { key: SETTING_KEY } });
  if (!row) {
    return {
      proxyInFlightLabel: null,
      proxyQueueDepth: 0,
      nativeInFlightCount: 0,
      updatedAt: null,
      role: null,
      ageMs: null,
      fresh: false,
    };
  }
  const snap = row.value as unknown as FmgActivitySnapshot;
  const slice = snap.integrations?.[integrationId];
  const updatedAt = snap.updatedAt ?? null;
  const ageMs = updatedAt ? Date.now() - new Date(updatedAt).getTime() : null;
  const fresh = ageMs !== null && ageMs <= STALENESS_MS;
  return {
    proxyInFlightLabel: slice?.proxyInFlightLabel ?? null,
    proxyQueueDepth: slice?.proxyQueueDepth ?? 0,
    nativeInFlightCount: slice?.nativeInFlightCount ?? 0,
    updatedAt,
    role: snap.role ?? null,
    ageMs,
    fresh,
  };
}
