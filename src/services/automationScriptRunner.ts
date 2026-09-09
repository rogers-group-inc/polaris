/**
 * src/services/automationScriptRunner.ts
 *
 * Server-side executor for pending AutomationScriptRun rows (runOn="server").
 * Driven by the runAutomationScripts job (5s tick, web/all role). NEVER runs
 * inline in the engine or the delivery drain — script execution is queued
 * work with its own claim pass, exactly like the delivery pipeline.
 *
 * Execution model (SECURITY-SENSITIVE — this executes operator-authored code
 * as the polaris service user):
 *   - claim: pending→running via updateMany on a bounded id set (restart-safe;
 *     a concurrently-claimed row simply isn't in the update count), with a
 *     stuck-running sweep (running > timeout + 60s ⇒ status "timeout").
 *   - execute: the script body is written to a 0600 temp file under the state
 *     dir and passed to the interpreter via execFile — the args string is a
 *     SINGLE argv entry, never shell-interpolated, EXCEPT for the `cmd`
 *     interpreter, which has no argv: `cmd /c` re-parses the raw command line
 *     with its own grammar, so that one path is escaped by
 *     buildCmdCommandLine and sent with windowsVerbatimArguments; the
 *     interpreter itself
 *     resolves to a known absolute path where one exists rather than to
 *     whatever the inherited PATH names first; alert context rides env vars
 *     (POLARIS_ALERT_ID / POLARIS_RULE / POLARIS_ASSET) over an environment
 *     stripped of secret-shaped keys (`buildScriptEnv` — stdout is STORED and
 *     displayed, so the server's own credentials must not be reachable in it).
 *     Kill on timeout; stdout/stderr captured with a 64 KB cap; temp file
 *     always deleted.
 *   - record: exitCode/status/output/completedAt + one audit Event per run
 *     (`automation.script.run`, warning on failure/timeout).
 *   - sweep: prunes completed runs older than the retention window.
 */

import { chunkArray } from "../utils/chunk.js";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, writeFile, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { prisma } from "../db.js";
import { logger } from "../utils/logger.js";
import { STATE_DIR } from "../utils/paths.js";
import { logEvent } from "./eventLogService.js";
import { pruneOldRuns, SCRIPT_OUTPUT_CAP_BYTES } from "./automationScriptService.js";

const CONCURRENCY = 2;
const CLAIM_BATCH = 10;
const OUTPUT_CAP_BYTES = SCRIPT_OUTPUT_CAP_BYTES;
const STUCK_GRACE_MS = 60_000;
const SCRIPT_TMP_DIR = resolve(STATE_DIR, "data", "automation-scripts-tmp");

/**
 * Standard absolute locations per interpreter, most-specific first.
 *
 * `execFile("bash", …)` resolves the binary through the inherited PATH, so
 * whatever the service environment's PATH names first is what runs operator
 * scripts. Preferring a known absolute path takes that decision away from the
 * environment. The bare name stays as the last candidate so an install with a
 * non-standard layout (a python3 under /opt, a Nix store path) keeps working
 * rather than failing every run — on such a host PATH is the only answer
 * available, and the systemd unit is what controls it.
 */
const INTERPRETER_PATHS: Record<string, string[]> = {
  bash: ["/bin/bash", "/usr/bin/bash", "/usr/local/bin/bash"],
  sh: ["/bin/sh", "/usr/bin/sh"],
  python3: ["/usr/bin/python3", "/usr/local/bin/python3", "/bin/python3"],
  pwsh: ["/usr/bin/pwsh", "/usr/local/bin/pwsh", "/opt/microsoft/powershell/7/pwsh"],
};

