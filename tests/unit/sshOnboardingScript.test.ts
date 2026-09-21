/**
 * Unit tests for the Windows SSH onboarding script generator.
 *
 * The emitted PowerShell runs FLEET-WIDE as SYSTEM, so these tests weight two
 * things heavily: that operator-supplied values can never inject code, and
 * that the script is genuinely idempotent (both in what it emits and in the
 * detection predicate that decides whether to run it again).
 */

import { describe, it, expect } from "vitest";
import ssh2 from "ssh2";
const sshUtils = ssh2.utils;

import {
  buildWindowsOnboardingScript,
  buildWindowsOnboardingDetectionScript,
  assertValidPublicKey,
  assertValidUsername,
  assertValidServerIp,
  WINDOWS_ACCOUNT_DESCRIPTION,
  WINDOWS_DESCRIPTION_MAX,
} from "../../src/services/sshOnboardingScript.js";

/** A real generated key, so the tests exercise the actual shape we emit. */
const KEYPAIR = sshUtils.generateKeyPairSync("ed25519", { comment: "polaris-agent-deploy" });
const PUBLIC_KEY = String(KEYPAIR.public).trim();

const BASE = {
  publicKey: PUBLIC_KEY,
  username: "polaris-agent",
  accountMode: "existing" as const,
};

describe("assertValidPublicKey", () => {
  it("accepts a real generated ed25519 public key", () => {
    expect(assertValidPublicKey(PUBLIC_KEY)).toBe(PUBLIC_KEY);
  });

  it("accepts rsa and ecdsa key types", () => {
    expect(() => assertValidPublicKey("ssh-rsa AAAAB3NzaC1yc2E= host")).not.toThrow();
    expect(() => assertValidPublicKey("ecdsa-sha2-nistp256 AAAAE2VjZHNh= host")).not.toThrow();
  });

  it("rejects an empty key with an actionable message", () => {
    expect(() => assertValidPublicKey("")).toThrow(/generated yet/i);
  });

  it("rejects an unknown algorithm", () => {
    expect(() => assertValidPublicKey("ssh-dss AAAAB3NzaC1kc3M= host")).toThrow(/well-formed/i);
  });

  it("rejects a key whose comment carries a quote or newline", () => {
    expect(() => assertValidPublicKey(PUBLIC_KEY + "'; Invoke-Bad; #")).toThrow(/well-formed/i);
    expect(() => assertValidPublicKey(PUBLIC_KEY + "\nssh-ed25519 AAAA= attacker")).toThrow(/well-formed/i);
  });
});

describe("assertValidUsername", () => {
  it("accepts a plain local name", () => {
    expect(assertValidUsername("polaris-agent", "create")).toBe("polaris-agent");
  });

  it("accepts DOMAIN\\user for an existing account", () => {
    expect(assertValidUsername("CORP\\svc-polaris", "existing")).toBe("CORP\\svc-polaris");
  });

  it("refuses to emit a script that would create a domain account locally", () => {
    // New-LocalUser cannot do this, so failing at authoring time beats failing
    // on every endpoint in the fleet.
    expect(() => assertValidUsername("CORP\\svc-polaris", "create")).toThrow(/cannot be created locally/i);
  });

  it("rejects an empty username", () => {
    expect(() => assertValidUsername("   ", "existing")).toThrow(/required/i);
  });

  it.each([
    ["quote break-out", "user'; Invoke-WebRequest evil.example; #"],
    ["subexpression",   "user$(whoami)"],
    ["newline",         "user\nInvoke-Bad"],
    ["semicolon",       "user;calc"],
    ["backtick",        "user`n"],
    ["space",           "user name"],
  ])("rejects an injection attempt via %s", (_label, value) => {
    expect(() => assertValidUsername(value, "existing")).toThrow();
  });

  it("rejects a username longer than 64 characters", () => {
    expect(() => assertValidUsername("a".repeat(65), "existing")).toThrow();
  });

  // PROD, 2026-09-17. New-LocalUser refuses a -Name over 20 characters, and
  // nothing checked: a longer name passed validation here and then failed
  // identically on every endpoint the script reached. Same class of bug as the
  // Description overflow below — a PowerShell parameter limit that only shows
  // up on the host — and the same reason the domain-account case is refused.
  it("refuses a create-mode name over the 20-character SAM limit", () => {
    expect(() => assertValidUsername("a".repeat(21), "create")).toThrow(/20 characters/i);
  });

  it("accepts exactly 20 characters in create mode", () => {
    expect(assertValidUsername("a".repeat(20), "create")).toBe("a".repeat(20));
  });

  it("does NOT apply the 20-char cap to an existing account", () => {
    // The account demonstrably exists, so a length rule could only refuse
    // something that already works.
    expect(assertValidUsername("a".repeat(21), "existing")).toBe("a".repeat(21));
  });
});

