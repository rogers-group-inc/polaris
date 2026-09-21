/**
 * src/services/sshOnboardingScript.ts — generator for the Windows SSH
 * onboarding scripts an operator pushes to their fleet before Polaris can
 * install the Polaris Agent over SSH.
 *
 * Pure string building, no I/O — the whole module is unit-testable.
 *
 * TWO scripts come out of here and they must agree:
 *
 *   • buildWindowsOnboardingScript()          — the REMEDIATION script.
 *     Installs the OpenSSH Server capability, starts sshd, optionally creates
 *     the local admin account, writes the Polaris public key into
 *     administrators_authorized_keys with the ACL sshd demands, optionally
 *     scopes inbound TCP/22 to the Polaris server, and either way settles the
 *     Private-profile-only rule Windows creates for OpenSSH (disabled when the
 *     Polaris rule supersedes it, widened to Domain when there is none).
 *
 *   • buildWindowsOnboardingDetectionScript() — the DETECTION script.
 *     Exits 0 when the endpoint is already onboarded, 1 when remediation is
 *     needed. Pairing the two under an Intune Remediation (or an SCCM
 *     Configuration Baseline) is what makes fleet rollout self-healing: a plain
 *     platform script runs ONCE per device and never retries, so a machine that
 *     was offline at assignment time, or was later reimaged, silently stays
 *     unconfigured.
 *
 * The "is the Polaris key already installed" predicate is emitted into BOTH
 * scripts from one place (POLARIS_PS_HELPERS) so detection can never drift
 * from what remediation writes.
 *
 * DELIVERY-NEUTRAL BY DESIGN. Nothing in the emitted PowerShell is
 * Intune-specific and nothing is machine-specific — the public key, username,
 * account mode and server IP are all fleet constants, and
 * administrators_authorized_keys is a single group-wide file authorizing any
 * local Administrator who presents the key. The identical body runs unchanged
 * under Intune, a GPO startup script, an SCCM baseline, Azure Arc, an RMM job,
 * or a one-off Invoke-Command loop. Only the vehicle differs.
 *
 * TWO THINGS FAIL SILENTLY IF YOU GET THEM WRONG, which is the entire reason
 * this generator exists instead of a doc page telling operators to do it:
 *   1. Windows OpenSSH IGNORES %USERPROFILE%\.ssh\authorized_keys for members
 *      of the Administrators group (sshd_config's AdministratorsAuthorizedKeys
 *      File directive). The key MUST live in
 *      %ProgramData%\ssh\administrators_authorized_keys.
 *   2. sshd REFUSES that file unless it is owned by Administrators/SYSTEM with
 *      inheritance disabled and no other ACEs.
 * Neither produces a useful error on the client — auth just fails.
 */

import { AppError } from "../utils/errors.js";
import { isValidIpv4, isValidCidr } from "../utils/cidr.js";

export type SshOnboardingAccountMode = "existing" | "create";

export interface WindowsOnboardingScriptOptions {
  /** The `authorized_keys` one-liner: "ssh-ed25519 AAAA... comment". */
  publicKey: string;
  /** Account Polaris authenticates as. `DOMAIN\user` allowed when mode=existing. */
  username: string;
  /** "create" emits local-account provisioning; "existing" assumes it's there. */
  accountMode: SshOnboardingAccountMode;
  /** When set, inbound TCP/22 is scoped to this IPv4 address or CIDR. */
  polarisServerIp?: string;
}

/** Firewall rule DisplayName — also the key for idempotent replacement. */
const FIREWALL_RULE_NAME = "Polaris SSH (TCP 22)";

/**
 * The rule WINDOWS creates when the OpenSSH Server capability installs, matched
 * by Name (not DisplayName — that one is localized). Wildcarded because the
 * build decides the suffix: `OpenSSH-Server-In-TCP` on most, plus a
 * `-NoScope` variant on some.
 *
 * It is created for the **Private profile only** and allows TCP/22 from ANY
 * source, which fails in both directions at once: a domain-joined endpoint sits
 * on the Domain profile and blocks Polaris outright — sshd running, nothing in
 * the service or the event log to say why nothing connects — while a machine on
 * a Private network has port 22 open to every host on it. Firewall rules are
 * additive allows, so no amount of scoping on the Polaris rule narrows that.
 */
const OPENSSH_BUILTIN_RULE_NAME = "OpenSSH-Server-In-*";

/**
 * Well-known SIDs rather than names. "Administrators" and "SYSTEM" are
 * LOCALIZED — on a German or French Windows install the literal strings don't
 * resolve and both the group-membership check and the ACL write fail.
 */
const SID_ADMINISTRATORS = "S-1-5-32-544";
const SID_SYSTEM = "S-1-5-18";

// ─── Input validation ─────────────────────────────────────────────────────
//
// These values are interpolated into a PowerShell script that an admin then
// runs FLEET-WIDE as SYSTEM. Anything that reaches the template is effectively
// remote code execution on every Windows endpoint in the estate, so validate
// strictly and reject rather than escape-and-hope.

/** Local or domain account name. Deliberately narrow. */
const USERNAME_RE = /^[A-Za-z0-9._-]{1,64}$/;
/** DOMAIN\user — each half held to the same charset. */
const DOMAIN_USERNAME_RE = /^[A-Za-z0-9._-]{1,64}\\[A-Za-z0-9._-]{1,64}$/;

/**
 * SAM account-name ceiling. `New-LocalUser` refuses a -Name over 20 characters,
 * so a longer one is rejected HERE rather than emitted into a script that fails
 * identically on every endpoint in the fleet — the same reasoning as the
 * domain-account refusal below, and the Linux 32-char cap in LINUX_USERNAME_RE.
 *
 * Only enforced for accountMode="create", where Polaris is the one creating the
 * account. An existing account is the operator's to name: it demonstrably
 * exists, so a length rule here could only refuse something that already works.
 */
const WINDOWS_CREATE_USERNAME_MAX = 20;

