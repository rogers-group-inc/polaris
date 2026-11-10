/**
 * tests/unit/automationTriggerFilters.test.ts — the trigger builder's FILTER
 * ROWS ("+ Condition → Device identifier / Component name") and the
 * device-identifier dimension matchers.
 *
 * Three pure surfaces:
 *  - tgFilterCompile / tgFilterLift (automations-wizard.js, off
 *    window.PolarisTriggerFilters): the wizard-side fold of filter rows into
 *    sibling conditions' dimensionFilter, and its inverse for rendering a
 *    stored rule. The STORED shape never carries a filter row — round-tripping
 *    these two is what keeps an edited automation meaning what it meant.
 *  - ipDimensionMatch / macDimensionMatch (notificationTypes) and their
 *    client mirrors (PolarisAutomationDimensions.ipMatch/macMatch): the match
 *    cue selects with the client copy while the engine selects with the
 *    server's, so the two are asserted EQUAL over a shared case table.
 *  - deviceFilterMatch + the engine's applyDeviceFilters gate live in
 *    notificationEngine.test.ts.
 */

import { describe, it, expect, beforeAll } from "vitest";
import vm from "node:vm";
import { ipDimensionMatch, macDimensionMatch } from "../../src/services/notificationTypes.js";
import { wizardSource } from "./_automationsWizardSource.js";

type Leaf = Record<string, any>;
type Group = { op: string; children: (Leaf | Group)[] };

let compile: (tree: Group, supports: (l: Leaf, d: string) => boolean, labelOf?: (d: string) => string) => { tree: Group; errors: string[] };
let lift: (tree: Group, supports: (l: Leaf, d: string) => boolean, dims: string[]) => Group;
let clientIpMatch: (ip: string | null, p?: string | null) => boolean;
let clientMacMatch: (mac: string | null, p?: string | null) => boolean;

beforeAll(() => {
  const code = wizardSource();
  const sandbox: Record<string, any> = {
    window: {},
    document: { addEventListener() {}, getElementById: () => null },
    escapeHtml: (x: unknown) => String(x ?? ""),
    api: {},
    permAtLeast: () => true,
    showToast: () => {},
  };
  sandbox.window.document = sandbox.document;
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);
  ({ compile, lift } = sandbox.window.PolarisTriggerFilters);
  clientIpMatch = sandbox.window.PolarisAutomationDimensions.ipMatch;
  clientMacMatch = sandbox.window.PolarisAutomationDimensions.macMatch;
});

// The wizard's real support rule in miniature: device identifiers apply to any
// asset leaf, component names to the leaves that take them.
const DEVICE_DIMS = ["hostnamePattern", "ipPattern", "macPattern", "manufacturerPattern", "modelPattern"];
const supports = (l: Leaf, d: string): boolean => {
  if (!l || l.type === "asset_filter" || l.type === "host_metric") return false;
  if (DEVICE_DIMS.includes(d)) return true;
  if (d === "ifNamePattern") return l.field === "ifOperStatus" || l.metric === "ifInBps";
  if (d === "tunnelName") return l.field === "ipsecStatus" || l.metric === "ipsecThroughputBps";
  if (d === "mountPathPattern") return String(l.metric ?? "").startsWith("storage");
  return false;
};
const ALL_DIMS = [...DEVICE_DIMS, "ifNamePattern", "tunnelName", "mountPathPattern"];

const metricLeaf = (over: Leaf = {}): Leaf => ({ type: "asset_metric", metric: "cpuPct", aggregation: "latest", windowSec: 0, operator: ">=", threshold: 90, ...over });
const stateLeaf = (over: Leaf = {}): Leaf => ({ type: "asset_state", field: "ifOperStatus", operator: "==", value: "down", ...over });
const filterRow = (dim: string, value: string): Leaf => ({ type: "asset_filter", dim, value });

