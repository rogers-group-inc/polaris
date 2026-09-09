/**
 * src/services/haHeartbeatService.ts — "which host is the active instance?"
 *
 * Polaris has no leader election: the schedulers are bare intervals on the web
 * role, `deliverNotifications` has no claim step, and the login lockout /
 * rate-limit / pending-MFA stores are in-process. Two web roles against one
 * database therefore means double polling, duplicate alert emails and two
 * state machines racing `Asset.monitorStatus`. Production has always relied on
 * deployment convention for that ("run exactly one web unit").
 *
 * In the active/standby HA topology (docs/HA.md) the convention gains teeth
 * from three independent layers — the Patroni leader lease, the systemd
 * ExecStartPre role guard, and `DATABASE_URL=localhost` on both nodes so an
 * app can only ever reach its own Postgres. This heartbeat is the fourth and
 * last: a row in the database that names the host currently running the
 * schedulers. It exists to catch the case none of the other three can see —
 * two hosts deliberately pointed at ONE database (a misconfigured standby, a
 * dev instance aimed at prod, a restored .env) — and to give an operator a
 * database-visible answer to "which host is active right now".
 *
 * Deliberately NOT a lock: a stale stamp must never be able to keep a
 * legitimate failover from starting. The window is short (90s against a 30s
 * write), the refusal is a non-zero exit, and systemd retries in 5s — so at
 * worst a promoted node starts one retry later than it otherwise would.
 *
 * The same tick also samples the WAL position, which is what sizes the WAN
 * link and the replication slot cap before HA is ever enabled.
 */

import os from "node:os";
import { prisma } from "../db.js";
import { logger } from "../utils/logger.js";
import { getDirectDatabaseUrl } from "../utils/dbConnections.js";

export const ACTIVE_INSTANCE_KEY = "ha.activeInstance";
export const WAL_SAMPLES_KEY     = "ha.walSamples";

/** How often the job re-stamps the row. */
export const HEARTBEAT_INTERVAL_MS = 30_000;
/**
 * A foreign stamp younger than this blocks the boot. Three missed writes:
 * long enough that a slow tick or a few seconds of clock skew never trips it,
 * short enough that a failover is not meaningfully delayed.
 */
export const CONFLICT_WINDOW_MS = 90_000;

/** One WAL sample every Nth heartbeat tick (10 x 30s = 5 min). */
export const WAL_SAMPLE_EVERY_TICKS = 10;
/** 288 x 5 min = 24h of history. */
export const WAL_SAMPLE_RING_SIZE = 288;

export interface ActiveInstanceStamp {
  hostname: string;
  pid:      number;
  /** ISO-8601. */
  at:       string;
}

export interface WalSample {
  /** ISO-8601. */
  at:  string;
  /** Raw pg_current_wal_lsn() text, e.g. "3/AF0001C8". */
  lsn: string;
}

export interface HeartbeatVerdict {
  conflict: boolean;
  /** The other hostname holding a fresh stamp, when conflict is true. */
  holder?:  string;
  /** Age of the stamp that was examined, in ms. */
  ageMs?:   number;
}

function parseStamp(raw: unknown): ActiveInstanceStamp | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.hostname !== "string" || !o.hostname) return null;
  if (typeof o.at !== "string" || !o.at) return null;
  const pid = typeof o.pid === "number" ? o.pid : 0;
  return { hostname: o.hostname, pid, at: o.at };
}

/**
 * Pure decision: does `stored` block a boot on `selfHostname` at `now`?
 *
 * Own hostname never conflicts (a restart of this host's own web role, or a
 * systemd cycle mid-tick, must always be allowed to proceed). A stamp with an
 * unparseable timestamp is treated as absent rather than as a conflict — a
 * corrupt row must not wedge the app permanently.
 */
