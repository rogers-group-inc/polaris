/**
 * tests/unit/runCookieJar.test.ts — business rule 85(b): the cookies one
 * path-check run keeps across its redirect hops (host-only, Path / Secure /
 * Max-Age / Expires honoured).
 */

import { describe, it, expect } from "vitest";
import { RunCookieJar } from "../../src/utils/runCookieJar.js";

const NOW = Date.UTC(2026, 10, 13, 12, 0, 0);
const U = (s: string) => new URL(s);

describe("RunCookieJar", () => {
  it("returns nothing before anything is set", () => {
    expect(new RunCookieJar().header(U("https://a.example/"), NOW)).toBeNull();
  });
  it("sends a cookie back to the host that set it, Node's array form included", () => {
    const j = new RunCookieJar();
    j.store(U("https://a.example/login"), ["NSC_x=1; Path=/; HttpOnly", "b=2; Path=/"], NOW);
    expect(j.header(U("https://a.example/app"), NOW)).toBe("NSC_x=1; b=2");
  });
  it("is host-only: ignores Domain and never sends to another host or a sub-domain", () => {
    const j = new RunCookieJar();
    j.store(U("https://a.example/"), "s=1; Domain=example; Path=/", NOW);
    expect(j.header(U("https://b.example/"), NOW)).toBeNull();
    expect(j.header(U("https://x.a.example/"), NOW)).toBeNull();
    expect(j.header(U("https://A.EXAMPLE/"), NOW)).toBe("s=1");
  });
  it("matches paths per RFC 6265 and defaults to the request's directory", () => {
    const j = new RunCookieJar();
    j.store(U("http://a.example/app/login"), "d=1", NOW); // default path /app
    j.store(U("http://a.example/"), "p=2; Path=/api", NOW);
    expect(j.header(U("http://a.example/app/x"), NOW)).toBe("d=1");
    expect(j.header(U("http://a.example/apple"), NOW)).toBeNull();
    expect(j.header(U("http://a.example/api/v1"), NOW)).toBe("p=2");
  });
  it("puts longer paths first", () => {
    const j = new RunCookieJar();
    j.store(U("http://a.example/"), "root=1; Path=/", NOW);
    j.store(U("http://a.example/"), "deep=2; Path=/a/b", NOW);
    expect(j.header(U("http://a.example/a/b/c"), NOW)).toBe("deep=2; root=1");
  });
  it("keeps a Secure cookie off plain HTTP", () => {
    const j = new RunCookieJar();
    j.store(U("https://a.example/"), "s=1; Secure; Path=/", NOW);
    expect(j.header(U("http://a.example/"), NOW)).toBeNull();
    expect(j.header(U("https://a.example/"), NOW)).toBe("s=1");
  });
  it("honours expiry: Max-Age over Expires, and a past date deletes", () => {
    const j = new RunCookieJar();
    j.store(U("https://a.example/"), "a=1; Path=/; Max-Age=60; Expires=Thu, 01 Jan 1970 00:00:00 GMT", NOW);
    expect(j.header(U("https://a.example/"), NOW)).toBe("a=1");
    expect(j.header(U("https://a.example/"), NOW + 61_000)).toBeNull();
    j.store(U("https://a.example/"), "b=2; Path=/", NOW);
    j.store(U("https://a.example/"), "b=; Path=/; Max-Age=0", NOW);
    expect(j.header(U("https://a.example/"), NOW)).toBe("a=1");
  });
  it("replaces a cookie of the same name and path, and skips one with no name", () => {
    const j = new RunCookieJar();
    j.store(U("https://a.example/"), ["t=1; Path=/", "=bad", "noequals"], NOW);
    j.store(U("https://a.example/"), "t=2; Path=/", NOW);
    expect(j.header(U("https://a.example/"), NOW)).toBe("t=2");
  });
  it("ignores an empty header", () => {
    const j = new RunCookieJar();
    j.store(U("https://a.example/"), undefined, NOW);
    expect(j.header(U("https://a.example/"), NOW)).toBeNull();
  });
});
