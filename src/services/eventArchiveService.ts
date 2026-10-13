/**
 * src/services/eventArchiveService.ts — Event export settings & archive transfer
 *
 * Manages two export mechanisms:
 *   1. Archive Export (SFTP/SCP) — batched archive files sent before pruning
 *   2. Syslog Forwarding (UDP/TCP/TLS) — real-time event forwarding
 *
 * Archives are only generated when export settings are configured and enabled.
 */

import { spawn } from "node:child_process";
import { createSocket } from "node:dgram";
import { createConnection, type Socket } from "node:net";
import { connect as tlsConnect } from "node:tls";
import { readFileSync, writeFileSync, unlinkSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { STATE_DIR } from "../utils/paths.js";
import { tmpdir } from "node:os";
import { prisma } from "../db.js";
import { logger } from "../utils/logger.js";
import { AppError } from "../utils/errors.js";
import { isIP } from "node:net";

// Spawn a child process with an explicit argv — no shell — and resolve with
// its stdout/stderr. Rejects on non-zero exit or timeout.
function runCommand(
  cmd: string,
  args: string[],
  opts: { timeoutMs: number; stdin?: string },
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(Object.assign(new Error(`${cmd} timed out after ${opts.timeoutMs}ms`), { killed: true }));
    }, opts.timeoutMs);
    child.stdout.on("data", (d) => { stdout += d.toString(); });
    child.stderr.on("data", (d) => { stderr += d.toString(); });
    child.on("error", (err) => { clearTimeout(timer); reject(err); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr });
      else reject(Object.assign(new Error(stderr.trim() || `${cmd} exited with code ${code}`), { stderr, stdout, code }));
    });
    if (opts.stdin !== undefined) child.stdin.write(opts.stdin);
    child.stdin.end();
  });
}

/**
 * Business rule 113(d): the archive server is authenticated by trust on
 * first use. OpenSSH's own `accept-new` pins the key it sees on the first
 * connection into a known_hosts file Polaris owns, and refuses a changed key
 * from then on ("Host key verification failed") — so the event log is never
 * handed to an impostor. It is a FILE under the state dir rather than a row in
 * ssh_host_keys because the ssh / scp / sftp binaries read keys, not the
 * fingerprints the table holds. On an HA install the file rides the periodic
 * file sync to the standby (data/ is synced; see deploy/ha/ha-rsync-exclude).
 * `forgetArchiveHostKey` is the recovery for a re-keyed archive server.
 */
export const ARCHIVE_KNOWN_HOSTS = resolve(STATE_DIR, "data", "archive_known_hosts");

export function sshCommonOptions(keyPath?: string): string[] {
  mkdirSync(dirname(ARCHIVE_KNOWN_HOSTS), { recursive: true });
  const opts = [
    "-o", "StrictHostKeyChecking=accept-new",
    "-o", `UserKnownHostsFile=${ARCHIVE_KNOWN_HOSTS}`,
    "-o", "ConnectTimeout=10",
    "-o", "BatchMode=yes",
  ];
  if (keyPath) opts.push("-i", keyPath);
  return opts;
}

/** True when ssh refused because the archive server's key no longer matches its pin. */
export function isHostKeyRefusal(text: string): boolean {
  return /Host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED/i.test(text);
}

export const ARCHIVE_HOST_KEY_CHANGED_MESSAGE =
  "The archive server's SSH host key has changed since Polaris pinned it, so the connection was refused. " +
  "If the server was legitimately rebuilt or re-keyed, use Forget host key and test again.";

/** Forget the archive server's pinned key; the next connection pins whatever answers. Audited. */
export async function forgetArchiveHostKey(actor: string): Promise<void> {
  try { unlinkSync(ARCHIVE_KNOWN_HOSTS); } catch { /* nothing pinned yet */ }
  // Dynamic: eventLogService imports this module (the retention cache), so a
  // static import back would be a cycle.
  const { logEvent } = await import("./eventLogService.js");
  await logEvent({
    action: "event_archive.host_key_forgotten",
    resourceType: "setting",
    resourceName: "eventArchive",
    actor,
    level: "warning",
    message: "Forgot the event archive server's pinned SSH host key — the next export will trust and pin whatever answers",
  });
}

