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
import { pickSampleTierForAsset, type SampleTier } from "./sampleQueryRouter.js";
import { resolveDependencyBlame, BLAME_MAX_HOPS } from "./dependencyTreeService.js";
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
  rows(args: unknown, ctx: ToolContext, cap: number): Promise<ListRows | ToolResult>;
}

interface ListRows {
  rows: Array<Record<string, unknown>>;
  total: number;
  /** Facts about the whole result the model should hear (not report columns). */
  extra?: Record<string, unknown>;
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
    "Search the Polaris operator documentation and the Polaris REST API reference. Use for ANY question about how " +
    "to use, configure or troubleshoot Polaris itself (pages, settings, integrations, permissions, automations, " +
    "monitoring, manufacturer profiles) and for questions about calling its API (endpoints, request bodies, " +
    "permissions, tokens). A hit with source \"api\" is from the API reference: quote its method and path exactly. " +
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
    "Global search across assets, networks, IP blocks, reservations, sites, and IPsec tunnels / VPN " +
    "connections by name, IP, MAC, hostname, tunnel name, peer id or VPN user. Good first step when the user " +
    "names a device, a tunnel, a VPN user or an address. For an address, each asset hit says why it matched: " +
    "matchedOn \"ipAddress\" (its current primary IP) or \"ipHistory\" with heldThisAddress (a WAN, secondary " +
    "or former address the device held, and when it was last seen there) — such a device IS a hit for that " +
    "address. An `ipsec` hit means the address or name is a tunnel's remote gateway, or a peer / user connected " +
    "through a FortiGate: context.assetId is that gate (link it), context.peerAssetId the far-end device when " +
    "Polaris knows it.",
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
      ipsec:        hasPermission(req, "assets", "read"),
      pins:         hasPermission(req, "serverSettingsSystem", "read"),
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

/** The asset filters list_assets and telemetry_summary share. */
const ASSET_FILTER_ARGS = {
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
};
const AssetFilterArgs = z.object(ASSET_FILTER_ARGS);

const AssetArgs = z.object({
  ...ASSET_FILTER_ARGS,
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

const ASSET_FILTER_PROPS = {
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
  model: { type: "string", description: "Model contains this text, e.g. \"61F\" for every FortiGate-61F" },
  os: { type: "string" },
  network: { type: "string", description: "A network CIDR, e.g. 10.20.0.0/16" },
  notSeenForHours: { type: "number", description: "Only assets not seen on the network for at least this many hours" },
} as const;

/**
 * The Prisma `where` for the shared asset filters, plus the CIDR to match in
 * memory (containment is not a Prisma predicate). A ToolResult when the
 * filters cannot be applied (no region assigned, a bad CIDR).
 */
async function assetFilterWhere(
  a: z.infer<typeof AssetFilterArgs>,
  req: Request,
): Promise<{ where: Record<string, unknown>; subnet?: string } | ToolResult> {
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
    const mine = req.session?.userId ? (await getEffectiveTagScopes(req.session.userId)).regions : [];
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
  return { where: and.length ? { AND: and } : {}, subnet };
}

/** Keep the rows whose IP is inside `subnet` (utils/cidr — the only place IP math may live). */
function inSubnet<T extends { ipAddress: string | null }>(rows: T[], subnet: string | undefined): T[] {
  if (!subnet) return rows;
  return rows.filter((r) => r.ipAddress && isValidIpAddress(r.ipAddress) && ipInCidr(r.ipAddress, subnet));
}

const listAssetsTool: ListToolDef = {
  name: "list_assets",
  label: "looked up assets",
  description:
    "List assets (devices) with filters. monitorStatus 'down' finds devices that are currently down. " +
    "assetType values include firewall, switch, access_point, server, workstation, printer, other. " +
    "network filters to assets whose IP is inside a network CIDR. Decommissioned assets are left out unless " +
    "status includes \"decommissioned\" — pass it only when the person asks about decommissioned assets. " +
    "Carries no CPU or memory figures — use telemetry_summary for those.",
  parameters: {
    type: "object",
    properties: {
      ...ASSET_FILTER_PROPS,
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
    const filter = await assetFilterWhere(a, ctx.req);
    if ("ok" in filter) return filter;
    const { where, subnet } = filter;
    const orderBy = a.sortBy ? { [a.sortBy]: a.sortBy === "hostname" || a.sortBy === "ipAddress" ? "asc" : "desc" } : { hostname: "asc" };
    const take = Math.min(a.limit ?? cap, cap);
    if (subnet) {
      // CIDR containment is not a Prisma predicate: narrow in SQL first, then
      // match in memory.
      const hits = inSubnet(await prisma.asset.findMany({ where, orderBy: orderBy as never, select: ASSET_TOOL_SELECT }), subnet);
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

// ─── telemetry_summary ───────────────────────────────────────────────────────
//
// CPU and memory over a window, one row per asset, aggregated in the database
// (rule 95(c): the model never averages a series itself, and a fleet's raw
// samples would never fit a small model's context anyway). The tier is the one
// the asset's CPU / memory chart would read for the same window
// (pickSampleTierForAsset "cpuMem"), so the figures agree with the charts:
// raw samples while detail retention covers the window, else the hourly or
// daily rollups with each bucket's average weighted by its sample count.
// Memory is memPct where the source reports a percentage (FortiOS), else
// used / total bytes — the same preference as the charts and the NOC widget.
//
// Scale: one asset findMany (tight select) + ONE grouped aggregate over
// `assetId = ANY(ids)` inside the window — flat from 100 to 2000 assets.

const TELEMETRY_DEFAULT_HOURS = 24;

const TelemetryArgs = z.object({
  ...ASSET_FILTER_ARGS,
  ...WindowArgs,
  metric: z.enum(["memory", "cpu"]).optional(),
  sortBy: z.enum(["avg", "max"]).optional(),
  order: z.enum(["highest", "lowest"]).optional(),
  limit: z.number().int().positive().max(REPORT_ROW_CAP).optional(),
});

interface TelemetryAgg {
  assetId: string;
  samples: number;
  avgCpu: number | null;
  maxCpu: number | null;
  avgMem: number | null;
  maxMem: number | null;
}

const MEM_PCT_DETAIL = `COALESCE("memPct", "memUsedBytes"::float / NULLIF("memTotalBytes", 0) * 100)`;

/** Per-asset CPU / memory aggregates for `ids` over [from, to). Exported for tests. */
export async function telemetryAggregates(ids: string[], from: Date, to: Date, tier: SampleTier): Promise<TelemetryAgg[]> {
  if (!ids.length) return [];
  if (tier === "detail") {
    return prisma.$queryRawUnsafe<TelemetryAgg[]>(
      `SELECT "assetId", count(*)::int AS samples,
              avg("cpuPct")::float AS "avgCpu", max("cpuPct")::float AS "maxCpu",
              avg(${MEM_PCT_DETAIL})::float AS "avgMem", max(${MEM_PCT_DETAIL})::float AS "maxMem"
         FROM "asset_telemetry_samples"
        WHERE "assetId" = ANY($1::text[]) AND "timestamp" >= $2 AND "timestamp" < $3
        GROUP BY "assetId"`,
      ids, from, to,
    );
  }
  const table = tier === "hourly" ? "asset_telemetry_samples_hourly" : "asset_telemetry_samples_daily";
  // A bucket's average counts as many times as it has samples; a bucket that
  // did not carry the metric adds nothing to either side of the division.
  return prisma.$queryRawUnsafe<TelemetryAgg[]>(
    `WITH b AS (
       SELECT "assetId", "sampleCount" AS n, "avgCpuPct" AS ac, "maxCpuPct" AS xc,
              COALESCE("avgMemPct", "avgMemUsedBytes"::float / NULLIF("lastMemTotalBytes", 0) * 100) AS am,
              COALESCE("maxMemPct", "maxMemUsedBytes"::float / NULLIF("lastMemTotalBytes", 0) * 100) AS xm
         FROM "${table}"
        WHERE "assetId" = ANY($1::text[]) AND "bucketStart" >= $2 AND "bucketStart" < $3
     )
     SELECT "assetId", sum(n)::int AS samples,
            (sum(ac * n) / NULLIF(sum(CASE WHEN ac IS NOT NULL THEN n END), 0))::float AS "avgCpu",
            max(xc)::float AS "maxCpu",
            (sum(am * n) / NULLIF(sum(CASE WHEN am IS NOT NULL THEN n END), 0))::float AS "avgMem",
            max(xm)::float AS "maxMem"
       FROM b GROUP BY "assetId"`,
    ids, from, to,
  );
}

const round1 = (v: number | null | undefined) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 10) / 10);

const telemetrySummaryTool: ListToolDef = {
  name: "telemetry_summary",
  label: "checked CPU and memory",
  description:
    "CPU and memory utilization (percent) per device over a time window: average and peak, computed by Polaris " +
    "from the stored samples. Use for \"highest / lowest / busiest / average CPU or memory\", \"which firewalls run " +
    "hot\", or a device's CPU / memory over a period. Takes the same device filters as list_assets (model \"61F\", " +
    `manufacturer, assetType, region…). metric picks what to rank by (memory or cpu); window defaults to the last ` +
    `${TELEMETRY_DEFAULT_HOURS} hours. Devices that report no CPU / memory in the window are counted in noData, ` +
    "not listed. For a downloadable table use create_report with source telemetry_summary.",
  parameters: {
    type: "object",
    properties: {
      ...ASSET_FILTER_PROPS,
      ...windowSchemaProps,
      metric: { type: "string", enum: ["memory", "cpu"], description: "What to rank by. Default memory" },
      sortBy: { type: "string", enum: ["avg", "max"], description: "Rank by the window's average (default) or its peak" },
      order: { type: "string", enum: ["highest", "lowest"], description: "Default highest" },
      limit: { type: "number" },
    },
  },
  columns: [
    { key: "hostname", label: "Hostname" }, { key: "ipAddress", label: "IP" }, { key: "model", label: "Model" },
    { key: "location", label: "Location" }, { key: "avgMemPct", label: "Avg memory %" }, { key: "maxMemPct", label: "Peak memory %" },
    { key: "avgCpuPct", label: "Avg CPU %" }, { key: "maxCpuPct", label: "Peak CPU %" }, { key: "samples", label: "Samples" },
    { key: "window", label: "Window" },
  ],
  async rows(args, ctx, cap) {
    if (!hasPermission(ctx.req, "assets", "read")) return denied("assets");
    const p = TelemetryArgs.safeParse(args ?? {});
    if (!p.success) return invalid(p.error);
    const a = p.data;
    const filter = await assetFilterWhere(a, ctx.req);
    if ("ok" in filter) return filter;
    const win = timeWindow(a);
    const to = win.to ?? new Date();
    const from = win.from ?? new Date(to.getTime() - TELEMETRY_DEFAULT_HOURS * 3_600_000);
    if (!(from < to)) return { ok: false, data: { error: "The window's start must be before its end" } };

    const assets = inSubnet(await prisma.asset.findMany({
      where: filter.where,
      select: { id: true, hostname: true, ipAddress: true, model: true, location: true },
    }), filter.subnet);
    const { tier } = await pickSampleTierForAsset("", "cpuMem", from);
    const aggs = await telemetryAggregates(assets.map((x) => x.id), from, to, tier);

    const metric = a.metric ?? "memory";
    const key = (a.sortBy ?? "avg") === "avg" ? (metric === "memory" ? "avgMem" : "avgCpu") : (metric === "memory" ? "maxMem" : "maxCpu");
    const dir = a.order === "lowest" ? 1 : -1;
    const byId = new Map(assets.map((x) => [x.id, x]));
    const window = `${from.toISOString()} – ${to.toISOString()}${tier === "detail" ? "" : ` (${tier} averages)`}`;
    const ranked = aggs
      .filter((g) => g[key] != null && byId.has(g.assetId))
      .sort((x, y) => dir * ((x[key] as number) - (y[key] as number)))
      .map((g) => {
        const asset = byId.get(g.assetId)!;
        return {
          id: asset.id, hostname: asset.hostname, ipAddress: asset.ipAddress, model: asset.model, location: asset.location,
          avgMemPct: round1(g.avgMem), maxMemPct: round1(g.maxMem), avgCpuPct: round1(g.avgCpu), maxCpuPct: round1(g.maxCpu),
          samples: g.samples, window,
        };
      });
    const take = Math.min(a.limit ?? cap, cap);
    return {
      rows: ranked.slice(0, take),
      total: ranked.length,
      extra: { window, matchedDevices: assets.length, noData: assets.length - ranked.length, rankedBy: `${a.sortBy ?? "avg"} ${metric}` },
    };
  },
  async run(args, ctx) {
    // The window rides once in `extra`, not on every row the model reads.
    const res = await this.rows(args, ctx, ctx.maxRows);
    if ("ok" in res) return res;
    return listResult({ ...res, rows: res.rows.map(({ window: _w, ...r }) => r) });
  },
};

// ─── get_dependencies ────────────────────────────────────────────────────────
//
// The dependency tree around ONE device: what it hangs off, hop by hop up to
// the top, and what hangs off it. Edges are AssetDependencyParent rows with the
// precedence the suppression walk uses (dependencyTreeService loadBlameLayer):
// a device's `override` parents REPLACE its computed / vcenter ones. When the
// device is down or suppressed, the root cause comes from resolveDependencyBlame
// itself, so the assistant names the same culprit the alert does.
//
// Scale: one edge read per hop up (bounded by BLAME_MAX_HOPS) and one per layer
// down (bounded by DEPENDENCY_DOWN_MAX nodes) — never a per-node await.

const DEPENDENCY_DOWN_MAX = 2000;

const DependencyArgs = z.object({
  id: z.string().max(60).optional(),
  hostname: z.string().max(255).optional(),
  ip: z.string().max(60).optional(),
}).refine((a) => a.id || a.hostname || a.ip, "Give id, hostname or ip");

const DEP_NODE_SELECT = {
  id: true, hostname: true, ipAddress: true, assetType: true, status: true,
  monitored: true, monitorStatus: true, dependencySuppressed: true,
} as const;

/** Effective parents per asset: overrides when it has any, else every other source. */
async function effectiveParents(ids: string[]): Promise<Map<string, Array<{ parentAssetId: string; detectedVia: string }>>> {
  const rows = await prisma.assetDependencyParent.findMany({
    where: { assetId: { in: ids } },
    select: { assetId: true, parentAssetId: true, source: true, detectedVia: true },
  });
  const overrides = new Map<string, Array<{ parentAssetId: string; detectedVia: string }>>();
  const others = new Map<string, Array<{ parentAssetId: string; detectedVia: string }>>();
  for (const r of rows) {
    const target = r.source === "override" ? overrides : others;
    const list = target.get(r.assetId) ?? [];
    if (!list.some((p) => p.parentAssetId === r.parentAssetId)) list.push({ parentAssetId: r.parentAssetId, detectedVia: r.detectedVia });
    target.set(r.assetId, list);
  }
  return new Map(ids.map((id) => [id, overrides.get(id) ?? others.get(id) ?? []]));
}

const getDependenciesTool: ToolDef = {
  name: "get_dependencies",
  label: "traced the dependency tree",
  description:
    "The dependency tree around ONE device (by id, exact hostname or IP): upstream — the device it hangs off, " +
    "then that device's parent, hop by hop to the top (how each link was learned: controller, interface, lldp, " +
    "manual, hypervisor) — and downstream — the devices that hang off it, with how many of them are down or " +
    "suppressed. When the device is down or suppressed, rootCause names the device whose outage explains it. " +
    "Use for \"what does X depend on\", \"what is behind X\", \"what goes down if X goes down\".",
  parameters: {
    type: "object",
    properties: { id: { type: "string" }, hostname: { type: "string" }, ip: { type: "string" } },
  },
  async run(args, ctx) {
    if (!hasPermission(ctx.req, "assets", "read")) return denied("assets");
    const p = DependencyArgs.safeParse(args ?? {});
    if (!p.success) return invalid(p.error);
    const a = p.data;
    const where = a.id ? { id: a.id }
      : a.hostname ? { hostname: { equals: a.hostname, mode: "insensitive" as const } }
      : { ipAddress: a.ip };
    const asset = await prisma.asset.findFirst({ where, select: DEP_NODE_SELECT });
    if (!asset) return { ok: true, data: { found: false } };

    // Upstream, layer by layer. A node seen before is not walked again (a
    // cycle in hand-made overrides must not loop).
    const upstream: Array<Record<string, unknown>> = [];
    const seen = new Set([asset.id]);
    let frontier = [asset.id];
    let upTruncated = false;
    for (let hop = 1; frontier.length > 0; hop++) {
      if (hop > BLAME_MAX_HOPS) { upTruncated = true; break; }
      const parents = await effectiveParents(frontier);
      const next: Array<{ child: string; parentAssetId: string; detectedVia: string }> = [];
      for (const [child, list] of parents) {
        for (const pr of list) if (!seen.has(pr.parentAssetId)) { seen.add(pr.parentAssetId); next.push({ child, ...pr }); }
      }
      if (!next.length) break;
      const nodes = await prisma.asset.findMany({ where: { id: { in: next.map((n) => n.parentAssetId) } }, select: DEP_NODE_SELECT });
      const byId = new Map(nodes.map((n) => [n.id, n]));
      for (const n of next) {
        const node = byId.get(n.parentAssetId);
        if (node) upstream.push({ hop, ...plain(node), parentOf: n.child, detectedVia: n.detectedVia });
      }
      frontier = next.map((n) => n.parentAssetId);
    }

    // Downstream: every device whose EFFECTIVE parents include a node already
    // reached. Candidate edges are read by parent, then each candidate's own
    // effective parents decide (an override elsewhere removes the edge).
    const down = new Set<string>();
    let layer = [asset.id];
    let downTruncated = false;
    const direct: string[] = [];
    while (layer.length > 0) {
      const cand = await prisma.assetDependencyParent.findMany({
        where: { parentAssetId: { in: layer } },
        select: { assetId: true },
      });
      const ids = Array.from(new Set(cand.map((c) => c.assetId))).filter((id) => id !== asset.id && !down.has(id));
      if (!ids.length) break;
      const eff = await effectiveParents(ids);
      const layerSet = new Set(layer);
      const nextLayer = ids.filter((id) => (eff.get(id) ?? []).some((pr) => layerSet.has(pr.parentAssetId)));
      if (layer.length === 1 && layer[0] === asset.id) direct.push(...nextLayer);
      for (const id of nextLayer) down.add(id);
      if (down.size >= DEPENDENCY_DOWN_MAX) { downTruncated = true; break; }
      layer = nextLayer;
    }
    const downIds = Array.from(down);
    const [downNodes, blame] = await Promise.all([
      downIds.length
        ? prisma.asset.findMany({ where: { id: { in: downIds } }, select: { id: true, monitorStatus: true, dependencySuppressed: true } })
        : Promise.resolve([] as Array<{ id: string; monitorStatus: string | null; dependencySuppressed: boolean | null }>),
      asset.monitorStatus === "down" || asset.dependencySuppressed ? resolveDependencyBlame(asset.id) : Promise.resolve(null),
    ]);
    const directCap = Math.min(ctx.maxRows, 50);
    const directNodes = direct.length
      ? await prisma.asset.findMany({ where: { id: { in: direct.slice(0, directCap) } }, select: DEP_NODE_SELECT, orderBy: { hostname: "asc" } })
      : [];
    return {
      ok: true,
      data: {
        found: true,
        device: plain(asset),
        upstream,
        upstreamTruncated: upTruncated,
        topOfTree: upstream.length === 0 ? "This device has no upstream device recorded." : undefined,
        downstream: {
          directChildren: directNodes.map(plain),
          directChildCount: direct.length,
          totalDevicesBehind: downIds.length,
          downBehind: downNodes.filter((n) => n.monitorStatus === "down" && !n.dependencySuppressed).length,
          suppressedBehind: downNodes.filter((n) => n.dependencySuppressed).length,
          truncated: downTruncated || direct.length > directCap,
        },
        rootCause: blame
          ? { device: blame.rootCause.hostname, id: blame.rootCause.id, reason: blame.rootCause.reason, hops: blame.hops, chain: blame.chain.map((c) => c.hostname) }
          : undefined,
      },
    };
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

const LIST_TOOLS: ListToolDef[] = [listAssetsTool, listAlertsTool, listEventsTool, listSubnetsTool, listReservationsTool, telemetrySummaryTool];
const LIST_BY_NAME = new Map(LIST_TOOLS.map((t) => [t.name, t]));

/** The list tools a report can be built from (create_report's `source`). */
export const REPORT_SOURCE_NAMES = ["list_assets", "list_alerts", "list_events", "list_networks", "list_reservations", "telemetry_summary"] as const;

const ReportArgs = z.object({
  title: z.string().min(1).max(150),
  source: z.enum(REPORT_SOURCE_NAMES),
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
        description: "Column keys to include. list_assets: hostname, ipAddress, assetType, status, monitorStatus, manufacturer, model, serialNumber, osVersion, location, tags, lastSeen, monitorStatusChangedAt. " +
          "telemetry_summary: hostname, ipAddress, model, location, avgMemPct, maxMemPct, avgCpuPct, maxCpuPct, samples, window",
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

function listResult(res: ListRows | ToolResult): ToolResult {
  if ("ok" in res) return res;
  return {
    ok: true,
    data: {
      ...res.extra,
      total: res.total,
      returned: res.rows.length,
      truncated: res.total > res.rows.length,
      rows: res.rows,
    },
  };
}

// ─── Manufacturer profiles ───────────────────────────────────────────────────
//
// The per-vendor SNMP mapping (which symbol is CPU, which table is the sensor
// table) and the MIBs behind it. Read-only, like everything here: the assistant
// can explain a profile, say why a row is unresolved and PROPOSE rows from the
// operator's own MIB, never save one. Readiness comes from the same service the
// profile page reads, so the two cannot disagree.

const ProfileArgs = z.object({
  manufacturer: z.string().min(1).max(200).optional(),
  id: z.string().min(1).max(64).optional(),
}).refine((a) => a.manufacturer || a.id, { message: "give manufacturer or id" });

/** One readiness side, cut to what an answer needs. */
function readinessBrief(r: { symbol: string; resolved: boolean; fromModuleName: string | null; fromScope: string | null; hint: unknown } | null | undefined) {
  if (!r) return null;
  if (r.resolved) return { symbol: r.symbol, resolved: true, module: r.fromModuleName, layer: r.fromScope };
  const h = r.hint as { kind?: string; mibModuleName?: string; roots?: Array<{ symbol: string; module: string | null }> } | null;
  return {
    symbol: r.symbol,
    resolved: false,
    why: h?.kind === "imports"
      ? `${h.mibModuleName} is uploaded but missing ${(h.roots ?? []).map((x) => x.module ?? x.symbol).join(", ")}`
      : "no uploaded MIB defines it",
  };
}

const listProfilesTool: ToolDef = {
  name: "list_manufacturer_profiles",
  label: "looked at the manufacturer profiles",
  description:
    "The manufacturer profiles on this install (the per-vendor SNMP telemetry mapping): each vendor's name, how many " +
    "metric rows, overrides and custom widgets it has, and its readiness — ready (every symbol resolves), partial, " +
    "or the symbols that do not resolve. Use before get_manufacturer_profile when you do not know the exact name.",
  parameters: { type: "object", properties: {} },
  async run(_args, ctx) {
    if (!hasPermission(ctx.req, "manufacturerProfiles", "read")) return denied("manufacturer profiles");
    const { listProfiles } = await import("./manufacturerProfileService.js");
    const rows = (await listProfiles()).slice(0, ctx.maxRows).map((p) => ({
      id: p.id, manufacturer: p.manufacturer,
      metricRows: p.metricCount, overrides: p.overrideCount, widgets: p.widgetCount, mibsUnderThisName: p.scopedMibCount,
      ready: p.ready, partial: p.partial, unresolvedSymbols: p.unresolvedSymbols,
    }));
    return { ok: true, data: { total: rows.length, rows } };
  },
};

const getProfileTool: ToolDef = {
  name: "get_manufacturer_profile",
  label: "looked at a manufacturer profile",
  description:
    "One manufacturer profile in full: its \"also applies when\" pattern; for each CONFIGURED metric row (model, cpu, " +
    "memory, temperature = Hardware Sensors, storage; interfaces / lldp / wirelessStations are descriptive) the " +
    "symbol(s), type, combiner / transform, aggregate, label, sensor-table columns, and whether each symbol resolves " +
    "and from which MIB (or why not); every device-type / per-model override; every custom widget and state probe. " +
    "Use to explain why a device's CPU, memory, sensors or storage are missing, or before proposing a change.",
  parameters: {
    type: "object",
    properties: {
      manufacturer: { type: "string", description: "The vendor name as Polaris shows it, e.g. Cisco" },
      id: { type: "string", description: "A profile id from list_manufacturer_profiles" },
    },
  },
  async run(args, ctx) {
    if (!hasPermission(ctx.req, "manufacturerProfiles", "read")) return denied("manufacturer profiles");
    const p = ProfileArgs.safeParse(args ?? {});
    if (!p.success) return invalid(p.error);
    const svc = await import("./manufacturerProfileService.js");
    let id = p.data.id;
    if (!id && p.data.manufacturer) {
      await svc.refreshProfileCacheIfStale();
      id = svc.getProfileFor(p.data.manufacturer)?.id;
    }
    const profile = id ? await svc.getProfile(id) : null;
    if (!profile) {
      return { ok: false, data: { error: `No manufacturer profile for "${p.data.manufacturer ?? p.data.id}". Call list_manufacturer_profiles for the names that exist.` } };
    }
    const brief = (r: { a: any; b: any; columns?: any[] } | null | undefined) =>
      r ? [readinessBrief(r.a), readinessBrief(r.b), ...(r.columns ?? []).map(readinessBrief)].filter(Boolean) : [];
    const configured = profile.metrics.filter((m) => m.defaultSymbol || m.defaultSymbolB || m.overrides.length);
    return {
      ok: true,
      data: {
        id: profile.id,
        manufacturer: profile.manufacturer,
        alsoAppliesWhen: profile.matchPattern,
        unconfiguredMetrics: profile.metrics.filter((m) => !configured.includes(m)).map((m) => m.metricKey),
        metrics: configured.map((m) => ({
          metric: m.metricKey,
          symbol: m.defaultSymbol, symbolB: m.defaultSymbolB, type: m.defaultType,
          transform: m.defaultTransform, aggregate: m.defaultAggregate, label: m.defaultLabel,
          parse: m.defaultParsePattern ? { pattern: m.defaultParsePattern, template: m.defaultParseTemplate } : null,
          sensorColumns: m.defaultSensorColumns,
          readiness: brief(m.readiness),
          overrides: m.overrides.map((o) => ({
            deviceType: o.assetType, modelPattern: o.modelPattern,
            symbol: o.symbol, symbolB: o.symbolB, type: o.type, transform: o.transform,
            aggregate: o.aggregate, label: o.label, sensorColumns: o.sensorColumns,
            readiness: brief(o.readiness),
          })),
        })),
        widgets: profile.widgets.map((w) => ({
          name: w.name, widgetType: w.widgetType, symbol: w.symbol, type: w.type, transform: w.transform,
          modelPattern: w.modelPattern, stateMap: w.stateMap, labelSymbol: w.labelSymbol,
          // The request a check makes, never the credential behind it.
          httpCheck: w.httpCheck, authenticated: w.widgetType === "http" ? !!w.credentialId : undefined,
        })),
      },
    };
  },
};

// ─── MIB Database ────────────────────────────────────────────────────────────

const MibListArgs = z.object({ manufacturer: z.string().min(1).max(200).optional() });

const listMibsTool: ToolDef = {
  name: "list_mibs",
  label: "looked at the MIB Database",
  description:
    "The SNMP MIB modules uploaded to this install: module name, the manufacturer (and model) it is uploaded under " +
    "— a vendor's symbols resolve only for that manufacturer — and the modules it IMPORTS. Polaris also bundles the " +
    "standard MIBs (SNMPv2-MIB, IF-MIB, HOST-RESOURCES-MIB, ENTITY-MIB, ENTITY-SENSOR-MIB, LLDP-MIB, " +
    "POWER-ETHERNET-MIB, BRIDGE-MIB, Q-BRIDGE-MIB, RSTP-MIB, IP-MIB), which are not listed here.",
  parameters: {
    type: "object",
    properties: { manufacturer: { type: "string", description: "Only the modules uploaded under this manufacturer" } },
  },
  async run(args, ctx) {
    if (!hasPermission(ctx.req, "mibDatabase", "read")) return denied("the MIB Database");
    const p = MibListArgs.safeParse(args ?? {});
    if (!p.success) return invalid(p.error);
    const { listMibs } = await import("./mibService.js");
    const all = await listMibs(p.data.manufacturer ? { manufacturer: p.data.manufacturer } : {});
    const rows = all.slice(0, ctx.maxRows).map((m) => plain({
      id: m.id, moduleName: m.moduleName, manufacturer: m.manufacturer ?? "(generic — every device)", model: m.model,
      imports: m.imports, sizeBytes: m.size, uploadedAt: m.uploadedAt,
    }));
    return { ok: true, data: { total: all.length, returned: rows.length, truncated: all.length > rows.length, rows } };
  },
};

const MibSymbolArgs = z.object({
  module: z.string().min(1).max(200),
  manufacturer: z.string().min(1).max(200).optional(),
  query: z.string().max(100).optional(),
  tablesOnly: z.boolean().optional(),
});
/** Symbols returned per call: enough to choose from, small enough for a local model. */
const MIB_SYMBOL_CAP = 40;

const searchMibSymbolsTool: ToolDef = {
  name: "search_mib_symbols",
  label: "read a MIB",
  description:
    "Read an uploaded MIB module: its objects matching a word (in the name or description), each with its OID, " +
    "SYNTAX, enum values, access, whether it is a table column, and a short description; or its tables and their " +
    "columns (tablesOnly). Use to find which object carries CPU, memory, a temperature, a battery or PSU status " +
    "before suggesting a manufacturer profile row or a widget — suggest only objects this returns, and name the " +
    "module. Also reports the modules the MIB imports that are not uploaded (what to upload next).",
  parameters: {
    type: "object",
    properties: {
      module: { type: "string", description: "Module name (e.g. PowerNet-MIB) or a module id from list_mibs" },
      manufacturer: { type: "string", description: "When the same module is uploaded under several manufacturers" },
      query: { type: "string", description: "A word to match, e.g. cpu, temperature, battery, status" },
      tablesOnly: { type: "boolean", description: "List the module's tables and their columns instead of objects" },
    },
    required: ["module"],
  },
  async run(args, ctx) {
    if (!hasPermission(ctx.req, "mibDatabase", "read")) return denied("the MIB Database");
    const p = MibSymbolArgs.safeParse(args ?? {});
    if (!p.success) return invalid(p.error);
    const { listMibs, getMib, parseMibStructured } = await import("./mibService.js");
    const { resolveSymbolsForMib, missingRootsForMib } = await import("./oidRegistry.js");
    const all = await listMibs(p.data.manufacturer ? { manufacturer: p.data.manufacturer } : {});
    const want = p.data.module.trim().toLowerCase();
    const matches = all.filter((m) => m.id === p.data.module || m.moduleName.toLowerCase() === want);
    if (matches.length === 0) {
      return { ok: false, data: { error: `No uploaded MIB "${p.data.module}". It may be a bundled standard MIB, or not uploaded — call list_mibs.` } };
    }
    if (matches.length > 1) {
      return { ok: false, data: { error: "That module is uploaded more than once. Pass manufacturer.", uploadedUnder: matches.map((m) => m.manufacturer ?? "(generic)") } };
    }
    const row = await getMib(matches[0].id);
    const parsed = parseMibStructured(row.contents);
    const oids = await resolveSymbolsForMib(row.id);
    const missingImports = [...new Set(missingRootsForMib(row.id).map((r) => r.module ?? r.symbol))];
    const base = { module: row.moduleName, manufacturer: row.manufacturer, missingImports };
    if (p.data.tablesOnly) {
      const tables = parsed.tables.slice(0, MIB_SYMBOL_CAP).map((t) => ({ table: t.name, row: t.rowSymbol, index: t.indexNames, columns: t.columns }));
      return { ok: true, data: { ...base, totalTables: parsed.tables.length, tables } };
    }
    const q = (p.data.query ?? "").trim().toLowerCase();
    const hits = parsed.symbols.filter((s) =>
      s.kind === "object-type" && (!q || s.name.toLowerCase().includes(q) || (s.description ?? "").toLowerCase().includes(q)));
    const symbols = hits.slice(0, MIB_SYMBOL_CAP).map((s) => ({
      name: s.name,
      oid: oids?.get(s.name) ?? null,
      syntax: s.syntax,
      enum: s.enumValues?.length ? s.enumValues.slice(0, 16).map((e) => `${e.label}(${e.value})`) : undefined,
      access: s.access,
      column: s.parentName && parsed.tables.some((t) => t.rowSymbol === s.parentName) ? `column of ${s.parentName}` : undefined,
      description: s.description ? (s.description.length > 240 ? s.description.slice(0, 240) + "…" : s.description) : null,
    }));
    return { ok: true, data: { ...base, matching: hits.length, returned: symbols.length, truncated: hits.length > symbols.length, symbols } };
  },
};

// ─── Automations ─────────────────────────────────────────────────────────────

/** One line saying what a trigger watches. */
function triggerSummary(t: any): string {
  if (!t || typeof t !== "object") return "unknown";
  switch (t.type) {
    case "asset_metric":
    case "host_metric":
      return `${t.type === "host_metric" ? "Polaris server " : ""}${t.metric} ${t.operator} ${t.threshold}` +
        (t.forPolls ? ` for ${t.forPolls} readings` : t.forDurationSec ? ` for ${t.forDurationSec}s` : "");
    case "asset_state":
      return `${t.field} ${t.operator} ${String(t.value)}` + (t.missedPolls ? ` (down after ${t.missedPolls} missed polls)` : "");
    case "event":
      return `event ${t.actionPattern}${t.minLevel ? ` at ${t.minLevel}+` : ""}`;
    case "change":
      return `change: ${t.changeType}`;
    case "composite":
      return `${t.op.toUpperCase()} of ${Array.isArray(t.children) ? t.children.length : 0} conditions`;
    default:
      return String(t.type);
  }
}

const listAutomationsTool: ToolDef = {
  name: "list_automations",
  label: "looked at the automations",
  description:
    "The automations (alert rules) on this install: name, enabled, severity, a one-line summary of what triggers " +
    "it, which device-filter keys its scope uses, and its action types. Use to answer which rule alerts on " +
    "something, or before get_automation.",
  parameters: {
    type: "object",
    properties: { search: { type: "string", description: "Only rules whose name contains this" } },
  },
  async run(args, ctx) {
    if (!hasPermission(ctx.req, "automationManagement", "read")) return denied("automations");
    const p = z.object({ search: z.string().max(200).optional() }).safeParse(args ?? {});
    if (!p.success) return invalid(p.error);
    const { listRules } = await import("./notificationRuleService.js");
    const s = (p.data.search ?? "").trim().toLowerCase();
    const rules = (await listRules()).filter((r: any) => !s || String(r.name).toLowerCase().includes(s));
    const rows = rules.slice(0, ctx.maxRows).map((r: any) => ({
      id: r.id, name: r.name, enabled: r.enabled, severity: r.severity,
      trigger: triggerSummary(r.trigger),
      scopeFilters: r.scope && typeof r.scope === "object" ? Object.keys(r.scope).filter((k) => (r.scope as any)[k] != null) : [],
      actions: Array.isArray(r.actions) ? [...new Set(r.actions.map((a: any) => a?.type).filter(Boolean))] : [],
    }));
    return { ok: true, data: { total: rules.length, returned: rows.length, truncated: rules.length > rows.length, rows } };
  },
};

/** The JSON a rule may cost the model before its longest optional parts are dropped. */
const AUTOMATION_JSON_CAP = 12_000;

const getAutomationTool: ToolDef = {
  name: "get_automation",
  label: "looked at an automation",
  description:
    "One automation in full (the stored rule: trigger, scope, actions, escalation, repeat, reset, quiet time, " +
    "severity bands), for explaining exactly what it does or why it did or did not fire. Secrets in API-call " +
    "actions are masked.",
  parameters: {
    type: "object",
    properties: {
      id: { type: "string", description: "An automation id from list_automations" },
      name: { type: "string", description: "Or its exact name" },
    },
  },
  async run(args, ctx) {
    if (!hasPermission(ctx.req, "automationManagement", "read")) return denied("automations");
    const p = z.object({ id: z.string().max(64).optional(), name: z.string().max(200).optional() })
      .refine((a) => a.id || a.name, { message: "give id or name" })
      .safeParse(args ?? {});
    if (!p.success) return invalid(p.error);
    const { listRules } = await import("./notificationRuleService.js");
    const { maskActionHeaders } = await import("../utils/actionHeaderMask.js");
    const want = (p.data.name ?? "").trim().toLowerCase();
    const rule = (await listRules()).find((r: any) => (p.data.id && r.id === p.data.id) || (want && String(r.name).toLowerCase() === want));
    if (!rule) return { ok: false, data: { error: "No such automation. Call list_automations for the names that exist." } };
    // api_call headers are secrets (rule 114(h)): masked exactly as every API response masks them.
    // The structure is kept as stored (`plain` would flatten its arrays); only the
    // dates become ISO strings. `alertGroup` is the group it delivers through.
    const masked = maskActionHeaders(rule) as Record<string, unknown>;
    const iso = (d: unknown) => (d instanceof Date ? d.toISOString() : d);
    let out: Record<string, unknown> = { ...masked, createdAt: iso(masked.createdAt), updatedAt: iso(masked.updatedAt) };
    if (JSON.stringify(out).length > AUTOMATION_JSON_CAP) {
      const { emailComposition: _e, messageTemplate: _m, ...smaller } = out;
      out = { ...smaller, note: "emailComposition and messageTemplate were left out to keep this short." };
    }
    return { ok: true, data: out };
  },
};

// ─── Registry ────────────────────────────────────────────────────────────────

const TOOLS: ToolDef[] = [
  searchHelpTool, searchTool, fleetSummaryTool, listAssetsTool, telemetrySummaryTool, getAssetTool, getDependenciesTool,
  listAlertsTool, listEventsTool, listSubnetsTool, listReservationsTool, createReportTool,
  listProfilesTool, getProfileTool, listMibsTool, searchMibSymbolsTool, listAutomationsTool, getAutomationTool,
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