/** First existing standard path for `name`, else `name` itself (PATH lookup). */
function resolveInterpreterBin(name: string): string {
  if (process.platform === "win32") {
    const root = process.env.SystemRoot || process.env.windir || "C:\\Windows";
    const winPath = name === "cmd.exe"
      ? resolve(root, "System32", "cmd.exe")
      : name === "powershell.exe"
        ? resolve(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
        : null;
    return winPath && existsSync(winPath) ? winPath : name;
  }
  for (const p of INTERPRETER_PATHS[name] ?? []) {
    if (existsSync(p)) return p;
  }
  return name;
}

/**
 * Characters that cannot be delivered to a cmd.exe command line safely.
 *
 * `"` ends the quoted token (cmd has no in-quote escape for it) and `%` / `!`
 * are expanded by the parser before the script ever sees them. Control
 * characters are rejected wholesale: CR and LF end the command line, NUL
 * truncates it, and 0x1A is still end-of-file to cmd.exe. A `^` prefix helps
 * with none of these, so such an argument is refused rather than mangled.
 */
const CMD_UNREPRESENTABLE = /["%!]|\p{Cc}/u;

/** cmd.exe metacharacters, all of which `^` does neutralise. */
const CMD_METACHARACTERS = /[()<>&|^]/g;

/**
 * The single command-line string for `cmd.exe`, or null if `args` cannot be
 * represented safely.
 *
 * cmd.exe is the one interpreter here that re-parses its own command line, so
 * it is the one that needs escaping (see the note in interpreterArgv). Three
 * things have to be true at once and each was verified empirically against
 * cmd.exe, not reasoned about:
 *
 *   1. Every metacharacter is `^`-escaped. Quoting ALONE is not enough — with
 *      `/s`, `"x | echo INJECTED"` still pipes.
 *   2. The whole command is wrapped in one further pair of quotes, because
 *      `/s` strips the first and last character of the remainder when both are
 *      quotes and uses the rest verbatim. Without the outer pair, `/s` eats the
 *      quotes around the script path instead.
 *   3. The caller passes `windowsVerbatimArguments`, or Node re-quotes this
 *      string with C-runtime rules that cmd.exe does not implement — which is
 *      the original bug: Node emitted `\"` for an embedded quote and cmd.exe
 *      read the `\` as an ordinary character and the `"` as end-of-quote.
 */
export function buildCmdCommandLine(scriptPath: string, args: string | null): string | null {
  if (args !== null && args !== "" && CMD_UNREPRESENTABLE.test(args)) return null;
  const escaped = args === null || args === "" ? null : args.replace(CMD_METACHARACTERS, (c) => `^${c}`);
  const inner = escaped === null ? `"${scriptPath}"` : `"${scriptPath}" "${escaped}"`;
  return `/d /s /c "${inner}"`;
}

/**
 * Interpreter → binary + argv. The temp file path and the rendered args are
 * discrete argv entries, so for bash/sh/python3/powershell no shell parses
 * them: each receives its argument vector directly from CreateProcess/execve.
 *
 * cmd.exe is the exception, and the reason `verbatim` exists. `cmd /c` does not
 * consume an argv — it re-parses the raw command line with its own grammar, in
 * which `&`, `|`, `<`, `>`, `(`, `)` and `^` are operators. Handing it a
 * Node-quoted argv therefore executed whatever an argument chose to inject, and
 * args are a rendered template of alert context (renderNotificationTemplate),
 * so the injected text can come from a device's own hostname. Everything cmd
 * touches goes through buildCmdCommandLine.
 */
function interpreterArgv(
  interpreter: string,
  scriptPath: string,
  args: string | null,
): { bin: string; argv: string[]; verbatim?: boolean; rejected?: string } | null {
  const tail = args !== null && args !== "" ? [args] : [];
  switch (interpreter) {
    case "bash": return { bin: resolveInterpreterBin("bash"), argv: [scriptPath, ...tail] };
    case "sh": return { bin: resolveInterpreterBin("sh"), argv: [scriptPath, ...tail] };
    case "python3": return { bin: resolveInterpreterBin("python3"), argv: [scriptPath, ...tail] };
    case "powershell": {
      const bin = resolveInterpreterBin(process.platform === "win32" ? "powershell.exe" : "pwsh");
      return { bin, argv: ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", scriptPath, ...tail] };
    }
    case "cmd": {
      if (process.platform !== "win32") return null;
      const line = buildCmdCommandLine(scriptPath, args);
      if (line === null) {
        return {
          bin: "", argv: [],
          rejected: 'arguments for the cmd interpreter cannot contain " % ! or a line break — '
            + "cmd.exe expands or re-parses those before the script sees them. "
            + "Use the POLARIS_ALERT_ID / POLARIS_RULE / POLARIS_ASSET environment variables instead.",
        };
      }
      return { bin: resolveInterpreterBin("cmd.exe"), argv: [line], verbatim: true };
    }
    default:
      return null;
  }
}

/**
 * Server secrets stripped from the child environment.
 *
 * The runner used to hand every script the web role's entire `process.env` —
 * DATABASE_URL, POLARIS_SECRET_KEY, SESSION_SECRET, HEALTH_TOKEN,
 * METRICS_TOKEN. A script that so much as runs `env` therefore wrote the
 * secret-box key into `AutomationScriptRun.stdout`, where it is stored
 * unencrypted and rendered in the Scripts tab to anyone who can read a run.
 * Authoring a script already requires an RCE-equivalent permission, so this is
 * not a privilege boundary — but the accidental copy into a stored, displayed,
 * backed-up column is worth removing regardless.
 *
 * A denylist rather than an allowlist on purpose: PATH / HOME / proxy vars /
 * locale stay inherited, so scripts that work today keep working.
 */
const SENSITIVE_ENV_PATTERN = /SECRET|TOKEN|PASSWORD|PASSWD|DATABASE_URL|SESSION|CREDENTIAL|PRIVATE_KEY|_KEY$/i;

/** process.env minus secret-shaped keys, plus the alert context vars. */
export function buildScriptEnv(
  base: NodeJS.ProcessEnv,
  context: Record<string, string>,
): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(base)) {
    if (!SENSITIVE_ENV_PATTERN.test(k)) out[k] = v;
  }
  return { ...out, ...context };
}

function scriptFileExtension(interpreter: string): string {
  switch (interpreter) {
    case "powershell": return ".ps1";
    case "cmd": return ".cmd";
    case "python3": return ".py";
    default: return ".sh";
  }
}

interface ExecResult {
  status: "succeeded" | "failed" | "timeout";
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

/** Execute one claimed run row. Exported for tests (fake interpreter). */
export async function executeServerScript(run: {
  id: string;
  scriptId: string | null;
  args: string | null;
  timeoutSec: number;
  notificationId: string | null;
  ruleId: string | null;
  assetId: string | null;
}): Promise<ExecResult> {
  const script = run.scriptId ? await prisma.automationScript.findUnique({ where: { id: run.scriptId } }) : null;
  if (!script) return { status: "failed", exitCode: null, stdout: "", stderr: "script no longer exists in the registry" };
  if (!script.enabled) return { status: "failed", exitCode: null, stdout: "", stderr: "script is disabled" };

  await mkdir(SCRIPT_TMP_DIR, { recursive: true });
  const scriptPath = resolve(SCRIPT_TMP_DIR, `run-${run.id}-${randomUUID().slice(0, 8)}${scriptFileExtension(script.interpreter)}`);
  const spec = interpreterArgv(script.interpreter, scriptPath, run.args);
  if (!spec) return { status: "failed", exitCode: null, stdout: "", stderr: `interpreter "${script.interpreter}" is not available on this platform` };
  // Refusing the run is the point: the alternative is silently delivering a
  // mangled argument, or delivering it faithfully to cmd.exe's parser.
  if (spec.rejected) return { status: "failed", exitCode: null, stdout: "", stderr: spec.rejected };

  try {
    await writeFile(scriptPath, script.body, { encoding: "utf8", mode: 0o600 });
    return await new Promise<ExecResult>((resolveExec) => {
      execFile(
        spec.bin,
        spec.argv,
        {
          timeout: run.timeoutSec * 1000,
          killSignal: "SIGKILL",
          maxBuffer: OUTPUT_CAP_BYTES,
          env: buildScriptEnv(process.env, {
            POLARIS_ALERT_ID: run.notificationId ?? "",
            POLARIS_RULE: run.ruleId ?? "",
            POLARIS_ASSET: run.assetId ?? "",
          }),
          windowsHide: true,
          // cmd only. buildCmdCommandLine has already applied cmd.exe's own
          // escaping rules; letting Node re-quote with C-runtime rules on top
          // is what made the argument injectable in the first place.
          windowsVerbatimArguments: spec.verbatim === true,
        },
        (err, stdout, stderr) => {
          const out = String(stdout ?? "").slice(0, OUTPUT_CAP_BYTES);
          const errOut = String(stderr ?? "").slice(0, OUTPUT_CAP_BYTES);
          if (!err) {
            resolveExec({ status: "succeeded", exitCode: 0, stdout: out, stderr: errOut });
            return;
          }
          const e = err as NodeJS.ErrnoException & { killed?: boolean; signal?: string; code?: number | string };
          // A maxBuffer kill also sets killed=true — classify it as a failure
          // (output cap exceeded), not a timeout.
          const bufferExceeded = e.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" || /maxBuffer/.test(e.message);
          const timedOut = !bufferExceeded && (e.killed === true || e.signal === "SIGKILL" || e.signal === "SIGTERM");
          resolveExec({
            status: timedOut ? "timeout" : "failed",
            exitCode: typeof e.code === "number" ? e.code : null,
            stdout: out,
            stderr: bufferExceeded ? `output exceeded the ${OUTPUT_CAP_BYTES / 1024} KB cap` : errOut || e.message.slice(0, 1000),
          });
        },
      );
    });
  } catch (err) {
    return { status: "failed", exitCode: null, stdout: "", stderr: (err as Error).message.slice(0, 1000) };
  } finally {
    await unlink(scriptPath).catch(() => {});
  }
}

/** One runner tick: stuck sweep → claim → execute (bounded) → record. */
export async function runPendingServerScripts(): Promise<{ started: number; completed: number }> {
  const now = new Date();

  // Stuck-running sweep: a run whose window (timeout + grace) elapsed without
  // completing — e.g. the process died mid-run — flips to timeout.
  const stuck = await prisma.automationScriptRun.findMany({
    where: { status: "running", runOn: "server", startedAt: { not: null } },
    select: { id: true, startedAt: true, timeoutSec: true, scriptName: true },
  });
  for (const s of stuck) {
    if (s.startedAt && now.getTime() - s.startedAt.getTime() > s.timeoutSec * 1000 + STUCK_GRACE_MS) {
      await prisma.automationScriptRun.update({
        where: { id: s.id, status: "running" },
        data: { status: "timeout", completedAt: now, stderr: "run abandoned (process restart or wedge) — swept by the runner" },
      });
    }
  }

  // Claim a bounded batch pending→running. updateMany's WHERE re-checks
  // status so a row another process claimed is silently skipped.
  const candidates = await prisma.automationScriptRun.findMany({
    where: { status: "pending", runOn: "server" },
    orderBy: { requestedAt: "asc" },
    take: CLAIM_BATCH,
    select: { id: true },
  });
  if (candidates.length === 0) {
    // Piggyback the retention sweep on idle ticks (cheap deleteMany).
    await pruneOldRuns().catch(() => {});
    return { started: 0, completed: 0 };
  }
  const ids = candidates.map((c) => c.id);
  await prisma.automationScriptRun.updateMany({
    where: { id: { in: ids }, status: "pending" },
    data: { status: "running", startedAt: now },
  });
  const claimed = await prisma.automationScriptRun.findMany({
    where: { id: { in: ids }, status: "running" },
  });

  let completed = 0;
  for (const chunk of chunkArray(claimed, CONCURRENCY)) {
    const results = await Promise.all(chunk.map(async (run) => ({ run, res: await executeServerScript(run) })));
    for (const { run, res } of results) {
      await prisma.automationScriptRun.update({
        where: { id: run.id },
        data: { status: res.status, exitCode: res.exitCode, stdout: res.stdout, stderr: res.stderr, completedAt: new Date() },
      });
      completed++;
      await logEvent({
        action: "automation.script.run",
        resourceType: "automation-script",
        resourceId: run.scriptId ?? undefined,
        resourceName: run.scriptName,
        actor: run.requestedBy ?? "system:automation",
        level: res.status === "succeeded" ? "info" : "warning",
        message: `Automation script "${run.scriptName}" ${res.status} on server (exit ${res.exitCode ?? "n/a"})`,
        details: {
          runId: run.id,
          scriptId: run.scriptId,
          ruleId: run.ruleId,
          notificationId: run.notificationId,
          exitCode: res.exitCode,
          runOn: "server",
          status: res.status,
        },
      }).catch(() => {});
    }
  }

  logger.debug({ started: claimed.length, completed }, "automation script runner tick");
  return { started: claimed.length, completed };
}
