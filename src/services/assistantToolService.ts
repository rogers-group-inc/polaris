/**
 * src/services/assistantToolService.ts — the lookups the AI assistant may make
 * (business rule 95).
 *
 * Every tool:
 *   (a) runs AS THE CALLER — it is handed the caller's own Express request and
 *       checks the caller's role snapshot with hasPermission() before it
 *       touches anything. A role without `alerts` read gets "not permitted"
 *       back from list_alerts, never data; alerts are region-scoped exactly as
 *       the Alerts page scopes them.
 *   (b) is READ-ONLY. Nothing here writes, acknowledges, pushes or probes.
 *   (c) projects to a tight select (no config blobs, no secrets, no raw
 *       topology JSON) and caps its rows, so a 2000-asset fleet costs the same
 *       as a 100-asset one and a small local model's context is not flooded.
 *
 * create_report re-runs one of the list tools server-side with a much larger
 * cap and hands the rows to the client as a downloadable table — the figures
 * in a report come from the database, never from model text (rule 95(c)).
 *
 * Tool arguments come from a language model, so every tool parses them with
 * Zod and answers a validation problem as a tool error the model can correct,
 * not as an exception.
 */

import type { Request } from "express";
import { z } from "zod";
import { prisma } from "../db.js";
import { hasPermission, callerIsAdminEquivalent } from "../api/middleware/permissions.js";
import { searchAll } from "./searchService.js";
import { listNotifications } from "./notificationService.js";
import { getEffectiveRegionTags, getEffectiveTagScopes } from "./regionScopeService.js";
import { REGION_TAG_PREFIX } from "../utils/tagNormalize.js";
import { queryEventsPage } from "./eventLogService.js";
import { getRetentionSettings } from "./eventArchiveService.js";
import { searchHelp } from "./helpIndexService.js";
import { usableHostCount, isValidCidr, ipInCidr, isValidIpAddress } from "../utils/cidr.js";
import type { ChatToolDef } from "./llmService.js";

export const REPORT_ROW_CAP = 5000;

/** Alert severities, lowest to highest (utils/alertSeverity.ts ranks them). */
const ALERT_SEVERITIES = ["notice", "informational", "warning", "serious", "critical"] as const;

export interface ReportColumn { key: string; label: string }

export interface AssistantReportPayload {
  title: string;
  columns: ReportColumn[];
  rows: Array<Record<string, unknown>>;
  rowCount: number;
  truncated: boolean;
}

export interface ToolContext {
  req: Request;
  /** Row cap for an ordinary lookup (the integration's maxRowsPerTool). */
  maxRows: number;
  /** Called when create_report produces a table for the client. */
  onReport?: (report: AssistantReportPayload) => void;
}

export interface ToolResult {
  ok: boolean;
  /** JSON-serializable payload returned to the model. */
  data: unknown;
}

interface ToolDef {
  name: string;
  /** Short past-tense chip label for the widget ("searched assets"). */
  label: string;
  description: string;
  parameters: Record<string, unknown>;
  run(args: unknown, ctx: ToolContext): Promise<ToolResult>;
}

/** A list tool also exposes its rows + column set to create_report. */
interface ListToolDef extends ToolDef {
  columns: ReportColumn[];
  rows(args: unknown, ctx: ToolContext, cap: number): Promise<{ rows: Array<Record<string, unknown>>; total: number } | ToolResult>;
}

const denied = (what: string): ToolResult => ({
  ok: false,
  data: { error: `Not permitted: your role cannot read ${what}. Tell the user they do not have access to this information.` },
});

const invalid = (err: z.ZodError): ToolResult => ({
  ok: false,
  data: { error: "Invalid arguments: " + err.issues.map((i) => `${i.path.join(".") || "args"}: ${i.message}`).join("; ") },
});

/** ISO-8601 strings for Dates so the model and the CSV both read them plainly. */
function plain(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    if (v instanceof Date) out[k] = v.toISOString();
    else if (Array.isArray(v)) out[k] = v.join(", ");
    else out[k] = v;
  }
  return out;
}

/**
 * Resolve a time window from `hours` (look back N hours) or explicit ISO
 * bounds. Small models handle "hours: 24" far more reliably than composing
 * timestamps, so both are offered.
 */
function timeWindow(a: { hours?: number; since?: string; until?: string }): { from?: Date; to?: Date } {
  const out: { from?: Date; to?: Date } = {};
  if (a.since) {
    const d = new Date(a.since);
    if (!isNaN(+d)) out.from = d;
  } else if (a.hours) {
    out.from = new Date(Date.now() - a.hours * 3_600_000);
  }
  if (a.until) {
    const d = new Date(a.until);
    if (!isNaN(+d)) out.to = d;
  }
  return out;
}

const WindowArgs = {
  hours: z.number().positive().max(24 * 400).optional(),
  since: z.string().max(40).optional(),
  until: z.string().max(40).optional(),
};
const windowSchemaProps = {
  hours: { type: "number", description: "Look back this many hours from now (e.g. 24). Use instead of since." },
  since: { type: "string", description: "ISO-8601 start time, e.g. 2026-10-06T00:00:00Z" },
  until: { type: "string", description: "ISO-8601 end time" },
};

// ─── search_help ─────────────────────────────────────────────────────────────

const HelpArgs = z.object({ query: z.string().min(1).max(300) });

