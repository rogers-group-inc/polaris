import { describe, it, expect } from "vitest";
import {
  claimIsOperatorOwned,
  claimIsCurrent,
  distinctDeviceCount,
  groupHasEligibleType,
  CONFLICT_ELIGIBLE_ASSET_TYPES,
  groupCurrentClaims,
  memberSetKey,
  pickPrimaryMemberId,
  resolveMergeTargets,
  toStoredMember,
  duplicateIpRejectMessage,
  DUPLICATE_IP_COLLISION_REASON,
  addressIsDeliberate,
  groupHasDisjointSources,
  DELIBERATE_RESERVATION_SOURCE_TYPES,
  type IpClaimRow,
} from "../../src/services/duplicateIpConflictService.js";

const CUTOFF = new Date("2026-08-26T00:00:00Z"); // "7 days ago" for these fixtures
const FRESH = new Date("2026-09-01T00:00:00Z");
const STALE = new Date("2026-07-01T00:00:00Z");

function row(over: Partial<IpClaimRow> = {}): IpClaimRow {
  return {
    id: "a1",
    ip: "10.1.1.50",
    hostname: "host-a",
    assetType: "switch",
    status: "active",
    monitored: true,
    macAddress: "AA:BB:CC:00:00:01",
    ipSource: "fortigate",
    ipOverride: null,
    lastSeen: FRESH,
    ipLastSeen: FRESH,
    ...over,
  };
}

describe("claimIsOperatorOwned", () => {
  it("is true when the pin equals the recorded address", () => {
    expect(claimIsOperatorOwned({ ip: "10.1.1.50", ipOverride: "10.1.1.50", ipSource: "manual" })).toBe(true);
  });

  it("is true for a manually-sourced address with no pin", () => {
    expect(claimIsOperatorOwned({ ip: "10.1.1.50", ipOverride: null, ipSource: "manual" })).toBe(true);
  });

  it("is false when the pin names a DIFFERENT address than the one recorded", () => {
    // Mid-flight ip-override state: the pin is 10.1.1.9 while the row shows
    // the discovered address. That address is not the operator's claim.
    expect(claimIsOperatorOwned({ ip: "10.1.1.50", ipOverride: "10.1.1.9", ipSource: "fortigate" })).toBe(false);
  });

  it("is false for a discovered address", () => {
    expect(claimIsOperatorOwned({ ip: "10.1.1.50", ipOverride: null, ipSource: "fortimanager" })).toBe(false);
  });
});

describe("claimIsCurrent", () => {
  it("counts a recently re-asserted discovered claim", () => {
    expect(claimIsCurrent(row({ ipLastSeen: FRESH }), CUTOFF)).toBe(true);
  });

  it("drops a stale discovered claim — the DHCP-reuse leftover", () => {
    expect(claimIsCurrent(row({ ipLastSeen: STALE, lastSeen: STALE }), CUTOFF)).toBe(false);
  });

  it("keeps an operator-owned claim however old it is", () => {
    expect(
      claimIsCurrent(
        row({ ipSource: "manual", ipOverride: "10.1.1.50", ipLastSeen: STALE, lastSeen: STALE }),
        CUTOFF,
      ),
    ).toBe(true);
  });

  it("falls back to Asset.lastSeen when there is no history row", () => {
    expect(claimIsCurrent(row({ ipLastSeen: null, lastSeen: FRESH }), CUTOFF)).toBe(true);
    expect(claimIsCurrent(row({ ipLastSeen: null, lastSeen: STALE }), CUTOFF)).toBe(false);
  });

  it("accepts a timestamp the raw query handed back as a string", () => {
    // $queryRaw types are a claim about the driver, not a guarantee.
    const asString = { ...row(), ipLastSeen: FRESH.toISOString() as unknown as Date };
    expect(claimIsCurrent(asString, CUTOFF)).toBe(true);
    const staleString = { ...row(), ipLastSeen: STALE.toISOString() as unknown as Date, lastSeen: null };
    expect(claimIsCurrent(staleString, CUTOFF)).toBe(false);
  });

  it("drops a claim whose timestamp does not parse", () => {
    expect(claimIsCurrent({ ...row(), ipLastSeen: "nonsense" as unknown as Date, lastSeen: null }, CUTOFF)).toBe(false);
  });

  it("drops a claim with no timestamp at all", () => {
    expect(claimIsCurrent(row({ ipLastSeen: null, lastSeen: null }), CUTOFF)).toBe(false);
  });

  it("prefers the per-address timestamp over the asset's presence", () => {
    // Device is present (lastSeen fresh) but nothing has re-asserted THIS
    // address in months — the record is stale, not a duplicate.
    expect(claimIsCurrent(row({ ipLastSeen: STALE, lastSeen: FRESH }), CUTOFF)).toBe(false);
  });
});

