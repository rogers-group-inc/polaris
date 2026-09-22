import { describe, it, expect } from "vitest";
import {
  isUsableSerial,
  controllerKeyFor,
  claimFoldKey,
  groupContestedSerials,
  claimantSetKey,
  groupDuplicateSerialAssets,
  memberSetKey,
  pickPrimaryMemberId,
  resolveMergeTargets,
  serialClaimRejectMessage,
  duplicateSerialRejectMessage,
  freshnessCutoff,
  conflictSerialOf,
  MAX_PLAUSIBLE_DUPLICATES,
  SERIAL_CLAIM_COLLISION_REASON,
  DUPLICATE_SERIAL_COLLISION_REASON,
  EMPTY_CONTROLLER_CONTEXT,
  type ControllerClaimRow,
  type ControllerContext,
  type DuplicateSerialAssetRow,
} from "../../src/services/duplicateSerialConflictService.js";

const NOW = new Date("2026-09-22T12:00:00Z");
const FRESH = new Date("2026-09-22T06:00:00Z");
const STALE = new Date("2026-09-10T00:00:00Z");
const CUTOFF = freshnessCutoff(NOW);

function claim(over: Partial<ControllerClaimRow> = {}): ControllerClaimRow {
  const controllerSerial = over.controllerSerial === undefined ? "FG100F0000000001" : over.controllerSerial;
  const controllerDevice = over.controllerDevice ?? "site-a-fw";
  return {
    id: "c1",
    assetId: "asset-switch-1",
    deviceSerial: "S248DF0000000001",
    sourceKind: "fortiswitch",
    controllerSerial,
    controllerDevice,
    controllerKey: over.controllerKey ?? controllerKeyFor({ controllerSerial, controllerDevice }),
    integrationId: "int-1",
    firstSeen: FRESH,
    lastSeen: FRESH,
    asset: { id: "asset-switch-1", hostname: "sw-a-01", assetType: "switch", status: "active" },
    ...over,
  };
}

function assetRow(over: Partial<DuplicateSerialAssetRow> = {}): DuplicateSerialAssetRow {
  return {
    id: "a1",
    hostname: "host-a",
    serialNumber: "ABC1234567",
    assetType: "server",
    status: "active",
    ipAddress: "10.1.1.10",
    macAddress: "AA:BB:CC:00:00:01",
    lastSeen: FRESH,
    discoveredByIntegrationId: "int-1",
    ...over,
  };
}

describe("isUsableSerial", () => {
  it("accepts a real serial", () => {
    expect(isUsableSerial("S248DF0000000001")).toBe(true);
    expect(isUsableSerial("FGT60F1234567890")).toBe(true);
  });

  it("rejects the SMBIOS placeholders whatever their case or padding", () => {
    for (const junk of [
      "To Be Filled By O.E.M.",
      "  default string  ",
      "System Serial Number",
      "Not Specified",
      "None",
      "n/a",
      "UNKNOWN",
      "0123456789",
    ]) {
      expect(isUsableSerial(junk), junk).toBe(false);
    }
  });

  it("rejects a single repeated character — every 'we didn't program one' serial", () => {
    expect(isUsableSerial("00000000")).toBe(false);
    expect(isUsableSerial("XXXXXXXXXX")).toBe(false);
    expect(isUsableSerial("--------")).toBe(false);
  });

  it("rejects anything too short to be a serial, and the empty cases", () => {
    expect(isUsableSerial("AB1")).toBe(false);
    expect(isUsableSerial("")).toBe(false);
    expect(isUsableSerial(null)).toBe(false);
    expect(isUsableSerial(undefined)).toBe(false);
  });
});

describe("controllerKeyFor", () => {
  it("keys on the chassis serial when the gate published one (business rule 41)", () => {
    expect(controllerKeyFor({ controllerSerial: "fg100f0001", controllerDevice: "site-a-fw" })).toBe("FG100F0001");
  });

  it("falls back to the device NAME when there is no serial, marked so it can never collide with one", () => {
    expect(controllerKeyFor({ controllerSerial: null, controllerDevice: "Site-A-FW" })).toBe("name:site-a-fw");
  });

  it("is empty when the gate has no identity at all", () => {
    expect(controllerKeyFor({ controllerSerial: null, controllerDevice: null })).toBe("");
    expect(controllerKeyFor({ controllerSerial: "  ", controllerDevice: "  " })).toBe("");
  });
});