/**
 * `New-LocalUser -Description` is capped at 48 characters and throws
 * ParameterArgumentValidationError above it. The string below is interpolated
 * into the emitted script, so this is asserted by a unit test rather than left
 * to whoever next edits the wording — the failure lands on the endpoint, not
 * here, and create mode shipped broken on a 68-character description.
 */
export const WINDOWS_ACCOUNT_DESCRIPTION = "Polaris Agent deployment (SSH key auth only)";
export const WINDOWS_DESCRIPTION_MAX = 48;

/**
 * An authorized_keys line: algorithm, base64 blob, optional comment. The
 * comment is the only free-form part, so it is held to a conservative charset
 * (no quotes, no newlines) instead of being escaped.
 */
const PUBLIC_KEY_RE =
  /^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp256|ecdsa-sha2-nistp384|ecdsa-sha2-nistp521) [A-Za-z0-9+/]+={0,3}( [A-Za-z0-9._@ -]{0,128})?$/;

export function assertValidPublicKey(publicKey: string): string {
  const k = String(publicKey ?? "").trim();
  if (!k) throw new AppError(400, "No SSH public key has been generated yet");
  if (!PUBLIC_KEY_RE.test(k)) {
    throw new AppError(400, "SSH public key is not a well-formed authorized_keys line");
  }
  return k;
}

/**
 * POSIX-ish account name. Deliberately tighter than the Windows rule: no
 * backslash (there is no DOMAIN\user on Linux), lowercase-leading, and capped
 * at the 32-char limit useradd enforces on most distros.
 */
const LINUX_USERNAME_RE = /^[a-z_][a-z0-9_-]{0,31}$/;

export function assertValidLinuxUsername(username: string): string {
  const u = String(username ?? "").trim();
  if (!u) throw new AppError(400, "A Linux username is required");
  if (u.includes("\\")) {
    throw new AppError(400, "Linux usernames have no DOMAIN\\user form — use the bare account name");
  }
  if (!LINUX_USERNAME_RE.test(u)) {
    throw new AppError(
      400,
      "Linux username must start with a lowercase letter or underscore and contain only lowercase letters, digits, dash and underscore (max 32 chars)",
    );
  }
  return u;
}

export function assertValidUsername(username: string, accountMode: SshOnboardingAccountMode): string {
  const u = String(username ?? "").trim();
  if (!u) throw new AppError(400, "A Windows username is required");
  const isDomain = u.includes("\\");
  if (isDomain && accountMode === "create") {
    // New-LocalUser cannot create a domain account, and silently emitting a
    // script that would fail on every endpoint is worse than refusing here.
    throw new AppError(
      400,
      'A domain account (DOMAIN\\user) cannot be created locally — use the "existing account" mode for it',
    );
  }
  if (!(isDomain ? DOMAIN_USERNAME_RE : USERNAME_RE).test(u)) {
    throw new AppError(
      400,
      "Windows username may only contain letters, digits, dot, dash and underscore (optionally DOMAIN\\user)",
    );
  }
  if (accountMode === "create" && u.length > WINDOWS_CREATE_USERNAME_MAX) {
    throw new AppError(
      400,
      `A local Windows account name is limited to ${WINDOWS_CREATE_USERNAME_MAX} characters — ` +
        `"${u}" is ${u.length}. Shorten it, or use the "existing account" mode to name an account that already exists.`,
    );
  }
  return u;
}

export function assertValidServerIp(ip: string | undefined | null): string {
  const v = String(ip ?? "").trim();
  if (!v) return "";
  // -RemoteAddress accepts a bare address or a CIDR range; allow both.
  if (!isValidIpv4(v) && !isValidCidr(v)) {
    throw new AppError(400, "Polaris server address must be an IPv4 address or CIDR range");
  }
  return v;
}

/**
 * Wrap a validated value as a PowerShell single-quoted literal. Single quotes
 * are literal in PowerShell (no expansion), and the only escape needed is
 * doubling an embedded quote. Validation above already excludes quotes; this
 * is belt-and-braces so a future regex loosening can't become an injection.
 */
function psLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

// ─── Shared PowerShell fragments ──────────────────────────────────────────

/**
 * Helpers emitted into BOTH the remediation and the detection script, so the
 * pair can never disagree about what "already onboarded" means — the Windows
 * counterpart of POLARIS_SH_HELPERS.
 *
 * Test-PolarisKeyPresent matches on the key BODY — algorithm + base64 — and
 * deliberately ignores the trailing comment, so re-running after a comment
 * change doesn't append a duplicate line.
 */
const POLARIS_PS_HELPERS = `
function Test-PolarisKeyPresent {
  param([string[]] $Lines, [string] $Key)
  $wantParts = @($Key.Trim() -split '\\s+')
  if ($wantParts.Count -lt 2) { return $false }
  $want = $wantParts[0] + ' ' + $wantParts[1]
  foreach ($line in $Lines) {
    if ([string]::IsNullOrWhiteSpace($line)) { continue }
    $parts = @($line.Trim() -split '\\s+')
    if ($parts.Count -ge 2 -and (($parts[0] + ' ' + $parts[1]) -eq $want)) { return $true }
  }
  return $false
}

function Get-PolarisAuthorizedKeysPath {
  return (Join-Path $env:ProgramData 'ssh\\administrators_authorized_keys')
}

function Get-PolarisSshCapability {
  return (Get-WindowsCapability -Online -Name 'OpenSSH.Server*' | Select-Object -First 1)
}

function Get-PolarisAdminGroupName {
  # By SID: "Administrators" is localized and does not resolve on a German or
  # French install.
  return (Get-LocalGroup -SID __SID_ADMINS__).Name
}

function Test-PolarisLocalAdmin {
  param([string] $Account)
  $groupName = Get-PolarisAdminGroupName
  $members = @()
  try {
    $members = @(Get-LocalGroupMember -Group $groupName -ErrorAction Stop |
                 ForEach-Object { $_.Name })
  } catch {
    # An Entra-joined endpoint routinely holds members whose SID no longer
    # resolves. Depending on the build, Get-LocalGroupMember either returns
    # those as raw 'S-1-12-1-...' strings (harmless — they cannot match an
    # account name) or throws outright and yields nothing. The WinNT provider
    # enumerates the same group without resolving every member, so one stale
    # ACE cannot make the whole check unanswerable.
    $members = @(([ADSI]('WinNT://./' + $groupName + ',group')).psbase.Invoke('Members') |
                 ForEach-Object { ([ADSI]$_).InvokeGet('Name') })
  }
  # Compare on the leaf name: the same member reads as 'DOMAIN\\user' from
  # Get-LocalGroupMember and bare 'user' from the WinNT provider, and the
  # configured account may itself carry a domain prefix. The cost is that a
  # local 'svc' and a domain 'CORP\\svc' are indistinguishable here — accepted,
  # because the alternative is a check that silently answers "no" for whichever
  # form the endpoint happens to report. -eq is case-insensitive.
  $wantLeaf = $Account.Split('\\')[-1]
  foreach ($m in $members) {
    if ([string]::IsNullOrWhiteSpace($m)) { continue }
    if ($m.Split('\\')[-1] -eq $wantLeaf) { return $true }
  }
  return $false
}
`.trim();