describe("distinctDeviceCount", () => {
  it("collapses rows sharing one MAC into a single device", () => {
    expect(
      distinctDeviceCount([{ macAddress: "AA:BB:CC:00:00:01" }, { macAddress: "aa:bb:cc:00:00:01" }]),
    ).toBe(1);
  });

  it("counts differing MACs separately", () => {
    expect(
      distinctDeviceCount([{ macAddress: "AA:BB:CC:00:00:01" }, { macAddress: "AA:BB:CC:00:00:02" }]),
    ).toBe(2);
  });

  it("treats each unknown MAC as its own device", () => {
    expect(distinctDeviceCount([{ macAddress: null }, { macAddress: null }])).toBe(2);
    expect(distinctDeviceCount([{ macAddress: "  " }, { macAddress: "AA:BB:CC:00:00:01" }])).toBe(2);
  });
});

describe("groupHasEligibleType", () => {
  it("accepts a set containing any of the four chosen-address types", () => {
    for (const t of CONFLICT_ELIGIBLE_ASSET_TYPES) {
      expect(groupHasEligibleType([{ assetType: "workstation" }, { assetType: t }])).toBe(true);
    }
  });

  it("rejects a set of only pool-addressed equipment", () => {
    expect(
      groupHasEligibleType([{ assetType: "workstation" }, { assetType: "printer" }]),
    ).toBe(false);
  });

  it("rejects unknown, blank and null types", () => {
    expect(groupHasEligibleType([{ assetType: "other" }, { assetType: null }])).toBe(false);
    expect(groupHasEligibleType([{ assetType: "" }, { assetType: "  " }])).toBe(false);
  });

  it("tolerates padding on a stored type", () => {
    expect(groupHasEligibleType([{ assetType: " switch " }])).toBe(true);
  });

  it("does NOT include hypervisor or router — see business rule 40", () => {
    // Stated as a test so widening the list is a deliberate edit here too.
    expect(groupHasEligibleType([{ assetType: "hypervisor" }, { assetType: "router" }])).toBe(false);
  });
});

