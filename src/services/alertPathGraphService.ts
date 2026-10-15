/**
 * src/services/alertPathGraphService.ts — the traceroute path graph in a
 * Path Monitor alert email (`{path.graph}`).
 *
 * A path alert ("HTTPS to erp.example is failing from PLANT-PC-04") used to
 * carry no picture: the device charts are about the HOST, not the path, so
 * alertChartService draws nothing for a path metric and the reader had to open
 * the Paths tab to see where the route broke. This draws that tab's graph —
 * the recent traceroutes folded into one NetPath-style view, each link coloured
 * by the latency it adds on the newest trace (utils/pathGraphSvg) — into the
 * email.
 *
 * WHICH PATHS. An ungrouped alert is about one (host, check): one graph. A
 * grouped alert (business rule 75) names several, and draws up to FOUR
 * (`MAX_PATH_GRAPHS`), worst first, chosen to differ in what the alert is
 * folded by: on an alert that spans devices (folded by automation or subnet)
 * one graph per DEVICE before any device gets a second, and on one folded per
 * device one per AUTOMATION before any automation gets a second. The rest of
 * the slots then fill with whatever distinct (host, check) pairs remain.
 *
 * A check Polaris runs itself (no host — `Notification.assetId` null) reads its
 * traces under POLARIS_SERVER_SUBJECT and is labelled "Polaris server".
 *
 * Built at DELIVERY, like the charts and the dependency path: an escalation an
 * hour later shows the route as it is then. Every failure degrades — traceroute
 * off for the check, no traces yet, an unreadable row, no resvg binding — to
 * the text line, or to nothing; it never stops the alert from sending.
 */

import { prisma } from "../db.js";
import { logger } from "../utils/logger.js";
import { escapeHtml } from "../utils/notificationTemplate.js";
import { buildPathGraph, pathGraphSvg, pathGraphText, type PathTrace } from "../utils/pathGraphSvg.js";
import { activeMembers, primaryMember, type AlertMember } from "./notificationTypes.js";
import { POLARIS_SERVER_LABEL, POLARIS_SERVER_SUBJECT } from "./pathCheckIngestService.js";
import type { InlineAttachment } from "./notificationChannels/emailChannel.js";

export const PATH_GRAPH_TOKENS = ["path.graph"] as const;
export type PathGraphToken = (typeof PATH_GRAPH_TOKENS)[number];

/** Most path graphs one email draws. */
export const MAX_PATH_GRAPHS = 4;

/** Traces folded into each graph — the Paths tab's default view. */
const TRACES_PER_GRAPH = 10;

/** The metrics whose alerts are about a path check (dimension key = check id). */
export const PATH_GRAPH_METRICS: ReadonlySet<string> = new Set([
  "pathLatencyMs", "pathHttpStatus", "pathOk", "pathFailurePct", "pathHopCount", "pathTlsDaysLeft",
]);

export function pathGraphCid(i: number): string {
  return `polaris-path-graph-${i}@polaris`;
}

/** One path to draw: a host (null = the Polaris server) and a check. */
export interface PathGraphSubject {
  assetId: string | null;
  checkId: string;
  ruleId: string | null;
}

export interface PathGraphNotification {
  assetId: string | null;
  dimension: string | null;
  metric: string | null;
  ruleId: string | null;
  members: unknown;
  testRun: boolean;
}

/**
 * Pure: which paths an alert draws, in order, at most `max`.
 *
 * The first pass takes one subject per distinct UNIT — the device on an alert
 * whose members carry one (folded by automation or subnet), else the
 * automation — so four graphs show four different things before any repeats.
 * The second fills the remaining slots with other distinct (host, check)
 * pairs, still worst first.
 */