describe("tgFilterCompile", () => {
  it("folds a filter into every supporting condition in its group and removes the row", () => {
    const { tree, errors } = compile({ op: "and", children: [stateLeaf(), filterRow("ifNamePattern", "wan"), filterRow("hostnamePattern", "CORE")] }, supports);
    expect(errors).toEqual([]);
    expect(tree.children).toHaveLength(1);
    expect((tree.children[0] as Leaf).dimensionFilter).toEqual({ ifNamePattern: "wan", hostnamePattern: "CORE" });
  });

  it("applies group filters into NESTED groups' leaves too", () => {
    // AND [hostname X, OR [cpu, mem]] means "(cpu OR mem) on X" per asset.
    const { tree, errors } = compile({
      op: "and",
      children: [
        { op: "or", children: [metricLeaf(), metricLeaf({ metric: "memPct" })] },
        filterRow("hostnamePattern", "db-"),
      ],
    }, supports);
    expect(errors).toEqual([]);
    const or = tree.children[0] as Group;
    expect((or.children as Leaf[]).map((l) => l.dimensionFilter)).toEqual([
      { hostnamePattern: "db-" }, { hostnamePattern: "db-" },
    ]);
  });

  it("never overwrites a deeper (more specific) value", () => {
    const { tree } = compile({
      op: "and",
      children: [
        { op: "and", children: [stateLeaf(), filterRow("ifNamePattern", "wan1")] },
        stateLeaf(),
        filterRow("ifNamePattern", "port"),
      ],
    }, supports);
    const inner = (tree.children[0] as Group).children[0] as Leaf;
    const outer = tree.children[1] as Leaf;
    expect(inner.dimensionFilter).toEqual({ ifNamePattern: "wan1" }); // nested row won
    expect(outer.dimensionFilter).toEqual({ ifNamePattern: "port" });
  });

  it("skips conditions that can't take the dimension, and errors when NONE can", () => {
    const one = compile({ op: "and", children: [metricLeaf(), stateLeaf(), filterRow("ifNamePattern", "wan")] }, supports);
    expect(one.errors).toEqual([]);
    expect((one.tree.children[0] as Leaf).dimensionFilter).toBeUndefined(); // cpuPct takes no interface
    expect((one.tree.children[1] as Leaf).dimensionFilter).toEqual({ ifNamePattern: "wan" });

    const none = compile({ op: "and", children: [metricLeaf(), filterRow("tunnelName", "to-hq")] }, supports, (_d) => "IPsec tunnel name");
    expect(none.errors.join(" ")).toContain("no condition in its group can take it");
    expect(none.errors.join(" ")).toContain("IPsec tunnel name");
  });

  it("refuses an empty value and a filter in an OR group", () => {
    const empty = compile({ op: "and", children: [stateLeaf(), filterRow("hostnamePattern", "  ")] }, supports);
    expect(empty.errors.join(" ")).toContain("give it a value");

    const orGroup = compile({ op: "or", children: [stateLeaf(), filterRow("hostnamePattern", "X")] }, supports);
    expect(orGroup.errors.join(" ")).toContain("AND group");
    // Refused, and NOT folded — "if down OR hostname X" must not silently
    // become "if down on X".
    expect((orGroup.tree.children[0] as Leaf).dimensionFilter).toBeUndefined();
  });
});

