/**
 * tests/unit/haHeartbeatService.test.ts — the active-instance conflict rule.
 *
 * The asymmetry is the thing worth pinning: a FOREIGN fresh stamp must block a
 * boot (two instances on one database double every poll and every alert), while
 * this install's OWN stamp must never block one, or a systemd restart mid-tick
 * would leave the app permanently refusing to start. A stale or corrupt stamp
 * likewise has to fall open, so a promoted node is never held down by
 * bookkeeping the dead host left behind.
 *
 * "This install" is the load-bearing phrase, and the reason the identity is a
 * persisted ID rather than os.hostname(): a container's hostname is its
 * container ID, regenerated on every recreate, so the hostname rule failed
 * every Docker upgrade closed — see the container-recreate case below.
 */

import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  evaluateHeartbeat,
  isHeartbeatEnabled,
  resolveInstanceId,
  __resetInstanceIdentityForTests,
  CONFLICT_WINDOW_MS,
  WAL_SAMPLE_EVERY_TICKS,
  WAL_SAMPLE_RING_SIZE,
  HEARTBEAT_INTERVAL_MS,
  type InstanceIdentity,
} from "../../src/services/haHeartbeatService.js";

const NOW = new Date("2026-09-08T12:00:00.000Z");

const self = (instanceId: string, hostname = "host-a"): InstanceIdentity => ({ instanceId, hostname });

/** A current stamp — carries the install ID. */
const stamp = (
  instanceId: string,
  agoMs: number,
  hostname = "host-a",
  pid = 1234,
) => ({ instanceId, hostname, pid, at: new Date(NOW.getTime() - agoMs).toISOString() });

/** A stamp written by a release that predates the install ID. */
const legacyStamp = (hostname: string, agoMs: number, pid = 1234) => ({
  hostname,
  pid,
  at: new Date(NOW.getTime() - agoMs).toISOString(),
});

describe("evaluateHeartbeat", () => {
  const A = self("install-a");

  it("does not conflict when no stamp exists", () => {
    expect(evaluateHeartbeat(undefined, NOW, A)).toEqual({ conflict: false });
    expect(evaluateHeartbeat(null, NOW, A)).toEqual({ conflict: false });
  });

  it("conflicts on a fresh stamp from another install", () => {
    const verdict = evaluateHeartbeat(stamp("install-b", 10_000, "host-b"), NOW, A);
    expect(verdict.conflict).toBe(true);
    expect(verdict.holder).toBe("host-b");
    expect(verdict.holderInstanceId).toBe("install-b");
    expect(verdict.ageMs).toBe(10_000);
  });

  it("never conflicts on this install's own stamp, however fresh", () => {
    expect(evaluateHeartbeat(stamp("install-a", 0), NOW, A).conflict).toBe(false);
    expect(evaluateHeartbeat(stamp("install-a", 1_000), NOW, A).conflict).toBe(false);
  });

  it("lets a recreated container boot on its predecessor's fresh stamp", () => {
    // The regression: one install, one database, one process — but Docker gave
    // the new container a new hostname, and the old container stamped 16s ago.
    // Identity is the install, so this is our own stamp and must not block.
    const predecessor = stamp("install-a", 16_000, "722cd35333e9");
    const successor   = self("install-a", "2d78e5cba267");
    expect(evaluateHeartbeat(predecessor, NOW, successor).conflict).toBe(false);
  });

  it("still conflicts between two installs that share a hostname", () => {
    // Two stacks on one host pointed at one database — the hostname matches,
    // the install does not, and this is a genuine double-poll.
    const verdict = evaluateHeartbeat(stamp("install-b", 5_000, "host-a"), NOW, A);
    expect(verdict.conflict).toBe(true);
    expect(verdict.holderInstanceId).toBe("install-b");
  });

  it("falls open once another install's stamp ages past the window", () => {
    const verdict = evaluateHeartbeat(
      stamp("install-b", CONFLICT_WINDOW_MS + 1, "host-b"),
      NOW,
      A,
    );
    expect(verdict.conflict).toBe(false);
    expect(verdict.ageMs).toBe(CONFLICT_WINDOW_MS + 1);
  });

  it("treats a stamp exactly at the window edge as still live", () => {
    expect(
      evaluateHeartbeat(stamp("install-b", CONFLICT_WINDOW_MS, "host-b"), NOW, A).conflict,
    ).toBe(true);
  });

  it("treats a future-dated foreign stamp as live (peer clock skew)", () => {
    const verdict = evaluateHeartbeat(stamp("install-b", -30_000, "host-b"), NOW, A);
    expect(verdict.conflict).toBe(true);
    expect(verdict.holder).toBe("host-b");
  });

  it("falls open on a malformed stamp rather than wedging the app", () => {
    expect(evaluateHeartbeat({ hostname: "host-b" }, NOW, A).conflict).toBe(false);
    expect(evaluateHeartbeat({ at: NOW.toISOString() }, NOW, A).conflict).toBe(false);
    expect(evaluateHeartbeat({ hostname: "host-b", at: "not-a-date" }, NOW, A).conflict).toBe(false);
    expect(evaluateHeartbeat({ hostname: "", at: NOW.toISOString() }, NOW, A).conflict).toBe(false);
    expect(evaluateHeartbeat("nonsense", NOW, A).conflict).toBe(false);
  });

  it("tolerates a stamp with no pid (written by an older release)", () => {
    const verdict = evaluateHeartbeat(
      { instanceId: "install-b", hostname: "host-b", at: NOW.toISOString() },
      NOW,
      A,
    );
    expect(verdict.conflict).toBe(true);
  });

  describe("a stamp with no install ID (written before this field existed)", () => {
    it("falls back to the hostname, and a foreign one still conflicts", () => {
      const verdict = evaluateHeartbeat(legacyStamp("host-b", 10_000), NOW, A);
      expect(verdict.conflict).toBe(true);
      expect(verdict.holder).toBe("host-b");
      expect(verdict.holderInstanceId).toBeUndefined();
    });

    it("does not conflict when the hostname is ours", () => {
      // The upgrade-in-place case: same host, our own pre-upgrade stamp.
      expect(evaluateHeartbeat(legacyStamp("host-a", 0), NOW, A).conflict).toBe(false);
    });
  });
});

