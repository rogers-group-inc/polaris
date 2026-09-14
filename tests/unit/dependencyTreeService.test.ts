/**
 * tests/unit/dependencyTreeService.test.ts
 *
 * Pure-function coverage for the dependency-tree builder, BFS layer
 * assignment, and the all-down multi-parent suppression evaluator. The
 * DB-bound recompute / reconcile wrappers are exercised via integration
 * tests separately.
 */

import { describe, it, expect } from "vitest";

import {
  buildDependencyEdgesFromInputs,
  assignLayers,
  evaluateSuppression,
  buildEndpointDependencyEdges,
  switchNameFromLastSeenSwitch,
  filterFreshLldpRows,
  type DepAsset,
  type DepEndpoint,
  type DepInterfaceEdge,
  type DepLldpEdge,
  type DepLldpRow,
  type SuppressionAssetState,
} from "../../src/services/dependencyTreeService.js";

// ─── helpers ────────────────────────────────────────────────────────────────

function fg(id: string, hostname: string): DepAsset {
  return { id, hostname, serialNumber: null, assetType: "firewall", fortinetTopology: null };
}
function sw(id: string, hostname: string, controllerFortigate?: string): DepAsset {
  return {
    id,
    hostname,
    serialNumber: null,
    assetType: "switch",
    fortinetTopology: controllerFortigate ? { role: "fortiswitch", controllerFortigate } : null,
  };
}
function ap(id: string, hostname: string, parentSwitch?: string, controllerFortigate?: string): DepAsset {
  return {
    id,
    hostname,
    serialNumber: null,
    assetType: "access_point",
    fortinetTopology: { role: "fortiap", parentSwitch, controllerFortigate },
  };
}

// ─── buildDependencyEdgesFromInputs ─────────────────────────────────────────