// ─── Remediation script ───────────────────────────────────────────────────

const WINDOWS_ONBOARDING_PS = `
# ---------------------------------------------------------------------------
# Polaris — Windows SSH onboarding (REMEDIATION)
#
# Prepares this machine so Polaris can install the Polaris Agent over SSH:
#   1. installs + starts the OpenSSH Server capability
#   2. __ACCOUNT_SUMMARY__
#   3. authorizes the Polaris public key for administrator logons
#   4. __FIREWALL_SUMMARY__
#
# Generated by Polaris. Contains no machine-specific values, so the same file
# runs unchanged on every endpoint in the fleet.
#
# HOW TO RUN IT
#   Intune  : Remediations (pair with the detection script so drift self-heals)
#             or Devices > Scripts. Run as SYSTEM, 64-bit PowerShell host = Yes.
#   GPO     : Computer Config > Policies > Windows Settings > Scripts > Startup.
#   SCCM    : Configuration Baseline, paired with the detection script.
#   Arc/RMM : any run-as-SYSTEM script job.
#   Ad hoc  : Invoke-Command -ComputerName ... -FilePath <this file>
#
# Idempotent: safe to run on every boot / every remediation cycle.
# Requires Windows 10 1809 / Server 2019 or later (older builds have no
# OpenSSH Server capability); on those it reports and exits 0 rather than
# failing forever.
#
# REVIEW BEFORE DEPLOYING. This grants fleet-wide administrative SSH access.
# ---------------------------------------------------------------------------

$ErrorActionPreference = 'Stop'

$PolarisPublicKey = __PUBLIC_KEY__
$PolarisUser      = __USERNAME__

__PS_HELPERS__

# --- 1. OpenSSH Server capability --------------------------------------------
$cap = Get-PolarisSshCapability
if (-not $cap) {
  Write-Host 'unsupported: this Windows build has no OpenSSH Server capability (needs Windows 10 1809 / Server 2019 or later)'
  exit 0
}
if ($cap.State -ne 'Installed') {
  Write-Host ('Installing ' + $cap.Name)
  Add-WindowsCapability -Online -Name $cap.Name | Out-Null
} else {
  Write-Host 'OpenSSH Server already installed'
}

Set-Service -Name sshd -StartupType Automatic
if ((Get-Service -Name sshd).Status -ne 'Running') {
  Start-Service -Name sshd
  Write-Host 'Started sshd'
} else {
  Write-Host 'sshd already running'
}

__ACCOUNT_BLOCK__

# --- 3. Authorize the Polaris public key -------------------------------------
# Windows OpenSSH ignores the per-user authorized_keys for anyone in the
# Administrators group and reads ONLY this file. Getting this wrong does not
# raise an error — authentication just fails.
$authKeys = Get-PolarisAuthorizedKeysPath
$authDir  = Split-Path -Path $authKeys -Parent
if (-not (Test-Path -LiteralPath $authDir)) {
  New-Item -ItemType Directory -Force -Path $authDir | Out-Null
}

$existingLines = @()
if (Test-Path -LiteralPath $authKeys) {
  $existingLines = @(Get-Content -LiteralPath $authKeys -ErrorAction SilentlyContinue)
}

if (Test-PolarisKeyPresent -Lines $existingLines -Key $PolarisPublicKey) {
  Write-Host 'Polaris key already authorized'
} else {
  # Append — never overwrite. Other keys in this file belong to someone else.
  Add-Content -LiteralPath $authKeys -Value $PolarisPublicKey -Encoding ascii
  Write-Host 'Authorized the Polaris key'
}

# sshd refuses administrators_authorized_keys unless it is owned by
# Administrators/SYSTEM, inheritance is off, and no other ACEs are present.
# Well-known SIDs, not names — group names are localized.
$adminSid  = New-Object System.Security.Principal.SecurityIdentifier(__SID_ADMINS__)
$systemSid = New-Object System.Security.Principal.SecurityIdentifier(__SID_SYSTEM__)

$acl = Get-Acl -LiteralPath $authKeys
$acl.SetAccessRuleProtection($true, $false)
foreach ($ace in @($acl.Access)) { [void]$acl.RemoveAccessRule($ace) }
$acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($adminSid, 'FullControl', 'Allow')))
$acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($systemSid, 'FullControl', 'Allow')))
$acl.SetOwner($adminSid)
Set-Acl -LiteralPath $authKeys -AclObject $acl
Write-Host 'Applied authorized_keys ACL (Administrators + SYSTEM only)'

__FIREWALL_BLOCK__

Write-Host 'Polaris SSH onboarding complete'
exit 0
`.trim();

