/**
 * src/services/presenceVerificationService.ts
 *
 * Post-discovery network-presence verification for assets discovered by the
 * AD / Entra ID / Azure Arc integrations. Directory timestamps (Entra
 * lastSyncDateTime, AD lastLogonTimestamp) are activity signals, not network
 * presence — an Intune sync can come from anywhere on the internet — so they
 * no longer write Asset.lastSeen. (Arc is the partial exception: its
 * status="Connected" is a live heartbeat read at scrape time, so the sync
 * does stamp lastSeen from it, which usually makes step 1 below hit for Arc
 * assets.) This pass establishes presence instead, checking
 * signals cheapest-first per asset; the first fresh one wins:
 *
 *   1. Already fresh — Asset.lastSeen within the window (e.g. FortiGate
 *      discovery sighted the device on the wire). Free, no query.
 *   2. Agent heartbeat — ManagedAgent.lastSeenAt fresh → lastSeen advances
 *      to the heartbeat time (source "agent").
 *   3. Monitor probe — asset monitored and answering (monitorStatus up /
 *      recovering) with a fresh lastMonitorAt → source "probe".
 *   4. ICMP fallback — one system-ping echo against the DNS name (the
 *      stored ipAddress is often stale for directory-discovered assets).
 *      Success → lastSeen = now (source "ping"). FAILURE WRITES NOTHING —
 *      Windows firewall profiles commonly drop ICMP and Entra-joined
 *      laptops are legitimately off-LAN; absence of pong is not evidence
 *      of absence.
 *
 * Scale guardrails (the 2000-asset check): steps 1–3 cost one findMany for
 * the whole fleet; only step 4 fans out, with bounded concurrency, a short
 * per-ping timeout, and a hard pass deadline. Skipped pings are counted and
 * reported — no silent caps. lastSeen writes are batched via $transaction.
 *
 * Gated per integration by `config.verifyPresence` (default ON — read-only
 * against the targets); the toggle lives on the AD/Entra Monitoring tab.
 */

import { chunkArray } from "../utils/chunk.js";
import { prisma } from "../db.js";
import { logger } from "../utils/logger.js";
import { logEvent } from "./eventLogService.js";
import { bumpLastSeen } from "../utils/assetInvariants.js";
import { pingHost } from "../utils/icmpPing.js";

const PING_TIMEOUT_MS = 2_000;
const PING_CONCURRENCY = 16;
const PASS_DEADLINE_MS = 3 * 60_000;
// Freshness floor — pollInterval is hours (1–24), so this only binds when a
// caller passes something degenerate.
const MIN_WINDOW_MS = 60 * 60_000;
const WRITE_CHUNK = 200;

/** Slim asset shape the signal cascade needs. */
export interface PresenceCandidate {
  lastSeen: Date | null;
  monitored: boolean;
  monitorStatus: string | null;
  lastMonitorAt: Date | null;
  managedAgent: { lastSeenAt: Date | null } | null;
}

export type PresenceSignal =
  | { kind: "fresh" }
  | { kind: "agent"; evidenceAt: Date }
  | { kind: "probe"; evidenceAt: Date }
  | { kind: "ping" };

/**
 * Classify which presence signal applies to a candidate, cheapest-first.
 * Pure — `freshFloorMs` is the epoch-ms cutoff of the freshness window.
 * "ping" means no free signal was fresh and the asset falls through to the
 * ICMP queue.
 */
export function classifyPresenceSignal(a: PresenceCandidate, freshFloorMs: number): PresenceSignal {
  if (a.lastSeen && a.lastSeen.getTime() >= freshFloorMs) return { kind: "fresh" };
  const agentSeen = a.managedAgent?.lastSeenAt;
  if (agentSeen && agentSeen.getTime() >= freshFloorMs) return { kind: "agent", evidenceAt: agentSeen };
  // "passive" is deliberately absent here and needs no branch: a passive asset
  // is still probed, and a SUCCESSFUL probe bumps lastSeen (business rule 12),
  // so an answering passive device short-circuits at the `fresh` check above and
  // never reaches this test. One whose lastSeen has gone stale genuinely has no
  // probe evidence to offer and should fall through to the ping, which it does.
  if (
    a.monitored &&
    (a.monitorStatus === "up" || a.monitorStatus === "recovering") &&
    a.lastMonitorAt &&
    a.lastMonitorAt.getTime() >= freshFloorMs
  ) {
    return { kind: "probe", evidenceAt: a.lastMonitorAt };
  }
  return { kind: "ping" };
}

export interface PresenceVerificationSummary {
  candidates: number;
  alreadyFresh: number;
  viaAgent: number;
  viaProbe: number;
  viaPing: number;
  pingUnreachable: number;
  pingSkippedNoTarget: number;
  pingSkippedDeadline: number;
}