const searchHelpTool: ToolDef = {
  name: "search_help",
  label: "searched the Polaris help",
  description:
    "Search the Polaris operator documentation. Use for ANY question about how to use, configure or " +
    "troubleshoot Polaris itself (pages, settings, integrations, permissions, automations, monitoring). " +
    "Cite the page and section you used.",
  parameters: {
    type: "object",
    properties: { query: { type: "string", description: "Keywords, e.g. 'maintenance window schedule'" } },
    required: ["query"],
  },
  async run(args) {
    const p = HelpArgs.safeParse(args);
    if (!p.success) return invalid(p.error);
    const r = await searchHelp(p.data.query);
    if (!r.available) {
      return { ok: false, data: { error: "The help documentation is not installed on this server. Say so; do not guess." } };
    }
    if (r.hits.length === 0) return { ok: true, data: { hits: [], note: "No matching help sections. Try other keywords." } };
    return { ok: true, data: { hits: r.hits.map(({ score: _s, ...h }) => h) } };
  },
};

// ─── search ──────────────────────────────────────────────────────────────────

const SearchArgs = z.object({ query: z.string().min(1).max(200) });

const searchTool: ToolDef = {
  name: "search",
  label: "searched Polaris",
  description:
    "Global search across assets, networks, IP blocks, reservations and sites by name, IP, " +
    "MAC or hostname. Good first step when the user names a device or address. For an address, each asset hit " +
    "says why it matched: matchedOn \"ipAddress\" (its current primary IP) or \"ipHistory\" with heldThisAddress " +
    "(a WAN, secondary or former address the device held, and when it was last seen there) — such a device IS " +
    "a hit for that address.",
  parameters: {
    type: "object",
    properties: { query: { type: "string", description: "Hostname, IP, MAC, CIDR or name fragment" } },
    required: ["query"],
  },
  async run(args, ctx) {
    const p = SearchArgs.safeParse(args);
    if (!p.success) return invalid(p.error);
    const req = ctx.req;
    const results = await searchAll(p.data.query, {
      blocks:       hasPermission(req, "ipBlocks", "read"),
      subnets:      hasPermission(req, "subnets", "read"),
      reservations: hasPermission(req, "reservations", "read"),
      assets:       hasPermission(req, "assets", "read"),
      sites:        hasPermission(req, "deviceMap", "read"),
    });
    const cap = Math.min(ctx.maxRows, 25);
    const trimmed: Record<string, unknown> = {};
    for (const [group, hits] of Object.entries(results as unknown as Record<string, unknown>)) {
      if (Array.isArray(hits)) trimmed[group] = hits.slice(0, cap);
    }
    // An address query: say WHY each asset matched. searchAll also finds a
    // device by an address in its IP history (a WAN / secondary / rotated-off
    // address) and returns the device with its CURRENT primary IP — which a
    // model read as a text coincidence and dismissed (seen live 2026-10-09,
    // a FortiGate that held 153.66.102.165 "not recorded in Polaris").
    const ipv4 = /\b(?:\d{1,3}\.){3}\d{1,3}\b/.exec(p.data.query)?.[0];
    const assets = trimmed.assets as Array<Record<string, unknown>> | undefined;
    if (ipv4 && assets?.length) {
      const ids = assets.map((a) => a.id).filter((id): id is string => typeof id === "string");
      const held = ids.length
        ? await prisma.assetIpHistory.findMany({
          where: { ip: ipv4, assetId: { in: ids } },
          select: { assetId: true, ip: true, source: true, firstSeen: true, lastSeen: true },
        })
        : [];
      const byAsset = new Map(held.map((h) => [h.assetId, h]));
      trimmed.assets = assets.map((a) => {
        if (a.ipAddress === ipv4) return { ...a, matchedOn: "ipAddress" };
        const h = byAsset.get(String(a.id));
        if (!h) return a;
        const { assetId: _assetId, ...rest } = h;
        return { ...a, matchedOn: "ipHistory", heldThisAddress: plain(rest) };
      });
    }
    return { ok: true, data: trimmed };
  },
};

// ─── list_assets ─────────────────────────────────────────────────────────────

const ASSET_STATUSES = ["active", "maintenance", "decommissioned", "storage", "disabled", "quarantined"] as const;
const MONITOR_STATUSES = ["up", "down", "warning", "recovering", "unknown", "passive"] as const;

/**
 * A filter a model may give as one value, a list, or a comma-separated
 * string ("switch, firewall") — small models use all three, and a single-value
 * filter turned "every switch and firewall" into a 0-row report (2026-10-07).
 * Normalized to a de-duplicated list.
 */
function oneOrMany<T extends z.ZodTypeAny>(item: T) {
  return z.preprocess((v) => {
    if (v == null || v === "") return undefined;
    const list = Array.isArray(v) ? v : typeof v === "string" ? v.split(",") : [v];
    const clean = list.map((x) => (typeof x === "string" ? x.trim() : x)).filter((x) => x !== "" && x != null);
    return clean.length ? Array.from(new Set(clean)) : undefined;
  }, z.array(item).max(20).optional());
}

const AssetArgs = z.object({
  search: z.string().max(200).optional(),
  assetType: oneOrMany(z.string().max(60)),
  status: oneOrMany(z.enum(ASSET_STATUSES)),
  monitorStatus: oneOrMany(z.enum(MONITOR_STATUSES)),
  monitored: z.boolean().optional(),
  tag: z.string().max(100).optional(),
  region: oneOrMany(z.string().trim().min(1).max(100)),
  myRegions: z.boolean().optional(),
  location: z.string().max(200).optional(),
  manufacturer: z.string().max(100).optional(),
  model: z.string().max(100).optional(),
  os: z.string().max(100).optional(),
  network: z.string().max(60).optional(),
  subnet: z.string().max(60).optional(), // older spelling of `network`, still accepted
  notSeenForHours: z.number().positive().max(24 * 3650).optional(),
  sortBy: z.enum(["hostname", "lastSeen", "monitorStatusChangedAt", "ipAddress"]).optional(),
  limit: z.number().int().positive().max(REPORT_ROW_CAP).optional(),
});