// Guard sftp batch-file injection: sftp parses "put" args on whitespace and
// quotes, so an embedded quote or newline in the remote path would let an
// admin smuggle extra sftp commands into the batch.
function assertSafeSftpPath(p: string, label: string): void {
  if (/["\n\r]/.test(p)) {
    throw new AppError(400, `${label} may not contain quotes or newlines`);
  }
}

// ─── Validation ─────────────────────────────────────────────────────────
//
// host, username, port and keyPath are handed to ssh / sftp / scp as arguments,
// and ssh reads a leading `-` as an OPTION: a username of
// `-oProxyCommand=<command>` runs that command through a shell as the Polaris
// service account (scan finding F162). They are validated when saved and again
// before every use — a value stored before this check existed must not reach a
// command line either — and every destination is also preceded by `--`.

const ARCHIVE_HOST_RE = /^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/;
const ARCHIVE_USER_RE = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,63}$/;
// C0 controls and DEL: nothing in a path, host or user may carry them.
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

/**
 * Refuse any archive setting that could change what ssh / sftp / scp does.
 * Empty host / username are allowed (unconfigured); callers that need a target
 * check for them separately.
 */
export function assertSafeArchiveSettings(s: Partial<ArchiveSettings>): void {
  if (s.protocol !== undefined && s.protocol !== "sftp" && s.protocol !== "scp") {
    throw new AppError(400, 'protocol must be "sftp" or "scp"');
  }
  if (s.host) {
    if (!(ARCHIVE_HOST_RE.test(s.host) || isIP(s.host) === 6)) {
      throw new AppError(400, "host must be a hostname or an IP address");
    }
  }
  if (s.username) {
    if (!ARCHIVE_USER_RE.test(s.username)) {
      throw new AppError(
        400,
        "username may contain only letters, digits, dot, underscore and hyphen, and may not start with a hyphen",
      );
    }
  }
  if (s.port !== undefined && (!Number.isInteger(s.port) || s.port < 1 || s.port > 65535)) {
    throw new AppError(400, "port must be a whole number from 1 to 65535");
  }
  if (s.remotePath !== undefined && (typeof s.remotePath !== "string" || CONTROL_CHARS.test(s.remotePath))) {
    throw new AppError(400, "remotePath may not contain control characters");
  }
  if (s.keyPath) {
    if (typeof s.keyPath !== "string" || CONTROL_CHARS.test(s.keyPath) || s.keyPath.startsWith("-")) {
      throw new AppError(400, "keyPath must be a file path");
    }
  }
}

export interface ArchiveSettings {
  enabled: boolean;
  protocol: "sftp" | "scp";
  host: string;
  port: number;
  username: string;
  password?: string;
  keyPath?: string;
  remotePath: string;
}

const SETTINGS_KEY = "eventArchive";

const DEFAULT_SETTINGS: ArchiveSettings = {
  enabled: false,
  protocol: "scp",
  host: "",
  port: 22,
  username: "",
  password: "",
  keyPath: "",
  remotePath: "/var/archive/polaris",
};

export async function getArchiveSettings(): Promise<ArchiveSettings> {
  const row = await prisma.setting.findUnique({ where: { key: SETTINGS_KEY } });
  if (!row) return { ...DEFAULT_SETTINGS };
  return { ...DEFAULT_SETTINGS, ...(row.value as Record<string, unknown>) } as ArchiveSettings;
}