export function pathGraphSubjects(n: PathGraphNotification, max = MAX_PATH_GRAPHS): PathGraphSubject[] {
  if (!n.metric || !PATH_GRAPH_METRICS.has(n.metric)) return [];
  const members = Array.isArray(n.members) ? activeMembers(n.members as AlertMember[]) : [];
  if (!members.length) {
    return n.dimension ? [{ assetId: n.assetId || null, checkId: n.dimension, ruleId: n.ruleId }] : [];
  }
  const primary = primaryMember(members);
  const ordered = primary ? [primary, ...members.filter((m) => m !== primary)] : members;
  const spansDevices = ordered.some((m) => m.assetId);
  const candidates = ordered
    .filter((m) => m.key)
    .map((m) => ({ assetId: (m.assetId ?? n.assetId) || null, checkId: m.key, ruleId: m.ruleId ?? null }));
  const pairKey = (s: PathGraphSubject) => `${s.assetId ?? ""}|${s.checkId}`;
  const unitKey = (s: PathGraphSubject) => (spansDevices ? s.assetId ?? "" : s.ruleId ?? "");

  const out: PathGraphSubject[] = [];
  const pairs = new Set<string>();
  const units = new Set<string>();
  for (const s of candidates) {
    if (out.length >= max) break;
    if (units.has(unitKey(s)) || pairs.has(pairKey(s))) continue;
    units.add(unitKey(s));
    pairs.add(pairKey(s));
    out.push(s);
  }
  for (const s of candidates) {
    if (out.length >= max) break;
    if (pairs.has(pairKey(s))) continue;
    pairs.add(pairKey(s));
    out.push(s);
  }
  return out;
}

/** An invented route for a wizard test send (business rule 65 — "Example"). */
function sampleTraces(): PathTrace[] {
  return [{
    destinationIp: "192.0.2.10",
    complete: true,
    hops: [
      { ttl: 1, ip: "192.0.2.1", hostname: "Example gateway", rttMs: [1.2, 1.1, 1.3] },
      { ttl: 2, ip: "198.51.100.1", rdns: "example-isp.example", rttMs: [8.4, 8.9, 9.1] },
      { ttl: 3, ip: null, rttMs: [-1, -1, -1] },
      { ttl: 4, ip: "192.0.2.10", hostname: "Example destination", rttMs: [64.2, 63.8, 65.0] },
    ],
  }];
}

interface LoadedGraph {
  title: string;
  source: string;
  traces: PathTrace[];
}

async function loadGraphs(n: PathGraphNotification): Promise<LoadedGraph[]> {
  const subjects = pathGraphSubjects(n);
  if (!subjects.length) return [];
  if (n.testRun) return [{ title: "Example check — from Example host", source: "Example host", traces: sampleTraces() }];

  const checkIds = [...new Set(subjects.map((s) => s.checkId))];
  const assetIds = [...new Set(subjects.map((s) => s.assetId).filter((x): x is string => !!x))];
  const [checks, assets] = await Promise.all([
    prisma.pathCheck.findMany({ where: { id: { in: checkIds } }, select: { id: true, name: true, traceroute: true } }),
    assetIds.length
      ? prisma.asset.findMany({ where: { id: { in: assetIds } }, select: { id: true, hostname: true } })
      : Promise.resolve([] as { id: string; hostname: string | null }[]),
  ]);
  const checkById = new Map(checks.map((c) => [c.id, c]));
  const hostById = new Map(assets.map((a) => [a.id, a.hostname]));

  const out: LoadedGraph[] = [];
  // At most four reads, each one indexed (assetId, checkId, timestamp).
  const rows = await Promise.all(subjects.map(async (s) => {
    const check = checkById.get(s.checkId);
    if (!check) return null;
    const tr = check.traceroute as { enabled?: boolean } | null;
    if (tr && tr.enabled === false) return null;
    const traces = await prisma.assetPathCheckTraceroute.findMany({
      where: { assetId: s.assetId ?? POLARIS_SERVER_SUBJECT, checkId: s.checkId },
      orderBy: { timestamp: "desc" },
      take: TRACES_PER_GRAPH,
      select: { destinationIp: true, complete: true, hops: true },
    });
    if (!traces.length) return null;
    const source = s.assetId ? (hostById.get(s.assetId) || "This host") : POLARIS_SERVER_LABEL;
    return {
      title: `${check.name} — from ${source}`,
      source,
      traces: traces.map((t) => ({ destinationIp: t.destinationIp, complete: t.complete, hops: Array.isArray(t.hops) ? (t.hops as never) : [] })),
    };
  }));
  for (const r of rows) if (r) out.push(r);
  return out;
}

