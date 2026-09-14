/**
 * src/services/eventLogService.ts — shared audit-event writer
 *
 * Extracted from src/api/routes/events.ts (2026-06 review): the event writer
 * is consumed by ~42 modules across services, jobs, and routes, and services
 * should not import from the route layer to write audit rows. events.ts
 * re-exports everything here for back-compat, so existing route-layer
 * imports keep working; new service-layer callers should import from here.
 *
 * logEvent never throws — event logging must never break the operation it
 * audits. Rows below the operator-configured minimum level are dropped
 * (cached read via eventArchiveService.getCachedRetentionSettings).
 */

import { prisma } from "../db.js";
import { getCachedRetentionSettings } from "./eventArchiveService.js";

const LEVEL_ORDER: Record<string, number> = { info: 0, warning: 1, error: 2 };

export interface LogEventInput {
  action: string;
  resourceType?: string;
  resourceId?: string;
  resourceName?: string;
  actor?: string;
  message: string;
  level?: "info" | "warning" | "error";
  details?: Record<string, unknown>;
}

export async function logEvent(input: LogEventInput): Promise<void> {
  try {
    const { minLevel } = await getCachedRetentionSettings();
    if ((LEVEL_ORDER[input.level ?? "info"] ?? 0) < (LEVEL_ORDER[minLevel] ?? 0)) return;
    const level = input.level || "info";
    await prisma.event.create({
      data: {
        action: input.action,
        resourceType: input.resourceType,
        resourceId: input.resourceId,
        resourceName: input.resourceName,
        actor: input.actor,
        message: input.message,
        level,
        // Numeric severity stamped at write time. The list endpoint's
        // sortBy=level dispatches to orderBy: { levelRank } so the operator
        // sees severity order, not alphabetical. Falls back to 0 (info) for
        // any unknown level string.
        levelRank: LEVEL_ORDER[level] ?? 0,
        details: input.details as any,
      },
    });
  } catch {
    // Never let event logging break the main request
  }
}

/**
 * Batch variant of logEvent — writes many audit rows in ONE `createMany`
 * instead of N awaited `create`s. Applies the same min-level drop + `levelRank`
 * stamping as logEvent. Use for high-fan-in audit sources (e.g. agent/poller OS
 * event-log ingest) where a per-row await would be a scale anti-pattern. Never
 * throws — a write failure is swallowed like logEvent. Returns the number of
 * rows actually written (after the min-level filter).
 */
export async function logEventsBatch(inputs: LogEventInput[]): Promise<number> {
  if (inputs.length === 0) return 0;
  try {
    const { minLevel } = await getCachedRetentionSettings();
    const floor = LEVEL_ORDER[minLevel] ?? 0;
    const rows = inputs
      .filter((i) => (LEVEL_ORDER[i.level ?? "info"] ?? 0) >= floor)
      .map((i) => {
        const level = i.level || "info";
        return {
          action: i.action,
          resourceType: i.resourceType,
          resourceId: i.resourceId,
          resourceName: i.resourceName,
          actor: i.actor,
          message: i.message,
          level,
          levelRank: LEVEL_ORDER[level] ?? 0,
          details: i.details as any,
        };
      });
    if (rows.length === 0) return 0;
    await prisma.event.createMany({ data: rows });
    return rows.length;
  } catch {
    return 0;
  }
}

/**
 * One page of the Events list (GET /events) — the route builds the validated
 * where/orderBy (sort whitelist + operator-aware text filters live route-side
 * with their Zod schema); this runs the paged read + total count together.
 */
export async function queryEventsPage(q: {
  where: Record<string, unknown>;
  orderBy: Record<string, "asc" | "desc">;
  skip: number;
  take: number;
}): Promise<{ events: unknown[]; total: number }> {
  const [events, total] = await Promise.all([
    prisma.event.findMany({
      where: q.where,
      orderBy: q.orderBy,
      skip: q.skip,
      take: q.take,
    }),
    prisma.event.count({ where: q.where }),
  ]);
  return { events, total };
}

/**
 * Distinct resourceType values inside the retention window — feeds the Events
 * page Resource-column multi-select. Low cardinality, so groupBy is cheap.
 */
export async function listEventResourceTypes(cutoff: Date): Promise<string[]> {
  const grouped = await prisma.event.groupBy({
    by: ["resourceType"],
    where: { timestamp: { gte: cutoff }, resourceType: { not: null } },
  });
  return grouped
    .map((g) => g.resourceType)
    .filter((v): v is string => !!v)
    .sort();
}

