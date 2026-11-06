/**
 * tests/unit/endpointTokens.test.ts — the /health and /metrics bearer gates'
 * token readers and comparison (utils/endpointTokens.ts, CQ-B042).
 */

import { describe, it, expect, afterEach } from "vitest";
import { bearerSatisfies, healthToken, metricsToken } from "../../src/utils/endpointTokens.js";

const saved = { h: process.env.HEALTH_TOKEN, m: process.env.METRICS_TOKEN };
afterEach(() => {
  if (saved.h === undefined) delete process.env.HEALTH_TOKEN; else process.env.HEALTH_TOKEN = saved.h;
  if (saved.m === undefined) delete process.env.METRICS_TOKEN; else process.env.METRICS_TOKEN = saved.m;
});

describe("healthToken / metricsToken", () => {
  it("are null when unset, empty or whitespace-only", () => {
    delete process.env.HEALTH_TOKEN;
    expect(healthToken()).toBeNull();
    process.env.HEALTH_TOKEN = "";
    expect(healthToken()).toBeNull();
    process.env.METRICS_TOKEN = "   \n";
    expect(metricsToken()).toBeNull();
  });

  it("trim surrounding whitespace and re-read on every call", () => {
    process.env.METRICS_TOKEN = "  abc123 ";
    expect(metricsToken()).toBe("abc123");
    process.env.METRICS_TOKEN = "def456";
    expect(metricsToken()).toBe("def456");
  });
});

describe("bearerSatisfies", () => {
  it("is open when no token is expected", () => {
    expect(bearerSatisfies(undefined, null)).toBe(true);
    expect(bearerSatisfies("Bearer anything", null)).toBe(true);
  });

  it("accepts exactly `Bearer <token>`", () => {
    expect(bearerSatisfies("Bearer s3cret", "s3cret")).toBe(true);
  });

  it("refuses a missing header, another scheme, a wrong or partial token", () => {
    expect(bearerSatisfies(undefined, "s3cret")).toBe(false);
    expect(bearerSatisfies("", "s3cret")).toBe(false);
    expect(bearerSatisfies("Basic s3cret", "s3cret")).toBe(false);
    expect(bearerSatisfies("Bearer s3cre", "s3cret")).toBe(false);
    expect(bearerSatisfies("Bearer s3cretX", "s3cret")).toBe(false);
    expect(bearerSatisfies("bearer s3cret", "s3cret")).toBe(false);
  });

  it("a padded configured token now matches a client sending the token itself", () => {
    process.env.METRICS_TOKEN = " s3cret ";
    expect(bearerSatisfies("Bearer s3cret", metricsToken())).toBe(true);
  });
});