describe("New-LocalUser parameter limits", () => {
  // PROD, 2026-09-17. The description shipped at 68 characters against a
  // 48-character limit, so create mode failed on EVERY Windows endpoint with
  // ParameterArgumentValidationError — it had never been run on a real host.
  // The assertion is on the emitted script, not just the constant, because the
  // failure lands on the endpoint where nobody is reading our source.
  it("keeps the account description inside the 48-character limit", () => {
    expect(WINDOWS_ACCOUNT_DESCRIPTION.length).toBeLessThanOrEqual(WINDOWS_DESCRIPTION_MAX);
  });

  it("emits a -Description the cmdlet will accept", () => {
    const script = buildWindowsOnboardingScript({ ...BASE, accountMode: "create" });
    const m = script.match(/-Description '([^']*)'/);
    expect(m).not.toBeNull();
    expect(m![1].length).toBeLessThanOrEqual(WINDOWS_DESCRIPTION_MAX);
  });

  it("only emits New-LocalUser in create mode", () => {
    expect(buildWindowsOnboardingScript({ ...BASE, accountMode: "create" })).toContain("New-LocalUser");
    expect(buildWindowsOnboardingScript({ ...BASE, accountMode: "existing" })).not.toContain("New-LocalUser");
  });
});

describe("assertValidServerIp", () => {
  it("treats blank as 'not configured' rather than an error", () => {
    expect(assertValidServerIp("")).toBe("");
    expect(assertValidServerIp(undefined)).toBe("");
    expect(assertValidServerIp(null)).toBe("");
  });

  it("accepts an address and a CIDR", () => {
    expect(assertValidServerIp("10.0.0.42")).toBe("10.0.0.42");
    expect(assertValidServerIp("10.0.0.0/24")).toBe("10.0.0.0/24");
  });

  it("rejects a non-address, including injection attempts", () => {
    expect(() => assertValidServerIp("10.0.0.42'; calc; #")).toThrow();
    expect(() => assertValidServerIp("not-an-ip")).toThrow();
  });
});