export async function runPresenceVerification(opts: {
  integrationId: string;
  integrationName: string;
  /** Integration.pollInterval (hours). Defines the freshness window. */
  pollIntervalHours: number;
  actor: string;
  signal?: AbortSignal;
}): Promise<PresenceVerificationSummary> {
  const startedAt = Date.now();
  const windowMs = Math.max((opts.pollIntervalHours || 0) * 3_600_000, MIN_WINDOW_MS);
  const freshFloorMs = startedAt - windowMs;

  // Candidates: assets this integration's directory sources discovered.
  // storage / decommissioned / disabled are expected off-network — skip.
  // maintenance is skipped too: a maintenance window pauses ALL server-driven
  // contact with the asset (including this presence ping), and its lastSeen
  // deliberately freezes for the duration.
  const candidates = await prisma.asset.findMany({
    where: {
      status: { in: ["active", "quarantined"] },
      sources: {
        some: {
          integrationId: opts.integrationId,
          // "arc" included so Arc-only assets are candidates too. In practice
          // most of them classify as "fresh" without a ping: the sync already
          // stamped lastSeen from a Connected heartbeat, which collapses the
          // ping queue at fleet scale.
          // "generic-api": a Generic API feed is an inventory claim and never
          // writes lastSeen (rule 12), so presence is established here the
          // way it is for a directory.
          sourceKind: { in: ["ad", "entra", "intune", "arc", "generic-api"] },
        },
      },
    },
    select: {
      id: true,
      hostname: true,
      dnsName: true,
      ipAddress: true,
      lastSeen: true,
      monitored: true,
      monitorStatus: true,
      lastMonitorAt: true,
      managedAgent: { select: { lastSeenAt: true } },
    },
  });

  const summary: PresenceVerificationSummary = {
    candidates: candidates.length,
    alreadyFresh: 0,
    viaAgent: 0,
    viaProbe: 0,
    viaPing: 0,
    pingUnreachable: 0,
    pingSkippedNoTarget: 0,
    pingSkippedDeadline: 0,
  };
  if (candidates.length === 0) return summary;

  const updates: Array<{ id: string; data: Record<string, unknown> }> = [];
  const pingQueue: typeof candidates = [];

  for (const a of candidates) {
    const signal = classifyPresenceSignal(a, freshFloorMs);
    if (signal.kind === "fresh") {
      summary.alreadyFresh++;
    } else if (signal.kind === "agent" || signal.kind === "probe") {
      const data: Record<string, unknown> = {};
      if (bumpLastSeen(data, a, signal.evidenceAt, signal.kind)) updates.push({ id: a.id, data });
      if (signal.kind === "agent") summary.viaAgent++;
      else summary.viaProbe++;
    } else {
      pingQueue.push(a);
    }
  }

  // ICMP fallback — bounded worker pool over the remainder.
  if (pingQueue.length > 0) {
    const deadline = startedAt + PASS_DEADLINE_MS;
    let cursor = 0;
    const worker = async (): Promise<void> => {
      for (;;) {
        if (opts.signal?.aborted) return;
        const i = cursor++;
        if (i >= pingQueue.length) return;
        const a = pingQueue[i];
        if (Date.now() > deadline) {
          summary.pingSkippedDeadline++;
          continue;
        }
        // DNS name first — the stored ipAddress on directory-discovered
        // assets is frequently stale (DHCP churn the directory never sees).
        const target = (a.dnsName || a.hostname || a.ipAddress || "").trim();
        if (!target) {
          summary.pingSkippedNoTarget++;
          continue;
        }
        const r = await pingHost(target, PING_TIMEOUT_MS);
        if (r.success) {
          const data: Record<string, unknown> = {};
          if (bumpLastSeen(data, a, new Date(), "ping")) updates.push({ id: a.id, data });
          summary.viaPing++;
        } else {
          summary.pingUnreachable++;
        }
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(PING_CONCURRENCY, pingQueue.length) }, () => worker()),
    );
  }

  for (const chunk of chunkArray(updates, WRITE_CHUNK)) {
    await prisma.$transaction(
      chunk.map((u) => prisma.asset.update({ where: { id: u.id }, data: u.data })),
    );
  }

  const tookMs = Date.now() - startedAt;
  logger.info(
    { integrationId: opts.integrationId, ...summary, tookMs },
    `Presence verification for "${opts.integrationName}" complete`,
  );
  logEvent({
    action: "integration.presence_verification",
    resourceType: "integration",
    resourceId: opts.integrationId,
    resourceName: opts.integrationName,
    actor: opts.actor,
    level: summary.pingSkippedDeadline > 0 ? "warning" : "info",
    message:
      `Presence verification for "${opts.integrationName}" — ${summary.candidates} candidate(s): ` +
      `${summary.alreadyFresh} already fresh, ${summary.viaAgent} via agent heartbeat, ` +
      `${summary.viaProbe} via monitor probe, ${summary.viaPing} via ping; ` +
      `${summary.pingUnreachable} unreachable (unchanged)` +
      (summary.pingSkippedNoTarget > 0 ? `, ${summary.pingSkippedNoTarget} skipped (no target)` : "") +
      (summary.pingSkippedDeadline > 0 ? `, ${summary.pingSkippedDeadline} skipped (pass deadline)` : ""),
    details: { ...summary, tookMs },
  });

  return summary;
}
