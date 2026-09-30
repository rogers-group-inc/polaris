/**
 * src/services/automationScriptService.ts
 *
 * The AutomationScript registry (operator-authored scripts referenced by
 * Automation `script` actions) + the AutomationScriptRun lifecycle entry
 * points shared by the server-side runner and (next phase) the agent path.
 *
 * SECURITY MODEL — this whole surface is RCE-equivalent:
 *   - CRUD and every route touching it are gated by the `automationScripts`
 *     RBAC key (seeded fullwrite only for admin-equivalent roles).
 *   - Server scripts execute as the polaris service user on the Polaris host;
 *     agent scripts as root/LocalSystem on the triggering asset.
 *   - Creation and every BODY change stamp a warning Event carrying the old
 *     and new sha256 (same posture as groupMappingService's admin-equivalent
 *     warning) so script tampering is visible in the audit trail + syslog.
 *   - sha256 is recomputed server-side on every save; the agent verifies the
 *     payload hash before executing. A human must review scripts before
 *     production use.
 */

import { createHash } from "node:crypto";
import { prisma } from "../db.js";
import { AppError } from "../utils/errors.js";
import { logEvent } from "./eventLogService.js";
import { publishCommandWake } from "./agentCommandWake.js";
import { versionAtLeast } from "../utils/version.js";
import {
  normalizeRuleToV2,
  SCRIPT_INTERPRETERS,
  type AutomationAction,
  type ScriptInterpreter,
} from "./notificationTypes.js";

export const SCRIPT_RUN_TARGET_VALUES = ["server", "agent", "either"] as const;

/** First agent version whose command loop understands action="run_script". */
export const MIN_AGENT_SCRIPT_VERSION = "0.13.0";

/** Moved to utils/version.ts so every agent-version gate shares one compare;
 *  re-exported here for the existing importers. */
export { versionAtLeast };

export const MAX_SCRIPT_BODY_BYTES = 64 * 1024;
/**
 * Cap on captured stdout/stderr for a script run — shared by the server-side
 * runner, the agent-result recorder, AND the /agents/command-result Zod
 * validator, which must all agree (the agent enforces the same cap on its
 * side before pushing).
 */
export const SCRIPT_OUTPUT_CAP_BYTES = 64 * 1024;
export const MAX_SCRIPT_TIMEOUT_SEC = 600;
const RUN_RETENTION_DAYS = 90;

export interface ScriptInput {
  name: string;
  description?: string | null;
  interpreter: ScriptInterpreter;
  body: string;
  runTarget: (typeof SCRIPT_RUN_TARGET_VALUES)[number];
  timeoutSec?: number | null;
  enabled?: boolean;
}

export function sha256Hex(body: string): string {
  return createHash("sha256").update(body, "utf8").digest("hex");
}

function validateInput(input: ScriptInput): void {
  if (!input.name?.trim()) throw new AppError(400, "Script name is required");
  if (!SCRIPT_INTERPRETERS.includes(input.interpreter)) throw new AppError(400, `Unknown interpreter "${input.interpreter}"`);
  if (!SCRIPT_RUN_TARGET_VALUES.includes(input.runTarget)) throw new AppError(400, `Unknown run target "${input.runTarget}"`);
  if (!input.body || !input.body.trim()) throw new AppError(400, "Script body is required");
  if (Buffer.byteLength(input.body, "utf8") > MAX_SCRIPT_BODY_BYTES) {
    throw new AppError(400, `Script body exceeds ${MAX_SCRIPT_BODY_BYTES / 1024} KB`);
  }
  const t = input.timeoutSec ?? 60;
  if (!Number.isInteger(t) || t < 1 || t > MAX_SCRIPT_TIMEOUT_SEC) {
    throw new AppError(400, `timeoutSec must be 1–${MAX_SCRIPT_TIMEOUT_SEC}`);
  }
}

export async function listScripts() {
  // Body included — the registry is the editor surface and holds no secrets
  // by policy (the no-secrets rule is in the catalog help + docs).
  return prisma.automationScript.findMany({ orderBy: { name: "asc" } });
}

export async function getScript(id: string) {
  const script = await prisma.automationScript.findUnique({ where: { id } });
  if (!script) throw new AppError(404, "Automation script not found");
  return script;
}