const ASSET_TOOL_SELECT = {
  id: true, hostname: true, ipAddress: true, macAddress: true, assetType: true, status: true,
  manufacturer: true, model: true, serialNumber: true, os: true, osVersion: true,
  location: true, learnedLocation: true, tags: true, monitored: true, monitorStatus: true,
  monitorStatusChangedAt: true, lastSeen: true, lastResponseTimeMs: true, assignedTo: true, department: true,
} as const;

/**
 * Every tag spelling a region name may be stored under on an asset. A model
 * passes the name the person typed ("middle tennessee", "Region:Middle
 * Tennessee"), and Prisma's `hasSome` is exact and case-sensitive — seen
 * 2026-10-09: a real Middle Tennessee device was reported absent. So each
 * name resolves, case-insensitively, against the Tag registry under both
 * the `region:` form and the bare form, and the literal forms are kept for
 * a tag the registry does not hold. Exported for tests.
 */
export async function regionTagVariants(names: string[]): Promise<string[]> {
  const bare = Array.from(new Set(names.map((n) => n.trim().replace(new RegExp(`^${REGION_TAG_PREFIX}`, "i"), "").trim()).filter(Boolean)));
  if (!bare.length) return [];
  const wanted = bare.flatMap((n) => [REGION_TAG_PREFIX + n, n]);
  const registered = await prisma.tag.findMany({
    where: { OR: wanted.map((w) => ({ name: { equals: w, mode: "insensitive" as const } })) },
    select: { name: true },
  }).catch(() => [] as Array<{ name: string }>);
  return Array.from(new Set([...wanted, ...registered.map((t) => t.name)]));
}

const listAssetsTool: ListToolDef = {
  name: "list_assets",
  label: "looked up assets",
  description:
    "List assets (devices) with filters. monitorStatus 'down' finds devices that are currently down. " +
    "assetType values include firewall, switch, access_point, server, workstation, printer, other. " +
    "network filters to assets whose IP is inside a network CIDR. Decommissioned assets are left out unless " +
    "status includes \"decommissioned\" — pass it only when the person asks about decommissioned assets.",
  parameters: {
    type: "object",
    properties: {
      search: { type: "string", description: "Matches hostname, DNS name, IP, MAC, asset tag or assigned-to" },
      assetType: { type: "array", items: { type: "string" }, description: "One or more types, e.g. [\"switch\", \"firewall\"] for switches AND firewalls" },
      status: { type: "array", items: { type: "string", enum: [...ASSET_STATUSES] } },
      monitorStatus: { type: "array", items: { type: "string", enum: [...MONITOR_STATUSES] } },
      monitored: { type: "boolean" },
      tag: { type: "string", description: "Exact tag, e.g. a site tag" },
      region: { type: "array", items: { type: "string" }, description: "Region names, e.g. [\"Middle Tennessee\"] — assets in ANY of them. Any case, with or without \"region:\". Use this, not location or search, for a region" },
      myRegions: { type: "boolean", description: "Only assets in the regions assigned to the person asking — use for \"my region\" / \"my sites\"" },
      location: { type: "string", description: "Location contains this text" },
      manufacturer: { type: "string" },
      model: { type: "string" },
      os: { type: "string" },
      network: { type: "string", description: "A network CIDR, e.g. 10.20.0.0/16" },
      notSeenForHours: { type: "number", description: "Only assets not seen on the network for at least this many hours" },
      sortBy: { type: "string", enum: ["hostname", "lastSeen", "monitorStatusChangedAt", "ipAddress"] },
      limit: { type: "number" },
    },
  },
  columns: [
    { key: "hostname", label: "Hostname" }, { key: "ipAddress", label: "IP" }, { key: "assetType", label: "Type" },
    { key: "status", label: "Status" }, { key: "monitorStatus", label: "Monitor" }, { key: "manufacturer", label: "Manufacturer" },
    { key: "model", label: "Model" }, { key: "serialNumber", label: "Serial" }, { key: "osVersion", label: "OS version" },
    { key: "location", label: "Location" }, { key: "tags", label: "Tags" }, { key: "lastSeen", label: "Last seen" },
    { key: "monitorStatusChangedAt", label: "Status changed" },
  ],
  async rows(args, ctx, cap) {
    if (!hasPermission(ctx.req, "assets", "read")) return denied("assets");
    const p = AssetArgs.safeParse(args ?? {});
    if (!p.success) return invalid(p.error);
    const a = p.data;
    const and: Record<string, unknown>[] = [];
    if (a.search) {
      and.push({
        OR: ["hostname", "dnsName", "ipAddress", "macAddress", "assetTag", "assignedTo"].map((f) => ({
          [f]: { contains: a.search, mode: "insensitive" },
        })),
      });
    }
    if (a.assetType) and.push({ assetType: { in: a.assetType } });
    // Decommissioned assets are history, not inventory: left out unless the
    // status filter asks for them (owner's call, 2026-10-09).
    if (a.status) and.push({ status: { in: a.status } });
    else and.push({ status: { not: "decommissioned" } });
    if (a.monitorStatus) and.push({ monitorStatus: { in: a.monitorStatus }, monitored: true });
    if (typeof a.monitored === "boolean") and.push({ monitored: a.monitored });
    if (a.tag) and.push({ tags: { has: a.tag } });
    // Regions ride assets as `region:<name>` tags — the same tags alert
    // scoping snapshots (notificationEngine regionSnapshot), matched the same
    // exact way. "My regions" are the person's ASSIGNED regions, admins
    // included (an admin sees everything, but still has regions of their own).
    let regionNames = a.region ?? [];
    if (a.myRegions) {
      const mine = ctx.req.session?.userId ? (await getEffectiveTagScopes(ctx.req.session.userId)).regions : [];
      if (!mine.length) {
        return { ok: false, data: { error: "No region is assigned to this person, so there is no \"my region\" to narrow to — ask which region they mean." } };
      }
      regionNames = [...regionNames, ...mine];
    }
    if (regionNames.length) and.push({ tags: { hasSome: await regionTagVariants(regionNames) } });
    if (a.location) {
      and.push({ OR: [
        { location: { contains: a.location, mode: "insensitive" } },
        { learnedLocation: { contains: a.location, mode: "insensitive" } },
      ] });
    }
    if (a.manufacturer) and.push({ manufacturer: { contains: a.manufacturer, mode: "insensitive" } });
    if (a.model) and.push({ model: { contains: a.model, mode: "insensitive" } });
    if (a.os) and.push({ OR: [{ os: { contains: a.os, mode: "insensitive" } }, { osVersion: { contains: a.os, mode: "insensitive" } }] });
    if (a.notSeenForHours) and.push({ lastSeen: { lt: new Date(Date.now() - a.notSeenForHours * 3_600_000) } });
    let subnet: string | undefined;
    const cidrArg = a.network ?? a.subnet;
    if (cidrArg) {
      if (!isValidCidr(cidrArg)) return { ok: false, data: { error: `"${cidrArg}" is not a valid CIDR` } };
      subnet = cidrArg;
      and.push({ ipAddress: { not: null } });
    }
    const where = and.length ? { AND: and } : {};
    const orderBy = a.sortBy ? { [a.sortBy]: a.sortBy === "hostname" || a.sortBy === "ipAddress" ? "asc" : "desc" } : { hostname: "asc" };
    const take = Math.min(a.limit ?? cap, cap);
    if (subnet) {
      // CIDR containment is not a Prisma predicate: narrow in SQL first, then
      // match in memory via utils/cidr (the only place IP math may live).
      const candidates = await prisma.asset.findMany({ where, orderBy: orderBy as never, select: ASSET_TOOL_SELECT });
      const hits = candidates.filter((r) => r.ipAddress && isValidIpAddress(r.ipAddress) && ipInCidr(r.ipAddress, subnet!));
      return { rows: hits.slice(0, take).map(plain), total: hits.length };
    }
    const [rows, total] = await Promise.all([
      prisma.asset.findMany({ where, orderBy: orderBy as never, take, select: ASSET_TOOL_SELECT }),
      prisma.asset.count({ where }),
    ]);
    return { rows: rows.map(plain), total };
  },
  async run(args, ctx) {
    return listResult(await this.rows(args, ctx, ctx.maxRows));
  },
};