describe("buildWindowsOnboardingScript", () => {
  it("embeds the public key and targets the administrators_authorized_keys file", () => {
    const script = buildWindowsOnboardingScript(BASE);
    expect(script).toContain(PUBLIC_KEY);
    // The whole point of the feature: NOT %USERPROFILE%\.ssh\authorized_keys,
    // which Windows OpenSSH ignores for administrators.
    expect(script).toContain("administrators_authorized_keys");
    expect(script).not.toContain(".ssh\\authorized_keys'");
  });

  it("appends rather than overwrites, so other keys in the file survive", () => {
    const script = buildWindowsOnboardingScript(BASE);
    expect(script).toContain("Add-Content");
    expect(script).not.toContain("Set-Content -LiteralPath $authKeys");
  });

  it("guards the key write behind the presence check so re-runs don't duplicate", () => {
    const script = buildWindowsOnboardingScript(BASE);
    expect(script).toContain("if (Test-PolarisKeyPresent");
    expect(script).toContain("function Test-PolarisKeyPresent");
  });

  it("locks the ACL down by well-known SID, not localized group name", () => {
    const script = buildWindowsOnboardingScript(BASE);
    expect(script).toContain("S-1-5-32-544");
    expect(script).toContain("S-1-5-18");
    expect(script).toContain("SetAccessRuleProtection($true, $false)");
  });

  it("exits 0 with a clear marker on a build that has no OpenSSH capability", () => {
    // Returning non-zero would loop a detection/remediation pair forever
    // against a machine that can never be fixed.
    const script = buildWindowsOnboardingScript(BASE);
    expect(script).toMatch(/unsupported:/);
  });

  describe("account mode", () => {
    it("emits account creation only for mode=create", () => {
      const created = buildWindowsOnboardingScript({ ...BASE, accountMode: "create" });
      expect(created).toContain("New-LocalUser");
      expect(created).toContain("Add-LocalGroupMember");
      // Resolve the group by SID — "Administrators" is localized.
      expect(created).toContain("Get-LocalGroup -SID");
    });

    it("emits no account mutation for mode=existing", () => {
      const existing = buildWindowsOnboardingScript({ ...BASE, accountMode: "existing" });
      expect(existing).not.toContain("New-LocalUser");
      expect(existing).not.toContain("Add-LocalGroupMember");
      expect(existing).toContain("not created by this script");
    });

    it("refuses mode=existing when the named account is absent or not an admin", () => {
      // Windows used to print 'Using existing account', authorize the key for
      // an account that was not there, and exit 0 — a fleet reporting fully
      // onboarded that could never accept a logon. Linux always refused here.
      const existing = buildWindowsOnboardingScript({ ...BASE, accountMode: "existing" });
      expect(existing).toContain("does not exist on this host");
      expect(existing).toContain("is disabled on this host");
      expect(existing).toContain("is not a member of");
      expect(existing).toContain("Test-PolarisLocalAdmin");
      // Verified, not mutated: the refusal must not become a silent fixup.
      expect(existing).not.toContain("Add-LocalGroupMember");
    });

    it("never emits a literal password value", () => {
      const created = buildWindowsOnboardingScript({ ...BASE, accountMode: "create" });
      // The password is generated on the endpoint from a CSPRNG and discarded.
      expect(created).toContain("RandomNumberGenerator");
      expect(created).toContain("Remove-Variable pwPlain");
    });

    it("rejects an unknown account mode", () => {
      expect(() =>
        buildWindowsOnboardingScript({ ...BASE, accountMode: "wibble" as never }),
      ).toThrow();
    });
  });

  describe("firewall block", () => {
    it("scopes TCP/22 to the configured address", () => {
      const script = buildWindowsOnboardingScript({ ...BASE, polarisServerIp: "10.0.0.42" });
      expect(script).toContain("New-NetFirewallRule");
      expect(script).toContain("'10.0.0.42'");
      expect(script).toContain("-LocalPort 22");
    });

    it("replaces an existing rule of the same name so re-runs stay idempotent", () => {
      const script = buildWindowsOnboardingScript({ ...BASE, polarisServerIp: "10.0.0.42" });
      expect(script).toContain("Remove-NetFirewallRule");
    });

    it("scopes the rule to every profile, not just Private", () => {
      // Windows' own OpenSSH rule is Private-only: a domain-joined endpoint
      // sits on the Domain profile and never sees the connection.
      const script = buildWindowsOnboardingScript({ ...BASE, polarisServerIp: "10.0.0.42" });
      expect(script).toContain("-Action Allow -Profile Any");
    });

    it("disables the built-in any-source OpenSSH rule when it scopes TCP/22", () => {
      // Allows are additive — leaving it enabled keeps port 22 open to every
      // host on a Private network however tight the Polaris rule is.
      const script = buildWindowsOnboardingScript({ ...BASE, polarisServerIp: "10.0.0.42" });
      expect(script).toContain("'OpenSSH-Server-In-*'");
      expect(script).toContain("Disable-NetFirewallRule");
      expect(script).not.toContain("Set-NetFirewallRule");
    });

    it("opens nothing when no address is configured, but adds Domain to the built-in rule", () => {
      const script = buildWindowsOnboardingScript(BASE);
      expect(script).not.toContain("New-NetFirewallRule");
      expect(script).not.toContain("Disable-NetFirewallRule");
      expect(script).toContain("Set-NetFirewallRule -Name $rule.Name -Profile Domain,Private");
      expect(script).toContain("not modified");
    });

    it("leaves Public off the built-in rule", () => {
      // Reachable-from-Domain is the problem being fixed; an any-source TCP/22
      // rule on the profile a laptop picks up in an airport is not.
      const script = buildWindowsOnboardingScript(BASE);
      expect(script).not.toContain("-Profile Domain,Private,Public");
    });

    it("re-reads as a no-op on a host already widened", () => {
      const script = buildWindowsOnboardingScript(BASE);
      expect(script).toContain("$ruleProfile -eq 'Any' -or $ruleProfile -match 'Domain'");
    });
  });

  it("summarizes the chosen options in the header", () => {
    const script = buildWindowsOnboardingScript({
      ...BASE,
      accountMode: "create",
      username: "svc-polaris",
      polarisServerIp: "192.168.1.5",
    });
    expect(script).toContain("creates the local administrator account 'svc-polaris'");
    expect(script).toContain("scopes inbound TCP/22 to 192.168.1.5");
    // No placeholder may survive into the emitted script.
    expect(script).not.toMatch(/__[A-Z_]+__/);
  });

  it("propagates validation failures instead of emitting a script", () => {
    expect(() => buildWindowsOnboardingScript({ ...BASE, username: "bad;name" })).toThrow();
    expect(() => buildWindowsOnboardingScript({ ...BASE, publicKey: "garbage" })).toThrow();
  });
});