async function rasterize(svg: string): Promise<Buffer | null> {
  try {
    // Lazy import, as the charts and the dependency path do: resvg resolves a
    // per-platform native binding, and an alert must still send without it.
    const { Resvg } = await import("@resvg/resvg-js");
    return Buffer.from(new Resvg(svg, { fitTo: { mode: "zoom", value: 2 } }).render().asPng());
  } catch (err) {
    logger.warn({ err: (err as Error)?.message }, "path graph rasterization failed — falling back to text");
    return null;
  }
}

/** The whole delivery-time step for one alert: both bodies and the images. */
export async function buildPathGraphBlocks(n: PathGraphNotification): Promise<{
  html: string;
  text: string;
  attachments: InlineAttachment[];
}> {
  const empty = { html: "", text: "", attachments: [] as InlineAttachment[] };
  let graphs: LoadedGraph[];
  try {
    graphs = await loadGraphs(n);
  } catch (err) {
    logger.warn({ err: (err as Error)?.message }, "path graph load failed — leaving it out");
    return empty;
  }
  if (!graphs.length) return empty;

  const heading = graphs.length === 1 ? "Path" : `Paths (${graphs.length})`;
  const textLines: string[] = [];
  const bodies: string[] = [];
  const attachments: InlineAttachment[] = [];
  for (const [i, gr] of graphs.entries()) {
    const line = pathGraphText(gr.traces, { hostname: gr.source });
    textLines.push(`${gr.title}: ${line}`);
    const svg = pathGraphSvg(buildPathGraph(gr.traces, 0), { hostname: gr.source }, { title: gr.title, minWidth: 520 });
    const png = await rasterize(svg);
    if (png) {
      const cid = pathGraphCid(i);
      attachments.push({ cid, filename: `path-${i + 1}.png`, contentType: "image/png", content: png });
      bodies.push(
        `<img src="cid:${cid}" width="520" alt="${escapeHtml(`${gr.title}: ${line}`)}" ` +
        'style="display:block;width:100%;max-width:520px;height:auto;border:1px solid #e5e7eb;border-radius:6px;margin:6px 0 0">',
      );
    } else {
      bodies.push(`<p style="margin:6px 0 0;color:#374151;font-size:13px"><strong>${escapeHtml(gr.title)}</strong><br>${escapeHtml(line)}</p>`);
    }
  }
  const html = [
    '<tr><td style="padding:14px 22px 0">',
    `<div style="font-size:12px;letter-spacing:.06em;text-transform:uppercase;color:#6b7280;font-weight:700;margin-bottom:2px">${heading}</div>`,
    ...bodies,
    '<div style="font-size:12px;color:#6b7280;margin-top:6px">Latency each link adds on the newest trace: green under 10 ms, amber 10–50 ms or probe loss, red over 50 ms; ✕ destination not reached. Faded branches are routes other recent traces took.</div>',
    "</td></tr>",
  ].join("\n");
  return { html, text: `${heading}:\n${textLines.join("\n")}`, attachments };
}

const PATH_GRAPH_TOKEN_RE = /\{path\.graph\}/g;

/** Do any of these templates reference `{path.graph}`? */
export function pathGraphTokensIn(...templates: Array<string | null | undefined>): Set<PathGraphToken> {
  const found = new Set<PathGraphToken>();
  for (const t of templates) if (t && t.includes("{path.graph}")) found.add("path.graph");
  return found;
}

/** Fill the token with the rendered block; an empty block removes it outright. */
export function substitutePathGraphTokens(body: string, block: string): string {
  if (!body) return body;
  return body.replace(PATH_GRAPH_TOKEN_RE, () => block);
}
