/**
 * src/utils/agentRebootPermission.ts — the host-side half of an agent host's
 * reboot opt-in (business rule 114). Pure: the paths and the scripts; the
 * remote run is agentRebootPermissionService's.
 *
 * Why a script at all. The Linux agent runs as the hardened DynamicUser
 * `polaris-agent` with NoNewPrivileges (utils/agentUnit.ts): it holds no
 * CAP_SYS_BOOT and cannot sudo, so it cannot reboot its host — on purpose. The
 * opt-in grants exactly ONE thing, through the mechanism the OS already has
 * for it: a polkit rule letting that user ask systemd-logind to reboot
 * (`org.freedesktop.login1.reboot*`). Nothing else the agent can do changes,
 * and the unit itself is untouched (no reinstall). Both polkit dialects are
 * written: a JavaScript rule (polkit ≥ 0.106 — RHEL 8+, Debian 12+, Ubuntu
 * 24.04+) and a .pkla (polkit 0.105 — Ubuntu ≤ 22.04, Debian ≤ 11); each
 * polkit ignores the other's file. The rule matches the user name AND the
 * unit (`subject.system_unit`, polkit ≥ 121) so a DynamicUser whose name does
 * not resolve still matches by unit.
 *
 * The MARKER is the operator's intent written where only root can write it.
 * The agent refuses a reboot command without it on every OS — on Windows the
 * agent runs as LocalSystem and could reboot regardless, so there the marker
 * is the opt-in, not a privilege boundary. The agent reports
 * `rebootCapable` = marker present AND (Linux) logind's CanReboot answers
 * "yes" for it, which is how the server knows the rule actually took.
 *
 * Every script is idempotent; enable and disable can be re-run.
 */

export const LINUX_REBOOT_MARKER = "/etc/polaris-agent-reboot.enabled";
export const LINUX_POLKIT_RULE = "/etc/polkit-1/rules.d/50-polaris-agent-reboot.rules";
export const LINUX_POLKIT_PKLA = "/etc/polkit-1/localauthority/50-local.d/50-polaris-agent-reboot.pkla";
/** Relative to %ProgramData% — inside the agent's conf dir, so the uninstaller's removal of that dir takes it too. */
export const WINDOWS_REBOOT_MARKER_REL = "Polaris\\agent\\reboot.enabled";
/** The macOS LaunchDaemon runs as root; the marker is the whole opt-in there. */
export const DARWIN_REBOOT_MARKER = "/etc/polaris-agent/reboot.enabled";

export const LOGIND_REBOOT_ACTIONS = [
  "org.freedesktop.login1.reboot",
  "org.freedesktop.login1.reboot-multiple-sessions",
  "org.freedesktop.login1.reboot-ignore-inhibit",
] as const;

export function polkitJsRule(): string {
  const actions = LOGIND_REBOOT_ACTIONS.map((a) => `action.id == "${a}"`).join(" ||\n       ");
  return `// Installed by Polaris (business rule 114) — lets the Polaris Agent ask
// systemd-logind to reboot this host. Remove with the agent card's
// "Disable reboots", or delete this file.
polkit.addRule(function(action, subject) {
  if ((${actions}) &&
      (subject.user == "polaris-agent" || subject.system_unit == "polaris-agent.service")) {
    return polkit.Result.YES;
  }
});
`;
}

export function polkitPkla(): string {
  return `# Installed by Polaris (business rule 114) — lets the Polaris Agent ask
# systemd-logind to reboot this host.
[Polaris Agent reboot]
Identity=unix-user:polaris-agent
Action=${LOGIND_REBOOT_ACTIONS.join(";")}
ResultAny=yes
ResultInactive=yes
ResultActive=yes
`;
}

