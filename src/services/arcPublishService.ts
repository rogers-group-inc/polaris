/**
 * src/services/arcPublishService.ts — run the SSH onboarding scripts on
 * Azure Arc-connected machines.
 *
 * The Arc counterpart to intunePublishService, and deliberately shaped
 * differently because the two vehicles differ in the way that matters most:
 *
 *   Intune  — a Remediation is INERT until assigned. Polaris uploads it
 *             targeting nothing and a human assigns it. Review gate =
 *             assignment.
 *   Arc     — a run command EXECUTES the moment it is created. There is no
 *             inert state to hand a reviewer. Review gate = TARGET SELECTION,
 *             which is why this takes an explicit list of ARM ids and will not
 *             expand a filter on the caller's behalf.
 *
 * Arc is also what covers the half Intune cannot: Intune does not deploy
 * scripts to Linux, and does not manage traditional Windows Server at all.
 * Arc reaches both, and `dispatchRunCommand` sends each machine the script
 * matching its OS.
 *
 * Opt-in. Refuses unless the Arc integration carries
 * `config.allowRunCommand === true`, which the operator sets on that
 * integration's Script Publishing tab after granting the service principal a
 * role carrying `Microsoft.HybridCompute/machines/runCommands/write`. Note
 * that is an AZURE RBAC ROLE ASSIGNMENT at a subscription/resource-group
 * scope — NOT a Graph API permission like the Intune side. Different consent
 * model, common point of confusion, so the tab says so explicitly.
 */

import { prisma } from "../db.js";
import { AppError } from "../utils/errors.js";
import { logEvent } from "./eventLogService.js";
import {
  dispatchRunCommand,
  listRunCommandTargets,
  readRunCommandResult,
  type ArcRunCommandTarget,
  type ArcRunCommandDispatch,
  type AzureArcConfig,
} from "./azureArcService.js";
import { getOnboardingScript } from "./windowsSshOnboardingService.js";

/**
 * Name of the run-command resource Polaris creates on each machine. Stable, so
 * re-running replaces the previous one rather than accumulating resources —
 * and so an operator can find ours among any others in the portal.
 */
export const ARC_RUN_COMMAND_NAME = "polaris-ssh-onboarding";

/** Hard cap per dispatch. A slip in the picker should not become a fleet-wide event. */
const MAX_TARGETS_PER_DISPATCH = 200;

export interface ArcPublishTarget {
  integrationId: string;
  integrationName: string;
  enabled: boolean;
}

export async function listPublishTargets(): Promise<ArcPublishTarget[]> {
  const rows = await prisma.integration.findMany({
    where: { type: "azurearc" },
    select: { id: true, name: true, config: true },
    orderBy: { name: "asc" },
  });
  return rows.map((r) => ({
    integrationId: r.id,
    integrationName: r.name,
    enabled: ((r.config ?? {}) as Record<string, unknown>).allowRunCommand === true,
  }));
}

async function loadEnabledIntegration(
  integrationId: string,
): Promise<{ name: string; config: AzureArcConfig }> {
  const row = await prisma.integration.findUnique({ where: { id: integrationId } });
  if (!row) throw new AppError(404, "Integration not found");
  if (row.type !== "azurearc") {
    throw new AppError(400, "Running scripts requires an Azure Arc integration");
  }
  const config = (row.config ?? {}) as Record<string, unknown>;
  if (config.allowRunCommand !== true) {
    throw new AppError(
      400,
      `Running scripts is not enabled on "${row.name}" — turn on "Allow Polaris to run deployment scripts" ` +
        "on that integration's Script Publishing tab first.",
    );
  }
  return { name: row.name, config: config as unknown as AzureArcConfig };
}

/** Machines the operator can pick from. Read-only; nothing executes here. */
export async function listMachines(integrationId: string): Promise<ArcRunCommandTarget[]> {
  const { config } = await loadEnabledIntegration(integrationId);
  return listRunCommandTargets(config);
}

