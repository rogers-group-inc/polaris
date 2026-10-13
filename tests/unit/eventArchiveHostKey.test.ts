/**
 * tests/unit/eventArchiveHostKey.test.ts
 *
 * Business rule 113(d): the event archive authenticates its SSH server by
 * trust on first use — every ssh / scp / sftp it spawns pins into a known_hosts
 * file Polaris owns (StrictHostKeyChecking=accept-new) and never disables the
 * check; a changed key comes back as a message that says so.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));

vi.mock("node:child_process", () => ({ spawn: spawnMock }));
vi.mock("../../src/db.js", () => ({
  prisma: {
    setting: { findUnique: vi.fn(async () => null), upsert: vi.fn(async () => ({})) },
    event: { findMany: vi.fn(async () => []) },
  },
}));

import {
  testConnection,
  sshCommonOptions,
  isHostKeyRefusal,
  ARCHIVE_KNOWN_HOSTS,
  ARCHIVE_HOST_KEY_CHANGED_MESSAGE,
  type ArchiveSettings,
} from "../../src/services/eventArchiveService.js";

const GOOD: ArchiveSettings = {
  enabled: true,
  protocol: "scp",
  host: "archive.example.com",
  port: 22,
  username: "polaris-archive",
  password: "",
  keyPath: "",
  remotePath: "/var/archive/polaris",
};

function fakeChild(exitCode = 0, stderr = "") {
  const child: any = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = { write: vi.fn(), end: vi.fn() };
  child.kill = vi.fn();
  setImmediate(() => {
    if (stderr) child.stderr.emit("data", Buffer.from(stderr));
    child.emit("close", exitCode);
  });
  return child;
}

beforeEach(() => {
  spawnMock.mockReset();
  spawnMock.mockImplementation(() => fakeChild(0));
});

describe("sshCommonOptions", () => {
  it("pins on first use into Polaris's own known_hosts and never disables the check", () => {
    const opts = sshCommonOptions().join(" ");
    expect(opts).toContain("StrictHostKeyChecking=accept-new");
    expect(opts).toContain(`UserKnownHostsFile=${ARCHIVE_KNOWN_HOSTS}`);
    expect(opts).not.toContain("StrictHostKeyChecking=no");
  });
});

describe("testConnection", () => {
  it("passes the pinning options to ssh and to sftp", async () => {
    await testConnection(GOOD);
    await testConnection({ ...GOOD, protocol: "sftp" });
    for (const [, args] of spawnMock.mock.calls) {
      expect(args).toContain("StrictHostKeyChecking=accept-new");
    }
  });

  it("explains a changed host key instead of echoing ssh's banner", async () => {
    spawnMock.mockImplementation(() => fakeChild(255,
      "@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@\n@    WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!     @\nHost key verification failed.\n"));
    const res = await testConnection(GOOD);
    expect(res).toEqual({ ok: false, message: ARCHIVE_HOST_KEY_CHANGED_MESSAGE });
  });
});

describe("isHostKeyRefusal", () => {
  it("recognizes OpenSSH's refusals and nothing else", () => {
    expect(isHostKeyRefusal("Host key verification failed.")).toBe(true);
    expect(isHostKeyRefusal("WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!")).toBe(true);
    expect(isHostKeyRefusal("Permission denied (publickey).")).toBe(false);
  });
});
