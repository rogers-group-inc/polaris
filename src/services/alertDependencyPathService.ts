/**
 * src/services/alertDependencyPathService.ts — the dependency-path diagram in a
 * dependency-down alert email (`{dependency.path}`, business rule 78).
 *
 * "PLC-7 is unreachable because SW-PLANT-3 is down" names two devices. A plant
 * operator reading it on a phone wants the rest: which boxes sit between the
 * dark one and theirs, and WHERE each of them is — the junction box, the room,
 * the shack. This draws the chain the engine blamed, root cause on the left and
 * the alerting device on the right, grouped into the same location boxes the
 * Device Map draws (a:/b:/f:/r:/jb: codes, `utils/locationCodes`), with the
 * link ports on each edge where LLDP knows them.
 *
 * Only the CHAIN — nothing beside it. The map shows a whole site; an email
 * about one device must not make the reader find it among forty others.
 *
 * At most FOUR devices are drawn (`MAX_PATH_DEVICES`). A longer chain keeps the
 * two at each end — the root cause and the one below it, the upstream device
 * and the alerting device — and replaces the middle with a "+N more" gap. The
 * ends are the two questions the email answers (what broke, what it broke);
 * the middle is the asset page's job.
 *
 * Which devices, and why each is blamed, is the FIRE-TIME snapshot
 * (`Notification.dependencyBlame.chain`): the diagram must agree with the
 * sentence above it, and that sentence was written at fire. What is read at
 * DELIVERY is only what the snapshot does not carry — each device's location
 * codes and the LLDP port names — the same way the charts and the LLDP block
 * are. A row written before `chain` existed still draws: its two named ends,
 * with the gap counted from `hops`.
 *
 * Location boxes nest two levels: the AREA as a band across the devices that
 * share it, and inside it the most specific code each device carries (junction
 * box, then room, floor, building). A device with no codes at all sits in a
 * GENERIC box labelled with its Location field, or "No location codes" — the
 * operator's call (2026-10-02, "generic box for now"); boxes never span the gap.
 *
 * Geometry is fixed: one column per device, labels shortened to the column
 * rather than measured, because resvg has no text metrics here and an email
 * client must get a predictable 520px image. Rasterized at 2x so the 9–11px
 * labels stay legible on a phone. Every failure degrades — no snapshot, no
 * chain, an unreadable asset, a missing native resvg binding — to the text
 * chain, or to nothing; it never stops the alert from sending.
 */

import { prisma } from "../db.js";
import { logger } from "../utils/logger.js";
import { escapeHtml } from "../utils/notificationTemplate.js";
import {
  hasLocationCodes,
  locationGroupKey,
  resolveEffectiveLocation,
  type LocationCodes,
} from "../utils/locationCodes.js";
import type { DependencyBlameReason } from "./dependencyTreeService.js";
import type { InlineAttachment } from "./notificationChannels/emailChannel.js";

export const DEPENDENCY_PATH_TOKENS = ["dependency.path"] as const;
export type DependencyPathToken = (typeof DEPENDENCY_PATH_TOKENS)[number];

/** Most devices the diagram draws; a longer chain keeps two at each end. */
export const MAX_PATH_DEVICES = 4;

export const DEPENDENCY_PATH_CID = "polaris-dependency-path@polaris";

/** Why a drawn device is on the path — the blame reason, or the alert's own device. */
export type PathNodeRole = DependencyBlameReason | "alerting";

/** One device the diagram can draw. */
export interface PathNode {
  id: string | null;
  hostname: string | null;
  role: PathNodeRole;
  /** Effective location codes (null = none known). */
  codes: LocationCodes | null;
  /** The asset's Location field — the generic box's label. */
  location: string | null;
}

/** A drawn slot: a device, or the gap standing in for `hidden` devices. */
export type PathEntry = { kind: "node"; node: PathNode } | { kind: "gap"; hidden: number };

/** Port names on the link between two adjacent drawn devices (left = parent). */
export interface PathLink {
  parentPort: string | null;
  childPort: string | null;
}

export interface DependencyPathSpec {
  entries: PathEntry[];
  /** `links[i]` joins `entries[i]` and `entries[i + 1]` (null across a gap or when unknown). */
  links: Array<PathLink | null>;
  /** The engine's walk stopped before reaching a device down in its own right. */
  truncated: boolean;
}

