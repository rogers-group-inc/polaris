/**
 * tests/unit/routePath.test.ts
 *
 * Express routes case-insensitively and ignores a trailing slash, so a gate that
 * compares req.path to exact lowercase strings is skipped by a different
 * spelling of the same route (scan finding F166; business rule 108).
 */

import { describe, it, expect } from "vitest";
import { canonicalRoutePath, nonCanonicalRequestPath } from "../../src/utils/routePath.js";

describe("canonicalRoutePath", () => {
  it.each([
    ["/api/v1/auth/login", "/api/v1/auth/login"],
    ["/api/v1/auth/login/", "/api/v1/auth/login"],
    ["/api/v1/auth/login//", "/api/v1/auth/login"],
    ["/API/V1/AUTH/LOGIN", "/api/v1/auth/login"],
    ["/Api/v1/Auth/Login/", "/api/v1/auth/login"],
    ["/api.HTML", "/api.html"],
    ["/api/", "/api"],
    ["/LOGIN.html", "/login.html"],
  ])("%s -> %s", (input, expected) => {
    expect(canonicalRoutePath(input)).toBe(expected);
  });

  it("keeps the root path as /", () => {
    expect(canonicalRoutePath("/")).toBe("/");
    expect(canonicalRoutePath("///")).toBe("/");
    expect(canonicalRoutePath("")).toBe("/");
  });

  it("resolves the path the way express.static will (re-scan F87)", () => {
    expect(canonicalRoutePath("/%61pi.html")).toBe("/api.html");
    expect(canonicalRoutePath("//api.html")).toBe("/api.html");
    expect(canonicalRoutePath("/./x/../API.html")).toBe("/api.html");
    expect(canonicalRoutePath("/%6Cogin.html")).toBe("/login.html");
  });

  it("nonCanonicalRequestPath flags every spelling a gate could miss", () => {
    for (const p of ["/%61pi.html", "//api.html", "/./api.html", "/a/../b", "/%zz", "/a//b"]) {
      expect(nonCanonicalRequestPath(p)).toBe(true);
    }
    for (const p of ["/", "/api", "/api.html", "/js/app.js", "/assets/abc123", "/api/v1/assets/search/a%20b"]) {
      expect(nonCanonicalRequestPath(p)).toBe(false);
    }
    // Trailing slashes are the router's business, not a disagreement.
    expect(nonCanonicalRequestPath("/api/v1/auth/login//")).toBe(false);
    expect(nonCanonicalRequestPath("/api.html/")).toBe(false);
    // Under /api/ slashes and dot segments still count.
    expect(nonCanonicalRequestPath("/api/v1//auth/login")).toBe(true);
    expect(nonCanonicalRequestPath("/api/../api.html")).toBe(true);
  });

  it("does not collapse distinct paths", () => {
    expect(canonicalRoutePath("/api/v1/auth/login/totp")).toBe("/api/v1/auth/login/totp");
    expect(canonicalRoutePath("/api/v1")).not.toBe(canonicalRoutePath("/api"));
  });
});
