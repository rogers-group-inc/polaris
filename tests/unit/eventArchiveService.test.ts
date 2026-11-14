/**
 * tests/unit/eventArchiveService.test.ts — CQ-T010: event archive export,
 * retention, auto-decommission and syslog settings.
 *
 * eventArchiveInjection.test.ts pins the F162 argument-injection guards and
 * eventArchiveHostKey.test.ts the rule 113(d) TOFU options. This file pins the
 * rest of the module:
 *
 *   - the settings readers / writers (defaults, merge, validation of the
 *     MERGED value, the clamps), the retention cache;
 *   - testConnection and archiveAndExport end to end against a fake child
 *     process: the argv, the stdin batch, the 15 s / 60 s timeouts, the temp
 *     file always removed, the host-key refusal surfaced as a 502;
 *   - forgetArchiveHostKey's audit Event;
 *   - testSyslogConnection over fake UDP / TCP / TLS sockets.
 *
 * child_process, fs, dgram, net.createConnection and tls.connect are all
 * mocked — nothing is spawned, written or sent.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";

const h = vi.hoisted(() => ({
  spawn: vi.fn(),
  writeFileSync: vi.fn(),
  unlinkSync: vi.fn(),
  mkdirSync: vi.fn(),
  existsSync: vi.fn(() => true),
  readFileSync: vi.fn((p: string) => Buffer.from(`contents of ${p}`)),
  createSocket: vi.fn(),
  createConnection: vi.fn(),
  tlsConnect: vi.fn(),
}));

vi.mock("node:child_process", () => ({ spawn: h.spawn }));
vi.mock("node:fs", async (orig) => {
  const real = await orig<Record<string, unknown>>();
  const over = {
    writeFileSync: h.writeFileSync, unlinkSync: h.unlinkSync, mkdirSync: h.mkdirSync,
    existsSync: h.existsSync, readFileSync: h.readFileSync,
  };
  return { ...real, ...over, default: { ...(real.default as object), ...over } };
});
vi.mock("node:dgram", () => ({ createSocket: h.createSocket }));
vi.mock("node:net", async (orig) => ({ ...(await orig<object>()), createConnection: h.createConnection }));
vi.mock("node:tls", async (orig) => ({ ...(await orig<object>()), connect: h.tlsConnect }));
vi.mock("../../src/db.js", () => import("./_dbStub.js"));
vi.mock("../../src/services/eventLogService.js", (orig) => import("./_eventLogStub.js").then((s) => s.withEventLogStubs(orig)));
vi.mock("../../src/utils/logger.js", () => {
  const logger: any = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn(), fatal: vi.fn() };
  logger.child = () => logger;
  return { logger };
});

import { join, sep } from "node:path";
import { tmpdir } from "node:os";
import { prisma } from "../../src/db.js";
import { resetDbStub, stubbed } from "./_dbStub.js";
import { eventLog, resetEventLogStub } from "./_eventLogStub.js";
import { logger } from "../../src/utils/logger.js";
import { AppError } from "../../src/utils/errors.js";
import {
  ARCHIVE_KNOWN_HOSTS,
  ARCHIVE_HOST_KEY_CHANGED_MESSAGE,
  sshCommonOptions,
  forgetArchiveHostKey,
  assertSafeArchiveSettings,
  getArchiveSettings,
  updateArchiveSettings,
  testConnection,
  archiveAndExport,
  getRetentionSettings,
  getCachedRetentionSettings,
  updateRetentionSettings,
  getAssetDecommissionSettings,
  updateAssetDecommissionSettings,
  getSyslogSettings,
  updateSyslogSettings,
  testSyslogConnection,
  type ArchiveSettings,
  type SyslogSettings,
} from "../../src/services/eventArchiveService.js";

// ─── Fakes ──────────────────────────────────────────────────────────────────

interface FakeChild extends EventEmitter {
  stdout: EventEmitter;
  stderr: EventEmitter;
  stdin: { write: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> };
  kill: ReturnType<typeof vi.fn>;
}

/** A child that exits with `code` (after writing `stderr`) on the next tick; `null` never exits. */
function fakeChild(code: number | null = 0, stderr = "", stdout = ""): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = { write: vi.fn(), end: vi.fn() };
  child.kill = vi.fn();
  if (code !== null) {
    setImmediate(() => {
      if (stdout) child.stdout.emit("data", Buffer.from(stdout));
      if (stderr) child.stderr.emit("data", Buffer.from(stderr));
      child.emit("close", code);
    });
  }
  return child;
}

let lastChild: FakeChild | null = null;
function spawnReturns(make: () => FakeChild): void {
  h.spawn.mockImplementation(() => {
    lastChild = make();
    return lastChild;
  });
}