/** The snapshot shape the engine writes (and older rows' subset of it). */
interface BlameSnapshotNode { id?: unknown; hostname?: unknown; reason?: unknown }
interface BlameSnapshot {
  upstream?: BlameSnapshotNode | null;
  rootCause?: BlameSnapshotNode | null;
  chain?: BlameSnapshotNode[] | null;
  hops?: unknown;
  truncated?: unknown;
}

const REASONS: ReadonlySet<string> = new Set(["down", "maintenance", "dependency_test", "suppressed"]);

function snapNode(n: BlameSnapshotNode | null | undefined, fallbackReason: DependencyBlameReason): PathNode | null {
  if (!n || typeof n !== "object") return null;
  const id = typeof n.id === "string" && n.id ? n.id : null;
  const hostname = typeof n.hostname === "string" && n.hostname ? n.hostname : null;
  if (!id && !hostname) return null;
  const role = typeof n.reason === "string" && REASONS.has(n.reason) ? (n.reason as DependencyBlameReason) : fallbackReason;
  return { id, hostname, role, codes: null, location: null };
}

/**
 * The drawn sequence, root cause first and the alerting device last, from a
 * `Notification.dependencyBlame` snapshot. Null when the snapshot names nobody
 * (the engine could not resolve the blame — the email says so in words, and an
 * arrow to an unnamed box would add nothing).
 *
 * Pure: the location codes are filled in afterwards.
 */
export function pathEntriesFromBlame(
  blame: unknown,
  alerting: { id: string | null; hostname: string | null },
): { entries: PathEntry[]; truncated: boolean } | null {
  if (!blame || typeof blame !== "object") return null;
  const b = blame as BlameSnapshot;
  const truncated = b.truncated === true;
  const self: PathNode = { id: alerting.id, hostname: alerting.hostname, role: "alerting", codes: null, location: null };

  // Upward walking order (upstream … root cause) → drawn order (root … upstream).
  let devices: Array<PathNode | null> | null = null;
  if (Array.isArray(b.chain) && b.chain.length > 0) {
    const chain = b.chain.map((n) => snapNode(n, "suppressed"));
    if (chain.every((n) => n !== null)) devices = [...chain].reverse();
  }
  if (!devices) {
    // A row written before the chain was snapshotted: its two named ends, and
    // `hops` says how many devices stood between them.
    const upstream = snapNode(b.upstream, "down");
    if (!upstream) return null;
    const root = snapNode(b.rootCause, "down");
    const hops = typeof b.hops === "number" && Number.isFinite(b.hops) ? Math.max(1, Math.floor(b.hops)) : 1;
    if (!root || root.id === upstream.id || hops <= 1) {
      devices = [upstream];
    } else {
      // The upstream device is suppressed by definition when it is not the root.
      upstream.role = "suppressed";
      devices = [root, ...Array<PathNode | null>(Math.max(0, hops - 2)).fill(null), upstream];
    }
  }
  const all: Array<PathNode | null> = [...devices, self];

  const entries: PathEntry[] = [];
  const pushNode = (n: PathNode | null) => {
    if (n) { entries.push({ kind: "node", node: n }); return; }
    const last = entries[entries.length - 1];
    if (last?.kind === "gap") last.hidden += 1;
    else entries.push({ kind: "gap", hidden: 1 });
  };
  if (all.length <= MAX_PATH_DEVICES) {
    all.forEach(pushNode);
  } else {
    const keep = MAX_PATH_DEVICES / 2;
    all.slice(0, keep).forEach(pushNode);
    entries.push({ kind: "gap", hidden: all.length - keep * 2 });
    all.slice(all.length - keep).forEach(pushNode);
    // An unknown middle device that landed next to the gap folds into it.
    for (let i = entries.length - 1; i > 0; i--) {
      const a = entries[i - 1];
      const c = entries[i];
      if (a.kind === "gap" && c.kind === "gap") { a.hidden += c.hidden; entries.splice(i, 1); }
    }
  }
  return { entries, truncated };
}

// ─── Location boxes ─────────────────────────────────────────────────────────

