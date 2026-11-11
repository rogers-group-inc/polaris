/**
 * src/services/assetRemovalService.ts — what an asset leaves behind when its
 * row goes: nothing the database's foreign keys do not already take, and
 * nothing a merge's survivor should have kept (business rule 157).
 *
 * The 2026-11-11 orphan audit found that every delete path ended at
 * `prisma.asset.delete` and trusted the cascade. But a dozen places hold an
 * asset id with NO foreign key — string arrays (`PathCheck.assetIds`,
 * `Contact.assetIds`, `MaintenanceSchedule.assetIds`), JSON
 * (`NotificationRule.scope.assetIds`, the Application Map's rules in a
 * Setting), and plain columns on tables deliberately left without an FK
 * (`LogFlagRule`, `AssetProcessConfig`, `AssetProcess`, `AssetService`,
 * `AssetSdwanRule`, `AssetInventoryScrape`, `AgentCommand`). After a delete
 * those kept naming a device that no longer existed: a log rule nobody could
 * find and still compiled, a path check pinned to a host its editor could not
 * show or untick, a queued agent script for a host that was gone. After a
 * MERGE it was worse — the same ids named the absorbed record, so the survivor
 * silently fell out of every path check, contact, maintenance window and
 * automation the absorbed one had been pinned to.
 *
 * Two entry points, both called AFTER the delete or merge has committed:
 *
 *   `afterAssetsDeleted(ids)`        — drop or prune every reference.
 *   `afterAssetMerged(from, to)`     — re-point every reference that expresses
 *                                      operator intent to the survivor, then
 *                                      drop what is left of the absorbed id.
 *
 * Post-commit, not inside the caller's transaction, on purpose: none of these
 * rows cascade (so they are all still there after the commit), and a re-point
 * inside a transaction that then rolled back would have moved intent off a
 * record that still exists. Both are best-effort — a failure is logged and
 * never undoes a delete or merge that already happened; the references are
 * then merely stale, as they always were before this service existed.
 *
 * Never widen a target: several lists read "empty" as "everything". Removing
 * the last id from an automation's `scope.assetIds`, or from an Application
 * Map rule with no device filter, would turn "this one device" into "every
 * device". Those are handled explicitly below (`pruneMayWiden`).
 */

import { prisma } from "../db.js";
import { logger } from "../utils/logger.js";
import { chunkArray } from "../utils/chunk.js";
import { getConfig as getAppMapConfig, saveConfig as saveAppMapConfig } from "./appMapDiscoveryService.js";

const ID_CHUNK = 500;

export interface AssetReferenceCounts {
  pathChecks: number;
  contacts: number;
  maintenanceSchedules: number;
  notificationRules: number;
  appMapRules: number;
  logFlagRules: number;
  processConfigs: number;
  agentCommands: number;
  scriptRuns: number;
  /** Current-state rows with no FK: processes, services, SD-WAN rules, inventory scrapes. */
  stateRows: number;
}

function emptyCounts(): AssetReferenceCounts {
  return {
    pathChecks: 0, contacts: 0, maintenanceSchedules: 0, notificationRules: 0, appMapRules: 0,
    logFlagRules: 0, processConfigs: 0, agentCommands: 0, scriptRuns: 0, stateRows: 0,
  };
}

/** `ids` with `from` replaced by `to`, order kept, no duplicate. Pure. */
export function repointIdList(ids: readonly string[], from: string, to: string): string[] {
  const out: string[] = [];
  for (const id of ids) {
    const next = id === from ? to : id;
    if (!out.includes(next)) out.push(next);
  }
  return out;
}

/** `ids` without any of `gone`, order kept. Pure. */
export function pruneIdList(ids: readonly string[], gone: ReadonlySet<string>): string[] {
  return ids.filter((id) => !gone.has(id));
}

// ─── The three string-array pin lists ───────────────────────────────────────
// An empty list is safe on all three: a path check with no pins and no filter
// targets nothing (`pathCheckService → membersFor`), a contact's pins are
// unioned with its filter, and a maintenance schedule's targets are
// union(criteria, assetIds) with an empty union meaning none.

type PinRow = { id: string; assetIds: string[] };

async function rewritePinLists(
  ids: readonly string[],
  rewrite: (list: string[]) => string[],
): Promise<{ pathChecks: number; contacts: number; maintenanceSchedules: number }> {
  const where = { assetIds: { hasSome: [...ids] } };
  const select = { id: true, assetIds: true } as const;
  const [checks, contacts, schedules] = await Promise.all([
    prisma.pathCheck.findMany({ where, select }) as Promise<PinRow[]>,
    prisma.contact.findMany({ where, select }) as Promise<PinRow[]>,
    prisma.maintenanceSchedule.findMany({ where, select }) as Promise<PinRow[]>,
  ]);
  await Promise.all([
    ...checks.map((r) => prisma.pathCheck.update({ where: { id: r.id }, data: { assetIds: rewrite(r.assetIds) } })),
    ...contacts.map((r) => prisma.contact.update({ where: { id: r.id }, data: { assetIds: rewrite(r.assetIds) } })),
    ...schedules.map((r) => prisma.maintenanceSchedule.update({ where: { id: r.id }, data: { assetIds: rewrite(r.assetIds) } })),
  ]);
  return { pathChecks: checks.length, contacts: contacts.length, maintenanceSchedules: schedules.length };
}