describe("buildDependencyEdgesFromInputs", () => {
  it("emits controller→switch edges from fortinetTopology", () => {
    const assets = [fg("fg1", "FG-EDGE-01"), sw("sw1", "FS-CORE-01", "FG-EDGE-01")];
    const edges = buildDependencyEdgesFromInputs(assets, [], []);
    expect(edges).toEqual([
      { childAssetId: "sw1", parentAssetId: "fg1", detectedVia: "controller" },
    ]);
  });

  // ── FMG device name ≠ gate hostname (prod 2026-08-12) ────────────────────
  //
  // A switch stamps `controllerFortigate` with FortiManager's DEVICE NAME. The
  // firewall's Asset.hostname is projected from the gate's own configured
  // hostname. When an operator names the FMG device differently the two never
  // matched, the switch got NO parent, and — since suppression requires at least
  // one effective parent — it could never enter dependency-down: a FortiGate in
  // a maintenance window left its switches reading plain "Down".
  it("resolves the controller by serial when the FMG device name differs from the gate hostname", () => {
    const assets: DepAsset[] = [
      { id: "fg1", hostname: "fg-edge-01.corp", serialNumber: "FG100F0001", assetType: "firewall", fortinetTopology: null },
      {
        id: "sw1",
        hostname: "S248EPTF0001",
        serialNumber: "S248EPTF0001",
        assetType: "switch",
        fortinetTopology: { role: "fortiswitch", controllerFortigate: "SITE-01-FW", controllerSerial: "FG100F0001" },
      },
    ];
    expect(buildDependencyEdgesFromInputs(assets, [], [])).toEqual([
      { childAssetId: "sw1", parentAssetId: "fg1", detectedVia: "controller" },
    ]);
  });

  it("resolves the controller via the gate's own FMG device-name stamp with no controllerSerial", () => {
    // Pre-fix rows carry no `controllerSerial` until their integration
    // re-discovers, so the edge has to come back from data already on disk.
    const assets: DepAsset[] = [
      {
        id: "fg1",
        hostname: "fg-edge-01.corp",
        serialNumber: "FG100F0001",
        assetType: "firewall",
        fortinetTopology: { role: "fortigate", deviceName: "SITE-01-FW" },
      },
      {
        id: "sw1",
        hostname: "S248EPTF0001",
        serialNumber: "S248EPTF0001",
        assetType: "switch",
        fortinetTopology: { role: "fortiswitch", controllerFortigate: "SITE-01-FW" },
      },
    ];
    expect(buildDependencyEdgesFromInputs(assets, [], [])).toEqual([
      { childAssetId: "sw1", parentAssetId: "fg1", detectedVia: "controller" },
    ]);
  });

  it("does not treat the AP's real uplink switch as bridged when the switch hostname is an operator label", () => {
    // The AP stamps parentSwitch from LLDP, which reports the switch-id (=
    // serial). Comparing that to Asset.hostname alone failed for a renamed
    // switch and INVERTED the topology: the switch was classified as bridged
    // behind the AP, losing its FortiLink edge to the FortiGate. Here the AP's
    // parentSwitch names the serial while the switch's hostname is a label —
    // the switch must still hang off the firewall.
    const assets: DepAsset[] = [
      { id: "fg1", hostname: "FG-EDGE-01", serialNumber: "FG100F0001", assetType: "firewall", fortinetTopology: null },
      {
        id: "sw1",
        hostname: "IDF-2-ACCESS",
        serialNumber: "S248EPTF0001",
        assetType: "switch",
        fortinetTopology: { role: "fortiswitch", controllerFortigate: "FG-EDGE-01" },
      },
      {
        id: "ap1",
        hostname: "FAP-IDF2",
        serialNumber: "FP231F0001",
        assetType: "access_point",
        fortinetTopology: { role: "fortiap", parentSwitch: "S248EPTF0001" },
      },
    ];
    const edges = buildDependencyEdgesFromInputs(assets, [], []);
    expect(edges).toEqual(expect.arrayContaining([
      { childAssetId: "sw1", parentAssetId: "fg1", detectedVia: "controller" },
      { childAssetId: "ap1", parentAssetId: "sw1", detectedVia: "controller" },
    ]));
  });

  it("still emits no edge when the controller genuinely is not in the inventory", () => {
    // Absence of a parent must stay absence — the serial fallbacks must not
    // invent an edge to some other gate.
    const assets: DepAsset[] = [
      { id: "fg1", hostname: "FG-OTHER", serialNumber: "FG100F9999", assetType: "firewall", fortinetTopology: null },
      {
        id: "sw1",
        hostname: "FS-CORE-01",
        serialNumber: "S248EPTF0001",
        assetType: "switch",
        fortinetTopology: { role: "fortiswitch", controllerFortigate: "NOT-DISCOVERED", controllerSerial: "FG100F0001" },
      },
    ];
    expect(buildDependencyEdgesFromInputs(assets, [], [])).toEqual([]);
  });

  it("makes a mesh leaf AP depend on its root AP, not the controller-resolved switch", () => {
    const assets = [
      fg("fg1", "FG-EDGE-01"),
      sw("sw1", "FS-CORE-01", "FG-EDGE-01"),
      ap("apRoot", "FAP-ROOT", "FS-CORE-01"), // root AP genuinely on the switch
      ap("apLeaf", "FAP-LEAF", "FS-CORE-01"), // discovery WRONGLY put the leaf on the switch
    ];
    const meshEdges = [{ rootApId: "apRoot", leafApId: "apLeaf" }];
    const edges = buildDependencyEdgesFromInputs(assets, [], [], meshEdges);
    // Leaf gets NO controller edge to the switch...
    expect(edges).not.toContainEqual({ childAssetId: "apLeaf", parentAssetId: "sw1", detectedVia: "controller" });
    // ...and instead a mesh edge to its root AP.
    expect(edges).toContainEqual({ childAssetId: "apLeaf", parentAssetId: "apRoot", detectedVia: "mesh" });

    const { layers, keptEdges } = assignLayers(assets, edges);
    // fg=1, sw=2, apRoot=3, apLeaf=4 (one layer below its root AP).
    expect(layers.get("apRoot")).toBe(3);
    expect(layers.get("apLeaf")).toBe(4);
    const leafParent = keptEdges.find((e) => e.childAssetId === "apLeaf");
    expect(leafParent).toEqual({ childAssetId: "apLeaf", parentAssetId: "apRoot", detectedVia: "mesh" });
  });

  it("makes a switch bridged behind an AP depend on the AP, not the FortiGate", () => {
    const assets = [
      fg("fg1", "FG-EDGE-01"),
      ap("apX", "FAP-REMOTE", undefined, "FG-EDGE-01"), // remote AP, no parentSwitch
      sw("swBridge", "FS-REMOTE", "FG-EDGE-01"), // FortiLink-managed switch behind apX
    ];
    const lldpEdges = [{ assetId: "apX", matchedAssetId: "swBridge" }];
    const bridgeLeaves = new Set(["swBridge"]);
    const edges = buildDependencyEdgesFromInputs(assets, [], lldpEdges, [], bridgeLeaves);
    // FortiLink controller edge to the FortiGate is suppressed...
    expect(edges).not.toContainEqual({ childAssetId: "swBridge", parentAssetId: "fg1", detectedVia: "controller" });
    // ...replaced by an LLDP edge to the AP.
    expect(edges).toContainEqual({ childAssetId: "swBridge", parentAssetId: "apX", detectedVia: "lldp" });

    const { layers, keptEdges } = assignLayers(assets, edges);
    expect(layers.get("apX")).toBe(2); // AP off the FortiGate
    expect(layers.get("swBridge")).toBe(3); // bridged switch off the AP
    const leafParent = keptEdges.find((e) => e.childAssetId === "swBridge");
    expect(leafParent).toEqual({ childAssetId: "swBridge", parentAssetId: "apX", detectedVia: "lldp" });
  });

  it("suppresses a mesh leaf's backwards controller edge via fortinetTopology.meshUplink even without station-derived mesh edges", () => {
    // The user-reported inversion: a mesh-leaf AP (FortiOS mesh_uplink="mesh")
    // whose LLDP sees a switch bridged behind its LAN port. Pre-fix discovery
    // stamped that switch as the leaf's parentSwitch, so the controller edge
    // pointed BACKWARDS (leaf depends on the bridged switch). The stamped
    // meshUplink flag alone — no root-AP station scrape required — must
    // suppress it, and with the switch flagged as a bridge leaf the switch
    // depends on the AP via LLDP.
    const meshLeaf: DepAsset = {
      id: "apLeaf",
      hostname: "FP234FTF21000002",
      serialNumber: null,
      assetType: "access_point",
      fortinetTopology: { role: "fortiap", parentSwitch: "S108EFTQ21000001", controllerFortigate: "FG-EDGE-01", meshUplink: "mesh" },
    };
    const assets = [fg("fg1", "FG-EDGE-01"), sw("swBridge", "S108EFTQ21000001", "FG-EDGE-01"), meshLeaf];
    const lldpEdges = [{ assetId: "apLeaf", matchedAssetId: "swBridge" }];
    const edges = buildDependencyEdgesFromInputs(assets, [], lldpEdges, [], new Set(["swBridge"]));
    // No backwards leaf→bridged-switch controller edge…
    expect(edges).not.toContainEqual({ childAssetId: "apLeaf", parentAssetId: "swBridge", detectedVia: "controller" });
    // …and the bridged switch's FortiLink edge stays suppressed in favor of
    // the LLDP edge to the AP.
    expect(edges).not.toContainEqual({ childAssetId: "swBridge", parentAssetId: "fg1", detectedVia: "controller" });
    expect(edges).toContainEqual({ childAssetId: "swBridge", parentAssetId: "apLeaf", detectedVia: "lldp" });
  });

  it("emits switch→AP edges from fortinetTopology.parentSwitch", () => {
    const assets = [
      fg("fg1", "FG-EDGE-01"),
      sw("sw1", "FS-CORE-01", "FG-EDGE-01"),
      ap("ap1", "FAP-01", "FS-CORE-01"),
    ];
    const edges = buildDependencyEdgesFromInputs(assets, [], []);
    expect(edges).toContainEqual({ childAssetId: "ap1", parentAssetId: "sw1", detectedVia: "controller" });
  });

  it("falls back to FortiGate parent for an AP not behind a switch", () => {
    const assets = [
      fg("fg1", "FG-EDGE-01"),
      ap("ap1", "FAP-01", undefined, "FG-EDGE-01"),
    ];
    const edges = buildDependencyEdgesFromInputs(assets, [], []);
    expect(edges).toContainEqual({ childAssetId: "ap1", parentAssetId: "fg1", detectedVia: "controller" });
  });

  it("emits both directions for interface edges (BFS resolves direction)", () => {
    const assets = [sw("sw1", "FS-A"), sw("sw2", "FS-B")];
    const edges = buildDependencyEdgesFromInputs(assets, [{ sourceAssetId: "sw1", targetAssetId: "sw2" }], []);
    expect(edges).toContainEqual({ childAssetId: "sw1", parentAssetId: "sw2", detectedVia: "interface" });
    expect(edges).toContainEqual({ childAssetId: "sw2", parentAssetId: "sw1", detectedVia: "interface" });
  });

  it("emits one edge per signal kind for the same pair (collapsing happens in assignLayers' prune step)", () => {
    const assets = [fg("fg1", "FG-EDGE-01"), sw("sw1", "FS-CORE-01", "FG-EDGE-01")];
    const edges = buildDependencyEdgesFromInputs(
      assets,
      [{ sourceAssetId: "sw1", targetAssetId: "fg1" }],
      [{ assetId: "sw1", matchedAssetId: "fg1" }],
    );
    const swToFg = edges.filter(e => e.childAssetId === "sw1" && e.parentAssetId === "fg1");
    const kinds = swToFg.map(e => e.detectedVia).sort();
    expect(kinds).toEqual(["controller", "interface", "lldp"]);
  });

  it("ignores self-loops and references to unknown assets", () => {
    const assets = [sw("sw1", "FS-A")];
    const edges = buildDependencyEdgesFromInputs(
      assets,
      [
        { sourceAssetId: "sw1", targetAssetId: "sw1" }, // self-loop
        { sourceAssetId: "sw1", targetAssetId: "ghost" }, // unknown peer
      ],
      [],
    );
    expect(edges).toEqual([]);
  });

  it("does not bind a switch's controllerFortigate to an asset of the wrong type", () => {
    // hostname collides with an AP, not a firewall — must NOT create the edge.
    const assets = [
      ap("ap1", "FG-EDGE-01"), // pretend an AP somehow shares a hostname with a FortiGate
      sw("sw1", "FS-CORE-01", "FG-EDGE-01"),
    ];
    const edges = buildDependencyEdgesFromInputs(assets, [], []);
    expect(edges.find(e => e.childAssetId === "sw1")).toBeUndefined();
  });
});

// ─── assignLayers ───────────────────────────────────────────────────────────

