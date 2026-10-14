/**
 * tests/unit/trustProxy.test.ts
 *
 * Asserts resolveTrustProxy()'s precedence: operator override > proxy-mode
 * auto-default > unset. And asserts it never mutates process.env.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import express from "express";
import { resolveTrustProxy, resolveClientIp, type TrustProxyFn } from "../../src/utils/trustProxy.js";

/** Express's own compiled predicate for a `trust proxy` value. */
function trustFn(value?: string | number | boolean): TrustProxyFn {
  const app = express();
  if (value !== undefined) app.set("trust proxy", value);
  return app.get("trust proxy fn");
}

describe("resolveTrustProxy", () => {
  const savedTrust = process.env.TRUST_PROXY;
  const savedProxy = process.env.POLARIS_PROXY_CERT_PATH;

  beforeEach(() => {
    delete process.env.TRUST_PROXY;
    delete process.env.POLARIS_PROXY_CERT_PATH;
  });

  afterEach(() => {
    if (savedTrust === undefined) delete process.env.TRUST_PROXY;
    else process.env.TRUST_PROXY = savedTrust;
    if (savedProxy === undefined) delete process.env.POLARIS_PROXY_CERT_PATH;
    else process.env.POLARIS_PROXY_CERT_PATH = savedProxy;
  });

  it("returns undefined when neither var is set", () => {
    expect(resolveTrustProxy()).toBeUndefined();
  });

  it("returns the operator value when TRUST_PROXY is set, regardless of proxy mode", () => {
    process.env.TRUST_PROXY = "10.0.0.0/8";
    expect(resolveTrustProxy()).toBe("10.0.0.0/8");

    process.env.POLARIS_PROXY_CERT_PATH = "/etc/polaris-nginx/cert.pem";
    expect(resolveTrustProxy()).toBe("10.0.0.0/8"); // operator override still wins
  });

  it("returns \"1\" (first-hop) by default in proxy mode", () => {
    process.env.POLARIS_PROXY_CERT_PATH = "/etc/polaris-nginx/cert.pem";
    expect(resolveTrustProxy()).toBe("1");
  });

  it("does NOT mutate process.env", () => {
    process.env.POLARIS_PROXY_CERT_PATH = "/etc/polaris-nginx/cert.pem";
    expect(process.env.TRUST_PROXY).toBeUndefined();
    resolveTrustProxy();
    expect(process.env.TRUST_PROXY).toBeUndefined();
  });
});

// The agent WebSocket upgrade never reaches Express, so it resolves the client
// address itself, and must land where req.ip would (business rule 103(e)).
describe("resolveClientIp", () => {
  it("behind nginx (trust proxy 1) the forwarded client wins over the loopback peer", () => {
    expect(resolveClientIp("127.0.0.1", "10.4.5.6", trustFn(1))).toBe("10.4.5.6");
    expect(resolveClientIp("::ffff:127.0.0.1", "10.4.5.6", trustFn(1))).toBe("10.4.5.6");
  });

  it("trusts only as many hops as configured, so a client-supplied hop is not taken", () => {
    // The client claims 1.2.3.4; nginx appended the real peer 10.4.5.6.
    expect(resolveClientIp("127.0.0.1", "1.2.3.4, 10.4.5.6", trustFn(1))).toBe("10.4.5.6");
  });

  it("with no trust proxy the header is ignored entirely", () => {
    expect(resolveClientIp("10.9.9.9", "10.4.5.6", trustFn())).toBe("10.9.9.9");
    expect(resolveClientIp("10.9.9.9", "10.4.5.6", null)).toBe("10.9.9.9");
  });

  it("a subnet-scoped trust stops at the first untrusted hop", () => {
    expect(resolveClientIp("127.0.0.1", "10.4.5.6", trustFn("loopback"))).toBe("10.4.5.6");
    expect(resolveClientIp("10.0.0.2", "10.4.5.6", trustFn("loopback"))).toBe("10.0.0.2");
  });

  it("no header, an array header, and no socket address", () => {
    expect(resolveClientIp("127.0.0.1", undefined, trustFn(1))).toBe("127.0.0.1");
    expect(resolveClientIp("127.0.0.1", ["10.4.5.6"], trustFn(1))).toBe("10.4.5.6");
    expect(resolveClientIp(undefined, "10.4.5.6", trustFn(1))).toBeNull();
  });
});