// ─── get_asset ───────────────────────────────────────────────────────────────

const GetAssetArgs = z.object({
  id: z.string().max(60).optional(),
  hostname: z.string().max(255).optional(),
  ip: z.string().max(60).optional(),
}).refine((a) => a.id || a.hostname || a.ip, "Give id, hostname or ip");

const getAssetTool: ToolDef = {
  name: "get_asset",
  label: "opened an asset",
  description:
    "Full detail for ONE asset by id, exact hostname or IP: identity, monitoring state, the upstream device " +
    "it hangs off, its active alerts, its most recent monitor status changes, and ipHistory — every address it " +
    "has held (primary, secondary, WAN) with first/last seen. Use to investigate a device.",
  parameters: {
    type: "object",
    properties: {
      id: { type: "string" },
      hostname: { type: "string" },
      ip: { type: "string" },
    },
  },
  async run(args, ctx) {
    if (!hasPermission(ctx.req, "assets", "read")) return denied("assets");
    const p = GetAssetArgs.safeParse(args ?? {});
    if (!p.success) return invalid(p.error);
    const a = p.data;
    const where = a.id ? { id: a.id }
      : a.hostname ? { hostname: { equals: a.hostname, mode: "insensitive" as const } }
      : { ipAddress: a.ip };
    const asset = await prisma.asset.findFirst({
      where,
      select: {
        ...ASSET_TOOL_SELECT,
        dnsName: true, description: true, assetTag: true, createdAt: true,
        lastMonitorAt: true, dependencySuppressed: true, maintenanceReturnStatus: true,
        discoveredByIntegration: { select: { name: true, type: true } },
        // Every address the device has held (primary, secondary, WAN) — the
        // Sources tab's IP History. A question about an address the device no
        // longer shows as its IP is answered from here.
        ipHistory: { select: { ip: true, source: true, firstSeen: true, lastSeen: true }, orderBy: { lastSeen: "desc" }, take: 30 },
      },
    });
    if (!asset) return { ok: true, data: { found: false } };
    const { discoveredByIntegration, ipHistory, ...rest } = asset;
    const out: Record<string, unknown> = {
      found: true,
      ...plain(rest),
      discoveredBy: discoveredByIntegration?.name ?? null,
      ipHistory: (ipHistory ?? []).map((h) => plain(h)),
    };

    const tasks: Promise<void>[] = [];
    if (hasPermission(ctx.req, "alerts", "read")) {
      tasks.push((async () => {
        const r = await listNotifications({
          viewerRegionTags: await viewerRegionTags(ctx.req),
          filters: { assetId: asset.id },
          limit: 10,
        });
        out.activeAlerts = (r.notifications as Array<Record<string, unknown>>).map((n) =>
          plain({ severity: n.severity, message: n.message, triggeredAt: n.triggeredAt, acknowledged: n.acknowledged }));
      })());
    }
    if (hasPermission(ctx.req, "events", "read")) {
      tasks.push((async () => {
        const r = await queryEventsPage({
          where: { assetId: asset.id, action: { startsWith: "monitor." } },
          orderBy: { timestamp: "desc" },
          skip: 0,
          take: 10,
        });
        out.recentMonitorEvents = (r.events as Array<Record<string, unknown>>).map((e) =>
          plain({ timestamp: e.timestamp, action: e.action, level: e.level, message: e.message }));
      })());
    }
    await Promise.all(tasks);
    return { ok: true, data: out };
  },
};

