/**
 * tests/unit/addressConfidence.test.ts — business rule 103's pure half: the
 * weights, freshness, the noisy-OR combination, penalties, bands, and the
 * polling run the probe path keeps.
 */

import { describe, it, expect } from "vitest";
import {
  scoreAddress,
  freshness,
  pollingWeight,
  confidenceBand,
  pollingRunStart,
  pollingHoursFor,
  pinReleaseVerdict,
  agentSourceCounts,
  EVIDENCE_KINDS,
  CONFIDENCE_WARN_BELOW,
  ALIVE_ELSEWHERE_FACTOR,
  CLAIMED_ELSEWHERE_FACTOR,
  ARP_ELSEWHERE_FACTOR,
  type Evidence,
} from "../../src/utils/addressConfidence.js";

const NOW = Date.parse("2026-10-11T12:00:00Z");
const ago = (ms: number) => new Date(NOW - ms);
const H = 3_600_000;

describe("freshness", () => {
  it("halves at each half-life and never decays a kind without one", () => {
    expect(freshness("arp", ago(0), NOW)).toBe(1);
    expect(freshness("arp", ago(4 * H), NOW)).toBeCloseTo(0.5, 5);
    expect(freshness("arp", ago(8 * H), NOW)).toBeCloseTo(0.25, 5);
    expect(freshness("reservation-configured", ago(1000 * H), NOW)).toBe(1);
    expect(freshness("detected-online", null, NOW)).toBe(1);
  });
});

describe("pollingWeight", () => {
  it("ramps toward the cap with hours of clean polling", () => {
    expect(pollingWeight(0)).toBe(0);
    expect(pollingWeight(1)).toBeCloseTo(0.95 * (1 - Math.exp(-1 / 24)), 5);
    expect(pollingWeight(24)).toBeCloseTo(0.6, 1);
    expect(pollingWeight(72)).toBeGreaterThan(0.9);
    expect(pollingWeight(10_000)).toBeLessThanOrEqual(EVIDENCE_KINDS.polling.weight);
  });
});

