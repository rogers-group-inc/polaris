/**
 * src/services/alertProcessService.ts — the "top 5 processes" block in a high
 * CPU / high memory alert email (`{processes.top}`).
 *
 * "CPU is 97%" says the host is busy; it does not say with what, and the
 * operator's next move is to open the device and sort its process table. This
 * puts the answer in the email: the five programs using the most of the
 * resource the alert fired on — ranked by CPU for a CPU alert, by memory for a
 * memory alert — with the other figure beside each, since a runaway process
 * usually moves both.
 *
 * Deferred to DELIVERY time like `{chart.*}` and `{interface.lldp}`, for their
 * reasons: it needs a DB read, its HTML and plain-text forms are different
 * markup, and an escalation sent an hour later should show the host as it is
 * then rather than a fire-time snapshot. It renders to a complete block or to
 * nothing — any other alert, a host with no process inventory (SNMP-polled
 * devices, firewalls, a Polaris-internal alert), or a read failure all remove
 * the token outright, so no heading ever sits over an empty table.
 *
 * The source is the current-state process inventory (`AssetProcess`), one row
 * per program with its instances summed. On a Polaris Agent host its CPU is
 * the mean since the agent's previous inventory scrape (agent 0.22.1+), which
 * is what makes a ranking meaningful; the block says how old that scrape is,
 * because the inventory is refreshed every few minutes, not at alert time.
 */

import { prisma } from "../db.js";
import { logger } from "../utils/logger.js";
import { escapeHtml } from "../utils/notificationTemplate.js";
import { formatBytes } from "../utils/haAdvisories.js";

export const PROCESS_TOKENS = ["processes.top"] as const;
export type ProcessToken = (typeof PROCESS_TOKENS)[number];

/** How many programs the block lists. */
export const TOP_PROCESS_COUNT = 5;

export type ProcessRanking = "cpu" | "memory";

/** The metric an automation fired on → which resource the list ranks by. */
export function processRankingForMetric(metric: string | null | undefined): ProcessRanking | null {
  switch (metric) {
    case "cpuPct":
      return "cpu";
    case "memPct":
    case "memUsedBytes":
      return "memory";
    default:
      return null;
  }
}

export interface TopProcessRow {
  name: string;
  instanceCount: number;
  cpuPct: number | null;
  memRssBytes: bigint | null;
}

export interface TopProcessList {
  ranking: ProcessRanking;
  rows: TopProcessRow[];
  /** When the inventory these rows came from was written. */
  reportedAt: Date | null;
}

/** Invented programs for the automation wizard's test email — its device is
 *  made up (utils/sampleAlertDevice), so there is no inventory to read. */
const SAMPLE_PROCESSES: TopProcessRow[] = [
  { name: "sqlservr.exe", instanceCount: 1, cpuPct: 184.2, memRssBytes: 12_884_901_888n },
  { name: "MsMpEng.exe", instanceCount: 1, cpuPct: 41.7, memRssBytes: 402_653_184n },
  { name: "w3wp.exe", instanceCount: 4, cpuPct: 22.3, memRssBytes: 2_147_483_648n },
  { name: "svchost.exe", instanceCount: 71, cpuPct: 6.1, memRssBytes: 1_288_490_189n },
  { name: "powershell.exe", instanceCount: 2, cpuPct: 3.4, memRssBytes: 188_743_680n },
  { name: "explorer.exe", instanceCount: 1, cpuPct: 0.4, memRssBytes: 125_829_120n },
];

/**
 * Rank rows by the resource. Rows with no reading for it are dropped, never
 * ranked as zero: "not measured" (a process the agent has seen once) must not
 * read as "idle". Ties break by name so the list is stable. Pure.
 */
