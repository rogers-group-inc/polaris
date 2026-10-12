/**
 * tests/unit/agentServerUrl.test.ts
 *
 * The agent server URL is written into agent.conf and pasted into the
 * PowerShell installer / upgrader Polaris runs on Windows hosts. A quote in it
 * used to close the script's string literal (scan finding F163).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { findUnique } = vi.hoisted(() => ({ findUnique: vi.fn() }));
vi.mock("../../src/db.js", () => ({ prisma: { setting: { findUnique } } }));

import { assertScriptSafeServerUrl, normalizeAgentServerUrl } from "../../src/utils/agentServerUrl.js";
import { inferOwnServerUrl } from "../../src/services/agentInstallService.js";

describe("normalizeAgentServerUrl", () => {
  it.each([
    ["https://polaris.example.com", "https://polaris.example.com"],
    ["https://polaris.example.com/", "https://polaris.example.com"],
    ["HTTPS://Polaris.Example.com:3000", "https://Polaris.Example.com:3000"],
    ["http://10.0.0.5:3000", "http://10.0.0.5:3000"],
    ["https://[fd00::5]:3000", "https://[fd00::5]:3000"],
    ["https://polaris.example.com/polaris", "https://polaris.example.com/polaris"],
    ["  https://polaris.example.com:443  ", "https://polaris.example.com:443"],
  ])("accepts %s", (input, expected) => {
    expect(normalizeAgentServerUrl(input)).toBe(expected);
  });

  it.each([
    "https://example.com/';Start-Process calc;'",
    "https://example.com/’;Start-Process calc;’",
    "https://example.com/`id`",
    "https://example.com/$(id)",
    "https://example.com/a b",
    "https://example.com/\nStart-Process calc",
    "https://example.com\r\nX: y",
    "https://user:pass@example.com",
    "https://example.com?x=1",
    "https://example.com/#frag",
    "https://exa'mple.com",
    "https://example.com:99999",
    "https://example.com:0",
    "ftp://example.com",
    "javascript:alert(1)",
    "//example.com",
    "",
    "https://",
    "https://-bad.example.com",
  ])("refuses %j", (input) => {
    expect(normalizeAgentServerUrl(input)).toBeNull();
  });

  it("refuses a non-string and an over-long value", () => {
    expect(normalizeAgentServerUrl(undefined)).toBeNull();
    expect(normalizeAgentServerUrl({})).toBeNull();
    expect(normalizeAgentServerUrl("https://example.com/" + "a".repeat(600))).toBeNull();
  });
});

describe("assertScriptSafeServerUrl", () => {
  it("returns the canonical form", () => {
    expect(assertScriptSafeServerUrl("https://polaris.example.com:3000/")).toBe("https://polaris.example.com:3000");
  });

  it("throws before a hostile URL can be placed in a script", () => {
    expect(() => assertScriptSafeServerUrl("https://example.com/';Start-Process calc;'")).toThrow(/not allowed/);
  });
});

describe("inferOwnServerUrl", () => {
  const savedEnv = { ...process.env };
  beforeEach(() => {
    findUnique.mockReset();
    delete process.env.POLARIS_PUBLIC_URL;
    process.env.POLARIS_PUBLIC_HOST = "polaris.example.com";
    process.env.PORT = "3000";
  });
  afterEach(() => {
    process.env = { ...savedEnv };
  });

  it("uses a clean stored override", async () => {
    findUnique.mockResolvedValue({ value: { url: "https://agents.example.com:8443/" } });
    expect(await inferOwnServerUrl()).toBe("https://agents.example.com:8443");
  });

  it("skips a stored override that fails the allowlist and falls back to the derived URL", async () => {
    findUnique.mockResolvedValue({ value: { url: "https://example.com/';Start-Process calc;'" } });
    const url = await inferOwnServerUrl();
    expect(url).not.toContain("'");
    expect(normalizeAgentServerUrl(url)).toBe(url);
  });

  it("skips a hostile POLARIS_PUBLIC_URL as well", async () => {
    findUnique.mockResolvedValue(null);
    process.env.POLARIS_PUBLIC_URL = "https://example.com/'; calc; '";
    const url = await inferOwnServerUrl();
    expect(url).not.toContain("'");
  });

  it("never returns a value that fails the allowlist, whatever the host variable holds", async () => {
    findUnique.mockResolvedValue(null);
    process.env.POLARIS_PUBLIC_HOST = "bad host'; calc";
    const url = await inferOwnServerUrl();
    expect(normalizeAgentServerUrl(url)).toBe(url);
  });
});
