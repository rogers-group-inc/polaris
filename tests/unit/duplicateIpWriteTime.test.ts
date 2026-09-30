/**
 * tests/unit/duplicateIpWriteTime.test.ts
 *
 * Business rule 40(i): the duplicate-address check an operator's save runs
 * BEFORE the write lands, and the clause that makes it mean something.
 *
 * Two things are pinned here, both pure:
 *
 *   1. `groupCurrentClaims` admits a group when one of its current claims is
 *      OPERATOR-OWNED (`ipSource="manual"` or a pin) — clause (i). Without it,
 *      the asset form's "submit for conflict review" raises a card the sweep
 *      then auto-closes as ineligible on its next pass, because two
 *      workstations qualify under neither (g) (type) nor (h) (IPAM address).
 *      The label is `operator-addressed`, and it is the narrowest clause: it
 *      takes the label only when neither older clause applies.
 *
 *   2. `simulateIncomingClaim` answers the form's question — "if I put THIS
 *      asset on THIS address, is that a collision?" — by grouping a synthetic
 *      operator-owned row with the real claims through that SAME function.
 *      What the dialog warns about must be exactly what the save raises, so the
 *      simulation and the reconcile cannot be allowed to disagree; sharing the
 *      grouping is how that is guaranteed, and these cases are what would catch
 *      a divergence.
 */

import { describe, it, expect } from "vitest";
import {
  groupCurrentClaims,
  simulateIncomingClaim,
  INCOMING_CLAIM_ID,
  EMPTY_CROSS_SOURCE_CONTEXT,
  type IpClaimRow,
} from "../../src/services/duplicateIpConflictService.js";

const NOW = new Date("2026-09-22T12:00:00Z");
const CUTOFF = new Date(NOW.getTime() - 7 * 86_400_000);
const FRESH = new Date(NOW.getTime() - 3_600_000);
const STALE = new Date(NOW.getTime() - 30 * 86_400_000);

function row(over: Partial<IpClaimRow> & { id: string }): IpClaimRow {
  return {
    ip: "10.1.1.50",
    hostname: over.id,
    assetType: "workstation",
    status: "active",
    monitored: true,
    macAddress: null,
    ipSource: "fortigate",
    ipOverride: null,
    lastSeen: FRESH,
    ipLastSeen: FRESH,
    ...over,
  };
}

describe("groupCurrentClaims — clause (i), an operator-typed claim qualifies the group", () => {
  it("two workstations do NOT qualify when neither claim is operator-owned (rule 40(g) unchanged)", () => {
    // The DHCP-noise carve-out (g) exists to exclude. Clause (i) must not
    // silently widen it for discovered claims.
    const groups = groupCurrentClaims([row({ id: "a" }), row({ id: "b" })], CUTOFF);
    expect(groups).toEqual([]);
  });

  it("two workstations DO qualify when one address was typed by an operator", () => {
    const groups = groupCurrentClaims(
      [row({ id: "a" }), row({ id: "b", ipSource: "manual" })],
      CUTOFF,
    );
    expect(groups).toHaveLength(1);
    expect(groups[0].qualifiedBy).toBe("operator-addressed");
    expect(groups[0].members.map((m) => m.id)).toEqual(["a", "b"]);
  });

  it("a pin equal to the address counts as operator-owned too", () => {
    const groups = groupCurrentClaims(
      [row({ id: "a" }), row({ id: "b", ipOverride: "10.1.1.50" })],
      CUTOFF,
    );
    expect(groups.map((g) => g.qualifiedBy)).toEqual(["operator-addressed"]);
  });

  it("is the NARROWEST clause — asset-type keeps the label when both apply", () => {
    const groups = groupCurrentClaims(
      [row({ id: "a", assetType: "switch" }), row({ id: "b", ipSource: "manual" })],
      CUTOFF,
    );
    expect(groups.map((g) => g.qualifiedBy)).toEqual(["asset-type"]);
  });

  it("cross-source keeps the label over operator-addressed when both apply", () => {
    const ctx = {
      sourceKindsByAsset: new Map([
        ["a", new Set(["ad"])],
        ["b", new Set(["fortigate-endpoint"])],
      ]),
      deliberateIps: new Set(["10.1.1.50"]),
    };
    const groups = groupCurrentClaims(
      [row({ id: "a" }), row({ id: "b", ipSource: "manual" })],
      CUTOFF,
      ctx,
    );
    expect(groups.map((g) => g.qualifiedBy)).toEqual(["cross-source"]);
  });

  it("still takes two DEVICES: an operator claim sharing the other row's MAC is one device (rule 40(c))", () => {
    const groups = groupCurrentClaims(
      [
        row({ id: "a", macAddress: "AA:BB:CC:00:11:22" }),
        row({ id: "b", macAddress: "AA:BB:CC:00:11:22", ipSource: "manual" }),
      ],
      CUTOFF,
    );
    expect(groups).toEqual([]);
  });

  it("still takes a CURRENT counterpart: an operator claim beside a stale discovered one is no group", () => {
    // The operator claim is current by definition; the OTHER side still has to
    // be. A departed laptop's leftover record is not a collision with the
    // device an operator just addressed — it is the stale record rule 40(b)
    // exists to ignore.
    const groups = groupCurrentClaims(
      [row({ id: "a", lastSeen: STALE, ipLastSeen: STALE }), row({ id: "b", ipSource: "manual" })],
      CUTOFF,
    );
    expect(groups).toEqual([]);
  });
});

