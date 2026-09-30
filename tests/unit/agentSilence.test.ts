/**
 * tests/unit/agentSilence.test.ts
 *
 * Business rule 86 — an enrolled agent's silence is a missed poll. The verdict
 * is a pure function; the probe path that acts on it is pinned in
 * tests/integration/agentSilenceDown.test.ts.
 */

import { describe, it, expect } from "vitest";
import {
  agentExpectedToReport,
  judgeAgentSilence,
  silenceWindowMs,
  type AgentLiveness,
} from "../../src/utils/agentSilence.js";

const NOW = new Date("2026-09-24T12:00:00Z");
const ago = (sec: number) => new Date(NOW.getTime() - sec * 1000);
const LONG_AGO = new Date(0);

function agent(over: Partial<AgentLiveness> = {}): AgentLiveness {
  return {
    installStatus: "active",
    bearerHash: "$argon2id$x",
    bearerRevokedAt: null,
    bearerIssuedAt: ago(86_400),
    lastSeenAt: ago(10),
    ...over,
  };
}

const LIVE_FLEET = { freshestLastSeenAt: ago(5), reportingAgents: 10 };

function judge(a: AgentLiveness | null, opts: { interval?: number; listeningSince?: Date; fleet?: typeof LIVE_FLEET } = {}) {
  return judgeAgentSilence({
    agent: a,
    intervalSeconds: opts.interval ?? 60,
    now: NOW,
    listeningSince: opts.listeningSince ?? LONG_AGO,
    fleet: opts.fleet ?? LIVE_FLEET,
  });
}

describe("silenceWindowMs", () => {
  it("is two intervals, and never less than one interval plus a minute", () => {
    expect(silenceWindowMs(60)).toBe(120_000);
    expect(silenceWindowMs(300)).toBe(600_000);
    expect(silenceWindowMs(10)).toBe(70_000);
    expect(silenceWindowMs(0)).toBe(61_000);
  });
});

describe("agentExpectedToReport — only a finished deployment is expected to report", () => {
  it("accepts active, upgrading and upgrade_failed with a live bearer", () => {
    for (const s of ["active", "upgrading", "upgrade_failed"]) {
      expect(agentExpectedToReport(agent({ installStatus: s }))).toBe(true);
    }
  });

  it("refuses an install still in flight, a failed install, an uninstall and a revoked agent", () => {
    for (const s of ["pending", "uploading", "enrolling", "failed", "uninstalling", "uninstall_failed", "revoked"]) {
      expect(agentExpectedToReport(agent({ installStatus: s }))).toBe(false);
    }
    expect(agentExpectedToReport(agent({ bearerHash: null }))).toBe(false);
    expect(agentExpectedToReport(agent({ bearerRevokedAt: ago(1) }))).toBe(false);
    expect(agentExpectedToReport(null)).toBe(false);
  });
});

describe("judgeAgentSilence", () => {
  it("an agent heard from inside its window is reporting", () => {
    expect(judge(agent({ lastSeenAt: ago(119) }))).toEqual({ kind: "reporting" });
  });

  it("an agent silent past its window is silent, dated from when it was last heard", () => {
    expect(judge(agent({ lastSeenAt: ago(120) }))).toEqual({ kind: "silent", since: ago(120) });
    expect(judge(agent({ lastSeenAt: ago(3600) }))).toEqual({ kind: "silent", since: ago(3600) });
  });

  it("scales the window with the asset's cadence", () => {
    expect(judge(agent({ lastSeenAt: ago(500) }), { interval: 300 }).kind).toBe("reporting");
    expect(judge(agent({ lastSeenAt: ago(600) }), { interval: 300 }).kind).toBe("silent");
  });

  it("falls back to the bearer's issue time for an agent that never called in", () => {
    expect(judge(agent({ lastSeenAt: null, bearerIssuedAt: ago(30) })).kind).toBe("reporting");
    expect(judge(agent({ lastSeenAt: null, bearerIssuedAt: ago(300) })).kind).toBe("silent");
  });

  it("an agent Polaris does not expect to hear from is never judged", () => {
    expect(judge(agent({ installStatus: "enrolling", lastSeenAt: ago(9999) }))).toEqual({ kind: "not-expected" });
    expect(judge(agent({ bearerRevokedAt: ago(9999), lastSeenAt: ago(9999) }))).toEqual({ kind: "not-expected" });
    expect(judge(null)).toEqual({ kind: "not-expected" });
  });

  it("the clock does not start before Polaris was listening — a restart does not accuse anyone", () => {
    // Agent last heard an hour ago, but this process only booted 30 s ago:
    // the agent has not had a full window to reconnect yet.
    expect(judge(agent({ lastSeenAt: ago(3600) }), { listeningSince: ago(30) }).kind).toBe("reporting");
    // A full window after boot and still nothing — now it is the host.
    expect(judge(agent({ lastSeenAt: ago(3600) }), { listeningSince: ago(130) })).toEqual({
      kind: "silent",
      since: ago(3600),
    });
  });

  it("a whole fleet silent at once is Polaris failing to receive, not every host dying", () => {
    const dark = { freshestLastSeenAt: ago(900), reportingAgents: 50 };
    expect(judge(agent({ lastSeenAt: ago(900) }), { fleet: dark })).toEqual({ kind: "fleetDark" });
  });

  it("one other agent reporting proves the ingest is up, so the silent one is accused", () => {
    const oneAlive = { freshestLastSeenAt: ago(20), reportingAgents: 50 };
    expect(judge(agent({ lastSeenAt: ago(900) }), { fleet: oneAlive }).kind).toBe("silent");
  });

  it("a fleet of one cannot tell the two apart, and accuses rather than never alerting", () => {
    const solo = { freshestLastSeenAt: ago(900), reportingAgents: 1 };
    expect(judge(agent({ lastSeenAt: ago(900) }), { fleet: solo }).kind).toBe("silent");
  });
});
