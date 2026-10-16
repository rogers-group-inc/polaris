/**
 * src/services/firmwareGroupService.ts — a GROUP firmware upgrade (business
 * rule 122): one controlling FortiGate and the FortiSwitches / FortiAPs behind
 * it, selected together on the Assets page, booked for one time, and flashed
 * in dependency order the way fortinet-updater does it.
 *
 * Planning (`planGroup`, shared by the dialog's preview and the booking):
 *   - every selected device must resolve to ONE controlling FortiGate (a
 *     firewall is its own; a switch / AP through `controllerGateIdOf`, falling
 *     back to the dependency tree) discovered by the same integration;
 *   - each device is assessed with `assessGroupCandidate` against the model's
 *     PRIMARY image; one already on it, with no image in the Repository, an HA
 *     member, unreachable or with no login bound is DROPPED (stored, with why);
 *   - the topology snapshot — every ancestor up to the gate, and MCLAG peers —
 *     is taken from `asset_dependency_parents` level by level (one query per
 *     level, not one walk per device), falling back to the Fortinet stamps.
 *
 * Execution (`advanceGroup`, run by the minute job and right after every
 * member's run ends):
 *   - deepest first; never a device beside a running ancestor, descendant or
 *     MCLAG peer; at most `concurrency` at once (parallelism only ever happens
 *     across independent branches);
 *   - a parent starts only when everything planned behind it ended upgraded /
 *     already-current / dropped / skipped-for-health. Anything else behind it
 *     (failed, unverified, skipped as upstream, timed out, cancelled) skips it
 *     as `subtree` — nothing is sent to it. Independent branches carry on;
 *   - health is taken live just before each device starts (`healthBlockers`:
 *     down / warning / recovering / dependency-suppressed / unmonitorable / no
 *     address). An unhealthy device is skipped and the group moves straight to
 *     the next — and a health skip does NOT hold back its ancestors;
 *   - each flash is an ordinary rule-87 run through `startFirmwareUpgrade`
 *     (every gate, the hold, the Events); a related flash running elsewhere
 *     makes the member wait, for up to CONFLICT_WAIT_MS.
 *
 * The group's state lives in the database, so a restart loses nothing: the
 * boot sweep fails an orphaned run, and the next pass reads that result.
 * One summary email goes to the booking's recipients when it ends.
 */

import { prisma } from "../db.js";
import { AppError } from "../utils/errors.js";
import { logger } from "../utils/logger.js";
import { logEvent } from "./eventLogService.js";
import type { CredentialUseActor } from "./credentialUseAuditService.js";
import {
  FIRMWARE_ASSET_SELECT,
  FirmwareRunConflictError,
  assessGroupCandidate,
  healthBlockers,
  recordFirmwareCredentialUse,
  startFirmwareUpgrade,
  type FirmwareAssetRow,
  type GroupDropKind,
} from "./firmwareUpgradeService.js";
import { CONFLICT_WAIT_MS, LATE_GRACE_MS, assertSchedulableTime, normalizeRecipients } from "./firmwareScheduleService.js";
import { applyBrandLetterhead, sendEmailThroughChannel } from "./notificationDeliveryService.js";
import { resolveSummaryChannel } from "./quietTimeSummaryService.js";
import { resolveTimeZone, serverTimeZone } from "./userTimezoneService.js";
import { buildInfraParentIndex, controllerGateIdOf, readParentSwitchStamp, resolveInfraParentAsset, type InfraParentCandidate } from "../utils/fortinetParentKey.js";
import { renderFirmwareGroupResultEmail, type GroupEmailMember, type GroupMemberState, type GroupOutcome } from "../utils/firmwareGroupResultEmailTemplate.js";

/** The most devices one group may select — the bulk cap maintenance uses. */
export const MAX_GROUP_SIZE = 500;
export const MAX_CONCURRENCY = 10;
const MAX_HOPS = 16;
const ASSESS_CHUNK = 10;
const ELIGIBLE_TYPES = new Set(["firewall", "switch", "access_point"]);

export const TERMINAL_MEMBER_STATES = new Set<GroupMemberState>(["upgraded", "already-current", "failed", "unverified", "skipped", "dropped"]);
const ACTIVE_GROUP_STATUSES = ["pending", "running"] as const;

function nameOf(a: { hostname: string | null; ipAddress: string | null; id: string }): string {
  return a.hostname || a.ipAddress || a.id;
}

// ─── Sources (which FortiGate each selected device sits under) ───────────────

export interface GroupSource {
  gateAssetId: string;
  gateName: string;
  integrationId: string | null;
  integrationName: string | null;
  assetIds: string[];
}

export interface UnplacedAsset {
  assetId: string;
  name: string;
  reason: string;
}

export interface SourcesResult {
  sources: GroupSource[];
  /** Switches / APs with no controlling FortiGate Polaris can name, or one discovered by another integration than their gate. */
  unresolved: UnplacedAsset[];
  /** Selected assets that are not a FortiGate, FortiSwitch or FortiAP. */
  unsupported: UnplacedAsset[];
}

interface Topology {
  /** Effective parents per asset (override wins over computed, as the connection path reads them). */
  parentsOf: Map<string, string[]>;
  typeOf: Map<string, string>;
}

/**
 * Walk `asset_dependency_parents` upward from the selection, one query per
 * LEVEL (≤ MAX_HOPS), never one walk per device. A device with no rows falls
 * back to its Fortinet stamps: an AP's parentSwitch, else its controller.
 */
async function loadTopology(selected: readonly FirmwareAssetRow[], infra: readonly InfraParentCandidate[]): Promise<Topology> {
  const parentsOf = new Map<string, string[]>();
  const typeOf = new Map<string, string>();
  for (const c of infra) typeOf.set(c.id, c.assetType);
  for (const a of selected) typeOf.set(a.id, a.assetType);
  const index = buildInfraParentIndex(infra as InfraParentCandidate[]);
  const topoOf = new Map<string, unknown>();
  for (const c of infra) topoOf.set(c.id, c.fortinetTopology);
  for (const a of selected) topoOf.set(a.id, a.fortinetTopology);

  let frontier = [...new Set(selected.filter((a) => a.assetType !== "firewall").map((a) => a.id))];
  const seen = new Set<string>(frontier);
  for (let level = 0; frontier.length > 0 && level < MAX_HOPS; level++) {
    const rows = await prisma.assetDependencyParent.findMany({
      where: { assetId: { in: frontier }, source: { in: ["override", "computed"] } },
      select: { assetId: true, parentAssetId: true, source: true, parent: { select: { assetType: true } } },
    });
    const byChild = new Map<string, typeof rows>();
    for (const r of rows) {
      const list = byChild.get(r.assetId);
      if (list) list.push(r); else byChild.set(r.assetId, [r]);
      typeOf.set(r.parentAssetId, r.parent.assetType);
    }
    const next: string[] = [];
    for (const id of frontier) {
      const own = byChild.get(id) ?? [];
      const overrides = own.filter((r) => r.source === "override");
      let parents = (overrides.length > 0 ? overrides : own).map((r) => r.parentAssetId);
      if (parents.length === 0) {
        // Fallback: the Fortinet stamps, resolved through the parent-key
        // helpers (never a hostname match against a FortiManager device name).
        const cand: InfraParentCandidate = { id, hostname: null, serialNumber: null, assetType: typeOf.get(id) ?? "", fortinetTopology: topoOf.get(id) };
        const viaSwitch = typeOf.get(id) === "access_point"
          ? resolveInfraParentAsset(index, readParentSwitchStamp(topoOf.get(id)), "switch")
          : null;
        const gate = controllerGateIdOf(index, cand);
        parents = viaSwitch ? [viaSwitch.id] : gate ? [gate] : [];
      }
      parents = parents.filter((p) => p !== id);
      parentsOf.set(id, parents);
      for (const p of parents) {
        if (typeOf.get(p) === "firewall" || seen.has(p)) continue;
        seen.add(p);
        next.push(p);
      }
    }
    frontier = next;
  }
  return { parentsOf, typeOf };
}