// ─── list_alerts ─────────────────────────────────────────────────────────────

/** Same scoping the Alerts page applies (routes/notifications.ts alertViewerRegionTags). */
async function viewerRegionTags(req: Request): Promise<string[]> {
  if (!req.session?.userId || callerIsAdminEquivalent(req)) return [];
  return getEffectiveRegionTags(req.session.userId);
}

const AlertArgs = z.object({
  ...WindowArgs,
  severity: z.array(z.string().max(20)).max(5).optional(),
  acknowledged: z.boolean().optional(),
  includeCleared: z.boolean().optional(),
  search: z.string().max(200).optional(),
  assetId: z.string().max(60).optional(),
  limit: z.number().int().positive().max(REPORT_ROW_CAP).optional(),
});

const listAlertsTool: ListToolDef = {
  name: "list_alerts",
  label: "checked alerts",
  description:
    "List alerts raised by automations. By default only open (not cleared) alerts; set includeCleared " +
    "with a time window to see history. Use a window (hours / since / until) to correlate what fired " +
    "around the same time.",
  parameters: {
    type: "object",
    properties: {
      ...windowSchemaProps,
      severity: { type: "array", items: { type: "string", enum: [...ALERT_SEVERITIES] }, description: "e.g. ['critical','serious']" },
      acknowledged: { type: "boolean" },
      includeCleared: { type: "boolean", description: "Include alerts that have since cleared" },
      search: { type: "string", description: "Matches the alert message or hostname" },
      assetId: { type: "string" },
      limit: { type: "number" },
    },
  },
  columns: [
    { key: "triggeredAt", label: "Triggered" }, { key: "severity", label: "Severity" }, { key: "assetHostname", label: "Device" },
    { key: "message", label: "Message" }, { key: "acknowledged", label: "Acknowledged" }, { key: "acknowledgedBy", label: "Acked by" },
    { key: "cleared", label: "Cleared" }, { key: "clearedAt", label: "Cleared at" },
  ],
  async rows(args, ctx, cap) {
    if (!hasPermission(ctx.req, "alerts", "read")) return denied("alerts");
    const p = AlertArgs.safeParse(args ?? {});
    if (!p.success) return invalid(p.error);
    const a = p.data;
    const w = timeWindow(a);
    // listNotifications caps a page at 500; walk pages for a report-sized cap.
    const want = Math.min(a.limit ?? cap, cap);
    const region = await viewerRegionTags(ctx.req);
    const rows: Array<Record<string, unknown>> = [];
    let total = 0;
    for (let offset = 0; rows.length < want; offset += 500) {
      const r = await listNotifications({
        viewerRegionTags: region,
        filters: {
          severity: a.severity, acknowledged: a.acknowledged, includeCleared: a.includeCleared,
          search: a.search, assetId: a.assetId, triggeredFrom: w.from, triggeredTo: w.to,
        },
        limit: Math.min(500, want - rows.length),
        offset,
      });
      total = r.total;
      for (const n of r.notifications as Array<Record<string, unknown>>) {
        rows.push(plain({
          id: n.id, triggeredAt: n.triggeredAt, severity: n.severity, assetHostname: n.assetHostname,
          assetId: n.assetId, message: n.message, acknowledged: n.acknowledged, acknowledgedBy: n.acknowledgedBy,
          cleared: n.cleared, clearedAt: n.clearedAt,
        }));
      }
      if ((r.notifications as unknown[]).length === 0 || offset + 500 >= r.total) break;
    }
    return { rows: rows.slice(0, want), total };
  },
  async run(args, ctx) {
    return listResult(await this.rows(args, ctx, ctx.maxRows));
  },
};

// ─── list_events ─────────────────────────────────────────────────────────────

const EventArgs = z.object({
  ...WindowArgs,
  level: z.enum(["info", "warning", "error"]).optional(),
  action: z.string().max(100).optional(),
  search: z.string().max(200).optional(),
  resourceType: z.string().max(60).optional(),
  assetId: z.string().max(60).optional(),
  limit: z.number().int().positive().max(REPORT_ROW_CAP).optional(),
});

