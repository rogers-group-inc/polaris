/**
 * tests/unit/icmpSpawnEperm.test.ts
 *
 * `spawn` failing SYNCHRONOUSLY, which is not the same failure as the "error"
 * event and used to be handled nowhere in the ICMP path.
 *
 * Debian ships both `fping` and `ping` with the file capability
 * `cap_net_raw=ep`. A process that cannot be granted CAP_NET_RAW — a rootless
 * container, or a systemd unit whose CapabilityBoundingSet omits it — fails
 * execve with EPERM, and Node throws that from the `spawn()` call itself rather
 * than emitting it on the child. Every site here caught only the async form, so
 * the throw escaped the Promise executor and REJECTED the promise.
 *
 * For `detectFping` that was the severe one: the answer is memoized, so the
 * rejection was cached for the life of the process and every later
 * `await detectFping()` rejected — `computeDueWork` → `runMonitorPass` then
 * died on EVERY tick. Monitoring stopped altogether instead of degrading to the
 * per-host `ping` fallback the code was written to fall back to.
 *
 * These tests force the synchronous throw with a mock, so they hold on any host
 * regardless of what capabilities it actually grants.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));

vi.mock("node:child_process", () => ({ spawn: spawnMock }));

const { detectFping, __resetFpingDetectionForTests } = await import("../../src/utils/burstPing.js");
const { pingHost, burstPingHost } = await import("../../src/utils/icmpPing.js");

/** What Node throws when execve is refused for a capability-carrying binary. */
function eperm(): Error {
  const err = new Error("spawn EPERM") as Error & { errno: number; code: string; syscall: string };
  err.errno = -1;
  err.code = "EPERM";
  err.syscall = "spawn";
  return err;
}

beforeEach(() => {
  spawnMock.mockReset();
  spawnMock.mockImplementation(() => { throw eperm(); });
  __resetFpingDetectionForTests();
});

describe("detectFping when spawn throws synchronously", () => {
  it("resolves false instead of rejecting", async () => {
    await expect(detectFping()).resolves.toBe(false);
  });

  it("does not cache a REJECTION — the memoized answer stays usable", async () => {
    // The regression: one EPERM used to poison every later call, so the monitor
    // pass failed forever rather than once.
    await expect(detectFping()).resolves.toBe(false);
    await expect(detectFping()).resolves.toBe(false);
    await expect(detectFping()).resolves.toBe(false);
  });

  it("probes only once, so the failure costs one spawn attempt, not one per sweep", async () => {
    await detectFping();
    await detectFping();
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });
});

describe("the per-host ping fallback when spawn throws synchronously", () => {
  it("pingHost reports failure with the reason instead of rejecting", async () => {
    const res = await pingHost("10.0.0.1", 1000);
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/EPERM/);
  });

  it("burstPingHost reports NOTHING SENT, never a 100% loss reading", async () => {
    // Inventing 100% loss here would read as a fleet-wide outage; "we never
    // asked" has to stay distinguishable from "we asked and heard nothing".
    await expect(burstPingHost("10.0.0.1", { count: 5, intervalMs: 500, timeoutMs: 1000 }))
      .resolves.toEqual({ sent: 0, received: 0, avgRttMs: null });
  });
});