describe("tgFilterLift", () => {
  it("round-trips what compile produced, rows re-appearing after the conditions", () => {
    const authored: Group = { op: "and", children: [stateLeaf(), filterRow("ifNamePattern", "wan"), filterRow("hostnamePattern", "CORE")] };
    const stored = compile(JSON.parse(JSON.stringify(authored)), supports).tree;
    const reopened = lift(stored, supports, ALL_DIMS);
    expect(reopened.children).toHaveLength(3);
    expect((reopened.children[0] as Leaf).dimensionFilter).toBeUndefined();
    expect(reopened.children.slice(1)).toEqual([
      filterRow("hostnamePattern", "CORE"), // lift order follows the dims list
      filterRow("ifNamePattern", "wan"),
    ].sort((a, b) => ALL_DIMS.indexOf(a.dim) - ALL_DIMS.indexOf(b.dim)));
  });

  it("leaves DIFFERING per-leaf values inline rather than inventing a shared row", () => {
    const stored: Group = {
      op: "and",
      children: [
        stateLeaf({ dimensionFilter: { ifNamePattern: "wan1" } }),
        stateLeaf({ dimensionFilter: { ifNamePattern: "wan2" } }),
      ],
    };
    const reopened = lift(stored, supports, ALL_DIMS);
    expect(reopened.children).toHaveLength(2);
    expect((reopened.children[0] as Leaf).dimensionFilter).toEqual({ ifNamePattern: "wan1" });
    expect((reopened.children[1] as Leaf).dimensionFilter).toEqual({ ifNamePattern: "wan2" });
  });

  it("lifts a nested uniform filter at the TOPMOST and-group, and never from an OR group", () => {
    // The row surfaces at the outermost AND whose supporting descendants all
    // agree — compile re-applies it to the same descendants, so the round trip
    // is exact even though the row may render a level above where it was
    // authored.
    const stored: Group = {
      op: "and",
      children: [
        metricLeaf(),
        { op: "and", children: [stateLeaf({ dimensionFilter: { ifNamePattern: "wan" } })] },
      ],
    };
    const reopened = lift(JSON.parse(JSON.stringify(stored)), supports, ALL_DIMS);
    expect(reopened.children[2]).toEqual(filterRow("ifNamePattern", "wan"));
    const sub = reopened.children[1] as Group;
    expect((sub.children[0] as Leaf).dimensionFilter).toBeUndefined();
    // …and compiling the reopened tree restores the stored shape exactly.
    const { tree: recompiled, errors } = compile(reopened, supports);
    expect(errors).toEqual([]);
    expect(((recompiled.children[1] as Group).children[0] as Leaf).dimensionFilter).toEqual({ ifNamePattern: "wan" });
    expect((recompiled.children[0] as Leaf).dimensionFilter).toBeUndefined();

    const orStored: Group = { op: "or", children: [stateLeaf({ dimensionFilter: { ifNamePattern: "wan" } }), metricLeaf()] };
    const orReopened = lift(orStored, supports, ALL_DIMS);
    // Stays inline — a lifted row in an OR group would compile back as an error.
    expect((orReopened.children[0] as Leaf).dimensionFilter).toEqual({ ifNamePattern: "wan" });
    expect(orReopened.children).toHaveLength(2);
  });

  it("a leaf whose filter lifted completely loses its dimensionFilter key", () => {
    const stored: Group = { op: "and", children: [stateLeaf({ dimensionFilter: { ifNamePattern: "wan" } })] };
    const reopened = lift(stored, supports, ALL_DIMS);
    expect("dimensionFilter" in (reopened.children[0] as Leaf)).toBe(false);
  });
});

// One case table, both implementations — the cue must agree with the engine.
describe("IP / MAC dimension matchers (server + client mirror)", () => {
  const IP_CASES: Array<[string | null, string, boolean]> = [
    ["10.4.12.63", "10.4.12.63", true],   // exact
    ["110.4.12.63", "10.4.12.63", false], // the substring lie this matcher exists to prevent
    ["10.4.12.63", "10.4", true],         // octet-boundary prefix
    ["10.40.12.63", "10.4", false],
    ["10.4.12.63", "10.4.1.", false],     // explicit dot prefix is literal
    ["10.4.1.9", "10.4.1.", true],
    ["10.4.12.63", "10.4.0.0/16", true],  // CIDR containment
    ["10.5.12.63", "10.4.0.0/16", false],
    ["10.4.12.63", "not-a-cidr/16", false],
    [null, "10.4", false],
    ["10.4.12.63", "", true],             // no pattern = no filter
  ];
  const MAC_CASES: Array<[string | null, string, boolean]> = [
    ["aa:bb:cc:dd:ee:ff", "AA:BB:CC", true],
    ["aa:bb:cc:dd:ee:ff", "aa-bb-cc", true], // separator-insensitive
    ["aa:bb:cc:dd:ee:ff", "aabb.cc", true],
    ["aa:bb:cc:dd:ee:ff", "bccd", true],     // substring crosses separators
    ["aa:bb:cc:dd:ee:ff", "ff:aa", false],
    [null, "aa", false],
    ["aa:bb:cc:dd:ee:ff", "", true],
  ];

  it("ipDimensionMatch: CIDR / prefix / exact, never bare substring", () => {
    for (const [ip, p, want] of IP_CASES) {
      expect(ipDimensionMatch(ip, p), `${ip} ~ ${p}`).toBe(want);
      expect(clientIpMatch(ip, p), `client ${ip} ~ ${p}`).toBe(want);
    }
  });

  it("macDimensionMatch: separator-insensitive substring", () => {
    for (const [mac, p, want] of MAC_CASES) {
      expect(macDimensionMatch(mac, p), `${mac} ~ ${p}`).toBe(want);
      expect(clientMacMatch(mac, p), `client ${mac} ~ ${p}`).toBe(want);
    }
  });
});