const listEventsTool: ListToolDef = {
  name: "list_events",
  label: "read the event log",
  description:
    "Search the audit / event log: device status changes (action starts with 'monitor.'), discovery runs, " +
    "configuration changes, logins. Newest first. Use a time window to correlate.",
  parameters: {
    type: "object",
    properties: {
      ...windowSchemaProps,
      level: { type: "string", enum: ["info", "warning", "error"] },
      action: { type: "string", description: "Action prefix, e.g. 'monitor.' or 'integration.discovery'" },
      search: { type: "string", description: "Matches the event message or resource name" },
      resourceType: { type: "string", description: "e.g. asset, integration, subnet (= a network), user" },
      assetId: { type: "string" },
      limit: { type: "number" },
    },
  },
  columns: [
    { key: "timestamp", label: "Time" }, { key: "level", label: "Level" }, { key: "action", label: "Action" },
    { key: "resourceType", label: "Resource type" }, { key: "resourceName", label: "Resource" },
    { key: "actor", label: "Actor" }, { key: "message", label: "Message" },
  ],
  async rows(args, ctx, cap) {
    if (!hasPermission(ctx.req, "events", "read")) return denied("the event log");
    const p = EventArgs.safeParse(args ?? {});
    if (!p.success) return invalid(p.error);
    const a = p.data;
    const w = timeWindow(a);
    // Same floor as GET /events: nothing older than the retention cutoff.
    const { retentionDays } = await getRetentionSettings();
    const cutoff = new Date(Date.now() - retentionDays * 86_400_000);
    const ts: Record<string, Date> = { gte: w.from && w.from > cutoff ? w.from : cutoff };
    if (w.to) ts.lte = w.to;
    const where: Record<string, unknown> = { timestamp: ts };
    if (a.level) where.level = a.level;
    if (a.action) where.action = { startsWith: a.action };
    if (a.resourceType) where.resourceType = a.resourceType;
    if (a.assetId) where.assetId = a.assetId;
    if (a.search) {
      where.OR = [
        { message: { contains: a.search, mode: "insensitive" } },
        { resourceName: { contains: a.search, mode: "insensitive" } },
      ];
    }
    const take = Math.min(a.limit ?? cap, cap);
    const r = await queryEventsPage({ where, orderBy: { timestamp: "desc" }, skip: 0, take });
    const rows = (r.events as Array<Record<string, unknown>>).map((e) => plain({
      timestamp: e.timestamp, level: e.level, action: e.action, resourceType: e.resourceType,
      resourceName: e.resourceName, actor: e.actor, message: e.message,
    }));
    return { rows, total: r.total };
  },
  async run(args, ctx) {
    return listResult(await this.rows(args, ctx, ctx.maxRows));
  },
};

// ─── list_networks ────────────────────────────────────────────────────────────

const SubnetArgs = z.object({
  search: z.string().max(200).optional(),
  status: z.string().max(30).optional(),
  tag: z.string().max(100).optional(),
  vlan: z.number().int().min(1).max(4094).optional(),
  minUtilizationPercent: z.number().min(0).max(100).optional(),
  limit: z.number().int().positive().max(REPORT_ROW_CAP).optional(),
});

const listSubnetsTool: ListToolDef = {
  name: "list_networks",
  label: "looked up networks",
  description:
    "List networks (the IPAM → Networks tab) with their IP block, VLAN, status and address utilization (reserved addresses / " +
    "usable hosts). minUtilizationPercent finds networks that are filling up.",
  parameters: {
    type: "object",
    properties: {
      search: { type: "string", description: "Matches the network name, CIDR or purpose" },
      status: { type: "string", description: "available, reserved, deprecated. Deprecated (retired) networks are left out unless asked for here" },
      tag: { type: "string" },
      vlan: { type: "number" },
      minUtilizationPercent: { type: "number" },
      limit: { type: "number" },
    },
  },
  columns: [
    { key: "cidr", label: "CIDR" }, { key: "name", label: "Name" }, { key: "vlan", label: "VLAN" },
    { key: "status", label: "Status" }, { key: "block", label: "Block" }, { key: "reserved", label: "Reserved" },
    { key: "usableHosts", label: "Usable hosts" }, { key: "utilizationPercent", label: "Utilization %" },
    { key: "fortigateDevice", label: "FortiGate" }, { key: "tags", label: "Tags" },
  ],
  async rows(args, ctx, cap) {
    if (!hasPermission(ctx.req, "subnets", "read")) return denied("networks");
    const p = SubnetArgs.safeParse(args ?? {});
    if (!p.success) return invalid(p.error);
    const a = p.data;
    const where: Record<string, unknown> = {};
    // A deprecated (retired) network is left out unless asked for by status.
    where.status = a.status ? a.status : { not: "deprecated" };
    if (a.tag) where.tags = { has: a.tag };
    if (a.vlan) where.vlan = a.vlan;
    if (a.search) {
      where.OR = [
        { name: { contains: a.search, mode: "insensitive" } },
        { cidr: { contains: a.search } },
        { purpose: { contains: a.search, mode: "insensitive" } },
      ];
    }
    const take = Math.min(a.limit ?? cap, cap);
    // Utilization filtering happens after the count, so read the whole match
    // set only when that filter is asked for; otherwise page in SQL.
    const rows = await prisma.subnet.findMany({
      where,
      orderBy: { cidr: "asc" },
      ...(a.minUtilizationPercent == null ? { take } : {}),
      select: {
        cidr: true, name: true, vlan: true, status: true, tags: true, fortigateDevice: true,
        block: { select: { name: true } },
        // Business rule 69: count addresses actually held — active rows with an IP.
        _count: { select: { reservations: { where: { status: "active", ipAddress: { not: null } } } } },
      },
    });
    let out = rows.map((s) => {
      const usable = s.cidr.includes(":") ? null : usableHostCount(s.cidr);
      const reserved = s._count.reservations;
      return plain({
        cidr: s.cidr, name: s.name, vlan: s.vlan, status: s.status, block: s.block?.name ?? null,
        reserved, usableHosts: usable,
        utilizationPercent: usable ? Math.round((reserved / usable) * 1000) / 10 : null,
        fortigateDevice: s.fortigateDevice, tags: s.tags,
      });
    });
    if (a.minUtilizationPercent != null) {
      out = out.filter((r) => typeof r.utilizationPercent === "number" && (r.utilizationPercent as number) >= a.minUtilizationPercent!)
        .sort((x, y) => (y.utilizationPercent as number) - (x.utilizationPercent as number));
    }
    const total = a.minUtilizationPercent != null ? out.length : await prisma.subnet.count({ where });
    return { rows: out.slice(0, take), total };
  },
  async run(args, ctx) {
    return listResult(await this.rows(args, ctx, ctx.maxRows));
  },
};