describe("assignLayers", () => {
  it("assigns layer 1 to every FortiGate root", () => {
    const assets = [fg("fg1", "A"), fg("fg2", "B"), sw("sw1", "C")];
    const { layers } = assignLayers(assets, []);
    expect(layers.get("fg1")).toBe(1);
    expect(layers.get("fg2")).toBe(1);
    expect(layers.has("sw1")).toBe(false); // no edges → unresolved
  });

  it("walks a 4-tier chain (FG → core → distribution → access)", () => {
    const assets = [
      fg("fg",  "FG"),
      sw("core","CORE", "FG"),
      sw("dist","DIST"), // chained via interface edge to core
      sw("acc", "ACC"),  // chained via interface edge to dist
    ];
    const ifEdges: DepInterfaceEdge[] = [
      { sourceAssetId: "core", targetAssetId: "dist" },
      { sourceAssetId: "dist", targetAssetId: "acc"  },
    ];
    const candidate = buildDependencyEdgesFromInputs(assets, ifEdges, []);
    const { layers, keptEdges } = assignLayers(assets, candidate);
    expect(layers.get("fg")).toBe(1);
    expect(layers.get("core")).toBe(2);
    expect(layers.get("dist")).toBe(3);
    expect(layers.get("acc")).toBe(4);
    expect(keptEdges).toContainEqual({ childAssetId: "core", parentAssetId: "fg",   detectedVia: "controller" });
    expect(keptEdges).toContainEqual({ childAssetId: "dist", parentAssetId: "core", detectedVia: "interface" });
    expect(keptEdges).toContainEqual({ childAssetId: "acc",  parentAssetId: "dist", detectedVia: "interface" });
  });

  it("MCLAG-paired switches at the same layer don't become parents of each other", () => {
    // FG at L1; sw1 + sw2 both controllerFortigate=FG → both L2; mutual interface edge.
    const assets = [
      fg("fg",  "FG"),
      sw("sw1", "A", "FG"),
      sw("sw2", "B", "FG"),
    ];
    const ifEdges: DepInterfaceEdge[] = [{ sourceAssetId: "sw1", targetAssetId: "sw2" }];
    const candidate = buildDependencyEdgesFromInputs(assets, ifEdges, []);
    const { layers, keptEdges } = assignLayers(assets, candidate);
    expect(layers.get("sw1")).toBe(2);
    expect(layers.get("sw2")).toBe(2);
    // Same-layer edges are pruned.
    expect(keptEdges.find(e => e.childAssetId === "sw1" && e.parentAssetId === "sw2")).toBeUndefined();
    expect(keptEdges.find(e => e.childAssetId === "sw2" && e.parentAssetId === "sw1")).toBeUndefined();
  });

  it("dual-homed switch records BOTH FortiGates as parents", () => {
    // controllerFortigate is single-valued, but the second FG also has an
    // interface edge from sw1 — both end up as L1 parents at L2.
    const assets = [
      fg("fg1", "FG-A"),
      fg("fg2", "FG-B"),
      sw("sw1", "DUAL", "FG-A"),
    ];
    const ifEdges: DepInterfaceEdge[] = [{ sourceAssetId: "sw1", targetAssetId: "fg2" }];
    const candidate = buildDependencyEdgesFromInputs(assets, ifEdges, []);
    const { layers, keptEdges } = assignLayers(assets, candidate);
    expect(layers.get("sw1")).toBe(2);
    const sw1Parents = keptEdges.filter(e => e.childAssetId === "sw1").map(e => e.parentAssetId).sort();
    expect(sw1Parents).toEqual(["fg1", "fg2"]);
  });

  it("chains a 3-switch daisy where every switch reports controllerFortigate=FG and only siblings are LLDP-connected", () => {
    // The bug-fix case: all three switches are FortiLink-managed by the
    // same FG (so every one has a controller edge to FG), but the chain
    // head 148F-1 has no detectable physical edge back to the FG. Only
    // sibling LLDP edges (148F-1↔148F-2, 148F-2↔148F-3) exist. The chain
    // should still resolve via the controller-fallback simple-path
    // detection so 148F-2 attaches under 148F-1 and 148F-3 under 148F-2.
    const assets = [
      fg("fg",   "LAKESIDE-91G-1"),
      sw("sw1",  "LAKESIDE-148F-1", "LAKESIDE-91G-1"),
      sw("sw2",  "LAKESIDE-148F-2", "LAKESIDE-91G-1"),
      sw("sw3",  "LAKESIDE-148F-3", "LAKESIDE-91G-1"),
    ];
    const candidate = buildDependencyEdgesFromInputs(
      assets,
      [],
      [
        { assetId: "sw1", matchedAssetId: "sw2" },
        { assetId: "sw2", matchedAssetId: "sw1" },
        { assetId: "sw2", matchedAssetId: "sw3" },
        { assetId: "sw3", matchedAssetId: "sw2" },
      ],
    );
    const { layers, keptEdges } = assignLayers(assets, candidate);
    expect(layers.get("fg")).toBe(1);
    expect(layers.get("sw1")).toBe(2);
    expect(layers.get("sw2")).toBe(3);
    expect(layers.get("sw3")).toBe(4);
    const parentOf = (id: string) =>
      keptEdges.find(e => e.childAssetId === id)?.parentAssetId;
    expect(parentOf("sw1")).toBe("fg");
    expect(parentOf("sw2")).toBe("sw1");
    expect(parentOf("sw3")).toBe("sw2");
  });

  it("prefers physical-uplink edges over controller edges when both reach the FG", () => {
    // The clean case: 148F-1 has both a controller edge (FortiLink mgmt)
    // and an LLDP edge to the FG. Physical-first BFS lands 148F-1 at L2
    // via the LLDP edge directly, and the kept edge for the (sw1, fg)
    // pair carries detectedVia="lldp" rather than "controller" so the
    // audit trail reflects the cable, not just the management contract.
    const assets = [fg("fg", "FG"), sw("sw1", "SW", "FG")];
    const candidate = buildDependencyEdgesFromInputs(
      assets,
      [],
      [{ assetId: "sw1", matchedAssetId: "fg" }, { assetId: "fg", matchedAssetId: "sw1" }],
    );
    const { layers, keptEdges } = assignLayers(assets, candidate);
    expect(layers.get("sw1")).toBe(2);
    const swEdge = keptEdges.find(e => e.childAssetId === "sw1" && e.parentAssetId === "fg");
    expect(swEdge?.detectedVia).toBe("lldp");
  });

  it("orphans (no path from any FG) end up unresolved", () => {
    const assets = [
      fg("fg",  "FG"),
      sw("sw1", "ISLAND-A"),
      sw("sw2", "ISLAND-B"),
    ];
    const ifEdges: DepInterfaceEdge[] = [{ sourceAssetId: "sw1", targetAssetId: "sw2" }];
    const candidate = buildDependencyEdgesFromInputs(assets, ifEdges, []);
    const { layers, unresolved } = assignLayers(assets, candidate);
    expect(layers.get("fg")).toBe(1);
    expect(unresolved.sort()).toEqual(["sw1", "sw2"]);
  });
});

// ─── evaluateSuppression ────────────────────────────────────────────────────