export function buildChanges(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): Record<string, { from: unknown; to: unknown }> | undefined {
  const changes: Record<string, { from: unknown; to: unknown }> = {};
  for (const key of Object.keys(after)) {
    const a = before[key];
    const b = after[key];
    const aStr = JSON.stringify(a ?? null);
    const bStr = JSON.stringify(b ?? null);
    if (aStr !== bStr) changes[key] = { from: a ?? null, to: b ?? null };
  }
  return Object.keys(changes).length ? changes : undefined;
}

// ─── Discovery per-asset audit events ────────────────────────────────────────
//
// Discovery historically logged only run-level `integration.discover.*` events
// (resourceType=integration). The asset details slide-over's Events tab filters
// strictly on resourceType=asset + resourceId, so a specific asset's discovery
// history was invisible there. These helpers emit per-asset events from the
// discovery sync paths (FMG/FortiGate firewall/switch/AP, Entra/Intune, AD) so
// "what did discovery do to THIS asset" shows up alongside monitor-status
// changes and manual edits.
//
// MATERIAL fields only. A discovery cycle bumps lastSeen / *FetchedAt / monitor
// stamp / topology / discoveredByIntegrationId on essentially every asset every
// pass — diffing those would write an event per asset per cycle and flood the
// 7-day Event table at 2000 assets. The whitelist below is the identity /
// classification / location surface an operator actually wants an audit trail
// for; an unchanged pass produces NO event. See CLAUDE.md scale-check rule.
//
// lastSeenSwitch / lastSeenAp stay OUT of this whitelist on purpose: Phase 7
// of discovery writes them set-always (same value restated every cycle), and
// Phase 7 vs Phase 7.5 stage differently-formatted strings for the same port,
// so a generic staged-vs-before diff here could not be trusted to stay quiet.
// Their dedicated change events (asset.switch_port.changed /
// asset.wireless_ap.changed — see the builders at the bottom of this file)
// are emitted edge-triggered by the write sites themselves; discovery nets
// its intra-run ping-pong through the end-of-run change-baseline flush in
// syncDhcpSubnets.
const MATERIAL_ASSET_FIELDS = [
  "hostname",
  "ipAddress",
  "macAddress",
  "serialNumber",
  "manufacturer",
  "model",
  "os",
  "osVersion",
  "assetType",
  "status",
  "learnedLocation",
  "learnedAddress",
  // Written by discovery only through the device-description → notes sync
  // (buildDescriptionSyncStamp in integrations.ts) — i.e. only when the
  // device-side description actually changed, so this can't flood the
  // Event table on unchanged passes.
  "notes",
] as const;

export interface DiscoveryAuditContext {
  integrationName: string;
  integrationId?: string;
  // AssetSource kind that drove the write — "fortigate-firewall" | "fortiswitch"
  // | "fortiap" | "entra" | "ad". Surfaced in the event message + details.
  sourceKind?: string;
  // Discovery actor (username for an operator-triggered run, undefined for the
  // scheduler). Defaults to "system:discovery" when absent so the row isn't
  // attributed to a person.
  actor?: string;
}

// Snapshot the material fields from an in-memory asset row BEFORE the discovery
// branch mutates it in place (several paths set existingAsset.assetType /
// .macAddresses / .status before the prisma.asset.update). Pass the result as
// `before` to logDiscoveryAssetUpdated after the write succeeds.
export function snapshotMaterialAssetFields(asset: Record<string, unknown>): Record<string, unknown> {
  const snap: Record<string, unknown> = {};
  for (const f of MATERIAL_ASSET_FIELDS) snap[f] = (asset as any)[f] ?? null;
  return snap;
}

export function logDiscoveryAssetCreated(
  assetId: string,
  name: string | null | undefined,
  ctx: DiscoveryAuditContext,
): void {
  const label = name || assetId;
  const via = ctx.sourceKind ? ` (${ctx.sourceKind})` : "";
  void logEvent({
    action: "asset.discovered",
    resourceType: "asset",
    resourceId: assetId,
    resourceName: name || undefined,
    actor: ctx.actor || "system:discovery",
    message: `Asset "${label}" discovered by ${ctx.integrationName}${via}`,
    details: { integrationId: ctx.integrationId, integrationName: ctx.integrationName, sourceKind: ctx.sourceKind },
  });
}

