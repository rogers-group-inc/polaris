/**
 * tests/unit/fortiosRequestGate.test.ts — per-FortiGate pacing for the direct
 * FortiOS REST transport (src/utils/fortiosRequestGate.ts) and its use in
 * fortigateService.fgRequest.
 *
 * FortiOS 7.6's http_authd locks a SOURCE IP out of API-key access after 3
 * non-OK authorizations, doubling the lockout on each repeat. These tests pin
 * the two behaviours that keep Polaris from driving that lockout: no more than
 * the cap in flight per gate, and nothing sent to a gate during a 401 pause.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  DEFAULT_FORTIOS_PER_GATE_CONCURRENCY,
  FORTIOS_AUTH_PAUSE_BASE_MS,
  FORTIOS_AUTH_PAUSE_MAX_MS,
  resolvePerGateConcurrency,
  authPauseMs,
  fortiosGateKey,
  authPauseRemainingMs,
  recordFortiosAuthResult,
  consecutive401sFor,
  withFortiosGateSlot,
  FortiosGateBusyError,
  _resetFortiosGateState,
} from "../../src/utils/fortiosRequestGate.js";

vi.mock("../../src/utils/tlsDispatcher.js", () => ({
  tlsFetch: (...args: unknown[]) => (globalThis.fetch as (...a: unknown[]) => unknown)(...args),
  insecureTlsDispatcher: () => ({}),
}));

beforeEach(() => _resetFortiosGateState());
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("resolvePerGateConcurrency", () => {
  it("defaults below FortiOS's default lockout threshold of 3", () => {
    expect(resolvePerGateConcurrency({})).toBe(DEFAULT_FORTIOS_PER_GATE_CONCURRENCY);
    expect(DEFAULT_FORTIOS_PER_GATE_CONCURRENCY).toBeLessThan(3);
  });
  it("honours a valid override and clamps it", () => {
    expect(resolvePerGateConcurrency({ POLARIS_FORTIOS_PER_GATE_CONCURRENCY: "4" })).toBe(4);
    expect(resolvePerGateConcurrency({ POLARIS_FORTIOS_PER_GATE_CONCURRENCY: "4.9" })).toBe(4);
    expect(resolvePerGateConcurrency({ POLARIS_FORTIOS_PER_GATE_CONCURRENCY: "999" })).toBe(16);
  });
  it("falls back to the default, never to unlimited, on garbage", () => {
    for (const v of ["0", "-2", "abc", ""]) {
      expect(resolvePerGateConcurrency({ POLARIS_FORTIOS_PER_GATE_CONCURRENCY: v })).toBe(DEFAULT_FORTIOS_PER_GATE_CONCURRENCY);
    }
  });
});

describe("authPauseMs", () => {
  it("starts at the base and doubles per consecutive 401", () => {
    expect(authPauseMs(1)).toBe(FORTIOS_AUTH_PAUSE_BASE_MS);
    expect(authPauseMs(2)).toBe(2 * FORTIOS_AUTH_PAUSE_BASE_MS);
    expect(authPauseMs(3)).toBe(4 * FORTIOS_AUTH_PAUSE_BASE_MS);
  });
  it("caps at the ceiling and never overflows", () => {
    expect(authPauseMs(50)).toBe(FORTIOS_AUTH_PAUSE_MAX_MS);
    expect(authPauseMs(10_000)).toBe(FORTIOS_AUTH_PAUSE_MAX_MS);
    expect(authPauseMs(0)).toBe(FORTIOS_AUTH_PAUSE_BASE_MS);
  });
});

describe("fortiosGateKey", () => {
  it("is host:port, case-insensitive on the host", () => {
    expect(fortiosGateKey(" FGT-A.example.internal ", 443)).toBe("fgt-a.example.internal:443");
    expect(fortiosGateKey("10.0.0.1", 8443)).toBe("10.0.0.1:8443");
  });
});

describe("recordFortiosAuthResult", () => {
  const key = "10.0.0.1:443";
  it("a 401 opens a pause; a second consecutive 401 doubles it", () => {
    expect(recordFortiosAuthResult(key, 401, 1_000)).toBe(FORTIOS_AUTH_PAUSE_BASE_MS);
    expect(authPauseRemainingMs(key, 1_000)).toBe(FORTIOS_AUTH_PAUSE_BASE_MS);
    expect(recordFortiosAuthResult(key, 401, 2_000)).toBe(2 * FORTIOS_AUTH_PAUSE_BASE_MS);
    expect(consecutive401sFor(key)).toBe(2);
    expect(authPauseRemainingMs(key, 2_000 + 2 * FORTIOS_AUTH_PAUSE_BASE_MS)).toBe(0);
  });
  it("any other HTTP answer ends the run and the pause", () => {
    recordFortiosAuthResult(key, 401, 0);
    expect(recordFortiosAuthResult(key, 403, 10)).toBe(0);
    expect(authPauseRemainingMs(key, 10)).toBe(0);
    expect(consecutive401sFor(key)).toBe(0);
    // The next 401 starts over at the base pause.
    expect(recordFortiosAuthResult(key, 401, 20)).toBe(FORTIOS_AUTH_PAUSE_BASE_MS);
  });
  it("pauses one gate without touching another", () => {
    recordFortiosAuthResult(key, 401, 0);
    expect(authPauseRemainingMs("10.0.0.2:443", 0)).toBe(0);
  });
});

describe("withFortiosGateSlot", () => {
  /** A task that stays in flight until released, recording peak concurrency. */
  function harness() {
    let inFlight = 0;
    let peak = 0;
    const releases: Array<() => void> = [];
    const task = () => new Promise<string>((resolve) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      releases.push(() => { inFlight--; resolve("done"); });
    });
    return { task, releases, peak: () => peak, inFlight: () => inFlight };
  }

  it("never runs more than the limit at once, and runs the rest FIFO", async () => {
    const h = harness();
    const key = "gate:443";
    const runs = Array.from({ length: 7 }, () => withFortiosGateSlot(key, h.task, { limit: 2 }));
    await Promise.resolve();
    expect(h.inFlight()).toBe(2);
    while (h.releases.length) {
      h.releases.shift()!();
      await new Promise((r) => setTimeout(r, 0));
    }
    await expect(Promise.all(runs)).resolves.toHaveLength(7);
    expect(h.peak()).toBe(2);
  });

  it("frees the slot when the task throws", async () => {
    const key = "gate:443";
    await expect(withFortiosGateSlot(key, async () => { throw new Error("boom"); }, { limit: 1 })).rejects.toThrow("boom");
    await expect(withFortiosGateSlot(key, async () => "next", { limit: 1 })).resolves.toBe("next");
  });

  it("gives up without running when the wait exceeds its budget", async () => {
    const h = harness();
    const key = "gate:443";
    const first = withFortiosGateSlot(key, h.task, { limit: 1 });
    const ran = vi.fn(async () => "ran");
    await expect(withFortiosGateSlot(key, ran, { limit: 1, maxWaitMs: 10 })).rejects.toBeInstanceOf(FortiosGateBusyError);
    expect(ran).not.toHaveBeenCalled();
    h.releases.shift()!();
    await first;
    // The abandoned waiter left no ghost behind: the slot is free again.
    await expect(withFortiosGateSlot(key, async () => "free", { limit: 1, maxWaitMs: 10 })).resolves.toBe("free");
  });

  it("gives up without running when the caller aborts while queued", async () => {
    const h = harness();
    const key = "gate:443";
    const first = withFortiosGateSlot(key, h.task, { limit: 1 });
    const ac = new AbortController();
    const ran = vi.fn(async () => "ran");
    const queued = withFortiosGateSlot(key, ran, { limit: 1, signal: ac.signal });
    ac.abort();
    await expect(queued).rejects.toBeTruthy();
    expect(ran).not.toHaveBeenCalled();
    h.releases.shift()!();
    await first;
  });
});

