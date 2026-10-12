/**
 * tests/unit/routePath.test.ts
 *
 * Express routes case-insensitively and ignores a trailing slash, so a gate that
 * compares req.path to exact lowercase strings is skipped by a different
 * spelling of the same route (scan finding F166; business rule 108).
 */

import { describe, it, expect } from "vitest";
import { canonicalRoutePath } from "../../src/utils/routePath.js";

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

  it("does not collapse distinct paths", () => {
    expect(canonicalRoutePath("/api/v1/auth/login/totp")).toBe("/api/v1/auth/login/totp");
    expect(canonicalRoutePath("/api/v1")).not.toBe(canonicalRoutePath("/api"));
  });
});