export async function updateArchiveSettings(
  settings: Partial<ArchiveSettings>,
): Promise<ArchiveSettings> {
  const current = await getArchiveSettings();
  const merged: ArchiveSettings = { ...current, ...settings };
  assertSafeArchiveSettings(merged);

  await prisma.setting.upsert({
    where: { key: SETTINGS_KEY },
    create: { key: SETTINGS_KEY, value: merged as any },
    update: { value: merged as any },
  });

  return merged;
}

/**
 * Test the SFTP/SCP connection by logging in and immediately disconnecting.
 */
export async function testConnection(
  settings: ArchiveSettings,
): Promise<{ ok: boolean; message: string }> {
  if (!settings.host || !settings.username) {
    return { ok: false, message: "Host and username are required" };
  }
  try {
    assertSafeArchiveSettings(settings);
  } catch (err) {
    return { ok: false, message: (err as Error).message };
  }

  const target = `${settings.username}@${settings.host}`;
  const keyOpts = sshCommonOptions(settings.keyPath);

  try {
    if (settings.protocol === "sftp") {
      await runCommand(
        "sftp",
        [...keyOpts, `-oPort=${settings.port}`, "-b", "-", "--", target],
        { timeoutMs: 15_000, stdin: "bye\n" },
      );
    } else {
      await runCommand(
        "ssh",
        [...keyOpts, "-p", String(settings.port), "--", target, "exit 0"],
        { timeoutMs: 15_000 },
      );
    }
    return { ok: true, message: `Connected to ${settings.host} via ${settings.protocol.toUpperCase()}` };
  } catch (err: any) {
    const msg = String(err.stderr || err.message || "Connection failed");
    if (isHostKeyRefusal(msg)) return { ok: false, message: ARCHIVE_HOST_KEY_CHANGED_MESSAGE };
    return { ok: false, message: msg.trim().split("\n")[0] };
  }
}

/**
 * Archive events older than the given cutoff and export via SFTP/SCP.
 * Returns the count of archived events, or 0 if archiving is not configured.
 */
export async function archiveAndExport(cutoff: Date): Promise<number> {
  const settings = await getArchiveSettings();
  if (!settings.enabled || !settings.host || !settings.username) {
    return 0;
  }
  // Stored settings are checked again here: a value saved before validation
  // existed must not reach a command line.
  assertSafeArchiveSettings(settings);

  const events = await prisma.event.findMany({
    where: { timestamp: { lt: cutoff } },
    orderBy: { timestamp: "asc" },
  });

  if (events.length === 0) return 0;

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const filename = `polaris-events-${timestamp}.json`;
  const tempDir = join(tmpdir(), "polaris-archives");
  if (!existsSync(tempDir)) mkdirSync(tempDir, { recursive: true });
  const localPath = join(tempDir, filename);

  try {
    writeFileSync(localPath, JSON.stringify(events, null, 2), "utf-8");

    const target = `${settings.username}@${settings.host}`;
    const remoteDest = `${settings.remotePath}/${filename}`;
    const keyOpts = sshCommonOptions(settings.keyPath);

    if (settings.protocol === "sftp") {
      assertSafeSftpPath(localPath, "local archive path");
      assertSafeSftpPath(remoteDest, "remote archive path");
      await runCommand(
        "sftp",
        [...keyOpts, `-oPort=${settings.port}`, "-b", "-", "--", target],
        {
          timeoutMs: 60_000,
          stdin: `put "${localPath}" "${remoteDest}"\nbye\n`,
        },
      );
    } else {
      await runCommand(
        "scp",
        [...keyOpts, "-P", String(settings.port), "--", localPath, `${target}:${remoteDest}`],
        { timeoutMs: 60_000 },
      );
    }

    logger.info({ count: events.length, filename, host: settings.host }, "Event archive exported");
    return events.length;
  } catch (err: any) {
    logger.error(err, "Failed to export event archive");
    if (isHostKeyRefusal(String(err?.stderr ?? err?.message ?? ""))) throw new Error(ARCHIVE_HOST_KEY_CHANGED_MESSAGE, { cause: err });
    throw err;
  } finally {
    try { unlinkSync(localPath); } catch { /* ignore cleanup errors */ }
  }
}