// Pure diff over the material-field whitelist. `after` is the partial
// updateData object passed to prisma.asset.update — only keys present in it are
// considered (discovery writes a field only when it has an opinion), each
// compared against the pre-write `before` snapshot. Returns undefined when
// nothing material changed. Extracted as a pure function so the gating logic is
// unit-testable without touching Prisma.
export function computeMaterialAssetChanges(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): Record<string, { from: unknown; to: unknown }> | undefined {
  const changes: Record<string, { from: unknown; to: unknown }> = {};
  for (const f of MATERIAL_ASSET_FIELDS) {
    if (!(f in after)) continue; // discovery didn't touch this field this write
    const a = (before as any)[f] ?? null;
    const b = (after as any)[f] ?? null;
    if (JSON.stringify(a) !== JSON.stringify(b)) changes[f] = { from: a, to: b };
  }
  return Object.keys(changes).length ? changes : undefined;
}

// Emits `asset.discovery_updated` only when a MATERIAL field actually changed.
export function logDiscoveryAssetUpdated(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  assetId: string,
  name: string | null | undefined,
  ctx: DiscoveryAuditContext,
): void {
  const changes = computeMaterialAssetChanges(before, after);
  if (!changes) return; // nothing material changed → no event

  // Firmware gets its OWN event on top of the generic diff. This is the single
  // seam covering every snapshot-based discovery path (FortiGate / FortiSwitch
  // / FortiAP infra, Arc, Entra/Intune, AD, vCenter) — they all funnel through
  // here, so hooking it once beats patching nine call sites. The generic
  // asset.discovery_updated row still carries os/osVersion in its changes map;
  // this adds the findable, automatable action string.
  if ("os" in changes || "osVersion" in changes) {
    const firmwareEvent = buildFirmwareChangedEvent(
      {
        assetId,
        assetName: name,
        actor: ctx.actor,
        source: ctx.sourceKind,
        integrationId: ctx.integrationId,
        integrationName: ctx.integrationName,
      },
      before,
      after,
    );
    if (firmwareEvent) void logEvent(firmwareEvent);
  }

  const label = name || assetId;
  const via = ctx.sourceKind ? ` (${ctx.sourceKind})` : "";
  void logEvent({
    action: "asset.discovery_updated",
    resourceType: "asset",
    resourceId: assetId,
    resourceName: name || undefined,
    actor: ctx.actor || "system:discovery",
    // Status changes are the one material diff worth surfacing above info.
    level: "status" in changes ? "warning" : "info",
    message: `Asset "${label}" updated by ${ctx.integrationName} discovery${via}`,
    details: { changes, integrationId: ctx.integrationId, integrationName: ctx.integrationName, sourceKind: ctx.sourceKind },
  });
}

// ─── Per-asset change events: firmware + network attachment ──────────────────
//
// Four edge-triggered audit events an operator asked to be able to see on the
// asset's Events tab and alert on:
//
//   asset.firmware.changed          os / osVersion moved
//   asset.switch_port.changed       lastSeenSwitch moved
//   asset.wireless_ap.changed       lastSeenAp moved (every roam)
//   asset.gateway_firewall.changed  the freshest FortiGate sighting flipped
//
// Unlike the `change.*` family in notificationChangeEvents.ts these are written
// UNCONDITIONALLY — never behind isChangeActionSubscribed. They're rare (a
// steady fleet produces none) and the operator wants them in the audit log
// whether or not an automation subscribes. They ARE listed in the automations
// change-trigger picker (notificationTypes.CHANGE_TYPES) so a rule can watch
// them; the picker entry just selects an always-present event.
//
// The builders below are PURE — they return a LogEventInput or undefined and
// touch no Prisma — so callers in discovery loops can accumulate them into one
// logEventsBatch, and the change-decision logic is unit-testable on its own.

export interface AssetChangeEventContext {
  assetId: string;
  // hostname || ipAddress — the Events tab's resourceName column.
  assetName?: string | null;
  // Defaults per event to "system:discovery"; pass an operator username for
  // operator-driven writes.
  actor?: string | null;
  // What drove the write: "fortigate-endpoint" | "fortiap" | "polaris-agent"
  // | "wireless-scrape" | "dhcp-sighting" | "operator" | "pdf-import".
  source?: string | null;
  integrationId?: string | null;
  integrationName?: string | null;
}

function changeDetails(
  ctx: AssetChangeEventContext,
  changes: Record<string, { from: unknown; to: unknown }>,
): Record<string, unknown> {
  return {
    changes,
    source: ctx.source ?? undefined,
    integrationId: ctx.integrationId ?? undefined,
    integrationName: ctx.integrationName ?? undefined,
  };
}