const GOOD: ArchiveSettings = {
  enabled: true,
  protocol: "scp",
  host: "archive.example.com",
  port: 2222,
  username: "polaris-archive",
  password: "",
  keyPath: "/etc/polaris/archive_key",
  remotePath: "/var/archive/polaris",
};

const findSetting = () => stubbed(prisma.setting.findUnique);
const upsertSetting = () => stubbed(prisma.setting.upsert);
const findEvents = () => stubbed(prisma.event.findMany);

/** Settings rows by key. */
let settingRows: Record<string, unknown> = {};

beforeEach(() => {
  resetDbStub();
  resetEventLogStub();
  settingRows = {};
  findSetting().mockImplementation(async (args: { where: { key: string } }) =>
    args.where.key in settingRows ? { key: args.where.key, value: settingRows[args.where.key] } : null);
  upsertSetting().mockImplementation(async () => ({}));
  findEvents().mockImplementation(async () => []);
  h.spawn.mockReset();
  spawnReturns(() => fakeChild(0));
  for (const f of [h.writeFileSync, h.unlinkSync, h.mkdirSync, h.createSocket, h.createConnection, h.tlsConnect]) f.mockReset();
  h.existsSync.mockReset();
  h.existsSync.mockImplementation(() => true);
  h.readFileSync.mockClear();
  lastChild = null;
  vi.mocked(logger.info).mockClear();
  vi.mocked(logger.error).mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

// ─── sshCommonOptions / forgetArchiveHostKey ────────────────────────────────

describe("sshCommonOptions", () => {
  it("creates the known_hosts directory and pins into Polaris's own file in batch mode", () => {
    const opts = sshCommonOptions();
    expect(h.mkdirSync).toHaveBeenCalledWith(expect.stringContaining("data"), { recursive: true });
    expect(opts).toEqual([
      "-o", "StrictHostKeyChecking=accept-new",
      "-o", `UserKnownHostsFile=${ARCHIVE_KNOWN_HOSTS}`,
      "-o", "ConnectTimeout=10",
      "-o", "BatchMode=yes",
    ]);
    expect(ARCHIVE_KNOWN_HOSTS.endsWith(`data${sep}archive_known_hosts`)).toBe(true);
  });

  it("adds -i only when a key path is given", () => {
    expect(sshCommonOptions("/k").slice(-2)).toEqual(["-i", "/k"]);
    expect(sshCommonOptions("")).not.toContain("-i");
  });
});

describe("forgetArchiveHostKey", () => {
  it("deletes the pinned file and writes a warning-level audit Event naming the actor", async () => {
    await forgetArchiveHostKey("alice");
    expect(h.unlinkSync).toHaveBeenCalledWith(ARCHIVE_KNOWN_HOSTS);
    expect(eventLog.logEvent).toHaveBeenCalledTimes(1);
    expect(eventLog.logEvent.mock.calls[0][0]).toMatchObject({
      action: "event_archive.host_key_forgotten",
      resourceType: "setting",
      resourceName: "eventArchive",
      actor: "alice",
      level: "warning",
    });
  });

  it("still audits when nothing was pinned yet (ENOENT is swallowed)", async () => {
    h.unlinkSync.mockImplementation(() => { throw Object.assign(new Error("no such file"), { code: "ENOENT" }); });
    await expect(forgetArchiveHostKey("bob")).resolves.toBeUndefined();
    expect(eventLog.logEvent).toHaveBeenCalledTimes(1);
  });
});

// ─── assertSafeArchiveSettings (beyond the injection suite) ─────────────────

describe("assertSafeArchiveSettings — edges", () => {
  const refuse = (s: Partial<ArchiveSettings>) => {
    let caught: unknown;
    try { assertSafeArchiveSettings(s); } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(AppError);
    expect((caught as AppError).httpStatus).toBe(400);
    return (caught as AppError).message;
  };

  it("an empty partial is fine — nothing stated, nothing to refuse", () => {
    expect(() => assertSafeArchiveSettings({})).not.toThrow();
  });

  it.each([0, 65536, 22.5, Number.NaN])("refuses port %s", (port) => {
    expect(refuse({ port })).toContain("port must be a whole number from 1 to 65535");
  });

  it("refuses a port stored as a string", () => {
    refuse({ port: "22" as unknown as number });
  });

  it("accepts the port bounds 1 and 65535", () => {
    expect(() => assertSafeArchiveSettings({ port: 1 })).not.toThrow();
    expect(() => assertSafeArchiveSettings({ port: 65535 })).not.toThrow();
  });

  it.each(["-oProxyCommand=id", "host_name", "host.", ".host", "a b", "a".repeat(254)])("refuses host %j", (host) => {
    expect(refuse({ host })).toContain("host must be a hostname or an IP address");
  });

  it.each(["a", "archive-01.corp.example", "10.1.2.3", "::1", "2001:db8::10"])("accepts host %j", (host) => {
    expect(() => assertSafeArchiveSettings({ host })).not.toThrow();
  });

  it("a remotePath must be a string free of control characters; spaces and quotes are left to the transport", () => {
    refuse({ remotePath: "/var/arch\tive" });
    refuse({ remotePath: 7 as unknown as string });
    expect(() => assertSafeArchiveSettings({ remotePath: '/var/my "archive"' })).not.toThrow();
  });

  it("a keyPath with a control character is refused; an empty one means 'no key'", () => {
    refuse({ keyPath: "/etc/key\u0007" });
    expect(() => assertSafeArchiveSettings({ keyPath: "" })).not.toThrow();
  });
});

// ─── Archive settings ───────────────────────────────────────────────────────

describe("getArchiveSettings / updateArchiveSettings", () => {
  it("answers the defaults (scp, port 22, disabled) when nothing is stored, as a fresh copy", async () => {
    const a = await getArchiveSettings();
    expect(a).toEqual({
      enabled: false, protocol: "scp", host: "", port: 22, username: "", password: "", keyPath: "", remotePath: "/var/archive/polaris",
    });
    a.host = "mutated";
    expect((await getArchiveSettings()).host).toBe("");
  });

  it("lays the stored value over the defaults", async () => {
    settingRows.eventArchive = { enabled: true, host: "h1", username: "u" };
    expect(await getArchiveSettings()).toMatchObject({ enabled: true, host: "h1", username: "u", port: 22, protocol: "scp" });
  });

  it("merges a partial update over what is stored and upserts the merged value", async () => {
    settingRows.eventArchive = { ...GOOD };
    const out = await updateArchiveSettings({ port: 2200 });
    expect(out).toEqual({ ...GOOD, port: 2200 });
    expect(upsertSetting()).toHaveBeenCalledWith({
      where: { key: "eventArchive" },
      create: { key: "eventArchive", value: { ...GOOD, port: 2200 } },
      update: { value: { ...GOOD, port: 2200 } },
    });
  });

  it("validates the MERGED value: a hostile stored username blocks an unrelated edit until it is fixed", async () => {
    settingRows.eventArchive = { ...GOOD, username: "-oProxyCommand=id" };
    await expect(updateArchiveSettings({ port: 2200 })).rejects.toMatchObject({ httpStatus: 400 });
    expect(upsertSetting()).not.toHaveBeenCalled();
    await expect(updateArchiveSettings({ username: "fixed" })).resolves.toMatchObject({ username: "fixed" });
  });

  // Was a bug until 2026-11-13: changing where the audit log is SHIPPED (host / user / path / enabled)
  // is an audit-worthy mutation, but neither updateArchiveSettings nor its
  // route (PUT /events/archive-settings) writes an Event — an operator can
  // repoint or disable the archive and the event log records nothing.
  // Fix: logEvent({ action: "event_archive.settings_updated", … }) with the
  // changed keys (password masked), as forgetArchiveHostKey already does.
  it("writes an audit Event when the archive destination changes", async () => {
    settingRows.eventArchive = { ...GOOD };
    await updateArchiveSettings({ host: "elsewhere.example.com" });
    expect(eventLog.logEvent).toHaveBeenCalled();
  });
});

// ─── testConnection ─────────────────────────────────────────────────────────

describe("testConnection", () => {
  it("requires a host and a username before spawning anything", async () => {
    expect(await testConnection({ ...GOOD, host: "" })).toEqual({ ok: false, message: "Host and username are required" });
    expect(await testConnection({ ...GOOD, username: "" })).toEqual({ ok: false, message: "Host and username are required" });
    expect(h.spawn).not.toHaveBeenCalled();
  });

  it("returns the validation message instead of throwing", async () => {
    const r = await testConnection({ ...GOOD, port: 0 });
    expect(r).toEqual({ ok: false, message: "port must be a whole number from 1 to 65535" });
    expect(h.spawn).not.toHaveBeenCalled();
  });

  it("scp: logs in with ssh on the configured port and runs `exit 0`", async () => {
    const r = await testConnection(GOOD);
    expect(r).toEqual({ ok: true, message: "Connected to archive.example.com via SCP" });
    const [cmd, args, opts] = h.spawn.mock.calls[0];
    expect(cmd).toBe("ssh");
    expect(args.slice(-5)).toEqual(["-p", "2222", "--", "polaris-archive@archive.example.com", "exit 0"]);
    expect(args).toEqual(expect.arrayContaining(["-i", "/etc/polaris/archive_key"]));
    expect(opts).toEqual({ stdio: ["pipe", "pipe", "pipe"] });
    expect(lastChild?.stdin.write).not.toHaveBeenCalled();
    expect(lastChild?.stdin.end).toHaveBeenCalled();
  });

  it("sftp: sends a one-line `bye` batch on stdin", async () => {
    const r = await testConnection({ ...GOOD, protocol: "sftp" });
    expect(r.message).toBe("Connected to archive.example.com via SFTP");
    const [cmd, args] = h.spawn.mock.calls[0];
    expect(cmd).toBe("sftp");
    expect(args.slice(-5)).toEqual(["-oPort=2222", "-b", "-", "--", "polaris-archive@archive.example.com"]);
    expect(lastChild?.stdin.write).toHaveBeenCalledWith("bye\n");
  });

  it("reports only the first line of ssh's stderr", async () => {
    spawnReturns(() => fakeChild(255, "Permission denied (publickey).\nConnection closed\n"));
    expect(await testConnection(GOOD)).toEqual({ ok: false, message: "Permission denied (publickey)." });
  });

  it("an exit with no stderr says which command exited with which code", async () => {
    spawnReturns(() => fakeChild(1));
    expect(await testConnection(GOOD)).toEqual({ ok: false, message: "ssh exited with code 1" });
  });

  it("a binary that cannot be spawned reports the spawn error", async () => {
    h.spawn.mockImplementation(() => {
      const c = fakeChild(null);
      setImmediate(() => c.emit("error", new Error("spawn sftp ENOENT")));
      return c;
    });
    expect(await testConnection({ ...GOOD, protocol: "sftp" })).toEqual({ ok: false, message: "spawn sftp ENOENT" });
  });

  it("a changed host key is explained rather than echoed", async () => {
    spawnReturns(() => fakeChild(255, "@@@ WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED! @@@\nHost key verification failed.\n"));
    expect(await testConnection(GOOD)).toEqual({ ok: false, message: ARCHIVE_HOST_KEY_CHANGED_MESSAGE });
  });

  it("kills a hung login after 15 s", async () => {
    vi.useFakeTimers();
    spawnReturns(() => fakeChild(null));
    const p = testConnection(GOOD);
    await vi.advanceTimersByTimeAsync(14_999);
    expect(lastChild?.kill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(await p).toEqual({ ok: false, message: "ssh timed out after 15000ms" });
    expect(lastChild?.kill).toHaveBeenCalledWith("SIGKILL");
  });
});

// ─── archiveAndExport ───────────────────────────────────────────────────────

describe("archiveAndExport", () => {
  const cutoff = new Date("2026-11-06T00:00:00.000Z");
  const events = [
    { id: "e1", timestamp: new Date("2026-11-01T00:00:00Z"), action: "a" },
    { id: "e2", timestamp: new Date("2026-11-02T00:00:00Z"), action: "b" },
  ];

  it("is a no-op returning 0 when the archive is disabled or has no target", async () => {
    expect(await archiveAndExport(cutoff)).toBe(0);
    settingRows.eventArchive = { ...GOOD, enabled: false };
    expect(await archiveAndExport(cutoff)).toBe(0);
    settingRows.eventArchive = { ...GOOD, host: "" };
    expect(await archiveAndExport(cutoff)).toBe(0);
    settingRows.eventArchive = { ...GOOD, username: "" };
    expect(await archiveAndExport(cutoff)).toBe(0);
    expect(findEvents()).not.toHaveBeenCalled();
    expect(h.spawn).not.toHaveBeenCalled();
  });

  it("re-validates STORED settings before any command line: a pre-validation hostile value throws 400", async () => {
    settingRows.eventArchive = { ...GOOD, username: "-oProxyCommand=id" };
    await expect(archiveAndExport(cutoff)).rejects.toMatchObject({ httpStatus: 400 });
    expect(findEvents()).not.toHaveBeenCalled();
    expect(h.spawn).not.toHaveBeenCalled();
  });

  it("returns 0 without writing a file when nothing is older than the cutoff", async () => {
    settingRows.eventArchive = { ...GOOD };
    expect(await archiveAndExport(cutoff)).toBe(0);
    expect(findEvents()).toHaveBeenCalledWith({ where: { timestamp: { lt: cutoff } }, orderBy: { timestamp: "asc" } });
    expect(h.writeFileSync).not.toHaveBeenCalled();
  });

  it("scp: writes the events as JSON to a temp file, copies it, removes it, and returns the count", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-13T04:05:06.789Z"));
    settingRows.eventArchive = { ...GOOD };
    findEvents().mockResolvedValue(events);
    expect(await archiveAndExport(cutoff)).toBe(2);

    const expectedLocal = join(tmpdir(), "polaris-archives", "polaris-events-2026-11-13T04-05-06-789Z.json");
    expect(h.writeFileSync).toHaveBeenCalledWith(expectedLocal, JSON.stringify(events, null, 2), "utf-8");
    const [cmd, args] = h.spawn.mock.calls[0];
    expect(cmd).toBe("scp");
    expect(args.slice(-5)).toEqual([
      "-P", "2222", "--", expectedLocal,
      "polaris-archive@archive.example.com:/var/archive/polaris/polaris-events-2026-11-13T04-05-06-789Z.json",
    ]);
    expect(h.unlinkSync).toHaveBeenCalledWith(expectedLocal);
    expect(logger.info).toHaveBeenCalledWith(expect.objectContaining({ count: 2, host: "archive.example.com" }), "Event archive exported");
  });

  it("creates the temp directory when it does not exist yet", async () => {
    settingRows.eventArchive = { ...GOOD };
    findEvents().mockResolvedValue(events);
    h.existsSync.mockImplementation(() => false);
    await archiveAndExport(cutoff);
    expect(h.mkdirSync).toHaveBeenCalledWith(join(tmpdir(), "polaris-archives"), { recursive: true });
  });

  it("sftp: sends a quoted put + bye batch on stdin", async () => {
    settingRows.eventArchive = { ...GOOD, protocol: "sftp" };
    findEvents().mockResolvedValue(events);
    await archiveAndExport(cutoff);
    const [cmd, args] = h.spawn.mock.calls[0];
    expect(cmd).toBe("sftp");
    expect(args.slice(-5)).toEqual(["-oPort=2222", "-b", "-", "--", "polaris-archive@archive.example.com"]);
    const batch = lastChild?.stdin.write.mock.calls[0][0] as string;
    expect(batch).toMatch(/^put ".+polaris-events-.+\.json" "\/var\/archive\/polaris\/polaris-events-.+\.json"\nbye\n$/);
  });

  it("sftp: refuses a remote path carrying a quote (batch injection) with a 400, and still removes the temp file", async () => {
    settingRows.eventArchive = { ...GOOD, protocol: "sftp", remotePath: '/var/x" "/etc' };
    findEvents().mockResolvedValue(events);
    const err = await archiveAndExport(cutoff).catch((e) => e);
    expect(err).toBeInstanceOf(AppError);
    expect(err.httpStatus).toBe(400);
    expect(err.message).toContain("remote archive path may not contain quotes or newlines");
    expect(h.spawn).not.toHaveBeenCalled();
    expect(h.unlinkSync).toHaveBeenCalledTimes(1);
  });

  it("a changed host key becomes a 502 AppError carrying the explanation, and the file is removed", async () => {
    settingRows.eventArchive = { ...GOOD };
    findEvents().mockResolvedValue(events);
    spawnReturns(() => fakeChild(1, "Host key verification failed.\nlost connection\n"));
    const err = await archiveAndExport(cutoff).catch((e) => e);
    expect(err).toBeInstanceOf(AppError);
    expect(err.httpStatus).toBe(502);
    expect(err.message).toBe(ARCHIVE_HOST_KEY_CHANGED_MESSAGE);
    expect((err as Error & { cause?: unknown }).cause).toBeInstanceOf(Error);
    expect(h.unlinkSync).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalled();
  });

  it("any other transfer failure is rethrown as-is (so the prune job keeps the events)", async () => {
    settingRows.eventArchive = { ...GOOD };
    findEvents().mockResolvedValue(events);
    spawnReturns(() => fakeChild(1, "scp: /var/archive/polaris: No such file or directory\n"));
    const err = await archiveAndExport(cutoff).catch((e) => e);
    expect(err).not.toBeInstanceOf(AppError);
    expect(err.message).toBe("scp: /var/archive/polaris: No such file or directory");
    expect(err.code).toBe(1);
    expect(h.unlinkSync).toHaveBeenCalledTimes(1);
  });

  it("a cleanup failure never masks the result", async () => {
    settingRows.eventArchive = { ...GOOD };
    findEvents().mockResolvedValue(events);
    h.unlinkSync.mockImplementation(() => { throw new Error("EBUSY"); });
    expect(await archiveAndExport(cutoff)).toBe(2);
  });

  it("gives the transfer 60 s before killing it", async () => {
    vi.useFakeTimers();
    settingRows.eventArchive = { ...GOOD };
    findEvents().mockResolvedValue(events);
    spawnReturns(() => fakeChild(null));
    const p = archiveAndExport(cutoff).catch((e) => e);
    await vi.advanceTimersByTimeAsync(59_999);
    expect(lastChild?.kill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    const err = await p;
    expect(err.message).toBe("scp timed out after 60000ms");
    expect(err.killed).toBe(true);
    expect(lastChild?.kill).toHaveBeenCalledWith("SIGKILL");
  });
});

// ─── Retention ──────────────────────────────────────────────────────────────

describe("retention settings", () => {
  it("defaults to 7 days at level info", async () => {
    expect(await getRetentionSettings()).toEqual({ retentionDays: 7, minLevel: "info" });
  });

  it("reads a stored value, flooring the days", async () => {
    settingRows.eventRetention = { retentionDays: 30.9, minLevel: "warning" };
    expect(await getRetentionSettings()).toEqual({ retentionDays: 30, minLevel: "warning" });
  });

  it("accepts a numeric string for days", async () => {
    settingRows.eventRetention = { retentionDays: "14", minLevel: "error" };
    expect(await getRetentionSettings()).toEqual({ retentionDays: 14, minLevel: "error" });
  });

  it.each([0, 0.5, -3, "abc", null])("an unusable stored days value (%j) reads as 7", async (d) => {
    settingRows.eventRetention = { retentionDays: d, minLevel: "info" };
    expect((await getRetentionSettings()).retentionDays).toBe(7);
  });

  it("an unknown stored level reads as info", async () => {
    settingRows.eventRetention = { retentionDays: 10, minLevel: "debug" };
    expect((await getRetentionSettings()).minLevel).toBe("info");
  });

  it("update keeps the current value for an omitted or unusable field", async () => {
    settingRows.eventRetention = { retentionDays: 21, minLevel: "warning" };
    expect(await updateRetentionSettings({ minLevel: "error" })).toEqual({ retentionDays: 21, minLevel: "error" });
    expect(await updateRetentionSettings({ retentionDays: 0 })).toEqual({ retentionDays: 21, minLevel: "warning" });
    expect(await updateRetentionSettings({ minLevel: "verbose" as never, retentionDays: 9.7 })).toEqual({ retentionDays: 9, minLevel: "warning" });
  });

  it("update upserts the merged value", async () => {
    await updateRetentionSettings({ retentionDays: 3, minLevel: "warning" });
    expect(upsertSetting()).toHaveBeenCalledWith({
      where: { key: "eventRetention" },
      create: { key: "eventRetention", value: { retentionDays: 3, minLevel: "warning" } },
      update: { value: { retentionDays: 3, minLevel: "warning" } },
    });
  });
});

describe("getCachedRetentionSettings — the logEvent hot path", () => {
  // The cache is module state; each test moves the clock far past any earlier one.
  it("an update primes the cache, so the next read costs no query", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2031-01-01T00:00:00Z"));
    await updateRetentionSettings({ retentionDays: 12, minLevel: "error" });
    findSetting().mockClear();
    expect(await getCachedRetentionSettings()).toEqual({ retentionDays: 12, minLevel: "error" });
    expect(findSetting()).not.toHaveBeenCalled();
  });

  it("serves the cached value for a minute, then re-reads", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2032-01-01T00:00:00Z"));
    settingRows.eventRetention = { retentionDays: 5, minLevel: "warning" };
    expect(await getCachedRetentionSettings()).toEqual({ retentionDays: 5, minLevel: "warning" });
    settingRows.eventRetention = { retentionDays: 9, minLevel: "error" };
    vi.setSystemTime(new Date("2032-01-01T00:00:59.999Z"));
    expect((await getCachedRetentionSettings()).retentionDays).toBe(5);
    vi.setSystemTime(new Date("2032-01-01T00:01:00.000Z"));
    expect((await getCachedRetentionSettings()).retentionDays).toBe(9);
    expect(findSetting()).toHaveBeenCalledTimes(2);
  });
});

// ─── Auto-decommission ──────────────────────────────────────────────────────

describe("asset auto-decommission settings", () => {
  it("defaults to 0 (disabled)", async () => {
    expect(await getAssetDecommissionSettings()).toEqual({ inactivityMonths: 0 });
  });

  it("floors a stored value and treats negative / non-numeric as disabled", async () => {
    settingRows.assetAutoDecommission = { inactivityMonths: 6.8 };
    expect(await getAssetDecommissionSettings()).toEqual({ inactivityMonths: 6 });
    settingRows.assetAutoDecommission = { inactivityMonths: -1 };
    expect(await getAssetDecommissionSettings()).toEqual({ inactivityMonths: 0 });
    settingRows.assetAutoDecommission = { inactivityMonths: "soon" };
    expect(await getAssetDecommissionSettings()).toEqual({ inactivityMonths: 0 });
  });

  it("update stores the floored value", async () => {
    expect(await updateAssetDecommissionSettings({ inactivityMonths: 12.4 })).toEqual({ inactivityMonths: 12 });
    expect(upsertSetting()).toHaveBeenCalledWith({
      where: { key: "assetAutoDecommission" },
      create: { key: "assetAutoDecommission", value: { inactivityMonths: 12 } },
      update: { value: { inactivityMonths: 12 } },
    });
  });

  it("unlike retention, an omitted or invalid value is written as 0 — it DISABLES rather than keeping the current setting", async () => {
    settingRows.assetAutoDecommission = { inactivityMonths: 6 };
    expect(await updateAssetDecommissionSettings({})).toEqual({ inactivityMonths: 0 });
    expect(await updateAssetDecommissionSettings({ inactivityMonths: -4 })).toEqual({ inactivityMonths: 0 });
    // It reads the current value only to audit the change (one Event naming
    // the changed key), never to keep it.
    expect(eventLog.logEvent).toHaveBeenCalledWith(expect.objectContaining({
      action: "asset_auto_decommission.settings_updated",
      details: { changed: ["inactivityMonths"] },
    }));
  });
});

// ─── Syslog settings ────────────────────────────────────────────────────────

describe("syslog settings", () => {
  it("defaults to disabled UDP 514, local0, RFC 5424", async () => {
    expect(await getSyslogSettings()).toEqual({
      enabled: false, protocol: "udp", host: "", port: 514, facility: "local0", severity: "info", format: "rfc5424",
      tlsCaPath: "", tlsCertPath: "", tlsKeyPath: "",
    });
  });

  it("merges a partial update over what is stored and upserts it", async () => {
    settingRows.eventSyslog = { host: "syslog.corp", protocol: "tcp" };
    const out = await updateSyslogSettings({ port: 6514 });
    expect(out).toMatchObject({ host: "syslog.corp", protocol: "tcp", port: 6514, facility: "local0" });
    expect(upsertSetting().mock.calls[0][0]).toMatchObject({ where: { key: "eventSyslog" }, update: { value: out } });
  });

  // Was a bug until 2026-11-13: repointing (or disabling) syslog forwarding of the event log is an
  // audit-worthy mutation, but neither updateSyslogSettings nor PUT
  // /events/syslog-settings writes an Event. Fix: logEvent the change.
  it("writes an audit Event when the syslog destination changes", async () => {
    await updateSyslogSettings({ host: "elsewhere.corp", enabled: true });
    expect(eventLog.logEvent).toHaveBeenCalled();
  });
});

// ─── testSyslogConnection ───────────────────────────────────────────────────

class FakeSock extends EventEmitter {
  written: string[] = [];
  write = vi.fn((data: string, cb?: () => void) => { this.written.push(data); setImmediate(() => cb?.()); return true; });
  end = vi.fn();
  destroy = vi.fn();
}

const SYSLOG: SyslogSettings = {
  enabled: true, protocol: "udp", host: "syslog.corp", port: 514, facility: "local0", severity: "info", format: "rfc5424",
};

describe("testSyslogConnection", () => {
  it("requires a host", async () => {
    expect(await testSyslogConnection({ ...SYSLOG, host: "" })).toEqual({ ok: false, message: "Host is required" });
    expect(h.createSocket).not.toHaveBeenCalled();
  });

  it("UDP: sends one RFC 5424 test datagram to host:port and closes the socket", async () => {
    const client = { send: vi.fn((_b: Buffer, _o: number, _l: number, _p: number, _h: string, cb: (e?: Error) => void) => cb()), close: vi.fn() };
    h.createSocket.mockReturnValue(client);
    const r = await testSyslogConnection(SYSLOG);
    expect(r).toEqual({ ok: true, message: "Test message sent to syslog.corp:514 via UDP" });
    expect(h.createSocket).toHaveBeenCalledWith("udp4");
    const [buf, off, len, port, host] = client.send.mock.calls[0];
    expect(buf.toString()).toMatch(/^<134>1 \d{4}-\d\d-\d\dT[\d:.]+Z polaris test - - - Polaris syslog connection test$/);
    expect([off, len, port, host]).toEqual([0, buf.length, 514, "syslog.corp"]);
    expect(client.close).toHaveBeenCalled();
  });

  it("UDP: a send error is reported, and the socket is still closed", async () => {
    const client = { send: vi.fn((...a: unknown[]) => (a[5] as (e?: Error) => void)(new Error("EHOSTUNREACH"))), close: vi.fn() };
    h.createSocket.mockReturnValue(client);
    expect(await testSyslogConnection(SYSLOG)).toEqual({ ok: false, message: "EHOSTUNREACH" });
    expect(client.close).toHaveBeenCalled();
  });

  // Was a bug until 2026-11-13: sendUdp always opens a "udp4" socket, so a syslog server configured
  // by its IPv6 address (host "fd00::5") can never be reached — the send fails
  // with EINVAL / EAFNOSUPPORT and the test reports a dead server. The TCP and
  // TLS paths resolve either family. Fix: createSocket(isIP(host) === 6 ? "udp6" : "udp4"),
  // the same choice buildSnmpSession makes for SNMP (rule 128).
  it("UDP: an IPv6 syslog server gets a udp6 socket", async () => {
    const client = { send: vi.fn((...a: unknown[]) => (a[5] as (e?: Error) => void)()), close: vi.fn() };
    h.createSocket.mockReturnValue(client);
    await testSyslogConnection({ ...SYSLOG, host: "fd00::5" });
    expect(h.createSocket).toHaveBeenCalledWith("udp6");
  });

  it("TCP: connects, writes the message newline-terminated, and ends the socket", async () => {
    const sock = new FakeSock();
    h.createConnection.mockImplementation((_o: unknown, onConnect: () => void) => { setImmediate(onConnect); return sock; });
    const r = await testSyslogConnection({ ...SYSLOG, protocol: "tcp", port: 601 });
    expect(r).toEqual({ ok: true, message: "Test message sent to syslog.corp:601 via TCP" });
    expect(h.createConnection.mock.calls[0][0]).toEqual({ host: "syslog.corp", port: 601 });
    expect(sock.written[0]).toMatch(/Polaris syslog connection test\n$/);
    expect(sock.end).toHaveBeenCalled();
  });

  it("TCP: a socket error is reported", async () => {
    const sock = new FakeSock();
    h.createConnection.mockImplementation(() => { setImmediate(() => sock.emit("error", new Error("ECONNREFUSED"))); return sock; });
    expect(await testSyslogConnection({ ...SYSLOG, protocol: "tcp" })).toEqual({ ok: false, message: "ECONNREFUSED" });
  });

  it("TCP: gives up after 10 s and destroys the socket", async () => {
    vi.useFakeTimers();
    const sock = new FakeSock();
    h.createConnection.mockImplementation(() => sock);
    const p = testSyslogConnection({ ...SYSLOG, protocol: "tcp" });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await p).toEqual({ ok: false, message: "Connection timeout" });
    expect(sock.destroy).toHaveBeenCalled();
  });

  it("TLS without a CA path does not verify the server certificate and reads no files", async () => {
    const sock = new FakeSock();
    h.tlsConnect.mockImplementation((_o: unknown, onConnect: () => void) => { setImmediate(onConnect); return sock; });
    const r = await testSyslogConnection({ ...SYSLOG, protocol: "tls", port: 6514, tlsCaPath: "", tlsCertPath: "", tlsKeyPath: "" });
    expect(r).toEqual({ ok: true, message: "Test message sent to syslog.corp:6514 via TLS" });
    expect(h.tlsConnect.mock.calls[0][0]).toEqual({ host: "syslog.corp", port: 6514, rejectUnauthorized: false });
    expect(h.readFileSync).not.toHaveBeenCalled();
  });

  it("TLS with a CA verifies, and loads the CA, client cert and key from disk", async () => {
    const sock = new FakeSock();
    h.tlsConnect.mockImplementation((_o: unknown, onConnect: () => void) => { setImmediate(onConnect); return sock; });
    await testSyslogConnection({ ...SYSLOG, protocol: "tls", tlsCaPath: "/ca.pem", tlsCertPath: "/c.pem", tlsKeyPath: "/k.pem" });
    const opts = h.tlsConnect.mock.calls[0][0];
    expect(opts.rejectUnauthorized).toBe(true);
    expect(String(opts.ca)).toBe("contents of /ca.pem");
    expect(String(opts.cert)).toBe("contents of /c.pem");
    expect(String(opts.key)).toBe("contents of /k.pem");
  });

  it("TLS: an unreadable CA file is reported, not thrown", async () => {
    h.readFileSync.mockImplementationOnce(() => { throw new Error("ENOENT: /missing.pem"); });
    const r = await testSyslogConnection({ ...SYSLOG, protocol: "tls", tlsCaPath: "/missing.pem" });
    expect(r).toEqual({ ok: false, message: "ENOENT: /missing.pem" });
    expect(h.tlsConnect).not.toHaveBeenCalled();
  });

  it("TLS: gives up after 10 s", async () => {
    vi.useFakeTimers();
    const sock = new FakeSock();
    h.tlsConnect.mockImplementation(() => sock);
    const p = testSyslogConnection({ ...SYSLOG, protocol: "tls" });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await p).toEqual({ ok: false, message: "TLS connection timeout" });
    expect(sock.destroy).toHaveBeenCalled();
  });
});
