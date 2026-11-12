/**
 * tests/unit/agentRebootPermission.test.ts
 *
 * Business rule 115, host-side scripts. rebootOptIn.test.ts covers the Linux
 * polkit dialects and the Windows marker ACL; this pins what it does not: the
 * macOS script, the polkit rule matching by user AND unit, the exact logind
 * actions, and idempotent / non-expanding shapes.
 */

import { describe, it, expect } from "vitest";
import {
  darwinRebootPermissionScript,
  linuxRebootPermissionScript,
  windowsRebootPermissionPs,
  polkitJsRule,
  polkitPkla,
  LOGIND_REBOOT_ACTIONS,
  LINUX_REBOOT_MARKER,
  LINUX_POLKIT_RULE,
  LINUX_POLKIT_PKLA,
  LINUX_REBOOT_PERMISSION_CLEANUP,
} from "../../src/utils/agentRebootPermission.js";

describe("darwinRebootPermissionScript", () => {
  it("enable writes the root-owned marker under /etc/polaris-agent", () => {
    const s = darwinRebootPermissionScript(true);
    expect(s.startsWith("#!/usr/bin/env bash\nset -euo pipefail\n")).toBe(true);
    expect(s).toContain("install -d -m 0755 /etc/polaris-agent");
    expect(s).toContain("> /etc/polaris-agent/reboot.enabled");
    expect(s).toContain("chmod 0644 /etc/polaris-agent/reboot.enabled");
    expect(s).not.toContain("polkit");
  });

  it("disable removes only the marker, idempotently (rm -f)", () => {
    const s = darwinRebootPermissionScript(false);
    expect(s).toContain("rm -f /etc/polaris-agent/reboot.enabled");
    expect(s).not.toContain("install -d");
  });
});

describe("polkit content", () => {
  it("lists exactly the three logind reboot actions", () => {
    expect([...LOGIND_REBOOT_ACTIONS]).toEqual([
      "org.freedesktop.login1.reboot",
      "org.freedesktop.login1.reboot-multiple-sessions",
      "org.freedesktop.login1.reboot-ignore-inhibit",
    ]);
  });

  it("the JS rule grants every action to the agent user OR its unit, and nothing else", () => {
    const r = polkitJsRule();
    for (const a of LOGIND_REBOOT_ACTIONS) expect(r).toContain(`action.id == "${a}"`);
    expect(r).toContain('subject.user == "polaris-agent"');
    expect(r).toContain('subject.system_unit == "polaris-agent.service"');
    expect(r.match(/polkit\.Result\.YES/g)).toHaveLength(1);
    expect(r).not.toContain("power-off");
  });

  it("the pkla joins the actions with semicolons", () => {
    expect(polkitPkla()).toContain(`Action=${LOGIND_REBOOT_ACTIONS.join(";")}\n`);
    expect(polkitPkla()).toContain("Identity=unix-user:polaris-agent");
  });
});

describe("linuxRebootPermissionScript", () => {
  it("enable fails clearly without systemd or polkit (exit 3 / 4) before writing anything", () => {
    const s = linuxRebootPermissionScript(true);
    const exit3 = s.indexOf("exit 3");
    const exit4 = s.indexOf("exit 4");
    const firstWrite = s.indexOf(`cat > ${LINUX_POLKIT_RULE}`);
    expect(exit3).toBeGreaterThan(0);
    expect(exit4).toBeGreaterThan(exit3);
    expect(firstWrite).toBeGreaterThan(exit4);
  });

  it("writes atomically via .tmp + mv -f", () => {
    const s = linuxRebootPermissionScript(true);
    expect(s).toContain(`mv -f ${LINUX_POLKIT_RULE}.tmp ${LINUX_POLKIT_RULE}`);
    expect(s).toContain(`mv -f ${LINUX_POLKIT_PKLA}.tmp ${LINUX_POLKIT_PKLA}`);
    expect(s).toContain(`> ${LINUX_REBOOT_MARKER}`);
  });

  it("disable and the uninstall cleanup remove the same three files", () => {
    expect(linuxRebootPermissionScript(false)).toContain(LINUX_REBOOT_PERMISSION_CLEANUP);
    expect(LINUX_REBOOT_PERMISSION_CLEANUP).toBe(`rm -f ${LINUX_REBOOT_MARKER} ${LINUX_POLKIT_RULE} ${LINUX_POLKIT_PKLA}`);
  });
});

describe("windowsRebootPermissionPs", () => {
  it("both directions stop on error and exit 0 on success", () => {
    for (const enable of [true, false]) {
      const s = windowsRebootPermissionPs(enable);
      expect(s.startsWith("$ErrorActionPreference = 'Stop'")).toBe(true);
      expect(s.trimEnd().endsWith("exit 0")).toBe(true);
      expect(s).toContain("Join-Path $env:ProgramData 'Polaris\\agent\\reboot.enabled'");
    }
  });
});
