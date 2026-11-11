/**
 * src/services/agentCommandService.ts — the agent command queue.
 *
 * Two queued actions: `run_script` (automation script runs on the agent —
 * enqueued by automationScriptService.requestScriptRun) and `reboot` (business
 * rule 115 — enqueued by rebootService, which watches the row and writes the
 * Events). The agent polls pending commands, executes, and reports the outcome
 * via /command-result. The agent never self-acts. Every result is audited.
 *
 * NOTE: process/service start/stop/restart control was removed (Satellite-posture
 * change) — the agent no longer accepts control actions and the server no longer
 * enqueues them. This module keeps only the shared queue plumbing (fetch / result
 * / status) used by run_script.
 *
 * A QUEUED COMMAND IS GOOD FOR `AGENT_COMMAND_TTL_MS`, THEN IT IS DEAD
 * (business rule 155). A script queued for an agent that was offline used to
 * wait in the queue with no expiry: it ran — as root / LocalSystem — whenever
 * the host next polled, days later, after the alert had cleared and even after
 * the automation that asked for it had been deleted. Nothing could cancel it
 * and nothing ever deleted the row. Now: `fetchPendingCommands` never hands
 * out a command older than the TTL (the gate — it holds on every process and
 * between sweeps), `expireStaleAgentCommands` settles the rows and their runs
 * so the history says what happened, and `pruneOldAgentCommands` removes
 * finished rows (each carries a script body) after the run retention window.
 */

import { prisma } from "../db.js";
import { logEvent } from "./eventLogService.js";
import { AppError } from "../utils/errors.js";
import { SCRIPT_OUTPUT_CAP_BYTES } from "./automationScriptService.js";

export interface AgentCommandView {
  id: string;
  action: string;
  target: string;
  /** run_script commands: { runId, interpreter, body, sha256, args, timeoutSec }. */
  payload?: unknown;
}

/**
 * Agent poll: return this agent's pending commands and atomically mark them
 * "sent" so a slow agent doesn't re-execute them on the next poll. Bounded.
 */
export async function fetchPendingCommands(managedAgentId: string, now: Date = new Date()): Promise<AgentCommandView[]> {
  const cmds = await prisma.agentCommand.findMany({
    // Rule 155: an expired command is never delivered, swept yet or not.
    where: { managedAgentId, status: "pending", requestedAt: { gte: commandExpiryCutoff(now) } },
    orderBy: { requestedAt: "asc" },
    take: 20,
    select: { id: true, action: true, target: true, payload: true },
  });
  if (cmds.length > 0) {
    await prisma.agentCommand.updateMany({
      where: { id: { in: cmds.map((c) => c.id) } },
      data: { status: "sent", sentAt: new Date() },
    });
    // run_script commands are "running" from the run's perspective the moment
    // they ship to the agent (the stuck sweep doesn't apply — agent runs
    // complete via /command-result).
    const scriptCmdIds = cmds.filter((c) => c.action === "run_script").map((c) => c.id);
    if (scriptCmdIds.length > 0) {
      await prisma.automationScriptRun.updateMany({
        where: { agentCommandId: { in: scriptCmdIds }, status: "pending" },
        data: { status: "running", startedAt: new Date() },
      });
    }
  }
  return cmds.map((c) => ({ id: c.id, action: c.action, target: c.target, ...(c.payload ? { payload: c.payload } : {}) }));
}

// ─── Expiry and retention (business rule 155) ────────────────────────────────

/**
 * How long a queued command waits for its agent. An online agent polls every
 * ~20 s and is woken at once, so a command still pending after this belongs to
 * a host that was not there to hear it — and what it was asked to fix is no
 * longer the situation it would run in.
 */
export const AGENT_COMMAND_TTL_MS = 15 * 60 * 1000;
/** Past its own timeout by this much with no result, an agent run is settled
 *  as `timeout`. Generous: the agent reports after the script ends, over a
 *  link that may be slow. A late result still overwrites it with the truth. */
export const AGENT_RUN_RESULT_GRACE_MS = 5 * 60 * 1000;
/** Finished commands are kept as long as script runs are (90 days). */
export const AGENT_COMMAND_RETENTION_DAYS = 90;
const EXPIRE_BATCH = 500;

