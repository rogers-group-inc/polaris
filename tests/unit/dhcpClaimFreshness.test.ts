/**
 * tests/unit/dhcpClaimFreshness.test.ts
 *
 * Ranking of competing address claims on one asset (business rule 101) — the
 * rule that decides which DHCP binding, detected-device row and network card
 * speaks for an asset's ipAddress, instead of whichever entry the discovery
 * run happened to iterate last.
 */

import { describe, it, expect } from "vitest";
import {
  scoreAddressClaim,
  claimBeats,
  claimMedium,
  mediumFromMacSource,
  createDhcpClaimState,
  RECENT_CLAIM_MS,
  type AddressClaimEvidence,
  type DhcpClaimState,
} from "../../src/utils/dhcpClaimFreshness.js";

const NOW = Date.parse("2026-10-10T21:00:00Z");
const score = (e: AddressClaimEvidence) => scoreAddressClaim(e, NOW);
const beats = (a: AddressClaimEvidence, b: AddressClaimEvidence) => claimBeats(score(a), score(b));

describe("scoreAddressClaim / claimBeats — the tiers", () => {
  it("an online detected-device row beats a held lease and a held reservation", () => {
    // The plant-HMI case: the gate is seeing the device at one address right
    // now, and still holds an unexpired lease for another.
    const online: AddressClaimEvidence = { kind: "device-inventory", current: true, seenMs: NOW };
    expect(beats(online, { kind: "dhcp-lease", current: true, seenMs: NOW, expireTime: 2_000_000_000 })).toBe(true);
    expect(beats(online, { kind: "dhcp-reservation", current: true, seenMs: NOW, medium: "wired" })).toBe(true);
  });

  it("a held binding beats a remembered-but-offline detected-device row", () => {
    // FortiOS keeps clients that left in the table, with their old address.
    expect(
      beats(
        { kind: "dhcp-lease", current: true },
        { kind: "device-inventory", current: false, seenMs: NOW - 3 * 86_400_000 },
      ),
    ).toBe(true);
  });

  it("an offline detected-device row still beats configuration nobody holds", () => {
    expect(
      beats(
        { kind: "device-inventory", current: false, seenMs: NOW - 86_400_000 },
        { kind: "dhcp-reservation", current: false },
      ),
    ).toBe(true);
  });

  it("a live-held lease beats a config-only static reservation", () => {
    expect(beats({ kind: "dhcp-lease", current: true }, { kind: "dhcp-reservation", current: false })).toBe(true);
    expect(beats({ kind: "dhcp-reservation", current: false }, { kind: "dhcp-lease", current: true })).toBe(false);
  });
});

