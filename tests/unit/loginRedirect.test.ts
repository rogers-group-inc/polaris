/**
 * tests/unit/loginRedirect.test.ts
 *
 * The two "where does this login land" carriers. alertAckPage.test.ts covers
 * the cookie flags, Sec-Fetch-Dest gating and the open-redirect reductions;
 * this pins the parser and RelayState edges it does not.
 */

import { describe, it, expect } from "vitest";
import { readCookie, generateRelayState, relayStateTarget, LOGIN_NEXT_COOKIE } from "../../src/utils/loginRedirect.js";

describe("readCookie", () => {
  it("returns null with no header or no match", () => {
    expect(readCookie(undefined, "a")).toBeNull();
    expect(readCookie("", "a")).toBeNull();
    expect(readCookie("b=1; c=2", "a")).toBeNull();
  });

  it("matches the exact name, trimming around it, and decodes the value", () => {
    expect(readCookie(`sid=x;  ${LOGIN_NEXT_COOKIE} = %2Fa%3Fb%3D1 ; z=9`, LOGIN_NEXT_COOKIE)).toBe("/a?b=1");
    expect(readCookie("xpolaris_next=/bad; polaris_next=/good", "polaris_next")).toBe("/good");
  });

  it("keeps '=' inside the value and returns the first occurrence", () => {
    expect(readCookie("a=b=c; a=second", "a")).toBe("b=c");
  });

  it("skips parts with no '='", () => {
    expect(readCookie("flag; a=1", "a")).toBe("1");
  });

  it("returns null for a malformed percent-escape", () => {
    expect(readCookie("a=%E0%A4%A", "a")).toBeNull();
  });
});

describe("generateRelayState", () => {
  it("is a 12-character base64url nonce with no path for the dashboard or nothing", () => {
    for (const p of [undefined, null, "", "/", "https://evil.example/"]) {
      const rs = generateRelayState(p);
      expect(rs).toMatch(/^[A-Za-z0-9_-]{12}$/);
      expect(relayStateTarget(rs)).toBeNull();
    }
  });

  it("carries a safe path beside the nonce", () => {
    const rs = generateRelayState("/alert-ack.html?id=abc");
    expect(rs).toMatch(/^[A-Za-z0-9_-]{12}\.\/alert-ack\.html\?id=abc$/);
    expect(relayStateTarget(rs)).toBe("/alert-ack.html?id=abc");
  });

  it("fits the longest mailed link (uuid + src=push) inside 80 bytes", () => {
    const rs = generateRelayState("/alert-ack.html?id=123e4567-e89b-12d3-a456-426614174000&src=push");
    expect(Buffer.byteLength(rs)).toBeLessThanOrEqual(80);
    expect(rs).toContain(".");
  });

  it("drops (never truncates) a path too long to fit", () => {
    const rs = generateRelayState("/" + "a".repeat(80));
    expect(rs).toMatch(/^[A-Za-z0-9_-]{12}$/);
  });

  it("is random per call", () => {
    expect(generateRelayState()).not.toBe(generateRelayState());
  });
});

describe("relayStateTarget", () => {
  it("is null for a non-string or a bare nonce", () => {
    expect(relayStateTarget(undefined)).toBeNull();
    expect(relayStateTarget(42)).toBeNull();
    expect(relayStateTarget("abcdefghijkl")).toBeNull();
  });

  it("re-reduces the carried path on the way back", () => {
    expect(relayStateTarget("n.//evil.example/x")).toBeNull();
    expect(relayStateTarget("n.https://evil.example/x")).toBeNull();
    expect(relayStateTarget("n./login.html")).toBeNull();
    expect(relayStateTarget("n./assets.html#a.b")).toBe("/assets.html#a.b");
  });
});