describe("fgRequest pacing", () => {
  const config = { host: "10.9.9.9", port: 443, apiUser: "", apiToken: "tok", verifySsl: false };

  it("after a 401, refuses further requests without sending them", async () => {
    const { fgRequest, FortiosAuthPausedError } = await import("../../src/services/fortigateService.js");
    const fetchMock = vi.fn(async () => ({ status: 401, ok: false, json: async () => ({}), text: async () => "" }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fgRequest(config as any, "GET", "/api/v2/monitor/system/status")).rejects.toThrow(/HTTP 401/);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const second = fgRequest(config as any, "GET", "/api/v2/monitor/system/status");
    await expect(second).rejects.toBeInstanceOf(FortiosAuthPausedError);
    await expect(fgRequest(config as any, "GET", "/api/v2/monitor/system/status"))
      .rejects.toThrow(/Authentication failed \(HTTP 401\) for 10\.9\.9\.9:443 — Polaris has paused/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not send requests that were already queued when the 401 arrived", async () => {
    const { fgRequest } = await import("../../src/services/fortigateService.js");
    const pending: Array<(v: unknown) => void> = [];
    const fetchMock = vi.fn(() => new Promise((r) => { pending.push(r); }));
    vi.stubGlobal("fetch", fetchMock);
    const unauthorized = { status: 401, ok: false, json: async () => ({}), text: async () => "" };

    // Default cap is 2: two requests take the slots (this is the "burst" a
    // monitor pass fires), three more queue behind them.
    const burst = Array.from({ length: 5 }, () =>
      fgRequest(config as any, "GET", "/api/v2/monitor/system/status").catch((e: Error) => e),
    );
    await new Promise((r) => setTimeout(r, 0));
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // The gate rejects both in-flight requests. Without pacing all five would
    // have hit http_authd — over FortiOS's threshold of 3 in one instant.
    pending.shift()!(unauthorized);
    await new Promise((r) => setTimeout(r, 0));
    pending.shift()!(unauthorized);
    const results = await Promise.all(burst);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const refused = results.filter((r) => r instanceof Error && /paused/.test((r as Error).message)).length;
    expect(refused).toBe(3);
  });
});