/** Every ancestor of `id` up to (and including) the first firewall on each branch, nearest first. Pure. */
export function ancestorsOf(id: string, topo: Pick<Topology, "parentsOf" | "typeOf">): string[] {
  const out: string[] = [];
  const seen = new Set<string>([id]);
  let layer = [id];
  for (let i = 0; layer.length > 0 && i < MAX_HOPS; i++) {
    const next: string[] = [];
    for (const n of layer) {
      if (n !== id && topo.typeOf.get(n) === "firewall") continue;
      for (const p of topo.parentsOf.get(n) ?? []) {
        if (seen.has(p)) continue;
        seen.add(p);
        out.push(p);
        next.push(p);
      }
    }
    layer = next;
  }
  return out;
}

/** 1 = a FortiGate; 2 = directly behind one; … — the LONGEST path up, so a dual-homed device sorts below both its uplinks. Pure. */
export function depthOf(id: string, topo: Pick<Topology, "parentsOf" | "typeOf">, memo = new Map<string, number>(), stack = new Set<string>()): number {
  if (topo.typeOf.get(id) === "firewall") return 1;
  const known = memo.get(id);
  if (known !== undefined) return known;
  if (stack.has(id)) return 1; // a cycle in bad data: stop climbing
  stack.add(id);
  const parents = topo.parentsOf.get(id) ?? [];
  const d = parents.length === 0 ? 2 : 1 + Math.max(...parents.map((p) => depthOf(p, topo, memo, stack)));
  stack.delete(id);
  memo.set(id, d);
  return d;
}

interface Resolution {
  selected: FirmwareAssetRow[];
  topo: Topology;
  sources: SourcesResult;
  gateOf: Map<string, string>;
}

async function resolve(assetIds: readonly string[]): Promise<Resolution> {
  const ids = [...new Set(assetIds)];
  if (ids.length === 0) throw new AppError(400, "Select at least one device");
  if (ids.length > MAX_GROUP_SIZE) throw new AppError(400, `A group upgrade can select at most ${MAX_GROUP_SIZE} devices`);
  const selected = await prisma.asset.findMany({ where: { id: { in: ids } }, select: FIRMWARE_ASSET_SELECT }) as FirmwareAssetRow[];
  if (selected.length !== ids.length) throw new AppError(404, `${ids.length - selected.length} of the selected assets no longer exist — refresh the list`);

  // One read of the gates and switches the stamps can name. Tight select:
  // this is every Fortinet-infra row in the fleet, not the selection.
  const infra = await prisma.asset.findMany({
    where: { assetType: { in: ["firewall", "switch"] } },
    select: { id: true, hostname: true, serialNumber: true, assetType: true, fortinetTopology: true, discoveredByIntegrationId: true, ipAddress: true },
  });
  const topo = await loadTopology(selected, infra);
  const index = buildInfraParentIndex(infra);
  const infraById = new Map(infra.map((c) => [c.id, c]));

  const unsupported: UnplacedAsset[] = [];
  const unresolved: UnplacedAsset[] = [];
  const gateOf = new Map<string, string>();
  for (const a of selected) {
    if (!ELIGIBLE_TYPES.has(a.assetType)) {
      unsupported.push({ assetId: a.id, name: nameOf(a), reason: "only FortiGates, FortiSwitches and FortiAPs can be group-upgraded" });
      continue;
    }
    if (a.assetType === "firewall") { gateOf.set(a.id, a.id); continue; }
    let gate = controllerGateIdOf(index, { id: a.id, hostname: a.hostname, serialNumber: a.serialNumber, assetType: a.assetType, fortinetTopology: a.fortinetTopology });
    if (!gate) gate = ancestorsOf(a.id, topo).find((p) => topo.typeOf.get(p) === "firewall") ?? null;
    if (!gate) {
      unresolved.push({ assetId: a.id, name: nameOf(a), reason: "Polaris cannot tell which FortiGate controls it (no controller stamp, or the gate has not been discovered)" });
      continue;
    }
    gateOf.set(a.id, gate);
  }

  // Same integration as the gate: a switch another integration reports is not
  // part of this gate's fleet as far as the group is concerned.
  const gateRows = new Map<string, { id: string; hostname: string | null; ipAddress: string | null; discoveredByIntegrationId: string | null }>();
  const missingGateIds = [...new Set(gateOf.values())].filter((g) => !infraById.has(g));
  for (const g of infra) if (g.assetType === "firewall") gateRows.set(g.id, g);
  if (missingGateIds.length) {
    for (const g of await prisma.asset.findMany({ where: { id: { in: missingGateIds } }, select: { id: true, hostname: true, ipAddress: true, discoveredByIntegrationId: true } })) gateRows.set(g.id, g);
  }
  for (const a of selected) {
    const g = gateOf.get(a.id);
    if (!g || g === a.id) continue;
    const gateIntegration = gateRows.get(g)?.discoveredByIntegrationId ?? null;
    if (a.discoveredByIntegrationId && gateIntegration && a.discoveredByIntegrationId !== gateIntegration) {
      gateOf.delete(a.id);
      unresolved.push({ assetId: a.id, name: nameOf(a), reason: `it was discovered by a different integration than its FortiGate ${nameOf(gateRows.get(g)!)}` });
    }
  }

  const integrationIds = [...new Set([...gateRows.values()].map((g) => g.discoveredByIntegrationId).filter((x): x is string => !!x))];
  const integrations = integrationIds.length
    ? await prisma.integration.findMany({ where: { id: { in: integrationIds } }, select: { id: true, name: true } })
    : [];
  const integrationName = new Map(integrations.map((i) => [i.id, i.name]));

  const byGate = new Map<string, string[]>();
  for (const a of selected) {
    const g = gateOf.get(a.id);
    if (!g) continue;
    const list = byGate.get(g);
    if (list) list.push(a.id); else byGate.set(g, [a.id]);
  }
  const sources: GroupSource[] = [...byGate.entries()].map(([g, list]) => {
    const row = gateRows.get(g);
    const integrationId = row?.discoveredByIntegrationId ?? null;
    return {
      gateAssetId: g,
      gateName: row ? nameOf(row) : g,
      integrationId,
      integrationName: integrationId ? integrationName.get(integrationId) ?? null : null,
      assetIds: list,
    };
  }).sort((x, y) => x.gateName.localeCompare(y.gateName));

  return { selected, topo, sources: { sources, unresolved, unsupported }, gateOf };
}

