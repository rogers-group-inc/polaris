/**
 * tests/unit/haHeartbeatService.test.ts — the active-instance conflict rule.
 *
 * The asymmetry is the thing worth pinning: a FOREIGN fresh stamp must block a
 * boot (two instances on one database double every poll and every alert), while
 * this host's OWN stamp must never block one, or a systemd restart mid-tick
 * would leave the app permanently refusing to start. A stale or corrupt stamp
 * likewise has to fall open, so a promoted node is never held down by
 * bookkeeping the dead host left behind.
 */

import { describe, it, expect } from "vitest";
import {
  evaluateHeartbeat,
  isHeartbeatEnabled,
  CONFLICT_WINDOW_MS,
  WAL_SAMPLE_EVERY_TICKS,
  WAL_SAMPLE_RING_SIZE,
  HEARTBEAT_INTERVAL_MS,
} from "../../src/services/haHeartbeatService.js";

const NOW = new Date("2026-09-08T12:00:00.000Z");
const stamp = (hostname: string, agoMs: number, pid = 1234) => ({
  hostname,
  pid,
  at: new Date(NOW.getTime() - agoMs).toISOString(),
});

describe("evaluateHeartbeat", () => {
  it("does not conflict when no stamp exists", () => {
    expect(evaluateHeartbeat(undefined, NOW, "polaris-a")).toEqual({ conflict: false });
    expect(evaluateHeartbeat(null, NOW, "polaris-a")).toEqual({ conflict: false });
  });

  it("conflicts on a fresh stamp from another host", () => {
    const verdict = evaluateHeartbeat(stamp("polaris-b", 10_000), NOW, "polaris-a");
    expect(verdict.conflict).toBe(true);
    expect(verdict.holder).toBe("polaris-b");
    expect(verdict.ageMs).toBe(10_000);
  });

  it("never conflicts on this host's own stamp, however fresh", () => {
    expect(evaluateHeartbeat(stamp("polaris-a", 0), NOW, "polaris-a").conflict).toBe(false);
    expect(evaluateHeartbeat(stamp("polaris-a", 1_000), NOW, "polaris-a").conflict).toBe(false);
  });

  it("falls open once another host's stamp ages past the window", () => {
    const verdict = evaluateHeartbeat(
      stamp("polaris-b", CONFLICT_WINDOW_MS + 1),
      NOW,
      "polaris-a",
    );
    expect(verdict.conflict).toBe(false);
    expect(verdict.ageMs).toBe(CONFLICT_WINDOW_MS + 1);
  });

  it("treats a stamp exactly at the window edge as still live", () => {
    expect(
      evaluateHeartbeat(stamp("polaris-b", CONFLICT_WINDOW_MS), NOW, "polaris-a").conflict,
    ).toBe(true);
  });

  it("treats a future-dated foreign stamp as live (peer clock skew)", () => {
    const verdict = evaluateHeartbeat(stamp("polaris-b", -30_000), NOW, "polaris-a");
    expect(verdict.conflict).toBe(true);
    expect(verdict.holder).toBe("polaris-b");
  });

  it("falls open on a malformed stamp rather than wedging the app", () => {
    expect(evaluateHeartbeat({ hostname: "polaris-b" }, NOW, "polaris-a").conflict).toBe(false);
    expect(evaluateHeartbeat({ at: NOW.toISOString() }, NOW, "polaris-a").conflict).toBe(false);
    expect(evaluateHeartbeat({ hostname: "polaris-b", at: "not-a-date" }, NOW, "polaris-a").conflict).toBe(false);
    expect(evaluateHeartbeat({ hostname: "", at: NOW.toISOString() }, NOW, "polaris-a").conflict).toBe(false);
    expect(evaluateHeartbeat("nonsense", NOW, "polaris-a").conflict).toBe(false);
  });

  it("tolerates a stamp with no pid (written by an older release)", () => {
    const verdict = evaluateHeartbeat(
      { hostname: "polaris-b", at: NOW.toISOString() },
      NOW,
      "polaris-a",
    );
    expect(verdict.conflict).toBe(true);
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