/** Emitted only for accountMode="create". */
const ACCOUNT_CREATE_PS = `
# --- 2. Local administrator account ------------------------------------------
# Key-only authentication: the password is randomly generated, never used by
# Polaris, and never stored anywhere.
if (-not (Get-LocalUser -Name $PolarisUser -ErrorAction SilentlyContinue)) {
  $pwBytes = New-Object byte[] 32
  [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($pwBytes)
  $pwPlain = [Convert]::ToBase64String($pwBytes) + '!Aa1'
  New-LocalUser -Name $PolarisUser \`
                -Password (ConvertTo-SecureString $pwPlain -AsPlainText -Force) \`
                -FullName 'Polaris Agent Deployment' \`
                -Description '${WINDOWS_ACCOUNT_DESCRIPTION}' \`
                -PasswordNeverExpires -AccountNeverExpires | Out-Null
  Remove-Variable pwPlain, pwBytes
  Write-Host ('Created local account ' + $PolarisUser)
} else {
  Write-Host ('Local account ' + $PolarisUser + ' already exists')
}

$adminGroupName = Get-PolarisAdminGroupName
if (-not (Test-PolarisLocalAdmin -Account $PolarisUser)) {
  Add-LocalGroupMember -Group $adminGroupName -Member $PolarisUser
  Write-Host ('Added ' + $PolarisUser + ' to ' + $adminGroupName)
} else {
  Write-Host ($PolarisUser + ' already an administrator')
}
`.trim();

/**
 * Emitted only for accountMode="existing".
 *
 * Refuses rather than continuing when the named account is absent or is not an
 * administrator — the Linux half has always done this and Windows did not,
 * which is the whole failure this block exists to stop: the script would print
 * "Using existing account", authorize the key anyway, exit 0, and leave an
 * endpoint that reports fully onboarded and can never accept a logon. The
 * installer writes to %ProgramFiles% and registers a service, and sshd reads
 * administrators_authorized_keys for administrators only, so neither condition
 * is optional.
 */
const ACCOUNT_EXISTING_PS = `
# --- 2. Account check ---------------------------------------------------------
# Using an existing account: this script does not create or modify it, but it
# does verify it, because authorizing a key for an account that is not there
# fails silently at logon time with nothing to diagnose.
# A domain account is invisible to Get-LocalUser; its Administrators membership
# is the only half this script can observe.
if (-not $PolarisUser.Contains('\\')) {
  $existingUser = Get-LocalUser -Name $PolarisUser -ErrorAction SilentlyContinue
  if (-not $existingUser) {
    Write-Host ('error: account ' + $PolarisUser + ' does not exist on this host')
    exit 1
  }
  if (-not $existingUser.Enabled) {
    Write-Host ('error: account ' + $PolarisUser + ' is disabled on this host')
    exit 1
  }
}
if (-not (Test-PolarisLocalAdmin -Account $PolarisUser)) {
  Write-Host ('error: account ' + $PolarisUser + ' is not a member of ' + (Get-PolarisAdminGroupName))
  exit 1
}
Write-Host ('Using existing account ' + $PolarisUser + ' (not created by this script)')
`.trim();

/**
 * Emitted only when a Polaris server address was supplied.
 *
 * Two rules decide whether sshd is reachable and only one of them is ours: the
 * Polaris rule allows TCP/22 from the Polaris server on EVERY profile, and
 * Windows' own rule allows it from everywhere on Private alone (see
 * OPENSSH_BUILTIN_RULE_NAME). Because allows are additive, the built-in rule is
 * disabled rather than left alongside — otherwise "scoped to the Polaris
 * server" is a sentence the firewall does not agree with, and the endpoint is
 * still unreachable the moment it joins a domain network.
 */
const FIREWALL_PS = `
# --- 4. Scope inbound TCP/22 to the Polaris server -----------------------------
$fwName = __FW_NAME__
$existingRule = Get-NetFirewallRule -DisplayName $fwName -ErrorAction SilentlyContinue
if ($existingRule) { $existingRule | Remove-NetFirewallRule }
New-NetFirewallRule -DisplayName $fwName \`
                    -Direction Inbound -Protocol TCP -LocalPort 22 \`
                    -RemoteAddress __SERVER_IP__ \`
                    -Action Allow -Profile Any | Out-Null
Write-Host ('Firewall rule set: TCP/22 inbound from ' + __SERVER_IP__ + ' on every profile (Domain, Private, Public)')

# Windows' own OpenSSH rule allows TCP/22 from ANY source, and only on Private.
# Leaving it enabled would keep port 22 open to every host on a Private network
# no matter how tightly the rule above is scoped, so it goes off and the Polaris
# rule becomes the only inbound path to sshd.
$builtInRules = @(Get-NetFirewallRule -Name __BUILTIN_FW_NAME__ -ErrorAction SilentlyContinue)
if ($builtInRules.Count -eq 0) {
  Write-Host 'No built-in OpenSSH firewall rule present — the Polaris rule is the only one'
} else {
  foreach ($rule in $builtInRules) {
    if ($rule.Enabled -eq 'True') {
      Disable-NetFirewallRule -Name $rule.Name
      Write-Host ('Disabled ' + $rule.Name + ' (it allowed TCP/22 from any source)')
    } else {
      Write-Host ('Built-in rule ' + $rule.Name + ' already disabled')
    }
  }
}
`.trim();

/**
 * Emitted when no server address was supplied. Still fixes the PROFILE of
 * Windows' built-in rule — a domain-joined endpoint is unreachable without it —
 * while leaving the set of permitted sources exactly as Windows wrote it.
 *
 * Public is deliberately not added. The reachable-from-Domain problem is the
 * one being fixed; enabling an any-source rule for TCP/22 on the profile a
 * laptop picks up in an airport is not part of it.
 */
