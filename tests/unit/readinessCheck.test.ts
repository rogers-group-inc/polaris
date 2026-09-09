/**
 * tests/unit/readinessCheck.test.ts — the readiness probe's four outcomes.
 *
 * The injectable probe is the whole point of the seam: "I am a hot standby",
 * "my database is unreachable" and "my database is too slow" all have to be
 * distinguishable without a second Postgres in recovery, because the reason
 * string is what tells an operator whether a 503 is expected (standby) or a
 * fault (primary that lost its database).
 */

import { describe, it, expect } from "vitest";
import { checkReadiness } from "../../src/utils/readinessCheck.js";

describe("checkReadiness", () => {
  it("is ready when the probe reports a writable primary", async () => {
    const result = await checkReadiness(async () => true);
    expect(result).toEqual({ ready: true });
  });

  it("is not ready with reason in-recovery on a hot standby", async () => {
    const result = await checkReadiness(async () => false);
    expect(result).toEqual({ ready: false, reason: "in-recovery" });
  });

  it("is not ready with reason db-error when the probe throws", async () => {
    const result = await checkReadiness(async () => {
      throw new Error("ECONNREFUSED");
    });
    expect(result).toEqual({ ready: false, reason: "db-error" });
  });

  it("is not ready with reason timeout when the probe never settles", async () => {
    const started = Date.now();
    const result = await checkReadiness(() => new Promise<boolean>(() => {}), 20);
    expect(result).toEqual({ ready: false, reason: "timeout" });
    // The point of the timeout is that a hung database cannot hold the load
    // balancer's monitor open: the answer must arrive on our schedule.
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("does not let a slow probe win after the timeout has fired", async () => {
    const result = await checkReadiness(
      () => new Promise<boolean>((resolve) => setTimeout(() => resolve(true), 200)),
      10,
    );
    expect(result.ready).toBe(false);
    expect(result.reason).toBe("timeout");
  });

  it("resolves a fast probe well inside a generous timeout", async () => {
    const result = await checkReadiness(
      () => new Promise<boolean>((resolve) => setTimeout(() => resolve(true), 5)),
      1000,
    );
    expect(result).toEqual({ ready: true });
  });
});