describe("resolveInstanceId", () => {
  const tmp: string[] = [];
  const tmpFile = () => {
    const dir = mkdtempSync(join(tmpdir(), "polaris-instance-id-"));
    tmp.push(dir);
    return join(dir, "data", "instance-id");
  };

  afterEach(() => {
    __resetInstanceIdentityForTests();
    delete process.env.POLARIS_HA_INSTANCE_ID;
    for (const dir of tmp.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("generates an ID on first call and persists it", () => {
    const file = tmpFile();
    const first = resolveInstanceId(file);
    expect(first).toMatch(/^[0-9a-f-]{36}$/);
    expect(readFileSync(file, "utf8").trim()).toBe(first);
  });

  it("returns the SAME ID after a restart — this is the whole point", () => {
    const file = tmpFile();
    const first = resolveInstanceId(file);
    __resetInstanceIdentityForTests();          // a new process, same state dir
    expect(resolveInstanceId(file)).toBe(first);
  });

  it("reads an ID a sibling role wrote rather than minting a second one", () => {
    const file = tmpFile();
    resolveInstanceId(file);                    // creates the directory
    writeFileSync(file, "  written-by-web  \n");
    __resetInstanceIdentityForTests();
    expect(resolveInstanceId(file)).toBe("written-by-web");
  });

  it("lets the operator pin one explicitly, without touching the file", () => {
    const file = tmpFile();
    process.env.POLARIS_HA_INSTANCE_ID = "  site-a-primary  ";
    expect(resolveInstanceId(file)).toBe("site-a-primary");
    expect(() => readFileSync(file, "utf8")).toThrow();
  });

  it("ignores a blank override", () => {
    process.env.POLARIS_HA_INSTANCE_ID = "   ";
    expect(resolveInstanceId(tmpFile())).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe("isHeartbeatEnabled", () => {
  const withEnv = (env: Record<string, string | undefined>, fn: () => void) => {
    const saved: Record<string, string | undefined> = {};
    for (const k of Object.keys(env)) {
      saved[k] = process.env[k];
      if (env[k] === undefined) delete process.env[k];
      else process.env[k] = env[k];
    }
    try { fn(); } finally {
      for (const k of Object.keys(saved)) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
    }
  };

  it("is on in production", () => {
    withEnv({ NODE_ENV: "production", POLARIS_HA_HEARTBEAT: undefined }, () => {
      expect(isHeartbeatEnabled()).toBe(true);
    });
  });

  it("is off outside production so dev and tests never trip on it", () => {
    withEnv({ NODE_ENV: "development", POLARIS_HA_HEARTBEAT: undefined }, () => {
      expect(isHeartbeatEnabled()).toBe(false);
    });
    withEnv({ NODE_ENV: "test", POLARIS_HA_HEARTBEAT: undefined }, () => {
      expect(isHeartbeatEnabled()).toBe(false);
    });
  });

  it("honours the explicit override in production", () => {
    withEnv({ NODE_ENV: "production", POLARIS_HA_HEARTBEAT: "off" }, () => {
      expect(isHeartbeatEnabled()).toBe(false);
    });
    withEnv({ NODE_ENV: "production", POLARIS_HA_HEARTBEAT: "OFF" }, () => {
      expect(isHeartbeatEnabled()).toBe(false);
    });
  });
});

describe("sampling constants", () => {
  it("keeps the WAL ring at 24h of 5-minute samples", () => {
    const sampleIntervalMs = HEARTBEAT_INTERVAL_MS * WAL_SAMPLE_EVERY_TICKS;
    expect(sampleIntervalMs).toBe(5 * 60 * 1000);
    expect((WAL_SAMPLE_RING_SIZE * sampleIntervalMs) / (60 * 60 * 1000)).toBe(24);
  });

  it("expires a stamp only after several missed writes", () => {
    expect(CONFLICT_WINDOW_MS / HEARTBEAT_INTERVAL_MS).toBe(3);
  });
});