describe("evaluateSuppression", () => {
  function st(id: string, layer: number | null, monitorStatus: string | null, monitored = true): SuppressionAssetState {
    return { id, layer, monitorStatus, monitored, currentlySuppressed: false };
  }

  it("orphans (no parents) are never suppressed", () => {
    const states = [st("a", 1, "down")];
    const out = evaluateSuppression(states, new Map());
    expect(out.get("a")).toBe(false);
  });

  it("single parent down → child suppressed", () => {
    const states = [st("fg", 1, "down"), st("sw", 2, "up")];
    const parents = new Map([["sw", ["fg"]]]);
    const out = evaluateSuppression(states, parents);
    expect(out.get("fg")).toBe(false);
    expect(out.get("sw")).toBe(true);
  });

  it("multi-parent: ANY parent up → child not suppressed", () => {
    const states = [st("fg1", 1, "down"), st("fg2", 1, "up"), st("sw", 2, "up")];
    const parents = new Map([["sw", ["fg1", "fg2"]]]);
    const out = evaluateSuppression(states, parents);
    expect(out.get("sw")).toBe(false);
  });

  it("multi-parent: ALL parents down → child suppressed", () => {
    const states = [st("fg1", 1, "down"), st("fg2", 1, "down"), st("sw", 2, "up")];
    const parents = new Map([["sw", ["fg1", "fg2"]]]);
    const out = evaluateSuppression(states, parents);
    expect(out.get("sw")).toBe(true);
  });

  it("transitive: parent suppressed → grandchild suppressed too", () => {
    const states = [
      st("fg",   1, "down"),
      st("core", 2, "up"),
      st("acc",  3, "up"),
    ];
    const parents = new Map([["core", ["fg"]], ["acc", ["core"]]]);
    const out = evaluateSuppression(states, parents);
    expect(out.get("core")).toBe(true);
    expect(out.get("acc")).toBe(true);
  });

  it("warning / recovering parents do NOT suppress descendants", () => {
    // Suppression follows confirmed-down only.
    const wState = [st("fg", 1, "warning"), st("sw", 2, "up")];
    const rState = [st("fg", 1, "recovering"), st("sw", 2, "up")];
    const parents = new Map([["sw", ["fg"]]]);
    expect(evaluateSuppression(wState, parents).get("sw")).toBe(false);
    expect(evaluateSuppression(rState, parents).get("sw")).toBe(false);
  });

  it("unmonitored parent is transparent — walks up to grandparents", () => {
    // sw_mid is unmonitored; FG is down; acc should be suppressed because
    // its only chain back to a monitored ancestor is via a down FG.
    const states = [
      st("fg",     1, "down"),
      st("sw_mid", 2, null, /*monitored=*/false),
      st("acc",    3, "up"),
    ];
    const parents = new Map([["sw_mid", ["fg"]], ["acc", ["sw_mid"]]]);
    const out = evaluateSuppression(states, parents);
    expect(out.get("acc")).toBe(true);
  });

  it("unmonitored parent with no grandparents is treated as ok", () => {
    // No monitored ancestor → no signal → not suppressed.
    const states = [
      st("orphan", 2, null, /*monitored=*/false),
      st("acc",    3, "up"),
    ];
    const parents = new Map([["acc", ["orphan"]]]);
    const out = evaluateSuppression(states, parents);
    expect(out.get("acc")).toBe(false);
  });

  // HA standby FortiGate parents — an unmonitored standby is IGNORED
  // (removed from the parent set), NOT transparent-ok. A switch LLDP-cabled
  // to both HA members must suppress on the primary's confirmed-down alone;
  // the generic no-monitored-ancestor rule would otherwise permanently veto
  // all-down suppression for the whole site.
  it("unmonitored HA-standby co-parent does not veto suppression when the primary is down", () => {
    const states: SuppressionAssetState[] = [
      st("fg_primary", 1, "down"),
      { ...st("fg_standby", 1, null, /*monitored=*/false), isHaStandby: true },
      st("sw", 2, "up"),
    ];
    const parents = new Map([["sw", ["fg_primary", "fg_standby"]]]);
    const out = evaluateSuppression(states, parents);
    expect(out.get("sw")).toBe(true);
  });

  it("unmonitored HA-standby co-parent stays invisible when the primary is up", () => {
    const states: SuppressionAssetState[] = [
      st("fg_primary", 1, "up"),
      { ...st("fg_standby", 1, null, /*monitored=*/false), isHaStandby: true },
      st("sw", 2, "up"),
    ];
    const parents = new Map([["sw", ["fg_primary", "fg_standby"]]]);
    const out = evaluateSuppression(states, parents);
    expect(out.get("sw")).toBe(false);
  });

  it("standby-only parent set → never suppressed (safe post-failover transient)", () => {
    const states: SuppressionAssetState[] = [
      { ...st("fg_standby", 1, null, /*monitored=*/false), isHaStandby: true },
      st("sw", 2, "up"),
    ];
    const parents = new Map([["sw", ["fg_standby"]]]);
    const out = evaluateSuppression(states, parents);
    expect(out.get("sw")).toBe(false);
  });

  it("MONITORED standby (operator opt-in) evaluates by its own probe state", () => {
    // Down monitored standby + down primary → all-down → suppressed;
    // up monitored standby + down primary → not suppressed.
    const parents = new Map([["sw", ["fg_primary", "fg_standby"]]]);
    const downStates: SuppressionAssetState[] = [
      st("fg_primary", 1, "down"),
      { ...st("fg_standby", 1, "down", /*monitored=*/true), isHaStandby: true },
      st("sw", 2, "up"),
    ];
    expect(evaluateSuppression(downStates, parents).get("sw")).toBe(true);
    const upStates: SuppressionAssetState[] = [
      st("fg_primary", 1, "down"),
      { ...st("fg_standby", 1, "up", /*monitored=*/true), isHaStandby: true },
      st("sw", 2, "up"),
    ];
    expect(evaluateSuppression(upStates, parents).get("sw")).toBe(false);
  });

  it("standby filtered inside the transparent walk — unmonitored mid-switch whose parents are a down FG and a standby still suppresses the grandchild", () => {
    const states: SuppressionAssetState[] = [
      st("fg_primary", 1, "down"),
      { ...st("fg_standby", 1, null, /*monitored=*/false), isHaStandby: true },
      st("sw_mid", 2, null, /*monitored=*/false),
      st("acc", 3, "up"),
    ];
    const parents = new Map([
      ["sw_mid", ["fg_primary", "fg_standby"]],
      ["acc",    ["sw_mid"]],
    ]);
    const out = evaluateSuppression(states, parents);
    expect(out.get("acc")).toBe(true);
  });

  // Admin-only "Dependency Test" overlay — parent with a future
  // dependencyTestUntil is treated as confirmed-down for suppression even
  // when its real probe is up. Past timestamps are inactive (auto-expired).
  it("dependencyTestUntil in the future treats parent as down", () => {
    const future = new Date(Date.now() + 30 * 60 * 1000);
    const states: SuppressionAssetState[] = [
      { id: "fg",  layer: 1, monitorStatus: "up", monitored: true, currentlySuppressed: false, dependencyTestUntil: future },
      { id: "sw",  layer: 2, monitorStatus: "up", monitored: true, currentlySuppressed: false },
    ];
    const parents = new Map([["sw", ["fg"]]]);
    const out = evaluateSuppression(states, parents);
    expect(out.get("sw")).toBe(true);
  });

  it("dependencyTestUntil in the past is ignored (acts as inactive)", () => {
    const past = new Date(Date.now() - 60 * 1000);
    const states: SuppressionAssetState[] = [
      { id: "fg",  layer: 1, monitorStatus: "up", monitored: true, currentlySuppressed: false, dependencyTestUntil: past },
      { id: "sw",  layer: 2, monitorStatus: "up", monitored: true, currentlySuppressed: false },
    ];
    const parents = new Map([["sw", ["fg"]]]);
    const out = evaluateSuppression(states, parents);
    expect(out.get("sw")).toBe(false);
  });

  it("dependency-test parent does NOT walk transparently to grandparents", () => {
    // Operator's intent is "pretend THIS box went offline" — even when an
    // upstream root is healthy, children of the test target stay suppressed.
    const future = new Date(Date.now() + 30 * 60 * 1000);
    const states: SuppressionAssetState[] = [
      { id: "fg",  layer: 1, monitorStatus: "up", monitored: true, currentlySuppressed: false },
      { id: "sw",  layer: 2, monitorStatus: "up", monitored: true, currentlySuppressed: false, dependencyTestUntil: future },
      { id: "acc", layer: 3, monitorStatus: "up", monitored: true, currentlySuppressed: false },
    ];
    const parents = new Map([["sw", ["fg"]], ["acc", ["sw"]]]);
    const out = evaluateSuppression(states, parents);
    expect(out.get("sw")).toBe(false);  // sw itself only depends on fg, which is up
    expect(out.get("acc")).toBe(true);  // acc's only parent is in test mode
  });

  it("multi-parent: test-active parent counts as down for the all-down rule", () => {
    // sw has two FortiGate parents; one is test-active, one is up. With
    // all-down semantics, ANY parent being up keeps sw not-suppressed.
    const future = new Date(Date.now() + 30 * 60 * 1000);
    const states: SuppressionAssetState[] = [
      { id: "fg1", layer: 1, monitorStatus: "up", monitored: true, currentlySuppressed: false, dependencyTestUntil: future },
      { id: "fg2", layer: 1, monitorStatus: "up", monitored: true, currentlySuppressed: false },
      { id: "sw",  layer: 2, monitorStatus: "up", monitored: true, currentlySuppressed: false },
    ];
    const parents = new Map([["sw", ["fg1", "fg2"]]]);
    const out = evaluateSuppression(states, parents);
    expect(out.get("sw")).toBe(false);
  });

  // Maintenance window — a parent with status="maintenance" behaves exactly
  // like an active Dependency Test overlay: confirmed-down for suppression,
  // no transparent walk to grandparents.
  it("maintenance parent treats children as dependency-down", () => {
    const states: SuppressionAssetState[] = [
      { id: "sw",  layer: 2, monitorStatus: "up", monitored: true, currentlySuppressed: false, status: "maintenance" },
      { id: "acc", layer: 3, monitorStatus: "up", monitored: true, currentlySuppressed: false, status: "active" },
    ];
    const parents = new Map([["acc", ["sw"]]]);
    const out = evaluateSuppression(states, parents);
    expect(out.get("acc")).toBe(true);
    expect(out.get("sw")).toBe(false); // the maintained box itself is not suppressed
  });

  it("maintenance parent does NOT walk transparently to a healthy grandparent", () => {
    const states: SuppressionAssetState[] = [
      { id: "fg",  layer: 1, monitorStatus: "up", monitored: true, currentlySuppressed: false, status: "active" },
      { id: "sw",  layer: 2, monitorStatus: "up", monitored: true, currentlySuppressed: false, status: "maintenance" },
      { id: "acc", layer: 3, monitorStatus: "up", monitored: true, currentlySuppressed: false, status: "active" },
    ];
    const parents = new Map([["sw", ["fg"]], ["acc", ["sw"]]]);
    const out = evaluateSuppression(states, parents);
    expect(out.get("acc")).toBe(true);
  });

  it("multi-parent: one maintained + one healthy parent keeps the child up (all-down rule)", () => {
    const states: SuppressionAssetState[] = [
      { id: "fg1", layer: 1, monitorStatus: "up", monitored: true, currentlySuppressed: false, status: "maintenance" },
      { id: "fg2", layer: 1, monitorStatus: "up", monitored: true, currentlySuppressed: false, status: "active" },
      { id: "sw",  layer: 2, monitorStatus: "up", monitored: true, currentlySuppressed: false, status: "active" },
    ];
    const parents = new Map([["sw", ["fg1", "fg2"]]]);
    const out = evaluateSuppression(states, parents);
    expect(out.get("sw")).toBe(false);
  });

  // Per-schedule opt-out (suppressChildren=false → maintenanceSuppressChildren
  // false on the state): the maintenance status is ignored by suppression and
  // the parent evaluates by its frozen monitorStatus.
  it("maintenance parent with suppressChildren=false leaves an up-parent's children unsuppressed", () => {
    const states: SuppressionAssetState[] = [
      { id: "sw",  layer: 2, monitorStatus: "up", monitored: true, currentlySuppressed: false, status: "maintenance", maintenanceSuppressChildren: false },
      { id: "acc", layer: 3, monitorStatus: "up", monitored: true, currentlySuppressed: false, status: "active" },
    ];
    const parents = new Map([["acc", ["sw"]]]);
    const out = evaluateSuppression(states, parents);
    expect(out.get("acc")).toBe(false);
  });

  it("maintenance parent with suppressChildren=false still suppresses via its frozen down monitorStatus", () => {
    // Parent was already down when the window opened — the opt-out only
    // removes the maintenance-implies-down shortcut, not real down state.
    const states: SuppressionAssetState[] = [
      { id: "sw",  layer: 2, monitorStatus: "down", monitored: true, currentlySuppressed: false, status: "maintenance", maintenanceSuppressChildren: false },
      { id: "acc", layer: 3, monitorStatus: "up",   monitored: true, currentlySuppressed: false, status: "active" },
    ];
    const parents = new Map([["acc", ["sw"]]]);
    const out = evaluateSuppression(states, parents);
    expect(out.get("acc")).toBe(true);
  });

  it("maintenanceSuppressChildren=true (explicit) matches the default maintenance-down behavior", () => {
    const states: SuppressionAssetState[] = [
      { id: "sw",  layer: 2, monitorStatus: "up", monitored: true, currentlySuppressed: false, status: "maintenance", maintenanceSuppressChildren: true },
      { id: "acc", layer: 3, monitorStatus: "up", monitored: true, currentlySuppressed: false, status: "active" },
    ];
    const parents = new Map([["acc", ["sw"]]]);
    const out = evaluateSuppression(states, parents);
    expect(out.get("acc")).toBe(true);
  });
});