describe("simulateIncomingClaim — the asset form's pre-save question", () => {
  it("reports no conflict on an empty address", () => {
    const out = simulateIncomingClaim([], { ip: "10.1.1.50" }, CUTOFF, EMPTY_CROSS_SOURCE_CONTEXT, NOW);
    expect(out).toEqual({ ip: "10.1.1.50", holders: [], wouldConflict: false, qualifiedBy: null });
  });

  it("names the holder and would conflict when a current network-present asset records the address", () => {
    const out = simulateIncomingClaim(
      [row({ id: "sw-01", assetType: "switch" })],
      { ip: "10.1.1.50", assetType: "workstation" },
      CUTOFF,
      EMPTY_CROSS_SOURCE_CONTEXT,
      NOW,
    );
    expect(out.wouldConflict).toBe(true);
    expect(out.holders).toHaveLength(1);
    expect(out.holders[0]).toMatchObject({ assetId: "sw-01", assetType: "switch", claimCurrent: true });
  });

  it("qualifies through clause (i) when the other holder is an ordinary endpoint", () => {
    // Exactly the case the clause exists for: the incoming claim is typed, so
    // the group qualifies although nothing about either device's type would.
    const out = simulateIncomingClaim(
      [row({ id: "laptop-7" })],
      { ip: "10.1.1.50", assetType: "workstation" },
      CUTOFF,
      EMPTY_CROSS_SOURCE_CONTEXT,
      NOW,
    );
    expect(out.wouldConflict).toBe(true);
    expect(out.qualifiedBy).toBe("operator-addressed");
  });

  it("shows a STALE holder but does not call it a conflict", () => {
    // The dialog can still list the record (the operator may want to clean it
    // up), but saving over a stale claim raises nothing, and saying otherwise
    // would train operators to ignore the dialog.
    const out = simulateIncomingClaim(
      [row({ id: "old-laptop", lastSeen: STALE, ipLastSeen: STALE })],
      { ip: "10.1.1.50" },
      CUTOFF,
      EMPTY_CROSS_SOURCE_CONTEXT,
      NOW,
    );
    expect(out.wouldConflict).toBe(false);
    expect(out.holders).toHaveLength(1);
    expect(out.holders[0].claimCurrent).toBe(false);
  });

  it("excludes the asset being edited from its own holders", () => {
    // Re-saving an edit form re-states the asset's own address; that row must
    // not appear as a colliding holder of itself.
    const out = simulateIncomingClaim(
      [row({ id: "me", ipSource: "manual" })],
      { ip: "10.1.1.50", excludeAssetId: "me" },
      CUTOFF,
      EMPTY_CROSS_SOURCE_CONTEXT,
      NOW,
    );
    expect(out).toEqual({ ip: "10.1.1.50", holders: [], wouldConflict: false, qualifiedBy: null });
  });

  it("does not conflict with a holder that shares the incoming MAC — same device (rule 40(c))", () => {
    const out = simulateIncomingClaim(
      [row({ id: "wired", macAddress: "AA:BB:CC:00:11:22" })],
      { ip: "10.1.1.50", macAddress: "AA:BB:CC:00:11:22" },
      CUTOFF,
      EMPTY_CROSS_SOURCE_CONTEXT,
      NOW,
    );
    expect(out.wouldConflict).toBe(false);
    expect(out.holders).toHaveLength(1);
  });

  it("never leaks the synthetic row into the holders it reports", () => {
    const out = simulateIncomingClaim(
      [row({ id: "a" })],
      { ip: "10.1.1.50" },
      CUTOFF,
      EMPTY_CROSS_SOURCE_CONTEXT,
      NOW,
    );
    expect(out.holders.some((h) => h.assetId === INCOMING_CLAIM_ID)).toBe(false);
  });

  it("ignores holders on OTHER addresses handed to it", () => {
    // Defensive: the DB loader is scoped, but the pure function must not
    // depend on that.
    const out = simulateIncomingClaim(
      [row({ id: "elsewhere", ip: "10.1.1.51" })],
      { ip: "10.1.1.50" },
      CUTOFF,
      EMPTY_CROSS_SOURCE_CONTEXT,
      NOW,
    );
    expect(out.holders).toEqual([]);
    expect(out.wouldConflict).toBe(false);
  });
});