describe("groupContestedSerials", () => {
  it("reports a serial two different gates both claim", () => {
    const groups = groupContestedSerials(
      [
        claim({ id: "c1", controllerSerial: "FG-A", controllerDevice: "site-a-fw" }),
        claim({ id: "c2", controllerSerial: "FG-B", controllerDevice: "site-b-fw" }),
      ],
      CUTOFF,
    );
    expect(groups).toHaveLength(1);
    expect(groups[0].deviceSerial).toBe("S248DF0000000001");
    expect(groups[0].claimants.map((c) => c.controllerDevice).sort()).toEqual(["site-a-fw", "site-b-fw"]);
  });

  it("does NOT report one gate that claims the device twice under two FMG device entries", () => {
    // Same chassis serial, two names — one gate, re-registered.
    const groups = groupContestedSerials(
      [
        claim({ id: "c1", controllerSerial: "FG-A", controllerDevice: "site-a-fw" }),
        claim({ id: "c2", controllerSerial: "FG-A", controllerDevice: "site-a-fw-old" }),
      ],
      CUTOFF,
    );
    expect(groups).toHaveLength(0);
  });

  it("folds HA cluster members into ONE claimant — a cluster is one gate", () => {
    // Both member serials resolve to the same firewall Asset, which is exactly
    // what discovery's per-member `fortigate-firewall` AssetSource rows encode.
    const ctx: ControllerContext = {
      assetIdByControllerKey: new Map([
        ["FG-PRIMARY", "asset-fw-cluster"],
        ["FG-SECONDARY", "asset-fw-cluster"],
      ]),
      nameByAssetId: new Map(),
      integrationNameById: new Map(),
    };
    const groups = groupContestedSerials(
      [
        claim({ id: "c1", controllerSerial: "FG-PRIMARY", controllerDevice: "hq-fw" }),
        claim({ id: "c2", controllerSerial: "FG-SECONDARY", controllerDevice: "hq-fw-standby" }),
      ],
      CUTOFF,
      ctx,
    );
    expect(groups).toHaveLength(0);
  });

  it("still reports two SEPARATE gates that each resolve to their own asset", () => {
    const ctx: ControllerContext = {
      assetIdByControllerKey: new Map([
        ["FG-A", "asset-fw-a"],
        ["FG-B", "asset-fw-b"],
      ]),
      nameByAssetId: new Map(),
      integrationNameById: new Map(),
    };
    const groups = groupContestedSerials(
      [
        claim({ id: "c1", controllerSerial: "FG-A", controllerDevice: "site-a-fw" }),
        claim({ id: "c2", controllerSerial: "FG-B", controllerDevice: "site-b-fw" }),
      ],
      CUTOFF,
      ctx,
    );
    expect(groups).toHaveLength(1);
    expect(groups[0].claimants[0].controllerAssetId).toBeTruthy();
  });

  it("ignores a claim nothing has re-asserted since the cutoff — a completed move closes itself", () => {
    const groups = groupContestedSerials(
      [
        claim({ id: "c1", controllerSerial: "FG-A", controllerDevice: "site-a-fw", lastSeen: FRESH }),
        claim({ id: "c2", controllerSerial: "FG-B", controllerDevice: "site-b-fw", lastSeen: STALE }),
      ],
      CUTOFF,
    );
    expect(groups).toHaveLength(0);
  });

  it("leads with the gate that spoke most recently — the one whose stamp the asset carries", () => {
    const newer = new Date("2026-09-22T11:00:00Z");
    const older = new Date("2026-09-22T01:00:00Z");
    const groups = groupContestedSerials(
      [
        claim({ id: "c1", controllerSerial: "FG-A", controllerDevice: "site-a-fw", lastSeen: older }),
        claim({ id: "c2", controllerSerial: "FG-B", controllerDevice: "site-b-fw", lastSeen: newer }),
      ],
      CUTOFF,
    );
    expect(groups[0].claimants[0].controllerDevice).toBe("site-b-fw");
  });

  it("skips a device the operator has written off or switched off", () => {
    for (const status of ["decommissioned", "disabled"]) {
      const groups = groupContestedSerials(
        [
          claim({ id: "c1", controllerSerial: "FG-A", asset: { id: "x", hostname: "sw", assetType: "switch", status } }),
          claim({ id: "c2", controllerSerial: "FG-B", asset: { id: "x", hostname: "sw", assetType: "switch", status } }),
        ],
        CUTOFF,
      );
      expect(groups, status).toHaveLength(0);
    }
  });

  it("still reports a switch in storage — an unauthorized switch still flaps between gates", () => {
    const groups = groupContestedSerials(
      [
        claim({ id: "c1", controllerSerial: "FG-A", asset: { id: "x", hostname: "sw", assetType: "switch", status: "storage" } }),
        claim({ id: "c2", controllerSerial: "FG-B", asset: { id: "x", hostname: "sw", assetType: "switch", status: "storage" } }),
      ],
      CUTOFF,
    );
    expect(groups).toHaveLength(1);
  });

  it("ignores a placeholder device serial", () => {
    const groups = groupContestedSerials(
      [
        claim({ id: "c1", deviceSerial: "unknown", controllerSerial: "FG-A" }),
        claim({ id: "c2", deviceSerial: "unknown", controllerSerial: "FG-B" }),
      ],
      CUTOFF,
    );
    expect(groups).toHaveLength(0);
  });

  it("is deterministic — the same claims produce the same order twice", () => {
    const claims = [
      claim({ id: "c1", deviceSerial: "S2", controllerSerial: "FG-A" }),
      claim({ id: "c2", deviceSerial: "S2", controllerSerial: "FG-B" }),
      claim({ id: "c3", deviceSerial: "S1", controllerSerial: "FG-A" }),
      claim({ id: "c4", deviceSerial: "S1", controllerSerial: "FG-B" }),
    ];
    const a = groupContestedSerials(claims, CUTOFF).map((g) => g.deviceSerial);
    const b = groupContestedSerials(claims, CUTOFF).map((g) => g.deviceSerial);
    expect(a).toEqual(b);
  });
});

