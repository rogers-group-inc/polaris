/**
 * src/utils/agentSilence.ts — when an agent's silence is a missed poll
 * (business rule 86).
 *
 * An agent-monitored asset is never polled by the server: the Polaris Agent
 * pushes its own responseTime samples, and those are the only readings that
 * move the monitor state machine. A host that dies, loses its network or has
 * its agent service stopped pushes NOTHING — so without this helper its
 * `monitorStatus` froze at its last value (normally `up`) forever and the
 * "Asset down" automation could never fire.
 *
 * The fix treats the absence of an expected push as the miss: once an
 * enrolled agent has made no bearer-authenticated call for `silenceWindowMs`,
 * each due monitor tick records one failed reading, so the covering
 * automation's missedPolls decides "down" exactly as it would for ICMP
 * (rule 36). The agent's next real sample drives recovery as usual.
 *
 * Two things must NOT be read as a host's silence, because Polaris caused
 * them (the rule 80 principle):
 *   - this monitor process was not running — the clock starts no earlier
 *     than `listeningSince` (the process boot, or the last time the whole
 *     fleet was seen dark), so a restart or an update does not accuse the
 *     agents that simply have not reconnected yet;
 *   - Polaris could not RECEIVE — when no enrolled agent anywhere has reported
 *     within the window, the ingest (web role, proxy, Polaris's own network)
 *     is the thing that is down, and the verdict is `fleetDark`: record
 *     nothing. A fleet of one agent cannot tell the two apart, so the guard
 *     needs a second enrolled agent to abstain.
 */

/**
 * installStatus values for an agent that finished deploying. "upgrading" and
 * "upgrade_failed" are included because the agent keeps running across both
 * (an upgrade's restart is covered by its rule 80 maintenance hold, which keeps
 * the asset out of the monitor pass altogether). Everything else — still
 * installing, uninstalling, revoked — is an agent Polaris does not expect to
 * hear from, so its silence says nothing about the host.
 */
export const AGENT_REPORTING_STATUSES: readonly string[] = ["active", "upgrading", "upgrade_failed"];

export interface AgentLiveness {
  installStatus: string;
  bearerHash: string | null;
  bearerRevokedAt: Date | null;
  bearerIssuedAt: Date | null;
  lastSeenAt: Date | null;
}

/** An enrolled, non-revoked agent Polaris expects to keep hearing from. */
export function agentExpectedToReport(agent: AgentLiveness | null | undefined): agent is AgentLiveness {
  return (
    !!agent &&
    agent.bearerHash !== null &&
    agent.bearerRevokedAt === null &&
    AGENT_REPORTING_STATUSES.includes(agent.installStatus)
  );
}

/**
 * How long an agent may go without any bearer call before one poll counts as
 * missed: two push intervals, and never less than one interval plus a minute.
 * The slack absorbs push jitter, the agent's phase offsets and the
 * fire-and-forget `lastSeenAt` stamp; at the 60 s default it is 120 s.
 */
export function silenceWindowMs(intervalSeconds: number): number {
  const sec = Math.max(1, intervalSeconds);
  return Math.max(2 * sec, sec + 60) * 1000;
}

export type AgentSilenceVerdict =
  | { kind: "not-expected" }
  | { kind: "reporting" }
  | { kind: "fleetDark" }
  | { kind: "silent"; since: Date };

export function judgeAgentSilence(input: {
  agent: AgentLiveness | null | undefined;
  intervalSeconds: number;
  now: Date;
  /** Earliest instant the silence clock may start from (process boot / last fleet-dark sighting). */
  listeningSince: Date;
  /** Freshest `lastSeenAt` across every agent expected to report, and how many there are. */
  fleet: { freshestLastSeenAt: Date | null; reportingAgents: number };
}): AgentSilenceVerdict {
  const { agent, intervalSeconds, now, listeningSince, fleet } = input;
  if (!agentExpectedToReport(agent)) return { kind: "not-expected" };

  const window = silenceWindowMs(intervalSeconds);
  const lastHeard = agent.lastSeenAt ?? agent.bearerIssuedAt;
  const clockFrom = Math.max(lastHeard?.getTime() ?? 0, listeningSince.getTime());
  if (now.getTime() - clockFrom < window) return { kind: "reporting" };

  if (
    fleet.reportingAgents >= 2 &&
    (fleet.freshestLastSeenAt === null || now.getTime() - fleet.freshestLastSeenAt.getTime() >= window)
  ) {
    return { kind: "fleetDark" };
  }
  return { kind: "silent", since: new Date(lastHeard?.getTime() ?? clockFrom) };
}