/**
 * The red-button read (rule 122): which FortiGate each selected device sits
 * under. No image or credential work — one asset read, one infra read, the
 * level-by-level parent walk.
 */
export async function resolveGroupSources(assetIds: readonly string[]): Promise<SourcesResult> {
  return (await resolve(assetIds)).sources;
}

// ─── Planning ────────────────────────────────────────────────────────────────

export interface PlannedMember {
  assetId: string;
  name: string;
  assetType: string;
  model: string | null;
  depth: number;
  ancestorIds: string[];
  mclagPeerIds: string[];
  fromVersion: string | null;
  toVersion: string;
  imageId: string;
  warnings: string[];
}

export interface DroppedMember {
  assetId: string;
  name: string;
  assetType: string;
  model: string | null;
  depth: number;
  fromVersion: string | null;
  kind: GroupDropKind;
  reason: string;
}

export interface GroupPlan {
  gate: { assetId: string; name: string; integrationId: string | null; integrationName: string | null };
  /** Upgrade order: deepest first, then name. */
  included: PlannedMember[];
  dropped: DroppedMember[];
  /** Pending single-device bookings on included devices — booking the group cancels them. */
  individualBookings: Array<{ scheduleId: string; assetId: string; name: string; scheduledFor: Date; toVersion: string }>;
  /** A pending / running group already booked on this gate — this one cannot be booked while it exists. */
  existingGroup: { id: string; scheduledFor: Date; status: string } | null;
  /** Included devices already in another gate's active group. */
  otherGroups: Array<{ assetId: string; name: string; groupId: string }>;
}

function orderKey(a: { depth: number; name: string }, b: { depth: number; name: string }): number {
  return b.depth - a.depth || a.name.localeCompare(b.name);
}

export async function planGroup(assetIds: readonly string[]): Promise<GroupPlan> {
  const r = await resolve(assetIds);
  const { sources, unresolved, unsupported } = r.sources;
  if (unsupported.length > 0) {
    throw new AppError(400, `Only FortiGates, FortiSwitches and FortiAPs can be group-upgraded — ${unsupported.map((u) => u.name).join(", ")} ${unsupported.length === 1 ? "is" : "are"} not`);
  }
  if (unresolved.length > 0) {
    throw new AppError(400, `A group upgrade runs against one FortiGate; Polaris cannot place ${unresolved.map((u) => `${u.name} (${u.reason})`).join("; ")}`);
  }
  if (sources.length !== 1) {
    throw new AppError(400, `A group upgrade runs against one FortiGate at a time — the selection spans ${sources.length}: ${sources.map((s) => `${s.gateName} (${s.assetIds.length})`).join(", ")}`);
  }
  const src = sources[0];

  const memo = new Map<string, number>();
  const memberIds = new Set(r.selected.map((a) => a.id));
  const peers = await prisma.assetMclagPeer.findMany({
    where: { assetId: { in: [...memberIds] }, matchedAssetId: { not: null } },
    select: { assetId: true, matchedAssetId: true },
  });
  const peersOf = new Map<string, string[]>();
  for (const p of peers) {
    if (!p.matchedAssetId) continue;
    for (const [x, y] of [[p.assetId, p.matchedAssetId], [p.matchedAssetId, p.assetId]] as const) {
      const list = peersOf.get(x) ?? [];
      if (!list.includes(y)) list.push(y);
      peersOf.set(x, list);
    }
  }

  // Assess in small parallel chunks: a few point queries each.
  const assessed: Array<{ a: FirmwareAssetRow; res: Awaited<ReturnType<typeof assessGroupCandidate>> }> = [];
  for (let i = 0; i < r.selected.length; i += ASSESS_CHUNK) {
    const chunk = r.selected.slice(i, i + ASSESS_CHUNK);
    assessed.push(...await Promise.all(chunk.map(async (a) => ({ a, res: await assessGroupCandidate(a) }))));
  }

  // A FortiGate-managed FortiAP usually has its local web UI off, so the
  // direct flash fails — warn on every AP no run has ever flashed.
  const apIds = assessed.filter((x) => x.res.ok && x.a.assetType === "access_point").map((x) => x.a.id);
  const flashedAps = apIds.length
    ? new Set((await prisma.firmwareUpgradeRun.findMany({ where: { assetId: { in: apIds }, status: "succeeded" }, select: { assetId: true }, distinct: ["assetId"] })).map((x) => x.assetId))
    : new Set<string>();

  const included: PlannedMember[] = [];
  const dropped: DroppedMember[] = [];
  for (const { a, res } of assessed) {
    const depth = depthOf(a.id, r.topo, memo);
    if (!res.ok) {
      dropped.push({ assetId: a.id, name: nameOf(a), assetType: a.assetType, model: a.model, depth, fromVersion: a.osVersion, kind: res.kind, reason: res.reason });
      continue;
    }
    const warnings = [...res.warnings];
    if (a.assetType === "access_point" && !flashedAps.has(a.id)) {
      warnings.push("no firmware upgrade has succeeded on this FortiAP before — a FortiGate-managed FortiAP usually has its local web UI turned off, and a failure here skips the switch and FortiGate above it");
    }
    included.push({
      assetId: a.id,
      name: nameOf(a),
      assetType: a.assetType,
      model: a.model,
      depth,
      ancestorIds: a.assetType === "firewall" ? [] : ancestorsOf(a.id, r.topo),
      mclagPeerIds: (peersOf.get(a.id) ?? []).filter((p) => memberIds.has(p)),
      fromVersion: res.fromVersion,
      toVersion: res.image.versionLabel,
      imageId: res.image.id,
      warnings,
    });
  }
  included.sort(orderKey);
  dropped.sort(orderKey);

  const includedIds = included.map((m) => m.assetId);
  const nameById = new Map(r.selected.map((a) => [a.id, nameOf(a)]));
  const [bookings, existing, others] = await Promise.all([
    includedIds.length
      ? prisma.firmwareUpgradeSchedule.findMany({ where: { assetId: { in: includedIds }, status: "pending" }, select: { id: true, assetId: true, scheduledFor: true, toVersion: true } })
      : Promise.resolve([]),
    prisma.firmwareGroupSchedule.findFirst({ where: { gateAssetId: src.gateAssetId, status: { in: [...ACTIVE_GROUP_STATUSES] } }, select: { id: true, scheduledFor: true, status: true } }),
    includedIds.length
      ? prisma.firmwareGroupMember.findMany({
        where: { assetId: { in: includedIds }, state: { notIn: [...TERMINAL_MEMBER_STATES] }, group: { status: { in: [...ACTIVE_GROUP_STATUSES] }, gateAssetId: { not: src.gateAssetId } } },
        select: { assetId: true, groupId: true },
      })
      : Promise.resolve([]),
  ]);

  return {
    gate: { assetId: src.gateAssetId, name: src.gateName, integrationId: src.integrationId, integrationName: src.integrationName },
    included,
    dropped,
    individualBookings: bookings.map((b) => ({ scheduleId: b.id, assetId: b.assetId, name: nameById.get(b.assetId) ?? b.assetId, scheduledFor: b.scheduledFor, toVersion: b.toVersion })),
    existingGroup: existing,
    otherGroups: others.map((o) => ({ assetId: o.assetId, name: nameById.get(o.assetId) ?? o.assetId, groupId: o.groupId })),
  };
}

