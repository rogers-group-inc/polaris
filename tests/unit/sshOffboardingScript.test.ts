/**
 * tests/unit/sshOffboardingScript.test.ts
 *
 * Business rule 166: what the SSH onboarding script puts on a host, Polaris
 * can also take off it.
 *
 *   - The OFFBOARDING scripts remove the Polaris key(s), the account when the
 *     onboarding script created it, the sudoers drop-in, and the firewall
 *     allowance — and nothing that was not provably Polaris's.
 *   - A ROTATED key is retired, not forgotten: the onboarding script removes
 *     it from the host as it authorizes the new one, and (rule 72) the
 *     detection script sends a host that still authorizes it back to
 *     remediation. With nothing retired every script is byte-for-byte what it
 *     was.
 *
 * The shell key-stripper is also EXECUTED here, against a scratch
 * authorized_keys, wherever bash exists (CI, and Git Bash on a Windows dev
 * machine). The PowerShell twin was run by hand when it was written; it is
 * pinned by text here.
 */

import { describe, it, expect } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildLinuxOffboardingScript,
  buildWindowsOffboardingScript,
  LINUX_ACCOUNT_COMMENT,
} from "../../src/services/sshOffboardingScript.js";
import {
  assertValidRetiredKeys,
  buildLinuxOnboardingScript,
  buildLinuxOnboardingDetectionScript,
  buildWindowsOnboardingScript,
  buildWindowsOnboardingDetectionScript,
  POLARIS_SH_HELPERS,
  POLARIS_SH_STRIP_HELPER,
  WINDOWS_ACCOUNT_DESCRIPTION,
} from "../../src/services/sshOnboardingScript.js";

const CUR = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAICURRENTKEYxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx polaris-agent-deploy";
const OLD = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIRETIREDKEYxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx polaris-agent-deploy";
const OLDER = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOLDERKEYxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx polaris-agent-deploy";
const base = { publicKey: CUR, username: "polaris-agent", accountMode: "create" as const, polarisServerIp: "10.0.0.5" };

const hasBash = spawnSync("bash", ["--version"], { stdio: "ignore" }).status === 0;

describe("assertValidRetiredKeys", () => {
  it("drops the current key and duplicates, comparing on the key body", () => {
    const sameBodyOtherComment = CUR.replace("polaris-agent-deploy", "renamed");
    expect(assertValidRetiredKeys([OLD, sameBodyOtherComment, OLD, OLDER], CUR)).toEqual([OLD, OLDER]);
    expect(assertValidRetiredKeys(undefined, CUR)).toEqual([]);
  });

  it("refuses a malformed retired key rather than emitting it", () => {
    expect(() => assertValidRetiredKeys(["ssh-ed25519 AAAA'; rm -rf / #"], CUR)).toThrow(/well-formed/);
    expect(() => assertValidRetiredKeys(["ssh-ed25519 AAAA\nssh-rsa BBBB"], CUR)).toThrow();
  });
});