const NO_FIREWALL_PS = `
# --- 4. Firewall --------------------------------------------------------------
# No Polaris server address was configured, so this script opens nothing and
# scopes nothing. Restrict inbound TCP/22 separately — the built-in rule below
# leaves it open to every source, which is a much wider exposure than Polaris
# needs.
#
# What does get fixed is the rule's PROFILE. Windows creates its OpenSSH rule
# for the Private profile only, so on a domain-joined endpoint — active profile
# Domain — sshd is unreachable even though it is installed and running, with
# nothing in the service or the event log to say so. Adding Domain changes which
# NETWORKS the rule applies on, never which sources may connect.
$builtInRules = @(Get-NetFirewallRule -Name __BUILTIN_FW_NAME__ -ErrorAction SilentlyContinue)
if ($builtInRules.Count -eq 0) {
  Write-Host 'Firewall: not modified (no Polaris server address configured, no built-in OpenSSH rule found)'
} else {
  foreach ($rule in $builtInRules) {
    $ruleProfile = [string]$rule.Profile
    if ($ruleProfile -eq 'Any' -or $ruleProfile -match 'Domain') {
      Write-Host ('Built-in rule ' + $rule.Name + ' already covers the Domain profile (' + $ruleProfile + ')')
    } else {
      Set-NetFirewallRule -Name $rule.Name -Profile Domain,Private
      Write-Host ('Widened ' + $rule.Name + ' from profile ' + $ruleProfile + ' to Domain, Private')
    }
  }
}
`.trim();

/**
 * Build the remediation script. Throws AppError on any invalid input rather
 * than emitting a script that would misbehave fleet-wide.
 */
export function buildWindowsOnboardingScript(opts: WindowsOnboardingScriptOptions): string {
  const publicKey = assertValidPublicKey(opts.publicKey);
  const username = assertValidUsername(opts.username, opts.accountMode);
  const serverIp = assertValidServerIp(opts.polarisServerIp);
  if (opts.accountMode !== "create" && opts.accountMode !== "existing") {
    throw new AppError(400, 'Account mode must be "create" or "existing"');
  }

  const accountBlock =
    opts.accountMode === "create"
      ? ACCOUNT_CREATE_PS.replace(/__SID_ADMINS__/g, psLiteral(SID_ADMINISTRATORS))
      : ACCOUNT_EXISTING_PS;

  const firewallBlock = (serverIp
    ? FIREWALL_PS
        .replace(/__FW_NAME__/g, psLiteral(FIREWALL_RULE_NAME))
        .replace(/__SERVER_IP__/g, psLiteral(serverIp))
    : NO_FIREWALL_PS
  ).replace(/__BUILTIN_FW_NAME__/g, psLiteral(OPENSSH_BUILTIN_RULE_NAME));

  return WINDOWS_ONBOARDING_PS
    .replace(/__PUBLIC_KEY__/g, psLiteral(publicKey))
    .replace(/__USERNAME__/g, psLiteral(username))
    .replace(/__PS_HELPERS__/g, POLARIS_PS_HELPERS)
    .replace(/__ACCOUNT_BLOCK__/g, accountBlock)
    .replace(/__FIREWALL_BLOCK__/g, firewallBlock)
    .replace(/__SID_ADMINS__/g, psLiteral(SID_ADMINISTRATORS))
    .replace(/__SID_SYSTEM__/g, psLiteral(SID_SYSTEM))
    .replace(
      /__ACCOUNT_SUMMARY__/g,
      opts.accountMode === "create"
        ? `creates the local administrator account '${username}'`
        : `uses the existing administrator account '${username}'`,
    )
    .replace(
      /__FIREWALL_SUMMARY__/g,
      serverIp
        ? `scopes inbound TCP/22 to ${serverIp} on every profile, and disables Windows' own any-source OpenSSH rule`
        : "opens nothing, but extends Windows' own OpenSSH rule to the Domain profile so a domain-joined endpoint is reachable",
    );
}

// ─── Detection script ─────────────────────────────────────────────────────

const WINDOWS_DETECTION_PS = `
# ---------------------------------------------------------------------------
# Polaris — Windows SSH onboarding (DETECTION)
#
# Exit 0 = already onboarded, no action needed.
# Exit 1 = remediation required (run the onboarding script).
#
# Pair this with the remediation script in an Intune Remediation or an SCCM
# Configuration Baseline. That pairing is what makes fleet rollout self-heal:
# a plain platform script runs once per device and never retries, so machines
# that were offline at assignment time, or reimaged afterwards, stay
# unconfigured forever without it.
#
# An unsupported Windows build reports 'unsupported: ...' and exits 0 on
# purpose — remediation cannot fix a missing OS capability, and returning 1
# would loop the pair against that device forever.
#
# Run as SYSTEM, 64-bit PowerShell host = Yes.
# ---------------------------------------------------------------------------

$ErrorActionPreference = 'Stop'

$PolarisPublicKey = __PUBLIC_KEY__
$PolarisUser      = __USERNAME__

__PS_HELPERS__

try {
  $cap = Get-PolarisSshCapability
  if (-not $cap) {
    Write-Host 'unsupported: no OpenSSH Server capability on this Windows build'
    exit 0
  }
  if ($cap.State -ne 'Installed') {
    Write-Host 'remediate: OpenSSH Server not installed'
    exit 1
  }

  $svc = Get-Service -Name sshd -ErrorAction SilentlyContinue
  if (-not $svc) {
    Write-Host 'remediate: sshd service missing'
    exit 1
  }
  if ($svc.Status -ne 'Running') {
    Write-Host 'remediate: sshd not running'
    exit 1
  }

  # The account and its Administrators membership are prerequisites the agent
  # install genuinely fails on, and the key below is only usable by an
  # administrator — administrators_authorized_keys is read for nobody else.
  # A domain account is invisible to Get-LocalUser, so for one of those the
  # group membership below is the only observable half.
  if (-not $PolarisUser.Contains('\\')) {
    $localUser = Get-LocalUser -Name $PolarisUser -ErrorAction SilentlyContinue
    if (-not $localUser) {
      Write-Host ('remediate: local account ' + $PolarisUser + ' missing')
      exit 1
    }
    if (-not $localUser.Enabled) {
      Write-Host ('remediate: local account ' + $PolarisUser + ' is disabled')
      exit 1
    }
  }
  if (-not (Test-PolarisLocalAdmin -Account $PolarisUser)) {
    Write-Host ('remediate: ' + $PolarisUser + ' is not a member of ' + (Get-PolarisAdminGroupName))
    exit 1
  }

  $authKeys = Get-PolarisAuthorizedKeysPath
  if (-not (Test-Path -LiteralPath $authKeys)) {
    Write-Host 'remediate: administrators_authorized_keys missing'
    exit 1
  }
  $lines = @(Get-Content -LiteralPath $authKeys -ErrorAction SilentlyContinue)
  if (-not (Test-PolarisKeyPresent -Lines $lines -Key $PolarisPublicKey)) {
    Write-Host 'remediate: Polaris key not authorized'
    exit 1
  }

  Write-Host ('ok: Polaris SSH onboarding present (' + $PolarisUser + ' is a local administrator)')
  exit 0
} catch {
  Write-Host ('remediate: detection error - ' + $_.Exception.Message)
  exit 1
}
`.trim();