/** The Device Map's per-level box colours, darkened for the white email card. */
const BOX_STYLE = {
  area: { color: "#db2777", dashed: false },
  building: { color: "#0284c7", dashed: false },
  floor: { color: "#7c3aed", dashed: true },
  room: { color: "#16a34a", dashed: false },
  junctionBox: { color: "#d97706", dashed: true },
  generic: { color: "#9ca3af", dashed: true },
} as const;
type BoxKind = keyof typeof BOX_STYLE;

export const NO_LOCATION_LABEL = "No location codes";

/** The inner box a device sits in: its most specific non-area code, or the generic box. */
export function innerBoxOf(node: PathNode): { kind: BoxKind; label: string; key: string } | null {
  const c = node.codes;
  if (c && hasLocationCodes(c)) {
    const label = c.junctionBox ?? c.room ?? c.floor ?? c.building;
    if (!label) return null; // area only — the band is the whole story
    const kind: BoxKind = c.junctionBox ? "junctionBox" : c.room ? "room" : c.floor ? "floor" : "building";
    // Identity is the whole code set below the area, so "jb:3" in two
    // different rooms is two boxes.
    const key = [c.building, c.floor, c.room, c.junctionBox].map((v) => (v ? locationGroupKey(v) : "")).join("|");
    return { kind, label, key: `codes:${key}` };
  }
  const label = node.location?.trim() || NO_LOCATION_LABEL;
  return { kind: "generic", label, key: `generic:${locationGroupKey(label)}` };
}

/** Runs of consecutive drawn slots sharing a key. A gap slot (null key) breaks every run. */
export function runsOf(keys: Array<string | null>): Array<{ start: number; end: number; key: string }> {
  const out: Array<{ start: number; end: number; key: string }> = [];
  keys.forEach((k, i) => {
    const last = out[out.length - 1];
    if (k === null) return;
    if (last && last.key === k && last.end === i - 1) last.end = i;
    else out.push({ start: i, end: i, key: k });
  });
  return out;
}

// ─── SVG ────────────────────────────────────────────────────────────────────

const W = 520;
const H = 150;
const MARGIN = 6;
const GAP_W = 64;
const MAX_SLOT_W = 168;
const NODE_Y = 76;
const NODE_R = 15;
const FONT = "Helvetica,Arial,sans-serif";

const ROLE_STYLE: Record<PathNodeRole, { ring: string; caption: string; captionColor: string }> = {
  // The red ring already says "this is where it broke"; the caption says how.
  down: { ring: "#d32f2f", caption: "Root cause", captionColor: "#b91c1c" },
  maintenance: { ring: "#d32f2f", caption: "In maintenance", captionColor: "#b91c1c" },
  dependency_test: { ring: "#d32f2f", caption: "Dependency test", captionColor: "#b91c1c" },
  suppressed: { ring: "#9ca3af", caption: "Dep. Down", captionColor: "#6b7280" },
  alerting: { ring: "#2563eb", caption: "This alert", captionColor: "#1d4ed8" },
};

