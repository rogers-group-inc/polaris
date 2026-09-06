/**
 * src/services/alertInterfaceService.ts — the per-INTERFACE facts an alert
 * email needs when the thing that broke is one port.
 *
 * An "interface down" alert is not an alert about a device. The device is
 * usually fine — it is answering probes, which is how Polaris knows the port
 * is down at all — so the last hour of its CPU, memory and response time
 * (which is what `alertChartService` draws for every other alert) says nothing
 * about the fault and reads as filler. The question an operator actually opens
 * that email to answer is "what was plugged into port2", and the switch
 * already told us: LLDP.
 *
 * Two things make this work rather than merely sound reasonable:
 *
 *  - `AssetLldpNeighbor` is current-state and delete-replaced per scrape, so a
 *    dead port's neighbour would normally be gone by the time the alert is
 *    delivered. It isn't, because `persistLldpNeighbors` holds a vanished
 *    neighbour for a 48-hour STICKY window (LLDP_STICKY_WINDOW_MS) before
 *    deleting it — precisely so the operator-visible Neighbor column doesn't
 *    flap on a missed advertisement. That grace is what leaves an answer in
 *    the table for the port that just went down, and it is why the block
 *    always prints "Last advertised": the entry is by definition from BEFORE
 *    the outage, and an operator has to be able to see how long before.
 *
 *  - The lookup is keyed on the interface name the alert carries
 *    (`Notification.dimension`, which for the interface-dimensioned metrics is
 *    the bare ifName), widened through `fortiapInterfaceAliases` because a
 *    FortiAP's LLDP rows are normalized to whichever of lan1/eth0 its
 *    interface inventory reports. For a switch port the alias set is just the
 *    name itself, so nothing changes there.
 *
 * Rendered at DELIVERY time, alongside the charts and for the same reasons:
 * off the engine's hot path, and an escalation email at T+90min re-reads
 * rather than replaying a frozen snapshot. `{interface.lldp}` is therefore a
 * DEFERRED token (see notificationTemplate's isDeferredToken) — the compose
 * pass must leave it literal for this one to fill.
 *
 * The token expands to a COMPLETE block — its own `<tr>` and its own heading —
 * or to nothing at all. That is deliberate: an alert that isn't about an
 * interface, or a port with no neighbour, leaves no empty heading standing and
 * needs no pruning pass of its own.
 */

import { prisma } from "../db.js";
import { logger } from "../utils/logger.js";
import { escapeHtml, formatLocalTime } from "../utils/notificationTemplate.js";
import { factRow } from "../utils/alertEmailTemplate.js";
import { fortiapInterfaceAliases } from "../utils/fortiapInterfaceAlias.js";

/** The interface-facts tokens, resolved at delivery like `{chart.*}`. */
export const INTERFACE_TOKENS = ["interface.lldp"] as const;
export type InterfaceToken = (typeof INTERFACE_TOKENS)[number];

/**
 * Metrics whose `dimension` IS an interface name — the ones for which asking
 * "what is on this port" is a coherent question. The state trio comes from
 * ASSET_STATE_FIELDS, the rate quartet from ASSET_METRICS; both are keyed on
 * ifName by their resolvers in notificationEngine.
 *
 * Only used to skip a pointless query: a sensor alert's dimension is "TMP1",
 * which would match no LLDP row anyway.
 */
export const INTERFACE_DIMENSION_METRICS: ReadonlySet<string> = new Set([
  "ifOperStatus",
  "ifAdminStatus",
  "poeStatus",
  "ifInBps",
  "ifOutBps",
  "ifInErrorRate",
  "ifOutErrorRate",
]);

export function isInterfaceDimensionMetric(metric: string | null | undefined): boolean {
  return !!metric && INTERFACE_DIMENSION_METRICS.has(metric);
}

/** Neighbours past this are summarized as a count — a port advertising five
 *  peers is a hub or a mis-cabled trunk, and the email's job is to say so, not
 *  to inventory it. */
const MAX_NEIGHBORS = 4;

/** A long systemDescription is a whole firmware banner; keep the model half. */
const MAX_SYSTEM_DESC = 100;