describe("groupCurrentClaims", () => {
  it("groups two current claims on one address", () => {
    const groups = groupCurrentClaims(
      [row({ id: "a2", macAddress: "AA:BB:CC:00:00:02" }), row({ id: "a1" })],
      CUTOFF,
    );
    expect(groups).toHaveLength(1);
    expect(groups[0].ip).toBe("10.1.1.50");
    expect(groups[0].members.map((m) => m.id)).toEqual(["a1", "a2"]); // sorted, stable
  });

  it("does not group when only one claim is current", () => {
    const groups = groupCurrentClaims(
      [
        row({ id: "a1" }),
        row({ id: "a2", macAddress: "AA:BB:CC:00:00:02", ipLastSeen: STALE, lastSeen: STALE }),
      ],
      CUTOFF,
    );
    expect(groups).toEqual([]);
  });

  it("does not group one device recorded twice (same MAC)", () => {
    const groups = groupCurrentClaims([row({ id: "a1" }), row({ id: "a2" })], CUTOFF);
    expect(groups).toEqual([]);
  });

  it("keeps a three-way collision as one group", () => {
    const groups = groupCurrentClaims(
      [
        row({ id: "a1" }),
        row({ id: "a2", macAddress: "AA:BB:CC:00:00:02" }),
        row({ id: "a3", macAddress: null }),
      ],
      CUTOFF,
    );
    expect(groups).toHaveLength(1);
    expect(groups[0].members).toHaveLength(3);
  });

  it("separates addresses and returns them in address order", () => {
    const groups = groupCurrentClaims(
      [
        row({ id: "b1", ip: "10.1.1.60" }),
        row({ id: "b2", ip: "10.1.1.60", macAddress: "AA:BB:CC:00:00:09" }),
        row({ id: "a1", ip: "10.1.1.50" }),
        row({ id: "a2", ip: "10.1.1.50", macAddress: "AA:BB:CC:00:00:02" }),
      ],
      CUTOFF,
    );
    expect(groups.map((g) => g.ip)).toEqual(["10.1.1.50", "10.1.1.60"]);
  });

  it("raises on a mix as long as one claimant is qualifying equipment", () => {
    const groups = groupCurrentClaims(
      [
        row({ id: "a1", assetType: "access_point" }),
        row({ id: "a2", assetType: "workstation", macAddress: "AA:BB:CC:00:00:02" }),
      ],
      CUTOFF,
    );
    expect(groups).toHaveLength(1);
    // The endpoint still rides the card — it is what took the address.
    expect(groups[0].members.map((m) => m.assetType)).toEqual(["access_point", "workstation"]);
  });

  it("ignores an endpoint-only collision — that is DHCP working", () => {
    const groups = groupCurrentClaims(
      [
        row({ id: "a1", assetType: "workstation" }),
        row({ id: "a2", assetType: "printer", macAddress: "AA:BB:CC:00:00:02" }),
      ],
      CUTOFF,
    );
    expect(groups).toEqual([]);
  });

  it("ignores a collision whose only qualifying claim is stale", () => {
    // Eligibility is tested on CURRENT claims: a departed switch's leftover
    // record must not license a conflict between two live endpoints.
    const groups = groupCurrentClaims(
      [
        row({ id: "a1", assetType: "switch", ipLastSeen: STALE, lastSeen: STALE }),
        row({ id: "a2", assetType: "workstation", macAddress: "AA:BB:CC:00:00:02" }),
        row({ id: "a3", assetType: "workstation", macAddress: "AA:BB:CC:00:00:03" }),
      ],
      CUTOFF,
    );
    expect(groups).toEqual([]);
  });

  it("ignores rows with no address", () => {
    expect(groupCurrentClaims([row({ id: "a1", ip: "" }), row({ id: "a2", ip: "" })], CUTOFF)).toEqual([]);
  });
});

describe("memberSetKey", () => {
  it("is order-independent and accepts both row and stored shapes", () => {
    expect(memberSetKey([{ assetId: "b" }, { assetId: "a" }])).toBe("a,b");
    expect(memberSetKey([{ id: "a" }, { id: "b" }])).toBe("a,b");
  });

  it("distinguishes a changed member set — which is what re-raises a dismissal", () => {
    expect(memberSetKey([{ assetId: "a" }, { assetId: "b" }])).not.toBe(
      memberSetKey([{ assetId: "a" }, { assetId: "c" }]),
    );
  });
});

describe("pickPrimaryMemberId", () => {
  it("picks the lowest id so refreshes do not churn the FK", () => {
    expect(pickPrimaryMemberId([{ id: "b" }, { id: "a" }, { id: "c" }])).toBe("a");
  });

  it("returns null for an empty set", () => {
    expect(pickPrimaryMemberId([])).toBeNull();
  });
});

describe("toStoredMember", () => {
  it("serializes dates and flags the operator-owned claim", () => {
    const stored = toStoredMember(row({ ipSource: "manual", ipOverride: "10.1.1.50" }));
    expect(stored.assetId).toBe("a1");
    expect(stored.pinned).toBe(true);
    expect(stored.lastSeen).toBe(FRESH.toISOString());
    expect(stored.ipLastSeen).toBe(FRESH.toISOString());
  });

  it("keeps nulls null rather than inventing timestamps", () => {
    const stored = toStoredMember(row({ lastSeen: null, ipLastSeen: null, macAddress: null }));
    expect(stored.lastSeen).toBeNull();
    expect(stored.ipLastSeen).toBeNull();
    expect(stored.macAddress).toBeNull();
    expect(stored.pinned).toBe(false);
  });
});