// ─── list_reservations ───────────────────────────────────────────────────────

const ReservationArgs = z.object({
  cidr: z.string().max(60).optional(),
  search: z.string().max(200).optional(),
  status: z.string().max(30).optional(),
  owner: z.string().max(200).optional(),
  limit: z.number().int().positive().max(REPORT_ROW_CAP).optional(),
});

const listReservationsTool: ListToolDef = {
  name: "list_reservations",
  label: "looked up reservations",
  description: "List IP reservations, optionally inside one network (cidr) or matching an IP / hostname / owner.",
  parameters: {
    type: "object",
    properties: {
      cidr: { type: "string", description: "The network's CIDR, e.g. 10.1.20.0/24" },
      search: { type: "string", description: "Matches IP, hostname, owner or notes" },
      status: { type: "string", description: "active, released, expired" },
      owner: { type: "string" },
      limit: { type: "number" },
    },
  },
  columns: [
    { key: "ipAddress", label: "IP" }, { key: "hostname", label: "Hostname" }, { key: "owner", label: "Owner" },
    { key: "status", label: "Status" }, { key: "sourceType", label: "Source" }, { key: "network", label: "Network" },
    { key: "expiresAt", label: "Expires" }, { key: "createdAt", label: "Created" },
  ],
  async rows(args, ctx, cap) {
    if (!hasPermission(ctx.req, "reservations", "read")) return denied("reservations");
    const p = ReservationArgs.safeParse(args ?? {});
    if (!p.success) return invalid(p.error);
    const a = p.data;
    const where: Record<string, unknown> = {};
    if (a.cidr) where.subnet = { cidr: a.cidr };
    if (a.status) where.status = a.status;
    if (a.owner) where.owner = { contains: a.owner, mode: "insensitive" };
    if (a.search) {
      where.OR = ["ipAddress", "hostname", "owner", "notes"].map((f) => ({ [f]: { contains: a.search, mode: "insensitive" } }));
    }
    const take = Math.min(a.limit ?? cap, cap);
    // Deliberately NOT reservationService.listReservations: that include
    // carries the subnet's integration config (secrets) for the push UI.
    const [rows, total] = await Promise.all([
      prisma.reservation.findMany({
        where, take, orderBy: { createdAt: "desc" },
        select: {
          ipAddress: true, hostname: true, owner: true, status: true, sourceType: true,
          expiresAt: true, createdAt: true, subnet: { select: { cidr: true, name: true } },
        },
      }),
      prisma.reservation.count({ where }),
    ]);
    return {
      rows: rows.map(({ subnet, ...r }) => plain({ ...r, network: subnet ? `${subnet.name} (${subnet.cidr})` : null })),
      total,
    };
  },
  async run(args, ctx) {
    return listResult(await this.rows(args, ctx, ctx.maxRows));
  },
};

// ─── fleet_summary ───────────────────────────────────────────────────────────

const fleetSummaryTool: ToolDef = {
  name: "fleet_summary",
  label: "summarized the fleet",
  description:
    "Counts across the whole install: monitored devices by monitor status, assets by type and status, " +
    "open alerts by severity. Use for overview questions ('how is the network doing?').",
  parameters: { type: "object", properties: {} },
  async run(_args, ctx) {
    const out: Record<string, unknown> = {};
    const tasks: Promise<void>[] = [];
    if (hasPermission(ctx.req, "assets", "read")) {
      tasks.push((async () => {
        const [byMonitor, byType, byStatus] = await Promise.all([
          prisma.asset.groupBy({ by: ["monitorStatus"], where: { monitored: true }, _count: { _all: true } }),
          prisma.asset.groupBy({ by: ["assetType"], where: { status: { not: "decommissioned" } }, _count: { _all: true } }),
          // Decommissioned assets are left out of the overview (owner's call, 2026-10-09).
          prisma.asset.groupBy({ by: ["status"], where: { status: { not: "decommissioned" } }, _count: { _all: true } }),
        ]);
        out.monitoredByStatus = Object.fromEntries(byMonitor.map((r) => [r.monitorStatus ?? "unknown", r._count._all]));
        out.assetsByType = Object.fromEntries(byType.map((r) => [r.assetType, r._count._all]));
        out.assetsByStatus = Object.fromEntries(byStatus.map((r) => [r.status, r._count._all]));
      })());
    }
    if (hasPermission(ctx.req, "alerts", "read")) {
      tasks.push((async () => {
        const region = await viewerRegionTags(ctx.req);
        // One count per severity through listNotifications, so the region
        // scope is the Alerts page's own predicate rather than a re-derived one.
        const totals = await Promise.all(ALERT_SEVERITIES.map((sev) =>
          listNotifications({ viewerRegionTags: region, filters: { severity: [sev] }, limit: 1 }).then((r) => [sev, r.total] as const)));
        out.openAlertsBySeverity = Object.fromEntries(totals.filter(([, n]) => n > 0));
      })());
    }
    await Promise.all(tasks);
    if (Object.keys(out).length === 0) return denied("assets or alerts");
    return { ok: true, data: out };
  },
};

