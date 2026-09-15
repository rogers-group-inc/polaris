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
 *
 * ── Why identity is NOT the hostname (business rule 62) ──────────────────────
 * It was, and on Docker that made every image upgrade look like a second host.
 * A container's hostname is its container ID, which the runtime regenerates on
 * every recreate — so the new container read the stamp the old one had written
 * seconds earlier, saw a name that was not its own, and refused to boot until
 * the 90s window expired (forever, on an install whose restart policy doesn't
 * retry). One install, two names, no second instance anywhere.
 *
 * So the identity a stamp asserts is the INSTALL, not the process's view of its
 * own name: a UUID persisted under the state directory, which is the bind mount
 * (Docker/Unraid) or the install root (RHEL/systemd) that outlives the process.
 * Two hosts pointed at one database still have two state directories and so
 * two IDs — the case this guard exists for is unchanged — while a container
 * recreate, a systemd restart and an in-app update all keep theirs.
 *
 * The residual gap: copying a whole state directory to a second host clones its
 * ID, and this layer then sees one instance. That is a narrower hole than the
 * one it replaces (`.env` alone, the case in the header above, carries no ID),
 * and the three layers in front of it are untouched.
 */

import os from "node:os";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { prisma } from "../db.js";
import { logger } from "../utils/logger.js";
import { getDirectDatabaseUrl } from "../utils/dbConnections.js";
import { STATE_DIR } from "../utils/paths.js";

export const ACTIVE_INSTANCE_KEY = "ha.activeInstance";
export const WAL_SAMPLES_KEY     = "ha.walSamples";

/**
 * Where the per-install ID lives. Under `data/` because the in-app updater
 * preserves that directory across a self-update, the Docker image bind-mounts
 * the whole state dir, and nothing serves it over HTTP (unlike
 * STATE_DIR/public/uploads).
 */
export const INSTANCE_ID_FILE = resolve(STATE_DIR, "data", "instance-id");

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
  /**
   * The install's stable ID. Optional because a stamp written before this
   * field existed has none — see `identityMatches` for how those compare.
   */
  instanceId?: string;
  hostname: string;
  pid:      number;
  /** ISO-8601. */
  at:       string;
}

/** Who this process is, for stamping and for comparing against a stored stamp. */
export interface InstanceIdentity {
  instanceId: string;
  hostname:   string;
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
  /**
   * The other install's ID, when conflict is true and the stamp carries one.
   * Logged alongside the hostname because on a container the hostname is a
   * disposable container ID and this is the part an operator can act on.
   */
  holderInstanceId?: string;
  /** Age of the stamp that was examined, in ms. */
  ageMs?:   number;
}

function parseStamp(raw: unknown): ActiveInstanceStamp | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.hostname !== "string" || !o.hostname) return null;
  if (typeof o.at !== "string" || !o.at) return null;
  const pid = typeof o.pid === "number" ? o.pid : 0;
  const instanceId = typeof o.instanceId === "string" && o.instanceId ? o.instanceId : undefined;
  return { instanceId, hostname: o.hostname, pid, at: o.at };
}

let cachedInstanceId: string | null = null;

/**
 * This install's stable ID: the operator's override, else the UUID under the
 * state directory, creating it on first call.
 *
 * Falls back to the hostname when the state directory cannot be written —
 * a read-only mount restores the old per-container behavior rather than
 * failing a boot, so it says so loudly once.
 *
 * `file` is a seam for tests; production always uses INSTANCE_ID_FILE.
 */
export function resolveInstanceId(file: string = INSTANCE_ID_FILE): string {
  if (cachedInstanceId) return cachedInstanceId;

  const override = (process.env.POLARIS_HA_INSTANCE_ID || "").trim();
  if (override) {
    cachedInstanceId = override;
    return cachedInstanceId;
  }

  const readFile = (): string | null => {
    try {
      const existing = readFileSync(file, "utf8").trim();
      return existing || null;
    } catch {
      return null;
    }
  };

  const existing = readFile();
  if (existing) {
    cachedInstanceId = existing;
    return cachedInstanceId;
  }

  const generated = randomUUID();
  try {
    mkdirSync(dirname(file), { recursive: true });
    // `wx` so the loser of a race between two roles starting together does not
    // overwrite the winner's ID — it falls through to the re-read below.
    writeFileSync(file, `${generated}\n`, { encoding: "utf8", flag: "wx" });
    cachedInstanceId = generated;
    logger.info({ file }, "Generated this install's HA instance ID");
  } catch {
    const raced = readFile();
    if (raced) {
      cachedInstanceId = raced;
    } else {
      cachedInstanceId = os.hostname();
      logger.warn(
        { file, hostname: cachedInstanceId },
        "Could not persist an HA instance ID — falling back to the hostname. On a container " +
        "that name changes on every recreate, so an upgrade may refuse to start for up to 90s. " +
        "Make the state directory writable, or set POLARIS_HA_INSTANCE_ID.",
      );
    }
  }
  return cachedInstanceId;
}