describe("rule 166: a rotated key is removed by the next onboarding run", () => {
  it("with nothing retired, all four onboarding scripts are byte-for-byte unchanged", () => {
    const none = { ...base, retiredPublicKeys: [] as string[] };
    expect(buildLinuxOnboardingScript(none)).toBe(buildLinuxOnboardingScript(base));
    expect(buildWindowsOnboardingScript(none)).toBe(buildWindowsOnboardingScript(base));
    expect(buildLinuxOnboardingDetectionScript(none)).toBe(buildLinuxOnboardingDetectionScript(base));
    expect(buildWindowsOnboardingDetectionScript(none)).toBe(buildWindowsOnboardingDetectionScript(base));
    for (const s of [buildLinuxOnboardingScript(base), buildWindowsOnboardingScript(base), buildLinuxOnboardingDetectionScript(base), buildWindowsOnboardingDetectionScript(base)]) {
      expect(s).not.toMatch(/__[A-Z_]+__/);
      expect(s).not.toMatch(/retired/i);
      expect(s).not.toContain("polaris_strip_keys");
      expect(s).not.toContain("Remove-PolarisKeys");
    }
  });

  it("the Linux remediation strips the retired keys after authorizing the current one, before the sudoers step", () => {
    const s = buildLinuxOnboardingScript({ ...base, retiredPublicKeys: [OLD, OLDER] });
    expect(s).not.toMatch(/__[A-Z_]+__/);
    expect(s).toContain(`POLARIS_RETIRED_KEYS=( '${OLD}' '${OLDER}' )`);
    expect(s).toContain("polaris_strip_keys()");
    const authorize = s.indexOf('printf \'%s\\n\' "$POLARIS_PUBLIC_KEY" >> "$AUTH_KEYS"');
    const strip = s.indexOf('polaris_strip_keys "$AUTH_KEYS" "${POLARIS_RETIRED_KEYS[@]}"');
    const sudo = s.indexOf("# --- 3. Passwordless sudo");
    expect(authorize).toBeGreaterThan(0);
    expect(strip).toBeGreaterThan(authorize);
    expect(sudo).toBeGreaterThan(strip);
  });

  it("the Windows remediation strips the retired keys before it re-applies the file's ACL", () => {
    const s = buildWindowsOnboardingScript({ ...base, retiredPublicKeys: [OLD] });
    expect(s).not.toMatch(/__[A-Z_]+__/);
    expect(s).toContain(`$PolarisRetiredKeys = @('${OLD}')`);
    expect(s).toContain("function Remove-PolarisKeys");
    const strip = s.indexOf("Remove-PolarisKeys -Path $authKeys -Keys $PolarisRetiredKeys");
    expect(strip).toBeGreaterThan(s.indexOf("Add-Content -LiteralPath $authKeys"));
    expect(s.indexOf("Set-Acl -LiteralPath $authKeys")).toBeGreaterThan(strip);
  });

  it("rule 72: both detection scripts send a host that still authorizes a retired key back to remediation", () => {
    const lin = buildLinuxOnboardingDetectionScript({ ...base, retiredPublicKeys: [OLD] });
    expect(lin).toContain(`for POLARIS_RETIRED_KEY in '${OLD}'; do`);
    expect(lin).toContain("remediate: a retired Polaris key is still authorized");
    expect(lin.indexOf("a retired Polaris key")).toBeLessThan(lin.indexOf("ok: Polaris SSH onboarding present"));

    const win = buildWindowsOnboardingDetectionScript({ ...base, retiredPublicKeys: [OLD] });
    expect(win).toContain(`foreach ($retiredKey in @('${OLD}')) {`);
    expect(win).toContain("remediate: a retired Polaris key is still authorized");
    expect(win).not.toMatch(/__[A-Z_]+__/);
  });

  it("a retired key equal to the current one is never stripped", () => {
    expect(buildLinuxOnboardingScript({ ...base, retiredPublicKeys: [CUR] })).toBe(buildLinuxOnboardingScript(base));
  });
});

