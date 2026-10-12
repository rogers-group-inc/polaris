/**
 * tests/unit/sshOnboardingLinuxInjection.test.ts
 *
 * The Linux onboarding script is run as root across a fleet. The Polaris server
 * address used to reach its `# 4. ...` summary comment unquoted, so a value with
 * a line break turned the next line into an executable one (scan finding F174).
 * Shell and PowerShell quoting helpers also had to learn that typographic
 * quotes and control characters are not literal text.
 */

import { describe, it, expect } from "vitest";
import ssh2 from "ssh2";
import {
  buildLinuxOnboardingScript,
  buildWindowsOnboardingScript,
} from "../../src/services/sshOnboardingScript.js";

const PUBLIC_KEY = String(ssh2.utils.generateKeyPairSync("ed25519", { comment: "polaris-agent-deploy" }).public).trim();
const BASE = { publicKey: PUBLIC_KEY, username: "polaris-agent", accountMode: "existing" as const };

describe("buildLinuxOnboardingScript — server address", () => {
  it("builds with a clean address", () => {
    const script = buildLinuxOnboardingScript({ ...BASE, polarisServerIp: "10.0.0.0/24" });
    expect(script).toContain("scopes inbound TCP/22 to 10.0.0.0/24");
  });

  it.each([
    "10.0.0.0/24\n/bin/touch /tmp/owned",
    "10.0.0.0/24\r\nid",
    "10.0.0.0/24 id",
    "::1/64\nid",
  ])("refuses a value that would start a new script line: %j", (polarisServerIp) => {
    expect(() => buildLinuxOnboardingScript({ ...BASE, polarisServerIp })).toThrow();
  });

  it("never emits a line the operator's value could have started", () => {
    const script = buildLinuxOnboardingScript({ ...BASE, polarisServerIp: "10.0.0.0/24" });
    for (const line of script.split("\n")) {
      expect(line).not.toMatch(/touch \/tmp\/owned/);
    }
  });
});

describe("buildWindowsOnboardingScript — typographic quotes", () => {
  it("builds with a clean address", () => {
    const script = buildWindowsOnboardingScript({ ...BASE, polarisServerIp: "10.0.0.42" });
    expect(script).toContain("'10.0.0.42'");
  });

  it("refuses an address carrying a typographic quote, which PowerShell reads as a quote", () => {
    for (const q of ["‘", "’", "‚", "‛"]) {
      expect(() => buildWindowsOnboardingScript({ ...BASE, polarisServerIp: `10.0.0.42${q}; calc; #` })).toThrow();
    }
  });
});