// ─── Retention Settings ──────────────────────────────────────────────────────

export type EventLevel = "info" | "warning" | "error";

export interface RetentionSettings {
  retentionDays: number;
  minLevel: EventLevel;
}

const RETENTION_KEY = "eventRetention";
const DEFAULT_RETENTION: RetentionSettings = { retentionDays: 7, minLevel: "info" };
const VALID_LEVELS: EventLevel[] = ["info", "warning", "error"];

// Cache to avoid a DB read on every logEvent() call
let _retentionCache: RetentionSettings | null = null;
let _retentionCacheAt = 0;
const RETENTION_CACHE_TTL = 60_000; // 1 minute

export async function getRetentionSettings(): Promise<RetentionSettings> {
  const row = await prisma.setting.findUnique({ where: { key: RETENTION_KEY } });
  if (!row) return { ...DEFAULT_RETENTION };
  const val = row.value as Record<string, unknown>;
  const days = Number(val.retentionDays);
  const level = val.minLevel as string;
  return {
    retentionDays: Number.isFinite(days) && days >= 1 ? Math.floor(days) : DEFAULT_RETENTION.retentionDays,
    minLevel: VALID_LEVELS.includes(level as EventLevel) ? (level as EventLevel) : DEFAULT_RETENTION.minLevel,
  };
}

export async function getCachedRetentionSettings(): Promise<RetentionSettings> {
  if (_retentionCache && Date.now() - _retentionCacheAt < RETENTION_CACHE_TTL) {
    return _retentionCache;
  }
  _retentionCache = await getRetentionSettings();
  _retentionCacheAt = Date.now();
  return _retentionCache;
}

export async function updateRetentionSettings(
  settings: Partial<RetentionSettings>,
): Promise<RetentionSettings> {
  const current = await getRetentionSettings();
  const days = Number(settings.retentionDays);
  const level = settings.minLevel;
  const merged: RetentionSettings = {
    retentionDays: Number.isFinite(days) && days >= 1 ? Math.floor(days) : current.retentionDays,
    minLevel: VALID_LEVELS.includes(level as EventLevel) ? (level as EventLevel) : current.minLevel,
  };
  await prisma.setting.upsert({
    where: { key: RETENTION_KEY },
    create: { key: RETENTION_KEY, value: merged as any },
    update: { value: merged as any },
  });
  _retentionCache = merged;
  _retentionCacheAt = Date.now();
  return merged;
}

// ─── Asset Auto-Decommission Settings ───────────────────────────────────────

export interface AssetDecommissionSettings {
  inactivityMonths: number; // 0 = disabled
}

const ASSET_DECOMMISSION_KEY = "assetAutoDecommission";
const DEFAULT_ASSET_DECOMMISSION: AssetDecommissionSettings = { inactivityMonths: 0 };

export async function getAssetDecommissionSettings(): Promise<AssetDecommissionSettings> {
  const row = await prisma.setting.findUnique({ where: { key: ASSET_DECOMMISSION_KEY } });
  if (!row) return { ...DEFAULT_ASSET_DECOMMISSION };
  const val = row.value as Record<string, unknown>;
  const months = Number(val.inactivityMonths);
  return {
    inactivityMonths: Number.isFinite(months) && months >= 0 ? Math.floor(months) : 0,
  };
}

export async function updateAssetDecommissionSettings(
  settings: Partial<AssetDecommissionSettings>,
): Promise<AssetDecommissionSettings> {
  const months = Number(settings.inactivityMonths);
  const merged: AssetDecommissionSettings = {
    inactivityMonths: Number.isFinite(months) && months >= 0 ? Math.floor(months) : 0,
  };
  await prisma.setting.upsert({
    where: { key: ASSET_DECOMMISSION_KEY },
    create: { key: ASSET_DECOMMISSION_KEY, value: merged as any },
    update: { value: merged as any },
  });
  return merged;
}