// ─── Booking / cancelling ────────────────────────────────────────────────────

export interface CreateGroupInput {
  assetIds: string[];
  scheduledFor: Date;
  concurrency: number;
  notifyEmails: string[];
  /** The operator saw and accepted that pending single-device bookings on these devices are cancelled. */
  cancelIndividual: boolean;
  actor: string;
  now?: Date;
}

export async function createGroupSchedule(input: CreateGroupInput): Promise<{ group: GroupDetail; plan: GroupPlan }> {
  assertSchedulableTime(input.scheduledFor, input.now);
  const recipients = normalizeRecipients(input.notifyEmails);
  if (!Number.isInteger(input.concurrency) || input.concurrency < 1 || input.concurrency > MAX_CONCURRENCY) {
    throw new AppError(400, `Concurrency must be a whole number from 1 to ${MAX_CONCURRENCY}`);
  }
  const plan = await planGroup(input.assetIds);
  if (plan.existingGroup) {
    throw new AppError(409, `A group upgrade is already ${plan.existingGroup.status === "running" ? "running" : `scheduled for ${plan.existingGroup.scheduledFor.toISOString()}`} on ${plan.gate.name} — only one group per FortiGate at a time; cancel it first`);
  }
  if (plan.otherGroups.length > 0) {
    throw new AppError(409, `${plan.otherGroups.map((o) => o.name).join(", ")} ${plan.otherGroups.length === 1 ? "is" : "are"} already in another group upgrade`);
  }
  if (plan.included.length === 0) {
    throw new AppError(409, "Nothing to upgrade: every selected device was dropped (already current, no Repository image, or not upgradable)");
  }
  if (plan.individualBookings.length > 0 && !input.cancelIndividual) {
    throw new AppError(409, `${plan.individualBookings.length} selected device${plan.individualBookings.length === 1 ? " has" : "s have"} a single-device upgrade scheduled (${plan.individualBookings.map((b) => b.name).join(", ")}); booking the group cancels ${plan.individualBookings.length === 1 ? "it" : "them"} — confirm to continue`);
  }

  const cancelledAt = new Date();
  let groupId: string;
  try {
    groupId = await prisma.$transaction(async (tx) => {
      for (const b of plan.individualBookings) {
        const res = await tx.firmwareUpgradeSchedule.updateMany({
          where: { id: b.scheduleId, status: "pending" },
          data: { status: "cancelled", cancelledBy: input.actor, cancelledAt, error: "Superseded by a group firmware upgrade" },
        });
        if (res.count === 0) throw new AppError(409, `The single-device upgrade on ${b.name} started or changed while you were booking — review the group again`);
      }
      const g = await tx.firmwareGroupSchedule.create({
        data: {
          gateAssetId: plan.gate.assetId,
          integrationId: plan.gate.integrationId,
          scheduledFor: input.scheduledFor,
          concurrency: input.concurrency,
          notifyEmails: recipients,
          createdBy: input.actor,
          members: {
            create: [
              ...plan.included.map((m) => ({
                assetId: m.assetId, imageId: m.imageId, fromVersion: m.fromVersion, toVersion: m.toVersion,
                depth: m.depth, ancestorIds: m.ancestorIds, mclagPeerIds: m.mclagPeerIds, state: "planned",
              })),
              ...plan.dropped.map((m) => ({
                assetId: m.assetId, fromVersion: m.fromVersion, depth: m.depth, ancestorIds: [], mclagPeerIds: [],
                state: "dropped", detail: m.reason,
              })),
            ],
          },
        },
        select: { id: true },
      });
      return g.id;
    });
  } catch (err: any) {
    if (err?.code === "P2002") throw new AppError(409, `A group upgrade was just booked on ${plan.gate.name} — only one group per FortiGate at a time`);
    throw err;
  }

  for (const b of plan.individualBookings) {
    await logEvent({
      action: "firmware.upgrade_schedule_cancelled",
      resourceType: "asset",
      resourceId: b.assetId,
      resourceName: b.name,
      actor: input.actor,
      level: "info",
      message: `Scheduled firmware upgrade to ${b.toVersion} (${b.scheduledFor.toISOString()}) cancelled: superseded by a group firmware upgrade on ${plan.gate.name}`,
      details: { scheduleId: b.scheduleId, supersededByGroupId: groupId },
    });
  }
  await logEvent({
    action: "firmware.group_upgrade_scheduled",
    resourceType: "asset",
    resourceId: plan.gate.assetId,
    resourceName: plan.gate.name,
    actor: input.actor,
    level: "info",
    message: `Group firmware upgrade scheduled for ${input.scheduledFor.toISOString()} on ${plan.gate.name}: ${plan.included.length} device${plan.included.length === 1 ? "" : "s"} to upgrade${plan.dropped.length ? `, ${plan.dropped.length} dropped` : ""}${plan.individualBookings.length ? `, ${plan.individualBookings.length} single-device booking${plan.individualBookings.length === 1 ? "" : "s"} superseded` : ""}; concurrency ${input.concurrency}; results to ${recipients.join(", ")}`,
    details: {
      groupId,
      scheduledFor: input.scheduledFor.toISOString(),
      concurrency: input.concurrency,
      notifyEmails: recipients,
      included: plan.included.map((m) => ({ assetId: m.assetId, toVersion: m.toVersion, depth: m.depth })),
      dropped: plan.dropped.map((m) => ({ assetId: m.assetId, kind: m.kind })),
      supersededSchedules: plan.individualBookings.map((b) => b.scheduleId),
    },
  });
  return { group: await getGroupSchedule(groupId), plan };
}