// ─── Release hysteresis ─────────────────────────────────────────────────────
// Entering suppression needs a CONFIRMED-down parent; leaving it needs a
// parent that is genuinely back — `up`, the bucket drained to zero, which is
// the number of answered polls the operator's own automation asked for.
// `recovering` and `warning` are neither: mid-flap the parent is still short of
// that threshold and drops back to `down` on the next miss. Releasing there
// un-suppresses the whole subtree on the strength of one packet, and every
// child — whose own probes are still failing — immediately starts its own down
// run and re-alerts as plain Down, which is the storm suppression exists to
// prevent. Only the two non-verdicts (`unknown`, `passive`) still release.

describe("evaluateSuppression — release hysteresis", () => {
  function st3(
    id: string,
    layer: number | null,
    monitorStatus: string | null,
    currentlySuppressed = false,
  ): SuppressionAssetState {
    return { id, layer, monitorStatus, monitored: true, currentlySuppressed };
  }
  const parents = new Map([["sw", ["fg"]]]);

  it("holds a suppressed child while the parent is only RECOVERING", () => {
    const out = evaluateSuppression(
      [st3("fg", 1, "recovering"), st3("sw", 2, "down", true)],
      parents,
    );
    expect(out.get("sw")).toBe(true);
  });

  it("releases as soon as the parent reaches UP", () => {
    const out = evaluateSuppression(
      [st3("fg", 1, "up"), st3("sw", 2, "down", true)],
      parents,
    );
    expect(out.get("sw")).toBe(false);
  });

  it("still releases when a recovering parent has a second parent that is up", () => {
    // All-down semantics are unchanged by the hysteresis: one genuinely-back
    // parent is enough, exactly as one live parent is enough to prevent entry.
    const out = evaluateSuppression(
      [st3("fg1", 1, "recovering"), st3("fg2", 1, "up"), st3("sw", 2, "down", true)],
      new Map([["sw", ["fg1", "fg2"]]]),
    );
    expect(out.get("sw")).toBe(false);
  });

  it("does NOT suppress an unsuppressed child when the parent is recovering", () => {
    // The asymmetry only bites on the way out. A recovering parent must never
    // drag a healthy subtree INTO Dep. Down — that was the pre-existing
    // "flapping does not propagate" rule and it still holds.
    const out = evaluateSuppression(
      [st3("fg", 1, "recovering"), st3("sw", 2, "up", false)],
      parents,
    );
    expect(out.get("sw")).toBe(false);
  });

  it("holds the whole chain until each level is genuinely back", () => {
    // Gate up, switch still down: the AP's own parent has not recovered, so it
    // stays suppressed even though the root did.
    const out = evaluateSuppression(
      [st3("fg", 1, "up"), st3("sw", 2, "down", true), st3("ap", 3, "down", true)],
      new Map([["sw", ["fg"]], ["ap", ["sw"]]]),
    );
    expect(out.get("sw")).toBe(false);
    expect(out.get("ap")).toBe(true);
  });

  it("never strands a subtree behind a parent that renders no verdict", () => {
    // `passive` (business rule 36) and `unknown` are not claims that the
    // parent is unreachable. Gating release on them would leave the child in
    // Dep. Down with nothing that could ever clear it. A null status reads as
    // `unknown` — a row written before the column existed says nothing either.
    for (const status of ["passive", "unknown", null]) {
      const out = evaluateSuppression(
        [st3("fg", 1, status), st3("sw", 2, "down", true)],
        parents,
      );
      expect(out.get("sw"), String(status)).toBe(false);
    }
  });

  it("holds a suppressed child while the parent is only WARNING", () => {
    // The flap that reached production: a parent deep in an outage answers
    // twice (bucket cap → cap-1 → cap-2, `recovering` both times, correctly
    // held) and then misses. Once the bucket has drained below threshold-1
    // that miss reads `warning`, not `down` (nextFailureBucket), and `warning`
    // used to count as "back" — so the whole subtree came out of Dep. Down
    // mid-outage and re-alerted device by device as plain Down. A parent that
    // has just MISSED a poll is the least plausible moment to call it
    // recovered, and `warning` cannot strand anything: keep missing and it
    // reaches `down`, keep answering and it drains to `up`.
    const out = evaluateSuppression(
      [st3("fg", 1, "warning"), st3("sw", 2, "down", true)],
      parents,
    );
    expect(out.get("sw")).toBe(true);
  });

  it("holds through a whole down → recovering → warning → down flap, releasing only at up", () => {
    // One child, walked across the parent's real state sequence. `sw` stays
    // suppressed for every state but the last.
    const suppressedAt = (parentStatus: string): boolean | undefined =>
      evaluateSuppression(
        [st3("fg", 1, parentStatus), st3("sw", 2, "down", true)],
        parents,
      ).get("sw");
    expect(suppressedAt("down")).toBe(true);
    expect(suppressedAt("recovering")).toBe(true);
    expect(suppressedAt("warning")).toBe(true);
    expect(suppressedAt("down")).toBe(true);
    expect(suppressedAt("up")).toBe(false);
  });

  it("holds a suppressed child behind a WARNING parent reached through an unmonitored switch", () => {
    // The transparent walk is only as recovered as the monitored ancestor it
    // lands on — the release rule has to survive the recursion, not just the
    // top-level parent lookup.
    const out = evaluateSuppression(
      [
        st3("fg", 1, "warning"),
        { id: "sw", layer: 2, monitorStatus: null, monitored: false, currentlySuppressed: false },
        st3("ap", 3, "down", true),
      ],
      new Map([["sw", ["fg"]], ["ap", ["sw"]]]),
    );
    expect(out.get("ap")).toBe(true);
  });
});