export function rankProcesses(rows: TopProcessRow[], ranking: ProcessRanking, n = TOP_PROCESS_COUNT): TopProcessRow[] {
  const key = (r: TopProcessRow): number | null =>
    ranking === "cpu" ? r.cpuPct : r.memRssBytes != null ? Number(r.memRssBytes) : null;
  return rows
    .filter((r) => key(r) != null)
    .sort((a, b) => key(b)! - key(a)! || a.name.localeCompare(b.name))
    .slice(0, n);
}

/**
 * Read the asset's top processes for this alert. Null when the alert is not
 * about CPU or memory, there is no asset, or there are no ranked rows. A test
 * alert (sample) gets invented rows. Best-effort: a read failure is null, never
 * a failed delivery.
 */
export async function loadTopProcesses(
  assetId: string | null,
  metric: string | null,
  opts?: { sample?: boolean; now?: Date },
): Promise<TopProcessList | null> {
  const ranking = processRankingForMetric(metric);
  if (!ranking) return null;
  if (opts?.sample) {
    const now = opts.now ?? new Date();
    return { ranking, rows: rankProcesses(SAMPLE_PROCESSES, ranking), reportedAt: new Date(now.getTime() - 3 * 60_000) };
  }
  if (!assetId) return null;
  try {
    // The ranking happens in SQL (NULLS LAST, and the not-null filter makes
    // them absent anyway), so the read is five rows however many programs the
    // host runs — a Windows server can carry several hundred.
    const rows = await prisma.assetProcess.findMany({
      where: ranking === "cpu" ? { assetId, cpuPct: { not: null } } : { assetId, memRssBytes: { not: null } },
      orderBy: [
        ranking === "cpu" ? { cpuPct: { sort: "desc", nulls: "last" } } : { memRssBytes: { sort: "desc", nulls: "last" } },
        { name: "asc" },
      ],
      take: TOP_PROCESS_COUNT,
      select: { name: true, instanceCount: true, cpuPct: true, memRssBytes: true, updatedAt: true },
    });
    if (rows.length === 0) return null;
    const reportedAt = rows.reduce<Date | null>((m, r) => (m == null || r.updatedAt > m ? r.updatedAt : m), null);
    return {
      ranking,
      rows: rankProcesses(rows.map(({ updatedAt: _u, ...r }) => r), ranking),
      reportedAt,
    };
  } catch (err) {
    logger.debug({ err: (err as Error)?.message, assetId }, "top-process read failed — sending without the process list");
    return null;
  }
}

/** "4 min", "2 h", "just now" — how long before this email the inventory was written. */
export function ageBefore(reportedAt: Date | null, now: Date): string | null {
  if (!reportedAt) return null;
  const min = Math.max(0, Math.round((now.getTime() - reportedAt.getTime()) / 60_000));
  if (min < 1) return "just now";
  if (min < 120) return `${min} min before this email`;
  const h = Math.round(min / 60);
  if (h < 48) return `${h} h before this email`;
  return `${Math.round(h / 24)} days before this email`;
}

function fmtCpu(v: number | null): string {
  return v == null ? "—" : `${v.toFixed(1)}%`;
}

function fmtMem(v: bigint | null): string {
  return v == null ? "—" : formatBytes(Number(v));
}

function nameWithCount(r: TopProcessRow): string {
  return r.instanceCount > 1 ? `${r.name} ×${r.instanceCount}` : r.name;
}

/**
 * Render the block for one body. Empty string when there is nothing to list.
 * The ranked column leads, so the figure the reader opened the email for is the
 * first number beside each name.
 */