/**
 * Rule 112: the logins a booked group's flashes will sign in with, recorded
 * at booking by the person who booked it — the route calls this, as the
 * single-device booking route does.
 */
export async function recordGroupCredentialUse(assetIds: readonly string[], actor: CredentialUseActor): Promise<void> {
  for (let i = 0; i < assetIds.length; i += ASSESS_CHUNK) {
    await Promise.all(assetIds.slice(i, i + ASSESS_CHUNK).map((id) => recordFirmwareCredentialUse(id, actor)));
  }
}

export async function cancelGroupSchedule(groupId: string, actor: string): Promise<GroupDetail> {
  const g = await prisma.firmwareGroupSchedule.findUnique({ where: { id: groupId }, select: { id: true, status: true, gateAssetId: true, scheduledFor: true } });
  if (!g) throw new AppError(404, "Group upgrade not found");
  if (g.status !== "pending" && g.status !== "running") throw new AppError(409, `This group upgrade is already ${g.status}`);
  const now = new Date();
  const res = await prisma.firmwareGroupSchedule.updateMany({
    where: { id: g.id, status: g.status },
    data: { status: "cancelled", cancelledBy: actor, cancelledAt: now, ...(g.status === "pending" ? { finishedAt: now } : {}) },
  });
  if (res.count === 0) throw new AppError(409, "This group upgrade changed while you were cancelling it — refresh and try again");
  const why = g.status === "running" ? `stopped by ${actor}` : `the group was cancelled by ${actor} before it started`;
  await prisma.firmwareGroupMember.updateMany({
    where: { groupId: g.id, state: { in: ["planned", "waiting"] } },
    data: { state: "skipped", skipKind: "cancelled", detail: why, finishedAt: now },
  });
  const gate = await prisma.asset.findUnique({ where: { id: g.gateAssetId }, select: { id: true, hostname: true, ipAddress: true } });
  await logEvent({
    action: "firmware.group_upgrade_cancelled",
    resourceType: "asset",
    resourceId: g.gateAssetId,
    resourceName: gate ? nameOf(gate) : undefined,
    actor,
    level: "info",
    message: g.status === "running"
      ? "Running group firmware upgrade stopped: flashes already under way finish; nothing else is started"
      : `Group firmware upgrade scheduled for ${g.scheduledFor.toISOString()} cancelled`,
    details: { groupId: g.id, wasRunning: g.status === "running" },
  });
  // A group that had started reports what it did; with nothing still flashing
  // the summary goes now, otherwise when the last run ends.
  if (g.status === "running") await advanceGroup(g.id);
  return getGroupSchedule(g.id);
}

// ─── Execution ───────────────────────────────────────────────────────────────

/** The executor's view of one member. Exported for the pure-function tests. */
export interface ExecMember {
  id: string;
  assetId: string;
  name: string;
  depth: number;
  ancestorIds: string[];
  mclagPeerIds: string[];
  state: GroupMemberState;
  skipKind: string | null;
}

/**
 * A finished member that holds its ancestors back. Everything else finished —
 * upgraded, already-current, dropped, skipped for HEALTH — lets them go.
 */
function endedBad(m: ExecMember): boolean {
  return m.state === "failed" || m.state === "unverified" || (m.state === "skipped" && m.skipKind !== "health");
}

function descendantsOf(m: ExecMember, members: readonly ExecMember[]): ExecMember[] {
  return members.filter((x) => x.id !== m.id && x.ancestorIds.includes(m.assetId));
}

/**
 * For a member that has not started: the descendant that ended badly and so
 * skips it (rule 122's subtree rule), "wait" while something behind it is
 * still to run, or null when everything behind it ended clean. Pure.
 */
export function subtreeState(m: ExecMember, members: readonly ExecMember[]): { bad: ExecMember } | "wait" | null {
  const below = descendantsOf(m, members);
  // The nearest failure names the cause best: deepest-first order is upgrade
  // order, so the first bad one in ascending depth is the one just below.
  const bad = below.filter(endedBad).sort((a, b) => a.depth - b.depth)[0];
  if (bad) return { bad };
  if (below.some((x) => !TERMINAL_MEMBER_STATES.has(x.state))) return "wait";
  return null;
}

/** True when `a` and `b` must never flash at the same time. Pure. */
export function conflicts(a: ExecMember, b: ExecMember): boolean {
  return a.ancestorIds.includes(b.assetId) || b.ancestorIds.includes(a.assetId)
    || a.mclagPeerIds.includes(b.assetId) || b.mclagPeerIds.includes(a.assetId);
}

/**
 * The next member to try: planned or waiting, not already tried this pass,
 * everything behind it ended clean, and no running member above, below or
 * paired with it. Deepest first, then name. Pure.
 */
export function pickNext(members: readonly ExecMember[], tried: ReadonlySet<string>): ExecMember | null {
  const running = members.filter((m) => m.state === "running");
  const candidates = members
    .filter((m) => (m.state === "planned" || m.state === "waiting") && !tried.has(m.id))
    .filter((m) => subtreeState(m, members) === null)
    .filter((m) => !running.some((r) => conflicts(m, r)))
    .sort(orderKey);
  return candidates[0] ?? null;
}

const advancing = new Set<string>();
const advanceAgain = new Set<string>();

/** After a member's run ends (the runner's hook): advance its group now rather than at the next tick. */
export async function advanceGroupForRun(runId: string): Promise<void> {
  const m = await prisma.firmwareGroupMember.findUnique({ where: { runId }, select: { groupId: true } });
  if (m) await advanceGroup(m.groupId);
}

/**
 * One pass over a group: record finished runs, skip parents whose subtree did
 * not end clean, start what may start, and finish the group when nothing is
 * left. Never two passes on one group at once — a call that arrives during a
 * pass runs another pass straight after it.
 */
export async function advanceGroup(groupId: string, now: Date = new Date()): Promise<void> {
  if (advancing.has(groupId)) { advanceAgain.add(groupId); return; }
  advancing.add(groupId);
  try {
    do {
      advanceAgain.delete(groupId);
      await advanceOnce(groupId, now);
    } while (advanceAgain.has(groupId));
  } finally {
    advancing.delete(groupId);
  }
}

type LoadedMember = ExecMember & {
  imageId: string | null;
  toVersion: string | null;
  runId: string | null;
  eligibleAt: Date | null;
  run: { status: string; result: string | null; error: string | null; stage: string | null } | null;
};