// ─── vCenter cluster multi-parent (vMotion-safe) ────────────────────────────
// A clustered VM carries one edge per cluster-member host; all-down semantics
// suppress it only when the ENTIRE cluster is dark, so an intra-cluster
// vMotion between discovery cycles can never cause a false Dep. Down.

describe("evaluateSuppression — vCenter cluster hosts", () => {
  function st2(id: string, layer: number | null, monitorStatus: string | null, monitored = true): SuppressionAssetState {
    return { id, layer, monitorStatus, monitored, currentlySuppressed: false };
  }

  it("VM with three cluster-host parents suppresses only when all three are down", () => {
    const parents = new Map([["vm", ["h1", "h2", "h3"]]]);

    // One host down (the VM's recorded host, say) — the cluster still has
    // live members, so the VM stays unsuppressed even if placement is stale.
    let out = evaluateSuppression(
      [st2("h1", 1, "down"), st2("h2", 1, "up"), st2("h3", 1, "up"), st2("vm", 2, "down")],
      parents,
    );
    expect(out.get("vm")).toBe(false);

    // Whole cluster dark → suppressed.
    out = evaluateSuppression(
      [st2("h1", 1, "down"), st2("h2", 1, "down"), st2("h3", 1, "down"), st2("vm", 2, "down")],
      parents,
    );
    expect(out.get("vm")).toBe(true);
  });

  it("standalone-host VM suppresses when its single host is down", () => {
    const parents = new Map([["vm", ["h1"]]]);
    const out = evaluateSuppression(
      [st2("h1", 1, "down"), st2("vm", 2, "down")],
      parents,
    );
    expect(out.get("vm")).toBe(true);
  });
});

// ─── Endpoint half of the DAG ───────────────────────────────────────────────
// Before 2026-08 only firewalls / switches / APs were in the tree, so every
// other asset had zero parents — and "no parents" means "never suppressed". A
// camera-station server behind a dead FortiGate alerted as plain Down while the
// switches and APs behind that same gate correctly read "Dep. Down".

describe("switchNameFromLastSeenSwitch", () => {
  it("takes the switch half of the '<switch>/<port>' value", () => {
    expect(switchNameFromLastSeenSwitch("FS-248E-01/port15")).toBe("FS-248E-01");
  });
  it("accepts a bare switch name with no port", () => {
    expect(switchNameFromLastSeenSwitch("FS-248E-01")).toBe("FS-248E-01");
  });
  it("returns null for empty / missing values", () => {
    expect(switchNameFromLastSeenSwitch(null)).toBeNull();
    expect(switchNameFromLastSeenSwitch("")).toBeNull();
    expect(switchNameFromLastSeenSwitch("   ")).toBeNull();
    expect(switchNameFromLastSeenSwitch("/port3")).toBeNull();
  });
});

describe("buildEndpointDependencyEdges", () => {
  function endpoint(id: string, over: Partial<DepEndpoint> = {}): DepEndpoint {
    return { id, lastSeenSwitch: null, lastSeenAp: null, sightedFortigates: [], ipamGateAssetId: null, ...over };
  }

  const infra: DepAsset[] = [
    fg("fg1", "FG-ASHFIELD-01"),
    sw("sw1", "FS-248E-01", "FG-ASHFIELD-01"),
    ap("ap1", "FAP-431F-07", "FS-248E-01"),
  ];

  it("hangs a wired endpoint off the switch port it was last seen on", () => {
    const edges = buildEndpointDependencyEdges([endpoint("srv", { lastSeenSwitch: "FS-248E-01/port15" })], infra);
    expect(edges).toEqual([{ childAssetId: "srv", parentAssetId: "sw1", detectedVia: "switch-port" }]);
  });

  it("hangs a wireless endpoint off its last-seen access point", () => {
    const edges = buildEndpointDependencyEdges([endpoint("tab", { lastSeenAp: "FAP-431F-07" })], infra);
    expect(edges).toEqual([{ childAssetId: "tab", parentAssetId: "ap1", detectedVia: "wireless" }]);
  });

  it("falls back to the FortiGate that last saw the device", () => {
    const edges = buildEndpointDependencyEdges([endpoint("cam", { sightedFortigates: ["FG-ASHFIELD-01"] })], infra);
    expect(edges).toEqual([{ childAssetId: "cam", parentAssetId: "fg1", detectedVia: "sighting" }]);
  });

  // Most-specific-wins, and ONE parent only. Listing the switch AND the gate
  // would break the operator's expectation under all-down semantics: a dead
  // access switch with a healthy gate would satisfy "some parent is ok" and the
  // endpoint would keep alerting. The series relationship instead comes from the
  // switch being suppressed by its own gate.
  it("prefers the switch over the gate when both resolve, emitting a single edge", () => {
    const edges = buildEndpointDependencyEdges(
      [endpoint("srv", { lastSeenSwitch: "FS-248E-01/port15", lastSeenAp: "FAP-431F-07", sightedFortigates: ["FG-ASHFIELD-01"] })],
      infra,
    );
    expect(edges).toEqual([{ childAssetId: "srv", parentAssetId: "sw1", detectedVia: "switch-port" }]);
  });

  it("prefers the AP over the gate when there is no wired sighting", () => {
    const edges = buildEndpointDependencyEdges(
      [endpoint("tab", { lastSeenAp: "FAP-431F-07", sightedFortigates: ["FG-ASHFIELD-01"] })],
      infra,
    );
    expect(edges[0].parentAssetId).toBe("ap1");
  });

  it("skips to the next signal when the more specific one names an unknown device", () => {
    const edges = buildEndpointDependencyEdges(
      [endpoint("srv", { lastSeenSwitch: "FS-GONE-99/port1", sightedFortigates: ["FG-ASHFIELD-01"] })],
      infra,
    );
    expect(edges).toEqual([{ childAssetId: "srv", parentAssetId: "fg1", detectedVia: "sighting" }]);
  });

  it("takes the first sighting that resolves (caller orders them freshest-first)", () => {
    const edges = buildEndpointDependencyEdges(
      [endpoint("cam", { sightedFortigates: ["FG-RETIRED-04", "FG-ASHFIELD-01"] })],
      infra,
    );
    expect(edges).toEqual([{ childAssetId: "cam", parentAssetId: "fg1", detectedVia: "sighting" }]);
  });

  it("emits nothing when no signal resolves — an unparented endpoint must keep alerting", () => {
    expect(buildEndpointDependencyEdges([endpoint("srv")], infra)).toEqual([]);
    expect(buildEndpointDependencyEdges([endpoint("srv", { sightedFortigates: ["FG-UNKNOWN"] })], infra)).toEqual([]);
  });

  // The stamp-vs-hostname trap that unparented every switch on a live install
  // (utils/fortinetParentKey.ts): the gate a sighting names is FortiManager's
  // DEVICE NAME, which need not equal the gate's configured hostname.
  it("resolves a sighting against the gate's FMG device name, not just its hostname", () => {
    const gates: DepAsset[] = [
      {
        id: "fg9",
        hostname: "ashf-edge-01.corp",
        serialNumber: "FG100F0009",
        assetType: "firewall",
        fortinetTopology: { deviceName: "FGT-ASHF-01" },
      },
    ];
    const edges = buildEndpointDependencyEdges([endpoint("cam", { sightedFortigates: ["FGT-ASHF-01"] })], gates);
    expect(edges).toEqual([{ childAssetId: "cam", parentAssetId: "fg9", detectedVia: "sighting" }]);
  });

  it("never resolves a switch signal to a firewall", () => {
    const edges = buildEndpointDependencyEdges([endpoint("srv", { lastSeenSwitch: "FG-ASHFIELD-01/wan1" })], infra);
    expect(edges).toEqual([]);
  });

  it("refuses a self-edge", () => {
    const selfInfra: DepAsset[] = [sw("srv", "FS-248E-01", "FG-ASHFIELD-01")];
    expect(buildEndpointDependencyEdges([endpoint("srv", { lastSeenSwitch: "FS-248E-01/port1" })], selfInfra)).toEqual([]);
  });
});

