/**
 * tests/unit/proxyMode.test.ts
 *
 * Asserts isProxyMode() reads env on EVERY call (no module-load caching).
 * That contract is load-bearing for Vitest test isolation, future runtime
 * config reloads, and CLI tooling that boots in arbitrary order.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isProxyMode, proxyCertPath } from "../../src/utils/proxyMode.js";

describe("isProxyMode", () => {
  const saved = process.env.POLARIS_PROXY_CERT_PATH;

  beforeEach(() => {
    delete process.env.POLARIS_PROXY_CERT_PATH;
  });

  afterEach(() => {
    if (saved === undefined) delete process.env.POLARIS_PROXY_CERT_PATH;
    else process.env.POLARIS_PROXY_CERT_PATH = saved;
  });

  it("returns false when POLARIS_PROXY_CERT_PATH is unset", () => {
    expect(isProxyMode()).toBe(false);
  });

  it("returns false when POLARIS_PROXY_CERT_PATH is empty string", () => {
    process.env.POLARIS_PROXY_CERT_PATH = "";
    expect(isProxyMode()).toBe(false);
  });

  it("returns true when POLARIS_PROXY_CERT_PATH is set to any non-empty value", () => {
    process.env.POLARIS_PROXY_CERT_PATH = "/etc/polaris-nginx/cert.pem";
    expect(isProxyMode()).toBe(true);
  });

  it("re-reads env on every call (no caching)", () => {
    expect(isProxyMode()).toBe(false);
    process.env.POLARIS_PROXY_CERT_PATH = "/tmp/x";
    expect(isProxyMode()).toBe(true);
    delete process.env.POLARIS_PROXY_CERT_PATH;
    expect(isProxyMode()).toBe(false);
  });
});

describe("proxyCertPath", () => {
  const saved = process.env.POLARIS_PROXY_CERT_PATH;
  afterEach(() => {
    if (saved === undefined) delete process.env.POLARIS_PROXY_CERT_PATH;
    else process.env.POLARIS_PROXY_CERT_PATH = saved;
  });

  it("is null when unset or empty, the path otherwise — and agrees with isProxyMode", () => {
    delete process.env.POLARIS_PROXY_CERT_PATH;
    expect(proxyCertPath()).toBeNull();
    expect(isProxyMode()).toBe(false);
    process.env.POLARIS_PROXY_CERT_PATH = "";
    expect(proxyCertPath()).toBeNull();
    expect(isProxyMode()).toBe(false);
    process.env.POLARIS_PROXY_CERT_PATH = "/etc/polaris-nginx/cert.pem";
    expect(proxyCertPath()).toBe("/etc/polaris-nginx/cert.pem");
    expect(isProxyMode()).toBe(true);
  });
});
