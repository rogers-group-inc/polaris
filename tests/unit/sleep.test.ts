/**
 * tests/unit/sleep.test.ts
 */

import { describe, it, expect } from "vitest";
import { sleep } from "../../src/utils/sleep.js";

describe("sleep", () => {
  it("resolves after roughly the requested delay", async () => {
    const start = Date.now();
    await sleep(25);
    expect(Date.now() - start).toBeGreaterThanOrEqual(20);
  });

  it("resolves immediately for 0", async () => {
    await expect(sleep(0)).resolves.toBeUndefined();
  });

  it("resolves at once when the signal is already aborted", async () => {
    const ac = new AbortController();
    ac.abort();
    const start = Date.now();
    await expect(sleep(5_000, ac.signal)).resolves.toBeUndefined();
    expect(Date.now() - start).toBeLessThan(1_000);
  });

  it("resolves early, without rejecting, when the signal aborts mid-wait", async () => {
    const ac = new AbortController();
    const start = Date.now();
    setTimeout(() => ac.abort(), 20);
    await expect(sleep(5_000, ac.signal)).resolves.toBeUndefined();
    expect(Date.now() - start).toBeLessThan(1_000);
  });

  it("waits the full delay when the signal never aborts", async () => {
    const ac = new AbortController();
    const start = Date.now();
    await sleep(25, ac.signal);
    expect(Date.now() - start).toBeGreaterThanOrEqual(20);
  });
});