describe("buildWindowsOnboardingDetectionScript", () => {
  const DETECT = {
    publicKey: PUBLIC_KEY,
    username: "polaris-agent",
    accountMode: "create" as const,
  };

  it("shares the key-presence predicate with the remediation script", () => {
    // Same function text in both — detection cannot drift from what
    // remediation writes.
    const detect = buildWindowsOnboardingDetectionScript(DETECT);
    const remediate = buildWindowsOnboardingScript(BASE);
    const fn = "function Test-PolarisKeyPresent";
    expect(detect).toContain(fn);
    expect(remediate).toContain(fn);

    const extract = (s: string) => s.slice(s.indexOf(fn), s.indexOf("function Get-PolarisAuthorizedKeysPath"));
    expect(extract(detect)).toBe(extract(remediate));
  });

  it("shares the Administrators-membership predicate with the remediation script", () => {
    // The pair must agree on "is an administrator" for the same reason it
    // agrees on "is the key present": a detection that judges it differently
    // either loops forever or reports an unusable endpoint compliant.
    const detect = buildWindowsOnboardingDetectionScript(DETECT);
    const remediate = buildWindowsOnboardingScript(BASE);
    const fn = "function Test-PolarisLocalAdmin";
    // Bounded at the function's own closing brace: it is the last helper, so
    // slicing to end-of-string would compare the two scripts' bodies instead.
    // Every brace inside the function is indented, so "\n}" is unambiguous.
    const extract = (s: string) => {
      const start = s.indexOf(fn);
      return s.slice(start, s.indexOf("\n}", start) + 2);
    };
    expect(detect).toContain(fn);
    expect(remediate).toContain(fn);
    expect(extract(detect)).toBe(extract(remediate));
  });

  it("exits 1 for each remediable condition and 0 when satisfied", () => {
    const script = buildWindowsOnboardingDetectionScript(DETECT);
    expect(script).toContain("remediate: OpenSSH Server not installed");
    expect(script).toContain("remediate: sshd not running");
    expect(script).toContain("remediate: Polaris key not authorized");
    expect(script).toContain("ok: Polaris SSH onboarding present");
  });

  it("checks the account exists and is a local administrator", () => {
    // The regression this pair shipped with: an endpoint whose account was
    // never created reported 'ok' forever while no logon could ever succeed.
    const script = buildWindowsOnboardingDetectionScript(DETECT);
    expect(script).toContain("Get-LocalUser");
    expect(script).toContain("Test-PolarisLocalAdmin");
    expect(script).toContain("remediate: local account ' + $PolarisUser + ' missing");
    expect(script).toContain("is not a member of");
    expect(script).toContain("$PolarisUser      = 'polaris-agent'");
  });

  it("resolves Administrators by SID, not by its localized name", () => {
    const script = buildWindowsOnboardingDetectionScript(DETECT);
    expect(script).toContain("Get-LocalGroup -SID 'S-1-5-32-544'");
    expect(script).not.toContain("__SID_ADMINS__");
  });

  it("falls back to the WinNT provider when a member SID will not resolve", () => {
    // Get-LocalGroupMember throws outright on an Entra-joined endpoint holding
    // one stale ACE; without the fallback every such device loops forever.
    const script = buildWindowsOnboardingDetectionScript(DETECT);
    expect(script).toContain("WinNT://./");
  });

  it("still does not check the firewall", () => {
    // With no server IP configured there is no rule to find, so this is the
    // one condition remediation could never satisfy.
    const script = buildWindowsOnboardingDetectionScript(DETECT);
    expect(script).not.toContain("Get-NetFirewallRule");
  });

  it("treats an unsupported build as exit 0 so the pair doesn't loop", () => {
    const script = buildWindowsOnboardingDetectionScript(DETECT);
    const idx = script.indexOf("unsupported: no OpenSSH Server capability");
    expect(idx).toBeGreaterThan(-1);
    expect(script.slice(idx, idx + 200)).toContain("exit 0");
  });

  it("fails closed on an unexpected error rather than reporting compliant", () => {
    const script = buildWindowsOnboardingDetectionScript(DETECT);
    expect(script).toContain("remediate: detection error");
  });

  it("carries a domain account through and skips Get-LocalUser for it", () => {
    const script = buildWindowsOnboardingDetectionScript({
      publicKey: PUBLIC_KEY,
      username: "CORP\\svc-polaris",
      accountMode: "existing",
    });
    expect(script).toContain("$PolarisUser      = 'CORP\\svc-polaris'");
    // The Get-LocalUser call is guarded, not removed — a domain account is
    // invisible to it and only its group membership is observable.
    expect(script).toContain("if (-not $PolarisUser.Contains('\\'))");
  });

  it("rejects an invalid public key or username", () => {
    expect(() => buildWindowsOnboardingDetectionScript({ ...DETECT, publicKey: "nope" })).toThrow();
    expect(() => buildWindowsOnboardingDetectionScript({ ...DETECT, username: "" })).toThrow();
    expect(() =>
      buildWindowsOnboardingDetectionScript({ ...DETECT, username: "CORP\\svc", accountMode: "create" }),
    ).toThrow();
  });
});