/** Commands requested before this instant have expired. Pure. */
export function commandExpiryCutoff(now: Date): Date {
  return new Date(now.getTime() - AGENT_COMMAND_TTL_MS);
}

const TTL_MINUTES = Math.round(AGENT_COMMAND_TTL_MS / 60_000);
const EXPIRED_NOTE = `expired: the agent did not pick this up within ${TTL_MINUTES} minutes, so it was withdrawn and will not run`;
const NO_RESULT_NOTE = "no result: the agent took this script but never reported an outcome — check the host";

/**
 * Settle what the queue can no longer deliver. Three sweeps, each bounded:
 *
 *  1. a command still `pending` past the TTL → `failed` (withdrawn);
 *  2. an agent script run still `pending` past the TTL → `failed`, with one
 *     audit Event — this also catches a run whose command row never got
 *     written, and a run whose agent was uninstalled or whose asset was
 *     deleted (neither table has a foreign key to the agent);
 *  3. an agent script run `running` past its timeout + grace → `timeout`,
 *     and its command `failed` — the host went away mid-run.
 *
 * Called from the script runner's tick (web / all role), at most once a
 * minute. Fleet size does not enter into it: the work is proportional to the
 * commands that expired since the last call, and every write is batched.
 */
export async function expireStaleAgentCommands(now: Date = new Date()): Promise<{ commands: number; runs: number; stuck: number }> {
  const cutoff = commandExpiryCutoff(now);

  const expired = await prisma.agentCommand.updateMany({
    where: { status: "pending", requestedAt: { lt: cutoff } },
    data: { status: "failed", error: EXPIRED_NOTE, completedAt: now },
  });

  const lapsed = await prisma.automationScriptRun.findMany({
    where: { runOn: "agent", status: "pending", requestedAt: { lt: cutoff } },
    orderBy: { requestedAt: "asc" },
    take: EXPIRE_BATCH,
    select: { id: true, scriptId: true, scriptName: true, ruleId: true, notificationId: true, assetId: true, requestedBy: true },
  });
  if (lapsed.length > 0) {
    await prisma.automationScriptRun.updateMany({
      where: { id: { in: lapsed.map((r) => r.id) }, status: "pending" },
      data: { status: "failed", stderr: EXPIRED_NOTE, completedAt: now },
    });
    await Promise.all(lapsed.map((run) => logEvent({
      action: "automation.script.run",
      resourceType: "automation-script",
      resourceId: run.scriptId ?? undefined,
      resourceName: run.scriptName,
      actor: run.requestedBy ?? "system:automation",
      level: "warning",
      message: `Automation script "${run.scriptName}" did not run on agent ${run.assetId ?? "(unknown)"}: the agent was not reachable within ${TTL_MINUTES} minutes, so the script was withdrawn`,
      details: { runId: run.id, scriptId: run.scriptId, ruleId: run.ruleId, notificationId: run.notificationId, runOn: "agent", status: "failed", reason: "expired", assetId: run.assetId },
    })));
  }

  const running = await prisma.automationScriptRun.findMany({
    where: { runOn: "agent", status: "running", startedAt: { not: null } },
    take: EXPIRE_BATCH,
    select: { id: true, startedAt: true, timeoutSec: true, agentCommandId: true },
  });
  const stuck = running.filter((r) => r.startedAt && now.getTime() - r.startedAt.getTime() > r.timeoutSec * 1000 + AGENT_RUN_RESULT_GRACE_MS);
  if (stuck.length > 0) {
    await prisma.automationScriptRun.updateMany({
      where: { id: { in: stuck.map((r) => r.id) }, status: "running" },
      data: { status: "timeout", stderr: NO_RESULT_NOTE, completedAt: now },
    });
    const cmdIds = stuck.map((r) => r.agentCommandId).filter((id): id is string => !!id);
    if (cmdIds.length > 0) {
      await prisma.agentCommand.updateMany({
        where: { id: { in: cmdIds }, status: "sent" },
        data: { status: "failed", error: NO_RESULT_NOTE, completedAt: now },
      });
    }
  }

  return { commands: expired.count, runs: lapsed.length, stuck: stuck.length };
}