describe("rule 166: the Linux offboarding script", () => {
  const s = buildLinuxOffboardingScript({ ...base, retiredPublicKeys: [OLD] });

  it("removes the current AND the retired keys, and nothing else is named", () => {
    expect(s).not.toMatch(/__[A-Z_]+__/);
    expect(s).toContain(`POLARIS_KEYS=( '${CUR}' '${OLD}' )`);
    expect(s).toContain('polaris_strip_keys "$AUTH_KEYS" "${POLARIS_KEYS[@]}"');
    expect(s.startsWith("#!/usr/bin/env bash")).toBe(true);
    expect(s).not.toContain("\r");
  });

  it("removes the sudoers drop-in only when it carries the Polaris header", () => {
    expect(s).toContain("POLARIS_SUDOERS='/etc/sudoers.d/polaris-agent'");
    expect(s).toMatch(/head -n 1 "\$POLARIS_SUDOERS" \| grep -q "Managed by Polaris"/);
    expect(s).toContain("it does not carry the Polaris header");
    // The header it looks for is the one the onboarding script writes.
    expect(buildLinuxOnboardingScript(base)).toContain("# Managed by Polaris");
  });

  it("create mode removes the account only while it still carries the onboarding comment", () => {
    expect(s).toContain(`[ "$POLARIS_GECOS" = '${LINUX_ACCOUNT_COMMENT}' ]`);
    expect(s).toContain('userdel --remove "$POLARIS_USER"');
    // …which is the comment the onboarding script creates it with.
    expect(buildLinuxOnboardingScript(base)).toContain(`--comment "${LINUX_ACCOUNT_COMMENT}"`);
  });

  it("existing mode never removes the account", () => {
    const e = buildLinuxOffboardingScript({ ...base, accountMode: "existing", username: "deploy" });
    expect(e).not.toContain("userdel");
    expect(e).toContain("onboarding did not create it");
  });

  it("removes the firewall allowance only for the configured server address", () => {
    expect(s).toContain("POLARIS_SERVER='10.0.0.5'");
    expect(s).toContain("--remove-rich-rule=");
    expect(s).toContain('ufw delete allow from "$POLARIS_SERVER" to any port 22 proto tcp');
    const none = buildLinuxOffboardingScript({ ...base, polarisServerIp: undefined });
    expect(none).not.toContain("firewall-cmd");
    expect(none).not.toContain("ufw");
  });

  it("never stops sshd, never touches the agent, and says so", () => {
    expect(s).not.toMatch(/systemctl (stop|disable)/);
    expect(s).toContain("sshd was not changed.");
    expect(s).toContain("the Polaris Agent is still installed");
    expect(s).toContain("Uninstall the agent FROM POLARIS FIRST");
  });

  it("refuses the inputs the onboarding builder refuses", () => {
    expect(() => buildLinuxOffboardingScript({ ...base, username: "root; rm -rf /" })).toThrow();
    expect(() => buildLinuxOffboardingScript({ ...base, publicKey: "not a key" })).toThrow(/well-formed/);
    expect(() => buildLinuxOffboardingScript({ ...base, polarisServerIp: "10.0.0.5; reboot" })).toThrow();
    expect(() => buildLinuxOffboardingScript({ ...base, accountMode: "nope" as never })).toThrow(/Account mode/);
  });

  it.runIf(hasBash)("is valid bash (bash -n), in every shape", () => {
    const dir = mkdtempSync(join(tmpdir(), "polaris-offb-"));
    try {
      const shapes = [
        s,
        buildLinuxOffboardingScript({ ...base, accountMode: "existing", username: "deploy", polarisServerIp: undefined }),
        buildLinuxOnboardingScript({ ...base, retiredPublicKeys: [OLD, OLDER] }),
        buildLinuxOnboardingDetectionScript({ ...base, retiredPublicKeys: [OLD, OLDER] }),
      ];
      shapes.forEach((script, i) => {
        const f = join(dir, `s${i}.sh`);
        writeFileSync(f, script + "\n");
        expect(() => execFileSync("bash", ["-n", f], { stdio: "pipe" })).not.toThrow();
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe.runIf(hasBash)("polaris_strip_keys, executed", () => {
  function run(lines: string[], keys: string[], trailingNewline = true) {
    const dir = mkdtempSync(join(tmpdir(), "polaris-strip-"));
    try {
      const file = join(dir, "authorized_keys");
      writeFileSync(file, lines.join("\n") + (trailingNewline ? "\n" : ""));
      const script = join(dir, "run.sh");
      writeFileSync(script, `set -uo pipefail\n${POLARIS_SH_HELPERS}\n${POLARIS_SH_STRIP_HELPER}\npolaris_strip_keys "$@"\n`);
      const out = execFileSync("bash", [script, file.replace(/\\/g, "/"), ...keys], { encoding: "utf8" }).trim();
      return { removed: Number(out), after: readFileSync(file, "utf8"), leftovers: existsSync(file) };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  const ALICE = "ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQC7someoneelse alice@laptop";
  const BOB = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIBOBSKEY bob@desk";

  it("removes exactly the named keys, whatever their comment, and keeps every other line", () => {
    const renamed = CUR.replace("polaris-agent-deploy", "a-different-comment");
    const r = run([ALICE, "# a comment line", "", OLD, renamed, BOB], [CUR, OLD]);
    expect(r.removed).toBe(2);
    expect(r.after).toBe([ALICE, "# a comment line", "", BOB].join("\n") + "\n");
  });

  it("keeps a last line that had no trailing newline", () => {
    const r = run([OLD, BOB], [OLD], false);
    expect(r.removed).toBe(1);
    expect(r.after).toBe(BOB + "\n");
  });

  it("leaves the file untouched when nothing matches", () => {
    const r = run([ALICE, BOB], [CUR, OLD]);
    expect(r.removed).toBe(0);
    expect(r.after).toBe([ALICE, BOB].join("\n") + "\n");
  });

  it("a file holding only Polaris keys ends up empty, not deleted", () => {
    const r = run([CUR, OLD], [CUR, OLD]);
    expect(r.removed).toBe(2);
    expect(r.after).toBe("");
    expect(r.leftovers).toBe(true);
  });

  it("does not treat another key that merely shares a prefix as a match", () => {
    const longer = CUR.replace("xxx polaris", "xxxEXTRA polaris");
    const r = run([longer], [CUR]);
    expect(r.removed).toBe(0);
  });
});

describe("rule 166: the Windows offboarding script", () => {
  const s = buildWindowsOffboardingScript({ ...base, retiredPublicKeys: [OLD] });

  it("removes the current and retired keys from administrators_authorized_keys, keeping the rest", () => {
    expect(s).not.toMatch(/__[A-Z_]+__/);
    expect(s).toContain(`$PolarisKeys = @('${CUR}', '${OLD}')`);
    expect(s).toContain("Remove-PolarisKeys -Path $authKeys -Keys $PolarisKeys");
    // The stripper rewrites in place (the ACL survives) and never deletes the file.
    expect(s).toContain("Set-Content -LiteralPath $Path -Value $kept.ToArray() -Encoding ascii");
    expect(s).toContain("Clear-Content -LiteralPath $Path");
    expect(s).not.toMatch(/Remove-Item[^\n]*authorized_keys/);
  });

  it("create mode removes the local account only while it carries the onboarding description", () => {
    expect(s).toContain(`$polarisAccount.Description -ne '${WINDOWS_ACCOUNT_DESCRIPTION}'`);
    expect(s).toContain("Remove-LocalUser -Name $PolarisUser");
    expect(buildWindowsOnboardingScript(base)).toContain(`-Description '${WINDOWS_ACCOUNT_DESCRIPTION}'`);
  });

  it("existing mode never removes or demotes the account, domain accounts included", () => {
    const e = buildWindowsOffboardingScript({ ...base, accountMode: "existing", username: "CORP\\svc-polaris" });
    expect(e).not.toContain("Remove-LocalUser");
    expect(e).not.toContain("Remove-LocalGroupMember");
    expect(e).toContain("$PolarisUser = 'CORP\\svc-polaris'");
  });

  it("removes the Polaris firewall rule and leaves the built-in rule as it finds it", () => {
    expect(s).toContain("$fwName = 'Polaris SSH (TCP 22)'");
    expect(s).toContain("$polarisRules | Remove-NetFirewallRule");
    expect(s).not.toMatch(/^\s*Enable-NetFirewallRule/m);
    expect(s).toContain("To restore the Windows default:  Enable-NetFirewallRule -Name ");
  });

  it("never uninstalls OpenSSH or the agent, and warns when the agent is still there", () => {
    expect(s).not.toContain("Remove-WindowsCapability");
    expect(s).not.toMatch(/Stop-Service|Set-Service/);
    expect(s).toContain("Get-Service -Name 'polaris-agent'");
    expect(s).toContain("OpenSSH Server was not changed.");
  });

  it("emits every value as a single-quoted literal and refuses unsafe input", () => {
    expect(() => buildWindowsOffboardingScript({ ...base, username: "x'; Remove-Item C:\\ -Recurse #" })).toThrow();
    expect(() => buildWindowsOffboardingScript({ ...base, retiredPublicKeys: ["ssh-ed25519 A'B"] })).toThrow(/well-formed/);
    expect(s).not.toContain('"' + CUR + '"');
  });

  it("reports failure with a non-zero exit instead of stopping at the first error", () => {
    expect(s).toContain("$failed = $true");
    expect(s).toMatch(/if \(\$failed\) \{\s+Write-Host 'Polaris SSH offboarding finished WITH ERRORS'\s+exit 1/);
    expect(s.trimEnd().endsWith("exit 0")).toBe(true);
  });
});