/**
 * Build the detection half of the pair. Checks the account and its
 * Administrators membership as well as the key — the same prerequisites the
 * Linux half checks, for the same reason: the agent install genuinely fails
 * without them, and sshd reads administrators_authorized_keys for nobody but
 * an administrator. Omitting them let an endpoint whose account was never
 * created report "ok" forever while no logon could ever succeed.
 *
 * Both modes are checked, because both are satisfiable: create mode provisions
 * the account, and existing mode now FAILS LOUDLY when the named account is
 * absent instead of authorizing a key for nobody. What stays out is the
 * firewall — with no server IP configured there is no Polaris rule to find, so
 * checking it would be the one loop the pair cannot break out of. The same
 * argument now covers Windows' built-in OpenSSH rule: remediation disables it
 * when a server IP is set and widens it to Domain when one is not, and this
 * builder is not told which, so either state would read as drift half the time.
 */
export function buildWindowsOnboardingDetectionScript(opts: {
  publicKey: string;
  username: string;
  accountMode: SshOnboardingAccountMode;
}): string {
  const publicKey = assertValidPublicKey(opts.publicKey);
  const username = assertValidUsername(opts.username, opts.accountMode);
  return WINDOWS_DETECTION_PS
    .replace(/__PUBLIC_KEY__/g, psLiteral(publicKey))
    .replace(/__USERNAME__/g, psLiteral(username))
    .replace(/__PS_HELPERS__/g, POLARIS_PS_HELPERS)
    .replace(/__SID_ADMINS__/g, psLiteral(SID_ADMINISTRATORS));
}

// ─── Linux ────────────────────────────────────────────────────────────────
//
// Not a translation of the Windows script — the two platforms differ in three
// ways that matter:
//
//  1. The key goes in the USER's ~/.ssh/authorized_keys (700 dir / 600 file,
//     owned by that user), not one group-wide file. sshd silently refuses a
//     world-writable .ssh or a wrongly-owned authorized_keys, exactly as it
//     refuses a bad ACL on Windows.
//  2. **Key auth does not remove the sudo requirement.** The agent installer
//     runs `sudo -n bash /tmp/polaris-agent-install.sh` (and separate
//     uninstall/upgrade scripts). Without passwordless sudo the install fails
//     no matter how the SSH auth succeeded, so onboarding that only installed
//     the key would just move the manual step. Hence the sudoers drop-in.
//  3. SELinux. On RHEL-family hosts a hand-created ~/.ssh carries the wrong
//     context and sshd refuses it — another silent failure, fixed with
//     restorecon when the tool is present.
//
// Deliberately NOT installed by this script: openssh-server. That needs
// distro-specific package management, and a host you cannot already reach over
// SSH is not one this script was delivered to. It detects and reports instead.

/** Sudoers drop-in path. Also the detection key. */
const LINUX_SUDOERS_PATH = "/etc/sudoers.d/polaris-agent";

/**
 * Shared shell helpers, emitted into BOTH Linux scripts from one place so the
 * detection script cannot disagree with what remediation wrote. Mirrors the
 * PowerShell POLARIS_PS_HELPERS.
 *
 * Matches on the key BODY (algorithm + base64) and ignores the comment, so a
 * comment change does not append a duplicate line.
 */
const POLARIS_SH_HELPERS = `
polaris_key_body() {
  # "<type> <base64>" — the comment is deliberately dropped.
  awk '{ print $1 " " $2 }' <<< "$1"
}

polaris_key_present() {
  # $1 = authorized_keys path, $2 = full key line
  local file="$1" want
  want="$(polaris_key_body "$2")"
  [ -f "$file" ] || return 1
  while IFS= read -r line; do
    [ -z "$line" ] && continue
    [ "$(polaris_key_body "$line")" = "$want" ] && return 0
  done < "$file"
  return 1
}

polaris_home_for() {
  getent passwd "$1" | cut -d: -f6
}
`.trim();

