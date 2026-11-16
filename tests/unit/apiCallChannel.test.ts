/**
 * tests/unit/apiCallChannel.test.ts — the `api_call` automation action's
 * outbound request (CQ-T010). netGuard and guardedFetch are mocked at the
 * module boundary; the real guard is pinned by ssrfOutboundCallers.test.ts.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { assertOutboundHostAllowed, resolveAllowedHost, guardedFetch } = vi.hoisted(() => ({
  assertOutboundHostAllowed: vi.fn(),
  resolveAllowedHost: vi.fn(),
  guardedFetch: vi.fn(),
}));
vi.mock("../../src/utils/netGuard.js", () => ({ assertOutboundHostAllowed, resolveAllowedHost }));
vi.mock("../../src/utils/guardedFetch.js", () => ({ guardedFetch }));

import { sendApiCall } from "../../src/services/notificationChannels/apiCallChannel.js";
import { AppError } from "../../src/utils/errors.js";

const init = () => guardedFetch.mock.calls[0]![1] as RequestInit & { headers: Record<string, string> };

beforeEach(() => {
  assertOutboundHostAllowed.mockReset();
  resolveAllowedHost.mockReset();
  resolveAllowedHost.mockResolvedValue("34.1.2.3");
  guardedFetch.mockReset();
  guardedFetch.mockResolvedValue(new Response("ok", { status: 200 }));
});
afterEach(() => {
  vi.useRealTimers();
});

describe("sendApiCall — guard", () => {
  it("rejects an unparseable URL as a 400 before any guard or request", async () => {
    const err = await sendApiCall({ method: "POST", url: "::nope" }).catch((e) => e);
    expect(err).toBeInstanceOf(AppError);
    expect(err).toMatchObject({ httpStatus: 400, message: "Invalid api_call URL: ::nope" });
    expect(assertOutboundHostAllowed).not.toHaveBeenCalled();
    expect(guardedFetch).not.toHaveBeenCalled();
  });

  it("checks the host literal and its resolution before sending", async () => {
    await sendApiCall({ method: "POST", url: "https://api.example.com/v1/x?y=1" });
    expect(assertOutboundHostAllowed).toHaveBeenCalledWith("api.example.com");
    expect(resolveAllowedHost).toHaveBeenCalledWith("api.example.com");
  });

  it("a blocked host never reaches the network", async () => {
    resolveAllowedHost.mockRejectedValue(Object.assign(new Error("blocked"), { code: "BLOCKED_HOST" }));
    await expect(sendApiCall({ method: "GET", url: "https://meta.example/" })).rejects.toMatchObject({ code: "BLOCKED_HOST" });
    expect(guardedFetch).not.toHaveBeenCalled();
  });
});

describe("sendApiCall — request shape", () => {
  it("upper-cases the method and defaults an empty one to POST", async () => {
    await sendApiCall({ method: "patch", url: "https://api.example.com/" });
    expect(init().method).toBe("PATCH");
    guardedFetch.mockClear();
    await sendApiCall({ method: "", url: "https://api.example.com/" });
    expect(init().method).toBe("POST");
  });

  it("sends with redirects off and an abort signal", async () => {
    await sendApiCall({ method: "POST", url: "https://api.example.com/" });
    expect(init().redirect).toBe("manual");
    expect(init().signal).toBeInstanceOf(AbortSignal);
  });

  it("adds a JSON Content-Type for a body when none was given", async () => {
    await sendApiCall({ method: "POST", url: "https://api.example.com/", body: '{"a":1}', headers: { "X-Key": "k" } });
    expect(init().headers).toEqual({ "X-Key": "k", "Content-Type": "application/json" });
    expect(init().body).toBe('{"a":1}');
  });

  it("keeps an operator's Content-Type whatever its case", async () => {
    await sendApiCall({ method: "PUT", url: "https://api.example.com/", body: "a=1", headers: { "content-type": "application/x-www-form-urlencoded" } });
    expect(init().headers).toEqual({ "content-type": "application/x-www-form-urlencoded" });
  });

  it("does not mutate the spec's headers object", async () => {
    const headers = { Authorization: "Bearer s" };
    await sendApiCall({ method: "POST", url: "https://api.example.com/", body: "{}", headers });
    expect(headers).toEqual({ Authorization: "Bearer s" });
  });

  it("drops a body on GET and adds no Content-Type", async () => {
    await sendApiCall({ method: "get", url: "https://api.example.com/", body: '{"ignored":true}' });
    expect(init()).not.toHaveProperty("body");
    expect(init().headers).toEqual({});
  });

  it("sends no body and no Content-Type when the spec has none", async () => {
    await sendApiCall({ method: "DELETE", url: "https://api.example.com/x" });
    expect(init()).not.toHaveProperty("body");
    expect(init().headers).toEqual({});
  });

  it("sends an empty-string body (defined) with a Content-Type", async () => {
    await sendApiCall({ method: "POST", url: "https://api.example.com/", body: "" });
    expect(init().body).toBe("");
    expect(init().headers["Content-Type"]).toBe("application/json");
  });
});

describe("sendApiCall — timeout clamp", () => {
  async function abortAfter(timeoutSec: number | undefined): Promise<number> {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    guardedFetch.mockImplementation((_u: string, i: RequestInit) => {
      signal = i.signal as AbortSignal;
      return new Promise(() => {}); // never settles; we only watch the abort timer
    });
    void sendApiCall({ method: "GET", url: "https://api.example.com/", ...(timeoutSec === undefined ? {} : { timeoutSec }) });
    await vi.waitFor(() => expect(signal).toBeDefined());
    let ms = 0;
    while (!signal!.aborted && ms < 120_000) {
      vi.advanceTimersByTime(500);
      ms += 500;
    }
    return ms;
  }

  it("defaults to 15 s", async () => {
    expect(await abortAfter(undefined)).toBe(15_000);
  });
  it("clamps above 60 s down to 60 s", async () => {
    expect(await abortAfter(600)).toBe(60_000);
  });
  it("clamps 0 up to 1 s", async () => {
    expect(await abortAfter(0)).toBe(1_000);
  });
  it("honours an in-range value", async () => {
    expect(await abortAfter(5)).toBe(5_000);
  });
});

describe("sendApiCall — result", () => {
  it("returns the 2xx status", async () => {
    guardedFetch.mockResolvedValue(new Response(null, { status: 204 }));
    expect(await sendApiCall({ method: "DELETE", url: "https://api.example.com/x" })).toEqual({ status: 204 });
  });

  it.each([301, 401, 503])("a %i answer is a 502 AppError naming the method", async (status) => {
    guardedFetch.mockResolvedValue(new Response(null, { status }));
    const err = await sendApiCall({ method: "put", url: "https://api.example.com/" }).catch((e) => e);
    expect(err).toBeInstanceOf(AppError);
    expect(err).toMatchObject({ httpStatus: 502, message: `api_call PUT failed: HTTP ${status}` });
  });
});