/**
 * Delete finished commands older than the retention window. A `run_script`
 * row carries the whole script body, and nothing else ever removed one.
 * Anything that old and still `sent` (a reboot acknowledged by a host that
 * never came back, a result that was never posted) goes too — the run and the
 * Events are the record; the queue row is plumbing.
 */
export async function pruneOldAgentCommands(now: Date = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - AGENT_COMMAND_RETENTION_DAYS * 24 * 3600 * 1000);
  const res = await prisma.agentCommand.deleteMany({
    where: { requestedAt: { lt: cutoff }, status: { not: "pending" } },
  });
  return res.count;
}

const OUTPUT_CAP_BYTES = SCRIPT_OUTPUT_CAP_BYTES;
const RUN_STATUSES = new Set(["succeeded", "failed", "timeout"]);

/** Agent result report. Bound to the agent's own commands; audited.
 *  run_script commands additionally complete their linked AutomationScriptRun
 *  (resultState carries the run status; stdout/stderr/exitCode optional). */
export async function recordCommandResult(
  managedAgentId: string,
  commandId: string,
  success: boolean,
  error: string | null,
  resultState: string | null,
  output?: { exitCode?: number | null; stdout?: string | null; stderr?: string | null },
): Promise<void> {
  const cmd = await prisma.agentCommand.findUnique({ where: { id: commandId } });
  if (!cmd || cmd.managedAgentId !== managedAgentId) {
    throw new AppError(404, "Command not found for this agent");
  }
  await prisma.agentCommand.update({
    where: { id: commandId },
    data: { status: success ? "succeeded" : "failed", completedAt: new Date(), error, resultState },
  });

  if (cmd.action === "run_script") {
    // resultState is the run status the agent observed; anything else maps
    // from the success flag (defensive against older/foreign reporters).
    const runStatus = resultState && RUN_STATUSES.has(resultState) ? resultState : success ? "succeeded" : "failed";
    const run = await prisma.automationScriptRun.findFirst({ where: { agentCommandId: commandId } });
    if (run) {
      await prisma.automationScriptRun.update({
        where: { id: run.id },
        data: {
          status: runStatus,
          exitCode: output?.exitCode ?? null,
          stdout: (output?.stdout ?? "").slice(0, OUTPUT_CAP_BYTES) || null,
          stderr: ((output?.stderr ?? "") || (error ?? "")).slice(0, OUTPUT_CAP_BYTES) || null,
          completedAt: new Date(),
        },
      });
      await logEvent({
        action: "automation.script.run",
        resourceType: "automation-script",
        resourceId: run.scriptId ?? undefined,
        resourceName: run.scriptName,
        actor: run.requestedBy ?? "system:automation",
        level: runStatus === "succeeded" ? "info" : "warning",
        message: `Automation script "${run.scriptName}" ${runStatus} on agent ${cmd.assetId} (exit ${output?.exitCode ?? "n/a"})`,
        details: { runId: run.id, scriptId: run.scriptId, ruleId: run.ruleId, notificationId: run.notificationId, exitCode: output?.exitCode ?? null, runOn: "agent", status: runStatus, assetId: cmd.assetId },
      });
    }
    return;
  }

  // A reboot (business rule 115): the agent acknowledges BEFORE it takes the
  // host down. The reboot run watching this row writes the Events — the ack
  // is one step of that run, not an outcome of its own.
  if (cmd.action === "reboot") return;

  // Any other action is stale/foreign (process control was removed) — record
  // the result generically for audit.
  await logEvent({
    action: `agent.command.${cmd.action}.result`,
    resourceType: "asset",
    resourceId: cmd.assetId,
    actor: cmd.requestedBy ?? undefined,
    level: success ? "info" : "warning",
    message: `Agent command "${cmd.action}" on "${cmd.target}" ${success ? "succeeded" : "failed"}${error ? `: ${error}` : ""}`,
    details: { commandId, resultState },
  });
}