export function renderTopProcesses(list: TopProcessList | null, opts: { html: boolean; now?: Date }): string {
  if (!list || list.rows.length === 0) return "";
  const now = opts.now ?? new Date();
  const byCpu = list.ranking === "cpu";
  const heading = `Top ${list.rows.length === 1 ? "process" : `${list.rows.length} processes`} by ${byCpu ? "CPU" : "memory"}`;
  const age = ageBefore(list.reportedAt, now);
  // CPU is summed across a program's instances and across cores, so it can
  // read above 100 — say what the scale is, once.
  const note = [age ? `reported ${age}` : null, "100% CPU = one core"].filter(Boolean).join(" · ");
  const cols = (r: TopProcessRow): [string, string] =>
    byCpu ? [fmtCpu(r.cpuPct), fmtMem(r.memRssBytes)] : [fmtMem(r.memRssBytes), fmtCpu(r.cpuPct)];
  const [firstLabel, secondLabel] = byCpu ? ["CPU", "Memory"] : ["Memory", "CPU"];

  if (!opts.html) {
    const width = Math.max(...list.rows.map((r) => nameWithCount(r).length), 7) + 2;
    const lines = [`${heading} (${note})`];
    lines.push(`  ${"Process".padEnd(width)}${firstLabel.padEnd(10)}${secondLabel}`);
    for (const r of list.rows) {
      const [a, b] = cols(r);
      lines.push(`  ${nameWithCount(r).padEnd(width)}${a.padEnd(10)}${b}`);
    }
    return lines.join("\n");
  }

  const th = (label: string, right: boolean) =>
    `<td style="padding:3px ${right ? "0 3px 12px" : "12px 3px 0"};color:#6b7280;font-size:12px;${right ? "text-align:right;" : ""}white-space:nowrap">${label}</td>`;
  const td = (value: string, right: boolean, strong = false) =>
    `<td style="padding:3px ${right ? "0 3px 12px" : "12px 3px 0"};vertical-align:top;${right ? "text-align:right;white-space:nowrap;" : "word-break:break-word;"}${strong ? "font-weight:600;" : ""}">${value}</td>`;
  const body = list.rows
    .map((r) => {
      const [a, b] = cols(r);
      return `<tr>${td(escapeHtml(nameWithCount(r)), false)}${td(escapeHtml(a), true, true)}${td(escapeHtml(b), true)}</tr>`;
    })
    .join("\n");
  return [
    '<tr><td style="padding:14px 22px 0">',
    `<div style="font-size:12px;letter-spacing:.06em;text-transform:uppercase;color:#6b7280;font-weight:700;margin-bottom:2px">${escapeHtml(heading)}</div>`,
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="font-size:13px;color:#374151;border-collapse:collapse">',
    `<tr>${th("Process", false)}${th(firstLabel, true)}${th(secondLabel, true)}</tr>`,
    body,
    "</table>",
    `<div style="font-size:12px;color:#6b7280;margin-top:6px">${escapeHtml(note.charAt(0).toUpperCase() + note.slice(1))}</div>`,
    "</td></tr>",
  ].join("\n");
}

const TOP_TOKEN_RE = /\{processes\.top\}/g;

/** Do any of these templates reference a `{processes.*}` token? */
export function processTokensIn(...templates: Array<string | null | undefined>): Set<ProcessToken> {
  const found = new Set<ProcessToken>();
  for (const t of templates) {
    if (!t) continue;
    for (const token of PROCESS_TOKENS) {
      if (t.includes(`{${token}}`)) found.add(token);
    }
  }
  return found;
}

/**
 * Fill `{processes.top}` with the rendered block; an empty block removes the
 * token outright (the `substituteInterfaceTokens` contract). The block is
 * already escaped, and it goes in through a function so `$&` in a process name
 * can't be read as a replacement pattern.
 */
export function substituteProcessTokens(body: string, block: string): string {
  if (!body) return body;
  return body.replace(TOP_TOKEN_RE, () => block);
}

/** The whole delivery-time step for one alert: one read, both bodies. */
export async function buildTopProcessBlocks(
  assetId: string | null,
  metric: string | null,
  opts?: { sample?: boolean; now?: Date },
): Promise<{ html: string; text: string }> {
  const now = opts?.now ?? new Date();
  const list = await loadTopProcesses(assetId, metric, { sample: opts?.sample, now });
  return { html: renderTopProcesses(list, { html: true, now }), text: renderTopProcesses(list, { html: false, now }) };
}