describe("scoreAddress", () => {
  it("corroboration adds up but never passes 100 (the plant-HMI primary)", () => {
    const evidence: Evidence[] = [
      { kind: "detected-online", seenAt: ago(2 * 60_000), device: "GW-1" },
      { kind: "reservation-held", seenAt: ago(0), device: "GW-1" },
      { kind: "polling", hours: 76 },
    ];
    const r = scoreAddress(evidence, [], NOW);
    expect(r.score).toBeGreaterThanOrEqual(99);
    expect(r.score).toBeLessThanOrEqual(100);
    expect(r.band).toBe("high");
    // A held reservation (0.90) now outweighs what the gate detected (0.70).
    expect(r.parts.map((p) => p.kind)).toEqual(["polling", "reservation-held", "detected-online"]);
  });

  it("a reservation outweighs FortiGate detection — a person chose it", () => {
    const held = scoreAddress([{ kind: "reservation-held", seenAt: ago(0) }], [], NOW).score;
    const detected = scoreAddress([{ kind: "detected-online", seenAt: ago(0) }], [], NOW).score;
    const configured = scoreAddress([{ kind: "reservation-configured" }], [], NOW).score;
    expect(held).toBe(90);
    expect(detected).toBe(70);
    expect(configured).toBe(40);
    expect(held).toBeGreaterThan(detected);
    // A static device on its reserved address: reservation configured + ARP
    // beats an unconfirmed detection elsewhere.
    const reservedInArp = scoreAddress([{ kind: "reservation-configured" }, { kind: "arp", seenAt: ago(0) }], [], NOW).score;
    expect(reservedInArp).toBe(76); // 1 − 0.6 × 0.4
    expect(reservedInArp).toBeGreaterThan(detected);
  });

  it("while polling answers on an address its evidence does not age — except in the discovery score", () => {
    const aged: Evidence[] = [{ kind: "detected-online", seenAt: ago(18 * H) }, { kind: "arp", seenAt: ago(12 * H) }];
    const unpolled = scoreAddress(aged, [], NOW);
    const polled = scoreAddress([...aged, { kind: "polling", hours: 0.5 }], [], NOW);
    expect(unpolled.sustained).toBe(false);
    expect(polled.sustained).toBe(true);
    // Unpolled: 0.7×0.125 and 0.6×0.125 → about 16. Polled: both at full weight.
    expect(unpolled.score).toBeLessThan(20);
    expect(polled.evidenceScore).toBeGreaterThanOrEqual(88); // 1 − 0.3 × 0.4 × (1 − polling)
    // The number pins are compared on still ages, so a monitored address
    // can't hold its evidence fresh while its rivals fade.
    expect(polled.discoveryScore).toBe(unpolled.discoveryScore);
  });

  it("a card with several addresses: what the gate detected counts as ambiguous, not as the address", () => {
    expect(scoreAddress([{ kind: "detected-ambiguous", seenAt: ago(0) }], [], NOW).score).toBe(20);
  });

  it("a single held lease is medium; a single ARP entry is medium-low and fades fast", () => {
    expect(scoreAddress([{ kind: "lease-held", seenAt: ago(0) }], [], NOW).score).toBe(70);
    expect(scoreAddress([{ kind: "arp", seenAt: ago(0) }], [], NOW).score).toBe(60);
    // 0.6 × 0.5³ = 0.075 — three half-lives (12 h) on, ARP alone is near nothing.
    expect(scoreAddress([{ kind: "arp", seenAt: ago(12 * H) }], [], NOW).score).toBeLessThan(10);
  });

  it("ARP corroborates whatever else reports the address, and the ARP contradiction halves a detected one", () => {
    const detected: Evidence = { kind: "detected-online", seenAt: ago(0) };
    const alone = scoreAddress([detected], [], NOW);
    const withArp = scoreAddress([detected, { kind: "arp", seenAt: ago(0) }], [], NOW);
    expect(alone.score).toBe(70);
    expect(withArp.score).toBe(88); // 1 − 0.3 × 0.4
    const contradicted = scoreAddress([detected], [{ kind: "arp-elsewhere", factor: ARP_ELSEWHERE_FACTOR, detail: "x" }], NOW);
    expect(contradicted.score).toBe(35);
    // The address ARP does resolve now out-scores the one it contradicts.
    expect(scoreAddress([{ kind: "arp", seenAt: ago(0) }], [], NOW).score).toBeGreaterThan(contradicted.score);
  });

  it("an address nothing reports scores 0, and is under the warn line", () => {
    const r = scoreAddress([], [], NOW);
    expect(r.score).toBe(0);
    expect(r.evidenceScore).toBeLessThan(CONFIDENCE_WARN_BELOW);
  });

  it("the operator's choice counts in the score but never in the evidence score", () => {
    const r = scoreAddress([{ kind: "operator" }, { kind: "arp", seenAt: ago(0) }], [], NOW);
    expect(r.evidenceScore).toBe(60);
    expect(r.score).toBe(92); // 1 - (0.2 × 0.4)
    const typedUnknown = scoreAddress([{ kind: "operator" }], [], NOW);
    expect(typedUnknown.score).toBe(80);
    expect(typedUnknown.evidenceScore).toBe(0);
  });

  it("one source repeating itself is not corroboration — the strongest of a kind counts", () => {
    const one = scoreAddress([{ kind: "arp", seenAt: ago(0), device: "GW-1" }], [], NOW);
    const two = scoreAddress([
      { kind: "arp", seenAt: ago(0), device: "GW-1" },
      { kind: "arp", seenAt: ago(H), device: "GW-2" },
    ], [], NOW);
    expect(two.score).toBe(one.score);
    expect(two.parts).toHaveLength(1);
    expect(two.parts[0]!.device).toBe("GW-1");
  });

  it("penalties multiply the score — contradictions, not absences", () => {
    const strong: Evidence[] = [{ kind: "detected-online", seenAt: ago(0) }];
    const base = scoreAddress(strong, [], NOW).score;
    const alive = scoreAddress(strong, [{ kind: "alive-elsewhere", factor: ALIVE_ELSEWHERE_FACTOR, detail: "x" }], NOW);
    expect(alive.score).toBe(Math.round(base * ALIVE_ELSEWHERE_FACTOR));
    const both = scoreAddress(strong, [
      { kind: "alive-elsewhere", factor: ALIVE_ELSEWHERE_FACTOR, detail: "x" },
      { kind: "claimed-elsewhere", factor: CLAIMED_ELSEWHERE_FACTOR, detail: "y" },
    ], NOW);
    expect(both.score).toBe(Math.round(base * ALIVE_ELSEWHERE_FACTOR * CLAIMED_ELSEWHERE_FACTOR));
    expect(both.penalties).toHaveLength(2);
  });
});

