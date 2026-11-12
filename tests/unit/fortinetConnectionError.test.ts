/**
 * tests/unit/fortinetConnectionError.test.ts
 *
 * The shared FortiGate / FortiManager "never got an answer" message mapping
 * (CQ-B034). Null for anything that is not a connection failure, so the
 * caller's own handling runs.
 */

import { describe, it, expect } from "vitest";
import { fortinetConnectionErrorMessage } from "../../src/utils/fortinetConnectionError.js";

const fetchFailed = (cause: Record<string, unknown>) => Object.assign(new TypeError("fetch failed"), { cause });

describe("fortinetConnectionErrorMessage", () => {
  it("maps ECONNREFUSED with the port, defaulting to 443", () => {
    expect(fortinetConnectionErrorMessage(fetchFailed({ code: "ECONNREFUSED" }), "fw1", 8443)).toBe("Connection refused — fw1:8443");
    expect(fortinetConnectionErrorMessage(fetchFailed({ code: "ECONNREFUSED" }), "fw1", undefined)).toBe("Connection refused — fw1:443");
    expect(fortinetConnectionErrorMessage(fetchFailed({ code: "ECONNREFUSED" }), "fw1", 0)).toBe("Connection refused — fw1:443");
  });

  it("maps ENOTFOUND without a port", () => {
    expect(fortinetConnectionErrorMessage(fetchFailed({ code: "ENOTFOUND" }), "nope.local", 443)).toBe("Host not found — nope.local");
  });

  it("maps ETIMEDOUT and an AbortSignal.timeout TimeoutError", () => {
    expect(fortinetConnectionErrorMessage(fetchFailed({ code: "ETIMEDOUT" }), "h", 10443)).toBe("Connection timed out — h:10443");
    const t = Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
    expect(fortinetConnectionErrorMessage(t, "h", undefined)).toBe("Connection timed out — h:443");
  });

  it.each(["UNABLE_TO_VERIFY_LEAF_SIGNATURE", "DEPTH_ZERO_SELF_SIGNED_CERT", "CERT_HAS_EXPIRED", "ERR_TLS_CERT_ALTNAME_INVALID"])(
    "points at SSL verification for TLS code %s",
    (code) => {
      expect(fortinetConnectionErrorMessage(fetchFailed({ code }), "h", 443))
        .toBe(`TLS certificate error (${code}) — try disabling SSL verification`);
    },
  );

  it("surfaces the cause message for another fetch failure, else the outer message", () => {
    expect(fortinetConnectionErrorMessage(fetchFailed({ code: "ECONNRESET", message: "socket hang up" }), "h", 443)).toBe("socket hang up");
    expect(fortinetConnectionErrorMessage(fetchFailed({ code: "EPIPE" }), "h", 443)).toBe("fetch failed");
  });

  it("returns null for anything that is not a connection failure", () => {
    expect(fortinetConnectionErrorMessage(new Error("HTTP 401"), "h", 443)).toBeNull();
    expect(fortinetConnectionErrorMessage(new TypeError("fetch failed"), "h", 443)).toBeNull();
    expect(fortinetConnectionErrorMessage(null, "h", 443)).toBeNull();
    expect(fortinetConnectionErrorMessage(undefined, "h", 443)).toBeNull();
  });
});
