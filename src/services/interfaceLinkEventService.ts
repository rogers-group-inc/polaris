/**
 * src/services/interfaceLinkEventService.ts — an Event when a MONITORED
 * (pinned) interface comes up or goes down.
 *
 * "Came up" is the moment a link negotiates, so the up event carries what it
 * negotiated — speed and duplex — which is exactly what an operator chasing a
 * port that came back at 100 Mb/s half duplex needs to see in the log.
 *
 * Fed from every place pinned interface samples are produced, right beside
 * `enqueueInterfaceSamples`: the full system-info scrape and the fast pinned
 * re-walk (monitoringService) and the agent's interface push (routes/agents).
 * Only pinned rows reach those enqueue calls, so "monitored interface" means
 * `Asset.monitoredInterfaces` without a second filter here (the same pin rule
 * 57 makes the statement of what may alert).
 *
 * State is the last link state seen per (asset, ifName), held in memory:
 *   - the FIRST reading after a process start only seeds it, so a restart
 *     never writes a burst of "came up" events for links that were already up
 *     (and a change that happened while the process was down is not reported);
 *   - only "up" and the definite down states move it — "unknown", "dormant",
 *     "testing" and a null reading (a synthesized FortiOS row, an agent with no
 *     carrier reading) leave it where it was, so up → unknown → up is silent;
 *   - each process role keeps its own map, which is safe because one asset's
 *     interface stream comes from one producer (SNMP / REST scrapes on the
 *     monitor role, the agent push on the web role).
 *
 * These are audit events, not alerts: they are written during a maintenance
 * window too, and raising a notification about a port is the automation
 * engine's job (rule 36 / 57). They DO reach the event tail, so an operator
 * can build an event automation on `monitor.interface_up`.
 */

import { prisma } from "../db.js";
import { logger } from "../utils/logger.js";
import { logEventsBatch, type LogEventInput } from "./eventLogService.js";

export type LinkState = "up" | "down";

/** The fields of an interface sample row this service reads. */
export interface InterfaceLinkReading {
  assetId: string;
  ifName: string;
  operStatus: string | null;
  adminStatus: string | null;
  speedBps: bigint | number | null;
  duplex: string | null;
  alias: string | null;
}

export interface InterfaceLinkTransition {
  assetId: string;
  ifName: string;
  alias: string | null;
  from: LinkState;
  to: LinkState;
  operStatus: string;
  adminStatus: string | null;
  speedBps: number | null;
  duplex: string | null;
}

/** IF-MIB oper states that mean the link is definitely not passing traffic. */
const DOWN_STATES = new Set(["down", "lowerLayerDown", "notPresent"]);

/** An entry not refreshed for this long belongs to an unpinned / renamed port. */
const STALE_MS = 24 * 60 * 60 * 1000;
const PRUNE_EVERY_MS = 60 * 60 * 1000;

const lastState = new Map<string, { state: LinkState; seenAt: number }>();
let lastPruneAt = 0;

/** Pure — map an oper status onto the two states that produce events. */
export function linkStateOf(operStatus: string | null | undefined): LinkState | null {
  if (operStatus === "up") return "up";
  if (operStatus && DOWN_STATES.has(operStatus)) return "down";
  return null;
}

function keyOf(assetId: string, ifName: string): string {
  return `${assetId}\u0000${ifName}`;
}

/**
 * Compare each reading with the last state for its interface, update the
 * state, and return the edges. Exported for tests; `nowMs` is injectable.
 */
