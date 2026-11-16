/**
 * tests/unit/probePatchBuffer.test.ts — own unit suite (CQ-T010) for
 * src/services/probePatchBuffer.ts: the merge rule (last-write-wins with
 * preserve-on-absent stamps), the positional bulk UPDATE, re-entrancy, the
 * failure restore, the size-threshold flush and the timer lifecycle.
 *
 * No database: `$executeRawUnsafe` is a spy, `retryOnDeadlock` a passthrough
 * (its backoff sleeps), metrics and logger are mocked. The 5,000-row chunking
 * is covered by tests/unit/probePatchChunking.test.ts.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const h = vi.hoisted(() => ({
  exec: vi.fn(async (..._args: unknown[]) => 0),
  retry: vi.fn(async (op: () => Promise<unknown>) => op()),
  depth: vi.fn(),
  stopTimer: vi.fn(),
  startTimer: vi.fn(),
  warn: vi.fn(),
}));

vi.mock("../../src/db.js", () => ({ prisma: { $executeRawUnsafe: h.exec } }));
vi.mock("../../src/utils/dbRetry.js", () => ({ retryOnDeadlock: h.retry }));
vi.mock("../../src/metrics.js", () => ({
  startProbePatchWriteTimer: h.startTimer,
  setProbePatchBufferDepth: h.depth,
}));
vi.mock("../../src/utils/logger.js", () => ({
  logger: { warn: h.warn, info: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

import {
  enqueueProbePatch,
  flushProbePatchBuffer,
  getPendingProbePatch,
  shutdownFlushProbePatchBuffer,
  startProbePatchBuffer,
  __test__,
  type ProbePatch,
} from "../../src/services/probePatchBuffer.js";

const T0 = new Date("2026-11-14T10:00:00.000Z");
const T1 = new Date("2026-11-14T10:00:05.000Z");

function patch(over: Partial<ProbePatch> = {}): ProbePatch {
  return {
    monitorStatus: "up",
    lastMonitorAt: T0,
    lastResponseTimeMs: 3,
    consecutiveFailures: 0,
    consecutiveSuccesses: 1,
    ...over,
  };
}

const execCall = (i = 0) => h.exec.mock.calls[i] as unknown as [string, ...unknown[]];

beforeEach(() => {
  __test__.reset();
  h.exec.mockReset();
  h.exec.mockResolvedValue(0);
  h.retry.mockClear();
  h.depth.mockClear();
  h.startTimer.mockReset();
  h.startTimer.mockReturnValue(h.stopTimer);
  h.stopTimer.mockClear();
  h.warn.mockClear();
});

afterEach(() => {
  __test__.reset();
  vi.useRealTimers();
});

describe("getPendingProbePatch", () => {
  it("is null for an asset with nothing pending, and the patch once enqueued", () => {
    expect(getPendingProbePatch("a")).toBeNull();
    const p = patch();
    enqueueProbePatch("a", p);
    expect(getPendingProbePatch("a")).toEqual(p);
    expect(getPendingProbePatch("b")).toBeNull();
  });
});

describe("enqueueProbePatch — merge rule", () => {
  it("last write wins for status, timestamp, counters and response time", () => {
    enqueueProbePatch("a", patch());
    enqueueProbePatch("a", patch({ monitorStatus: "warning", lastMonitorAt: T1, lastResponseTimeMs: null, consecutiveFailures: 1, consecutiveSuccesses: 0 }));
    expect(getPendingProbePatch("a")).toMatchObject({
      monitorStatus: "warning", lastMonitorAt: T1, lastResponseTimeMs: null, consecutiveFailures: 1, consecutiveSuccesses: 0,
    });
    expect(__test__.getBufferDepth()).toBe(1);
  });

  it("preserves every stamp the newer patch omits", () => {
    enqueueProbePatch("a", patch({
      monitorStatusChangedAt: T0, lastUptimeSec: 100, lastRebootAt: T0, lastDescrAt: T0,
      recoveryStartedAt: T0, awaitingRecoveryConfirm: true, lastSeen: T0, lastSeenSource: "probe",
      ipConfirmedFor: "10.0.0.1", ipConfirmedSince: T0,
    }));
    enqueueProbePatch("a", patch({ monitorStatus: "warning", lastMonitorAt: T1 }));
    expect(getPendingProbePatch("a")).toMatchObject({
      monitorStatus: "warning",
      monitorStatusChangedAt: T0, lastUptimeSec: 100, lastRebootAt: T0, lastDescrAt: T0,
      recoveryStartedAt: T0, awaitingRecoveryConfirm: true, lastSeen: T0, lastSeenSource: "probe",
      ipConfirmedFor: "10.0.0.1", ipConfirmedSince: T0,
    });
  });

  it("lets a newer stamp replace an older one", () => {
    enqueueProbePatch("a", patch({ monitorStatusChangedAt: T0, lastUptimeSec: 100, lastSeen: T0 }));
    enqueueProbePatch("a", patch({ monitorStatusChangedAt: T1, lastUptimeSec: 5, lastSeen: T1 }));
    expect(getPendingProbePatch("a")).toMatchObject({ monitorStatusChangedAt: T1, lastUptimeSec: 5, lastSeen: T1 });
  });

  it("lands a disarming `false` over an armed `true` (?? not ||)", () => {
    enqueueProbePatch("a", patch({ awaitingRecoveryConfirm: true }));
    enqueueProbePatch("a", patch({ awaitingRecoveryConfirm: false }));
    expect(getPendingProbePatch("a")?.awaitingRecoveryConfirm).toBe(false);
  });

  it("keeps an uptime of 0 (a just-booted device) rather than the prior reading", () => {
    enqueueProbePatch("a", patch({ lastUptimeSec: 9999 }));
    enqueueProbePatch("a", patch({ lastUptimeSec: 0 }));
    expect(getPendingProbePatch("a")?.lastUptimeSec).toBe(0);
  });

  it("moves the address-confidence run as a pair", () => {
    enqueueProbePatch("a", patch({ ipConfirmedFor: "10.0.0.1", ipConfirmedSince: T0 }));
    // A restart for a new address without a since replaces BOTH (since → undefined).
    enqueueProbePatch("a", patch({ ipConfirmedFor: "2001:db8::1" }));
    expect(getPendingProbePatch("a")).toMatchObject({ ipConfirmedFor: "2001:db8::1" });
    expect(getPendingProbePatch("a")?.ipConfirmedSince).toBeUndefined();
  });

  it("keeps assets independent", () => {
    enqueueProbePatch("a", patch({ lastSeen: T0 }));
    enqueueProbePatch("b", patch({ monitorStatus: "down" }));
    expect(getPendingProbePatch("b")?.lastSeen).toBeUndefined();
    expect(getPendingProbePatch("a")?.monitorStatus).toBe("up");
  });

  it("publishes the buffer depth on every enqueue", () => {
    enqueueProbePatch("a", patch());
    enqueueProbePatch("b", patch());
    enqueueProbePatch("b", patch());
    expect(h.depth.mock.calls.map((c) => c[1])).toEqual([1, 2, 2]);
    expect(h.depth.mock.calls[0]![0]).toBe("assets:probe");
  });

  it("flushes early when the buffer reaches 5,000 entries", async () => {
    for (let i = 0; i < 4999; i++) enqueueProbePatch(`a${i}`, patch());
    expect(h.exec).not.toHaveBeenCalled();
    enqueueProbePatch("a4999", patch());
    await vi.waitFor(() => expect(h.exec).toHaveBeenCalled());
    await vi.waitFor(() => expect(__test__.getBufferDepth()).toBe(0));
  });
});

describe("flushProbePatchBuffer — the bulk UPDATE", () => {
  it("does nothing on an empty buffer", async () => {
    await flushProbePatchBuffer();
    expect(h.exec).not.toHaveBeenCalled();
    expect(h.startTimer).not.toHaveBeenCalled();
  });

  it("writes one UPDATE … FROM (VALUES …) with 16 positional params per row, in column order", async () => {
    enqueueProbePatch("a", patch({
      monitorStatus: "down", lastResponseTimeMs: null, consecutiveFailures: 3, consecutiveSuccesses: 0,
      monitorStatusChangedAt: T1, lastUptimeSec: 42, lastRebootAt: T1, lastSeen: T0, lastSeenSource: "probe",
      recoveryStartedAt: T1, awaitingRecoveryConfirm: false, lastDescrAt: T0,
      ipConfirmedFor: "2001:db8::5", ipConfirmedSince: T1,
    }));
    await flushProbePatchBuffer();
    const [sql, ...params] = execCall();
    expect(params).toEqual([
      "a", "down", T0.toISOString(), null, 3, 0, T1.toISOString(),
      42, T1.toISOString(), T0.toISOString(), "probe",
      T1.toISOString(), false, T0.toISOString(),
      "2001:db8::5", T1.toISOString(),
    ]);
    expect(sql).toContain(`UPDATE "assets" AS t SET`);
    expect(sql).toContain(
      "AS v(id, status, last_monitor_at, rt, cf, cs, changed_at, uptime_sec, reboot_at, last_seen, last_seen_source, recovery_started_at, awaiting_recovery_confirm, last_descr_at, ip_confirmed_for, ip_confirmed_since)",
    );
    expect(sql).toContain(`WHERE t."id" = v.id`);
    expect(sql).toContain("($1::text, $2::text, $3::timestamp, $4::int, $5::int, $6::int, $7::timestamp, $8::int, $9::timestamp, $10::timestamp, $11::text, $12::timestamp, $13::boolean, $14::timestamp, $15::text, $16::timestamp)");
  });

  it("binds null for every omitted stamp so COALESCE keeps the row's value", async () => {
    enqueueProbePatch("a", patch());
    await flushProbePatchBuffer();
    const [sql, ...params] = execCall();
    expect(params.slice(6)).toEqual([null, null, null, null, null, null, null, null, null, null]);
    for (const [col, alias] of [
      ["monitorStatusChangedAt", "changed_at"], ["lastUptimeSec", "uptime_sec"], ["lastRebootAt", "reboot_at"],
      ["lastSeen", "last_seen"], ["lastSeenSource", "last_seen_source"], ["recoveryStartedAt", "recovery_started_at"],
      ["awaitingRecoveryConfirm", "awaiting_recovery_confirm"], ["lastDescrAt", "last_descr_at"],
      ["ipConfirmedFor", "ip_confirmed_for"], ["ipConfirmedSince", "ip_confirmed_since"],
    ]) {
      expect(sql).toContain(`COALESCE(v.${alias}, t."${col}")`);
    }
    // The rolling state is overwritten, never coalesced.
    expect(sql).toMatch(/"consecutiveFailures"\s+= v\.cf,/);
    expect(sql).toMatch(/"lastResponseTimeMs"\s+= v\.rt,/);
  });

  it("numbers placeholders continuously across rows", async () => {
    enqueueProbePatch("a", patch());
    enqueueProbePatch("b", patch({ monitorStatus: "down" }));
    await flushProbePatchBuffer();
    const [sql, ...params] = execCall();
    expect(params).toHaveLength(32);
    expect(params[16]).toBe("b");
    expect(params[17]).toBe("down");
    expect(sql).toContain("($17::text, $18::text, $19::timestamp");
    expect(sql).toContain("$32::timestamp)");
  });

  it("empties the buffer, wraps each chunk in the deadlock retry and stops the write timer", async () => {
    enqueueProbePatch("a", patch());
    await flushProbePatchBuffer();
    expect(__test__.getBufferDepth()).toBe(0);
    expect(getPendingProbePatch("a")).toBeNull();
    expect(h.retry).toHaveBeenCalledTimes(1);
    expect(h.startTimer).toHaveBeenCalledTimes(1);
    expect(h.stopTimer).toHaveBeenCalledTimes(1);
    expect(h.depth).toHaveBeenLastCalledWith("assets:probe", 0);
  });

  it("is a no-op while another flush is mid-write; enqueues during it land in a fresh buffer", async () => {
    let release!: () => void;
    h.exec.mockImplementationOnce(() => new Promise<number>((r) => { release = () => r(0); }));
    enqueueProbePatch("a", patch());
    const first = flushProbePatchBuffer();
    enqueueProbePatch("b", patch());
    await flushProbePatchBuffer();
    expect(h.exec).toHaveBeenCalledTimes(1);
    release();
    await first;
    expect(getPendingProbePatch("b")).not.toBeNull();
    await flushProbePatchBuffer();
    expect(h.exec).toHaveBeenCalledTimes(2);
    expect(execCall(1)[1]).toBe("b");
  });

  // Was a bug until 2026-11-16: while a flush awaited its write the snapshot had left the buffer, so getPendingProbePatch returned null and a probe read stale DB counters.
  it("keeps an asset's in-flight patch readable until the write settles", async () => {
    let release!: () => void;
    h.exec.mockImplementationOnce(() => new Promise<number>((r) => { release = () => r(0); }));
    enqueueProbePatch("a", patch({ consecutiveFailures: 1, monitorStatusChangedAt: T0 }));
    const inFlight = flushProbePatchBuffer();
    expect(getPendingProbePatch("a")).toMatchObject({ consecutiveFailures: 1 });
    // A newer patch wins, merged over the in-flight one (preserve-on-absent).
    enqueueProbePatch("a", patch({ consecutiveFailures: 2, lastMonitorAt: T1 }));
    expect(getPendingProbePatch("a")).toMatchObject({ consecutiveFailures: 2, lastMonitorAt: T1, monitorStatusChangedAt: T0 });
    release();
    await inFlight;
    // Settled: only the newer pending patch remains.
    expect(getPendingProbePatch("a")).toMatchObject({ consecutiveFailures: 2 });
    expect(getPendingProbePatch("a")?.monitorStatusChangedAt).toBeUndefined();
  });
});

describe("flushProbePatchBuffer — failure restore", () => {
  it("restores the failed rows, logs a warning, and does not throw", async () => {
    h.exec.mockRejectedValueOnce(new Error("connection refused"));
    enqueueProbePatch("a", patch({ lastSeen: T0 }));
    enqueueProbePatch("b", patch());
    await expect(flushProbePatchBuffer()).resolves.toBeUndefined();
    expect(__test__.getBufferDepth()).toBe(2);
    expect(getPendingProbePatch("a")?.lastSeen).toEqual(T0);
    expect(h.warn).toHaveBeenCalledTimes(1);
    expect(h.warn.mock.calls[0]![0]).toMatchObject({ err: "connection refused", rowCount: 2 });
    expect(h.stopTimer).toHaveBeenCalledTimes(1);
    // The next flush retries them.
    await flushProbePatchBuffer();
    expect(__test__.getBufferDepth()).toBe(0);
  });

  it("lets a fresher patch enqueued during the failed write win over the stale snapshot", async () => {
    let fail!: () => void;
    h.exec.mockImplementationOnce(() => new Promise<number>((_r, rej) => { fail = () => rej(new Error("boom")); }));
    enqueueProbePatch("a", patch({ consecutiveFailures: 1, monitorStatus: "warning" }));
    const inFlight = flushProbePatchBuffer();
    enqueueProbePatch("a", patch({ consecutiveFailures: 2, monitorStatus: "warning", lastMonitorAt: T1 }));
    fail();
    await inFlight;
    expect(getPendingProbePatch("a")).toMatchObject({ consecutiveFailures: 2, lastMonitorAt: T1 });
  });

  // Was a bug until 2026-11-14: the module's merge contract is preserve-on-absent for the
  // transition / reboot / recovery stamps ("the DB ends up with the actual
  // transition timestamp instead of NULL-erasing it"), but the failure restore
  // re-adds a snapshot entry ONLY when the buffer has no entry for that asset —
  // it never merges. Input: probe N transitions the asset to down
  // (monitorStatusChangedAt = T0, awaitingRecoveryConfirm = true), the flush
  // carrying it fails, and probe N+1 (still down, no transition, no stamps)
  // was enqueued during the write. Wrong: the buffer keeps only N+1, so
  // monitorStatusChangedAt and the rule-36 recovery-confirm arm are never
  // written (the status says down, the changed-at stamp stays at the old
  // transition). Right: the restored snapshot is merged under the fresher
  // patch by the same rule enqueueProbePatch uses, keeping T0 and `true`.
  it("keeps a failed snapshot's transition stamps under a fresher patch", async () => {
    let fail!: () => void;
    h.exec.mockImplementationOnce(() => new Promise<number>((_r, rej) => { fail = () => rej(new Error("boom")); }));
    enqueueProbePatch("a", patch({ monitorStatus: "down", consecutiveFailures: 3, monitorStatusChangedAt: T0, awaitingRecoveryConfirm: true }));
    const inFlight = flushProbePatchBuffer();
    enqueueProbePatch("a", patch({ monitorStatus: "down", consecutiveFailures: 3, lastMonitorAt: T1 }));
    fail();
    await inFlight;
    expect(getPendingProbePatch("a")).toMatchObject({ monitorStatusChangedAt: T0, awaitingRecoveryConfirm: true, lastMonitorAt: T1 });
  });

  it("releases the re-entrancy guard after a failure", async () => {
    h.exec.mockRejectedValueOnce(new Error("x"));
    enqueueProbePatch("a", patch());
    await flushProbePatchBuffer();
    await flushProbePatchBuffer();
    expect(h.exec).toHaveBeenCalledTimes(2);
  });
});

describe("timer lifecycle", () => {
  it("flushes every 2 s once started, and a second start is a no-op", async () => {
    vi.useFakeTimers();
    startProbePatchBuffer();
    startProbePatchBuffer();
    enqueueProbePatch("a", patch());
    await vi.advanceTimersByTimeAsync(1999);
    expect(h.exec).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(h.exec).toHaveBeenCalledTimes(1);
    enqueueProbePatch("b", patch());
    await vi.advanceTimersByTimeAsync(2000);
    expect(h.exec).toHaveBeenCalledTimes(2);
  });

  it("shutdown stops the timer and drains what is pending", async () => {
    vi.useFakeTimers();
    startProbePatchBuffer();
    enqueueProbePatch("a", patch());
    await shutdownFlushProbePatchBuffer();
    expect(h.exec).toHaveBeenCalledTimes(1);
    enqueueProbePatch("b", patch());
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.exec).toHaveBeenCalledTimes(1);
  });

  it("shutdown is safe without a started timer and with an empty buffer", async () => {
    await expect(shutdownFlushProbePatchBuffer()).resolves.toBeUndefined();
    expect(h.exec).not.toHaveBeenCalled();
  });
});
