/**
 * src/utils/pathGraphSvg.ts — the traceroute PATH GRAPH (NetPath-style hops)
 * as a static SVG, for an alert email.
 *
 * The server-side twin of the Paths tab's graph (`_trPathGraph` /
 * `_trPathLayout` / `_trNodeView` / `_trPathSVG` in public/js/assets.js): the
 * same fold of recent traces into one graph — a node per (TTL, address), a
 * branch where a route changed, each link coloured by the latency it ADDS on
 * the newest trace — drawn in the daylight paper palette the browser's export
 * uses, because an email is read on white whatever theme the sender runs.
 *
 * Kept as a separate port rather than shared code: public/ has no build step
 * and src/ cannot load a browser script. The two are held together by
 * tests/unit/pathGraphSvg.test.ts, which pins the fold's shape on the same
 * inputs the browser's reasoning is written against.
 *
 * Differences from the browser, all forced by the medium:
 *  - no hover targets, tooltips or click-through;
 *  - the source and destination glyphs (⌂, ◎) are drawn as shapes — a server's
 *    fonts need not carry them, and resvg draws a missing glyph as nothing;
 *  - text uses the email's font stack, and every colour is a literal.
 *
 * Pure: no I/O. alertPathGraphService reads the traces and rasterizes.
 */

export interface PathTraceHop {
  ttl: number;
  ip: string | null;
  rdns?: string | null;
  /** Per-probe round trips; a negative or non-number entry is an unanswered probe. */
  rttMs?: unknown[];
  assetId?: string | null;
  hostname?: string | null;
  monitorStatus?: string | null;
}

export interface PathTrace {
  destinationIp: string | null;
  complete: boolean;
  hops: PathTraceHop[];
}

export interface PathGraphNode {
  key: string;
  ttl: number;
  hop: PathTraceHop | null;
  traces: number;
  onSel: boolean;
  col: number;
  row: number;
}

export interface PathGraphEdge {
  from: string;
  to: string;
  traces: number;
  onSel: boolean;
  broken: boolean;
  delta: number | null;
  lossy: boolean;
  unanswered: boolean;
}

export interface PathGraph {
  nodes: Record<string, PathGraphNode>;
  edges: PathGraphEdge[];
  cols: number;
  traces: number;
  destIp: string | null;
}

/** avg / min / max of a hop's answered probes, or null when none answered. */
export function hopRtt(rtts: unknown[] | undefined): { avg: number; min: number; max: number } | null {
  const v = (rtts ?? []).filter((x): x is number => typeof x === "number" && x >= 0);
  if (!v.length) return null;
  return { avg: v.reduce((a, b) => a + b, 0) / v.length, min: Math.min(...v), max: Math.max(...v) };
}

/**
 * Fold traces (NEWEST FIRST) into one graph. `sel` is the trace whose route is
 * highlighted and whose per-link latency is shown — the newest, in an email.
 * Same algorithm as the browser's `_trPathGraph`; see its header.
 */