// ─── Linux ────────────────────────────────────────────────────────────────

import {
  buildLinuxOnboardingScript,
  buildLinuxOnboardingDetectionScript,
  assertValidLinuxUsername,
} from "../../src/services/sshOnboardingScript.js";

const LINUX_BASE = {
  publicKey: PUBLIC_KEY,
  username: "polaris-agent",
  accountMode: "existing" as const,
};

describe("assertValidLinuxUsername", () => {
  it("accepts a POSIX account name", () => {
    expect(assertValidLinuxUsername("polaris-agent")).toBe("polaris-agent");
    expect(assertValidLinuxUsername("_svc1")).toBe("_svc1");
  });

  it("rejects the Windows DOMAIN-backslash-user form with a pointed message", () => {
    // Silently accepting it would emit a script that can never work.
    expect(() => assertValidLinuxUsername("CORP\\svc")).toThrow(/no DOMAIN.user form/i);
  });

  it("rejects uppercase, over-long and injection-shaped names", () => {
    expect(() => assertValidLinuxUsername("Polaris")).toThrow();
    expect(() => assertValidLinuxUsername("a".repeat(33))).toThrow();
    expect(() => assertValidLinuxUsername("svc; rm -rf /")).toThrow();
    expect(() => assertValidLinuxUsername("svc$(id)")).toThrow();
    expect(() => assertValidLinuxUsername("svc'x")).toThrow();
    expect(() => assertValidLinuxUsername("")).toThrow(/required/i);
  });
});