function displayValue(v: unknown): string {
  const s = typeof v === "string" ? v.trim() : v == null ? "" : String(v);
  return s === "" ? "(none)" : s;
}

/**
 * Pure firmware diff over os/osVersion. A field is considered only when the
 * caller staged it (present in `after`), matching computeMaterialAssetChanges.
 *
 * A null→value transition is deliberately NOT a firmware change: that's Polaris
 * learning what the device runs for the first time (a fresh discovery, a newly
 * installed agent, a source that just started reporting), which is already
 * covered by asset.discovered / asset.discovery_updated. Only a value→different
 * value move means the device was actually upgraded or downgraded.
 */
export function computeFirmwareChange(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): Record<string, { from: unknown; to: unknown }> | undefined {
  const changes: Record<string, { from: unknown; to: unknown }> = {};
  for (const f of ["osVersion", "os"] as const) {
    if (!(f in after)) continue;
    const a = (before as any)[f] ?? null;
    const b = (after as any)[f] ?? null;
    if (a === null) continue; // first learn, not an upgrade
    if (b === null) continue; // a source going quiet is not a downgrade
    if (JSON.stringify(a) !== JSON.stringify(b)) changes[f] = { from: a, to: b };
  }
  return Object.keys(changes).length ? changes : undefined;
}

export function buildFirmwareChangedEvent(
  ctx: AssetChangeEventContext,
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): LogEventInput | undefined {
  const changes = computeFirmwareChange(before, after);
  if (!changes) return undefined;
  const label = ctx.assetName || ctx.assetId;
  const parts: string[] = [];
  if (changes.osVersion) {
    parts.push(`firmware changed: ${displayValue(changes.osVersion.from)} → ${displayValue(changes.osVersion.to)}`);
  }
  if (changes.os) {
    // Reads as one sentence either way: "firmware changed: A → B; OS X → Y"
    // when both moved, "OS changed: X → Y" when only the family did.
    const lead = parts.length ? "OS" : "OS changed:";
    parts.push(`${lead} ${displayValue(changes.os.from)} → ${displayValue(changes.os.to)}`);
  }
  return {
    action: "asset.firmware.changed",
    resourceType: "asset",
    resourceId: ctx.assetId,
    resourceName: ctx.assetName || undefined,
    actor: ctx.actor || "system:discovery",
    level: "info",
    message: `Asset "${label}" ${parts.join("; ")}`,
    details: changeDetails(ctx, changes),
  };
}

/**
 * Switch-port / wireless-AP attachment change.
 *
 * Comparison is trim + case-insensitive: the same attachment is written by more
 * than one subsystem (discovery's device-inventory apName vs the wireless
 * scrape's AP hostname), and a pure case difference between them would
 * otherwise alternate an event every cycle.
 *
 * `to === null` returns undefined — the writers only ever stage a value they
 * observed, so a null means "nothing seen this pass", not "detached". A
 * `from === null` DOES emit: first observed attachment is exactly the
 * "where is this device plugged in" record an operator wants.
 */
export function buildConnectionChangedEvent(
  kind: "switch" | "ap",
  ctx: AssetChangeEventContext,
  from: string | null | undefined,
  to: string | null | undefined,
): LogEventInput | undefined {
  const next = typeof to === "string" ? to.trim() : "";
  if (!next) return undefined;
  const prev = typeof from === "string" ? from.trim() : "";
  if (prev.toLowerCase() === next.toLowerCase()) return undefined;

  const field = kind === "switch" ? "lastSeenSwitch" : "lastSeenAp";
  const changes = { [field]: { from: prev || null, to: next } };
  const label = ctx.assetName || ctx.assetId;
  const message =
    kind === "switch"
      ? `Asset "${label}" switch port changed: ${displayValue(prev)} → ${next}`
      : prev
        ? `Asset "${label}" roamed to AP "${next}" (was "${prev}")`
        : `Asset "${label}" connected to AP "${next}"`;
  return {
    action: kind === "switch" ? "asset.switch_port.changed" : "asset.wireless_ap.changed",
    resourceType: "asset",
    resourceId: ctx.assetId,
    resourceName: ctx.assetName || undefined,
    actor: ctx.actor || "system:discovery",
    level: "info",
    message,
    details: changeDetails(ctx, changes),
  };
}