export interface AlertLldpNeighbor {
  /** Best available name: the matched Polaris asset, else what LLDP said. */
  name: string;
  /** Asset type of the matched asset, when the neighbour is one we know. */
  matchedType: string | null;
  port: string | null;
  managementIp: string | null;
  capabilities: string[];
  systemDescription: string | null;
  lastSeen: Date;
}

/**
 * The LLDP neighbours on one interface, freshest first.
 *
 * Best-effort like every other delivery-time enrichment: a failed read logs
 * and yields nothing rather than holding up the alert.
 */
export async function loadInterfaceLldp(assetId: string, ifName: string): Promise<AlertLldpNeighbor[]> {
  try {
    const rows = await prisma.assetLldpNeighbor.findMany({
      // The alias set is the port itself for everything except a FortiAP,
      // whose rows may be stored under either spelling of the same NIC.
      where: { assetId, localIfName: { in: fortiapInterfaceAliases(ifName) } },
      orderBy: { lastSeen: "desc" },
      take: MAX_NEIGHBORS + 1,
      select: {
        chassisId: true,
        portId: true,
        portDescription: true,
        systemName: true,
        systemDescription: true,
        managementIp: true,
        capabilities: true,
        lastSeen: true,
        matchedAsset: { select: { hostname: true, ipAddress: true, assetType: true } },
      },
    });
    return rows.map((r) => ({
      // The matched asset's hostname first: it is the name the operator will
      // search Polaris for, where systemName is whatever the peer advertises.
      name: r.matchedAsset?.hostname || r.systemName || r.chassisId || "unidentified neighbor",
      matchedType: r.matchedAsset?.assetType ?? null,
      port:
        r.portDescription && r.portId
          ? `${r.portId} (${r.portDescription})`
          : r.portId || r.portDescription || null,
      managementIp: r.managementIp || r.matchedAsset?.ipAddress || null,
      capabilities: r.capabilities ?? [],
      systemDescription: truncateDesc(r.systemDescription),
      lastSeen: r.lastSeen,
    }));
  } catch (err) {
    logger.warn({ err: (err as Error)?.message, assetId, ifName }, "alert LLDP lookup failed — sending without it");
    return [];
  }
}

function truncateDesc(value: string | null): string | null {
  if (!value) return null;
  const flat = value.replace(/\s+/g, " ").trim();
  if (flat.length === 0) return null;
  return flat.length > MAX_SYSTEM_DESC ? `${flat.slice(0, MAX_SYSTEM_DESC).trimEnd()}…` : flat;
}

/**
 * Label / value pairs for one neighbour, empties already dropped.
 *
 * `timeZone` is the recipient's — this block is stitched into a body that is
 * already rendered in their zone, so "Last advertised" has to agree with the
 * "Raised" row above it. Null keeps the server's zone (a send with no
 * per-recipient zone, which is every send before User.timezone existed).
 */
function neighborFacts(n: AlertLldpNeighbor, timeZone: string | null): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  out.push(["Neighbor", n.matchedType ? `${n.name} (${n.matchedType})` : n.name]);
  if (n.port) out.push(["Neighbor port", n.port]);
  if (n.managementIp) out.push(["Management IP", n.managementIp]);
  if (n.capabilities.length > 0) out.push(["Capabilities", n.capabilities.join(", ")]);
  if (n.systemDescription) out.push(["Neighbor system", n.systemDescription]);
  // Always last, and never omitted: the entry predates the outage by
  // definition (see the 48h stickiness note at the top), so how stale it is
  // IS part of the finding.
  out.push(["Last advertised", formatLocalTime(n.lastSeen, timeZone)]);
  return out;
}

function heading(ifName: string, count: number): string {
  return `LLDP ${count === 1 ? "neighbor" : "neighbors"} on ${ifName}`;
}