async function loadMembers(groupId: string): Promise<LoadedMember[]> {
  const rows = await prisma.firmwareGroupMember.findMany({
    where: { groupId },
    select: {
      id: true, assetId: true, depth: true, ancestorIds: true, mclagPeerIds: true, state: true, skipKind: true,
      imageId: true, toVersion: true, runId: true, eligibleAt: true,
      asset: { select: { id: true, hostname: true, ipAddress: true } },
      run: { select: { status: true, result: true, error: true, stage: true } },
    },
  });
  return rows.map((r) => ({
    id: r.id, assetId: r.assetId, name: nameOf(r.asset), depth: r.depth, ancestorIds: r.ancestorIds, mclagPeerIds: r.mclagPeerIds,
    state: r.state as GroupMemberState, skipKind: r.skipKind, imageId: r.imageId, toVersion: r.toVersion, runId: r.runId,
    eligibleAt: r.eligibleAt, run: r.run,
  }));
}

async function setMember(m: LoadedMember, data: { state: GroupMemberState; skipKind?: string | null; detail?: string | null; eligibleAt?: Date | null; finished?: boolean }, now: Date): Promise<void> {
  m.state = data.state;
  m.skipKind = data.state === "skipped" ? (data.skipKind ?? "cancelled") : null;
  if (data.eligibleAt !== undefined) m.eligibleAt = data.eligibleAt;
  await prisma.firmwareGroupMember.update({
    where: { id: m.id },
    data: {
      state: data.state,
      skipKind: m.skipKind,
      ...(data.detail !== undefined ? { detail: data.detail } : {}),
      ...(data.eligibleAt !== undefined ? { eligibleAt: data.eligibleAt } : {}),
      ...(data.finished ? { finishedAt: now } : {}),
    },
  });
}

async function memberSkippedEvent(groupId: string, m: LoadedMember, why: string): Promise<void> {
  await logEvent({
    action: "firmware.group_member_skipped",
    resourceType: "asset",
    resourceId: m.assetId,
    resourceName: m.name,
    actor: "system:firmware",
    level: "warning",
    message: `Group firmware upgrade skipped this device: ${why}`,
    details: { groupId, memberId: m.id, skipKind: m.skipKind },
  });
}

async function advanceOnce(groupId: string, now: Date): Promise<void> {
  const group = await prisma.firmwareGroupSchedule.findUnique({
    where: { id: groupId },
    select: { id: true, status: true, concurrency: true, createdBy: true, firedAt: true, notifiedAt: true, gateAssetId: true },
  });
  if (!group) return;
  const members = await loadMembers(groupId);

  // 1. Record runs that ended.
  for (const m of members) {
    if (m.state !== "running" || !m.run) continue;
    if (m.run.status === "queued" || m.run.status === "running") continue;
    const state: GroupMemberState = m.run.status === "succeeded"
      ? (m.run.result === "already-current" ? "already-current" : "upgraded")
      : m.run.status === "unverified" ? "unverified" : "failed";
    await setMember(m, { state, detail: state === "failed" || state === "unverified" ? (m.run.error ?? null) : null, finished: true }, now);
  }

  if (group.status === "running") {
    const tried = new Set<string>();
    for (let guard = 0; guard < members.length * 3 + 5; guard++) {
      // 2. Parents whose subtree ended badly are skipped — nothing is sent.
      let changed = true;
      while (changed) {
        changed = false;
        for (const m of members) {
          if (m.state !== "planned" && m.state !== "waiting") continue;
          const st = subtreeState(m, members);
          if (st && st !== "wait") {
            const why = `${st.bad.name}, behind it, ${st.bad.state === "skipped" ? `was skipped (${st.bad.skipKind})` : st.bad.state}`;
            await setMember(m, { state: "skipped", skipKind: "subtree", detail: why, finished: true }, now);
            await memberSkippedEvent(groupId, m, why);
            changed = true;
          }
        }
      }
      // 3. Start what may start, up to the concurrency.
      if (members.filter((m) => m.state === "running").length >= group.concurrency) break;
      const next = pickNext(members, tried) as LoadedMember | null;
      if (!next) break;
      tried.add(next.id);
      await tryStart(group, next, now);
    }
  }

  // 4. Finish.
  const unfinished = members.some((m) => !TERMINAL_MEMBER_STATES.has(m.state));
  if (group.status === "running" && !unfinished) {
    const done = await prisma.firmwareGroupSchedule.updateMany({ where: { id: groupId, status: "running" }, data: { status: "completed", finishedAt: now } });
    if (done.count > 0) {
      const counts = tally(members);
      const gate = await prisma.asset.findUnique({ where: { id: group.gateAssetId }, select: { id: true, hostname: true, ipAddress: true } });
      await logEvent({
        action: "firmware.group_upgrade_completed",
        resourceType: "asset",
        resourceId: group.gateAssetId,
        resourceName: gate ? nameOf(gate) : undefined,
        actor: "system:firmware",
        level: counts.failed + counts.unverified > 0 ? "warning" : "info",
        message: `Group firmware upgrade finished: ${Object.entries(counts).filter(([, v]) => v > 0).map(([k, v]) => `${v} ${k}`).join(", ")}`,
        details: { groupId, counts, members: members.map((m) => ({ assetId: m.assetId, name: m.name, state: m.state, skipKind: m.skipKind })) },
      });
      await sendGroupResults(groupId, "completed");
    }
  } else if (group.status === "cancelled" && group.firedAt && !group.notifiedAt && !members.some((m) => m.state === "running")) {
    await prisma.firmwareGroupSchedule.updateMany({ where: { id: groupId, finishedAt: null }, data: { finishedAt: now } });
    await sendGroupResults(groupId, "cancelled");
  }
}

function tally(members: readonly ExecMember[]): Record<string, number> {
  const t: Record<string, number> = { upgraded: 0, "already current": 0, failed: 0, unverified: 0, "skipped (health)": 0, "skipped (upstream)": 0, "not started": 0, dropped: 0 };
  for (const m of members) {
    if (m.state === "upgraded") t.upgraded++;
    else if (m.state === "already-current") t["already current"]++;
    else if (m.state === "failed") t.failed++;
    else if (m.state === "unverified") t.unverified++;
    else if (m.state === "dropped") t.dropped++;
    else if (m.state === "skipped") {
      if (m.skipKind === "health") t["skipped (health)"]++;
      else if (m.skipKind === "subtree") t["skipped (upstream)"]++;
      else t["not started"]++;
    }
  }
  return t;
}