/**
 * A MAC-less asset was given the MAC its address answers on.
 *
 * Written by the rule 45 IP-upstream sweep when the owning gate's ARP cache
 * resolved exactly one MAC for the asset's address. This is the one write in
 * that sweep that is not reversible in practice — a MAC makes the row eligible
 * for MAC-keyed dedupe and merge — so it is always audited, never folded into
 * the switch/AP change events, and names the address the answer came from so
 * an operator chasing a bad merge can see what the sweep believed.
 */
export function buildMacAdoptedEvent(
  ctx: AssetChangeEventContext,
  ip: string,
  mac: string,
): LogEventInput {
  const label = ctx.assetName || ctx.assetId;
  return {
    action: "asset.mac.adopted",
    resourceType: "asset",
    resourceId: ctx.assetId,
    resourceName: ctx.assetName || undefined,
    actor: ctx.actor || "system:upstream-chain",
    level: "info",
    message: `Asset "${label}" adopted MAC ${mac}, resolved from the owning FortiGate's ARP entry for ${ip}`,
    details: changeDetails(ctx, { macAddress: { from: null, to: mac } }),
  };
}

/**
 * The FortiGate an asset currently sits behind changed — i.e. the freshest
 * AssetFortigateSighting row now names a different gate. Callers decide WHEN
 * that's true (see computeFreshestGateChanges in assetSightingService); this
 * only shapes the row.
 */
export function buildFirewallChangedEvent(
  ctx: AssetChangeEventContext,
  from: string,
  to: string,
): LogEventInput | undefined {
  const prev = (from ?? "").trim();
  const next = (to ?? "").trim();
  if (!next || prev.toLowerCase() === next.toLowerCase()) return undefined;
  const label = ctx.assetName || ctx.assetId;
  return {
    action: "asset.gateway_firewall.changed",
    resourceType: "asset",
    resourceId: ctx.assetId,
    resourceName: ctx.assetName || undefined,
    actor: ctx.actor || "system:discovery",
    level: "info",
    message: `Asset "${label}" gateway FortiGate changed: ${displayValue(prev)} → ${next}`,
    details: changeDetails(ctx, { seenFirewall: { from: prev || null, to: next } }),
  };
}

/**
 * Controller link state change for a FortiGate-managed switch / AP — the
 * FortiLink session (FortiSwitch) or CAPWAP tunnel (FortiAP) going up or down
 * as the CONTROLLER sees it (business rule 58).
 *
 * Written unconditionally by the sweep, like the rest of the `asset.*.changed`
 * family: the transition is edge-triggered and rare, and an operator wants it
 * in the audit log whether or not an automation happens to watch it. The
 * `fortilink_changed` CHANGE_TYPE entry only gives the wizard a picker over an
 * Event that is already there.
 *
 * Level tracks direction — a link going down is a `warning`, coming back is
 * `info` — so the Events page's level filter separates the two without the
 * operator parsing messages. The first observation (`from === null`) is an
 * `info` at any value: it is Polaris learning the state, not the link moving.
 *
 * `to === null` returns undefined. Null means "never swept", and the sweep
 * never writes it — a controller it could not read is skipped, so there is no
 * value→null transition to report.
 */
export function buildFortilinkChangedEvent(
  ctx: AssetChangeEventContext,
  from: string | null | undefined,
  to: string | null | undefined,
  rawStatus?: string | null,
): LogEventInput | undefined {
  const next = (to ?? "").trim();
  if (!next) return undefined;
  const prev = (from ?? "").trim();
  if (prev === next) return undefined;
  const label = ctx.assetName || ctx.assetId;
  // The controller's own word for it, when it adds anything the normalized
  // value doesn't already say ("offline" / "discovered" both read as down).
  const raw = (rawStatus ?? "").trim();
  const rawSuffix = raw && raw.toLowerCase() !== next.toLowerCase() ? ` (controller reports "${raw}")` : "";
  return {
    action: "asset.fortilink.changed",
    resourceType: "asset",
    resourceId: ctx.assetId,
    resourceName: ctx.assetName || undefined,
    actor: ctx.actor || "system:fortilink-sweep",
    level: prev && next === "down" ? "warning" : "info",
    message: prev
      ? `Asset "${label}" controller link ${prev} → ${next}${rawSuffix}`
      : `Asset "${label}" controller link is ${next}${rawSuffix}`,
    details: changeDetails(ctx, { fortilinkStatus: { from: prev || null, to: next } }),
  };
}
