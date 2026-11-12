/**
 * src/api/routes/assets/list.ts — The asset collection: the server-side list (filter / sort / page), tags and
 * by-tag, settings (IP history, source priority, sightings), bulk monitor / tags,
 * mass pinning, quarantine availability, IP check. Split out of routes/assets.ts
 * (CQ-B062) and mounted FIRST, so these literal paths win over GET /:id.
 */

import { Router } from "express";
import { z } from "zod";
import { AppError } from "../../../utils/errors.js";
import { requirePermission, hasPermission, credentialUseActor, assertTagChangeAllowed } from "../../middleware/permissions.js";
import { resolveWriteScope, inWriteScope } from "../../../services/writeScopeService.js";
import { scopeAssetIds, requireFleetWide, idsFromBody } from "../../middleware/writeScope.js";
import { checkIpForIncomingClaim } from "../../../services/duplicateIpConflictService.js";
import { requestActor } from "../../middleware/auth.js";
import { logEvent } from "../events.js";
import { getHistorySettings, updateHistorySettings, pruneOldHistory } from "../../../services/assetIpHistoryService.js";
import { getSightingSettings, updateSightingSettings } from "../../../services/assetSightingService.js";
import { getQuarantinePushAvailability } from "../../../services/assetQuarantineService.js";
import { isValidIpAddress } from "../../../utils/cidr.js";
import { listAssetTags } from "../../../services/tagAssignmentService.js";
import { bulkEditAssetTags } from "../../../services/assetBulkTagService.js";
import { listAssetsWithTag, listAllAssetTags } from "../../../services/assetTagListService.js";
import { isAllZeroMac } from "../../../utils/mac.js";
import { listScopeOptions } from "../../../services/notificationRuleService.js";
import { SCOPE_FIELD_OPS, scopeConditionMeta, scopeConditionSchema } from "../../../services/notificationTypes.js";
import { loadScopeAssetIds } from "../../../services/notificationEngine.js";
import { listAssetTypes } from "../../../services/assetTypeService.js";
import { applyMassPins, getPinInventoryForAssets, MASS_PIN_MAX_ASSETS, MASS_PIN_MAX_DELTAS } from "../../../services/massPinService.js";
import { bulkSetMonitored } from "../../../services/assetBulkMonitorService.js";
import { AssetListQuerySchema, listAssetsPage } from "../../../services/assetListService.js";


const router = Router();

const AssetsByTagQuerySchema = z.object({
  tag: z.string().trim().min(1).max(128),
});

// ─── Routes ──────────────────────────────────────────────────────────────────