describe("discoveryScore", () => {
  it("leaves out both the operator's choice and polling", () => {
    const r = scoreAddress([
      { kind: "operator" },
      { kind: "polling", hours: 200 },
      { kind: "lease-held", seenAt: ago(0) },
    ], [], NOW);
    expect(r.discoveryScore).toBe(70);
    expect(r.evidenceScore).toBeGreaterThan(90);
    expect(r.score).toBeGreaterThan(r.evidenceScore);
  });
});

describe("pinReleaseVerdict (rule 103(a))", () => {
  const s = (discoveryScore: number) => ({ discoveryScore });

  it("releases when the pinned address beats every other and reaches the warn line", () => {
    const v = pinReleaseVerdict("10.0.0.5", new Map([["10.0.0.5", s(85)], ["10.0.0.6", s(70)]]));
    expect(v).toEqual({ release: true, pinnedScore: 85, bestOther: { ip: "10.0.0.6", score: 70 } });
  });

  it("holds while another address scores as high or higher", () => {
    expect(pinReleaseVerdict("10.0.0.5", new Map([["10.0.0.5", s(70)], ["10.0.0.6", s(70)]])).release).toBe(false);
    expect(pinReleaseVerdict("10.0.0.5", new Map([["10.0.0.5", s(60)], ["10.0.0.6", s(90)]])).release).toBe(false);
  });

  it("holds when the pinned address is merely the best of a weak lot", () => {
    expect(pinReleaseVerdict("10.0.0.5", new Map([["10.0.0.5", s(40)], ["10.0.0.6", s(10)]])).release).toBe(false);
  });

  it("releases the only address once it is backed on its own; holds an address with no evidence", () => {
    expect(pinReleaseVerdict("10.0.0.5", new Map([["10.0.0.5", s(60)]])).release).toBe(true);
    expect(pinReleaseVerdict("10.0.0.9", new Map([["10.0.0.5", s(90)]])).release).toBe(false);
  });
});

describe("confidenceBand", () => {
  it("high ≥ 80, medium ≥ 50, low ≥ 20, very low below", () => {
    expect(confidenceBand(80)).toBe("high");
    expect(confidenceBand(79)).toBe("medium");
    expect(confidenceBand(50)).toBe("medium");
    expect(confidenceBand(49)).toBe("low");
    expect(confidenceBand(20)).toBe("low");
    expect(confidenceBand(19)).toBe("very-low");
  });
});