function esc(s: string): string {
  return s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

/** Shorten to a character budget — a deliberate over-estimate of glyph width (0.6em). */
export function fitText(s: string, widthPx: number, fontPx: number): string {
  const max = Math.max(3, Math.floor(widthPx / (fontPx * 0.6)));
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

/**
 * A label that must stay whole if it can: step the font down (11 → 9px) before
 * shortening, since a hostname cut to "PLANT-SW-DIST…" no longer names a device.
 */
export function fitLabel(s: string, widthPx: number, fontPx = 11, minFontPx = 9): { text: string; fontPx: number } {
  for (let f = fontPx; f >= minFontPx; f--) {
    if (s.length <= Math.floor(widthPx / (f * 0.6))) return { text: s, fontPx: f };
  }
  return { text: fitText(s, widthPx, minFontPx), fontPx: minFontPx };
}

function portLabel(link: PathLink | null): string | null {
  if (!link || (!link.parentPort && !link.childPort)) return null;
  return `${link.parentPort ?? "?"} ↔ ${link.childPort ?? "?"}`;
}

/** The diagram as a standalone SVG string (520 × 150). */
export function dependencyPathSvg(spec: DependencyPathSpec): string {
  const { entries, links } = spec;
  const nodeCount = entries.filter((e) => e.kind === "node").length;
  const gapCount = entries.length - nodeCount;
  const slotW = Math.min(MAX_SLOT_W, (W - 2 * MARGIN - gapCount * GAP_W) / Math.max(1, nodeCount));
  const rowW = slotW * nodeCount + GAP_W * gapCount;
  const left0 = (W - rowW) / 2;
  const slotLeft: number[] = [];
  const slotWidth: number[] = [];
  let x = left0;
  for (const e of entries) {
    slotLeft.push(x);
    const w = e.kind === "node" ? slotW : GAP_W;
    slotWidth.push(w);
    x += w;
  }
  const cx = (i: number) => slotLeft[i] + slotWidth[i] / 2;
  const parts: string[] = [];

  // Area bands, then inner boxes, then edges, then nodes — later draws on top.
  const areaKeys = entries.map((e) => (e.kind === "node" && e.node.codes?.area ? `area:${locationGroupKey(e.node.codes.area)}` : null));
  for (const run of runsOf(areaKeys)) {
    const first = entries[run.start] as Extract<PathEntry, { kind: "node" }>;
    const bx = slotLeft[run.start] + 1;
    const bw = slotLeft[run.end] + slotWidth[run.end] - 1 - bx;
    const st = BOX_STYLE.area;
    parts.push(
      `<rect x="${bx.toFixed(1)}" y="3" width="${bw.toFixed(1)}" height="${H - 6}" rx="8" fill="none" stroke="${st.color}" stroke-width="1.2"/>`,
      `<text x="${(bx + bw / 2).toFixed(1)}" y="16" text-anchor="middle" font-family="${FONT}" font-size="11" font-weight="bold" fill="${st.color}">${esc(fitText(first.node.codes!.area!, bw - 8, 11))}</text>`,
    );
  }
  const boxes = entries.map((e) => (e.kind === "node" ? innerBoxOf(e.node) : null));
  for (const run of runsOf(boxes.map((b) => b?.key ?? null))) {
    const box = boxes[run.start]!;
    const bx = slotLeft[run.start] + 6;
    const bw = slotLeft[run.end] + slotWidth[run.end] - 6 - bx;
    const st = BOX_STYLE[box.kind];
    parts.push(
      `<rect x="${bx.toFixed(1)}" y="24" width="${bw.toFixed(1)}" height="${H - 32}" rx="6" fill="none" stroke="${st.color}" stroke-width="1.2"${st.dashed ? ' stroke-dasharray="4 3"' : ""}/>`,
      `<text x="${(bx + bw / 2).toFixed(1)}" y="38" text-anchor="middle" font-family="${FONT}" font-size="10" font-weight="bold" fill="${st.color}">${esc(fitText(box.label, bw - 8, 10))}</text>`,
    );
  }

  for (let i = 0; i + 1 < entries.length; i++) {
    const a = entries[i];
    const b = entries[i + 1];
    const x1 = cx(i) + (a.kind === "node" ? NODE_R + 2 : 10);
    const x2 = cx(i + 1) - (b.kind === "node" ? NODE_R + 3 : 10);
    if (a.kind === "gap" || b.kind === "gap") {
      parts.push(`<line x1="${x1.toFixed(1)}" y1="${NODE_Y}" x2="${x2.toFixed(1)}" y2="${NODE_Y}" stroke="#93a3b8" stroke-width="1.5" stroke-dasharray="3 3"/>`);
      continue;
    }
    parts.push(
      `<line x1="${x1.toFixed(1)}" y1="${NODE_Y}" x2="${(x2 - 5).toFixed(1)}" y2="${NODE_Y}" stroke="#3b82f6" stroke-width="1.8"/>`,
      `<polygon points="${x2.toFixed(1)},${NODE_Y} ${(x2 - 7).toFixed(1)},${NODE_Y - 4} ${(x2 - 7).toFixed(1)},${NODE_Y + 4}" fill="#3b82f6"/>`,
    );
    const label = portLabel(links[i]);
    if (label) {
      const mid = (x1 + x2) / 2;
      // A white halo, so a label crossing a location box border stays legible.
      parts.push(`<text x="${mid.toFixed(1)}" y="${NODE_Y - 7}" text-anchor="middle" font-family="${FONT}" font-size="9" fill="#4b5563" stroke="#ffffff" stroke-width="3" stroke-linejoin="round" paint-order="stroke">${esc(fitText(label, x2 - x1, 9))}</text>`);
    }
  }

  entries.forEach((e, i) => {
    const c = cx(i);
    if (e.kind === "gap") {
      parts.push(
        `<rect x="${(c - 15).toFixed(1)}" y="${NODE_Y - 7}" width="30" height="14" rx="7" fill="#ffffff" stroke="#93a3b8" stroke-width="1"/>`,
        ...[-7, 0, 7].map((dx) => `<circle cx="${(c + dx).toFixed(1)}" cy="${NODE_Y}" r="1.8" fill="#64748b"/>`),
        `<text x="${c.toFixed(1)}" y="${NODE_Y + 24}" text-anchor="middle" font-family="${FONT}" font-size="10" fill="#6b7280">+${e.hidden} more</text>`,
      );
      return;
    }
    const st = ROLE_STYLE[e.node.role];
    const name = fitLabel(e.node.hostname ?? "(unnamed device)", slotW - 6);
    parts.push(
      `<circle cx="${c.toFixed(1)}" cy="${NODE_Y}" r="${NODE_R}" fill="#f3f4f6" stroke="${st.ring}" stroke-width="3"/>`,
      `<circle cx="${c.toFixed(1)}" cy="${NODE_Y}" r="4" fill="${st.ring}"/>`,
      `<text x="${c.toFixed(1)}" y="${NODE_Y + NODE_R + 15}" text-anchor="middle" font-family="${FONT}" font-size="${name.fontPx}"${e.node.role === "alerting" ? ' font-weight="bold"' : ""} fill="#1f2430">${esc(name.text)}</text>`,
      `<text x="${c.toFixed(1)}" y="${NODE_Y + NODE_R + 29}" text-anchor="middle" font-family="${FONT}" font-size="10" fill="${st.captionColor}">${esc(fitText(st.caption, slotW - 14, 10))}</text>`,
    );
  });

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">` +
    `<rect width="${W}" height="${H}" fill="#ffffff"/>` +
    parts.join("") +
    "</svg>"
  );
}

// ─── Text form ──────────────────────────────────────────────────────────────

function whereOf(n: PathNode): string | null {
  const c = n.codes;
  if (c && hasLocationCodes(c)) {
    const inner = c.junctionBox ?? c.room ?? c.floor ?? c.building;
    return [c.area, inner].filter(Boolean).join(" / ") || null;
  }
  return n.location?.trim() || null;
}

/**
 * The chain on one line, for the plain-text body and the image's alt text:
 * "Dependency path  SW-1 [Mine / JB-3] (down) → … +2 more → PLC-7 [Mine / Room 4] (this alert)".
 * No colon anywhere — `pruneEmptyTextLines` deletes a "Label:" line with nothing after it.
 */
export function dependencyPathText(spec: DependencyPathSpec): string {
  const parts = spec.entries.map((e) => {
    if (e.kind === "gap") return `… +${e.hidden} more`;
    const where = whereOf(e.node);
    const role = e.node.role === "alerting" ? "this alert"
      : e.node.role === "suppressed" ? "dep. down"
      : e.node.role === "dependency_test" ? "dependency test"
      : e.node.role;
    return `${e.node.hostname ?? "(unnamed device)"}${where ? ` [${where}]` : ""} (${role})`;
  });
  return `Dependency path  ${parts.join(" → ")}`;
}

// ─── Delivery-time loading ──────────────────────────────────────────────────

/** LLDP port-id subtypes that carry a port NAME (topologyGraphService's set). */
const PORT_ID_NAME_SUBTYPES = new Set(["interfaceName", "interfaceAlias", "agentCircuitId", "local"]);
/** collectLldpNeighborsSnmp's ifIndex fallback — never a real port name. */
const SYNTHETIC_PORT_RE = /^port-\d+$/i;

export interface LldpPortRow {
  assetId: string;
  matchedAssetId: string | null;
  localIfName: string;
  portId: string | null;
  portIdSubtype: string | null;
}

/**
 * `a`'s port facing `b`: `a`'s own LLDP row naming `b` (authoritative), else
 * `b`'s row naming `a`, whose remote port id is `a`'s port when its subtype is
 * a name. The Device Map's edge-label rule, so the two read the same.
 */
export function portFacing(rows: LldpPortRow[], a: string, b: string): string | null {
  const own = rows.find((r) => r.assetId === a && r.matchedAssetId === b && r.localIfName && !SYNTHETIC_PORT_RE.test(r.localIfName));
  if (own) return own.localIfName;
  const peer = rows.find((r) =>
    r.assetId === b && r.matchedAssetId === a && r.portId && r.portIdSubtype &&
    PORT_ID_NAME_SUBTYPES.has(r.portIdSubtype) && !SYNTHETIC_PORT_RE.test(r.portId));
  return peer?.portId ?? null;
}

/** The switch port in `lastSeenSwitch` ("FS-248E-01/port15") when it names `parentHostname`. */
export function lastSeenSwitchPort(lastSeenSwitch: string | null, parentHostname: string | null): string | null {
  if (!lastSeenSwitch || !parentHostname) return null;
  const slash = lastSeenSwitch.lastIndexOf("/");
  if (slash <= 0) return null;
  const sw = lastSeenSwitch.slice(0, slash).trim();
  const port = lastSeenSwitch.slice(slash + 1).trim();
  return port && sw.toLowerCase() === parentHostname.trim().toLowerCase() ? port : null;
}

function deviceDescriptionOf(topology: unknown): string | null {
  if (!topology || typeof topology !== "object") return null;
  const v = (topology as { deviceDescription?: unknown }).deviceDescription;
  return typeof v === "string" ? v : null;
}

/**
 * Fill each drawn device's location codes and each link's ports from the DB.
 * Two reads whatever the chain length — at most four assets, and the LLDP rows
 * among them. A read failure leaves the boxes generic and the edges unlabelled.
 */
async function hydrate(entries: PathEntry[]): Promise<Array<PathLink | null>> {
  const nodes = entries.flatMap((e) => (e.kind === "node" && e.node.id ? [e.node] : []));
  const ids = Array.from(new Set(nodes.map((n) => n.id!)));
  const links: Array<PathLink | null> = entries.slice(1).map(() => null);
  if (ids.length === 0) return links;
  try {
    const [assets, lldp] = await Promise.all([
      prisma.asset.findMany({
        where: { id: { in: ids } },
        select: { id: true, hostname: true, location: true, description: true, fortinetTopology: true, lastSeenSwitch: true },
      }),
      ids.length > 1
        ? prisma.assetLldpNeighbor.findMany({
            where: { assetId: { in: ids }, matchedAssetId: { in: ids } },
            select: { assetId: true, matchedAssetId: true, localIfName: true, portId: true, portIdSubtype: true },
          })
        : Promise.resolve([] as LldpPortRow[]),
    ]);
    const byId = new Map(assets.map((a) => [a.id, a]));
    for (const n of nodes) {
      const a = byId.get(n.id!);
      if (!a) continue;
      n.codes = resolveEffectiveLocation({ description: a.description, deviceDescription: deviceDescriptionOf(a.fortinetTopology) });
      n.location = a.location;
      // The snapshot's name is the fire-time one; a renamed device reads as it is now.
      n.hostname = a.hostname ?? n.hostname;
    }
    for (let i = 0; i + 1 < entries.length; i++) {
      const p = entries[i];
      const c = entries[i + 1];
      if (p.kind !== "node" || c.kind !== "node" || !p.node.id || !c.node.id) continue;
      const parentPort = portFacing(lldp, p.node.id, c.node.id)
        ?? lastSeenSwitchPort(byId.get(c.node.id)?.lastSeenSwitch ?? null, p.node.hostname);
      const childPort = portFacing(lldp, c.node.id, p.node.id);
      links[i] = parentPort || childPort ? { parentPort, childPort } : null;
    }
  } catch (err) {
    logger.debug({ err: (err as Error)?.message }, "dependency path read failed — drawing without locations");
  }
  return links;
}

/** Invented locations for a test alert's path (business rule 65 — "Example"-prefixed). */
const SAMPLE_CODES: LocationCodes = { area: "Example Area", building: null, floor: null, room: null, junctionBox: "Example Cabinet" };

export interface DependencyPathNotification {
  assetId: string | null;
  assetHostname: string | null;
  dependencyDown: boolean;
  dependencyBlame: unknown;
  testRun: boolean;
}

/** The spec for one alert, or null when it is not a dependency-down alert or names nobody. */
export async function loadDependencyPath(n: DependencyPathNotification): Promise<DependencyPathSpec | null> {
  if (!n.dependencyDown) return null;
  const seq = pathEntriesFromBlame(n.dependencyBlame, { id: n.assetId, hostname: n.assetHostname });
  if (!seq) return null;
  if (n.testRun) {
    // A test alert is about an invented device: nothing to read, and real
    // location codes must not appear in it.
    for (const e of seq.entries) if (e.kind === "node") e.node.codes = { ...SAMPLE_CODES };
    return { entries: seq.entries, links: seq.entries.slice(1).map(() => null), truncated: seq.truncated };
  }
  const links = await hydrate(seq.entries);
  return { entries: seq.entries, links, truncated: seq.truncated };
}

async function rasterize(svg: string): Promise<Buffer | null> {
  try {
    // Lazy import, as alertChartService does: resvg resolves a per-platform
    // native binding, and an alert must still send on a host without it.
    const { Resvg } = await import("@resvg/resvg-js");
    return Buffer.from(new Resvg(svg, { fitTo: { mode: "zoom", value: 2 } }).render().asPng());
  } catch (err) {
    logger.warn({ err: (err as Error)?.message }, "dependency path rasterization failed — falling back to text");
    return null;
  }
}

/** Both rendered forms: a complete `<tr>` block (or "") and the text line (or ""). */
export function renderDependencyPathBlocks(spec: DependencyPathSpec | null, png: Buffer | null): {
  html: string;
  text: string;
  attachment: InlineAttachment | null;
} {
  if (!spec) return { html: "", text: "", attachment: null };
  const text = dependencyPathText(spec);
  const body = png
    ? `<img src="cid:${DEPENDENCY_PATH_CID}" width="520" alt="${esc(text)}" ` +
      'style="display:block;width:100%;max-width:520px;height:auto;border:1px solid #e5e7eb;border-radius:6px;margin:6px 0 0">'
    : `<p style="margin:6px 0 0;color:#374151;font-size:13px">${escapeHtml(text.replace(/^Dependency path\s+/, ""))}</p>`;
  const html = [
    '<tr><td style="padding:14px 22px 0">',
    '<div style="font-size:12px;letter-spacing:.06em;text-transform:uppercase;color:#6b7280;font-weight:700;margin-bottom:2px">Dependency path</div>',
    body,
    spec.truncated
      ? '<div style="font-size:12px;color:#6b7280;margin-top:6px">The walk stopped before reaching a device that is down in its own right.</div>'
      : "",
    "</td></tr>",
  ].filter(Boolean).join("\n");
  const attachment: InlineAttachment | null = png
    ? { cid: DEPENDENCY_PATH_CID, filename: "dependency-path.png", contentType: "image/png", content: png }
    : null;
  return { html, text, attachment };
}

/** The whole delivery-time step for one alert: one load, one render, both bodies. */
export async function buildDependencyPathBlocks(n: DependencyPathNotification): Promise<{
  html: string;
  text: string;
  attachment: InlineAttachment | null;
}> {
  const spec = await loadDependencyPath(n);
  const png = spec ? await rasterize(dependencyPathSvg(spec)) : null;
  return renderDependencyPathBlocks(spec, png);
}

const PATH_TOKEN_RE = /\{dependency\.path\}/g;

/** Do any of these templates reference `{dependency.path}`? */
export function dependencyPathTokensIn(...templates: Array<string | null | undefined>): Set<DependencyPathToken> {
  const found = new Set<DependencyPathToken>();
  for (const t of templates) {
    if (t && t.includes("{dependency.path}")) found.add("dependency.path");
  }
  return found;
}

/** Fill the token with the rendered block; an empty block removes it outright. */
export function substituteDependencyPathTokens(body: string, block: string): string {
  if (!body) return body;
  return body.replace(PATH_TOKEN_RE, () => block);
}