describe("scoreAddressClaim / claimBeats — inside a tier", () => {
  it("a held reservation beats a held leftover lease on the same gate", () => {
    // Same gate, same MAC freshness: before rule 101 the lease's expireTime
    // (reservations scored 0 there) always won.
    expect(
      beats(
        { kind: "dhcp-reservation", current: true, seenMs: NOW },
        { kind: "dhcp-lease", current: true, seenMs: NOW, expireTime: 2_000_000_000 },
      ),
    ).toBe(true);
  });

  it("wired beats wireless when the device is online on both cards", () => {
    expect(
      beats(
        { kind: "device-inventory", current: true, seenMs: NOW, medium: "wired" },
        { kind: "device-inventory", current: true, seenMs: NOW, medium: "wireless" },
      ),
    ).toBe(true);
    expect(
      beats(
        { kind: "dhcp-lease", current: true, seenMs: NOW, medium: "wireless" },
        { kind: "dhcp-lease", current: true, seenMs: NOW, medium: "wired" },
      ),
    ).toBe(false);
  });

  it("unknown medium sits between wired and wireless", () => {
    const base: AddressClaimEvidence = { kind: "dhcp-lease", current: true, seenMs: NOW };
    expect(beats({ ...base, medium: "unknown" }, { ...base, medium: "wireless" })).toBe(true);
    expect(beats({ ...base, medium: "unknown" }, { ...base, medium: "wired" })).toBe(false);
    expect(beats({ ...base }, { ...base, medium: "wireless" })).toBe(true); // absent = unknown
  });

  it("wired beats a wireless reservation — the medium outranks the binding type", () => {
    expect(
      beats(
        { kind: "dhcp-lease", current: true, seenMs: NOW, medium: "wired" },
        { kind: "dhcp-reservation", current: true, seenMs: NOW, medium: "wireless" },
      ),
    ).toBe(true);
  });

  it("a recent claim beats an old one before medium or binding type count", () => {
    // The undocked laptop: its wired reservation is still unexpired on the
    // gate, but that gate last saw the card hours ago. Wi-Fi was seen now.
    const wiredStale: AddressClaimEvidence = {
      kind: "dhcp-reservation", current: true, medium: "wired", seenMs: NOW - 3 * RECENT_CLAIM_MS,
    };
    const wirelessNow: AddressClaimEvidence = {
      kind: "dhcp-lease", current: true, medium: "wireless", seenMs: NOW - 60_000,
    };
    expect(beats(wirelessNow, wiredStale)).toBe(true);
    expect(beats(wiredStale, wirelessNow)).toBe(false);
  });

  it("two live leases: the gate whose device inventory saw the client more recently wins", () => {
    // The roaming-laptop case: unexpired lease on the site it left vs the
    // fresh lease where it moved. Both are 'live' to the DHCP monitor and both
    // outside the recent window, so freshness itself decides.
    const oldGate: AddressClaimEvidence = {
      kind: "dhcp-lease", current: true, seenMs: NOW - 5 * 86_400_000, expireTime: 1_787_000_000,
    };
    const newGate: AddressClaimEvidence = {
      kind: "dhcp-lease", current: true, seenMs: NOW - 2 * 86_400_000, expireTime: 1_786_000_000,
    };
    expect(beats(newGate, oldGate)).toBe(true);
    expect(beats(oldGate, newGate)).toBe(false);
  });

  it("without inventory, the later-expiring lease wins (fresher renewal)", () => {
    expect(
      beats(
        { kind: "dhcp-lease", current: true, expireTime: 2_000 },
        { kind: "dhcp-lease", current: true, expireTime: 1_000 },
      ),
    ).toBe(true);
  });

  it("a reservation's expireTime is never read", () => {
    const s = score({ kind: "dhcp-reservation", current: true, expireTime: 9_999_999 });
    expect(s[5]).toBe(0);
  });

  it("equal evidence keeps the incumbent (stable across re-runs)", () => {
    const a: AddressClaimEvidence = { kind: "dhcp-lease", current: true, expireTime: 1_000 };
    expect(beats(a, { ...a })).toBe(false);
  });

  it("missing/NaN evidence scores as zero rather than poisoning the comparison", () => {
    expect(score({ kind: "dhcp-lease", seenMs: NaN, expireTime: undefined })).toEqual([0, 0, 1, 0, 0, 0]);
  });
});

describe("claimMedium / mediumFromMacSource", () => {
  it("reads the row's own attribution first", () => {
    expect(claimMedium({ wirelessEvidence: true, macSource: "intune-ethernet" })).toBe("wireless");
    expect(claimMedium({ wiredEvidence: true, macSource: "intune-wifi" })).toBe("wired");
  });

  it("falls back to the hardware source's adapter type", () => {
    expect(claimMedium({ macSource: "intune-ethernet" })).toBe("wired");
    expect(claimMedium({ macSource: "intune-wifi" })).toBe("wireless");
    expect(claimMedium({ macSource: "vcenter-vnic" })).toBe("wired");
  });

  it("a sighting or the agent's NIC list says nothing", () => {
    expect(mediumFromMacSource("dhcp-lease")).toBe("unknown");
    expect(mediumFromMacSource("polaris-agent")).toBe("unknown");
    expect(mediumFromMacSource(null)).toBe("unknown");
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
    evidence: { kind: "dhcp-reservation", current: true } as AddressClaimEvidence,
  };
  const STALE_RESERVATION_GATE = {
    gate: "HOPKINSVILLE-101F-1",
    evidence: { kind: "dhcp-reservation", current: false } as AddressClaimEvidence,
  };

  /** One gate's sync pass: stage the address only when its claim wins. */
  const gatePass = (
    state: DhcpClaimState,
    assetId: string,
    entry: { gate: string; evidence: AddressClaimEvidence },
    staged: { gate: string | null },
  ) => {
    const s = score(entry.evidence);
    const incumbent = state.bestAddressClaimByAsset.get(assetId);
    if (!incumbent || claimBeats(s, incumbent)) {
      state.bestAddressClaimByAsset.set(assetId, s);
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
    expect(state.bestAddressClaimByAsset.size).toBe(0);
    expect(state.bestGateClaimMsByAsset.size).toBe(0);

    const staged = { gate: null as string | null };
    for (const assetId of ["asset-1", "asset-2"]) {
      for (const entry of [LIVE_LEASE_GATE, STALE_RESERVATION_GATE]) {
        gatePass(state, assetId, entry, staged);
      }
    }
    expect(state.bestAddressClaimByAsset.size).toBe(2);
  });
});