describe("pollingRunStart", () => {
  const now = new Date(NOW);
  const running = { ipAddress: "10.0.0.5", ipConfirmedFor: "10.0.0.5", ipConfirmedSince: ago(5 * H) };

  it("keeps a running run on an ordinary success", () => {
    expect(pollingRunStart(running, true, "up", false, now)).toEqual({});
  });

  it("starts a run on a new address, with no run yet, and coming back from down / unknown", () => {
    expect(pollingRunStart({ ...running, ipAddress: "10.0.0.6" }, true, "up", false, now))
      .toEqual({ ipConfirmedFor: "10.0.0.6", ipConfirmedSince: now });
    expect(pollingRunStart({ ipAddress: "10.0.0.5", ipConfirmedFor: null, ipConfirmedSince: null }, true, "up", false, now))
      .toEqual({ ipConfirmedFor: "10.0.0.5", ipConfirmedSince: now });
    expect(pollingRunStart(running, true, "down", false, now)).toEqual({ ipConfirmedFor: "10.0.0.5", ipConfirmedSince: now });
    expect(pollingRunStart(running, true, "unknown", false, now)).toEqual({ ipConfirmedFor: "10.0.0.5", ipConfirmedSince: now });
  });

  it("never moves on a failure, an agent-reported result, or an asset with no address", () => {
    expect(pollingRunStart({ ...running, ipAddress: "10.0.0.6" }, false, "up", false, now)).toEqual({});
    expect(pollingRunStart({ ...running, ipAddress: "10.0.0.6" }, true, "up", true, now)).toEqual({});
    expect(pollingRunStart({ ipAddress: null }, true, "up", false, now)).toEqual({});
  });
});

describe("pollingHoursFor", () => {
  const asset = { monitored: true, monitorStatus: "up", ipConfirmedFor: "10.0.0.5", ipConfirmedSince: ago(10 * H) };
  it("credits only the address the run is for, only while not down and monitored", () => {
    expect(pollingHoursFor("10.0.0.5", asset, NOW)).toBeCloseTo(10, 5);
    expect(pollingHoursFor("10.0.0.6", asset, NOW)).toBe(0);
    expect(pollingHoursFor("10.0.0.5", { ...asset, monitorStatus: "down" }, NOW)).toBe(0);
    expect(pollingHoursFor("10.0.0.5", { ...asset, monitored: false }, NOW)).toBe(0);
  });
});

// Rule 103(e): the asset's own agent.
describe("agentSourceCounts", () => {
  const none = new Set<string>();
  it("counts the private address the agent connects from, mapped form included", () => {
    expect(agentSourceCounts("10.1.2.3", "10.1.2.3", none)).toBe(true);
    expect(agentSourceCounts("10.1.2.3", "::ffff:10.1.2.3", none)).toBe(true);
  });
  it("never for another address, a loopback (a proxy) or a public one (a NAT gateway)", () => {
    expect(agentSourceCounts("10.1.2.3", "10.1.2.4", none)).toBe(false);
    expect(agentSourceCounts("127.0.0.1", "127.0.0.1", none)).toBe(false);
    expect(agentSourceCounts("203.0.113.5", "203.0.113.5", none)).toBe(false);
    expect(agentSourceCounts("10.1.2.3", null, none)).toBe(false);
  });
  it("not when the agent's own interface report leaves the source address out (translated)", () => {
    expect(agentSourceCounts("10.1.2.3", "10.1.2.3", new Set(["192.168.5.5"]))).toBe(false);
    expect(agentSourceCounts("10.1.2.3", "10.1.2.3", new Set(["10.1.2.3", "192.168.5.5"]))).toBe(true);
  });
});

describe("agent evidence (rule 103(e))", () => {
  it("the agent's report outranks a scrape, and the two agent signals together are high", () => {
    expect(EVIDENCE_KINDS["agent-interface"].weight).toBeGreaterThan(EVIDENCE_KINDS.interface.weight);
    const r = scoreAddress([
      { kind: "agent-interface", seenAt: ago(0) },
      { kind: "agent-source", seenAt: ago(0) },
    ], [], NOW);
    expect(r.score).toBe(100);
    expect(r.band).toBe("high");
    // Neither is polling nor operator: both back a pin on their own (103(a)).
    expect(r.discoveryScore).toBe(100);
  });
  it("the connect-from address fades within hours once the agent goes quiet", () => {
    const fresh = scoreAddress([{ kind: "agent-source", seenAt: ago(0) }], [], NOW);
    const quiet = scoreAddress([{ kind: "agent-source", seenAt: ago(4 * H) }], [], NOW);
    expect(fresh.score).toBe(85);
    expect(quiet.score).toBeLessThan(CONFIDENCE_WARN_BELOW / 5);
  });
});