// ─── Lists where "empty" means "everything" ─────────────────────────────────

/**
 * Would removing `gone` from this list leave it empty — and so, for a list
 * whose emptiness means "no restriction", widen the target from a few named
 * devices to all of them? Pure.
 */
export function pruneMayWiden(ids: readonly string[], gone: ReadonlySet<string>): boolean {
  return ids.length > 0 && ids.every((id) => gone.has(id));
}

/**
 * An automation's `scope.assetIds`. On a MERGE the absorbed id is replaced by
 * the survivor's. On a DELETE the list is left exactly as it is: a dead id
 * matches no device, which is the correct reading of "this automation was
 * about that device", whereas an emptied list means "no device restriction"
 * (`notifications/scope.ts`). The operator removes it in the wizard.
 */
async function repointRuleScopes(from: string, to: string): Promise<number> {
  const rules = await prisma.notificationRule.findMany({
    where: { scope: { path: ["assetIds"], array_contains: [from] } },
    select: { id: true, scope: true },
  });
  await Promise.all(rules.map((r) => {
    const scope = (r.scope ?? {}) as Record<string, unknown>;
    const list = Array.isArray(scope.assetIds) ? (scope.assetIds as string[]) : [];
    return prisma.notificationRule.update({
      where: { id: r.id },
      data: { scope: { ...scope, assetIds: repointIdList(list, from, to) } as object },
    });
  }));
  return rules.length;
}

/**
 * The Application Map's discovery rules (one Setting blob). A rule with no
 * device filter and an empty pin list means EVERY monitored asset, so:
 *   - an AUTO rule that loses its last device is deleted, as un-pinning does
 *     (`appMapDiscoveryService → applyPinChangesToConfig`);
 *   - a MANUAL rule with no filter keeps its last dead id rather than widen;
 *   - anything else is simply pruned.
 * `to` set = a merge: the id is replaced instead.
 */
async function rewriteAppMapRules(gone: ReadonlySet<string>, to: string | null): Promise<number> {
  const cfg = await getAppMapConfig();
  let touched = 0;
  const kept = [];
  for (const rule of cfg.rules) {
    if (!rule.assetIds.some((id) => gone.has(id))) { kept.push(rule); continue; }
    touched += 1;
    if (to !== null) {
      let list = rule.assetIds;
      for (const from of gone) list = repointIdList(list, from, to);
      kept.push({ ...rule, assetIds: list });
      continue;
    }
    if (rule.scope === null && pruneMayWiden(rule.assetIds, gone)) {
      if (rule.source === "auto") continue; // deleted with its last device
      kept.push(rule);                      // manual: never widen
      continue;
    }
    kept.push({ ...rule, assetIds: pruneIdList(rule.assetIds, gone) });
  }
  if (touched > 0) await saveAppMapConfig({ ...cfg, rules: kept });
  return touched;
}

// ─── Rows that hold the id in a plain column, with no foreign key ───────────

const GONE_NOTE = "withdrawn: the device this was queued for was deleted or merged away";

/**
 * Drop everything that names `ids` and is meaningless without the asset:
 * per-asset log rules and process log config, the current-state tables, and
 * commands / script runs still waiting on an agent that went with it.
 */
async function purgeAssetRows(ids: readonly string[]): Promise<Pick<AssetReferenceCounts, "logFlagRules" | "processConfigs" | "agentCommands" | "scriptRuns" | "stateRows">> {
  const out = { logFlagRules: 0, processConfigs: 0, agentCommands: 0, scriptRuns: 0, stateRows: 0 };
  const now = new Date();
  for (const chunk of chunkArray(ids, ID_CHUNK)) {
    const where = { assetId: { in: chunk } };
    const [rules, configs, procs, services, sdwan, scrapes, commands, runs] = await prisma.$transaction([
      prisma.logFlagRule.deleteMany({ where }),
      prisma.assetProcessConfig.deleteMany({ where }),
      prisma.assetProcess.deleteMany({ where }),
      prisma.assetService.deleteMany({ where }),
      prisma.assetSdwanRule.deleteMany({ where }),
      prisma.assetInventoryScrape.deleteMany({ where }),
      prisma.agentCommand.updateMany({
        where: { ...where, status: { in: ["pending", "sent"] } },
        data: { status: "failed", error: GONE_NOTE, completedAt: now },
      }),
      prisma.automationScriptRun.updateMany({
        where: { ...where, runOn: "agent", status: { in: ["pending", "running"] } },
        data: { status: "failed", stderr: GONE_NOTE, completedAt: now },
      }),
    ]);
    out.logFlagRules += rules.count;
    out.processConfigs += configs.count;
    out.stateRows += procs.count + services.count + sdwan.count + scrapes.count;
    out.agentCommands += commands.count;
    out.scriptRuns += runs.count;
  }
  return out;
}