describe("buildLinuxOnboardingScript", () => {
  it("targets the user's own authorized_keys with the modes sshd demands", () => {
    const s = buildLinuxOnboardingScript(LINUX_BASE);
    expect(s).toContain('SSH_DIR="$POLARIS_HOME/.ssh"');
    expect(s).toContain('chmod 700 "$SSH_DIR"');
    expect(s).toContain('chmod 600 "$AUTH_KEYS"');
    expect(s).toContain('chown -R "$POLARIS_USER" "$SSH_DIR"');
  });

  it("appends the key only when absent, so re-runs don't duplicate", () => {
    const s = buildLinuxOnboardingScript(LINUX_BASE);
    expect(s).toContain("if polaris_key_present");
    expect(s).toContain('>> "$AUTH_KEYS"');
    // No TRUNCATING redirect anywhere — a single '>' would wipe other people's
    // keys out of the file. (Matched with a leading non-'>' so the append
    // itself doesn't trip it.)
    expect(s).not.toMatch(/[^>]> "\$AUTH_KEYS"/);
  });

  it("restores the SELinux context when the tool is present", () => {
    // RHEL: a hand-made ~/.ssh has the wrong context and sshd refuses it,
    // with nothing useful on the client — same class of silent failure as the
    // Windows ACL.
    const s = buildLinuxOnboardingScript(LINUX_BASE);
    expect(s).toContain("restorecon -R");
    expect(s).toContain("command -v restorecon");
  });

  describe("sudoers drop-in", () => {
    it("writes NOPASSWD for the account", () => {
      // Key auth alone is not enough: the installer runs `sudo -n`.
      const s = buildLinuxOnboardingScript(LINUX_BASE);
      expect(s).toContain("NOPASSWD:ALL");
      expect(s).toContain("/etc/sudoers.d/polaris-agent");
    });

    it("VALIDATES with visudo before installing", () => {
      // A malformed drop-in locks sudo out for every user on the host — far
      // worse than a failed onboarding.
      const s = buildLinuxOnboardingScript(LINUX_BASE);
      const validateAt = s.indexOf("visudo -cf");
      const installAt = s.indexOf("install -m 0440");
      expect(validateAt).toBeGreaterThan(-1);
      expect(installAt).toBeGreaterThan(validateAt);
      expect(s).toContain("refusing to install it");
    });

    it("installs 0440 root:root and skips an unchanged file", () => {
      const s = buildLinuxOnboardingScript(LINUX_BASE);
      expect(s).toContain("install -m 0440 -o root -g root");
      expect(s).toContain("cmp -s");
    });
  });

  it("creates a password-locked account only in create mode", () => {
    const created = buildLinuxOnboardingScript({ ...LINUX_BASE, accountMode: "create" });
    expect(created).toContain("useradd --create-home");
    expect(created).toContain("passwd --lock");

    const existing = buildLinuxOnboardingScript(LINUX_BASE);
    expect(existing).not.toContain("useradd");
    expect(existing).toContain("does not exist on this host");
  });

  it("requires root and uses strict bash flags", () => {
    const s = buildLinuxOnboardingScript(LINUX_BASE);
    expect(s).toContain("set -euo pipefail");
    expect(s).toContain('if [ "$(id -u)" -ne 0 ]');
  });

  it("does not try to install openssh-server", () => {
    // Distro-specific package management is out of scope, and a host you
    // can't already reach over SSH isn't one this script was delivered to.
    const s = buildLinuxOnboardingScript(LINUX_BASE);
    expect(s).not.toMatch(/apt-get install|yum install|dnf install|zypper install/);
    expect(s).toContain("install openssh-server for this host to be reachable");
  });

  describe("firewall block", () => {
    it("handles firewalld and ufw, idempotently", () => {
      const s = buildLinuxOnboardingScript({ ...LINUX_BASE, polarisServerIp: "10.0.0.42" });
      expect(s).toContain("firewall-cmd");
      expect(s).toContain("ufw");
      expect(s).toContain("--remove-rich-rule"); // removed before added
      expect(s).toContain("'10.0.0.42'");
    });

    it("leaves the firewall alone when no address is set", () => {
      const s = buildLinuxOnboardingScript(LINUX_BASE);
      expect(s).not.toContain("firewall-cmd");
      expect(s).toContain("not modified");
    });
  });

  it("leaves no placeholder unreplaced and rejects bad input", () => {
    const s = buildLinuxOnboardingScript({ ...LINUX_BASE, accountMode: "create", polarisServerIp: "10.1.2.3" });
    expect(s).not.toMatch(/__[A-Z_]+__/);
    expect(() => buildLinuxOnboardingScript({ ...LINUX_BASE, username: "BAD" })).toThrow();
    expect(() => buildLinuxOnboardingScript({ ...LINUX_BASE, publicKey: "junk" })).toThrow();
  });
});

describe("buildLinuxOnboardingDetectionScript", () => {
  it("shares the key-presence helpers with the remediation script", () => {
    const detect = buildLinuxOnboardingDetectionScript({ publicKey: PUBLIC_KEY, username: "polaris-agent" });
    const remediate = buildLinuxOnboardingScript(LINUX_BASE);
    const marker = "polaris_key_present() {";
    const extract = (s: string) => s.slice(s.indexOf("polaris_key_body() {"), s.indexOf("polaris_home_for() {"));
    expect(detect).toContain(marker);
    expect(extract(detect)).toBe(extract(remediate));
  });

  it("checks account, key AND the sudoers drop-in", () => {
    // Unlike Windows, all three are prerequisites the install genuinely fails
    // without, and all three are cheaply observable here.
    const s = buildLinuxOnboardingDetectionScript({ publicKey: PUBLIC_KEY, username: "polaris-agent" });
    expect(s).toContain("remediate: account");
    expect(s).toContain("remediate: Polaris key not authorized");
    expect(s).toContain("remediate: sudoers drop-in missing");
    expect(s).toContain("ok: Polaris SSH onboarding present");
  });

  it("does not judge the firewall", () => {
    const s = buildLinuxOnboardingDetectionScript({ publicKey: PUBLIC_KEY, username: "polaris-agent" });
    expect(s).not.toContain("firewall-cmd");
  });

  it("validates both inputs", () => {
    expect(() => buildLinuxOnboardingDetectionScript({ publicKey: "junk", username: "polaris-agent" })).toThrow();
    expect(() => buildLinuxOnboardingDetectionScript({ publicKey: PUBLIC_KEY, username: "CORP\svc" })).toThrow();
  });
});