// GET /api/v1/assets — list assets (all authenticated users). Server-side
// filter / sort / pagination; favorites-first ordering when `favoriteIds` is
// supplied (operator's starred ids float to the top of the whole result set,
// not just the current page).
router.get("/", requirePermission("assets", "read"), async (req, res, next) => {
  try {
    const parsed = AssetListQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      throw new AppError(400, "Invalid query: " + parsed.error.issues[0].message);
    }
    const { enriched, total, limit, offset } = await listAssetsPage(parsed.data, req.query as Record<string, unknown>, requestActor(req));
    // Rule 141 (e): what THIS caller may change, per row — server-computed so
    // the page never re-derives tag matching. Pure set lookups over columns
    // already selected; nothing more at 2000 rows.
    const [editScope, quarantineScope, maintScope] = await Promise.all([resolveWriteScope(req, "assets"), resolveWriteScope(req, "assetsQuarantine"), resolveWriteScope(req, "maintenanceManagement")]);
    const flagged = (enriched as Array<Record<string, unknown>>).map((a) => ({
      ...a,
      canEdit: inWriteScope(editScope, a as { createdBy: string | null; tags?: string[] }),
      canQuarantine: inWriteScope(quarantineScope, a as { createdBy: string | null; tags?: string[] }),
      canMaintain: inWriteScope(maintScope, a as { createdBy: string | null; tags?: string[] }),
    }));
    res.json({ assets: flagged, total, limit, offset });
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/assets/ip-history-settings — get history retention settings (all authenticated users)
// Must be defined before /:id to avoid route shadowing.
router.get("/ip-history-settings", requirePermission("assets", "read"), async (_req, res, next) => {
  try {
    res.json(await getHistorySettings());
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/assets/tags — distinct tags across all assets, for autocomplete
// (notification-rule scope picker, etc.). One scan with a tight select.
router.get("/tags", requirePermission("assets", "read"), async (_req, res, next) => {
  try {
    res.json({ tags: await listAllAssetTags() });
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/assets/by-tag?tag=<name> — the assets carrying exactly this tag
// (case-sensitive, as Asset.tags stores it). Drives the Server Settings tag
// registry's "assets with this tag" slide-over. The list endpoint's Tags filter
// is a substring match ("prod" also finds "production"), so it cannot answer
// this. Capped; `total` is the uncapped count.
router.get("/by-tag", requirePermission("assets", "read"), async (req, res, next) => {
  try {
    const parsed = AssetsByTagQuerySchema.safeParse(req.query);
    if (!parsed.success) throw new AppError(400, "Invalid query: " + parsed.error.issues[0].message);
    res.json(await listAssetsWithTag(parsed.data.tag));
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/assets/agent-signing-alert — the durable "last agent build
// shipped UNSIGNED Windows binaries" stamp (Setting `agent.signing.lastFailure`,
// written by agentBuildService's fail-open signing step; cleared by the next
// fully-signed build or by disabling signing). Drives the dismissable sidebar
// alert in app.js. Gated assets:write — the agent-DEPLOY permission (same gate
// as /:id/agent/install below) — deliberately NOT under /server-settings,
// whose router-level serverSettingsSystem gate only admin passes.
router.get("/agent-signing-alert", requirePermission("assets", "write"), async (_req, res, next) => {
  try {
    const { getSigningAlert } = await import("../../../services/agentSigningService.js");
    res.json(await getSigningAlert());
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/assets/source-priority — the operator's Sources-column priority
// (which discovery source's learned location wins) plus the catalogue of what
// each source contributes, so the drag-and-drop list renders its labels and
// hints from the server rather than hardcoding them. Before /:id.
router.get("/source-priority", requirePermission("assets", "read"), async (_req, res, next) => {
  try {
    const { getSourcePrioritySettings } = await import("../../../services/assetSourcePriorityService.js");
    res.json(await getSourcePrioritySettings());
  } catch (err) {
    next(err);
  }
});

// PUT /api/v1/assets/source-priority — reorder / toggle the integration-name
// prefix. assets:write, matching the other settings on the Assets → Settings
// modal; the service audits the change with the previous order.
router.put("/source-priority", requirePermission("assets", "write"), requireFleetWide("assets", "the source priority"), async (req, res, next) => {
  try {
    const body = z.object({
      order: z.array(z.string()).max(500).optional(),
      integrationPrefix: z.boolean().optional(),
    }).parse(req.body);
    const { saveSourceLocationPriority, getSourcePrioritySettings } =
      await import("../../../services/assetSourcePriorityService.js");
    await saveSourceLocationPriority(body, requestActor(req));
    res.json(await getSourcePrioritySettings());
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/assets/ip-context?ip=10.4.12.63 — everything Polaris already
// knows about one address, for the manual Add Asset form: the containing
// network, the lease/reservation sitting on it, the gate ARP caches and
// FortiGate sightings that have resolved it, the switch port its MAC shows up
// on, and any asset already carrying it. Read-only; creates nothing. Before
// /:id (a bare word would otherwise be captured as an asset id).
//
// Gated assets:read, with the two IPAM halves gated a second time on the
// caller's own subnets/reservations access — the dashboard precedent. Which
// sections were consulted rides back in `visibility`, so a role that can't see
// networks reads "not shown" rather than a confident "no network found".
router.get("/ip-context", requirePermission("assets", "read"), async (req, res, next) => {
  try {
    const ip = typeof req.query.ip === "string" ? req.query.ip : "";
    const { lookupIpContext } = await import("../../../services/ipContextService.js");
    const result = await lookupIpContext(ip, {
      includeSubnets: hasPermission(req, "subnets", "read"),
      includeReservations: hasPermission(req, "reservations", "read"),
    });
    // A half-typed address is the normal case on a debounced keystroke, not an
    // error — answer 200 with nothing found rather than 400-ing per character.
    res.json(result ?? { ip: ip.trim(), unparseable: true });
  } catch (err) {
    next(err);
  }
});

// PUT /api/v1/assets/ip-history-settings — update retention settings (assets admin)
router.put("/ip-history-settings", requirePermission("assets", "write"), requireFleetWide("assets", "the IP-history settings"), async (req, res, next) => {
  try {
    const { retentionDays } = z.object({ retentionDays: z.number().int().min(0).max(3650) }).parse(req.body);
    await updateHistorySettings({ retentionDays });
    const pruned = await pruneOldHistory();
    logEvent({ action: "asset.history_settings.updated", actor: requestActor(req), message: `IP history retention set to ${retentionDays} day(s)${pruned ? `; pruned ${pruned} old record(s)` : ""}` });
    res.json({ ok: true, pruned });
  } catch (err) {
    next(err);
  }
});

// Note: the legacy GET/PUT /monitor-settings routes were retired with the
// move to the four-tier hierarchy. Operators now use:
//   - /api/v1/monitor-settings/manual                → global manual tier
//   - /api/v1/monitor-settings/integration/:id       → per-integration tier
//   - /api/v1/monitor-settings/class-overrides       → (class + integration)
//   - PUT /api/v1/assets/:id  with monitorIntervalSec / probeTimeoutMs / etc.
//                                                    → per-asset overrides
// See src/api/routes/monitorSettings.ts.

// POST /api/v1/assets/bulk-monitor — enable/disable monitoring on a set of assets.
// Body: { ids, monitored, monitorCredentialId?, monitorIntervalSec?, probeTimeoutMs? }.
// On enable: applies the same credential + cadence overrides uniformly. The
// polling method comes from the resolver (per-asset overrides set via PUT,
// class overrides, integration-tier setting, source default) — the bulk
// endpoint isn't the place to choose a method, since one selection rarely
// fits a heterogeneous batch. Operators picking a method per-asset use the
// asset edit modal's Monitoring tab.
// Returns per-id error list for any rejected rows.
router.post("/bulk-monitor", requirePermission("assets", "write"), scopeAssetIds("assets", "change monitoring on devices", idsFromBody), async (req, res, next) => {
  try {
    const body = z.object({
      ids:                 z.array(z.string().guid()).max(50_000).min(1),
      monitored:           z.boolean(),
      monitorCredentialId: z.string().guid().nullable().optional(),
      monitorIntervalSec:  z.number().int().min(5).max(86400).nullable().optional(),
      probeTimeoutMs:      z.number().int().min(100).max(60000).nullable().optional(),
    }).parse(req.body);

    res.json(await bulkSetMonitored(body, credentialUseActor(req), requestActor(req)));
  } catch (err) { next(err); }
});

// POST /api/v1/assets/bulk-tags — add / remove / replace tags on a set of
// assets (Assets page bulk bar "Tags"). Body: { ids, mode, tags }. Same gate
// as PUT /:id, which is the single-asset tag write. Semantics — including the
// managed prefixes a replace keeps — live in assetBulkTagService.
const BulkTagsSchema = z.object({
  ids:  z.array(z.string().guid()).min(1).max(10000),
  mode: z.enum(["add", "remove", "replace"]),
  tags: z.array(z.string().max(128)).max(200),
});

router.post("/bulk-tags", requirePermission("assets", "write"), scopeAssetIds("assets", "tag devices", idsFromBody), async (req, res, next) => {
  try {
    const body = BulkTagsSchema.parse(req.body);
    // The whole verb is a tag change, so it is the Tags key's grant chained
    // on the asset edit it also is.
    assertTagChangeAllowed(req, [], body.tags.length ? body.tags : ["(any)"]);
    const result = await bulkEditAssetTags(body);
    const verb = body.mode === "add" ? "Added" : body.mode === "remove" ? "Removed" : "Replaced";
    const tagList = result.tags.length ? result.tags.join(", ") : "(none)";
    logEvent({
      action: "asset.bulk_tags",
      resourceType: "asset",
      actor: requestActor(req),
      message: `${verb} tags [${tagList}] on ${result.updated} asset(s)` +
        (result.unchanged ? `; ${result.unchanged} already matched` : "") +
        (result.notFound.length ? `; ${result.notFound.length} not found` : ""),
      details: { mode: body.mode, tags: result.tags, updated: result.updated, unchanged: result.unchanged, notFound: result.notFound },
    });
    res.json(result);
  } catch (err) { next(err); }
});

// ─── Mass Pinning (Assets → Settings → Mass Pinning section) ─────────────────
//
// Manual bulk pin/unpin of fast-cadence targets (interfaces incl. IPsec
// tunnels, storage mounts) across a condition-filtered device set. Three
// endpoints; business logic lives in services/massPinService.ts. The UI button
// is data-admin-only, but the endpoints are gated assets:read / assets:write
// for API-token parity (the bulk-monitor posture).

// The device-filter scope: the automations condition-tree vocabulary
// (SCOPE_FIELD_OPS), or the explicit all-assets flag. One of the two is
// required — a bare {} must never quietly mean "the whole fleet".
const MassPinScopeSchema = z.object({
  allAssets: z.boolean().optional(),
  condition: scopeConditionSchema.optional(),
}).refine((v) => v.allAssets === true || v.condition !== undefined, {
  message: "Provide a condition or allAssets: true",
});

// GET /api/v1/assets/pin-filter-schema — the condition builder's vocabulary +
// value suggestions for the Mass Pinning section. Its own route rather than
// /automations/schema + /scope-options because those are gated
// automationManagement:read, and pinning interfaces must not require
// permission to edit automations (the contacts /filter-schema precedent).
// Built from the same shared scopeConditionMeta so vocabularies can't drift —
// this one carries the NARROW automations field set, matching what the
// automation wizard's Devices step offers.
router.get("/pin-filter-schema", requirePermission("assets", "read"), async (_req, res, next) => {
  try {
    const [options, assetTypes, tags] = await Promise.all([
      listScopeOptions(),
      listAssetTypes(),
      listAssetTags(),
    ]);
    res.json({
      scopeCondition: scopeConditionMeta(SCOPE_FIELD_OPS),
      options: {
        ...options,
        assetTypes: assetTypes.map((t) => ({ name: t.name, label: t.label || t.name })),
        tags,
      },
      maxAssets: MASS_PIN_MAX_ASSETS,
    });
  } catch (err) { next(err); }
});

// POST /api/v1/assets/pin-inventory — resolve the device filter server-side
// (the client never ships thousands of ids) and return the matched assets'
// facet inventory aggregated by name, with per-device pinned state so the
// client renders tri-state checkboxes from one call. mode:"count" is the
// cheap half the debounced filter preview uses. Matched sets over
// MASS_PIN_MAX_ASSETS refuse the full inventory (overCap) rather than
// truncating — a cut device list would make "pinned on ALL devices" a lie.
router.post("/pin-inventory", requirePermission("assets", "read"), async (req, res, next) => {
  try {
    const body = MassPinScopeSchema.and(z.object({
      facet: z.enum(["interfaces", "storage"]),
      mode:  z.enum(["count", "full"]).default("full"),
    })).parse(req.body);

    const ids = await loadScopeAssetIds(
      body.allAssets === true ? { allAssets: true } : { condition: body.condition as any },
    );
    if (body.mode === "count") {
      res.json({ matchedCount: ids.length });
      return;
    }
    if (ids.length > MASS_PIN_MAX_ASSETS) {
      res.json({ matchedCount: ids.length, overCap: true });
      return;
    }
    const inventory = await getPinInventoryForAssets(ids, body.facet);
    res.json({ matchedCount: ids.length, overCap: false, inventory });
  } catch (err) { next(err); }
});

// POST /api/v1/assets/mass-pins — apply staged pin/unpin deltas. Deltas (not
// final arrays) so a concurrent hand-pin of an unrelated name on the same
// asset is never clobbered; the 64-per-array cap is re-enforced per asset in
// the service (overflow = per-asset skip with reason, never a batch 400).
router.post("/mass-pins", requirePermission("assets", "write"), scopeAssetIds("assets", "pin interfaces on devices", (r) => [...((r.body && r.body.pin) || []), ...((r.body && r.body.unpin) || [])].map((d: { assetId?: unknown }) => (d && typeof d.assetId === "string" ? d.assetId : ""))), async (req, res, next) => {
  try {
    const DeltaSchema = z.object({
      assetId: z.string().guid(),
      name:    z.string().min(1).max(256),
      field:   z.enum(["interfaces", "ipsecTunnels", "storage"]),
    });
    const body = z.object({
      pin:   z.array(DeltaSchema).max(MASS_PIN_MAX_DELTAS).default([]),
      unpin: z.array(DeltaSchema).max(MASS_PIN_MAX_DELTAS).default([]),
    }).refine((b) => b.pin.length + b.unpin.length > 0, { message: "No pin changes supplied" })
      .parse(req.body);

    res.json(await applyMassPins(body, requestActor(req) ?? "unknown"));
  } catch (err) { next(err); }
});

// GET /api/v1/assets/agent-install-scripts — curated install-method catalog
// for the deploy modal's picker. MUST stay above GET /:id so the literal path
// isn't captured as an asset id. Read-only metadata (no secrets); gated read.
router.get("/agent-install-scripts", requirePermission("assets", "read"), async (_req, res, next) => {
  try {
    const { AGENT_INSTALL_SCRIPTS } = await import("../../../services/agentInstallScripts.js");
    res.json({ scripts: AGENT_INSTALL_SCRIPTS });
  } catch (err) { next(err); }
});

// GET /api/v1/assets/quarantine-availability — is quarantine push configured
// on ANY enabled FortiManager / FortiGate integration? Drives whether the
// frontends offer the quarantine verbs at all (row menu, bulk bar, details
// tab): with the per-integration toggle off fleet-wide a push can only fail
// with "0/0 FortiGate(s) accepted the push". MUST stay above GET /:id so the
// literal path isn't captured as an asset id. Gated on the quarantine key at
// read level — the callers already hold `assetsQuarantine:write`, and the
// answer says nothing about any individual integration.
router.get(
  "/quarantine-availability",
  requirePermission("assetsQuarantine", "read"),
  async (_req, res, next) => {
    try {
      res.json(await getQuarantinePushAvailability());
    } catch (err) { next(err); }
  },
);

// GET|PUT /api/v1/assets/sighting-settings — the quarantine sighting max-age.
// MUST stay above GET /:id and PUT /:id (the quarantine-availability rule):
// these two literals sat BELOW the parameterized routes from the day they
// shipped, so Express captured them as id="sighting-settings" and both verbs
// answered 404 "Asset not found" — unreachable until 2026-09-02. Nothing in
// the UI calls them (the api.js wrappers are unused), so only external API
// callers ever hit the shadowing; found while authoring /api docs.
router.get("/sighting-settings", requirePermission("assetsQuarantine", "read"), async (_req, res, next) => {
  try {
    res.json(await getSightingSettings());
  } catch (err) {
    next(err);
  }
});

router.put("/sighting-settings", requirePermission("assetsQuarantine", "write"), requireFleetWide("assetsQuarantine", "the sighting settings"), async (req, res, next) => {
  try {
    const Schema = z.object({ sightingMaxAgeDays: z.number().int().min(0).max(3650) });
    const input = Schema.parse(req.body);
    await updateSightingSettings(input);
    logEvent({
      action: "asset.sighting_settings_updated",
      actor: requestActor(req),
      message: `Quarantine sighting max-age set to ${input.sightingMaxAgeDays} day(s)`,
    });
    res.json(input);
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/assets/:id — get single asset (all authenticated users)
// GET /api/v1/assets/ip-check?ip=&excludeAssetId=&assetType=&macAddress=
//
// The asset form's pre-save question (business rule 40(i)): who else is on
// this address, and would saving raise a duplicate-ip conflict? Answered by
// SIMULATING the incoming claim through the same grouping the sweep uses, so
// what the dialog warns about is exactly what the save will raise. Read-only;
// `assets:read` because the assets list already exposes every IP it names.
//
// `canMerge` rides along so the form's "review merge" button is gated by the
// SERVER's answer rather than a client-side re-derivation of the matrix — the
// too-strict-client-gate trap this codebase has hit before.
//
// Declared above `/:id` so Express does not read "ip-check" as an asset id.
const IpCheckQuerySchema = z.object({
  ip: z.string().trim().min(1),
  excludeAssetId: z.string().trim().min(1).optional(),
  assetType: z.string().trim().min(1).optional(),
  macAddress: z.string().trim().min(1).optional(),
});

router.get("/ip-check", requirePermission("assets", "read"), async (req, res, next) => {
  try {
    const q = IpCheckQuerySchema.parse(req.query);
    if (!isValidIpAddress(q.ip)) throw new AppError(400, `"${q.ip}" is not a valid IP address`);
    const result = await checkIpForIncomingClaim({
      ip: q.ip,
      excludeAssetId: q.excludeAssetId ?? null,
      assetType: q.assetType ?? null,
      // All-zero → null: no incoming device is identified by "no MAC".
      macAddress: q.macAddress && !isAllZeroMac(q.macAddress) ? q.macAddress.toUpperCase().replace(/-/g, ":") : null,
    });
    // Merging any two assets is its own key from 2026-11-03; release 2 of the
    // write-scope change adds "or you own both" at assets:write.
    res.json({ ...result, canMerge: hasPermission(req, "assetMerge", "write") });
  } catch (err) {
    next(err);
  }
});

export default router;