// ─── create_report ───────────────────────────────────────────────────────────

const LIST_TOOLS: ListToolDef[] = [listAssetsTool, listAlertsTool, listEventsTool, listSubnetsTool, listReservationsTool];
const LIST_BY_NAME = new Map(LIST_TOOLS.map((t) => [t.name, t]));

const ReportArgs = z.object({
  title: z.string().min(1).max(150),
  source: z.enum(["list_assets", "list_alerts", "list_events", "list_networks", "list_reservations"]),
  args: z.record(z.unknown()).optional(),
  columns: z.array(z.string().max(60)).max(30).optional(),
});

const createReportTool: ToolDef = {
  name: "create_report",
  label: "built a report",
  description:
    "Build a downloadable report (CSV / PDF / Markdown) for the user. Polaris runs the named list tool " +
    `itself with the given filter args (up to ${REPORT_ROW_CAP} rows) — never type report rows yourself. ` +
    "Optionally pick which columns to include. After calling it, briefly tell the user what the report holds.",
  parameters: {
    type: "object",
    properties: {
      title: { type: "string" },
      source: { type: "string", enum: LIST_TOOLS.map((t) => t.name) },
      args: { type: "object", description: "The same filter arguments the source tool accepts" },
      columns: {
        type: "array", items: { type: "string" },
        description: "Column keys to include. list_assets: hostname, ipAddress, assetType, status, monitorStatus, manufacturer, model, serialNumber, osVersion, location, tags, lastSeen, monitorStatusChangedAt",
      },
    },
    required: ["title", "source"],
  },
  async run(args, ctx) {
    const p = ReportArgs.safeParse(args ?? {});
    if (!p.success) return invalid(p.error);
    const tool = LIST_BY_NAME.get(p.data.source)!;
    const res = await tool.rows(p.data.args ?? {}, ctx, REPORT_ROW_CAP);
    if ("ok" in res) return res;
    let columns = tool.columns;
    if (p.data.columns?.length) {
      const wanted = new Set(p.data.columns);
      const picked = tool.columns.filter((c) => wanted.has(c.key));
      if (picked.length) columns = picked;
    }
    const report: AssistantReportPayload = {
      title: p.data.title,
      columns,
      rows: res.rows.map((r) => Object.fromEntries(columns.map((c) => [c.key, r[c.key] ?? null]))),
      rowCount: res.rows.length,
      truncated: res.total > res.rows.length,
    };
    ctx.onReport?.(report);
    return {
      ok: true,
      data: {
        created: true,
        title: report.title,
        rowCount: report.rowCount,
        totalMatching: res.total,
        truncated: report.truncated,
        columns: columns.map((c) => c.label),
        // The model never sees the rows — only this summary — so any table it
        // writes afterwards would be invented. The chat service strips tables
        // from text after a report regardless (stripMarkdownTables); this says why.
        note: "The user ALREADY SEES the full table with CSV / PDF / Markdown download buttons. " +
          "You have NOT seen its rows. Reply with ONE short sentence about what the report holds " +
          "(its title and row count). Do NOT write a table, list rows, or invent values.",
      },
    };
  },
};

function listResult(res: { rows: Array<Record<string, unknown>>; total: number } | ToolResult): ToolResult {
  if ("ok" in res) return res;
  return {
    ok: true,
    data: {
      total: res.total,
      returned: res.rows.length,
      truncated: res.total > res.rows.length,
      rows: res.rows,
    },
  };
}

// ─── Registry ────────────────────────────────────────────────────────────────

const TOOLS: ToolDef[] = [
  searchHelpTool, searchTool, fleetSummaryTool, listAssetsTool, getAssetTool,
  listAlertsTool, listEventsTool, listSubnetsTool, listReservationsTool, createReportTool,
];
const BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

/** The OpenAI-style tool definitions sent to the model. */
export function assistantToolDefs(): ChatToolDef[] {
  return TOOLS.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } }));
}

export function toolLabel(name: string): string {
  return BY_NAME.get(name)?.label ?? name;
}

/**
 * Run one tool call. Never throws: an unknown tool, bad JSON or a failing
 * query comes back as `{ ok: false, data: { error } }` so the model can
 * recover and the conversation keeps going.
 */
export async function runAssistantTool(name: string, rawArgs: string, ctx: ToolContext): Promise<ToolResult> {
  const tool = BY_NAME.get(name);
  if (!tool) return { ok: false, data: { error: `Unknown tool "${name}". Available: ${TOOLS.map((t) => t.name).join(", ")}` } };
  let args: unknown = {};
  if (rawArgs && rawArgs.trim()) {
    try { args = JSON.parse(rawArgs); } catch {
      return { ok: false, data: { error: "Tool arguments were not valid JSON" } };
    }
  }
  try {
    return await tool.run(args, ctx);
  } catch (err: any) {
    return { ok: false, data: { error: `Lookup failed: ${err?.message || "unknown error"}` } };
  }
}