describe("resolveMergeTargets", () => {
  const members = [{ assetId: "a1" }, { assetId: "a2" }, { assetId: "a3" }];

  it("returns the chosen targets", () => {
    expect(resolveMergeTargets(members, "a1", ["a2"])).toEqual(["a2"]);
    expect(resolveMergeTargets(members, "a1", ["a2", "a3"])).toEqual(["a2", "a3"]);
  });

  it("drops the survivor from its own target list instead of self-merging", () => {
    expect(resolveMergeTargets(members, "a1", ["a1", "a2"])).toEqual(["a2"]);
  });

  it("collapses duplicates and blanks", () => {
    expect(resolveMergeTargets(members, "a1", ["a2", "a2", ""])).toEqual(["a2"]);
  });

  it("refuses a survivor that is not a member of this conflict", () => {
    expect(() => resolveMergeTargets(members, "outsider", ["a2"])).toThrow(/surviving asset is not one/i);
  });

  it("refuses a target that is not a member of this conflict", () => {
    // Nothing may reach an asset the card never showed.
    expect(() => resolveMergeTargets(members, "a1", ["outsider"])).toThrow(/not one of the assets/i);
  });

  it("refuses an empty merge — the caller is about to delete rows", () => {
    expect(() => resolveMergeTargets(members, "a1", [])).toThrow(/at least one other asset/i);
    expect(() => resolveMergeTargets(members, "a1", ["a1"])).toThrow(/at least one other asset/i);
  });
});

describe("duplicateIpRejectMessage", () => {
  it("names the address and both assets", () => {
    const msg = duplicateIpRejectMessage({
      proposedAssetFields: {
        collisionReason: DUPLICATE_IP_COLLISION_REASON,
        ipAddress: "10.1.1.50",
        members: [{ assetId: "a1", hostname: "host-a" }, { assetId: "a2", hostname: "host-b" }],
      },
    });
    expect(msg).toContain("10.1.1.50");
    expect(msg).toContain("host-a");
    expect(msg).toContain("host-b");
  });

  it("survives a conflict with no members recorded", () => {
    expect(duplicateIpRejectMessage({ proposedAssetFields: null })).toContain("unknown");
  });
});

// ─── Cross-source clause (rule 40, the second eligibility bar) ───────────────

describe("addressIsDeliberate", () => {
  it("is false when IPAM has no reservation for the address", () => {
    expect(addressIsDeliberate(null)).toBe(false);
    expect(addressIsDeliberate(undefined)).toBe(false);
  });

  it("is false for a plain DHCP lease — two devices may legitimately trade it", () => {
    expect(addressIsDeliberate({ sourceType: "dhcp_lease", dhcpBinding: "lease", vipInfo: null })).toBe(false);
  });

  it("is true for every deliberate sourceType", () => {
    for (const kind of DELIBERATE_RESERVATION_SOURCE_TYPES) {
      expect(addressIsDeliberate({ sourceType: kind, dhcpBinding: null, vipInfo: null })).toBe(true);
    }
  });

  // Business rule 23: the three columns are three separate facts, and the two
  // below are exactly the cases reading sourceType alone would get wrong.
  it("is true for a VIP stamped on a row whose sourceType still says dhcp_lease", () => {
    expect(addressIsDeliberate({
      sourceType: "dhcp_lease",
      dhcpBinding: "lease",
      vipInfo: { name: "vip-web", device: "FGT-01" },
    })).toBe(true);
  });

  it("is true when the gate serves it as a reservation whatever sourceType says", () => {
    expect(addressIsDeliberate({ sourceType: "dhcp_lease", dhcpBinding: "reservation", vipInfo: null })).toBe(true);
  });
});

