/**
 * tests/unit/rebootOptIn.test.ts — the three opt-ins behind a reboot
 * (business rule 115), as far as they are pure:
 *
 *  - a stored credential's `allowReboot`: only on the kinds that can reboot
 *    (SSH, REST API token, device admin login), refused on the rest, dropped
 *    with the login when an http credential leaves form mode, never stored
 *    as `false`;
 *  - the agent host's permission scripts: the root-owned marker the agent
 *    requires, BOTH polkit dialects on Linux, quoted heredocs, removal of all
 *    three on disable and on uninstall, and an Administrators/SYSTEM-only
 *    marker on Windows;
 *  - the `device-reboot` hold kind and its cap.
 */

import { describe, it, expect, vi } from "vitest";

vi.mock("../../src/db.js", () => ({ prisma: {} }));

import { validateConfig, credentialAllowsReboot, credentialCanReboot } from "../../src/services/credentialService.js";
import {
  linuxRebootPermissionScript,
  windowsRebootPermissionPs,
  polkitJsRule,
  polkitPkla,
  LINUX_REBOOT_MARKER,
  LINUX_POLKIT_RULE,
  LINUX_POLKIT_PKLA,
  LINUX_REBOOT_PERMISSION_CLEANUP,
  LOGIND_REBOOT_ACTIONS,
} from "../../src/utils/agentRebootPermission.js";
import { MAINTENANCE_HOLD_KINDS, holdTtlMinutes } from "../../src/services/maintenanceScheduleService.js";
import { parseJoinTime } from "../../src/services/rebootTransports.js";

describe("allowReboot on a stored credential", () => {
  const ssh = () => ({ username: "admin", password: "pw" });
  it("is accepted on SSH, REST API and device-login credentials", () => {
    const s = { ...ssh(), allowReboot: true };
    validateConfig("ssh", s);
    expect(s.allowReboot).toBe(true);
    const r = { baseUrl: "https://gate", apiToken: "t", allowReboot: true };
    validateConfig("restapi", r);
    expect(r.allowReboot).toBe(true);
    const f = { authMode: "form", username: "a", password: "p", allowReboot: true };
    validateConfig("http", f);
    expect(f.allowReboot).toBe(true);
  });

  it("is refused on SNMP and WinRM, which can never reboot anything", () => {
    expect(() => validateConfig("winrm", { username: "a", password: "p", allowReboot: true })).toThrow(/cannot reboot/);
    expect(() => validateConfig("snmp", { version: "v2c", community: "c", allowReboot: true })).toThrow(/cannot reboot/);
  });

  it("goes with the login when an http credential leaves form mode", () => {
    const b = { authMode: "bearer", apiToken: "t", allowReboot: true } as Record<string, unknown>;
    validateConfig("http", b);
    expect(b.allowReboot).toBeUndefined();
  });

  it("is not stored when false, and must be a boolean", () => {
    const s = { ...ssh(), allowReboot: false } as Record<string, unknown>;
    validateConfig("ssh", s);
    expect("allowReboot" in s).toBe(false);
    expect(() => validateConfig("ssh", { ...ssh(), allowReboot: "yes" })).toThrow(/boolean/);
  });

  it("credentialAllowsReboot needs both the kind and the flag", () => {
    expect(credentialAllowsReboot("ssh", { allowReboot: true })).toBe(true);
    expect(credentialAllowsReboot("ssh", {})).toBe(false);
    expect(credentialAllowsReboot("http", { authMode: "basic", allowReboot: true })).toBe(false);
    expect(credentialCanReboot("winrm", {})).toBe(false);
  });
});

describe("the agent host's reboot permission", () => {
  it("installs the marker and BOTH polkit dialects, with quoted heredocs", () => {
    const s = linuxRebootPermissionScript(true);
    expect(s).toContain(LINUX_REBOOT_MARKER);
    expect(s).toContain(LINUX_POLKIT_RULE);
    expect(s).toContain(LINUX_POLKIT_PKLA);
    expect(s).toContain("<<'POLARIS_EOF'");
    expect(s).toMatch(/chown root:root \/etc\/polaris-agent-reboot\.enabled/);
    // Refuses rather than half-installs on a host without logind or polkit.
    expect(s).toMatch(/systemd \(logind\) is required/);
    expect(s).toMatch(/polkit is not installed/);
  });

  it("grants only the logind reboot actions, to the agent's user or unit", () => {
    const js = polkitJsRule();
    for (const a of LOGIND_REBOOT_ACTIONS) expect(js).toContain(`"${a}"`);
    expect(js).toContain('subject.user == "polaris-agent"');
    expect(js).toContain('subject.system_unit == "polaris-agent.service"');
    expect(js).not.toMatch(/power-off|halt|suspend/);
    expect(polkitPkla()).toContain("Identity=unix-user:polaris-agent");
  });

  it("removes all three on disable and on uninstall", () => {
    const off = linuxRebootPermissionScript(false);
    for (const p of [LINUX_REBOOT_MARKER, LINUX_POLKIT_RULE, LINUX_POLKIT_PKLA]) {
      expect(off).toContain(p);
      expect(LINUX_REBOOT_PERMISSION_CLEANUP).toContain(p);
    }
  });

  it("writes an Administrators/SYSTEM-only marker on Windows, inside the conf dir the uninstaller removes", () => {
    const on = windowsRebootPermissionPs(true);
    expect(on).toContain("Polaris\\agent\\reboot.enabled");
    expect(on).toContain("S-1-5-32-544");
    expect(on).toContain("S-1-5-18");
    expect(on).toContain("SetAccessRuleProtection($true, $false)");
    expect(windowsRebootPermissionPs(false)).toMatch(/Remove-Item -Force -LiteralPath \$marker/);
  });
});

describe("a controller join time (the proof a managed switch or AP restarted)", () => {
  it("reads a managed switch's date string and an AP's epoch seconds, as seen on FortiOS 7.6.7", () => {
    expect(parseJoinTime("Fri Sep  4 07:26:15 2026")).toBe(Date.parse("Fri Sep 4 07:26:15 2026"));
    expect(parseJoinTime(1791900121)).toBe(1791900121000);
    expect(parseJoinTime(1791900121000)).toBe(1791900121000);
    expect(parseJoinTime("")).toBeNull();
    expect(parseJoinTime("not a date")).toBeNull();
    expect(parseJoinTime(undefined)).toBeNull();
  });
});

describe("the device-reboot hold", () => {
  it("is a known kind with a 20-minute cap", () => {
    expect(MAINTENANCE_HOLD_KINDS["device-reboot"]).toBe("Reboot");
    expect(holdTtlMinutes("device-reboot")).toBe(20);
  });
});
