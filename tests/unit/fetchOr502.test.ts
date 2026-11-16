/**
 * tests/unit/fetchOr502.test.ts — a request that never got a response becomes
 * a 502 AppError with its reason; a response of any status is returned as is.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { fetchOr502 } from "../../src/utils/fetchOr502.js";
import { AppError } from "../../src/utils/errors.js";

afterEach(() => { vi.unstubAllGlobals(); });

describe("fetchOr502", () => {
  it("returns any response untouched, a non-2xx included", async () => {
    const res = new Response("nope", { status: 503 });
    vi.stubGlobal("fetch", vi.fn(async () => res));
    expect(await fetchOr502("X", "https://x.example")).toBe(res);
  });

  it("passes the url and init through", async () => {
    const f = vi.fn(async () => new Response("ok"));
    vi.stubGlobal("fetch", f);
    await fetchOr502("X", "https://x.example/a", { method: "POST" });
    expect(f).toHaveBeenCalledWith("https://x.example/a", { method: "POST" });
  });

  it("a network failure is a 502 naming the call and the cause's code", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ENOTFOUND" } }); }));
    const err = await fetchOr502("Pushbullet push", "https://x.example").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).httpStatus).toBe(502);
    expect((err as AppError).message).toBe("Pushbullet push failed: ENOTFOUND");
  });

  it("an abort reads as a timeout", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw Object.assign(new Error("aborted"), { name: "AbortError" }); }));
    await expect(fetchOr502("X", "https://x.example")).rejects.toMatchObject({ httpStatus: 502, message: "X failed: timed out" });
  });

  it("falls back to the message, keeps one line, and rethrows an AppError as is", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("socket hang up\nmore"); }));
    await expect(fetchOr502("X", "u")).rejects.toMatchObject({ message: "X failed: socket hang up" });
    const own = new AppError(400, "mine");
    vi.stubGlobal("fetch", vi.fn(async () => { throw own; }));
    await expect(fetchOr502("X", "u")).rejects.toBe(own);
  });
});