// ─── Syslog Settings ────────────────────────────────────────────────────────

export interface SyslogSettings {
  enabled: boolean;
  protocol: "udp" | "tcp" | "tls";
  host: string;
  port: number;
  facility: string;
  severity: "info" | "warning" | "error";
  format: "rfc5424" | "rfc3164";
  tlsCaPath?: string;
  tlsCertPath?: string;
  tlsKeyPath?: string;
}

const SYSLOG_KEY = "eventSyslog";

const DEFAULT_SYSLOG: SyslogSettings = {
  enabled: false,
  protocol: "udp",
  host: "",
  port: 514,
  facility: "local0",
  severity: "info",
  format: "rfc5424",
  tlsCaPath: "",
  tlsCertPath: "",
  tlsKeyPath: "",
};

export async function getSyslogSettings(): Promise<SyslogSettings> {
  const row = await prisma.setting.findUnique({ where: { key: SYSLOG_KEY } });
  if (!row) return { ...DEFAULT_SYSLOG };
  return { ...DEFAULT_SYSLOG, ...(row.value as Record<string, unknown>) } as SyslogSettings;
}

export async function updateSyslogSettings(
  settings: Partial<SyslogSettings>,
): Promise<SyslogSettings> {
  const current = await getSyslogSettings();
  const merged: SyslogSettings = { ...current, ...settings };

  await prisma.setting.upsert({
    where: { key: SYSLOG_KEY },
    create: { key: SYSLOG_KEY, value: merged as any },
    update: { value: merged as any },
  });

  return merged;
}

/**
 * Test syslog connectivity by sending a test message.
 */
export async function testSyslogConnection(
  settings: SyslogSettings,
): Promise<{ ok: boolean; message: string }> {
  if (!settings.host) {
    return { ok: false, message: "Host is required" };
  }

  const testMsg = "<134>1 " + new Date().toISOString() + " polaris test - - - Polaris syslog connection test";

  try {
    if (settings.protocol === "udp") {
      await sendUdp(settings.host, settings.port, testMsg);
    } else if (settings.protocol === "tcp") {
      await sendTcp(settings.host, settings.port, testMsg);
    } else {
      await sendTls(settings, testMsg);
    }
    return {
      ok: true,
      message: `Test message sent to ${settings.host}:${settings.port} via ${settings.protocol.toUpperCase()}`,
    };
  } catch (err: any) {
    return { ok: false, message: err.message || "Connection failed" };
  }
}

function sendUdp(host: string, port: number, msg: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const client = createSocket("udp4");
    const buf = Buffer.from(msg);
    client.send(buf, 0, buf.length, port, host, (err) => {
      client.close();
      if (err) reject(err);
      else resolve();
    });
  });
}

function sendTcp(host: string, port: number, msg: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.destroy();
      reject(new Error("Connection timeout"));
    }, 10_000);
    const socket: Socket = createConnection({ host, port }, () => {
      socket.write(msg + "\n", () => {
        clearTimeout(timeout);
        socket.end();
        resolve();
      });
    });
    socket.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

function sendTls(settings: SyslogSettings, msg: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const opts: Record<string, unknown> = {
      host: settings.host,
      port: settings.port,
      rejectUnauthorized: !!settings.tlsCaPath,
    };
    if (settings.tlsCaPath) opts.ca = readFileSync(settings.tlsCaPath);
    if (settings.tlsCertPath) opts.cert = readFileSync(settings.tlsCertPath);
    if (settings.tlsKeyPath) opts.key = readFileSync(settings.tlsKeyPath);

    const timeout = setTimeout(() => {
      socket.destroy();
      reject(new Error("TLS connection timeout"));
    }, 10_000);

    const socket = tlsConnect(opts as any, () => {
      socket.write(msg + "\n", () => {
        clearTimeout(timeout);
        socket.end();
        resolve();
      });
    });
    socket.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}