/** Run as root (`sudo -n bash`). Exit 0 = done; non-zero names what is missing. */
export function linuxRebootPermissionScript(enable: boolean): string {
  if (!enable) {
    return `#!/usr/bin/env bash
# Polaris Agent — withdraw reboot permission (business rule 114). Idempotent.
set -euo pipefail
rm -f ${LINUX_REBOOT_MARKER} ${LINUX_POLKIT_RULE} ${LINUX_POLKIT_PKLA}
echo "Polaris Agent reboot permission removed"
`;
  }
  // Heredocs are quoted ('EOF') so nothing inside them is expanded.
  return `#!/usr/bin/env bash
# Polaris Agent — grant reboot permission (business rule 114). Idempotent.
set -euo pipefail
if ! command -v busctl >/dev/null 2>&1 || [ ! -d /run/systemd/system ]; then
  echo "systemd (logind) is required for the agent to reboot this host" >&2
  exit 3
fi
if [ ! -d /etc/polkit-1 ] && ! command -v pkaction >/dev/null 2>&1; then
  echo "polkit is not installed — install it (dnf install polkit / apt install polkitd) and enable reboots again" >&2
  exit 4
fi
install -d -m 0755 /etc/polkit-1/rules.d
cat > ${LINUX_POLKIT_RULE}.tmp <<'POLARIS_EOF'
${polkitJsRule()}POLARIS_EOF
chmod 0644 ${LINUX_POLKIT_RULE}.tmp
mv -f ${LINUX_POLKIT_RULE}.tmp ${LINUX_POLKIT_RULE}
if [ -d /etc/polkit-1/localauthority ]; then
  install -d -m 0755 /etc/polkit-1/localauthority/50-local.d
  cat > ${LINUX_POLKIT_PKLA}.tmp <<'POLARIS_EOF'
${polkitPkla()}POLARIS_EOF
  chmod 0644 ${LINUX_POLKIT_PKLA}.tmp
  mv -f ${LINUX_POLKIT_PKLA}.tmp ${LINUX_POLKIT_PKLA}
fi
printf 'Polaris Agent reboots enabled %s\\n' "$(date -u +%FT%TZ)" > ${LINUX_REBOOT_MARKER}
chown root:root ${LINUX_REBOOT_MARKER}
chmod 0644 ${LINUX_REBOOT_MARKER}
echo "Polaris Agent reboot permission installed"
`;
}

export function darwinRebootPermissionScript(enable: boolean): string {
  return enable
    ? `#!/usr/bin/env bash
set -euo pipefail
install -d -m 0755 /etc/polaris-agent
printf 'Polaris Agent reboots enabled %s\\n' "$(date -u +%FT%TZ)" > ${DARWIN_REBOOT_MARKER}
chmod 0644 ${DARWIN_REBOOT_MARKER}
echo "Polaris Agent reboot permission installed"
`
    : `#!/usr/bin/env bash
set -euo pipefail
rm -f ${DARWIN_REBOOT_MARKER}
echo "Polaris Agent reboot permission removed"
`;
}

/** PowerShell, run elevated (WinRM / SSH as an administrator). */
export function windowsRebootPermissionPs(enable: boolean): string {
  if (!enable) {
    return `$ErrorActionPreference = 'Stop'
$marker = Join-Path $env:ProgramData '${WINDOWS_REBOOT_MARKER_REL}'
if (Test-Path -LiteralPath $marker) { Remove-Item -Force -LiteralPath $marker }
Write-Host "Polaris Agent reboot permission removed"
exit 0
`;
  }
  return `$ErrorActionPreference = 'Stop'
$marker = Join-Path $env:ProgramData '${WINDOWS_REBOOT_MARKER_REL}'
$dir = Split-Path -Parent $marker
if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
Set-Content -LiteralPath $marker -Value ("Polaris Agent reboots enabled " + (Get-Date).ToUniversalTime().ToString('s') + "Z") -Encoding ASCII
# Administrators and SYSTEM only: the marker is the operator's opt-in.
$acl = New-Object System.Security.AccessControl.FileSecurity
$acl.SetAccessRuleProtection($true, $false)
foreach ($sid in @('S-1-5-32-544', 'S-1-5-18')) {
  $id = New-Object System.Security.Principal.SecurityIdentifier($sid)
  $acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($id, 'FullControl', 'Allow')))
}
Set-Acl -LiteralPath $marker -AclObject $acl
Write-Host "Polaris Agent reboot permission installed"
exit 0
`;
}

/** The uninstall-time cleanup appended to the Linux uninstaller. */
export const LINUX_REBOOT_PERMISSION_CLEANUP = `rm -f ${LINUX_REBOOT_MARKER} ${LINUX_POLKIT_RULE} ${LINUX_POLKIT_PKLA}`;
