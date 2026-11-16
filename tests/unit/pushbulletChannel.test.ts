/**
 * tests/unit/pushbulletChannel.test.ts — Pushbullet "note" delivery
 * (CQ-T010). The Pushbullet API is the global fetch, stubbed.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { sendPushbullet } from "../../src/services/notificationChannels/pushbulletChannel.js";
import { AppError } from "../../src/utils/errors.js";

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("sendPushbullet", () => {
  it("refuses a channel with no access token as a 400 before any request", async () => {
    const err = await sendPushbullet({ accessToken: "" }, { title: "t", body: "b" }).catch((e) => e);
    expect(err).toBeInstanceOf(AppError);
    expect(err).toMatchObject({ httpStatus: 400, message: /access token/ });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("POSTs a note push with the token header", async () => {
    await sendPushbullet({ accessToken: "o.abc" }, { title: "sw-01 down", body: "No response" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.pushbullet.com/v2/pushes");
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({ "Access-Token": "o.abc", "Content-Type": "application/json" });
    expect(JSON.parse(String(init.body))).toEqual({ type: "note", title: "sw-01 down", body: "No response" });
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("reports the API's error.message (first line) as a 502", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ error: { message: "Access token is invalid\nsee docs" } }), { status: 401 }));
    const err = await sendPushbullet({ accessToken: "bad" }, { title: "t", body: "b" }).catch((e) => e);
    expect(err).toBeInstanceOf(AppError);
    expect(err).toMatchObject({ httpStatus: 502, message: "Pushbullet push failed: Access token is invalid" });
  });

  it("falls back to the HTTP status for a non-JSON or message-less error", async () => {
    fetchMock.mockResolvedValueOnce(new Response("<html>", { status: 503 }));
    await expect(sendPushbullet({ accessToken: "x" }, { title: "t", body: "b" })).rejects.toMatchObject({ message: "Pushbullet push failed: HTTP 503" });
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: {} }), { status: 429 }));
    await expect(sendPushbullet({ accessToken: "x" }, { title: "t", body: "b" })).rejects.toMatchObject({ message: "Pushbullet push failed: HTTP 429" });
  });

  // Was a bug until 2026-11-14: sendPushbullet does not catch a transport failure. With
  // api.pushbullet.com unreachable, fetch rejects with TypeError("fetch
  // failed") and the channel Test route answers 500 "Internal server error"
  // with no reason. It should reject with an AppError (502), as its own non-2xx
  // path and sendSmtpEmail do.
  it("a network failure surfaces as a 502 AppError", async () => {
    fetchMock.mockRejectedValue(new TypeError("fetch failed"));
    const err = await sendPushbullet({ accessToken: "x" }, { title: "t", body: "b" }).catch((e) => e);
    expect(err).toBeInstanceOf(AppError);
    expect(err.httpStatus).toBe(502);
  });
});