export async function createScript(input: ScriptInput, actor?: string) {
  validateInput(input);
  const sha256 = sha256Hex(input.body);
  const script = await prisma.automationScript.create({
    data: {
      name: input.name.trim(),
      description: input.description ?? null,
      interpreter: input.interpreter,
      body: input.body,
      runTarget: input.runTarget,
      timeoutSec: input.timeoutSec ?? 60,
      sha256,
      enabled: input.enabled ?? true,
      createdBy: actor ?? null,
    },
  });
  await logEvent({
    action: "automation_script.created",
    resourceType: "automation-script",
    resourceId: script.id,
    resourceName: script.name,
    actor,
    level: "warning", // script creation is always audit-worthy (RCE surface)
    message: `Automation script "${script.name}" created (${script.interpreter}, ${script.runTarget})`,
    details: { interpreter: script.interpreter, runTarget: script.runTarget, sha256 },
  });
  return script;
}

export async function updateScript(id: string, input: ScriptInput, actor?: string) {
  const existing = await getScript(id);
  validateInput(input);
  const sha256 = sha256Hex(input.body);
  const bodyChanged = sha256 !== existing.sha256;
  const script = await prisma.automationScript.update({
    where: { id },
    data: {
      name: input.name.trim(),
      description: input.description ?? null,
      interpreter: input.interpreter,
      body: input.body,
      runTarget: input.runTarget,
      timeoutSec: input.timeoutSec ?? existing.timeoutSec,
      sha256,
      enabled: input.enabled ?? existing.enabled,
    },
  });
  await logEvent({
    action: "automation_script.updated",
    resourceType: "automation-script",
    resourceId: script.id,
    resourceName: script.name,
    actor,
    level: bodyChanged ? "warning" : "info",
    message: bodyChanged
      ? `Automation script "${script.name}" BODY changed`
      : `Automation script "${script.name}" updated`,
    details: bodyChanged ? { oldSha256: existing.sha256, newSha256: sha256 } : { sha256 },
  });
  return script;
}

/** Rules (actions or escalation tiers) referencing a script id. */
async function rulesReferencingScript(scriptId: string): Promise<string[]> {
  const rules = await prisma.notificationRule.findMany({
    select: { id: true, name: true, targets: true, emailComposition: true, escalation: true, clearBehavior: true, clearAfterSec: true, reset: true, actions: true },
  });
  const names: string[] = [];
  const refs = (actions: AutomationAction[]) => actions.some((a) => a.type === "script" && a.scriptId === scriptId);
  for (const r of rules) {
    const v2 = normalizeRuleToV2(r);
    if (refs(v2.actions) || (v2.escalation?.tiers ?? []).some((t) => refs(t.actions))) names.push(r.name);
  }
  return names;
}

export async function deleteScript(id: string, actor?: string) {
  const script = await getScript(id);
  const referencedBy = await rulesReferencingScript(id);
  if (referencedBy.length > 0) {
    throw new AppError(409, `Script "${script.name}" is used by ${referencedBy.length} automation(s): ${referencedBy.slice(0, 5).join(", ")}${referencedBy.length > 5 ? ", …" : ""}. Remove those actions first.`);
  }
  await prisma.automationScript.delete({ where: { id } });
  await logEvent({
    action: "automation_script.deleted",
    resourceType: "automation-script",
    resourceId: id,
    resourceName: script.name,
    actor,
    level: "warning",
    message: `Automation script "${script.name}" deleted`,
    details: { sha256: script.sha256 },
  });
}

// ─── Run lifecycle ───────────────────────────────────────────────────────────

export interface ScriptRunRequest {
  scriptId: string;
  runOn: "server" | "agent";
  /** Rendered argsTemplate (fire-time snapshot); null for no args. */
  args: string | null;
  /** Action-level override; falls back to the script's default. */
  timeoutSec?: number | null;
  notificationId?: string | null;
  ruleId?: string | null;
  assetId?: string | null;
  requestedBy: string;
}

/**
 * Create a pending AutomationScriptRun. Server runs are picked up by the
 * runAutomationScripts job's claim pass; agent runs additionally enqueue an
 * AgentCommand (action="run_script") for the TRIGGERING asset's agent —
 * requiring an active agent on version ≥ MIN_AGENT_SCRIPT_VERSION (older
 * agents don't know the action; the version gate keeps it off their queue).
 * Validates: script exists + enabled + runTarget compatibility.
 */