describe("groupHasDisjointSources", () => {
  const members = [{ id: "a1" }, { id: "a2" }];

  it("is true when two claimants share no source kind", () => {
    const idx = new Map([
      ["a1", new Set(["entra", "intune", "ad"])],
      ["a2", new Set(["fortigate-endpoint"])],
    ]);
    expect(groupHasDisjointSources(members, idx)).toBe(true);
  });

  it("is false when one integration reported both rows", () => {
    const idx = new Map([
      ["a1", new Set(["fortigate-endpoint"])],
      ["a2", new Set(["fortigate-endpoint"])],
    ]);
    expect(groupHasDisjointSources(members, idx)).toBe(false);
  });

  it("is false when the sets merely overlap — a shared kind is a cross-link", () => {
    const idx = new Map([
      ["a1", new Set(["ad", "entra"])],
      ["a2", new Set(["entra", "fortigate-endpoint"])],
    ]);
    expect(groupHasDisjointSources(members, idx)).toBe(false);
  });

  it("abstains for a member with no source rows rather than qualifying on it", () => {
    const idx = new Map([["a1", new Set(["entra"])]]);
    expect(groupHasDisjointSources(members, idx)).toBe(false);
    expect(groupHasDisjointSources(members, new Map())).toBe(false);
  });

  it("finds a disjoint PAIR inside a larger group", () => {
    const idx = new Map([
      ["a1", new Set(["entra"])],
      ["a2", new Set(["entra"])],
      ["a3", new Set(["fortigate-endpoint"])],
    ]);
    expect(groupHasDisjointSources([{ id: "a1" }, { id: "a2" }, { id: "a3" }], idx)).toBe(true);
  });
});

describe("groupCurrentClaims — cross-source clause", () => {
  const endpoints = [
    row({ id: "a1", assetType: "workstation", macAddress: null, hostname: "WKS-042" }),
    row({ id: "a2", assetType: "workstation", macAddress: "AA:BB:CC:00:00:09", hostname: "wks042.corp" }),
  ];
  const disjoint = {
    sourceKindsByAsset: new Map([
      ["a1", new Set(["entra", "intune", "ad"])],
      ["a2", new Set(["fortigate-endpoint"])],
    ]),
    deliberateIps: new Set(["10.1.1.50"]),
  };

  it("still refuses endpoint-only duplicates with no context (unchanged default)", () => {
    expect(groupCurrentClaims(endpoints, CUTOFF)).toEqual([]);
  });

  it("raises when sources are disjoint AND the address is deliberate", () => {
    const groups = groupCurrentClaims(endpoints, CUTOFF, disjoint);
    expect(groups).toHaveLength(1);
    expect(groups[0].qualifiedBy).toBe("cross-source");
  });

  it("stays silent on a leased address even with disjoint sources", () => {
    const groups = groupCurrentClaims(endpoints, CUTOFF, {
      ...disjoint,
      deliberateIps: new Set<string>(),
    });
    expect(groups).toEqual([]);
  });

  it("stays silent on a deliberate address when one integration reported both", () => {
    const groups = groupCurrentClaims(endpoints, CUTOFF, {
      ...disjoint,
      sourceKindsByAsset: new Map([
        ["a1", new Set(["fortigate-endpoint"])],
        ["a2", new Set(["fortigate-endpoint"])],
      ]),
    });
    expect(groups).toEqual([]);
  });

  // The older, broader clause keeps the label when both apply.
  it("labels a group asset-type when infrastructure is on the card", () => {
    const withSwitch = [row({ id: "a1", assetType: "switch" }), row({ id: "a2", macAddress: null })];
    const groups = groupCurrentClaims(withSwitch, CUTOFF, disjoint);
    expect(groups).toHaveLength(1);
    expect(groups[0].qualifiedBy).toBe("asset-type");
  });

  // Every other refusal still applies on top of the new clause.
  it("still collapses two rows that share a MAC", () => {
    const sameDevice = [
      row({ id: "a1", assetType: "workstation", macAddress: "AA:BB:CC:00:00:09" }),
      row({ id: "a2", assetType: "workstation", macAddress: "AA:BB:CC:00:00:09" }),
    ];
    expect(groupCurrentClaims(sameDevice, CUTOFF, disjoint)).toEqual([]);
  });

  it("still drops a stale claim before testing eligibility", () => {
    const stale = [
      endpoints[0],
      row({ id: "a2", assetType: "workstation", macAddress: null, lastSeen: STALE, ipLastSeen: STALE }),
    ];
    expect(groupCurrentClaims(stale, CUTOFF, disjoint)).toEqual([]);
  });
});