export function evaluateHeartbeat(
  stored:       unknown,
  now:          Date,
  selfHostname: string,
): HeartbeatVerdict {
  const stamp = parseStamp(stored);
  if (!stamp) return { conflict: false };
  if (stamp.hostname === selfHostname) return { conflict: false };
  const at = Date.parse(stamp.at);
  if (Number.isNaN(at)) return { conflict: false };
  const ageMs = now.getTime() - at;
  // A stamp from the future (clock skew on the peer) counts as fresh: erring
  // toward "someone else is live" is the safe direction here.
  if (ageMs > CONFLICT_WINDOW_MS) return { conflict: false, ageMs };
  return { conflict: true, holder: stamp.hostname, ageMs };
}

/** Read the current stamp, or null when the row is absent/unparseable. */
export async function readActiveInstance(): Promise<ActiveInstanceStamp | null> {
  const row = await prisma.setting.findUnique({ where: { key: ACTIVE_INSTANCE_KEY } });
  return parseStamp(row?.value ?? undefined);
}

/** Claim (or renew) this process's stamp. */
export async function stampActiveInstance(): Promise<ActiveInstanceStamp> {
  const stamp: ActiveInstanceStamp = {
    hostname: os.hostname(),
    pid:      process.pid,
    at:       new Date().toISOString(),
  };
  await prisma.setting.upsert({
    where:  { key: ACTIVE_INSTANCE_KEY },
    update: { value: stamp as never },
    create: { key: ACTIVE_INSTANCE_KEY, value: stamp as never },
  });
  return stamp;
}

function parseWalSamples(raw: unknown): WalSample[] {
  const blob = raw as { samples?: unknown } | undefined;
  if (!blob || !Array.isArray(blob.samples)) return [];
  return blob.samples.filter(
    (s): s is WalSample =>
      !!s &&
      typeof s === "object" &&
      typeof (s as WalSample).at === "string" &&
      typeof (s as WalSample).lsn === "string",
  );
}

/**
 * Append one WAL position to the 24h ring.
 *
 * Advisory sizing data, not something the app needs to run: a role without WAL
 * introspection rights, or a replica where the answer is uninteresting, logs
 * at debug and moves on.
 */
export async function appendWalSample(): Promise<WalSample | null> {
  if (!getDirectDatabaseUrl()) return null;
  try {
    const rows = await prisma.$queryRaw<{ lsn: string }[]>`SELECT pg_current_wal_lsn()::text AS lsn`;
    const lsn = rows?.[0]?.lsn;
    if (!lsn) return null;
    const sample: WalSample = { at: new Date().toISOString(), lsn };
    const row = await prisma.setting.findUnique({ where: { key: WAL_SAMPLES_KEY } });
    const samples = [...parseWalSamples(row?.value ?? undefined), sample].slice(-WAL_SAMPLE_RING_SIZE);
    await prisma.setting.upsert({
      where:  { key: WAL_SAMPLES_KEY },
      update: { value: { samples } as never },
      create: { key: WAL_SAMPLES_KEY, value: { samples } as never },
    });
    return sample;
  } catch (err: any) {
    logger.debug({ err: err?.message }, "WAL sample skipped");
    return null;
  }
}

/** True unless explicitly disabled. Off outside production so dev/test never trips. */
export function isHeartbeatEnabled(): boolean {
  if ((process.env.POLARIS_HA_HEARTBEAT || "").trim().toLowerCase() === "off") return false;
  return process.env.NODE_ENV === "production";
}

/**
 * Boot guard. Returns the verdict; the caller decides whether to exit.
 *
 * A database error here is NOT a conflict — the schema sanity check and the
 * app's own startup path already fail loudly on an unusable database, and a
 * transient read error must not be the reason a promoted node stays down.
 */
export async function checkActiveInstanceConflict(): Promise<HeartbeatVerdict> {
  if (!isHeartbeatEnabled()) return { conflict: false };
  try {
    const row = await prisma.setting.findUnique({ where: { key: ACTIVE_INSTANCE_KEY } });
    return evaluateHeartbeat(row?.value ?? undefined, new Date(), os.hostname());
  } catch (err: any) {
    logger.warn({ err: err?.message }, "active-instance heartbeat check skipped (read failed)");
    return { conflict: false };
  }
}
