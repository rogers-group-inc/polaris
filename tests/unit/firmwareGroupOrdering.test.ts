/**
 * tests/unit/firmwareGroupOrdering.test.ts
 *
 * The pure half of group firmware upgrades (business rule 122): the topology
 * snapshot (ancestors, depth) and the ordering predicates the executor uses
 * (pickNext, subtreeState, conflicts).
 */

import { describe, it, expect, vi } from "vitest";

vi.mock("../../src/db.js", () => ({ prisma: {} }));
vi.mock("../../src/services/eventLogService.js", () => ({ logEvent: vi.fn() }));
vi.mock("../../src/services/firmwareUpgradeService.js", () => ({ FIRMWARE_ASSET_SELECT: {}, FirmwareRunConflictError: class extends Error {} }));
vi.mock("../../src/services/firmwareScheduleService.js", () => ({ CONFLICT_WAIT_MS: 1, LATE_GRACE_MS: 1 }));
vi.mock("../../src/services/notificationDeliveryService.js", () => ({}));
vi.mock("../../src/services/quietTimeSummaryService.js", () => ({}));
vi.mock("../../src/services/userTimezoneService.js", () => ({}));

import { ancestorsOf, depthOf, pickNext, subtreeState, conflicts, type ExecMember } from "../../src/services/firmwareGroupService.js";

const topo = {
  parentsOf: new Map<string, string[]>([
    ["S1", ["G"]],
    ["S2", ["S1"]],          // chained switch
    ["A1", ["S2"]],
    ["M1", ["S1", "S3"]],    // dual-homed (MCLAG pair above it)
    ["S3", ["G"]],
  ]),
  typeOf: new Map<string, string>([["G", "firewall"], ["S1", "switch"], ["S2", "switch"], ["S3", "switch"], ["A1", "access_point"], ["M1", "switch"]]),
};

describe("topology snapshot", () => {
  it("ancestors are every hop up to the FortiGate, nearest first", () => {
    expect(ancestorsOf("A1", topo)).toEqual(["S2", "S1", "G"]);
    expect(ancestorsOf("M1", topo)).toEqual(["S1", "S3", "G"]);
    expect(ancestorsOf("G", topo)).toEqual([]);
  });

  it("depth is the longest path to the gate (1 = the gate)", () => {
    expect(depthOf("G", topo)).toBe(1);
    expect(depthOf("S1", topo)).toBe(2);
    expect(depthOf("A1", topo)).toBe(4);
    expect(depthOf("M1", topo)).toBe(3);
  });

  it("survives a cycle in bad data", () => {
    const loop = { parentsOf: new Map([["X", ["Y"]], ["Y", ["X"]]]), typeOf: new Map([["X", "switch"], ["Y", "switch"]]) };
    expect(() => depthOf("X", loop)).not.toThrow();
    expect(ancestorsOf("X", loop)).toEqual(["Y"]);
  });
});

function m(assetId: string, depth: number, ancestorIds: string[], state: ExecMember["state"] = "planned", extra: Partial<ExecMember> = {}): ExecMember {
  return { id: assetId, assetId, name: assetId, depth, ancestorIds, mclagPeerIds: [], state, skipKind: null, ...extra };
}

describe("ordering predicates", () => {
  it("conflicts covers ancestor, descendant and MCLAG peer — not siblings", () => {
    const a = m("A", 3, ["S", "G"]);
    expect(conflicts(a, m("S", 2, ["G"]))).toBe(true);
    expect(conflicts(m("S", 2, ["G"]), a)).toBe(true);
    expect(conflicts(a, m("B", 3, ["S", "G"]))).toBe(false);
    expect(conflicts(m("P", 2, ["G"], "planned", { mclagPeerIds: ["Q"] }), m("Q", 2, ["G"]))).toBe(true);
  });

  it("subtreeState: wait while a child is unfinished, clear when clean, the bad child otherwise", () => {
    const s = m("S", 2, ["G"]);
    expect(subtreeState(s, [s, m("A", 3, ["S", "G"])])).toBe("wait");
    expect(subtreeState(s, [s, m("A", 3, ["S", "G"], "upgraded"), m("B", 3, ["S", "G"], "dropped")])).toBeNull();
    expect(subtreeState(s, [s, m("A", 3, ["S", "G"], "skipped", { skipKind: "health" })])).toBeNull();
    const bad = m("A", 3, ["S", "G"], "failed");
    expect(subtreeState(s, [s, bad])).toEqual({ bad });
    expect(subtreeState(s, [s, m("A", 3, ["S", "G"], "skipped", { skipKind: "timeout" })])).not.toBeNull();
  });

  it("pickNext: deepest first, then name; skips tried and conflicting members", () => {
    const members = [m("G", 1, []), m("S", 2, ["G"]), m("B", 3, ["S", "G"]), m("A", 3, ["S", "G"])];
    expect(pickNext(members, new Set())?.assetId).toBe("A");
    expect(pickNext(members, new Set(["A"]))?.assetId).toBe("B");
    members[3].state = "running";
    // B is A's sibling — no conflict.
    expect(pickNext(members, new Set())?.assetId).toBe("B");
    members[2].state = "upgraded";
    // S waits for A, G waits for everything.
    expect(pickNext(members, new Set())).toBeNull();
  });
});