/** This process's identity, as stamped and as compared. */
export function getSelfIdentity(): InstanceIdentity {
  return { instanceId: resolveInstanceId(), hostname: os.hostname() };
}

/**
 * Is `stamp` ours?
 *
 * On the ID when the stamp carries one. A stamp from a release that predates
 * the ID falls back to the hostname — the old rule, kept deliberately: a
 * pre-upgrade peer really might be live, and guessing "that's me" there would
 * open the exact hole this guard closes. It costs one 90s wait on the upgrade
 * that lands this code, and nothing after.
 */
function identityMatches(stamp: ActiveInstanceStamp, self: InstanceIdentity): boolean {
  return stamp.instanceId
    ? stamp.instanceId === self.instanceId
    : stamp.hostname === self.hostname;
}

/**
 * Pure decision: does `stored` block a boot on `self` at `now`?
 *
 * Our own stamp never conflicts (a restart of this install's own web role, a
 * systemd cycle mid-tick, or a container recreate must always be allowed to
 * proceed). A stamp with an unparseable timestamp is treated as absent rather
 * than as a conflict — a corrupt row must not wedge the app permanently.
 */
export function evaluateHeartbeat(
  stored: unknown,
  now:    Date,
  self:   InstanceIdentity,
): HeartbeatVerdict {
  const stamp = parseStamp(stored);
  if (!stamp) return { conflict: false };
  if (identityMatches(stamp, self)) return { conflict: false };
  const at = Date.parse(stamp.at);
  if (Number.isNaN(at)) return { conflict: false };
  const ageMs = now.getTime() - at;
  // A stamp from the future (clock skew on the peer) counts as fresh: erring
  // toward "someone else is live" is the safe direction here.
  if (ageMs > CONFLICT_WINDOW_MS) return { conflict: false, ageMs };
  return { conflict: true, holder: stamp.hostname, holderInstanceId: stamp.instanceId, ageMs };
}

/** Read the current stamp, or null when the row is absent/unparseable. */
export async function readActiveInstance(): Promise<ActiveInstanceStamp | null> {
  const row = await prisma.setting.findUnique({ where: { key: ACTIVE_INSTANCE_KEY } });
  return parseStamp(row?.value ?? undefined);
}

/**
 * Set once the stamp has been released on shutdown, so an in-flight tick
 * cannot resurrect the row behind the successor's back.
 */
let released = false;

/** Claim (or renew) this process's stamp. Null once released. */
export async function stampActiveInstance(): Promise<ActiveInstanceStamp | null> {
  if (released) return null;
  const self = getSelfIdentity();
  const stamp: ActiveInstanceStamp = {
    instanceId: self.instanceId,
    hostname:   self.hostname,
    pid:        process.pid,
    at:         new Date().toISOString(),
  };
  await prisma.setting.upsert({
    where:  { key: ACTIVE_INSTANCE_KEY },
    update: { value: stamp as never },
    create: { key: ACTIVE_INSTANCE_KEY, value: stamp as never },
  });
  return stamp;
}

/**
 * Drop our claim on the way down, so the next process to boot — the upgraded
 * container, the restarted unit, the promoted node — does not have to wait out
 * a window for a stamp nobody is behind any more.
 *
 * Only ever deletes OUR row: a peer's live claim is what the guard is for.
 * Best-effort, like every other step in the shutdown path — a failure here
 * costs the successor one 90s wait, never correctness.
 */
export async function releaseActiveInstance(): Promise<boolean> {
  if (!isHeartbeatEnabled()) return false;
  released = true;
  try {
    const row   = await prisma.setting.findUnique({ where: { key: ACTIVE_INSTANCE_KEY } });
    const stamp = parseStamp(row?.value ?? undefined);
    if (!stamp || !identityMatches(stamp, getSelfIdentity())) return false;
    await prisma.setting.delete({ where: { key: ACTIVE_INSTANCE_KEY } });
    return true;
  } catch (err: any) {
    logger.debug({ err: err?.message }, "active-instance stamp release skipped");
    return false;
  }
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

/** Test-only: clear the cached ID (and the released latch) so a test can re-resolve. */
export function __resetInstanceIdentityForTests(): void {
  cachedInstanceId = null;
  released = false;
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
    return evaluateHeartbeat(row?.value ?? undefined, new Date(), getSelfIdentity());
  } catch (err: any) {
    logger.warn({ err: err?.message }, "active-instance heartbeat check skipped (read failed)");
    return { conflict: false };
  }
}
