/**
 * src/utils/remoteStaging.ts — where Polaris puts the files it is about to run
 * as root / Administrator on a monitored host (business rule 119, re-scan
 * F63 / F64 / F67).
 *
 * Agent install, upgrade, uninstall and reboot-permission used to upload to
 * FIXED names in world-writable temp directories (`/tmp/polaris-agent-*`,
 * `C:\Windows\Temp\polaris-agent-*.ps1`) and then run them elevated. SFTP
 * opens with create/truncate and applies the mode only to a NEW file, so a
 * local user who created that name first kept ownership of it: Polaris wrote
 * the enrollment token into their file and ran a script they could still edit.
 *
 * Now every run gets a directory created fresh for it, which no other local
 * account can enter:
 *   - Linux / macOS: `mktemp -d` in /tmp, run as the SSH user with umask 077
 *     (mode 0700, owned by that user). Root reads from it; nobody else can
 *     create, replace or read anything inside.
 *   - Windows: a random directory under the SSH user's OWN temp folder
 *     (%LOCALAPPDATA%\Temp — that user, SYSTEM and Administrators only),
 *     never C:\Windows\Temp, where every user can create files.
 * The directory is removed after the run, whether it succeeded or not.
 *
 * The root-side scripts also check the agent binary's SHA-256 (passed as an
 * argument) before installing it — STAGED_SCRIPT_PRELUDE.
 */

import { AppError } from "./errors.js";
import { sshExec } from "./remoteExec.js";
import { truncate } from "./text.js";

type SshClient = Parameters<typeof sshExec>[0];

/** What `mktemp -d /tmp/polaris-agent.XXXXXXXXXX` returns — and nothing else is accepted. */
export const UNIX_STAGE_DIR_RE = /^\/tmp\/polaris-agent\.[A-Za-z0-9]{10}$/;

/** A Windows staging path: drive-rooted, no quote or shell metacharacters, our own random leaf. */
export const WINDOWS_STAGE_DIR_RE = /^[A-Za-z]:\\[^"'<>|?*\r\n%`$]+\\polaris-agent-[0-9a-f]{32}$/;

const SHA256_RE = /^[0-9a-f]{64}$/;

/** Create this run's private staging directory on a Linux / macOS host. */
export async function makeUnixStageDir(client: SshClient): Promise<string> {
  const out = await sshExec(client, "umask 077 && mktemp -d /tmp/polaris-agent.XXXXXXXXXX", 15_000);
  const dir = out.stdout.trim();
  if (out.exitCode !== 0 || !UNIX_STAGE_DIR_RE.test(dir)) {
    throw new AppError(502, `Could not create a private staging directory on the host: ${truncate(out.stderr || out.stdout, 200)}`);
  }
  return dir;
}

/**
 * The command that runs a staged script as root and removes the directory
 * afterwards, keeping the script's exit code. `dir` and every argument are
 * validated, so nothing here needs shell quoting.
 */
export function unixStagedCommand(dir: string, script: string, sha256?: string): string {
  if (!UNIX_STAGE_DIR_RE.test(dir)) throw new AppError(500, "Invalid staging directory");
  if (!/^[a-z0-9.-]+$/.test(script)) throw new AppError(500, "Invalid staged script name");
  if (sha256 !== undefined && !SHA256_RE.test(sha256)) throw new AppError(500, "Invalid binary digest");
  const args = sha256 ? ` ${sha256}` : "";
  return `sudo -n bash ${dir}/${script} ${dir}${args}; rc=$?; rm -rf ${dir}; exit $rc`;
}

/** Best-effort removal, for a run that failed before the staged command could clean up. */
export async function removeUnixStageDir(client: SshClient, dir: string): Promise<void> {
  if (!UNIX_STAGE_DIR_RE.test(dir)) return;
  await sshExec(client, `rm -rf ${dir}`, 10_000).catch(() => { /* best effort */ });
}

/**
 * Create this run's private staging directory on a Windows host, under the
 * SSH user's own temp folder. Refuses a temp folder that resolves to
 * C:\Windows\Temp (shared by every user), which a misconfigured profile can do.
 */
export async function makeWindowsStageDir(client: SshClient): Promise<string> {
  const ps =
    "$d = Join-Path ([IO.Path]::GetTempPath()) ('polaris-agent-' + [guid]::NewGuid().ToString('N')); " +
    "New-Item -ItemType Directory -Path $d -ErrorAction Stop | Out-Null; Write-Output $d";
  const out = await sshExec(client, `powershell.exe -NoProfile -NonInteractive -Command "${ps}"`, 30_000);
  const dir = out.stdout.trim();
  if (out.exitCode !== 0 || !WINDOWS_STAGE_DIR_RE.test(dir)) {
    throw new AppError(502, `Could not create a private staging directory on the host: ${truncate(out.stderr || out.stdout, 200)}`);
  }
  if (/^[A-Za-z]:\\Windows\\Temp\\/i.test(dir)) {
    await removeWindowsStageDir(client, dir);
    throw new AppError(502, "The SSH user's temp folder is C:\\Windows\\Temp, which every local user can write — set a per-user TEMP for that account");
  }
  return dir;
}

/** The SFTP form of a Windows path inside the staging directory. */
export function windowsStagedSftpPath(dir: string, name: string): string {
  if (!WINDOWS_STAGE_DIR_RE.test(dir)) throw new AppError(500, "Invalid staging directory");
  if (!/^[a-z0-9.-]+$/.test(name)) throw new AppError(500, "Invalid staged file name");
  return `${dir.replace(/\\/g, "/")}/${name}`;
}

/** Best-effort recursive removal of a Windows staging directory. */
export async function removeWindowsStageDir(client: SshClient, dir: string): Promise<void> {
  if (!WINDOWS_STAGE_DIR_RE.test(dir)) return;
  await sshExec(
    client,
    `powershell.exe -NoProfile -NonInteractive -Command "Remove-Item -LiteralPath '${dir}' -Recurse -Force -ErrorAction SilentlyContinue"`,
    15_000,
  ).catch(() => { /* best effort */ });
}

/**
 * Shared opening of every staged root script: take the staging directory as
 * $1, refuse a missing or symlinked one, and define verify_sha256 for the
 * binary. Interpolate it (`${STAGED_SCRIPT_PRELUDE}`) into a script literal;
 * the string itself already carries plain shell `${…}`.
 */
export const STAGED_SCRIPT_PRELUDE = `STAGE_DIR="\${1:?usage: script <staging-dir> [<sha256>]}"
# Business rule 119: this run's files were uploaded into a directory Polaris
# created for it (mktemp -d, mode 0700, owned by the SSH user) — never a fixed
# name in /tmp that a local user could have created first.
if [ -L "\${STAGE_DIR}" ] || [ ! -d "\${STAGE_DIR}" ]; then
  echo "Staging directory \${STAGE_DIR} is missing or is a link" >&2
  exit 1
fi
verify_sha256() {
  local file="$1" want="$2" got
  [ -f "\${file}" ] && [ ! -L "\${file}" ] || { echo "Agent binary missing at \${file}" >&2; exit 1; }
  if command -v sha256sum >/dev/null 2>&1; then
    got="$(sha256sum "\${file}" | awk '{print $1}')"
  else
    got="$(shasum -a 256 "\${file}" | awk '{print $1}')"
  fi
  if [ "\${got}" != "\${want}" ]; then
    echo "Agent binary SHA-256 mismatch (expected \${want}, got \${got}) — refusing to install" >&2
    exit 1
  fi
}
`;