const LINUX_ONBOARDING_SH = `#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Polaris — Linux SSH onboarding (REMEDIATION)
#
# Prepares this machine so Polaris can install the Polaris Agent over SSH:
#   1. __ACCOUNT_SUMMARY__
#   2. authorizes the Polaris public key for that account
#   3. grants passwordless sudo via __SUDOERS_PATH__
#   4. __FIREWALL_SUMMARY__
#
# Generated by Polaris. Contains no machine-specific values, so the same file
# runs unchanged on every host in the fleet.
#
# Run as root. Idempotent — safe to re-run on every boot / config-management
# pass.
#
# HOW TO RUN IT
#   Ansible  : ansible all -b -m script -a polaris-ssh-onboarding.sh
#   Salt/Chef/Puppet : any run-as-root file/script resource
#   cloud-init : runcmd
#   Ad hoc   : scp it over, then  sudo bash polaris-ssh-onboarding.sh
#
# WHY PASSWORDLESS SUDO. The agent installer runs
# 'sudo -n bash /tmp/polaris-agent-install.sh' (plus separate uninstall and
# upgrade scripts), so SSH key auth alone is not enough to install the agent.
# This grants NOPASSWD:ALL to the account below — effectively passwordless root
# on this host for anyone holding the Polaris private key.
#
# REVIEW BEFORE DEPLOYING. This grants fleet-wide passwordless root.
# ---------------------------------------------------------------------------

set -euo pipefail

POLARIS_PUBLIC_KEY=__PUBLIC_KEY__
POLARIS_USER=__USERNAME__
POLARIS_SUDOERS=__SUDOERS_PATH__

__SH_HELPERS__

if [ "$(id -u)" -ne 0 ]; then
  echo "error: must run as root (it creates a sudoers drop-in and writes another user's authorized_keys)" >&2
  exit 1
fi

# --- 1. Account -------------------------------------------------------------
__ACCOUNT_BLOCK__

POLARIS_HOME="$(polaris_home_for "$POLARIS_USER")"
if [ -z "$POLARIS_HOME" ] || [ ! -d "$POLARIS_HOME" ]; then
  echo "error: no home directory for $POLARIS_USER — cannot install an authorized_keys file" >&2
  exit 1
fi

# --- 2. Authorize the Polaris public key ------------------------------------
# sshd silently refuses a group/world-writable .ssh or a wrongly-owned
# authorized_keys, so the modes and ownership below are load-bearing.
SSH_DIR="$POLARIS_HOME/.ssh"
AUTH_KEYS="$SSH_DIR/authorized_keys"

mkdir -p "$SSH_DIR"
chmod 700 "$SSH_DIR"
touch "$AUTH_KEYS"
chmod 600 "$AUTH_KEYS"
chown -R "$POLARIS_USER" "$SSH_DIR"

if polaris_key_present "$AUTH_KEYS" "$POLARIS_PUBLIC_KEY"; then
  echo "Polaris key already authorized for $POLARIS_USER"
else
  # Append — never overwrite. Other keys in this file belong to someone else.
  printf '%s\\n' "$POLARIS_PUBLIC_KEY" >> "$AUTH_KEYS"
  echo "Authorized the Polaris key for $POLARIS_USER"
fi

# RHEL-family: a hand-created ~/.ssh carries the wrong SELinux context and
# sshd refuses it, with nothing useful on the client.
if command -v restorecon >/dev/null 2>&1; then
  restorecon -R "$SSH_DIR" 2>/dev/null || true
fi

# --- 3. Passwordless sudo ---------------------------------------------------
# Validate BEFORE installing: a malformed drop-in can lock sudo out entirely
# for every user on the host, which is far worse than a failed onboarding.
SUDOERS_TMP="$(mktemp)"
trap 'rm -f "$SUDOERS_TMP"' EXIT
printf '# Managed by Polaris — passwordless sudo for the agent installer.\\n%s ALL=(ALL) NOPASSWD:ALL\\n' "$POLARIS_USER" > "$SUDOERS_TMP"
chmod 0440 "$SUDOERS_TMP"

if command -v visudo >/dev/null 2>&1; then
  if ! visudo -cf "$SUDOERS_TMP" >/dev/null; then
    echo "error: generated sudoers drop-in failed validation — refusing to install it" >&2
    exit 1
  fi
else
  echo "warning: visudo not found; installing the sudoers drop-in unvalidated" >&2
fi

if [ -f "$POLARIS_SUDOERS" ] && cmp -s "$SUDOERS_TMP" "$POLARIS_SUDOERS"; then
  echo "sudoers drop-in already current"
else
  install -m 0440 -o root -g root "$SUDOERS_TMP" "$POLARIS_SUDOERS"
  echo "Installed $POLARIS_SUDOERS"
fi

# --- 4. sshd ----------------------------------------------------------------
# Not installed here: that needs distro-specific package management, and a host
# you cannot already reach over SSH is not one this script was delivered to.
if command -v systemctl >/dev/null 2>&1; then
  if systemctl list-unit-files 2>/dev/null | grep -qE '^(sshd|ssh)\\.service'; then
    SSHD_UNIT=sshd.service
    systemctl list-unit-files 2>/dev/null | grep -qE '^sshd\\.service' || SSHD_UNIT=ssh.service
    systemctl enable "$SSHD_UNIT" >/dev/null 2>&1 || true
    systemctl start "$SSHD_UNIT" >/dev/null 2>&1 || true
    echo "sshd unit: $SSHD_UNIT enabled and started"
  else
    echo "warning: no sshd/ssh systemd unit found — install openssh-server for this host to be reachable" >&2
  fi
fi

__FIREWALL_BLOCK__

echo "Polaris SSH onboarding complete"
exit 0
`.trim();

const LINUX_ACCOUNT_CREATE_SH = `
# Key-only authentication: the account is created with NO password and left
# locked, so it can never be used for a password logon.
if id -u "$POLARIS_USER" >/dev/null 2>&1; then
  echo "Account $POLARIS_USER already exists"
else
  useradd --create-home --shell /bin/bash --comment "Polaris Agent deployment" "$POLARIS_USER"
  passwd --lock "$POLARIS_USER" >/dev/null 2>&1 || true
  echo "Created account $POLARIS_USER (password locked; key auth only)"
fi
`.trim();

const LINUX_ACCOUNT_EXISTING_SH = `
# Using an existing account: this script does not create or modify it beyond
# its authorized_keys and the sudoers drop-in below.
if ! id -u "$POLARIS_USER" >/dev/null 2>&1; then
  echo "error: account $POLARIS_USER does not exist on this host" >&2
  exit 1
fi
echo "Using existing account $POLARIS_USER (not created by this script)"
`.trim();