export function detectInterfaceLinkTransitions(
  rows: readonly InterfaceLinkReading[],
  nowMs: number = Date.now(),
): InterfaceLinkTransition[] {
  const out: InterfaceLinkTransition[] = [];
  for (const r of rows) {
    const state = linkStateOf(r.operStatus);
    if (!state) continue;
    const key = keyOf(r.assetId, r.ifName);
    const prev = lastState.get(key);
    lastState.set(key, { state, seenAt: nowMs });
    if (!prev || prev.state === state) continue;
    out.push({
      assetId: r.assetId,
      ifName: r.ifName,
      alias: r.alias,
      from: prev.state,
      to: state,
      operStatus: r.operStatus as string,
      adminStatus: r.adminStatus,
      speedBps: state === "up" && r.speedBps != null && Number(r.speedBps) > 0 ? Number(r.speedBps) : null,
      duplex: state === "up" && (r.duplex === "full" || r.duplex === "half") ? r.duplex : null,
    });
  }
  if (nowMs - lastPruneAt >= PRUNE_EVERY_MS) {
    lastPruneAt = nowMs;
    for (const [k, v] of lastState) if (nowMs - v.seenAt > STALE_MS) lastState.delete(k);
  }
  return out;
}

/** Test hook — forget every remembered link state. */
export function _resetInterfaceLinkState(): void {
  lastState.clear();
  lastPruneAt = 0;
}

/** Pure — "1 Gbps", "2.5 Gbps", "100 Mbps", "10 Mbps", "1.2 kbps". */
export function formatLinkSpeed(bps: number): string {
  const units: Array<[number, string]> = [[1e12, "Tbps"], [1e9, "Gbps"], [1e6, "Mbps"], [1e3, "kbps"]];
  for (const [div, unit] of units) {
    if (bps >= div) {
      const v = bps / div;
      return `${Number.isInteger(v) ? v : Number(v.toFixed(1))} ${unit}`;
    }
  }
  return `${bps} bps`;
}

/** Pure — the Event the transition is recorded as. */
export function interfaceLinkEvent(t: InterfaceLinkTransition, hostname: string | null): LogEventInput {
  const device = hostname || t.assetId;
  const port = t.alias && t.alias !== t.ifName ? `${t.ifName} (${t.alias})` : t.ifName;
  let message: string;
  let level: "info" | "warning";
  if (t.to === "up") {
    const speed = t.speedBps != null ? formatLinkSpeed(t.speedBps) : "speed unknown";
    const duplex = t.duplex ? `${t.duplex} duplex` : "duplex unknown";
    message = `Interface ${port} on ${device} came up — ${speed}, ${duplex}`;
    level = "info";
  } else {
    // An operator shutting the port is deliberate, not a fault.
    const adminDown = t.adminStatus === "down";
    message = `Interface ${port} on ${device} went down` + (adminDown ? " (administratively down)" : "");
    level = adminDown ? "info" : "warning";
  }
  return {
    action: t.to === "up" ? "monitor.interface_up" : "monitor.interface_down",
    level,
    resourceType: "asset",
    resourceId: t.assetId,
    resourceName: hostname ?? undefined,
    message,
    details: {
      ifName: t.ifName,
      alias: t.alias,
      previousState: t.from,
      operStatus: t.operStatus,
      adminStatus: t.adminStatus,
      speedBps: t.speedBps,
      duplex: t.duplex,
    },
  };
}

/**
 * Detect edges in a batch of pinned-interface readings and write one Event
 * per edge. Never throws — it runs fire-and-forget beside the sample enqueue
 * and must not break a scrape. Costs nothing on the common path: the asset
 * lookup and the write only happen when a link actually changed.
 */
export async function recordInterfaceLinkEvents(rows: readonly InterfaceLinkReading[]): Promise<void> {
  try {
    const transitions = detectInterfaceLinkTransitions(rows);
    if (transitions.length === 0) return;
    const assetIds = [...new Set(transitions.map((t) => t.assetId))];
    const assets = await prisma.asset.findMany({
      where: { id: { in: assetIds } },
      select: { id: true, hostname: true },
    });
    const hostById = new Map(assets.map((a) => [a.id, a.hostname]));
    await logEventsBatch(transitions.map((t) => interfaceLinkEvent(t, hostById.get(t.assetId) ?? null)));
  } catch (err) {
    logger.warn({ err: (err as Error)?.message }, "interface link event write failed");
  }
}