describe("claimFoldKey", () => {
  it("prefers the resolved firewall asset over the claim's own key", () => {
    const ctx: ControllerContext = {
      assetIdByControllerKey: new Map([["FG-A", "asset-fw-a"]]),
      nameByAssetId: new Map(),
      integrationNameById: new Map(),
    };
    expect(claimFoldKey(claim({ controllerSerial: "FG-A" }), ctx)).toBe("asset:asset-fw-a");
  });

  it("falls back to the claim key when nothing resolved", () => {
    expect(claimFoldKey(claim({ controllerSerial: "FG-A" }), EMPTY_CONTROLLER_CONTEXT)).toBe("FG-A");
  });
});

describe("claimantSetKey", () => {
  it("is order-independent, so a re-raise is suppressed however the claims sorted", () => {
    expect(claimantSetKey([{ controllerKey: "FG-B" }, { controllerKey: "FG-A" }])).toBe(
      claimantSetKey([{ controllerKey: "FG-A" }, { controllerKey: "FG-B" }]),
    );
  });

  it("changes when a THIRD gate joins the argument — that is a new disagreement", () => {
    const two = claimantSetKey([{ controllerKey: "FG-A" }, { controllerKey: "FG-B" }]);
    const three = claimantSetKey([{ controllerKey: "FG-A" }, { controllerKey: "FG-B" }, { controllerKey: "FG-C" }]);
    expect(two).not.toBe(three);
  });
});

