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
  EVIDENCE_KINDS,
  CONFIDENCE_WARN_BELOW,
  ALIVE_ELSEWHERE_FACTOR,
  CLAIMED_ELSEWHERE_FACTOR,
  type Evidence,
} from "../../src/utils/addressConfidence.js";

const NOW = Date.parse("2026-10-11T12:00:00Z");
const ago = (ms: number) => new Date(NOW - ms);
const H = 3_600_000;

describe("freshness", () => {
  it("halves at each half-life and never decays a kind without one", () => {
    expect(freshness("arp", ago(0), NOW)).toBe(1);
    expect(freshness("arp", ago(H), NOW)).toBeCloseTo(0.5, 5);
    expect(freshness("arp", ago(2 * H), NOW)).toBeCloseTo(0.25, 5);
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
    expect(r.parts.map((p) => p.kind)).toEqual(["polling", "detected-online", "reservation-held"]);
  });

  it("a single held lease is medium; a single ARP entry is medium-low and fades fast", () => {
    expect(scoreAddress([{ kind: "lease-held", seenAt: ago(0) }], [], NOW).score).toBe(70);
    expect(scoreAddress([{ kind: "arp", seenAt: ago(0) }], [], NOW).score).toBe(60);
    // 0.6 × 0.5³ = 0.075 — three half-lives on, ARP alone is near nothing.
    expect(scoreAddress([{ kind: "arp", seenAt: ago(3 * H) }], [], NOW).score).toBeLessThan(10);
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