async function tryStart(group: { id: string; createdBy: string }, m: LoadedMember, now: Date): Promise<void> {
  const a = await prisma.asset.findUnique({ where: { id: m.assetId }, select: FIRMWARE_ASSET_SELECT }) as FirmwareAssetRow | null;
  if (!a) { await setMember(m, { state: "dropped", detail: "the asset was deleted", finished: true }, now); return; }

  // Health first, live (fortinet-updater's excludeHealth): skip and move on.
  const blockers = healthBlockers(a);
  if (blockers.length > 0) {
    const why = blockers.join("; ");
    await setMember(m, { state: "skipped", skipKind: "health", detail: why, finished: true }, now);
    await memberSkippedEvent(group.id, m, why);
    return;
  }

  // The image gates again: a device upgraded since booking is already current;
  // a Repository change since booking drops it (the image was approved by name).
  const assess = await assessGroupCandidate(a);
  if (!assess.ok) {
    if (assess.kind === "current") {
      await setMember(m, { state: "already-current", detail: `already runs ${a.osVersion ?? "the target version"}`, finished: true }, now);
    } else {
      await setMember(m, { state: "dropped", detail: assess.reason, finished: true }, now);
    }
    return;
  }
  if (!m.imageId || assess.image.id !== m.imageId) {
    await setMember(m, {
      state: "dropped",
      detail: m.imageId
        ? `the model's primary image changed to ${assess.image.versionLabel} after the group was booked (approved: ${m.toVersion ?? "?"}) — book it again to push the new one`
        : `the approved image (${m.toVersion ?? "?"}) was deleted from the Repository`,
      finished: true,
    }, now);
    return;
  }

  try {
    await startFirmwareUpgrade({ assetId: m.assetId, imageId: m.imageId, actor: group.createdBy, groupMemberId: m.id });
    m.state = "running";
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (err instanceof FirmwareRunConflictError) {
      const since = m.eligibleAt ?? now;
      if (now.getTime() - since.getTime() > CONFLICT_WAIT_MS) {
        const why = `${msg} — still waiting ${Math.round(CONFLICT_WAIT_MS / 60_000)} min later, so it was not started`;
        await setMember(m, { state: "skipped", skipKind: "timeout", detail: why, finished: true }, now);
        await memberSkippedEvent(group.id, m, why);
      } else {
        await setMember(m, { state: "waiting", detail: msg, eligibleAt: since }, now);
      }
      return;
    }
    if (err instanceof AppError && err.httpStatus === 409 && msg.startsWith("Cannot start:")) {
      // The health gate inside startFirmwareUpgrade, seen in a race with ours.
      const why = msg.replace(/^Cannot start:\s*/, "");
      await setMember(m, { state: "skipped", skipKind: "health", detail: why, finished: true }, now);
      await memberSkippedEvent(group.id, m, why);
      return;
    }
    await setMember(m, { state: "failed", detail: msg, finished: true }, now);
  }
}

export interface DueGroupResult {
  started: number;
  missed: number;
  advanced: number;
}

/**
 * The job's tick: start due groups (or record them missed), then advance
 * every running group and every stopped one still waiting on a flash.
 */
export async function runDueGroupSchedules(now: Date = new Date()): Promise<DueGroupResult> {
  const out: DueGroupResult = { started: 0, missed: 0, advanced: 0 };
  const due = await prisma.firmwareGroupSchedule.findMany({
    where: { status: "pending", scheduledFor: { lte: now } },
    orderBy: { scheduledFor: "asc" },
    select: { id: true, scheduledFor: true, gateAssetId: true },
  });
  for (const g of due) {
    const lateMs = now.getTime() - g.scheduledFor.getTime();
    const gate = await prisma.asset.findUnique({ where: { id: g.gateAssetId }, select: { id: true, hostname: true, ipAddress: true } });
    if (lateMs > LATE_GRACE_MS) {
      const why = `Polaris was not running at the scheduled time and first saw this group ${Math.round(lateMs / 60_000)} min late; nothing was started`;
      const res = await prisma.firmwareGroupSchedule.updateMany({ where: { id: g.id, status: "pending" }, data: { status: "missed", error: why, firedAt: now, finishedAt: now } });
      if (res.count === 0) continue;
      await prisma.firmwareGroupMember.updateMany({ where: { groupId: g.id, state: { in: ["planned", "waiting"] } }, data: { state: "skipped", skipKind: "cancelled", detail: "the group was missed", finishedAt: now } });
      await logEvent({
        action: "firmware.group_upgrade_missed",
        resourceType: "asset",
        resourceId: g.gateAssetId,
        resourceName: gate ? nameOf(gate) : undefined,
        actor: "system:firmware",
        level: "warning",
        message: `Group firmware upgrade was not started: ${why}`,
        details: { groupId: g.id, scheduledFor: g.scheduledFor.toISOString() },
      });
      await sendGroupResults(g.id, "missed");
      out.missed++;
      continue;
    }
    const claimed = await prisma.firmwareGroupSchedule.updateMany({ where: { id: g.id, status: "pending" }, data: { status: "running", firedAt: now } });
    if (claimed.count === 0) continue;
    await logEvent({
      action: "firmware.group_upgrade_started",
      resourceType: "asset",
      resourceId: g.gateAssetId,
      resourceName: gate ? nameOf(gate) : undefined,
      actor: "system:firmware",
      level: "info",
      message: "Group firmware upgrade started",
      details: { groupId: g.id, scheduledFor: g.scheduledFor.toISOString() },
    });
    out.started++;
  }

  const active = await prisma.firmwareGroupSchedule.findMany({
    where: {
      OR: [
        { status: "running" },
        { status: "cancelled", firedAt: { not: null }, notifiedAt: null },
      ],
    },
    select: { id: true },
  });
  for (const g of active) {
    try {
      await advanceGroup(g.id, now);
      out.advanced++;
    } catch (err) {
      logger.warn({ err, groupId: g.id }, "group firmware upgrade: a pass failed (retried next tick)");
    }
  }
  return out;
}

// ─── Reads ───────────────────────────────────────────────────────────────────

export interface GroupMemberDetail {
  id: string;
  assetId: string;
  name: string;
  assetType: string;
  model: string | null;
  depth: number;
  state: GroupMemberState;
  skipKind: string | null;
  detail: string | null;
  fromVersion: string | null;
  toVersion: string | null;
  runId: string | null;
  run: { status: string; stage: string | null; progress: unknown; verifiedVersion: string | null; error: string | null } | null;
  startedAt: Date | null;
  finishedAt: Date | null;
}

export interface GroupDetail {
  id: string;
  gateAssetId: string;
  gateName: string;
  scheduledFor: Date;
  concurrency: number;
  notifyEmails: string[];
  status: string;
  error: string | null;
  createdBy: string;
  createdAt: Date;
  cancelledBy: string | null;
  cancelledAt: Date | null;
  firedAt: Date | null;
  finishedAt: Date | null;
  notifiedAt: Date | null;
  notifyError: string | null;
  /** Upgrade order (deepest first); dropped members last. */
  members: GroupMemberDetail[];
}

