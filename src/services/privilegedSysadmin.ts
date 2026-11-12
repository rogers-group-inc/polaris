/**
 * src/services/privilegedSysadmin.ts
 *
 * Thin TypeScript wrapper around `sudo /usr/local/sbin/polaris-nginx-apply`.
 * The wrapper script (deploy/scripts/polaris-nginx-apply.sh) is the entire
 * privileged surface granted to the polaris OS user — see the comments at
 * the top of that file. All subcommand + arg validation lives in the shell
 * wrapper; this module is just process glue.
 *
 * The caller writes staged files to /run/polaris-nginx-stage/ (writable by
 * polaris) via stageNginxConfig() / stageCertAndKey() before calling
 * runNginxApply().
 *
 * runNginxApply() starts the root unit polaris-nginx-apply@<op>.service when
 * it is installed (business rule 117(o)) and sudo-s the wrapper only as a
 * fallback: from polaris-web's ProtectSystem=strict sandbox a sudo cannot
 * write nginx's files.
 *
 * Output is captured stdout+stderr interleaved (limited to 64 KB to keep
 * pathological cases bounded). Failures surface as a non-zero exitCode in
 * the result; throwing is reserved for sudo-or-spawn errors before the
 * wrapper even runs.
 */

import { spawn } from "node:child_process";
import { writeFileSync, mkdirSync, existsSync, chmodSync, readFileSync, rmSync } from "node:fs";
import { AppError } from "../utils/errors.js";
import { logger } from "../utils/logger.js";

const WRAPPER_PATH = "/usr/local/sbin/polaris-nginx-apply";
const STAGE_DIR = "/run/polaris-nginx-stage";
const DEFAULT_TIMEOUT_MS = 35_000; // wrapper caps each op at 30s; we add 5s headroom.
const MAX_OUTPUT_BYTES = 64 * 1024;

export type NginxApplySubcommand =
  | { kind: "apply-config" }
  | { kind: "rotate-cert" }
  | { kind: "reload" }
  | { kind: "verify-listening"; port: number };

export interface WrapperResult {
  exitCode: number;
  /** stdout + stderr interleaved, truncated at MAX_OUTPUT_BYTES. */
  output: string;
  durationMs: number;
  truncated: boolean;
}

/** The root unit the nginx GUI starts (business rule 117(o)). */
const APPLY_UNIT_FILE = "/etc/systemd/system/polaris-nginx-apply@.service";

/** What an administrator runs to install a held root helper (rule 117(g)). */
const APPLY_HELPERS_HINT =
  "Approve the held root helpers on this host: sudo /usr/local/sbin/polaris-update-sync --apply-helpers " +
  "(run it a second time if it installs a newer polaris-update-sync, which then offers polaris-nginx-apply@.service).";

/** The unit instance — and the wrapper's single argument — for a subcommand. */
function instanceFor(cmd: NginxApplySubcommand): string {
  if (cmd.kind === "verify-listening") {
    if (!Number.isInteger(cmd.port) || cmd.port < 1 || cmd.port > 65535) {
      throw new AppError(500, `verify-listening: invalid port ${cmd.port}`);
    }
    return `verify-listening-${cmd.port}`;
  }
  return cmd.kind;
}

/**
 * Run one wrapper operation as root.
 *
 * Preferred: START `polaris-nginx-apply@<instance>.service` (a fixed root
 * oneshot the scoped polkit rule lets this user start) and read the wrapper's
 * output from the file the unit writes. polaris-web is ProtectSystem=strict,
 * and a `sudo` from inside it inherits that mount namespace — root then sees
 * /etc/nginx, /run and /var/log/nginx read-only, so the sudo path cannot
 * apply anything from a shipped unit. The started unit runs outside it.
 *
 * Fallback, while the unit is not installed (an administrator has not yet
 * approved the held root helper): the old `sudo -n` of the wrapper, which
 * still works for a web process that is not sandboxed. A read-only failure on
 * that path, or polkit refusing the start, comes back with the
 * --apply-helpers hint so the operator sees the fix, not just "EROFS".
 */