const LINUX_FIREWALL_SH = `
# --- 5. Scope inbound TCP/22 to the Polaris server --------------------------
# Only the two common front-ends are handled; a host using raw nftables or a
# cloud security group is left alone rather than guessed at.
POLARIS_SERVER=__SERVER_IP__
if command -v firewall-cmd >/dev/null 2>&1 && firewall-cmd --state >/dev/null 2>&1; then
  firewall-cmd --permanent --remove-rich-rule="rule family=ipv4 source address=$POLARIS_SERVER service name=ssh accept" >/dev/null 2>&1 || true
  firewall-cmd --permanent --add-rich-rule="rule family=ipv4 source address=$POLARIS_SERVER service name=ssh accept" >/dev/null
  firewall-cmd --reload >/dev/null
  echo "firewalld: allowed ssh from $POLARIS_SERVER"
elif command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q "Status: active"; then
  ufw allow from "$POLARIS_SERVER" to any port 22 proto tcp >/dev/null
  echo "ufw: allowed tcp/22 from $POLARIS_SERVER"
else
  echo "firewall: neither firewalld nor ufw is active — not modified"
fi
`.trim();

const LINUX_NO_FIREWALL_SH = `
# --- 5. Firewall ------------------------------------------------------------
# No Polaris server address was configured, so this script does not touch the
# firewall. Restrict inbound TCP/22 separately.
echo "firewall: not modified (no Polaris server address configured)"
`.trim();

/** Shell single-quoted literal; validated input, so the escape is belt-and-braces. */
function shLiteral(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export interface LinuxOnboardingScriptOptions {
  publicKey: string;
  username: string;
  accountMode: SshOnboardingAccountMode;
  polarisServerIp?: string;
}

/**
 * Build the Linux remediation script. Same contract as the Windows one:
 * validated inputs, idempotent output, hard reject on anything unsafe.
 */
export function buildLinuxOnboardingScript(opts: LinuxOnboardingScriptOptions): string {
  const publicKey = assertValidPublicKey(opts.publicKey);
  const username = assertValidLinuxUsername(opts.username);
  const serverIp = assertValidServerIp(opts.polarisServerIp);
  if (opts.accountMode !== "create" && opts.accountMode !== "existing") {
    throw new AppError(400, 'Account mode must be "create" or "existing"');
  }

  const accountBlock =
    opts.accountMode === "create" ? LINUX_ACCOUNT_CREATE_SH : LINUX_ACCOUNT_EXISTING_SH;
  const firewallBlock = serverIp
    ? LINUX_FIREWALL_SH.replace(/__SERVER_IP__/g, shLiteral(serverIp))
    : LINUX_NO_FIREWALL_SH;

  return LINUX_ONBOARDING_SH
    .replace(/__PUBLIC_KEY__/g, shLiteral(publicKey))
    .replace(/__USERNAME__/g, shLiteral(username))
    .replace(/__SUDOERS_PATH__/g, shLiteral(LINUX_SUDOERS_PATH))
    .replace(/__SH_HELPERS__/g, POLARIS_SH_HELPERS)
    .replace(/__ACCOUNT_BLOCK__/g, accountBlock)
    .replace(/__FIREWALL_BLOCK__/g, firewallBlock)
    .replace(
      /__ACCOUNT_SUMMARY__/g,
      opts.accountMode === "create"
        ? `creates the local account '${username}' (password locked, key auth only)`
        : `uses the existing account '${username}'`,
    )
    .replace(
      /__FIREWALL_SUMMARY__/g,
      serverIp ? `scopes inbound TCP/22 to ${serverIp}` : "leaves the firewall alone",
    );
}

const LINUX_DETECTION_SH = `#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Polaris — Linux SSH onboarding (DETECTION)
#
# Exit 0 = already onboarded, no action needed.
# Exit 1 = remediation required (run the onboarding script).
#
# Pair with the remediation script in any config-management tool that supports
# a check/apply split (Ansible 'creates', Salt onlyif, an SCCM-style baseline),
# so a reimaged or previously-unreachable host self-heals instead of staying
# unconfigured.
#
# Run as root: it reads another user's authorized_keys and /etc/sudoers.d.
# ---------------------------------------------------------------------------

set -uo pipefail

POLARIS_PUBLIC_KEY=__PUBLIC_KEY__
POLARIS_USER=__USERNAME__
POLARIS_SUDOERS=__SUDOERS_PATH__

__SH_HELPERS__

if ! id -u "$POLARIS_USER" >/dev/null 2>&1; then
  echo "remediate: account $POLARIS_USER missing"
  exit 1
fi

POLARIS_HOME="$(polaris_home_for "$POLARIS_USER")"
if [ -z "$POLARIS_HOME" ]; then
  echo "remediate: no home directory for $POLARIS_USER"
  exit 1
fi

if ! polaris_key_present "$POLARIS_HOME/.ssh/authorized_keys" "$POLARIS_PUBLIC_KEY"; then
  echo "remediate: Polaris key not authorized for $POLARIS_USER"
  exit 1
fi

if [ ! -f "$POLARIS_SUDOERS" ]; then
  echo "remediate: sudoers drop-in missing (agent install needs passwordless sudo)"
  exit 1
fi

echo "ok: Polaris SSH onboarding present"
exit 0
`.trim();

/**
 * Linux detection half. Unlike Windows this DOES check the account and the
 * sudoers drop-in: both are prerequisites the install genuinely fails without,
 * and both are cheaply and unambiguously observable here (no localization, no
 * policy guessing). The firewall is still left out — too distro-dependent to
 * judge without false positives.
 */
export function buildLinuxOnboardingDetectionScript(opts: { publicKey: string; username: string }): string {
  const publicKey = assertValidPublicKey(opts.publicKey);
  const username = assertValidLinuxUsername(opts.username);
  return LINUX_DETECTION_SH
    .replace(/__PUBLIC_KEY__/g, shLiteral(publicKey))
    .replace(/__USERNAME__/g, shLiteral(username))
    .replace(/__SUDOERS_PATH__/g, shLiteral(LINUX_SUDOERS_PATH))
    .replace(/__SH_HELPERS__/g, POLARIS_SH_HELPERS);
}