/**
 * The block as the email carries it — a complete `<tr>` (HTML) or an indented
 * text stanza, or "" when the port advertised nothing.
 *
 * The text form deliberately uses NO colons. `pruneEmptyTextLines` drops any
 * "Label:" line with nothing after the colon, and a heading like "LLDP
 * neighbor on port2:" matches that shape exactly — it would delete its own
 * heading. Padded columns read the same and can't be mistaken for a fact row.
 */
export function renderInterfaceLldp(
  ifName: string,
  neighbors: AlertLldpNeighbor[],
  opts: { html: boolean; timeZone?: string | null },
): string {
  if (neighbors.length === 0) return "";
  const shown = neighbors.slice(0, MAX_NEIGHBORS);
  const extra = neighbors.length - shown.length;

  if (!opts.html) {
    const lines: string[] = [heading(ifName, shown.length)];
    shown.forEach((n, i) => {
      if (i > 0) lines.push("");
      for (const [label, value] of neighborFacts(n, opts.timeZone ?? null)) {
        lines.push(`  ${label.padEnd(16)}${value}`);
      }
    });
    if (extra > 0) lines.push(`  and ${extra} more on this port`);
    return lines.join("\n");
  }

  const blocks = shown
    .map((n, i) => {
      const rows = neighborFacts(n, opts.timeZone ?? null)
        .map(([label, value]) => factRow(escapeHtml(label), escapeHtml(value)))
        .join("\n");
      const sep =
        i > 0
          ? '<tr><td colspan="2" style="border-top:1px solid #e5e7eb;height:1px;line-height:1px;font-size:0;padding-top:8px">&nbsp;</td></tr>'
          : "";
      return sep + rows;
    })
    .join("\n");
  const more =
    extra > 0
      ? `<div style="font-size:12px;color:#6b7280;margin-top:6px">and ${extra} more on this port</div>`
      : "";

  return [
    '<tr><td style="padding:14px 22px 0">',
    `<div style="font-size:12px;letter-spacing:.06em;text-transform:uppercase;color:#6b7280;font-weight:700;margin-bottom:2px">${escapeHtml(heading(ifName, shown.length))}</div>`,
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="font-size:13px;color:#374151;border-collapse:collapse">',
    blocks,
    "</table>",
    more,
    "</td></tr>",
  ]
    .filter((s) => s.length > 0)
    .join("\n");
}

const LLDP_TOKEN_RE = /\{interface\.lldp\}/g;

/** Do any of these templates reference an `{interface.*}` token? */
export function interfaceTokensIn(...templates: Array<string | null | undefined>): Set<InterfaceToken> {
  const found = new Set<InterfaceToken>();
  for (const t of templates) {
    if (!t) continue;
    for (const token of INTERFACE_TOKENS) {
      if (t.includes(`{${token}}`)) found.add(token);
    }
  }
  return found;
}

/**
 * Fill `{interface.lldp}` with the rendered block. An empty block removes the
 * token outright — the same contract `substituteChartTokens` uses for a chart
 * with no samples, and what keeps a non-interface alert from mailing a heading
 * over nothing.
 *
 * The block is built per body (HTML vs text), so unlike the token values the
 * renderer interpolates there is nothing to escape here: `renderInterfaceLldp`
 * has already escaped every network-supplied string it put in its HTML form.
 */
export function substituteInterfaceTokens(body: string, block: string): string {
  if (!body) return body;
  return body.replace(LLDP_TOKEN_RE, block);
}

/**
 * The whole delivery-time step, for one alert: decide whether this alert is
 * about an interface at all, read the port's neighbours once, and render both
 * bodies from the one read.
 */
export async function buildInterfaceLldpBlocks(
  assetId: string | null,
  metric: string | null,
  dimension: string | null,
  timeZone: string | null = null,
): Promise<{ html: string; text: string }> {
  const empty = { html: "", text: "" };
  if (!assetId || !dimension || !isInterfaceDimensionMetric(metric)) return empty;
  const neighbors = await loadInterfaceLldp(assetId, dimension);
  if (neighbors.length === 0) return empty;
  return {
    html: renderInterfaceLldp(dimension, neighbors, { html: true, timeZone }),
    text: renderInterfaceLldp(dimension, neighbors, { html: false, timeZone }),
  };
}