export async function runNginxApply(
  cmd: NginxApplySubcommand,
  opts: { timeoutMs?: number } = {},
): Promise<WrapperResult> {
  const instance = instanceFor(cmd);
  // The instance becomes a path under STAGE_DIR and a unit name. instanceFor
  // already bounds it, but an anchored allow-list here is what keeps a future
  // subcommand from carrying "/" or ".." into the path (and what CodeQL's
  // js/path-injection recognises as the sanitizer).
  if (!/^[a-z0-9-]+$/.test(instance)) throw new AppError(500, `nginx apply: invalid instance ${instance}`);
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  if (existsSync(APPLY_UNIT_FILE)) {
    const outFile = `${STAGE_DIR}/${instance}.out`;
    // A stale result must never be read as this run's: remove it first (the
    // directory is polaris's, so the root-written file can be unlinked).
    try { rmSync(outFile, { force: true }); } catch { /* unreadable stage: the read below reports it */ }
    const run = await capture("systemctl", ["start", `polaris-nginx-apply@${instance}.service`], timeoutMs);
    let fromUnit = "";
    try { fromUnit = readFileSync(outFile, "utf8"); } catch { /* the unit never started */ }
    let output = fromUnit;
    if (run.exitCode !== 0 && run.output) output += (output ? "\n" : "") + run.output;
    if (run.exitCode !== 0 && !fromUnit && /access denied|authentication required|not authorized/i.test(run.output)) {
      output += `\n${APPLY_HELPERS_HINT}`;
    }
    return bounded(output, run.exitCode, run.durationMs, run.truncated);
  }

  const args = [WRAPPER_PATH, ...(cmd.kind === "verify-listening" ? ["verify-listening", String(cmd.port)] : [cmd.kind])];
  const run = await capture("sudo", ["-n", "--", ...args], timeoutMs);
  if (run.exitCode !== 0 && /read-only file system/i.test(run.output)) {
    return bounded(`${run.output}\n${APPLY_HELPERS_HINT}`, run.exitCode, run.durationMs, run.truncated);
  }
  return run;
}

function bounded(output: string, exitCode: number, durationMs: number, alreadyTruncated: boolean): WrapperResult {
  const truncated = alreadyTruncated || output.length > MAX_OUTPUT_BYTES;
  return { exitCode, output: output.slice(0, MAX_OUTPUT_BYTES), durationMs, truncated };
}

/** Spawn, capture stdout + stderr interleaved (bounded), kill on timeout. */
async function capture(command: string, args: string[], timeoutMs: number): Promise<WrapperResult> {
  const start = Date.now();
  return await new Promise<WrapperResult>((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    let truncated = false;
    const append = (chunk: Buffer): void => {
      if (truncated) return;
      const text = chunk.toString("utf8");
      const room = MAX_OUTPUT_BYTES - output.length;
      if (text.length <= room) {
        output += text;
      } else {
        output += text.slice(0, room);
        truncated = true;
      }
    };
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);

    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch { /* ignore */ }
    }, timeoutMs);

    child.on("close", (exitCode) => {
      clearTimeout(timer);
      resolve({
        exitCode: exitCode ?? -1,
        output,
        durationMs: Date.now() - start,
        truncated,
      });
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

/**
 * Write the rendered nginx config to the staging area where polaris-nginx-apply
 * (running as root) will pick it up. Caller invokes runNginxApply({kind:"apply-config"})
 * immediately after.
 */
export function stageNginxConfig(contents: string): void {
  ensureStageDir();
  const path = `${STAGE_DIR}/polaris.conf`;
  writeFileSync(path, contents, { mode: 0o640 });
}

export function stageCertAndKey(certPem: string, keyPem: string): void {
  ensureStageDir();
  writeFileSync(`${STAGE_DIR}/cert.pem`, certPem, { mode: 0o640 });
  writeFileSync(`${STAGE_DIR}/key.pem`, keyPem, { mode: 0o640 });
}

function ensureStageDir(): void {
  if (existsSync(STAGE_DIR)) return;
  // systemd-tmpfiles creates this on boot via deploy/tmpfiles.d/polaris-nginx.conf;
  // mkdirSync here is a dev/test fallback for hosts where tmpfiles didn't run.
  try {
    mkdirSync(STAGE_DIR, { recursive: true, mode: 0o750 });
    chmodSync(STAGE_DIR, 0o750);
  } catch (err: any) {
    logger.warn({ err: err?.message, dir: STAGE_DIR }, "Could not create staging dir; subsequent stage* calls will fail");
  }
}

/**
 * True iff the privileged wrapper is installed on this host. Used by route
 * handlers to short-circuit with a clear error on dev boxes where Phase 2's
 * setup-script changes haven't been applied yet.
 */
export function isWrapperAvailable(): boolean {
  return existsSync(WRAPPER_PATH);
}
