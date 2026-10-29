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
import { lookupOui } from "./ouiService.js";
import { POLARIS_SERVER_SUBJECT, POLARIS_SERVER_LABEL } from "./pathCheckIngestService.js";
import { macColonUpperOrNull } from "../utils/mac.js";
import { usableHostCount, isValidCidr, ipInCidr, isValidIpAddress } from "../utils/cidr.js";
import { deviceUptime } from "../utils/uptime.js";
import type { ChatToolDef } from "./llmService.js";
import { ASSET_SECTIONS, ASSET_SECTION_HELP, readAssetSections } from "./assetDetailReadService.js";

export const REPORT_ROW_CAP = 5000;

/** Alert severities, lowest to highest (utils/alertSeverity.ts ranks them). */
const ALERT_SEVERITIES = ["notice", "informational", "warning", "serious", "critical"] as const;

export interface ReportColumn { key: string; label: string }

/** The downloads a report card offers. */
export const REPORT_FORMATS = ["csv", "pdf", "md"] as const;
export type ReportFormat = (typeof REPORT_FORMATS)[number];

export interface AssistantReportPayload {
  title: string;
  columns: ReportColumn[];
  rows: Array<Record<string, unknown>>;
  rowCount: number;
  truncated: boolean;
  /** The downloads to offer — only the ones the user asked for. Absent or empty = all three. */
  formats?: ReportFormat[];
}

export interface ToolContext {
  req: Request;
  /** Row cap for an ordinary lookup (the integration's maxRowsPerTool). */
  maxRows: number;
  /** Called when create_report produces a table for the client. */
  onReport?: (report: AssistantReportPayload) => void;
  /**
   * The download formats the user's own message named ("a PDF of…"). They win
   * over create_report's `formats` argument, which a small model often omits.
   */
  reportFormats?: ReportFormat[];
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
  // The General tab's lifecycle dates, as ISO dates ("2022-01-01").
  acquiredBefore: z.string().max(40).optional(),
  acquiredAfter: z.string().max(40).optional(),
  warrantyExpiresBefore: z.string().max(40).optional(),
  warrantyExpiresAfter: z.string().max(40).optional(),
};
const AssetFilterArgs = z.object(ASSET_FILTER_ARGS);

const AssetArgs = z.object({
  ...ASSET_FILTER_ARGS,
  sortBy: z.enum(["hostname", "lastSeen", "monitorStatusChangedAt", "ipAddress", "acquiredAt", "warrantyExpiry", "uptime"]).optional(),
  order: z.enum(["asc", "desc"]).optional(),
  limit: z.number().int().positive().max(REPORT_ROW_CAP).optional(),
});

const ASSET_TOOL_SELECT = {
  id: true, hostname: true, ipAddress: true, macAddress: true, assetType: true, status: true,
  manufacturer: true, model: true, serialNumber: true, os: true, osVersion: true,
  location: true, learnedLocation: true, tags: true, monitored: true, monitorStatus: true,
  monitorStatusChangedAt: true, lastSeen: true, lastResponseTimeMs: true, assignedTo: true, department: true,
  // The General tab's lifecycle rows — without them "acquired before 2022" or
  // "oldest switches" had nothing to read. createdAt is the Acquired row's
  // fallback (withAcquired).
  acquiredAt: true, warrantyExpiry: true, purchaseOrder: true, createdAt: true,
  // The System tab's Uptime row (withUptime). Without them the assistant told
  // a user Polaris collects no FortiGate uptime (seen live 2026-10-28).
  lastUptimeSec: true, lastMonitorAt: true, lastRebootAt: true,
} as const;

/**
 * Uptime as the System tab shows it (deviceUptime): carried forward from the
 * last probe's reading, with upSince the detected reboot or implied boot.
 * The raw reading is dropped: on its own it is the uptime at lastMonitorAt,
 * which the model would report as current. Exported for tests.
 */
export function withUptime<T extends { lastUptimeSec?: number | null; lastMonitorAt?: Date | null; lastRebootAt?: Date | null; monitorStatus?: string | null }>(
  row: T,
): Omit<T, "lastUptimeSec" | "lastRebootAt"> & { uptimeSec: number | null; uptime: string | null; upSince: Date | null } {
  const { lastUptimeSec: _u, lastRebootAt: _r, ...rest } = row;
  const up = deviceUptime(row);
  return { ...rest, uptimeSec: up?.uptimeSec ?? null, uptime: up?.uptime ?? null, upSince: up?.upSince ?? null };
}

/**
 * The Acquired date as the asset's General tab shows it: the date entered on
 * the asset, else the day Polaris first saw it. Reading the column alone,
 * the assistant called a device with "Acquired Jan 22, 2025" on screen
 * undated and told the user to go and save the date (seen live 2026-10-27).
 * Exported for tests.
 */
export function withAcquired<T extends { acquiredAt?: Date | null; createdAt?: Date | null }>(row: T): T & { acquiredFrom: string | null } {
  const acquiredAt = row.acquiredAt ?? row.createdAt ?? null;
  return { ...row, acquiredAt, acquiredFrom: row.acquiredAt ? "entered" : acquiredAt ? "first seen by Polaris" : null };
}

/** The Prisma predicate for "Acquired (as shown) <op> d": the entered date, else first seen. */
function acquiredBound(op: "lt" | "gte", d: Date): Record<string, unknown> {
  return { OR: [{ acquiredAt: { [op]: d } }, { acquiredAt: null, createdAt: { [op]: d } }] };
}

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
  acquiredBefore: { type: "string", description: "Acquired (purchase) date before this ISO date, e.g. \"2022-01-01\"" },
  acquiredAfter: { type: "string", description: "Acquired (purchase) date on or after this ISO date" },
  warrantyExpiresBefore: { type: "string", description: "Warranty expires before this ISO date — use for \"warranty expired\" / \"expiring soon\"" },
  warrantyExpiresAfter: { type: "string", description: "Warranty expires on or after this ISO date" },
} as const;

/**
 * The device filters the measurement tools ADVERTISE — the ones a question
 * about figures names. Their Zod schemas still accept every list_assets
 * filter; the schema sent to the model is kept short because every tool
 * definition rides in every round of a small local model's window.
 */
