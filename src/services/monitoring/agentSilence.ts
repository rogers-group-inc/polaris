/**
 * src/services/monitoring/agentSilence.ts — agent silence (business rule 86; CQ-B061, moved verbatim from monitoringService.ts):
 * when an agent-monitored asset last had its agent listening, from a short-lived cache of
 * the fleet's liveness, so a dead agent host reads as a probe miss rather than `up`.
 */

import { prisma } from "../../db.js";
import { AGENT_REPORTING_STATUSES } from "../../utils/agentSilence.js";

// ─── Agent silence (business rule 86) ──────────────────────────────────────
//
// The silence clock for an agent-mode asset never starts before this process
// was listening: its boot, or the last time the whole fleet was seen dark
// (Polaris could not receive, so nobody's silence counted). See
// src/utils/agentSilence.ts for the verdict itself.
export let agentListeningSince = new Date();

/** The fleet went dark: restart every agent-mode silence clock from `at`.
 *  probeAsset (monitoring/probes.ts) writes the clock through this — an ES
 *  module cannot assign another module's `let`, though it reads it live. */
export function restartAgentListening(at: Date): void {
  agentListeningSince = at;
}

// Freshest lastSeenAt across every agent expected to report, plus how many
// there are. One aggregate over ManagedAgent, cached briefly: a silence check
// only runs on an OVERDUE agent-mode asset, but at 2000 agents a dead site can
// make hundreds of them due in one tick, and they all ask the same question.
const AGENT_FLEET_CACHE_MS = 10_000;

let agentFleetCache: { at: number; value: { freshestLastSeenAt: Date | null; reportingAgents: number } } | null = null;

export async function agentFleetLiveness(): Promise<{ freshestLastSeenAt: Date | null; reportingAgents: number }> {
  const nowMs = Date.now();
  if (agentFleetCache && nowMs - agentFleetCache.at < AGENT_FLEET_CACHE_MS) return agentFleetCache.value;
  const agg = await prisma.managedAgent.aggregate({
    where: {
      installStatus: { in: [...AGENT_REPORTING_STATUSES] },
      bearerHash: { not: null },
      bearerRevokedAt: null,
    },
    _max: { lastSeenAt: true },
    _count: { _all: true },
  });
  const value = { freshestLastSeenAt: agg._max.lastSeenAt ?? null, reportingAgents: agg._count._all };
  agentFleetCache = { at: nowMs, value };
  return value;
}

/** Test seam: reset the rule 86 process state (boot instant + fleet cache). */
export function __resetAgentSilenceStateForTests(listeningSince: Date = new Date()): void {
  agentListeningSince = listeningSince;
  agentFleetCache = null;
}