// The behavior the operator asked for, end to end through the pure evaluator: an
// endpoint under a switch suppresses both when the switch itself is down and
// when the switch is fine but the gate above it is down.
describe("evaluateSuppression — endpoint leaves", () => {
  const parents = new Map([["sw", ["fg"]], ["srv", ["sw"]]]);
  function s(id: string, layer: number | null, monitorStatus: string | null, monitored = true): SuppressionAssetState {
    return { id, layer, monitorStatus, monitored, currentlySuppressed: false };
  }

  it("suppresses the endpoint when its gate is down (through the switch)", () => {
    const out = evaluateSuppression([s("fg", 1, "down"), s("sw", 2, "down"), s("srv", 3, "down")], parents);
    expect(out.get("sw")).toBe(true);
    expect(out.get("srv")).toBe(true);
  });

  it("suppresses the endpoint when only its switch is down", () => {
    const out = evaluateSuppression([s("fg", 1, "up"), s("sw", 2, "down"), s("srv", 3, "down")], parents);
    expect(out.get("srv")).toBe(true);
  });

  it("leaves the endpoint alerting when everything above it is up", () => {
    const out = evaluateSuppression([s("fg", 1, "up"), s("sw", 2, "up"), s("srv", 3, "down")], parents);
    expect(out.get("srv")).toBe(false);
  });

  // An unmonitored access switch is transparent, so gate state still decides —
  // pinning an endpoint to gear nobody polls must not silence it.
  it("walks through an unmonitored switch to the gate", () => {
    let out = evaluateSuppression([s("fg", 1, "down"), s("sw", 2, null, false), s("srv", 3, "down")], parents);
    expect(out.get("srv")).toBe(true);
    out = evaluateSuppression([s("fg", 1, "up"), s("sw", 2, null, false), s("srv", 3, "down")], parents);
    expect(out.get("srv")).toBe(false);
  });

  it("suppresses an endpoint hung directly off a gate in a maintenance window", () => {
    const out = evaluateSuppression(
      [
        { id: "fg", layer: 1, monitorStatus: "up", monitored: true, currentlySuppressed: false, status: "maintenance" },
        s("cam", 2, "down"),
      ],
      new Map([["cam", ["fg"]]]),
    );
    expect(out.get("cam")).toBe(true);
  });
});

describe("filterFreshLldpRows", () => {
  const HOUR = 60 * 60 * 1000;
  const now = new Date("2026-09-03T12:00:00.000Z");
  const at = (msAgo: number) => new Date(now.getTime() - msAgo);

  function row(over: Partial<DepLldpRow> = {}): DepLldpRow {
    return {
      assetId: "sw1",
      matchedAssetId: "fg-right",
      lastSeen: at(0),
      source: "snmp",
      ...over,
    };
  }

  it("keeps rows refreshed inside the grace window", () => {
    const rows = [row({ lastSeen: at(HOUR) }), row({ lastSeen: at(5 * HOUR) })];
    expect(filterFreshLldpRows(rows, now)).toHaveLength(2);
  });

  it("drops a stale row while keeping the fresh row for the same asset", () => {
    // The prod 2026-09-03 shape: an orphaned row under an old local-port label
    // still naming the wrong gate, alongside the current row for the same link.
    const stale = row({ matchedAssetId: "fg-wrong", lastSeen: at(28 * HOUR) });
    const fresh = row({ matchedAssetId: "fg-right", lastSeen: at(0) });
    const kept = filterFreshLldpRows([stale, fresh], now);
    expect(kept).toHaveLength(1);
    expect(kept[0].matchedAssetId).toBe("fg-right");
  });

  it("keeps an old row that the newest scrape for its source did refresh", () => {
    // Slow-cadence install: lldpIntervalSeconds is settable to 24h, so every
    // row can be older than the grace window and still be current.
    const rows = [
      row({ lastSeen: at(20 * HOUR) }),
      row({ matchedAssetId: "fg-other", lastSeen: at(20 * HOUR) }),
    ];
    expect(filterFreshLldpRows(rows, now)).toHaveLength(2);
  });

  it("ages each source independently so one writer does not retire another's rows", () => {
    // persistLldpNeighbors (snmp) and persistManagedApLldpNeighbors both write
    // this asset. A fresh snmp write must not age out a current fortios row.
    const snmpFresh = row({ source: "snmp", lastSeen: at(0) });
    const fortiosOld = row({ source: "fortios", matchedAssetId: "fg-b", lastSeen: at(30 * HOUR) });
    const kept = filterFreshLldpRows([snmpFresh, fortiosOld], now);
    expect(kept).toHaveLength(2);
  });

  it("drops a stale row for a source whose newest write is newer still", () => {
    const rows = [
      row({ source: "snmp", matchedAssetId: "fg-wrong", lastSeen: at(30 * HOUR) }),
      row({ source: "snmp", matchedAssetId: "fg-right", lastSeen: at(25 * HOUR) }),
    ];
    const kept = filterFreshLldpRows(rows, now);
    expect(kept).toHaveLength(1);
    expect(kept[0].matchedAssetId).toBe("fg-right");
  });

  it("scopes freshness per asset", () => {
    // sw2's only row is old, but it is sw2's newest — it must survive sw1's
    // fresher scrape.
    const rows = [
      row({ assetId: "sw1", lastSeen: at(0) }),
      row({ assetId: "sw2", lastSeen: at(30 * HOUR) }),
    ];
    expect(filterFreshLldpRows(rows, now)).toHaveLength(2);
  });

  it("returns an empty list unchanged", () => {
    expect(filterFreshLldpRows([], now)).toEqual([]);
  });
});

// ─── controller membership bounds the graph ─────────────────────────────────
//
// Each gate publishes its own managed switch / AP inventory, stamped on the
// gate as managedSwitchSerials / managedApSerials. A device absent from that
// list cannot sit under that gate, whatever an inferred edge claims. The
// tri-state is the delicate part: absent = unknown = no constraint, while an
// empty array is the real answer "manages none".

