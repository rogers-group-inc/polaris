/**
 * tests/unit/dhcpClaimFreshness.test.ts
 *
 * Ranking of competing DHCP claims on one asset — the rule that makes an
 * asset's ipAddress follow its LATEST firewall sighting instead of whichever
 * DHCP entry the discovery run happened to iterate last.
 */

import { describe, it, expect } from "vitest";
import {
  scoreDhcpClaim,
  claimBeats,
  createDhcpClaimState,
  type DhcpClaimEvidence,
  type DhcpClaimState,
} from "../../src/utils/dhcpClaimFreshness.js";

const beats = (a: DhcpClaimEvidence, b: DhcpClaimEvidence) =>
  claimBeats(scoreDhcpClaim(a), scoreDhcpClaim(b));

describe("scoreDhcpClaim / claimBeats", () => {
  it("a live-held lease beats a config-only static reservation", () => {
    expect(
      beats(
        { type: "dhcp-lease", seenLeased: true },
        { type: "dhcp-reservation", seenLeased: false },
      ),
    ).toBe(true);
    expect(
      beats(
        { type: "dhcp-reservation", seenLeased: false },
        { type: "dhcp-lease", seenLeased: true },
      ),
    ).toBe(false);
  });

  it("an online-held reservation beats a live lease only via inventory freshness, never by type", () => {
    // Both monitor-confirmed: the gate that actually saw the client most
    // recently wins, regardless of lease-vs-reservation.
    expect(
      beats(
        { type: "dhcp-reservation", seenLeased: true, inventorySeenMs: 2_000 },
        { type: "dhcp-lease", seenLeased: true, inventorySeenMs: 1_000 },
      ),
    ).toBe(true);
  });

  it("two live leases: the gate whose device inventory saw the client more recently wins", () => {
    // The roaming-laptop case: unexpired lease on the site it left vs the
    // fresh lease where it moved. Both are 'live' to the DHCP monitor.
    const oldGate: DhcpClaimEvidence = {
      type: "dhcp-lease",
      seenLeased: true,
      inventorySeenMs: Date.parse("2026-08-18T08:00:00Z"),
      expireTime: 1_787_000_000,
    };
    const newGate: DhcpClaimEvidence = {
      type: "dhcp-lease",
      seenLeased: true,
      inventorySeenMs: Date.parse("2026-08-21T09:30:00Z"),
      expireTime: 1_786_000_000, // even with an EARLIER expiry, inventory wins
    };
    expect(beats(newGate, oldGate)).toBe(true);
    expect(beats(oldGate, newGate)).toBe(false);
  });

  it("without inventory, the later-expiring lease wins (fresher renewal)", () => {
    expect(
      beats(
        { type: "dhcp-lease", seenLeased: true, expireTime: 2_000 },
        { type: "dhcp-lease", seenLeased: true, expireTime: 1_000 },
      ),
    ).toBe(true);
  });

  it("a reservation's expireTime is ignored (leases only)", () => {
    // A static reservation entry carries no meaningful expiry; if one leaks
    // through it must not outrank a real lease renewal.
    expect(
      beats(
        { type: "dhcp-reservation", seenLeased: true, expireTime: 9_999_999 },
        { type: "dhcp-lease", seenLeased: true, expireTime: 1_000 },
      ),
    ).toBe(false);
  });

  it("all else equal, a lease beats a reservation deterministically", () => {
    expect(
      beats(
        { type: "dhcp-lease", seenLeased: true },
        { type: "dhcp-reservation", seenLeased: true },
      ),
    ).toBe(true);
  });

  it("equal evidence keeps the incumbent (stable across re-runs)", () => {
    const a: DhcpClaimEvidence = { type: "dhcp-lease", seenLeased: true, expireTime: 1_000 };
    expect(beats(a, { ...a })).toBe(false);
  });

  it("missing/NaN evidence scores as zero rather than poisoning the comparison", () => {
    const s = scoreDhcpClaim({ type: "dhcp-lease", inventorySeenMs: NaN, expireTime: undefined });
    expect(s).toEqual([0, 0, 0, 1]);
  });
});

/**
 * Run scope. In FortiManager mode `syncDhcpSubnets` runs once per managed
 * gate, so the ranking only arbitrates if the state outlives a single call.
 * These model that: each "gate pass" is one call's worth of arbitration, and
 * the assertion is that the outcome does not depend on which gate finished
 * last. Prod 2026-09-22: a never-claimed static reservation took an endpoint's
 * address from the gate holding its live lease, purely by finishing 10s later.
 */
describe("createDhcpClaimState — arbitration spans the per-gate syncs of one run", () => {
  const LIVE_LEASE_GATE = {
    gate: "HOPAGGEMPBLDG-61F-1",
    evidence: { type: "dhcp-reservation", seenLeased: true } as DhcpClaimEvidence,
  };
  const STALE_RESERVATION_GATE = {
    gate: "HOPKINSVILLE-101F-1",
    evidence: { type: "dhcp-reservation", seenLeased: false } as DhcpClaimEvidence,
  };

  /** One gate's sync pass: stage the address only when its claim wins. */
  const gatePass = (
    state: DhcpClaimState,
    assetId: string,
    entry: { gate: string; evidence: DhcpClaimEvidence },
    staged: { gate: string | null },
  ) => {
    const score = scoreDhcpClaim(entry.evidence);
    const incumbent = state.bestIpClaimByAsset.get(assetId);
    if (!incumbent || claimBeats(score, incumbent)) {
      state.bestIpClaimByAsset.set(assetId, score);
      staged.gate = entry.gate;
    }
  };

  it("the live-lease gate wins whichever gate syncs last", () => {
    for (const order of [
      [LIVE_LEASE_GATE, STALE_RESERVATION_GATE],
      [STALE_RESERVATION_GATE, LIVE_LEASE_GATE],
    ]) {
      const state = createDhcpClaimState();
      const staged = { gate: null as string | null };
      for (const entry of order) gatePass(state, "asset-1", entry, staged);
      expect(staged.gate).toBe(LIVE_LEASE_GATE.gate);
    }
  });

  it("a state created per gate instead of per run is what made it last-gate-wins", () => {
    // The pre-fix shape, kept as the counter-example the fix is defined
    // against: a fresh state each pass means every gate wins uncontested.
    const staged = { gate: null as string | null };
    for (const entry of [LIVE_LEASE_GATE, STALE_RESERVATION_GATE]) {
      gatePass(createDhcpClaimState(), "asset-1", entry, staged);
    }
    expect(staged.gate).toBe(STALE_RESERVATION_GATE.gate);
  });

  it("starts empty and keys every map by asset, so size tracks fleet not gate count", () => {
    const state = createDhcpClaimState();
    expect(state.bestIpClaimByAsset.size).toBe(0);
    expect(state.bestGateClaimMsByAsset.size).toBe(0);
    expect(state.bestInvIpSeenByAsset.size).toBe(0);

    const staged = { gate: null as string | null };
    for (const assetId of ["asset-1", "asset-2"]) {
      for (const entry of [LIVE_LEASE_GATE, STALE_RESERVATION_GATE]) {
        gatePass(state, assetId, entry, staged);
      }
    }
    expect(state.bestIpClaimByAsset.size).toBe(2);
  });
});