describe("groupDuplicateSerialAssets", () => {
  it("groups two records carrying the same serial", () => {
    const groups = groupDuplicateSerialAssets([
      assetRow({ id: "a1", serialNumber: "ABC1234567" }),
      assetRow({ id: "a2", serialNumber: "abc1234567", hostname: "host-b" }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].serialNumber).toBe("ABC1234567");
    expect(groups[0].members.map((m) => m.assetId)).toEqual(["a1", "a2"]);
  });

  it("leaves a serial only one asset carries alone", () => {
    expect(groupDuplicateSerialAssets([assetRow({ id: "a1" })])).toHaveLength(0);
  });

  it("ignores placeholder serials however many assets share them", () => {
    const rows = ["a1", "a2", "a3"].map((id) =>
      assetRow({ id, serialNumber: "To Be Filled By O.E.M." }),
    );
    expect(groupDuplicateSerialAssets(rows)).toHaveLength(0);
  });

  it("treats a serial shared by more records than any one device could be as a vendor default", () => {
    const rows = Array.from({ length: MAX_PLAUSIBLE_DUPLICATES + 1 }, (_, i) =>
      assetRow({ id: `a${i}`, serialNumber: "SHARED123456" }),
    );
    expect(groupDuplicateSerialAssets(rows)).toHaveLength(0);
  });

  it("still reports a group exactly at the plausible limit", () => {
    const rows = Array.from({ length: MAX_PLAUSIBLE_DUPLICATES }, (_, i) =>
      assetRow({ id: `a${i}`, serialNumber: "SHARED123456" }),
    );
    expect(groupDuplicateSerialAssets(rows)).toHaveLength(1);
  });

  it("drops written-off records before deciding there is a duplicate", () => {
    const groups = groupDuplicateSerialAssets([
      assetRow({ id: "a1" }),
      assetRow({ id: "a2", status: "decommissioned" }),
    ]);
    expect(groups).toHaveLength(0);
  });
});

describe("resolveMergeTargets", () => {
  const members = [{ assetId: "a1" }, { assetId: "a2" }, { assetId: "a3" }];

  it("absorbs every other member when none is named (the card's one-click verb)", () => {
    expect(resolveMergeTargets(members, "a1", []).sort()).toEqual(["a2", "a3"]);
  });

  it("honours an explicit list and never absorbs the survivor", () => {
    expect(resolveMergeTargets(members, "a1", ["a2", "a1"])).toEqual(["a2"]);
  });

  it("refuses a survivor that is not one of the members", () => {
    expect(() => resolveMergeTargets(members, "zz", [])).toThrow(/not one of the assets/i);
  });

  it("refuses to absorb an asset that is not one of the members", () => {
    expect(() => resolveMergeTargets(members, "a1", ["zz"])).toThrow(/not one of the assets/i);
  });

  it("refuses a merge with nothing to absorb", () => {
    expect(() => resolveMergeTargets([{ assetId: "a1" }], "a1", [])).toThrow(/nothing to merge/i);
  });
});

describe("memberSetKey / pickPrimaryMemberId", () => {
  it("keys a member set independent of order", () => {
    expect(memberSetKey([{ assetId: "b" }, { assetId: "a" }])).toBe(memberSetKey([{ assetId: "a" }, { assetId: "b" }]));
  });

  it("picks the lowest id, so the conflict's FK does not churn between passes", () => {
    expect(pickPrimaryMemberId([{ assetId: "b2" }, { assetId: "a1" }])).toBe("a1");
    expect(pickPrimaryMemberId([])).toBeNull();
  });
});

describe("dismissal copy", () => {
  it("names the gates on a contested serial", () => {
    const msg = serialClaimRejectMessage({
      proposedAssetFields: {
        collisionReason: SERIAL_CLAIM_COLLISION_REASON,
        deviceSerial: "S248DF0000000001",
        claimants: [{ controllerDevice: "site-a-fw" }, { controllerDevice: "site-b-fw" }],
      },
    });
    expect(msg).toContain("S248DF0000000001");
    expect(msg).toContain("site-a-fw");
    expect(msg).toContain("site-b-fw");
  });

  it("names the records on a duplicate serial", () => {
    const msg = duplicateSerialRejectMessage({
      proposedAssetFields: {
        collisionReason: DUPLICATE_SERIAL_COLLISION_REASON,
        serialNumber: "ABC1234567",
        members: [{ assetId: "a1", hostname: "host-a" }, { assetId: "a2", hostname: "host-b" }],
      },
    });
    expect(msg).toContain("ABC1234567");
    expect(msg).toContain("host-a");
    expect(msg).toContain("host-b");
  });

  it("survives a conflict with nothing recorded on it", () => {
    expect(serialClaimRejectMessage({ proposedAssetFields: {} })).toContain("unknown");
    expect(duplicateSerialRejectMessage({ proposedAssetFields: null })).toContain("unknown");
  });
});

describe("conflictSerialOf", () => {
  it("reads either flavour's key", () => {
    expect(conflictSerialOf({ proposedAssetFields: { deviceSerial: "S1" } })).toBe("S1");
    expect(conflictSerialOf({ proposedAssetFields: { serialNumber: "S2" } })).toBe("S2");
    expect(conflictSerialOf({ proposedAssetFields: {} })).toBeNull();
  });
});