export interface ArcPublishResult {
  dispatched: number;
  skipped: number;
  failed: number;
  results: ArcRunCommandDispatch[];
}

/**
 * Run the onboarding script on the named machines.
 *
 * THIS EXECUTES CODE AS root/SYSTEM ON EVERY MACHINE PASSED IN. The caller is
 * responsible for having put an explicit, human-reviewed list in `armIds` —
 * there is deliberately no "all machines" affordance anywhere in this path.
 */
export async function runOnboardingOnMachines(
  integrationId: string,
  armIds: readonly string[],
  actor: string,
): Promise<ArcPublishResult> {
  if (armIds.length === 0) throw new AppError(400, "Select at least one machine");
  if (armIds.length > MAX_TARGETS_PER_DISPATCH) {
    throw new AppError(400, `At most ${MAX_TARGETS_PER_DISPATCH} machines per run`);
  }

  const { name: integrationName, config } = await loadEnabledIntegration(integrationId);

  // Resolve the ids against the live roster rather than trusting the client's
  // copy: the subscription/resourceGroup/region in the URL and body come from
  // Azure, not from a request body a caller could point elsewhere.
  const roster = await listRunCommandTargets(config);
  const byId = new Map(roster.map((m) => [m.armId.toLowerCase(), m]));
  const targets: ArcRunCommandTarget[] = [];
  const unknown: string[] = [];
  // Each machine once, however often (and in whatever case) the selection
  // names it — until 2026-11-14 a repeat created the same run command twice,
  // the second replacing the first while it might still be running as root.
  const seen = new Set<string>();
  for (const id of armIds) {
    const key = String(id).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const hit = byId.get(key);
    if (hit) targets.push(hit);
    else unknown.push(String(id));
  }
  if (targets.length === 0) {
    throw new AppError(400, "None of the selected machines are in this integration's Arc roster");
  }

  const [win, lin] = await Promise.all([
    getOnboardingScript("windows", "remediation"),
    getOnboardingScript("linux", "remediation"),
  ]);

  const results = await dispatchRunCommand(
    config,
    targets,
    { windows: win.script, linux: lin.script },
    { runCommandName: ARC_RUN_COMMAND_NAME },
  );

  const dispatched = results.filter((r) => r.dispatched).length;
  const skipped = results.filter((r) => r.skipped).length;
  const failed = results.filter((r) => !r.dispatched && !r.skipped).length;

  // Warning level: this ran code as root/SYSTEM on real machines. One event
  // for the batch with the per-machine roll-up — a per-machine event at 200
  // targets would bury the Events page.
  await logEvent({
    action: "arc.run_command_executed",
    resourceType: "integration",
    resourceId: integrationId,
    resourceName: integrationName,
    actor,
    level: "warning",
    message:
      `Ran the SSH onboarding script on ${dispatched} Arc machine(s) via "${integrationName}" ` +
      `(${skipped} skipped, ${failed} failed) — the script grants administrative SSH access`,
    details: {
      runCommandName: ARC_RUN_COMMAND_NAME,
      dispatched, skipped, failed,
      machines: results.map((r) => ({ name: r.name, dispatched: r.dispatched, skipped: r.skipped, error: r.error })),
      ...(unknown.length ? { unknownArmIds: unknown } : {}),
    },
  });

  return { dispatched, skipped, failed, results };
}

/** Poll one machine's outcome after a dispatch. */
export async function getMachineResult(integrationId: string, armId: string) {
  const { config } = await loadEnabledIntegration(integrationId);
  const roster = await listRunCommandTargets(config);
  const target = roster.find((m) => m.armId.toLowerCase() === String(armId).toLowerCase());
  if (!target) throw new AppError(404, "Machine not found in this integration's Arc roster");
  return readRunCommandResult(config, target, ARC_RUN_COMMAND_NAME);
}