describe("buildDependencyEdgesFromInputs — controller membership", () => {
  const SW_SERIAL = "S248EPTF0001";
  const AP_SERIAL = "FP231FTF0001";

  function gate(id: string, hostname: string, members?: { switches?: string[]; aps?: string[] }): DepAsset {
    return {
      id,
      hostname,
      serialNumber: `FG101F${id.toUpperCase()}`,
      assetType: "firewall",
      fortinetTopology: members
        ? {
            role: "fortigate",
            ...(members.switches ? { managedSwitchSerials: members.switches } : {}),
            ...(members.aps ? { managedApSerials: members.aps } : {}),
          }
        : null,
    };
  }
  function managedSwitch(id: string, hostname: string, serial: string): DepAsset {
    return { id, hostname, serialNumber: serial, assetType: "switch", fortinetTopology: { role: "fortiswitch" } };
  }
  const lldp = (assetId: string, matchedAssetId: string): DepLldpEdge => ({ assetId, matchedAssetId });

  it("drops an inferred edge to a gate whose roster does not list the switch", () => {
    // The prod 2026-09-03 shape: the LLDP row named the right gate but
    // matchedAssetId had been resolved to the wrong asset and frozen there.
    const assets = [
      gate("fg-right", "CARMOBILE-101F-1", { switches: [SW_SERIAL] }),
      gate("fg-wrong", "CROSSVILLE-61F-1", { switches: ["S248EPTF9999"] }),
      managedSwitch("sw1", "CARMOBILE-124F-1", SW_SERIAL),
    ];
    const edges = buildDependencyEdgesFromInputs(assets, [], [lldp("sw1", "fg-wrong")]);
    expect(edges.some(e => e.parentAssetId === "fg-wrong" || e.childAssetId === "fg-wrong")).toBe(false);
  });

  it("keeps the inferred edge to the gate that DOES list the switch", () => {
    const assets = [
      gate("fg-right", "GATE", { switches: [SW_SERIAL] }),
      managedSwitch("sw1", "SW", SW_SERIAL),
    ];
    const edges = buildDependencyEdgesFromInputs(assets, [], [lldp("sw1", "fg-right")]);
    expect(edges).toContainEqual({ childAssetId: "sw1", parentAssetId: "fg-right", detectedVia: "lldp" });
  });

  it("end-to-end: the non-member gate is not a parent after layering", () => {
    const assets = [
      gate("fg-right", "CARMOBILE-101F-1", { switches: [SW_SERIAL] }),
      gate("fg-wrong", "CROSSVILLE-61F-1", { switches: [] }),
      managedSwitch("sw1", "CARMOBILE-124F-1", SW_SERIAL),
    ];
    const edges = buildDependencyEdgesFromInputs(
      assets,
      [{ sourceAssetId: "sw1", targetAssetId: "fg-right" }],
      [lldp("sw1", "fg-wrong")],
    );
    const { keptEdges } = assignLayers(assets, edges);
    const parents = keptEdges.filter(e => e.childAssetId === "sw1").map(e => e.parentAssetId);
    expect([...new Set(parents)]).toEqual(["fg-right"]);
  });

  it("treats a KNOWN-EMPTY roster as manages-none", () => {
    // An empty array is a real answer, distinct from an absent field.
    const assets = [gate("fg-empty", "GATE", { switches: [] }), managedSwitch("sw1", "SW", SW_SERIAL)];
    const edges = buildDependencyEdgesFromInputs(assets, [], [lldp("sw1", "fg-empty")]);
    expect(edges).toHaveLength(0);
  });

  it("treats an ABSENT roster as unknown and applies no constraint", () => {
    // Pre-feature rows, and any gate whose roster read failed, must keep the
    // previous behavior rather than losing their subtree.
    const assets = [gate("fg-unknown", "GATE"), managedSwitch("sw1", "SW", SW_SERIAL)];
    const edges = buildDependencyEdgesFromInputs(assets, [], [lldp("sw1", "fg-unknown")]);
    expect(edges).toContainEqual({ childAssetId: "sw1", parentAssetId: "fg-unknown", detectedVia: "lldp" });
  });

  it("applies no constraint to a child carrying no serial", () => {
    // Nothing to match against the roster -- refuse to judge rather than guess.
    const assets = [
      gate("fg1", "GATE", { switches: [SW_SERIAL] }),
      { id: "sw1", hostname: "SW", serialNumber: null, assetType: "switch", fortinetTopology: null } as DepAsset,
    ];
    const edges = buildDependencyEdgesFromInputs(assets, [], [lldp("sw1", "fg1")]);
    expect(edges).toContainEqual({ childAssetId: "sw1", parentAssetId: "fg1", detectedVia: "lldp" });
  });

  it("drops a child<->child edge whose ends belong to different gates", () => {
    // The cross-site link a child-side veto could never express.
    const assets = [
      gate("fg-a", "GATE-A", { switches: [SW_SERIAL] }),
      gate("fg-b", "GATE-B", { switches: ["S248EPTF0002"] }),
      managedSwitch("sw1", "SW-1", SW_SERIAL),
      managedSwitch("sw2", "SW-2", "S248EPTF0002"),
    ];
    const edges = buildDependencyEdgesFromInputs(assets, [], [lldp("sw1", "sw2")]);
    expect(edges.some(e => e.detectedVia === "lldp")).toBe(false);
  });

  it("keeps a child<->child edge between two members of the SAME gate", () => {
    const assets = [
      gate("fg-a", "GATE-A", { switches: [SW_SERIAL, "S248EPTF0002"] }),
      managedSwitch("sw1", "SW-1", SW_SERIAL),
      managedSwitch("sw2", "SW-2", "S248EPTF0002"),
    ];
    const edges = buildDependencyEdgesFromInputs(assets, [], [lldp("sw1", "sw2")]);
    expect(edges).toContainEqual({ childAssetId: "sw1", parentAssetId: "sw2", detectedVia: "lldp" });
  });

  it("HA: both members carry the same roster, so an edge to either survives", () => {
    // memberTopology is stamped per HA member, which is what removes the need
    // for any HA carve-out in the constraint itself.
    const assets = [
      gate("fg-a", "GATE-A", { switches: [SW_SERIAL] }),
      gate("fg-b", "GATE-B", { switches: [SW_SERIAL] }),
      managedSwitch("sw1", "SW", SW_SERIAL),
    ];
    const edges = buildDependencyEdgesFromInputs(assets, [], [lldp("sw1", "fg-b")]);
    expect(edges).toContainEqual({ childAssetId: "sw1", parentAssetId: "fg-b", detectedVia: "lldp" });
  });

  it("matches serials case-insensitively", () => {
    const assets = [
      gate("fg1", "GATE", { switches: [SW_SERIAL.toLowerCase()] }),
      managedSwitch("sw1", "SW", SW_SERIAL),
    ];
    const edges = buildDependencyEdgesFromInputs(assets, [], [lldp("sw1", "fg1")]);
    expect(edges).toContainEqual({ childAssetId: "sw1", parentAssetId: "fg1", detectedVia: "lldp" });
  });

  it("honours the AP roster for access points", () => {
    const ap: DepAsset = {
      id: "ap1", hostname: "AP", serialNumber: AP_SERIAL,
      assetType: "access_point", fortinetTopology: { role: "fortiap" },
    };
    const assets = [gate("fg-wrong", "GATE", { aps: ["FP231FTF9999"] }), ap];
    const edges = buildDependencyEdgesFromInputs(assets, [], [lldp("ap1", "fg-wrong")]);
    expect(edges).toHaveLength(0);
  });

  it("filters interface edges by the same rule", () => {
    const assets = [
      gate("fg-wrong", "GATE", { switches: [] }),
      managedSwitch("sw1", "SW", SW_SERIAL),
    ];
    const edges = buildDependencyEdgesFromInputs(
      assets,
      [{ sourceAssetId: "sw1", targetAssetId: "fg-wrong" }],
      [],
    );
    expect(edges.some(e => e.detectedVia === "interface")).toBe(false);
  });

  it("never rejects the controller-derived edge itself", () => {
    // Membership constrains INFERRED edges. A controller stamp is the gate
    // naming the child directly, so it is not second-guessed here.
    const assets = [
      {
        id: "sw1", hostname: "SW", serialNumber: SW_SERIAL, assetType: "switch",
        fortinetTopology: { role: "fortiswitch", controllerFortigate: "GATE" },
      } as DepAsset,
      gate("fg1", "GATE", { switches: [] }),
    ];
    const edges = buildDependencyEdgesFromInputs(assets, [], []);
    expect(edges).toContainEqual({ childAssetId: "sw1", parentAssetId: "fg1", detectedVia: "controller" });
  });
});