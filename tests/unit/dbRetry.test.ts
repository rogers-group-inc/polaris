/**
 * tests/unit/dbRetry.test.ts
 *
 * retryOnDeadlock: SQLSTATE 40P01 (under any of the Prisma adapter shapes, or
 * the "deadlock detected" message) is retried up to 3 times with a jittered
 * sleep; anything else is rethrown at once; the 4th deadlock surfaces the
 * original error untouched.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const sleepMock = vi.hoisted(() => vi.fn(async (_ms: number) => undefined));
vi.mock("../../src/utils/sleep.js", () => ({ sleep: sleepMock }));

import { retryOnDeadlock } from "../../src/utils/dbRetry.js";

beforeEach(() => sleepMock.mockClear());

const deadlockShapes: Array<[string, unknown]> = [
  ["direct code", Object.assign(new Error("x"), { code: "40P01" })],
  ["adapter originalCode", { meta: { driverAdapterError: { cause: { originalCode: "40P01" } } } }],
  ["adapter cause code", { meta: { driverAdapterError: { cause: { code: "40P01" } } } }],
  ["message only", new Error("ERROR: deadlock detected")],
];

describe("retryOnDeadlock", () => {
  it("returns the first success without sleeping", async () => {
    await expect(retryOnDeadlock(async () => 7)).resolves.toBe(7);
    expect(sleepMock).not.toHaveBeenCalled();
  });

  it.each(deadlockShapes)("retries a deadlock reported as %s", async (_label, err) => {
    const op = vi.fn().mockRejectedValueOnce(err).mockResolvedValueOnce("ok");
    await expect(retryOnDeadlock(op)).resolves.toBe("ok");
    expect(op).toHaveBeenCalledTimes(2);
    expect(sleepMock).toHaveBeenCalledTimes(1);
  });

  it("jitters the backoff within 25..99 ms", async () => {
    const err = Object.assign(new Error("d"), { code: "40P01" });
    const op = vi.fn().mockRejectedValueOnce(err).mockRejectedValueOnce(err).mockResolvedValue(1);
    await retryOnDeadlock(op);
    for (const [ms] of sleepMock.mock.calls) {
      expect(ms).toBeGreaterThanOrEqual(25);
      expect(ms).toBeLessThan(100);
    }
  });

  it("gives up after 4 attempts and throws the last deadlock error itself", async () => {
    const errs = [1, 2, 3, 4].map((i) => Object.assign(new Error(`d${i}`), { code: "40P01" }));
    const op = vi.fn();
    for (const e of errs) op.mockRejectedValueOnce(e);
    await expect(retryOnDeadlock(op)).rejects.toBe(errs[3]);
    expect(op).toHaveBeenCalledTimes(4);
  });

  it("rethrows a non-deadlock error immediately", async () => {
    const err = Object.assign(new Error("unique"), { code: "P2002" });
    const op = vi.fn().mockRejectedValue(err);
    await expect(retryOnDeadlock(op)).rejects.toBe(err);
    expect(op).toHaveBeenCalledTimes(1);
    expect(sleepMock).not.toHaveBeenCalled();
  });

  it("rethrows non-object throwables without retrying", async () => {
    const op = vi.fn().mockRejectedValue("boom");
    await expect(retryOnDeadlock(op)).rejects.toBe("boom");
    expect(op).toHaveBeenCalledTimes(1);
  });
});