const DEVICE_FILTER_PROPS = {
  search: { type: "string", description: "Hostname, IP or name contains" },
  assetType: ASSET_FILTER_PROPS.assetType,
  region: { type: "array", items: { type: "string" }, description: "Region names" },
  myRegions: { type: "boolean", description: "The asker's own regions" },
  location: { type: "string" },
  manufacturer: { type: "string" },
  model: { type: "string", description: "Model contains, e.g. \"61F\"" },
  os: { type: "string" },
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
  const dateBounds: Array<[string | undefined, "acquiredAt" | "warrantyExpiry", "lt" | "gte"]> = [
    [a.acquiredBefore, "acquiredAt", "lt"], [a.acquiredAfter, "acquiredAt", "gte"],
    [a.warrantyExpiresBefore, "warrantyExpiry", "lt"], [a.warrantyExpiresAfter, "warrantyExpiry", "gte"],
  ];
  for (const [value, field, op] of dateBounds) {
    if (!value) continue;
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return { ok: false, data: { error: `"${value}" is not a date — use an ISO date like 2022-01-01` } };
    and.push(field === "acquiredAt" ? acquiredBound(op, d) : { [field]: { [op]: d } });
  }
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
    "Each row carries acquiredAt (the Acquired date the asset page shows — acquiredFrom says whether it was " +
    "entered or is the day Polaris first saw the device, which the page shows when none was entered), " +
    "warrantyExpiry and purchaseOrder; filter on them with " +
    "acquiredBefore / acquiredAfter / warrantyExpiresBefore / warrantyExpiresAfter and sort with sortBy " +
    "acquiredAt or warrantyExpiry (order asc = oldest / soonest first). " +
    "Rows carry uptime / upSince as the asset page shows them (null where no probe reports uptime); " +
    "sortBy uptime ranks longest-up first (order asc = most recently rebooted). " +
    "Carries no CPU or memory figures — use telemetry_summary for those.",
  parameters: {
    type: "object",
    properties: {
      ...ASSET_FILTER_PROPS,
      sortBy: { type: "string", enum: ["hostname", "lastSeen", "monitorStatusChangedAt", "ipAddress", "acquiredAt", "warrantyExpiry", "uptime"] },
      order: { type: "string", enum: ["asc", "desc"], description: "Sort direction; dates default to newest first" },
      limit: { type: "number" },
    },
  },
  columns: [
    { key: "hostname", label: "Hostname" }, { key: "ipAddress", label: "IP" }, { key: "assetType", label: "Type" },
    { key: "status", label: "Status" }, { key: "monitorStatus", label: "Monitor" }, { key: "manufacturer", label: "Manufacturer" },
    { key: "model", label: "Model" }, { key: "serialNumber", label: "Serial" }, { key: "osVersion", label: "OS version" },
    { key: "location", label: "Location" }, { key: "tags", label: "Tags" }, { key: "lastSeen", label: "Last seen" },
    { key: "monitorStatusChangedAt", label: "Status changed" }, { key: "acquiredAt", label: "Acquired" },
    { key: "acquiredFrom", label: "Acquired from" },
    { key: "warrantyExpiry", label: "Warranty expires" }, { key: "purchaseOrder", label: "Purchase order" },
    { key: "uptime", label: "Uptime" }, { key: "upSince", label: "Up since" },
  ],
  async rows(args, ctx, cap) {
    if (!hasPermission(ctx.req, "assets", "read")) return denied("assets");
    const p = AssetArgs.safeParse(args ?? {});
    if (!p.success) return invalid(p.error);
    const a = p.data;
    const filter = await assetFilterWhere(a, ctx.req);
    if ("ok" in filter) return filter;
    const { where, subnet } = filter;
    const dir = a.order ?? (a.sortBy === "hostname" || a.sortBy === "ipAddress" ? "asc" : "desc");
    // Most assets carry no warranty date: those sort last either way.
    const byAcquired = a.sortBy === "acquiredAt";
    const byUptime = a.sortBy === "uptime";
    const orderBy = !a.sortBy || byAcquired || byUptime ? { hostname: "asc" }
      : a.sortBy === "warrantyExpiry" ? { warrantyExpiry: { sort: dir, nulls: "last" } }
      : { [a.sortBy]: dir };
    const take = Math.min(a.limit ?? cap, cap);
    type Row = Parameters<typeof withAcquired>[0] & Parameters<typeof withUptime>[0];
    const shown = (r: Row) => withUptime(withAcquired(r));
    if (subnet || byAcquired || byUptime) {
      // CIDR containment is not a Prisma predicate, and neither is the
      // Acquired date the page shows (entered, else first seen) or the uptime
      // it carries forward from the last probe: narrow in SQL first, then
      // match and order in memory.
      let hits = inSubnet(await prisma.asset.findMany({ where, orderBy: orderBy as never, select: ASSET_TOOL_SELECT }), subnet).map(shown);
      if (byAcquired || byUptime) {
        // Rows with no value sort last either way.
        const t = (r: (typeof hits)[number]) => byUptime ? r.uptimeSec : r.acquiredAt?.getTime() ?? null;
        hits = hits.sort((x, y) => {
          const tx = t(x), ty = t(y);
          if (tx === ty) return 0;
          if (tx === null) return 1;
          if (ty === null) return -1;
          return dir === "asc" ? tx - ty : ty - tx;
        });
      }
      return { rows: hits.slice(0, take).map(plain), total: hits.length };
    }
    const [rows, total] = await Promise.all([
      prisma.asset.findMany({ where, orderBy: orderBy as never, take, select: ASSET_TOOL_SELECT }),
      prisma.asset.count({ where }),
    ]);
    return { rows: rows.map((r) => plain(shown(r))), total };
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
      ...DEVICE_FILTER_PROPS,
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

// ─── list_services ───────────────────────────────────────────────────────────
//
// The systemd units / Windows services the Polaris Agent reports (AssetService,
// current state, agent-only). The two platforms speak different vocabularies,
// so the model asks in plain words — running / stopped / failed, automatic /
// manual / disabled — and they are mapped here. `problems` is the question an
// operator actually asks: a systemd unit in `failed`, or a Windows service set
// to start automatically that is not running. An enabled-but-inactive systemd
// unit is NOT a problem (timer- and socket-started units sit there normally).
//
// Scale: one asset findMany (id + names) and one service findMany / count
// filtered in SQL, capped — never a per-device read.

const SERVICE_STATES = ["running", "stopped", "failed"] as const;
const SERVICE_STARTUPS = ["automatic", "manual", "disabled"] as const;
const ACTIVE_FOR: Record<(typeof SERVICE_STATES)[number], string[]> = {
  running: ["active", "running"],
  stopped: ["inactive", "stopped"],
  failed: ["failed"],
};
const WIN_AUTO = ["auto", "auto-delayed", "boot", "system"];
const ENABLED_FOR: Record<(typeof SERVICE_STARTUPS)[number], string[]> = {
  automatic: ["enabled", ...WIN_AUTO],
  manual: ["manual", "static"],
  disabled: ["disabled", "masked"],
};

const ServiceArgs = z.object({
  ...ASSET_FILTER_ARGS,
  service: z.string().max(200).optional(),
  state: oneOrMany(z.enum(SERVICE_STATES)),
  startup: oneOrMany(z.enum(SERVICE_STARTUPS)),
  problems: z.boolean().optional(),
  watchedOnly: z.boolean().optional(),
  limit: z.number().int().positive().max(REPORT_ROW_CAP).optional(),
});

const listServicesTool: ListToolDef = {
  name: "list_services",
  label: "checked services",
  description:
    "Services on servers and workstations running the Polaris Agent (systemd units on Linux, Windows services): " +
    "state (running / stopped / failed), startup type (automatic / manual / disabled), CPU and memory. Takes the " +
    "same device filters as list_assets. service matches the unit / service name or display name (\"sql\", " +
    "\"nginx\"). problems: true finds what should be running but is not — a failed systemd unit, or a Windows " +
    "service set to start automatically that is stopped. watchedOnly: the services pinned for monitoring on " +
    "each device. Devices without the agent report no services.",
  parameters: {
    type: "object",
    properties: {
      ...DEVICE_FILTER_PROPS,
      service: { type: "string", description: "Service / unit name or display name contains this text" },
      state: { type: "array", items: { type: "string", enum: [...SERVICE_STATES] } },
      startup: { type: "array", items: { type: "string", enum: [...SERVICE_STARTUPS] } },
      problems: { type: "boolean", description: "Only services that should be running but are not" },
      watchedOnly: { type: "boolean", description: "Only services pinned for monitoring on their device" },
      limit: { type: "number" },
    },
  },
  columns: [
    { key: "hostname", label: "Hostname" }, { key: "ipAddress", label: "IP" }, { key: "service", label: "Service" },
    { key: "displayName", label: "Display name" }, { key: "platform", label: "Platform" }, { key: "state", label: "State" },
    { key: "startup", label: "Startup" }, { key: "cpuPct", label: "CPU %" }, { key: "memMB", label: "Memory MB" },
    { key: "watched", label: "Watched" }, { key: "updatedAt", label: "Reported" },
  ],
  async rows(args, ctx, cap) {
    if (!hasPermission(ctx.req, "assets", "read")) return denied("assets");
    const p = ServiceArgs.safeParse(args ?? {});
    if (!p.success) return invalid(p.error);
    const a = p.data;
    const filter = await assetFilterWhere(a, ctx.req);
    if ("ok" in filter) return filter;
    const assets = inSubnet(await prisma.asset.findMany({
      where: filter.where,
      select: { id: true, hostname: true, ipAddress: true, monitoredServices: true },
    }), filter.subnet);
    if (!assets.length) return { rows: [], total: 0, extra: { matchedDevices: 0 } };

    const and: Record<string, unknown>[] = [{ assetId: { in: assets.map((x) => x.id) } }];
    if (a.service) {
      and.push({ OR: [
        { unit: { contains: a.service, mode: "insensitive" } },
        { displayName: { contains: a.service, mode: "insensitive" } },
      ] });
    }
    if (a.state) and.push({ activeState: { in: a.state.flatMap((s) => ACTIVE_FOR[s]), mode: "insensitive" } });
    if (a.startup) and.push({ enabledState: { in: a.startup.flatMap((s) => ENABLED_FOR[s]), mode: "insensitive" } });
    if (a.problems) {
      and.push({ OR: [
        { activeState: { equals: "failed", mode: "insensitive" } },
        { platform: "windows", enabledState: { in: WIN_AUTO, mode: "insensitive" }, NOT: { activeState: { equals: "running", mode: "insensitive" } } },
      ] });
    }
    if (a.watchedOnly) {
      // Pins are per device; OR of (device, its pinned units), devices with none dropped.
      const pinned = assets.filter((x) => x.monitoredServices.length);
      if (!pinned.length) return { rows: [], total: 0, extra: { matchedDevices: assets.length, note: "No matching device has a watched service." } };
      and.push({ OR: pinned.map((x) => ({ assetId: x.id, unit: { in: x.monitoredServices } })) });
    }
    const where = { AND: and };
    const take = Math.min(a.limit ?? cap, cap);
    const [rows, total, devicesWithServices] = await Promise.all([
      prisma.assetService.findMany({
        where, take, orderBy: [{ assetId: "asc" }, { unit: "asc" }],
        select: { assetId: true, unit: true, displayName: true, platform: true, activeState: true, subState: true, enabledState: true, cpuPct: true, memBytes: true, updatedAt: true },
      }),
      prisma.assetService.count({ where }),
      prisma.assetService.groupBy({ by: ["assetId"], where: { assetId: { in: assets.map((x) => x.id) } } }).then((g) => g.length),
    ]);
    const byId = new Map(assets.map((x) => [x.id, x]));
    return {
      rows: rows.map((s) => {
        const dev = byId.get(s.assetId);
        const state = [s.activeState, s.subState && s.subState !== s.activeState ? s.subState : null].filter(Boolean).join(" / ");
        return plain({
          id: s.assetId, hostname: dev?.hostname ?? null, ipAddress: dev?.ipAddress ?? null,
          service: s.unit, displayName: s.displayName, platform: s.platform, state: state || null, startup: s.enabledState || null,
          cpuPct: round1(s.cpuPct), memMB: s.memBytes == null ? null : Math.round(Number(s.memBytes) / 1_048_576),
          watched: Boolean(dev?.monitoredServices.includes(s.unit)), updatedAt: s.updatedAt,
        });
      }),
      total,
      extra: { matchedDevices: assets.length, devicesReportingServices: devicesWithServices },
    };
  },
  async run(args, ctx) {
    return listResult(await this.rows(args, ctx, ctx.maxRows));
  },
};

// ─── find_endpoint ───────────────────────────────────────────────────────────
//
// Where an endpoint is on the network, from what the infrastructure learned:
// gateways' ARP tables (IP ↔ MAC, which interface), switches' MAC tables
// (which port, which VLAN) and APs' wireless clients (which AP, SSID, band,
// signal). A lookup, never a dump: it needs a MAC, an IP, or a device plus a
// port or VLAN. A MAC is learned on every switch's UPLINK as well as on its
// real access port, so each MAC-table hit carries how many MACs that port
// holds and hits are ordered fewest-first — the access port leads.
//
// Scale: each table read is one indexed query (macAddress / apAssetId /
// assetId) or one filtered scan for an IP, plus one groupBy for the port
// counts — independent of fleet size.

const ENDPOINT_ROW_CAP = 50;

const EndpointArgs = z.object({
  mac: z.string().max(40).optional(),
  ip: z.string().max(60).optional(),
  device: z.string().max(255).optional(),
  port: z.string().max(100).optional(),
  vlan: z.number().int().min(0).max(4095).optional(),
}).refine((a) => a.mac || a.ip || (a.device && (a.port || a.vlan !== undefined)),
  "Give a mac, an ip, or a device with a port or vlan");

const HIT_ASSET_SELECT = { id: true, hostname: true, ipAddress: true, assetType: true } as const;

/** A full MAC → equals; 3–5 octets → prefix (an OUI search). Null when unusable. */
function macPredicate(raw: string): { equals: string } | { startsWith: string } | null {
  const full = macColonUpperOrNull(raw);
  if (full) return { equals: full };
  const hex = raw.toUpperCase().replace(/[^0-9A-F]/g, "");
  if (hex.length >= 6 && hex.length < 12 && hex.length % 2 === 0) return { startsWith: hex.match(/.{2}/g)!.join(":") };
  return null;
}

const findEndpointTool: ToolDef = {
  name: "find_endpoint",
  label: "traced an endpoint",
  description:
    "Find where a client or device is on the network from what switches, gateways and access points learned: " +
    "the switch port and VLAN it is on (MAC tables — the hit with the fewest MACs on its port is the access " +
    "port; ports holding many MACs are uplinks), the IP / MAC pairing and the gateway interface (ARP tables), " +
    "and the access point, SSID, band and signal for a wireless client. Give mac (full, or the first 3–5 octets " +
    "for a vendor prefix) or ip. Or give device (a switch's hostname or IP) with port and / or vlan to see " +
    "what is connected there. lastSeen says how fresh each sighting is. Use when someone asks where a device " +
    "or address is plugged in, which AP a laptop is on, or what is on a switch port.",
  parameters: {
    type: "object",
    properties: {
      mac: { type: "string", description: "MAC in any format, or a 3–5 octet prefix" },
      ip: { type: "string", description: "IPv4 address" },
      device: { type: "string", description: "Hostname or IP of the switch / AP / gateway to look inside (with port or vlan)" },
      port: { type: "string", description: "Port / interface name contains this, e.g. \"port12\" or \"1/0/12\"" },
      vlan: { type: "number" },
    },
  },
  async run(args, ctx) {
    if (!hasPermission(ctx.req, "assets", "read")) return denied("assets");
    const p = EndpointArgs.safeParse(args ?? {});
    if (!p.success) return invalid(p.error);
    const a = p.data;
    const cap = Math.min(ctx.maxRows, ENDPOINT_ROW_CAP);

    let macWhere: { equals: string } | { startsWith: string } | null = null;
    if (a.mac) {
      macWhere = macPredicate(a.mac);
      if (!macWhere) return { ok: false, data: { error: `"${a.mac}" is not a MAC address or a prefix of at least 3 octets` } };
    }
    if (a.ip && !isValidIpAddress(a.ip)) return { ok: false, data: { error: `"${a.ip}" is not a valid IP address` } };

    let inside: { id: string; hostname: string | null } | null = null;
    if (a.device) {
      inside = await prisma.asset.findFirst({
        where: { OR: [{ hostname: { equals: a.device, mode: "insensitive" } }, { ipAddress: a.device }, { id: a.device }] },
        select: { id: true, hostname: true },
      });
      if (!inside) return { ok: true, data: { found: false, note: `No device named "${a.device}"` } };
    }

    // ARP: by MAC, by IP, or a device's own table narrowed by port.
    const arpWhere: Record<string, unknown>[] = [];
    if (macWhere) arpWhere.push({ macAddress: macWhere });
    if (a.ip) arpWhere.push({ ipAddress: a.ip });
    if (inside) arpWhere.push({ assetId: inside.id, ...(a.port ? { ifName: { contains: a.port, mode: "insensitive" } } : {}) });
    // MAC tables: by MAC (and the MACs the ARP tables pair with the IP), or a device's port / VLAN.
    // A device + VLAN alone is a MAC-table question; its whole ARP table is not wanted.
    const wantArp = Boolean(macWhere || a.ip || (inside && a.port));
    const [arp, wirelessByIp] = await Promise.all([
      !wantArp ? Promise.resolve([] as never[]) : prisma.assetArpEntry.findMany({
        where: { AND: arpWhere },
        orderBy: { lastSeen: "desc" },
        take: cap,
        select: { ipAddress: true, macAddress: true, ifName: true, lastSeen: true, asset: { select: HIT_ASSET_SELECT }, matchedAsset: { select: HIT_ASSET_SELECT } },
      }),
      a.ip && !a.mac
        ? prisma.assetWirelessStation.findMany({ where: { staIpAddr: a.ip }, select: { staMacAddr: true }, take: 5 })
        : Promise.resolve([] as Array<{ staMacAddr: string }>),
    ]);
    const macsForIp = a.ip && !a.mac
      ? Array.from(new Set([...arp.map((r) => r.macAddress), ...wirelessByIp.map((w) => w.staMacAddr)]))
      : [];
    const macFilter = macWhere ?? (macsForIp.length ? { in: macsForIp } : null);

    const macTableWhere: Record<string, unknown>[] = [];
    if (macFilter) macTableWhere.push({ macAddress: macFilter });
    if (inside) {
      macTableWhere.push({ assetId: inside.id });
      if (a.port) macTableWhere.push({ ifName: { contains: a.port, mode: "insensitive" } });
      if (a.vlan !== undefined) macTableWhere.push({ vlanId: a.vlan });
    }
    const wantMacTable = macFilter != null || inside != null;
    const wantWireless = macFilter != null || inside != null;
    const [macHits, wireless] = await Promise.all([
      wantMacTable
        ? prisma.assetMacTableEntry.findMany({
          where: { AND: macTableWhere },
          orderBy: { lastSeen: "desc" },
          take: cap * 4,
          select: { assetId: true, macAddress: true, vlanId: true, ifName: true, status: true, lastSeen: true, asset: { select: HIT_ASSET_SELECT }, matchedAsset: { select: HIT_ASSET_SELECT } },
        })
        : Promise.resolve([]),
      wantWireless
        ? prisma.assetWirelessStation.findMany({
          where: {
            AND: [
              ...(macFilter ? [{ staMacAddr: macFilter }] : []),
              ...(inside ? [{ apAssetId: inside.id }] : []),
              ...(inside && a.vlan !== undefined ? [{ vlanId: a.vlan }] : []),
            ],
          },
          orderBy: { lastSeen: "desc" },
          take: cap,
          select: {
            staMacAddr: true, staIpAddr: true, ssid: true, band: true, vlanId: true, signalStrength: true, lastSeen: true,
            apAsset: { select: HIT_ASSET_SELECT }, matchedAsset: { select: HIT_ASSET_SELECT },
          },
        })
        : Promise.resolve([]),
    ]);

    // How many MACs each hit's port holds — the access port is the quiet one.
    const portKeys = Array.from(new Set(macHits.filter((h) => h.ifName).map((h) => `${h.assetId}\u0000${h.ifName}`)));
    const portCounts = new Map<string, number>();
    if (portKeys.length) {
      const groups = await prisma.assetMacTableEntry.groupBy({
        by: ["assetId", "ifName"],
        where: { OR: portKeys.map((k) => { const [assetId, ifName] = k.split("\u0000"); return { assetId, ifName }; }) },
        _count: { _all: true },
      });
      for (const g of groups) portCounts.set(`${g.assetId}\u0000${g.ifName}`, g._count._all);
    }
    const macRows = macHits
      .map((h) => ({ h, macsOnPort: h.ifName ? portCounts.get(`${h.assetId}\u0000${h.ifName}`) ?? null : null }))
      .sort((x, y) => (x.macsOnPort ?? Infinity) - (y.macsOnPort ?? Infinity) || y.h.lastSeen.getTime() - x.h.lastSeen.getTime())
      .slice(0, cap)
      .map(({ h, macsOnPort }) => plain({
        mac: h.macAddress, switch: h.asset?.hostname ?? null, switchId: h.assetId, port: h.ifName, vlan: h.vlanId,
        macsOnPort, likelyAccessPort: macsOnPort != null && macsOnPort <= 3, status: h.status, lastSeen: h.lastSeen,
        knownAs: h.matchedAsset?.hostname ?? null, knownAsId: h.matchedAsset?.id ?? null,
      }));

    const anyMac = macFilter && "equals" in macFilter ? macFilter.equals : macsForIp[0];
    const vendor = anyMac ? await lookupOui(anyMac).catch(() => null) : null;
    return {
      ok: true,
      data: {
        query: { mac: a.mac, ip: a.ip, device: inside?.hostname ?? undefined, port: a.port, vlan: a.vlan },
        vendor: vendor ?? undefined,
        switchPorts: macRows,
        arp: arp.map((r) => plain({
          ip: r.ipAddress, mac: r.macAddress, seenBy: r.asset?.hostname ?? null, seenById: r.asset?.id ?? null,
          interface: r.ifName || null, lastSeen: r.lastSeen, knownAs: r.matchedAsset?.hostname ?? null, knownAsId: r.matchedAsset?.id ?? null,
        })),
        wireless: wireless.map((w) => plain({
          mac: w.staMacAddr, ip: w.staIpAddr, accessPoint: w.apAsset?.hostname ?? null, accessPointId: w.apAsset?.id ?? null,
          ssid: w.ssid, band: w.band, vlan: w.vlanId, signalDbm: w.signalStrength, lastSeen: w.lastSeen,
          knownAs: w.matchedAsset?.hostname ?? null, knownAsId: w.matchedAsset?.id ?? null,
        })),
        note: macRows.length + arp.length + wireless.length === 0
          ? "No switch, gateway or access point has learned this endpoint. It may be offline, behind a device Polaris does not collect tables from, or outside the retention window."
          : undefined,
      },
    };
  },
};

// ─── path_check_summary ──────────────────────────────────────────────────────
//
// Path Monitor results: one row per check × source (an agent host, or the
// Polaris server itself) over a window — availability, average and peak
// latency — plus the source row's live facts (last result, last error, last
// failure). Gated on `pathChecks` read, like every Path Monitor route. The
// aggregates are SQL on the tier the check's chart reads for the same window
// (pickSampleTierForAsset "pathCheck"); server-run samples are keyed by
// POLARIS_SERVER_SUBJECT, not by an asset.
//
// Scale: one check findMany, one source findMany, one grouped aggregate over
// (assetId, checkId) = ANY(...) inside the window.

const PATH_DEFAULT_HOURS = 24;

const PathArgs = z.object({
  ...WindowArgs,
  check: z.string().max(200).optional(),
  source: z.string().max(255).optional(),
  failingOnly: z.boolean().optional(),
  sortBy: z.enum(["availability", "latency"]).optional(),
  limit: z.number().int().positive().max(REPORT_ROW_CAP).optional(),
});

interface PathAgg {
  assetId: string;
  checkId: string;
  samples: number;
  okCount: number;
  avgLatency: number | null;
  maxLatency: number | null;
}

/** Per (source, check) availability and latency over [from, to). Exported for tests. */
export async function pathCheckAggregates(subjects: string[], checkIds: string[], from: Date, to: Date, tier: SampleTier): Promise<PathAgg[]> {
  if (!subjects.length || !checkIds.length) return [];
  if (tier === "detail") {
    return prisma.$queryRawUnsafe<PathAgg[]>(
      `SELECT "assetId", "checkId", count(*)::int AS samples, count(*) FILTER (WHERE ok)::int AS "okCount",
              avg("latencyMs")::float AS "avgLatency", max("latencyMs")::float AS "maxLatency"
         FROM "asset_path_check_samples"
        WHERE "checkId" = ANY($1::text[]) AND "assetId" = ANY($2::text[]) AND "timestamp" >= $3 AND "timestamp" < $4
        GROUP BY "assetId", "checkId"`,
      checkIds, subjects, from, to,
    );
  }
  const table = tier === "hourly" ? "asset_path_check_samples_hourly" : "asset_path_check_samples_daily";
  // Latency is averaged over the SUCCESSFUL samples a bucket carries (a failed
  // run has no latency), so it weights by okCount, not sampleCount.
  return prisma.$queryRawUnsafe<PathAgg[]>(
    `SELECT "assetId", "checkId", sum("sampleCount")::int AS samples, sum("okCount")::int AS "okCount",
            (sum("avgLatencyMs" * "okCount") / NULLIF(sum(CASE WHEN "avgLatencyMs" IS NOT NULL THEN "okCount" END), 0))::float AS "avgLatency",
            max("maxLatencyMs")::float AS "maxLatency"
       FROM "${table}"
      WHERE "checkId" = ANY($1::text[]) AND "assetId" = ANY($2::text[]) AND "bucketStart" >= $3 AND "bucketStart" < $4
      GROUP BY "assetId", "checkId"`,
    checkIds, subjects, from, to,
  );
}

const pathCheckSummaryTool: ListToolDef = {
  name: "path_check_summary",
  label: "checked Path Monitor",
  description:
    "Path Monitor results (HTTP / HTTPS / TCP / ICMP checks run from agent hosts and from the Polaris server): " +
    "for each check and each place it runs from, availability % and average / peak latency over a window, the " +
    "last result and error, and when it last failed. check matches the check name or target (\"m365\", " +
    "\"erp.example.com\"); source matches the hostname it runs from (\"server\" for the Polaris server). " +
    "failingOnly: only check/source pairs whose latest result failed. Worst availability first, or sortBy " +
    `latency. The window defaults to the last ${PATH_DEFAULT_HOURS} hours.`,
  parameters: {
    type: "object",
    properties: {
      ...windowSchemaProps,
      check: { type: "string", description: "Check name or target contains this text" },
      source: { type: "string", description: "Hostname the check runs from contains this; \"server\" for the Polaris server" },
      failingOnly: { type: "boolean" },
      sortBy: { type: "string", enum: ["availability", "latency"] },
      limit: { type: "number" },
    },
  },
  columns: [
    { key: "check", label: "Check" }, { key: "kind", label: "Kind" }, { key: "target", label: "Target" },
    { key: "source", label: "Runs from" }, { key: "availabilityPct", label: "Availability %" },
    { key: "avgLatencyMs", label: "Avg latency ms" }, { key: "maxLatencyMs", label: "Peak latency ms" },
    { key: "samples", label: "Runs" }, { key: "lastOk", label: "Last OK" }, { key: "lastError", label: "Last error" },
    { key: "lastFailAt", label: "Last failed" }, { key: "lastSampleAt", label: "Last run" }, { key: "window", label: "Window" },
  ],
  async rows(args, ctx, cap) {
    if (!hasPermission(ctx.req, "pathChecks", "read")) return denied("Path Monitor");
    const p = PathArgs.safeParse(args ?? {});
    if (!p.success) return invalid(p.error);
    const a = p.data;
    const win = timeWindow(a);
    const to = win.to ?? new Date();
    const from = win.from ?? new Date(to.getTime() - PATH_DEFAULT_HOURS * 3_600_000);
    if (!(from < to)) return { ok: false, data: { error: "The window's start must be before its end" } };

    const checks = await prisma.pathCheck.findMany({
      where: a.check
        ? { OR: [{ name: { contains: a.check, mode: "insensitive" } }, { target: { contains: a.check, mode: "insensitive" } }] }
        : {},
      select: { id: true, name: true, kind: true, target: true, enabled: true },
    });
    if (!checks.length) return { rows: [], total: 0, extra: { matchedChecks: 0 } };

    const serverSource = a.source != null && /\b(server|polaris)\b/i.test(a.source);
    const sourceWhere: Record<string, unknown> = { checkId: { in: checks.map((c) => c.id) } };
    if (a.source && !serverSource) sourceWhere.asset = { hostname: { contains: a.source, mode: "insensitive" } };
    if (serverSource) sourceWhere.assetId = null;
    if (a.failingOnly) sourceWhere.lastOk = false;
    const sources = await prisma.pathCheckSource.findMany({
      where: sourceWhere,
      select: {
        checkId: true, assetId: true, lastOk: true, lastError: true, lastSampleAt: true, lastFailAt: true, lastLatencyMs: true,
        asset: { select: { hostname: true } },
      },
    });

    const { tier } = await pickSampleTierForAsset(POLARIS_SERVER_SUBJECT, "pathCheck", from);
    const subjects = Array.from(new Set(sources.map((s) => s.assetId ?? POLARIS_SERVER_SUBJECT)));
    const aggs = await pathCheckAggregates(subjects, Array.from(new Set(sources.map((s) => s.checkId))), from, to, tier);
    const aggBy = new Map(aggs.map((g) => [`${g.assetId}\u0000${g.checkId}`, g]));
    const checkBy = new Map(checks.map((c) => [c.id, c]));
    const window = `${from.toISOString()} – ${to.toISOString()}${tier === "detail" ? "" : ` (${tier} averages)`}`;

    const rows = sources.map((s) => {
      const c = checkBy.get(s.checkId)!;
      const g = aggBy.get(`${s.assetId ?? POLARIS_SERVER_SUBJECT}\u0000${s.checkId}`);
      return {
        checkId: c.id, check: c.name, kind: c.kind, target: c.target, enabled: c.enabled,
        source: s.assetId ? s.asset?.hostname ?? null : POLARIS_SERVER_LABEL, assetId: s.assetId ?? undefined,
        samples: g?.samples ?? 0,
        availabilityPct: g && g.samples ? round1((g.okCount / g.samples) * 100) : null,
        avgLatencyMs: round1(g?.avgLatency), maxLatencyMs: round1(g?.maxLatency),
        lastOk: s.lastOk, lastError: s.lastError, lastFailAt: s.lastFailAt, lastSampleAt: s.lastSampleAt, window,
      };
    });
    const byLatency = a.sortBy === "latency";
    rows.sort((x, y) => byLatency
      ? (y.avgLatencyMs ?? -1) - (x.avgLatencyMs ?? -1)
      : (x.availabilityPct ?? 101) - (y.availabilityPct ?? 101) || (y.avgLatencyMs ?? -1) - (x.avgLatencyMs ?? -1));
    const take = Math.min(a.limit ?? cap, cap);
    return {
      rows: rows.slice(0, take).map(plain),
      total: rows.length,
      extra: { window, matchedChecks: checks.length, failingNow: sources.filter((s) => s.lastOk === false).length },
    };
  },
  async run(args, ctx) {
    const res = await this.rows(args, ctx, ctx.maxRows);
    if ("ok" in res) return res;
    return listResult({ ...res, rows: res.rows.map(({ window: _w, ...r }) => r) });
  },
};

// ─── interface_summary ───────────────────────────────────────────────────────
//
// Interfaces / ports on the devices the list_assets filters match. Current
// state for EVERY interface comes from AssetInterface (status, speed, VLAN,
// PoE). Traffic, utilization and error counts over a window exist only for the
// interfaces selected for monitoring (Asset.monitoredInterfaces) — since the
// pinned-only cutover no other interface writes samples — so an unpinned row
// says `history: false` rather than reading as idle.
//
// Rates are counter deltas computed in SQL on the tier the interface chart
// reads (pickSampleTierForAsset "interfaces"), with the chart's reset rule: a
// negative delta is a counter reset and is skipped, never counted as traffic
// (sampleHistoryService rate()). Average = bytes moved / seconds covered;
// peak = the fastest single interval (detail) or bucket (rollup).
// "down" means operationally down while administratively up — a port someone
// shut on purpose is "disabled", not a fault.
//
// Scale: asset findMany + interface count / findMany (refused past
// INTERFACE_SCAN_MAX until narrowed) + ONE grouped aggregate over the pinned
// set's (assetId, ifName) = ANY(...) inside the window.

const IFACE_DEFAULT_HOURS = 24;
const INTERFACE_SCAN_MAX = 20_000;

const IFACE_STATES = ["up", "down", "disabled"] as const;
const IFACE_SORTS = ["utilization", "peak", "traffic", "errors", "name"] as const;

const InterfaceArgs = z.object({
  ...ASSET_FILTER_ARGS,
  ...WindowArgs,
  interface: z.string().max(200).optional(),
  state: oneOrMany(z.enum(IFACE_STATES)),
  poe: z.enum(["fault", "delivering"]).optional(),
  withErrors: z.boolean().optional(),
  monitoredOnly: z.boolean().optional(),
  sortBy: z.enum(IFACE_SORTS).optional(),
  limit: z.number().int().positive().max(REPORT_ROW_CAP).optional(),
});

interface IfaceAgg {
  assetId: string;
  ifName: string;
  avgIn: number | null;
  avgOut: number | null;
  peakIn: number | null;
  peakOut: number | null;
  inErrors: number | null;
  outErrors: number | null;
}

/**
 * Per (asset, interface) byte rates and error counts over [from, to) for the
 * interfaces named. Rates are bytes / second. Exported for tests.
 */
export async function interfaceAggregates(assetIds: string[], ifNames: string[], from: Date, to: Date, tier: SampleTier): Promise<IfaceAgg[]> {
  if (!assetIds.length || !ifNames.length) return [];
  const agg = `SELECT "assetId", "ifName",
                 (sum(di) / NULLIF(sum(dt) FILTER (WHERE di IS NOT NULL), 0))::float AS "avgIn",
                 (sum(dout) / NULLIF(sum(dt) FILTER (WHERE dout IS NOT NULL), 0))::float AS "avgOut",
                 max(di / dt)::float AS "peakIn", max(dout / dt)::float AS "peakOut",
                 sum(die)::float AS "inErrors", sum(doe)::float AS "outErrors"
            FROM d WHERE dt > 0 GROUP BY "assetId", "ifName"`;
  if (tier === "detail") {
    return prisma.$queryRawUnsafe<IfaceAgg[]>(
      `WITH s AS (
         SELECT "assetId", "ifName", "timestamp" AS t, "inOctets" AS i, "outOctets" AS o, "inErrors" AS ie, "outErrors" AS oe,
                lag("timestamp") OVER w AS pt, lag("inOctets") OVER w AS pi, lag("outOctets") OVER w AS po,
                lag("inErrors") OVER w AS pie, lag("outErrors") OVER w AS poe
           FROM "asset_interface_samples"
          WHERE "assetId" = ANY($1::text[]) AND "ifName" = ANY($2::text[]) AND "timestamp" >= $3 AND "timestamp" < $4
          WINDOW w AS (PARTITION BY "assetId", "ifName" ORDER BY "timestamp")
       ), d AS (
         SELECT "assetId", "ifName", extract(epoch FROM t - pt)::float AS dt,
                CASE WHEN i >= pi THEN (i - pi)::float END AS di, CASE WHEN o >= po THEN (o - po)::float END AS dout,
                CASE WHEN ie >= pie THEN (ie - pie)::float END AS die, CASE WHEN oe >= poe THEN (oe - poe)::float END AS doe
           FROM s WHERE pt IS NOT NULL
       ) ${agg}`,
      assetIds, ifNames, from, to,
    );
  }
  const table = tier === "hourly" ? "asset_interface_samples_hourly" : "asset_interface_samples_daily";
  return prisma.$queryRawUnsafe<IfaceAgg[]>(
    `WITH d AS (
       SELECT "assetId", "ifName", extract(epoch FROM "lastBucketSampleAt" - "bucketStart")::float AS dt,
              CASE WHEN "lastInOctets" >= "firstInOctets" THEN ("lastInOctets" - "firstInOctets")::float END AS di,
              CASE WHEN "lastOutOctets" >= "firstOutOctets" THEN ("lastOutOctets" - "firstOutOctets")::float END AS dout,
              CASE WHEN "lastInErrors" >= "firstInErrors" THEN ("lastInErrors" - "firstInErrors")::float END AS die,
              CASE WHEN "lastOutErrors" >= "firstOutErrors" THEN ("lastOutErrors" - "firstOutErrors")::float END AS doe
         FROM "${table}"
        WHERE "assetId" = ANY($1::text[]) AND "ifName" = ANY($2::text[]) AND "bucketStart" >= $3 AND "bucketStart" < $4
     ) ${agg}`,
    assetIds, ifNames, from, to,
  );
}

const mbps = (bytesPerSec: number | null | undefined) => (bytesPerSec == null ? null : Math.round((bytesPerSec * 8) / 10_000) / 100);
const utilPct = (bytesPerSec: number | null | undefined, speedBps: number | null) =>
  bytesPerSec == null || !speedBps ? null : round1(((bytesPerSec * 8) / speedBps) * 100);

const interfaceSummaryTool: ListToolDef = {
  name: "interface_summary",
  label: "checked interfaces",
  description:
    "Interfaces and switch ports on the devices the list_assets filters match: status, speed, VLAN, PoE, and — for " +
    "interfaces selected for monitoring — average and peak traffic (Mbps), utilization % of link speed and error " +
    "counts over a window (default the last 24 hours). Rows without history (history: false) are interfaces not " +
    "selected for monitoring: current state only. interface matches the name, alias or description (\"wan\", " +
    "\"port12\"). state: up, down (link down although enabled), disabled (shut by an operator). poe: fault or " +
    "delivering. withErrors: only interfaces that logged errors in the window. sortBy utilization (default), " +
    "peak, traffic, errors or name. Use for busiest links, WAN utilization, ports down, ports with errors, PoE faults.",
  parameters: {
    type: "object",
    properties: {
      ...DEVICE_FILTER_PROPS,
      ...windowSchemaProps,
      interface: { type: "string", description: "Interface name, alias or description contains this text" },
      state: { type: "array", items: { type: "string", enum: [...IFACE_STATES] } },
      poe: { type: "string", enum: ["fault", "delivering"] },
      withErrors: { type: "boolean" },
      monitoredOnly: { type: "boolean", description: "Only interfaces selected for monitoring (the ones with traffic history)" },
      sortBy: { type: "string", enum: [...IFACE_SORTS] },
      limit: { type: "number" },
    },
  },
  columns: [
    { key: "hostname", label: "Device" }, { key: "interface", label: "Interface" }, { key: "description", label: "Description" },
    { key: "state", label: "State" }, { key: "speedMbps", label: "Speed Mbps" }, { key: "vlan", label: "VLAN" },
    { key: "poe", label: "PoE" }, { key: "avgInMbps", label: "Avg in Mbps" }, { key: "avgOutMbps", label: "Avg out Mbps" },
    { key: "peakInMbps", label: "Peak in Mbps" }, { key: "peakOutMbps", label: "Peak out Mbps" },
    { key: "avgUtilPct", label: "Avg util %" }, { key: "peakUtilPct", label: "Peak util %" },
    { key: "inErrors", label: "In errors" }, { key: "outErrors", label: "Out errors" }, { key: "history", label: "History" },
    { key: "window", label: "Window" },
  ],
  async rows(args, ctx, cap) {
    if (!hasPermission(ctx.req, "assets", "read")) return denied("assets");
    const p = InterfaceArgs.safeParse(args ?? {});
    if (!p.success) return invalid(p.error);
    const a = p.data;
    const filter = await assetFilterWhere(a, ctx.req);
    if ("ok" in filter) return filter;
    const win = timeWindow(a);
    const to = win.to ?? new Date();
    const from = win.from ?? new Date(to.getTime() - IFACE_DEFAULT_HOURS * 3_600_000);
    if (!(from < to)) return { ok: false, data: { error: "The window's start must be before its end" } };

    const assets = inSubnet(await prisma.asset.findMany({
      where: filter.where,
      select: { id: true, hostname: true, ipAddress: true, monitoredInterfaces: true },
    }), filter.subnet);
    if (!assets.length) return { rows: [], total: 0, extra: { matchedDevices: 0 } };

    const and: Record<string, unknown>[] = [{ assetId: { in: assets.map((x) => x.id) } }];
    if (a.interface) {
      and.push({ OR: ["ifName", "alias", "description"].map((f) => ({ [f]: { contains: a.interface, mode: "insensitive" } })) });
    }
    if (a.state) {
      and.push({ OR: a.state.map((s) => s === "up" ? { operStatus: { equals: "up", mode: "insensitive" } }
        : s === "down" ? { NOT: { operStatus: { equals: "up", mode: "insensitive" } }, adminStatus: { equals: "up", mode: "insensitive" } }
        : { adminStatus: { equals: "down", mode: "insensitive" } }) });
    }
    if (a.poe === "fault") and.push({ poeStatus: { in: ["fault", "other-fault"] } });
    if (a.poe === "delivering") and.push({ poeStatus: "delivering" });
    if (a.monitoredOnly || a.withErrors) {
      const pinned = assets.filter((x) => x.monitoredInterfaces.length);
      if (!pinned.length) return { rows: [], total: 0, extra: { matchedDevices: assets.length, note: "No matching device has an interface selected for monitoring, so there is no traffic or error history." } };
      and.push({ OR: pinned.map((x) => ({ assetId: x.id, ifName: { in: x.monitoredInterfaces } })) });
    }
    const where = { AND: and };
    const count = await prisma.assetInterface.count({ where });
    if (count > INTERFACE_SCAN_MAX) {
      return { ok: false, data: { error: `${count} interfaces match — narrow by device (model, type, region, search) or interface name first.` } };
    }
    const ifaces = await prisma.assetInterface.findMany({
      where,
      select: { assetId: true, ifName: true, alias: true, description: true, operStatus: true, adminStatus: true, speedBps: true, vlanId: true, poeStatus: true, poeClass: true },
    });

    const byAsset = new Map(assets.map((x) => [x.id, x]));
    const pinnedRows = ifaces.filter((i) => byAsset.get(i.assetId)?.monitoredInterfaces.includes(i.ifName));
    const { tier } = await pickSampleTierForAsset("", "interfaces", from);
    const aggs = await interfaceAggregates(
      Array.from(new Set(pinnedRows.map((i) => i.assetId))), Array.from(new Set(pinnedRows.map((i) => i.ifName))), from, to, tier,
    );
    const aggBy = new Map(aggs.map((g) => [`${g.assetId}\u0000${g.ifName}`, g]));
    const window = `${from.toISOString()} – ${to.toISOString()}${tier === "detail" ? "" : ` (${tier} averages)`}`;

    let rows = ifaces.map((i) => {
      const dev = byAsset.get(i.assetId)!;
      const history = dev.monitoredInterfaces.includes(i.ifName);
      const g = history ? aggBy.get(`${i.assetId}\u0000${i.ifName}`) : undefined;
      const speed = i.speedBps == null ? null : Number(i.speedBps);
      const admin = (i.adminStatus ?? "").toLowerCase();
      const oper = (i.operStatus ?? "").toLowerCase();
      return {
        id: i.assetId, hostname: dev.hostname, interface: i.ifName,
        description: i.alias || i.description || null,
        state: admin === "down" ? "disabled" : oper === "up" ? "up" : oper === "down" ? "down" : oper ? `down (${oper})` : null,
        speedMbps: speed == null ? null : Math.round(speed / 1e6), vlan: i.vlanId,
        poe: i.poeStatus ? [i.poeStatus, i.poeClass].filter(Boolean).join(" / ") : null,
        avgInMbps: mbps(g?.avgIn), avgOutMbps: mbps(g?.avgOut), peakInMbps: mbps(g?.peakIn), peakOutMbps: mbps(g?.peakOut),
        avgUtilPct: utilPct(Math.max(g?.avgIn ?? -1, g?.avgOut ?? -1) < 0 ? null : Math.max(g?.avgIn ?? 0, g?.avgOut ?? 0), speed),
        peakUtilPct: utilPct(Math.max(g?.peakIn ?? -1, g?.peakOut ?? -1) < 0 ? null : Math.max(g?.peakIn ?? 0, g?.peakOut ?? 0), speed),
        inErrors: g?.inErrors == null ? null : Math.round(g.inErrors), outErrors: g?.outErrors == null ? null : Math.round(g.outErrors),
        history, window,
      };
    });
    if (a.withErrors) rows = rows.filter((r) => (r.inErrors ?? 0) + (r.outErrors ?? 0) > 0);
    const sort = a.sortBy ?? (a.withErrors ? "errors" : "utilization");
    const key = (r: (typeof rows)[number]): number | null =>
      sort === "utilization" ? r.avgUtilPct
      : sort === "peak" ? r.peakUtilPct
      : sort === "traffic" ? (r.avgInMbps == null && r.avgOutMbps == null ? null : (r.avgInMbps ?? 0) + (r.avgOutMbps ?? 0))
      : sort === "errors" ? (r.inErrors == null && r.outErrors == null ? null : (r.inErrors ?? 0) + (r.outErrors ?? 0))
      : null;
    rows.sort((x, y) => sort === "name"
      ? `${x.hostname}\u0000${x.interface}`.localeCompare(`${y.hostname}\u0000${y.interface}`, undefined, { numeric: true })
      : (key(y) ?? -1) - (key(x) ?? -1) || `${x.hostname}${x.interface}`.localeCompare(`${y.hostname}${y.interface}`, undefined, { numeric: true }));
    const take = Math.min(a.limit ?? cap, cap);
    return {
      rows: rows.slice(0, take).map(plain),
      total: rows.length,
      extra: { window, matchedDevices: assets.length, interfacesWithHistory: pinnedRows.length, sortedBy: sort },
    };
  },
  async run(args, ctx) {
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
    "Full detail for ONE asset by id, exact hostname or IP: identity, monitoring state, acquired date (as the " +
      "asset page shows it; acquiredFrom says entered or first seen by Polaris), warranty " +
      "expiry and purchase order, the upstream device " +
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
        dependencySuppressed: true, maintenanceReturnStatus: true,
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
      ...plain(withUptime(withAcquired(rest))),
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

// ─── asset_details ───────────────────────────────────────────────────────────
//
// The rest of the asset slide-in, one section at a time (assetDetailReadService
// holds the readers and their per-section second gates). One tool with a
// section enum rather than one tool per tab: every definition rides in every
// round, and a local model's window cannot afford sixteen of them.

const AssetDetailsArgs = z.object({
  id: z.string().max(60).optional(),
  hostname: z.string().max(255).optional(),
  ip: z.string().max(60).optional(),
  sections: z.array(z.enum(ASSET_SECTIONS)).min(1).max(6),
}).refine((a) => a.id || a.hostname || a.ip, "Give id, hostname or ip");

const assetDetailsTool: ToolDef = {
  name: "asset_details",
  label: "read the asset's details",
  description:
    "The rest of ONE asset's details page (by id, exact hostname or IP), 1-6 sections per call: " +
    ASSET_SECTIONS.map((s) => (ASSET_SECTION_HELP[s] ? `${s} (${ASSET_SECTION_HELP[s]})` : s)).join(", ") + ".",
  parameters: {
    type: "object",
    properties: {
      id: { type: "string" },
      hostname: { type: "string" },
      ip: { type: "string" },
      sections: { type: "array", items: { type: "string", enum: [...ASSET_SECTIONS] } },
    },
    required: ["sections"],
  },
  async run(args, ctx) {
    if (!hasPermission(ctx.req, "assets", "read")) return denied("assets");
    const p = AssetDetailsArgs.safeParse(args ?? {});
    if (!p.success) return invalid(p.error);
    const a = p.data;
    const where = a.id ? { id: a.id }
      : a.hostname ? { hostname: { equals: a.hostname, mode: "insensitive" as const } }
      : { ipAddress: a.ip };
    const asset = await prisma.asset.findFirst({ where, select: { id: true, hostname: true, assetType: true } });
    if (!asset) return { ok: true, data: { found: false } };
    // Section rows are capped tighter than a list lookup: several sections
    // ride in one result.
    const cap = Math.min(ctx.maxRows, 100);
    return {
      ok: true,
      data: { found: true, ...asset, ...(await readAssetSections(asset.id, a.sections, ctx.req, cap)) },
    };
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
    { key: "ipAddress", label: "IP" }, { key: "hostname", label: "Hostname" }, { key: "macAddress", label: "MAC" },
    { key: "owner", label: "Owner" }, { key: "status", label: "Status" }, { key: "sourceType", label: "Source" },
    { key: "dhcpBinding", label: "DHCP binding" }, { key: "network", label: "Network" }, { key: "notes", label: "Notes" },
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
          // The network slide-in's other columns: the MAC, how the gate serves
          // the address, whether a push landed, and the operator's notes.
          macAddress: true, dhcpBinding: true, pushStatus: true, conflictMessage: true, notes: true,
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

// ─── get_network ─────────────────────────────────────────────────────────────
//
// Everything the network slide-in (ip-panel.js) shows, for ONE network: the
// header (purpose, VLAN, the FortiGate and interface serving it, the
// integration that discovered it and when), the utilization footer — counted
// over the whole network here rather than the panel's one page — and the
// address grid one page at a time. The page comes from getSubnetIps, the call
// the panel itself makes, so the two cannot disagree about which reservation
// owns an address or which asset sits on it; that function strips the
// integration config before returning, and only its return value is read.

const NETWORK_PAGE_MAX = 256;
const FIRST_FREE_COUNT = 10;

const GetNetworkArgs = z.object({
  id: z.string().max(60).optional(),
  cidr: z.string().max(60).optional(),
  name: z.string().max(200).optional(),
  page: z.number().int().positive().max(1_000_000).optional(),
  usedOnly: z.boolean().optional(),
}).refine((a) => a.id || a.cidr || a.name, "Give id, cidr or name");

/** Drop null / empty fields so a page of addresses costs the model less. */
function compact(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    if (v == null || v === "" || (Array.isArray(v) && v.length === 0)) continue;
    out[k] = v instanceof Date ? v.toISOString() : v;
  }
  return out;
}

const getNetworkTool: ToolDef = {
  name: "get_network",
  label: "opened a network",
  description:
    "ONE network's details (by id, CIDR or name): purpose, VLAN, gate + interface, discovery, utilization by " +
    "kind, conflicts, first free addresses, and a page of addresses with who holds each (hostname, MAC, owner, " +
    "lease / reservation / VIP, push state, notes) and the asset on it.",
  parameters: {
    type: "object",
    properties: {
      id: { type: "string" },
      cidr: { type: "string" },
      name: { type: "string" },
      page: { type: "number" },
      usedOnly: { type: "boolean", description: "Default true: held addresses only" },
    },
  },
  async run(args, ctx) {
    if (!hasPermission(ctx.req, "subnets", "read")) return denied("networks");
    const p = GetNetworkArgs.safeParse(args ?? {});
    if (!p.success) return invalid(p.error);
    const a = p.data;
    const where = a.id ? { id: a.id }
      : a.cidr ? { cidr: a.cidr.trim() }
      : { name: { equals: a.name!.trim(), mode: "insensitive" as const } };
    const select = {
      id: true, cidr: true, name: true, purpose: true, status: true, vlan: true, tags: true,
      fortigateDevice: true, fortigateInterface: true, fortigateVlanParent: true,
      lastDiscoveredAt: true, createdBy: true, createdAt: true,
      block: { select: { name: true, cidr: true } },
      integration: { select: { name: true, type: true } },
    } as const;
    let matches = await prisma.subnet.findMany({ where, select, take: 6, orderBy: { cidr: "asc" } });
    if (!matches.length && a.name) {
      matches = await prisma.subnet.findMany({
        where: { name: { contains: a.name.trim(), mode: "insensitive" } }, select, take: 6, orderBy: { cidr: "asc" },
      });
    }
    if (!matches.length) return { ok: true, data: { found: false } };
    if (matches.length > 1) {
      // The same CIDR can sit in two blocks; a name can be shared. Let the model pick.
      return {
        ok: true,
        data: {
          found: false,
          ambiguous: true,
          note: "More than one network matches — call again with the id of the one meant.",
          candidates: matches.map((s) => ({ id: s.id, cidr: s.cidr, name: s.name, block: s.block?.name ?? null, status: s.status })),
        },
      };
    }
    const s = matches[0];
    const ipv6 = s.cidr.includes(":");
    const canReservations = hasPermission(ctx.req, "reservations", "read");
    const canAssets = hasPermission(ctx.req, "assets", "read");

    const { getSubnetIps } = await import("./subnetService.js");
    const { findNextAvailableIps } = await import("./reservationService.js");
    const pageSize = Math.min(NETWORK_PAGE_MAX, Math.max(32, ctx.maxRows));
    const page = a.page ?? 1;
    const [byKind, conflicts, pushProblems, grid] = await Promise.all([
      // Business rule 69's numerator: active rows holding an address.
      prisma.reservation.groupBy({
        by: ["sourceType"],
        where: { subnetId: s.id, status: "active", ipAddress: { not: null } },
        _count: { _all: true },
      }),
      prisma.reservation.count({ where: { subnetId: s.id, conflictMessage: { not: null } } }),
      prisma.reservation.count({ where: { subnetId: s.id, status: "active", pushStatus: { in: ["pending", "failed_permanent"] } } }),
      // An IPv6 network is not enumerable — getSubnetIps returns every
      // reservation as one list, which is paged here instead.
      getSubnetIps(s.id, ipv6 ? 1 : page, pageSize),
    ]);
    const reserved = byKind.reduce((n, k) => n + k._count._all, 0);
    const usable = ipv6 ? null : usableHostCount(s.cidr);
    // findNextAvailableIps refuses (409) when it cannot return the whole
    // count, so a small or nearly full network asks only for what is free.
    const wantFree = usable != null && s.status !== "deprecated" ? Math.min(FIRST_FREE_COUNT, Math.max(0, usable - reserved)) : 0;
    const firstFree = wantFree > 0 ? await findNextAvailableIps(s.id, wantFree, false).catch(() => null) : null;

    const allRows = ipv6 ? grid.ips.slice((page - 1) * pageSize, page * pageSize) : grid.ips;
    const used = (r: (typeof grid.ips)[number]) => !!r.reservation || !!r.assetId;
    const rows = (a.usedOnly === false ? allRows : allRows.filter(used)).map((r) => {
      const res = r.reservation;
      return compact({
        address: r.address,
        type: r.type === "host" ? null : r.type,
        free: used(r) ? null : true,
        ...(canReservations && res ? {
          status: res.status, hostname: res.hostname, owner: res.owner, macAddress: res.macAddress,
          sourceType: res.sourceType, dhcpBinding: res.dhcpBinding, vip: res.vipInfo,
          pushStatus: res.pushStatus, pushError: res.pushError, notes: res.notes,
          expiresAt: res.expiresAt, leaseExpiresAt: res.leaseExpiresAt, createdBy: res.createdBy,
          conflict: res.conflictMessage,
        } : {}),
        ...(!canReservations && res ? { held: true } : {}),
        ...(canAssets && r.assetId ? { assetId: r.assetId, assetHostname: r.assetHostname } : {}),
      });
    });
    const totalForPaging = ipv6 ? grid.ips.length : grid.totalIps;

    return {
      ok: true,
      data: {
        found: true,
        ...compact({
          id: s.id, cidr: s.cidr, name: s.name, purpose: s.purpose, status: s.status, vlan: s.vlan, tags: s.tags,
          ipv6,
          block: s.block ? `${s.block.name} (${s.block.cidr})` : null,
          discoveredBy: s.integration ? `${s.integration.name} (${s.integration.type})` : null,
          lastDiscoveredAt: s.lastDiscoveredAt,
          fortigateDevice: s.fortigateDevice,
          fortigateInterface: s.fortigateInterface,
          fortigateVlanParent: s.fortigateVlanParent,
          createdBy: s.createdBy, createdAt: s.createdAt,
        }),
        utilization: {
          reserved,
          usableHosts: usable,
          free: usable != null ? Math.max(0, usable - reserved) : null,
          utilizationPercent: usable ? Math.round((reserved / usable) * 1000) / 10 : null,
          byKind: Object.fromEntries(byKind.map((k) => [k.sourceType, k._count._all])),
          conflicts,
          pushPendingOrFailed: pushProblems,
        },
        firstFree: firstFree ?? undefined,
        addresses: {
          page,
          pageCount: Math.max(1, Math.ceil(totalForPaging / pageSize)),
          usedOnly: a.usedOnly !== false,
          ...(canReservations ? {} : { note: "Your role cannot read reservations, so who holds each address is left out." }),
          rows,
        },
      },
    };
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

const LIST_TOOLS: ListToolDef[] = [listAssetsTool, listAlertsTool, listEventsTool, listSubnetsTool, listReservationsTool, telemetrySummaryTool, listServicesTool, pathCheckSummaryTool, interfaceSummaryTool];
const LIST_BY_NAME = new Map(LIST_TOOLS.map((t) => [t.name, t]));

/** The list tools a report can be built from (create_report's `source`). */
export const REPORT_SOURCE_NAMES = ["list_assets", "list_alerts", "list_events", "list_networks", "list_reservations", "telemetry_summary", "list_services", "path_check_summary", "interface_summary"] as const;

const ReportArgs = z.object({
  title: z.string().min(1).max(150),
  source: z.enum(REPORT_SOURCE_NAMES),
  args: z.record(z.unknown()).optional(),
  columns: z.array(z.string().max(60)).max(30).optional(),
  formats: z.preprocess((v) => {
    if (v == null || v === "") return undefined;
    const list = Array.isArray(v) ? v : String(v).split(",");
    // "markdown" is what a model writes as often as "md".
    return Array.from(new Set(list.map((f) => String(f).trim().toLowerCase()).map((f) => (f === "markdown" ? "md" : f))));
  }, z.array(z.enum(REPORT_FORMATS)).max(3).optional()),
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
        description: "Column keys to include. list_assets: hostname, ipAddress, assetType, status, monitorStatus, manufacturer, model, serialNumber, osVersion, location, tags, lastSeen, monitorStatusChangedAt, acquiredAt, acquiredFrom, warrantyExpiry, purchaseOrder. " +
          "telemetry_summary: hostname, ipAddress, model, location, avgMemPct, maxMemPct, avgCpuPct, maxCpuPct, samples, window. " +
          "list_services: hostname, ipAddress, service, displayName, platform, state, startup, cpuPct, memMB, watched, updatedAt. " +
          "path_check_summary: check, kind, target, source, availabilityPct, avgLatencyMs, maxLatencyMs, samples, lastOk, lastError, lastFailAt, lastSampleAt, window. " +
          "interface_summary: hostname, interface, description, state, speedMbps, vlan, poe, avgInMbps, avgOutMbps, peakInMbps, peakOutMbps, avgUtilPct, peakUtilPct, inErrors, outErrors, history, window",
      },
      formats: {
        type: "array", items: { type: "string", enum: [...REPORT_FORMATS] },
        description: "Only the download formats the user asked for, e.g. [\"pdf\"]. Omit when they named none — all three are offered.",
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
    const formats = ctx.reportFormats?.length ? ctx.reportFormats : p.data.formats;
    const report: AssistantReportPayload = {
      title: p.data.title,
      columns,
      rows: res.rows.map((r) => Object.fromEntries(columns.map((c) => [c.key, r[c.key] ?? null]))),
      rowCount: res.rows.length,
      truncated: res.total > res.rows.length,
      ...(formats?.length ? { formats } : {}),
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
        downloads: (report.formats ?? REPORT_FORMATS).map((f) => (f === "md" ? "Markdown" : f.toUpperCase())),
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
  searchHelpTool, searchTool, fleetSummaryTool, listAssetsTool, telemetrySummaryTool, getAssetTool, assetDetailsTool, getDependenciesTool, listServicesTool, findEndpointTool, pathCheckSummaryTool, interfaceSummaryTool,
  listAlertsTool, listEventsTool, listSubnetsTool, getNetworkTool, listReservationsTool, createReportTool,
  listProfilesTool, getProfileTool, listMibsTool, searchMibSymbolsTool, listAutomationsTool, getAutomationTool,
];
const BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

/**
 * Tools a turn offers only when the model's window has room for every
 * definition, or when the turn's playbook names them (assistantChatService
 * toolsForWindow). On a small local window the full list would crowd out the
 * system prompt; every tool that predates these stays offered as before.
 */
export const WINDOW_OPTIONAL_TOOLS: ReadonlySet<string> = new Set([
  "telemetry_summary", "get_dependencies", "list_services", "find_endpoint", "path_check_summary", "interface_summary",
]);

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