export function buildPathGraph(traces: PathTrace[], sel = 0): PathGraph {
  const nodes: Record<string, PathGraphNode> = {};
  const edges: Record<string, PathGraphEdge> = {};
  let maxTtl = 0;
  const selT = traces[sel] ?? traces[0];
  let destIp: string | null = selT?.destinationIp ?? null;
  for (const t of traces) if (!destIp && t.destinationIp) destIp = t.destinationIp;

  const keyOf = (t: PathTrace, h: PathTraceHop, isLast: boolean): string =>
    h.ip && ((isLast && t.complete) || h.ip === destIp) ? "dst" : `${h.ttl}:${h.ip || "*"}`;
  const ensure = (key: string, h: PathTraceHop | null): PathGraphNode => {
    const n = nodes[key] ?? (nodes[key] = { key, ttl: h ? h.ttl : 0, hop: null, traces: 0, onSel: false, col: 0, row: 0 });
    if (h && !n.hop) n.hop = h; // newest trace first, so the first sighting is the latest
    return n;
  };
  const touch = (key: string, ti: number, h: PathTraceHop): void => {
    const n = ensure(key, h);
    n.traces++;
    if (ti === sel) { n.onSel = true; n.hop = h; }
  };
  const link = (a: string, b: string, ti: number, extra: { broken?: boolean; delta?: number | null; lossy?: boolean; unanswered?: boolean }): void => {
    // A trace that stopped short gets its own link to the destination, so the
    // ✕ never lands on a route that got through.
    const k = `${a}>${b}${extra.broken ? "!" : ""}`;
    const e = edges[k] ?? (edges[k] = { from: a, to: b, traces: 0, onSel: false, broken: false, delta: null, lossy: false, unanswered: false });
    e.traces++;
    if (extra.broken) e.broken = true;
    if (ti === sel) {
      e.onSel = true;
      e.delta = extra.delta ?? null;
      e.lossy = !!extra.lossy;
      e.unanswered = !!extra.unanswered;
    }
  };

  ensure("src", null).onSel = true;
  traces.forEach((t, ti) => {
    const hops = [...(t.hops ?? [])].sort((a, b) => a.ttl - b.ttl);
    let prev = "src";
    let lastAvg = 0;
    hops.forEach((h, i) => {
      const key = keyOf(t, h, i === hops.length - 1);
      if (key === prev) return; // the destination answering at two TTLs
      touch(key, ti, h);
      if (key !== "dst" && h.ttl > maxTtl) maxTtl = h.ttl;
      const rtt = hopRtt(h.rttMs);
      const lost = (h.rttMs ?? []).filter((x) => !(typeof x === "number" && x >= 0)).length;
      link(prev, key, ti, { delta: rtt ? Math.max(0, rtt.avg - lastAvg) : null, lossy: !!rtt && lost > 0, unanswered: !rtt });
      if (rtt) lastAvg = rtt.avg;
      prev = key;
    });
    if (prev !== "dst") {
      ensure("dst", null); // drawn even when no trace reached it
      link(prev, "dst", ti, { broken: true });
    }
  });
  nodes["src"]!.traces = traces.length;
  if (nodes["dst"] && !nodes["dst"].hop) nodes["dst"].hop = { ttl: 0, ip: destIp, rdns: null, rttMs: [] };

  const cols: PathGraphNode[][] = [];
  for (const [k, n] of Object.entries(nodes)) {
    n.col = k === "src" ? 0 : k === "dst" ? maxTtl + 1 : n.ttl;
    (cols[n.col] ??= []).push(n);
  }
  // Most-travelled first, then by address — the browser's stable row order.
  for (const list of cols) {
    if (!list) continue;
    list.sort((a, b) => b.traces - a.traces || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    list.forEach((n, i) => { n.row = i; });
  }
  return { nodes, edges: Object.values(edges), cols: maxTtl + 2, traces: traces.length, destIp };
}

/** The daylight (noon) values of the tokens the browser graph paints with. */
export const PATH_GRAPH_COLORS = {
  accent: "#0288d1",
  paper: "#ffffff",
  text: "#1a1a2e",
  textSecondary: "#555570",
  textTertiary: "#8080a0",
  success: "#2e7d32",
  warning: "#f57f17",
  danger: "#c62828",
} as const;

/** The Device Map's monitor-state fills (MONITOR_STATE_COLORS in assets.js). */
const MONITOR_STATE_COLORS: Record<string, string> = { up: "#2a9d8f", down: "#d32f2f", warning: "#f4a261" };

/** A link's colour by the latency it adds — the NetPath reading. */
export function pathEdgeColor(e: PathGraphEdge): string {
  if (e.broken) return PATH_GRAPH_COLORS.danger;
  if (!e.onSel || e.delta == null) return PATH_GRAPH_COLORS.textTertiary;
  if (e.delta >= 50) return PATH_GRAPH_COLORS.danger;
  if (e.delta >= 10 || e.lossy) return PATH_GRAPH_COLORS.warning;
  return PATH_GRAPH_COLORS.success;
}

const FONT = "Helvetica,Arial,sans-serif";

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/**
 * The graph as a static SVG. `title` heads it (the check and its host — an
 * email can carry several of these, so each must say which path it is);
 * `minWidth` is the width the columns try to fill before the image grows.
 * Same geometry as the browser's `_trPathLayout`.
 */
export function pathGraphSvg(g: PathGraph, source: { hostname?: string | null }, opts: { title?: string; minWidth?: number } = {}): string {
  const MINCOL = 76, MAXCOL = 130, ROWH = 74, PADX = 12, R = 13;
  const PADT = opts.title ? 40 : 22;
  const minWidth = opts.minWidth ?? 520;
  let rows = 1;
  for (const n of Object.values(g.nodes)) rows = Math.max(rows, n.row + 1);
  const colW = Math.max(MINCOL, Math.min(MAXCOL, (minWidth - PADX * 2) / g.cols));
  const W = Math.max(minWidth, PADX * 2 + g.cols * colW);
  const H = PADT + rows * ROWH + 4;
  const offX = (W - g.cols * colW) / 2;
  const pos = (n: PathGraphNode) => ({ x: offX + n.col * colW + colW / 2, y: PADT + R + n.row * ROWH });
  const clip = (s: string | null | undefined): string => {
    const max = Math.max(4, Math.floor((colW - 8) / 6.2));
    const t = String(s ?? "");
    return t.length > max ? `${t.slice(0, max - 1)}…` : t;
  };
  const C = PATH_GRAPH_COLORS;
  const parts: string[] = [`<rect x="0" y="0" width="${W}" height="${H}" fill="${C.paper}"/>`];
  if (opts.title) {
    parts.push(`<text x="${PADX}" y="18" font-family="${FONT}" font-size="12" font-weight="bold" fill="${C.text}">${esc(opts.title)}</text>`);
  }

  // Unselected routes first so the newest one paints on top.
  for (const e of [...g.edges].sort((a, b) => (a.onSel ? 1 : 0) - (b.onSel ? 1 : 0))) {
    const a = pos(g.nodes[e.from]!), b = pos(g.nodes[e.to]!);
    const x1 = a.x + R, x2 = b.x - R, mx = (x1 + x2) / 2;
    const width = Math.max(e.onSel ? 2.5 : 0, 1.25 + 3 * (e.traces / Math.max(1, g.traces)));
    const dash = e.broken || e.unanswered ? ' stroke-dasharray="5 4"' : "";
    parts.push(
      `<path d="M${x1.toFixed(1)},${a.y} C${mx.toFixed(1)},${a.y} ${mx.toFixed(1)},${b.y} ${x2.toFixed(1)},${b.y}" fill="none" ` +
      `stroke="${pathEdgeColor(e)}" stroke-width="${width.toFixed(2)}"${dash} stroke-linecap="round" opacity="${e.onSel ? 1 : 0.35}"/>`,
    );
    if (e.broken && e.onSel) {
      const cx = (x1 + x2) / 2, cy = (a.y + b.y) / 2;
      parts.push(
        `<g stroke="${C.danger}" stroke-width="2.5" stroke-linecap="round">` +
        `<line x1="${cx - 5}" y1="${cy - 5}" x2="${cx + 5}" y2="${cy + 5}"/><line x1="${cx - 5}" y1="${cy + 5}" x2="${cx + 5}" y2="${cy - 5}"/></g>`,
      );
    }
  }

  for (const [k, n] of Object.entries(g.nodes)) {
    const p = pos(n);
    const h = n.hop ?? ({} as PathTraceHop);
    const rtt = hopRtt(h.rttMs);
    const opacity = n.onSel || k === "src" ? 1 : 0.45;
    let fill: string = C.paper, stroke: string = C.textSecondary, glyphColor: string = C.text, dashed = false;
    let strokeWidth = 1.5, glyph = "", name = "", sub = "";
    let extra = "";
    if (k === "src") {
      fill = C.accent; stroke = C.accent;
      name = source.hostname || "This host"; sub = "source";
      // ⌂ as a shape: a small white house.
      extra = `<path d="M${(p.x - 6).toFixed(1)},${p.y + 5} V${p.y - 1} L${p.x.toFixed(1)},${p.y - 7} L${(p.x + 6).toFixed(1)},${p.y - 1} V${p.y + 5} Z" fill="${C.paper}"/>`;
    } else if (k === "dst") {
      const sc = h.monitorStatus ? MONITOR_STATE_COLORS[h.monitorStatus] : undefined;
      fill = sc ?? C.paper; if (sc) stroke = sc;
      strokeWidth = 3;
      name = h.hostname || h.rdns || g.destIp || "Destination";
      sub = rtt ? `${round1(rtt.avg)} ms` : "destination";
      // ◎ as a shape: an inner ring.
      extra = `<circle cx="${p.x.toFixed(1)}" cy="${p.y}" r="5" fill="none" stroke="${sc ? C.paper : C.textSecondary}" stroke-width="2"/>`;
    } else if (!h.ip) {
      stroke = C.textTertiary; dashed = true; glyphColor = C.textTertiary;
      glyph = "*"; name = "no reply"; sub = `TTL ${n.ttl}`;
    } else {
      const sc = h.monitorStatus ? MONITOR_STATE_COLORS[h.monitorStatus] : undefined;
      if (sc) { fill = sc; stroke = sc; glyphColor = C.paper; }
      glyph = String(n.ttl);
      name = h.hostname || h.rdns || h.ip;
      sub = rtt ? `${round1(rtt.avg)} ms` : "—";
    }
    parts.push(
      `<g opacity="${opacity}">` +
      `<circle cx="${p.x.toFixed(1)}" cy="${p.y}" r="${R}" fill="${fill}" stroke="${stroke}" stroke-width="${strokeWidth}"${dashed ? ' stroke-dasharray="3 3"' : ""}/>` +
      extra +
      (glyph ? `<text x="${p.x.toFixed(1)}" y="${p.y + 4}" text-anchor="middle" font-family="${FONT}" font-size="11" font-weight="bold" fill="${glyphColor}">${esc(glyph)}</text>` : "") +
      `<text x="${p.x.toFixed(1)}" y="${p.y + R + 14}" text-anchor="middle" font-family="${FONT}" font-size="11" fill="${C.text}">${esc(clip(name))}</text>` +
      `<text x="${p.x.toFixed(1)}" y="${p.y + R + 27}" text-anchor="middle" font-family="${FONT}" font-size="10" fill="${C.textSecondary}">${esc(clip(sub))}</text>` +
      "</g>",
    );
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${Math.round(W)}" height="${H}" viewBox="0 0 ${Math.round(W)} ${H}">${parts.join("")}</svg>`;
}

/** One line for the plain-text body: the newest trace's route, hop by hop. */
export function pathGraphText(traces: PathTrace[], source: { hostname?: string | null }): string {
  const t = traces[0];
  if (!t) return "";
  const hops = [...(t.hops ?? [])].sort((a, b) => a.ttl - b.ttl);
  const names = hops.map((h) => {
    const rtt = hopRtt(h.rttMs);
    const label = h.hostname || h.rdns || h.ip || "*";
    return rtt ? `${label} (${round1(rtt.avg)} ms)` : label;
  });
  return [source.hostname || "source", ...names, ...(t.complete ? [] : ["✕ not reached"])].join(" → ");
}