/**
 * The absorbed asset's per-asset rows that express OPERATOR intent move to the
 * survivor: its log-flag rules, and its per-process log configuration where
 * the survivor has none for that program (the survivor's own wins a clash).
 * Commands queued for an agent that moved with the merge follow it.
 */
async function repointAssetRows(from: string, to: string): Promise<Pick<AssetReferenceCounts, "logFlagRules" | "processConfigs" | "agentCommands" | "scriptRuns">> {
  const [rules, fromConfigs, toConfigs, agent] = await Promise.all([
    prisma.logFlagRule.updateMany({ where: { assetId: from }, data: { assetId: to } }),
    prisma.assetProcessConfig.findMany({ where: { assetId: from }, select: { id: true, name: true } }),
    prisma.assetProcessConfig.findMany({ where: { assetId: to }, select: { name: true } }),
    prisma.managedAgent.findUnique({ where: { assetId: to }, select: { id: true } }),
  ]);
  const taken = new Set(toConfigs.map((c) => c.name));
  const movable = fromConfigs.filter((c) => !taken.has(c.name)).map((c) => c.id);
  const moved = movable.length
    ? await prisma.assetProcessConfig.updateMany({ where: { id: { in: movable } }, data: { assetId: to } })
    : { count: 0 };

  let agentCommands = 0;
  let scriptRuns = 0;
  if (agent) {
    // Only commands riding the agent the survivor now holds; anything queued
    // for an agent that did not survive the merge is withdrawn by the purge.
    const live = await prisma.agentCommand.findMany({
      where: { assetId: from, managedAgentId: agent.id, status: { in: ["pending", "sent"] } },
      select: { id: true },
    });
    if (live.length > 0) {
      const cmdIds = live.map((c) => c.id);
      const [c, r] = await prisma.$transaction([
        prisma.agentCommand.updateMany({ where: { id: { in: cmdIds } }, data: { assetId: to } }),
        prisma.automationScriptRun.updateMany({ where: { agentCommandId: { in: cmdIds } }, data: { assetId: to } }),
      ]);
      agentCommands = c.count;
      scriptRuns = r.count;
    }
  }
  return { logFlagRules: rules.count, processConfigs: moved.count, agentCommands, scriptRuns };
}

// ─── Entry points ───────────────────────────────────────────────────────────

/**
 * Call after one or more assets have been deleted (single delete, bulk
 * delete). Prunes the pin lists, the Application Map rules, and purges the
 * FK-less rows. Best-effort: resolves with the counts, or with `null` after
 * logging when something failed.
 *
 * Cost is proportional to what referenced the deleted assets, never to the
 * fleet: three indexed array reads, one Setting read, and one batched
 * transaction per 500 ids.
 */
export async function afterAssetsDeleted(ids: readonly string[]): Promise<AssetReferenceCounts | null> {
  if (ids.length === 0) return emptyCounts();
  try {
    const gone = new Set(ids);
    const counts = emptyCounts();
    for (const chunk of chunkArray(ids, ID_CHUNK)) {
      const pins = await rewritePinLists(chunk, (list) => pruneIdList(list, gone));
      counts.pathChecks += pins.pathChecks;
      counts.contacts += pins.contacts;
      counts.maintenanceSchedules += pins.maintenanceSchedules;
    }
    counts.appMapRules = await rewriteAppMapRules(gone, null);
    Object.assign(counts, await purgeAssetRows(ids));
    return counts;
  } catch (err) {
    logger.warn({ err, assets: ids.length }, "asset removal: reference clean-up failed after a delete");
    return null;
  }
}

/**
 * Call after `fromId` has been merged into `toId` and deleted. Re-points the
 * pin lists, automation scopes, Application Map rules, log rules and process
 * log config to the survivor, then purges what is left under the absorbed id
 * (its own process / service / SD-WAN / scrape rows — the survivor has its
 * own — and commands for an agent that did not survive).
 */
export async function afterAssetMerged(fromId: string, toId: string): Promise<AssetReferenceCounts | null> {
  if (!fromId || !toId || fromId === toId) return emptyCounts();
  try {
    const counts = emptyCounts();
    const pins = await rewritePinLists([fromId], (list) => repointIdList(list, fromId, toId));
    counts.pathChecks = pins.pathChecks;
    counts.contacts = pins.contacts;
    counts.maintenanceSchedules = pins.maintenanceSchedules;
    counts.notificationRules = await repointRuleScopes(fromId, toId);
    counts.appMapRules = await rewriteAppMapRules(new Set([fromId]), toId);
    const moved = await repointAssetRows(fromId, toId);
    const purged = await purgeAssetRows([fromId]);
    counts.logFlagRules = moved.logFlagRules;
    counts.processConfigs = moved.processConfigs;
    counts.agentCommands = moved.agentCommands + purged.agentCommands;
    counts.scriptRuns = moved.scriptRuns + purged.scriptRuns;
    counts.stateRows = purged.stateRows;
    return counts;
  } catch (err) {
    logger.warn({ err, fromId, toId }, "asset removal: reference re-point failed after a merge");
    return null;
  }
}