export async function requestScriptRun(req: ScriptRunRequest): Promise<{ runId: string }> {
  const script = await getScript(req.scriptId);
  if (!script.enabled) throw new AppError(409, `Script "${script.name}" is disabled`);
  if (script.runTarget !== "either" && script.runTarget !== req.runOn) {
    throw new AppError(400, `Script "${script.name}" only runs on ${script.runTarget}; action requested ${req.runOn}`);
  }

  // Agent path preflight — fail BEFORE creating the run row so a misfire is
  // one failed-action Event, not an orphaned forever-pending run.
  let agent: { id: string } | null = null;
  if (req.runOn === "agent") {
    if (!req.assetId) throw new AppError(409, `Script "${script.name}" targets the agent, but this alert has no asset`);
    const row = await prisma.managedAgent.findUnique({
      where: { assetId: req.assetId },
      select: { id: true, installStatus: true, agentVersion: true },
    });
    if (!row) throw new AppError(409, "The triggering asset has no Polaris Agent — agent scripts require an installed agent");
    if (row.installStatus !== "active") throw new AppError(409, "The Polaris Agent on the triggering asset isn't active");
    if (!versionAtLeast(row.agentVersion, MIN_AGENT_SCRIPT_VERSION)) {
      throw new AppError(409, `The agent on the triggering asset is ${row.agentVersion ?? "unknown"} — script execution needs ${MIN_AGENT_SCRIPT_VERSION}+ (upgrade the Polaris Agent)`);
    }
    agent = { id: row.id };
  }

  const timeoutSec = Math.min(req.timeoutSec ?? script.timeoutSec, MAX_SCRIPT_TIMEOUT_SEC);
  const run = await prisma.automationScriptRun.create({
    data: {
      scriptId: script.id,
      scriptName: script.name,
      sha256: script.sha256,
      notificationId: req.notificationId ?? null,
      ruleId: req.ruleId ?? null,
      assetId: req.assetId ?? null,
      runOn: req.runOn,
      args: req.args,
      timeoutSec,
      requestedBy: req.requestedBy,
    },
  });

  if (req.runOn === "agent" && agent) {
    const cmd = await prisma.agentCommand.create({
      data: {
        assetId: req.assetId!,
        managedAgentId: agent.id,
        action: "run_script",
        target: script.name,
        payload: {
          runId: run.id,
          interpreter: script.interpreter,
          body: script.body,
          sha256: script.sha256,
          args: req.args ?? "",
          timeoutSec,
        },
        requestedBy: req.requestedBy,
      },
    });
    await prisma.automationScriptRun.update({ where: { id: run.id }, data: { agentCommandId: cmd.id } });
    // Best-effort near-real-time nudge: signal the process holding this agent's
    // WS session to push a "commands-pending" frame so the agent fetches now
    // instead of waiting for its ~20s command poll (the guaranteed floor).
    await publishCommandWake(agent.id);
  }

  return { runId: run.id };
}

/** Single run row — the Scripts-tab test-run polling read. */
export async function getRun(id: string) {
  const run = await prisma.automationScriptRun.findUnique({ where: { id } });
  if (!run) throw new AppError(404, "Script run not found");
  return run;
}

export async function listRuns(filter: { scriptId?: string; notificationId?: string; status?: string; limit?: number }) {
  return prisma.automationScriptRun.findMany({
    where: {
      ...(filter.scriptId ? { scriptId: filter.scriptId } : {}),
      ...(filter.notificationId ? { notificationId: filter.notificationId } : {}),
      ...(filter.status ? { status: filter.status } : {}),
    },
    orderBy: { requestedAt: "desc" },
    take: Math.min(filter.limit ?? 100, 500),
  });
}

/** Prune completed runs older than the retention window. Called by the runner's sweep. */
export async function pruneOldRuns(): Promise<number> {
  const cutoff = new Date(Date.now() - RUN_RETENTION_DAYS * 24 * 3600 * 1000);
  const res = await prisma.automationScriptRun.deleteMany({
    where: { requestedAt: { lt: cutoff }, status: { in: ["succeeded", "failed", "timeout"] } },
  });
  return res.count;
}
