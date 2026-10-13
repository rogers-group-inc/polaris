/**
 * src/services/agentCommandService.ts — the agent command queue.
 *
 * Two queued actions: `run_script` (automation script runs on the agent —
 * enqueued by automationScriptService.requestScriptRun) and `reboot` (business
 * rule 114 — enqueued by rebootService, which watches the row and writes the
 * Events). The agent polls pending commands, executes, and reports the outcome
 * via /command-result. The agent never self-acts. Every result is audited.
 *
 * NOTE: process/service start/stop/restart control was removed (Satellite-posture
 * change) — the agent no longer accepts control actions and the server no longer
 * enqueues them. This module keeps only the shared queue plumbing (fetch / result
 * / status) used by run_script.
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
export async function fetchPendingCommands(managedAgentId: string): Promise<AgentCommandView[]> {
  const cmds = await prisma.agentCommand.findMany({
    where: { managedAgentId, status: "pending" },
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

  // A reboot (business rule 114): the agent acknowledges BEFORE it takes the
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