export async function getGroupSchedule(groupId: string): Promise<GroupDetail> {
  const g = await prisma.firmwareGroupSchedule.findUnique({
    where: { id: groupId },
    include: {
      gate: { select: { id: true, hostname: true, ipAddress: true } },
      members: {
        include: {
          asset: { select: { id: true, hostname: true, ipAddress: true, assetType: true, model: true } },
          run: { select: { status: true, stage: true, progress: true, verifiedVersion: true, error: true } },
        },
      },
    },
  });
  if (!g) throw new AppError(404, "Group upgrade not found");
  const members: GroupMemberDetail[] = g.members.map((m) => ({
    id: m.id, assetId: m.assetId, name: nameOf(m.asset), assetType: m.asset.assetType, model: m.asset.model, depth: m.depth,
    state: m.state as GroupMemberState, skipKind: m.skipKind, detail: m.detail, fromVersion: m.fromVersion, toVersion: m.toVersion,
    runId: m.runId, run: m.run, startedAt: m.startedAt, finishedAt: m.finishedAt,
  }));
  members.sort((a, b) => (a.state === "dropped" ? 1 : 0) - (b.state === "dropped" ? 1 : 0) || orderKey(a, b));
  return {
    id: g.id, gateAssetId: g.gateAssetId, gateName: nameOf(g.gate), scheduledFor: g.scheduledFor, concurrency: g.concurrency,
    notifyEmails: g.notifyEmails, status: g.status, error: g.error, createdBy: g.createdBy, createdAt: g.createdAt,
    cancelledBy: g.cancelledBy, cancelledAt: g.cancelledAt, firedAt: g.firedAt, finishedAt: g.finishedAt,
    notifiedAt: g.notifiedAt, notifyError: g.notifyError, members,
  };
}

export interface GroupListRow {
  id: string;
  gateAssetId: string;
  gateName: string;
  scheduledFor: Date;
  status: string;
  concurrency: number;
  createdBy: string;
  memberCount: number;
}

export async function listGroupSchedules(opts: { gateAssetId?: string; status?: string; limit?: number } = {}): Promise<GroupListRow[]> {
  const rows = await prisma.firmwareGroupSchedule.findMany({
    where: { ...(opts.gateAssetId ? { gateAssetId: opts.gateAssetId } : {}), ...(opts.status ? { status: opts.status } : {}) },
    orderBy: { scheduledFor: "desc" },
    take: Math.min(Math.max(opts.limit ?? 50, 1), 200),
    select: {
      id: true, gateAssetId: true, scheduledFor: true, status: true, concurrency: true, createdBy: true,
      gate: { select: { id: true, hostname: true, ipAddress: true } },
      _count: { select: { members: { where: { state: { not: "dropped" } } } } },
    },
  });
  return rows.map((r) => ({
    id: r.id, gateAssetId: r.gateAssetId, gateName: nameOf(r.gate), scheduledFor: r.scheduledFor, status: r.status,
    concurrency: r.concurrency, createdBy: r.createdBy, memberCount: r._count.members,
  }));
}

/** The asset card's note: the pending / running group this device is in, if any. */
export async function activeGroupForAsset(assetId: string): Promise<{ id: string; gateAssetId: string; gateName: string; scheduledFor: Date; status: string; memberState: string } | null> {
  const m = await prisma.firmwareGroupMember.findFirst({
    where: { assetId, state: { not: "dropped" }, group: { status: { in: [...ACTIVE_GROUP_STATUSES] } } },
    select: { state: true, group: { select: { id: true, gateAssetId: true, scheduledFor: true, status: true, gate: { select: { id: true, hostname: true, ipAddress: true } } } } },
  });
  if (!m) return null;
  return { id: m.group.id, gateAssetId: m.group.gateAssetId, gateName: nameOf(m.group.gate), scheduledFor: m.group.scheduledFor, status: m.group.status, memberState: m.state };
}

// ─── The summary email ───────────────────────────────────────────────────────

async function sendGroupResults(groupId: string, outcome: GroupOutcome): Promise<void> {
  const claimed = await prisma.firmwareGroupSchedule.updateMany({ where: { id: groupId, notifiedAt: null }, data: { notifiedAt: new Date() } });
  if (claimed.count === 0) return;
  const g = await getGroupSchedule(groupId);
  const members: GroupEmailMember[] = g.members.map((m) => ({
    assetId: m.assetId, deviceName: m.name, assetType: m.assetType, model: m.model, state: m.state, skipKind: m.skipKind,
    detail: m.detail ?? m.run?.error ?? null, stage: m.state === "failed" || m.state === "unverified" ? (m.run?.stage ?? null) : null,
    fromVersion: m.fromVersion, toVersion: m.toVersion, verifiedVersion: m.run?.verifiedVersion ?? null,
  }));

  const channel = await resolveSummaryChannel(null, []);
  if (!channel) {
    await recordNotifyError(g, "no enabled email channel (SMTP or Microsoft 365) is configured");
    return;
  }
  const users = await prisma.user.findMany({
    where: { email: { in: g.notifyEmails, mode: "insensitive" } },
    select: { email: true, timezone: true, detectedTimezone: true },
  });
  const zoneOf = new Map<string, string>();
  for (const u of users) if (u.email) zoneOf.set(u.email.toLowerCase(), resolveTimeZone(u.timezone, u.detectedTimezone));

  const failures: string[] = [];
  for (const address of g.notifyEmails) {
    try {
      const rendered = renderFirmwareGroupResultEmail({
        outcome,
        gateAssetId: g.gateAssetId,
        gateName: g.gateName,
        scheduledFor: g.scheduledFor,
        startedAt: g.firedAt,
        finishedAt: g.finishedAt,
        scheduledBy: g.createdBy,
        cancelledBy: g.cancelledBy,
        members,
        zone: zoneOf.get(address) ?? serverTimeZone(),
      });
      const msg = await applyBrandLetterhead({ to: [address], subject: rendered.subject, text: rendered.text, html: rendered.html });
      await sendEmailThroughChannel({ type: channel.type, config: channel.config as Record<string, unknown> }, msg);
    } catch (err) {
      failures.push(`${address}: ${String((err as Error)?.message ?? err).slice(0, 200)}`);
    }
  }
  if (failures.length > 0) await recordNotifyError(g, failures.join("; "));
  else logger.info({ groupId, recipients: g.notifyEmails.length, outcome }, "group firmware upgrade summary emailed");
}

async function recordNotifyError(g: GroupDetail, error: string): Promise<void> {
  await prisma.firmwareGroupSchedule.update({ where: { id: g.id }, data: { notifyError: error.slice(0, 2000) } }).catch(() => undefined);
  await logEvent({
    action: "firmware.group_upgrade_email_failed",
    resourceType: "asset",
    resourceId: g.gateAssetId,
    resourceName: g.gateName,
    actor: "system:firmware",
    level: "warning",
    message: `The group firmware upgrade summary email could not be sent: ${error}`,
    details: { groupId: g.id, notifyEmails: g.notifyEmails, error },
  });
}
