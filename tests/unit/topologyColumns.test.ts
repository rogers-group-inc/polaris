/**
 * tests/unit/topologyColumns.test.ts
 *
 * Unit tests for computeTopologyColumns() — the Dijkstra-weighted column
 * solver in public/js/topology-render.js. The solver lives in a browser IIFE
 * (no module export), so we evaluate the file in a Node vm context with a
 * stub `window` and pull the function off window.PolarisTopologyRender.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import vm from "node:vm";

type Cols = Record<string, { depth: number; lane: number }>;
type El = { data: Record<string, unknown> };

let computeTopologyColumns: (els: El[]) => Cols | null;
type FanOutOpts = { colSpacing: number; orientation?: string };
let markFanOutEdges: (cy: unknown, columns: Cols | null, opts: FanOutOpts) => void;

beforeAll(() => {
  const here = dirname(fileURLToPath(import.meta.url));
  const file = resolve(here, "../../public/js/topology-render.js");
  const code = readFileSync(file, "utf8");
  const sandbox: { window: Record<string, any> } = { window: {} };
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);
  computeTopologyColumns = sandbox.window.PolarisTopologyRender.computeTopologyColumns;
  markFanOutEdges = sandbox.window.PolarisTopologyRender.markFanOutEdges;
});

// Helpers to build a /topology element set.
const node = (id: string, role: string): El => ({ data: { id, role } });
// A physically-verified link (interface-inferred or LLDP) — this is what
// proves a switch's real cable to the firewall.
const edge = (source: string, target: string): El => ({
  data: { id: `e-${source}-${target}`, source, target, isIface: 1 },
});
// A controller/FortiLink edge — NOT physical proof. A switch reachable only
// through these is a fallback (negative columns).
const controllerEdge = (source: string, target: string): El => ({
  data: { id: `c-${source}-${target}`, source, target },
});
// A wireless-mesh backhaul edge root AP → leaf AP.
const meshEdge = (source: string, target: string): El => ({
  data: { id: `m-${source}-${target}`, source, target, isMesh: 1 },
});
// A wired bridge edge AP → switch (FortiLink switch behind a FortiAP). The
// renderer stamps isBridge (layout semantics) + isApLink (styling).
const bridgeEdge = (source: string, target: string): El => ({
  data: { id: `b-${source}-${target}`, source, target, isBridge: 1, isApLink: 1 },
});
// A wireless client edge AP → station.
const wirelessEdge = (source: string, target: string): El => ({
  data: { id: `w-${source}-${target}`, source, target, isWireless: 1 },
});
// A controller edge whose link is physically confirmed (interface/LLDP-backed),
// flagged server-side after the FG↔switch interface edge is deduped into it.
const verifiedControllerEdge = (source: string, target: string): El => ({
  data: { id: `v-${source}-${target}`, source, target, isVerifiedUplink: 1 },
});

describe("computeTopologyColumns", () => {
  it("returns null when there is no firewall root", () => {
    expect(computeTopologyColumns([node("s1", "fortiswitch")])).toBeNull();
    expect(computeTopologyColumns([])).toBeNull();
  });

  it("places a lone firewall in column 0", () => {
    const cols = computeTopologyColumns([node("fg", "fortigate")])!;
    expect(cols.fg.depth).toBe(0);
  });

  it("puts infra on even columns by weighted depth, compacting gaps", () => {
    // fw(1) → sw1(1+2=3) → sw2(3+2=5) → sw3(5+2=7)
    // distinct anchor values {1,3,5,7} → ranks 0,1,2,3 → even cols 0,2,4,6
    const cols = computeTopologyColumns([
      node("fg", "fortigate"),
      node("sw1", "fortiswitch"),
      node("sw2", "fortiswitch"),
      node("sw3", "fortiswitch"),
      edge("fg", "sw1"),
      edge("sw1", "sw2"),
      edge("sw2", "sw3"),
    ])!;
    expect(cols.fg.depth).toBe(0);
    expect(cols.sw1.depth).toBe(2);
    expect(cols.sw2.depth).toBe(4);
    expect(cols.sw3.depth).toBe(6);
    // every anchor column is even
    [cols.fg, cols.sw1, cols.sw2, cols.sw3].forEach((c) => expect(c.depth % 2).toBe(0));
  });

  it("places a terminal AP as a leaf in the odd column right of its switch", () => {
    // A managed AP hanging off a switch port is NOT its own column anchor — it
    // hangs one column right of the switch, so the switch chain stays tight.
    // fw(1) → sw(3); ap is a terminal leaf → col 3 (sw col 2 + 1), not col 4.
    const cols = computeTopologyColumns([
      node("fg", "fortigate"),
      node("sw", "fortiswitch"),
      node("ap", "fortiap"),
      edge("fg", "sw"),
      edge("sw", "ap"),
    ])!;
    expect(cols.sw.depth).toBe(2);
    expect(cols.ap.depth).toBe(3); // odd, one right of the switch
    expect(cols.ap.depth % 2).toBe(1);
  });

  it("packs a switch chain into consecutive columns with APs stacked below each switch", () => {
    // Mirrors the real LAKESIDE topology: FortiGate → three daisy-chained
    // FortiSwitches (verified uplinks), each switch carrying terminal APs.
    // The switches must land in tight consecutive even columns (0,2,4,6); each
    // switch's APs hang in the odd column immediately right of it (3,5,7); and
    // each switch's AP stack lines up just below that switch rather than
    // staircasing across the canvas (no AP column lands past the last switch's
    // column except its own leaf column).
    const els = [
      node("fg", "fortigate"),
      node("sw1", "fortiswitch"),
      node("sw2", "fortiswitch"),
      node("sw3", "fortiswitch"),
      edge("fg", "sw1"),
      edge("sw1", "sw2"),
      edge("sw2", "sw3"),
    ];
    const apsBySwitch: Record<string, string[]> = {
      sw1: ["a1a", "a1b", "a1c"],
      sw2: ["a2a", "a2b", "a2c"],
      sw3: ["a3a", "a3b", "a3c", "a3d"],
    };
    for (const [sw, aps] of Object.entries(apsBySwitch)) {
      for (const ap of aps) {
        els.push(node(ap, "fortiap"));
        els.push(edge(sw, ap));
      }
    }
    const cols = computeTopologyColumns(els)!;

    // Tight switch chain.
    expect(cols.fg.depth).toBe(0);
    expect(cols.sw1.depth).toBe(2);
    expect(cols.sw2.depth).toBe(4);
    expect(cols.sw3.depth).toBe(6);
    // Switch chain shares row 0 (the flat spine).
    [cols.fg, cols.sw1, cols.sw2, cols.sw3].forEach((c) => expect(c.lane).toBe(0));

    // Each switch's APs hang in the odd column one right of that switch…
    const expectStack = (sw: string, aps: string[]) => {
      const swCol = cols[sw].depth;
      aps.forEach((ap) => expect(cols[ap].depth).toBe(swCol + 1));
      // …on distinct rows, and the stack starts within a row of the switch
      // (i.e. it is NOT staircased far down the canvas).
      const lanes = aps.map((ap) => cols[ap].lane).sort((a, b) => a - b);
      expect(new Set(lanes).size).toBe(aps.length);
      expect(Math.min(...lanes)).toBeLessThanOrEqual(cols[sw].lane + 1);
    };
    expectStack("sw1", apsBySwitch.sw1);
    expectStack("sw2", apsBySwitch.sw2);
    expectStack("sw3", apsBySwitch.sw3);

    // No node is pushed past the last switch's own AP column — proves the
    // stacks aren't fanned rightward the way the all-APs-are-infra layout did.
    const maxDepth = Math.max(...Object.values(cols).map((c) => c.depth));
    expect(maxDepth).toBe(cols.sw3.depth + 1);
  });

  it("walks to the nearest infra ancestor for a leaf one hop past a leaf", () => {
    // An endpoint hanging off a switch sits one column right of that switch.
    const cols = computeTopologyColumns([
      node("fg", "fortigate"),
      node("sw", "fortiswitch"),
      node("ep", "endpoint"),
      edge("fg", "sw"),
      edge("sw", "ep"),
    ])!;
    expect(cols.sw.depth).toBe(2);
    expect(cols.ep.depth).toBe(3);
  });

  it("drops disconnected nodes into a rightmost orphan column", () => {
    // fw(0) → sw(2). An island switch with no path to fw lands at maxInfra+1 = 3.
    const cols = computeTopologyColumns([
      node("fg", "fortigate"),
      node("sw", "fortiswitch"),
      node("island", "fortiswitch"),
      edge("fg", "sw"),
    ])!;
    expect(cols.sw.depth).toBe(2);
    expect(cols.island.depth).toBe(3);
  });

  it("treats a verifiedUplink controller edge as a real link (switch not a fallback)", () => {
    // swA reaches the FG via a verifiedUplink controller edge (the deduped
    // interface edge); swB chains off swA via interface; swF has only a plain
    // controller edge → fallback. swA/swB verified (positive), swF at -2.
    const cols = computeTopologyColumns([
      node("fg", "fortigate"),
      node("swA", "fortiswitch"),
      node("swB", "fortiswitch"),
      node("swF", "fortiswitch"),
      verifiedControllerEdge("fg", "swA"),
      edge("swA", "swB"),
      controllerEdge("fg", "swF"),
    ])!;
    expect(cols.swA.depth).toBe(2);
    expect(cols.swB.depth).toBe(4);
    expect(cols.swF.depth).toBe(-2);
  });

  it("exiles a FortiLink-fallback switch (no physical link) to column -2", () => {
    // swF reaches the firewall ONLY through a controller edge — no interface
    // or LLDP proof — so it lands in the negative column -2.
    const cols = computeTopologyColumns([
      node("fg", "fortigate"),
      node("swOk", "fortiswitch"),
      node("swF", "fortiswitch"),
      edge("fg", "swOk"), // verified
      controllerEdge("fg", "swF"), // fallback — controller only
    ])!;
    expect(cols.swOk.depth).toBe(2);
    expect(cols.swF.depth).toBe(-2);
  });

  it("puts an endpoint on a fallback switch in column -3", () => {
    const cols = computeTopologyColumns([
      node("fg", "fortigate"),
      node("swF", "fortiswitch"),
      node("ep", "endpoint"),
      controllerEdge("fg", "swF"), // fallback switch
      controllerEdge("swF", "ep"),
    ])!;
    expect(cols.swF.depth).toBe(-2);
    expect(cols.ep.depth).toBe(-3);
  });

  it("treats a switch chained off a fallback switch (no physical path to fw) as fallback too", () => {
    // Neither switch can prove a physical path to the firewall.
    const cols = computeTopologyColumns([
      node("fg", "fortigate"),
      node("swF1", "fortiswitch"),
      node("swF2", "fortiswitch"),
      controllerEdge("fg", "swF1"),
      controllerEdge("swF1", "swF2"),
    ])!;
    expect(cols.swF1.depth).toBe(-2);
    expect(cols.swF2.depth).toBe(-2);
  });

  it("routes a mesh-leaf AP through its root AP, not its (bogus) fallback uplink", () => {
    // apRoot on a switch (col 4); apLeaf meshes off apRoot and also has a bogus
    // FG fallback edge. The mesh must win → apLeaf one tier right of apRoot.
    const cols = computeTopologyColumns([
      node("fg", "fortigate"),
      node("sw", "fortiswitch"),
      node("apRoot", "fortiap"),
      node("apLeaf", "fortiap"),
      edge("fg", "sw"),
      edge("sw", "apRoot"),
      meshEdge("apRoot", "apLeaf"),
      controllerEdge("fg", "apLeaf"), // bogus wired uplink — must be suppressed
    ])!;
    expect(cols.apRoot.depth).toBe(4);
    expect(cols.apLeaf.depth).toBe(6); // apRoot + one AP hop, NOT col 2 via the FG fallback
  });

  it("nudges an endpoint off a connection line passing through its column", () => {
    // Station hangs off apRoot (col 2) → it would sit in col 3; the mesh edge
    // apRoot(col2)→apLeaf(col4) crosses col 3 at lane 0, so the station must be
    // moved off lane 0.
    const cols = computeTopologyColumns([
      node("fg", "fortigate"),
      node("apRoot", "fortiap"),
      node("apLeaf", "fortiap"),
      node("sta", "wireless-station"),
      edge("fg", "apRoot"),
      meshEdge("apRoot", "apLeaf"),
      wirelessEdge("apRoot", "sta"),
    ])!;
    expect(cols.apRoot.depth).toBe(2);
    expect(cols.apLeaf.depth).toBe(4);
    expect(cols.sta.depth).toBe(3); // odd column right of its AP
    expect(cols.sta.lane).not.toBe(0); // nudged off the mesh line at lane 0
  });

  it("routes a switch bridged behind an AP through the AP, not as a fallback", () => {
    // swBridge is reached via a wired bridge edge from apRoot and also carries
    // a bogus FortiLink controller edge. It must route through the AP (positive
    // column), not the -2 FortiLink-fallback column.
    const cols = computeTopologyColumns([
      node("fg", "fortigate"),
      node("sw", "fortiswitch"),
      node("apRoot", "fortiap"),
      node("swBridge", "fortiswitch"),
      edge("fg", "sw"),
      edge("sw", "apRoot"),
      bridgeEdge("apRoot", "swBridge"),
      controllerEdge("fg", "swBridge"), // bogus FortiLink — suppressed
    ])!;
    expect(cols.apRoot.depth).toBe(4);
    expect(cols.swBridge.depth).toBe(6); // apRoot + one switch hop, NOT -2
    expect(cols.swBridge.depth).toBeGreaterThan(0);
  });

  it("assigns distinct lanes to siblings sharing a column", () => {
    // Two switches both directly on the firewall → same column, different lanes.
    const cols = computeTopologyColumns([
      node("fg", "fortigate"),
      node("swA", "fortiswitch"),
      node("swB", "fortiswitch"),
      edge("fg", "swA"),
      edge("fg", "swB"),
    ])!;
    expect(cols.swA.depth).toBe(2);
    expect(cols.swB.depth).toBe(2);
    expect(cols.swA.lane).not.toBe(cols.swB.lane);
  });

  it("keeps each switch's APs in one contiguous block when siblings share a column and APs arrive interleaved", () => {
    // Mirrors the BOONE site: three switches all hang off one parent switch
    // (so they share column 4) and their APs share column 5. The /topology
    // payload lists APs interleaved across switches (A1, B1, C1, A2, C2) — the
    // solver must still group each switch's APs into one contiguous block and
    // never split a switch's APs apart with another switch's APs.
    const els = [
      node("fg", "fortigate"),
      node("s0", "fortiswitch"),
      node("swA", "fortiswitch"),
      node("swB", "fortiswitch"),
      node("swC", "fortiswitch"),
      edge("fg", "s0"),
      edge("s0", "swA"),
      edge("s0", "swB"),
      edge("s0", "swC"),
    ];
    // Interleaved AP element order — the crux of the regression.
    const apEdges: [string, string][] = [
      ["swA", "a1"], ["swB", "b1"], ["swC", "c1"], ["swA", "a2"], ["swC", "c2"],
    ];
    const apsBySwitch: Record<string, string[]> = { swA: ["a1", "a2"], swB: ["b1"], swC: ["c1", "c2"] };
    for (const [sw, ap] of apEdges) {
      els.push(node(ap, "fortiap"));
      els.push(edge(sw, ap));
    }
    const cols = computeTopologyColumns(els)!;

    // The three switches share column 4; their APs share column 5.
    ["swA", "swB", "swC"].forEach((s) => expect(cols[s].depth).toBe(4));
    ["a1", "a2", "b1", "c1", "c2"].forEach((a) => expect(cols[a].depth).toBe(5));

    // Each switch's APs form a contiguous lane block...
    const contiguous = (ls: number[]) => {
      const s = [...ls].sort((x, y) => x - y);
      return s.every((l, i) => i === 0 || l === s[i - 1] + 1);
    };
    for (const aps of Object.values(apsBySwitch)) {
      expect(contiguous(aps.map((a) => cols[a].lane))).toBe(true);
    }
    // ...and no other switch's AP falls between a switch's min and max lane
    // (i.e. the blocks don't interleave).
    const block = (aps: string[]) => {
      const ls = aps.map((a) => cols[a].lane);
      return { lo: Math.min(...ls), hi: Math.max(...ls) };
    };
    const bA = block(apsBySwitch.swA), bB = block(apsBySwitch.swB), bC = block(apsBySwitch.swC);
    const disjoint = (x: { lo: number; hi: number }, y: { lo: number; hi: number }) =>
      x.hi < y.lo || y.hi < x.lo;
    expect(disjoint(bA, bB)).toBe(true);
    expect(disjoint(bA, bC)).toBe(true);
    expect(disjoint(bB, bC)).toBe(true);

    // Each switch sits at the top of its own AP block (reserved row spacing).
    expect(cols.swA.lane).toBe(bA.lo);
    expect(cols.swB.lane).toBe(bB.lo);
    expect(cols.swC.lane).toBe(bC.lo);
  });

  it("keeps the spine on one row: a chain shares the firewall's lane", () => {
    const cols = computeTopologyColumns([
      node("fg", "fortigate"),
      node("sw1", "fortiswitch"),
      node("sw2", "fortiswitch"),
      node("ap", "fortiap"),
      edge("fg", "sw1"),
      edge("sw1", "sw2"),
      edge("sw2", "ap"),
    ])!;
    expect(cols.fg.lane).toBe(0);
    expect(cols.sw1.lane).toBe(0);
    expect(cols.sw2.lane).toBe(0);
    expect(cols.ap.lane).toBe(0);
  });

  it("stacks endpoints of same-column sibling switches without overlap", () => {
    // swA (3 endpoints) and swB (2 endpoints) both directly on the firewall →
    // both at column 2, so their endpoints share column 3. The switches take
    // distinct rows, and every endpoint in the shared column occupies its own
    // distinct lane (no two stacked nodes collide), with each switch's stack
    // grouped contiguously.
    const cols = computeTopologyColumns([
      node("fg", "fortigate"),
      node("swA", "fortiswitch"),
      node("swB", "fortiswitch"),
      node("a1", "endpoint"),
      node("a2", "endpoint"),
      node("a3", "endpoint"),
      node("b1", "endpoint"),
      node("b2", "endpoint"),
      edge("fg", "swA"),
      edge("fg", "swB"),
      edge("swA", "a1"),
      edge("swA", "a2"),
      edge("swA", "a3"),
      edge("swB", "b1"),
      edge("swB", "b2"),
    ])!;
    expect(cols.swA.depth).toBe(2);
    expect(cols.swB.depth).toBe(2);
    expect(cols.swA.lane).not.toBe(cols.swB.lane); // sibling switches on distinct rows
    // All five endpoints live in column 3, each on its own lane.
    const epIds = ["a1", "a2", "a3", "b1", "b2"];
    epIds.forEach((id) => expect(cols[id].depth).toBe(3));
    const epLanes = epIds.map((id) => cols[id].lane);
    expect(new Set(epLanes).size).toBe(epIds.length);
    // Each switch's endpoints are a contiguous block (no interleaving between
    // the two switches' stacks).
    const aLanes = ["a1", "a2", "a3"].map((id) => cols[id].lane).sort((x, y) => x - y);
    const bLanes = ["b1", "b2"].map((id) => cols[id].lane).sort((x, y) => x - y);
    const contiguous = (ls: number[]) => ls.every((l, i) => i === 0 || l === ls[i - 1] + 1);
    expect(contiguous(aLanes)).toBe(true);
    expect(contiguous(bLanes)).toBe(true);
  });

  it("places every endpoint of one switch on its own row, first one on the switch's row", () => {
    const cols = computeTopologyColumns([
      node("fg", "fortigate"),
      node("sw", "fortiswitch"),
      node("e1", "endpoint"),
      node("e2", "endpoint"),
      node("e3", "endpoint"),
      node("e4", "endpoint"),
      edge("fg", "sw"),
      edge("sw", "e1"),
      edge("sw", "e2"),
      edge("sw", "e3"),
      edge("sw", "e4"),
    ])!;
    const lanes = [cols.e1, cols.e2, cols.e3, cols.e4].map((c) => c.lane);
    expect(new Set(lanes).size).toBe(4); // all distinct rows
    expect(cols.e1.lane).toBe(cols.sw.lane); // first endpoint continues the switch's row
    expect(Math.min(...lanes)).toBe(cols.sw.lane); // the rest stack below
  });

  it("stacks a leaf chained off a leaf (same column) on a distinct row", () => {
    // ep2 hangs off ep1; both resolve to the same odd column right of the
    // switch — the spine must NOT collapse them onto one row.
    const cols = computeTopologyColumns([
      node("fg", "fortigate"),
      node("sw", "fortiswitch"),
      node("ep1", "endpoint"),
      node("ep2", "endpoint"),
      edge("fg", "sw"),
      edge("sw", "ep1"),
      edge("ep1", "ep2"),
    ])!;
    expect(cols.ep1.depth).toBe(3);
    expect(cols.ep2.depth).toBe(3);
    expect(cols.ep1.lane).not.toBe(cols.ep2.lane);
    expect(cols.sw.lane).toBe(cols.ep1.lane); // spine inherits through the rightward leaf
  });

  it("band-places fallback exiles with their own cursor", () => {
    // A fallback switch's spine continues through its first endpoint (leftward
    // band), and two chained fallback switches (same column -2) get distinct rows.
    const cols = computeTopologyColumns([
      node("fg", "fortigate"),
      node("swOk", "fortiswitch"),
      node("swF1", "fortiswitch"),
      node("swF2", "fortiswitch"),
      node("epF", "endpoint"),
      edge("fg", "swOk"),
      controllerEdge("fg", "swF1"),
      controllerEdge("swF1", "swF2"),
      controllerEdge("swF1", "epF"),
    ])!;
    expect(cols.swF1.depth).toBe(-2);
    expect(cols.swF2.depth).toBe(-2);
    expect(cols.epF.depth).toBe(-3);
    expect(cols.swF1.lane).toBe(cols.epF.lane); // exile spine continues leftward
    expect(cols.swF1.lane).not.toBe(cols.swF2.lane); // same-column chain stacks
    expect(cols.swF1.lane).toBeGreaterThanOrEqual(0);
    // The verified spine still owns row 0 — a fallback switch must never steal it.
    expect(cols.fg.lane).toBe(0);
    expect(cols.swOk.lane).toBe(0);
  });

  it("stacks orphans below the main tree so they can't share a row with verified leaves", () => {
    // The verified leaf `ep` occupies orphanCol (maxInfra=2 → orphanCol=3);
    // the island lands in the same column and must sit on a lower row.
    const cols = computeTopologyColumns([
      node("fg", "fortigate"),
      node("sw", "fortiswitch"),
      node("ep", "endpoint"),
      node("island", "fortiswitch"),
      edge("fg", "sw"),
      edge("sw", "ep"),
    ])!;
    expect(cols.ep.depth).toBe(3);
    expect(cols.island.depth).toBe(3);
    expect(cols.island.lane).toBeGreaterThan(cols.ep.lane);
  });

  it("packs first-column siblings near the spine instead of below earlier subtrees", () => {
    // fg's spine chain (swA→swB→swC, 2 APs each) used to consume a globally
    // disjoint row band FIRST, pushing fg's other children (swX's chain, swZ)
    // below the entire spine subtree — first-column siblings ended up huge
    // row distances apart. Nearest-free-slot packing keeps them just below
    // the spine, drifting down only past genuinely occupied rows.
    const els = [
      node("fg", "fortigate"),
      node("swA", "fortiswitch"),
      node("swB", "fortiswitch"),
      node("swC", "fortiswitch"),
      node("swX", "fortiswitch"),
      node("swY", "fortiswitch"),
      node("swZ", "fortiswitch"),
      edge("fg", "swA"),
      edge("swA", "swB"),
      edge("swB", "swC"),
      edge("fg", "swX"),
      edge("swX", "swY"),
      edge("fg", "swZ"),
    ];
    const apsBySwitch: Record<string, string[]> = {
      swA: ["aa1", "aa2"], swB: ["ab1", "ab2"], swC: ["ac1", "ac2"],
      swX: ["ax1", "ax2"], swY: ["ay1", "ay2"], swZ: ["az1", "az2"],
    };
    for (const [sw, aps] of Object.entries(apsBySwitch)) {
      for (const ap of aps) {
        els.push(node(ap, "fortiap"));
        els.push(edge(sw, ap));
      }
    }
    const cols = computeTopologyColumns(els)!;
    // Spine flat on row 0.
    ["fg", "swA", "swB", "swC"].forEach((s) => expect(cols[s].lane).toBe(0));
    // swX dodges only swA's 2-AP block (rows 1-2 in the shared leaf column —
    // shifted one below swA because swA's continuing spine edge occupies its
    // own row), landing at row 3 — NOT below the whole 3-switch spine subtree
    // (the old band pass put it at row 6+ here, and hundreds down on real sites).
    expect(cols.swX.lane).toBe(3);
    expect(cols.swY.lane).toBe(cols.swX.lane); // swX's own chain stays flat
    // swZ dodges swA's and swX's blocks, landing at row 6.
    expect(cols.swZ.lane).toBe(6);
    // AP blocks stay contiguous, each starting at its switch's own row — or
    // one below it when the switch's spine continues (that edge crosses the
    // leaf column at the switch's row, so the block can't use it).
    for (const [sw, aps] of Object.entries(apsBySwitch)) {
      const lanes = aps.map((a) => cols[a].lane).sort((x, y) => x - y);
      expect(lanes.every((l, i) => i === 0 || l === lanes[i - 1] + 1)).toBe(true);
      expect(lanes[0] === cols[sw].lane || lanes[0] === cols[sw].lane + 1).toBe(true);
    }
  });

  it("is deterministic across repeated calls on the same elements", () => {
    const els = [
      node("fg", "fortigate"),
      node("sw", "fortiswitch"),
      node("apRoot", "fortiap"),
      node("apLeaf", "fortiap"),
      node("sta", "wireless-station"),
      node("swF", "fortiswitch"),
      node("e1", "endpoint"),
      node("e2", "endpoint"),
      edge("fg", "sw"),
      edge("sw", "apRoot"),
      meshEdge("apRoot", "apLeaf"),
      wirelessEdge("apRoot", "sta"),
      controllerEdge("fg", "swF"),
      edge("sw", "e1"),
      edge("sw", "e2"),
    ];
    expect(computeTopologyColumns(els)).toEqual(computeTopologyColumns(els));
  });
});

// A node stamped with b:/f: location grouping keys (already normalized — in
// production buildTopologyElements normalizes via locKey()).
const locNode = (id: string, role: string, locB?: string, locF?: string): El => ({
  data: { id, role, ...(locB ? { locB } : {}), ...(locF ? { locF } : {}) },
});

describe("computeTopologyColumns — location-code row clustering", () => {
  // Shared shape: fg → keyless spine switch sw0 (continues fg's row), plus
  // four same-column sibling switches whose buildings arrive interleaved
  // (A, B, A, B). All heights are equal so the legacy sort is element order.
  const interleavedSiblings = (withCodes: boolean) => [
    node("fg", "fortigate"),
    node("sw0", "fortiswitch"),
    locNode("swA1", "fortiswitch", withCodes ? "shop" : undefined),
    locNode("swB1", "fortiswitch", withCodes ? "office" : undefined),
    locNode("swA2", "fortiswitch", withCodes ? "shop" : undefined),
    locNode("swB2", "fortiswitch", withCodes ? "office" : undefined),
    edge("fg", "sw0"),
    edge("fg", "swA1"),
    edge("fg", "swB1"),
    edge("fg", "swA2"),
    edge("fg", "swB2"),
  ];

  it("packs interleaved same-building siblings into adjacent row bands (A,B,A,B → A,A,B,B)", () => {
    const cols = computeTopologyColumns(interleavedSiblings(true))!;
    // Same-building pairs sit on adjacent rows…
    expect(Math.abs(cols.swA1.lane - cols.swA2.lane)).toBe(1);
    expect(Math.abs(cols.swB1.lane - cols.swB2.lane)).toBe(1);
    // …and the two buildings' bands don't interleave.
    const shop = [cols.swA1.lane, cols.swA2.lane];
    const office = [cols.swB1.lane, cols.swB2.lane];
    expect(Math.min(...office) > Math.max(...shop) || Math.min(...shop) > Math.max(...office)).toBe(true);
    // First-appearance order: shop (swA1 appeared first) above office.
    expect(Math.max(...shop)).toBeLessThan(Math.min(...office));
  });

  it("does not change the spine: the first-ordered child still continues the parent's row", () => {
    const cols = computeTopologyColumns(interleavedSiblings(true))!;
    expect(cols.fg.lane).toBe(0);
    expect(cols.sw0.lane).toBe(0); // keyless spine untouched by grouping
  });

  it("reproduces the legacy element-order layout when no node carries codes", () => {
    const cols = computeTopologyColumns(interleavedSiblings(false))!;
    // Legacy: fresh rows claimed in element order after the spine.
    expect(cols.sw0.lane).toBe(0);
    expect(cols.swA1.lane).toBe(1);
    expect(cols.swB1.lane).toBe(2);
    expect(cols.swA2.lane).toBe(3);
    expect(cols.swB2.lane).toBe(4);
  });

  it("sinks keyless siblings to the tail while coded ones cluster", () => {
    const cols = computeTopologyColumns([
      node("fg", "fortigate"),
      node("sw0", "fortiswitch"),
      locNode("swA1", "fortiswitch", "shop"),
      node("swPlain", "fortiswitch"),
      locNode("swA2", "fortiswitch", "shop"),
      edge("fg", "sw0"),
      edge("fg", "swA1"),
      edge("fg", "swPlain"),
      edge("fg", "swA2"),
    ])!;
    expect(Math.abs(cols.swA1.lane - cols.swA2.lane)).toBe(1); // shop pair adjacent
    expect(cols.swPlain.lane).toBeGreaterThan(Math.max(cols.swA1.lane, cols.swA2.lane)); // keyless at tail
  });

  it("subgroups by floor within a building", () => {
    const cols = computeTopologyColumns([
      node("fg", "fortigate"),
      node("sw0", "fortiswitch"),
      locNode("swF2a", "fortiswitch", "shop", "2"),
      locNode("swF1", "fortiswitch", "shop", "1"),
      locNode("swF2b", "fortiswitch", "shop", "2"),
      edge("fg", "sw0"),
      edge("fg", "swF2a"),
      edge("fg", "swF1"),
      edge("fg", "swF2b"),
    ])!;
    // Floor-2 pair adjacent (floor 2 appeared first), floor 1 after.
    expect(Math.abs(cols.swF2a.lane - cols.swF2b.lane)).toBe(1);
    expect(cols.swF1.lane).toBeGreaterThan(Math.max(cols.swF2a.lane, cols.swF2b.lane));
  });

  it("keeps each switch's AP block contiguous under it when buildings regroup the switches", () => {
    const els = [
      node("fg", "fortigate"),
      node("sw0", "fortiswitch"),
      locNode("swA1", "fortiswitch", "shop"),
      locNode("swB1", "fortiswitch", "office"),
      locNode("swA2", "fortiswitch", "shop"),
      edge("fg", "sw0"),
      edge("fg", "swA1"),
      edge("fg", "swB1"),
      edge("fg", "swA2"),
    ];
    // sw0 gets an AP too so all four siblings share subtree height — the
    // height sort then keeps element order and sw0 (first) holds the spine.
    const apsBySwitch: Record<string, string[]> = {
      sw0: ["s0a"],
      swA1: ["a1a", "a1b"],
      swB1: ["b1a", "b1b"],
      swA2: ["a2a", "a2b"],
    };
    for (const [sw, aps] of Object.entries(apsBySwitch)) {
      for (const ap of aps) {
        els.push(node(ap, "fortiap"));
        els.push(edge(sw, ap));
      }
    }
    const cols = computeTopologyColumns(els)!;
    const contiguous = (ls: number[]) => {
      const s = [...ls].sort((x, y) => x - y);
      return s.every((l, i) => i === 0 || l === s[i - 1] + 1);
    };
    for (const [sw, aps] of Object.entries(apsBySwitch)) {
      const lanes = aps.map((a) => cols[a].lane);
      expect(contiguous(lanes)).toBe(true); // block intact
      expect(cols[sw].lane).toBe(Math.min(...lanes)); // switch tops its own block
    }
    // Same-building switches (with their reserved AP rows) stay adjacent:
    // nothing from office lands between shop's two bands.
    expect(cols.swA2.lane).toBe(cols.swA1.lane + apsBySwitch.swA1.length);
    expect(cols.swB1.lane).toBeGreaterThan(cols.swA2.lane);
  });

  it("is deterministic with location codes present", () => {
    const els = interleavedSiblings(true);
    expect(computeTopologyColumns(els)).toEqual(computeTopologyColumns(els));
  });

  it("a foreign fan-out edge no longer crosses the leaf column at an intermediate row: first leaf lands on its parent's row", () => {
    // swW has one AP. A foreign chain's edge swA(2,0)→swB2(4,2) used to be a
    // diagonal crossing the AP's column (3) at lane 1 — exactly swW's row —
    // so without a building code the AP was pushed down (the b: code made
    // the leaf pass ignore foreign pass-throughs). Under the fan-out model
    // that edge runs along row 0 through column 3 and turns in the gutter,
    // so it occupies (3,0) and never (3,1): the AP shares its parent's row
    // in BOTH variants, and the building code changes nothing here.
    const build = (withCode: boolean) => {
      const els = [
        node("fg", "fortigate"),
        node("swA", "fortiswitch"),
        node("swB", "fortiswitch"),
        node("swB1", "fortiswitch"),
        node("swB2", "fortiswitch"),
        locNode("swW", "fortiswitch", withCode ? "warehouse" : undefined),
        node("apW", "fortiap"),
        edge("fg", "swA"),
        edge("swA", "swB"),
        edge("swA", "swB1"),
        edge("swA", "swB2"),
        edge("fg", "swW"),
        edge("swW", "apW"),
      ];
      return computeTopologyColumns(els)!;
    };
    const coded = build(true);
    // Sanity: the shape still puts swW on row 1 and swB2 on row 2, so the
    // old diagonal WOULD have crossed (3,1).
    expect(coded.swW.lane).toBe(1);
    expect(coded.swB2.lane).toBe(2);
    expect(coded.apW.lane).toBe(coded.swW.lane); // same row as its parent
    const plain = build(false);
    expect(plain.swW.lane).toBe(1);
    expect(plain.swB2.lane).toBe(2);
    expect(plain.apW.lane).toBe(plain.swW.lane); // no dodge needed any more
  });
});

describe("computeTopologyColumns — fan-out edge model", () => {
  it("keeps a bridged switch's downstream AP beside it instead of orphaning it", () => {
    // Mirrors the DRIVERS/EMPLOYEE buildings: a switch bridged behind a mesh
    // leaf AP carries its own wired FortiAP. The solver used to drop EVERY
    // non-mesh edge touching a bridge leaf, so the AP had no path to the
    // firewall and fell into the orphan column's stray rows a dozen lanes
    // below its switch. Only the parent → leaf uplink is bogus.
    const cols = computeTopologyColumns([
      node("fg", "fortigate"),
      node("sw", "fortiswitch"),
      node("apRoot", "fortiap"),
      node("swBridge", "fortiswitch"),
      node("apBehind", "fortiap"),
      edge("fg", "sw"),
      edge("sw", "apRoot"),
      bridgeEdge("apRoot", "swBridge"),
      controllerEdge("fg", "swBridge"), // bogus FortiLink — still suppressed
      edge("swBridge", "apBehind"), // the switch's OWN wired AP — must survive
    ])!;
    expect(cols.swBridge.depth).toBe(6);
    expect(cols.apBehind.depth).toBe(cols.swBridge.depth + 1); // leaf column right of its switch
    expect(cols.apBehind.lane).toBe(cols.swBridge.lane); // on its switch's row, not a stray row
  });

  it("keeps a switch chained behind a bridged switch in the verified tree", () => {
    const cols = computeTopologyColumns([
      node("fg", "fortigate"),
      node("sw", "fortiswitch"),
      node("apRoot", "fortiap"),
      node("swBridge", "fortiswitch"),
      node("swBehind", "fortiswitch"),
      node("apBehind", "fortiap"),
      edge("fg", "sw"),
      edge("sw", "apRoot"),
      bridgeEdge("apRoot", "swBridge"),
      controllerEdge("fg", "swBridge"),
      edge("swBridge", "swBehind"),
      edge("swBridge", "apBehind"),
    ])!;
    expect(cols.swBehind.depth).toBe(cols.swBridge.depth + 2); // next anchor column, not orphaned
    expect(cols.swBehind.lane).toBe(cols.swBridge.lane); // continues the row (spine)
    expect(cols.apBehind.depth).toBe(cols.swBridge.depth + 1);
    expect(cols.apBehind.lane).toBe(cols.swBridge.lane + 1); // one below: the spine edge owns the row
  });

  it("reserves the spine-edge cell so a sibling's AP block sits directly beneath it", () => {
    // Mirrors QC-LAB / ASP-TOWER: two non-spine sibling switches under one
    // parent, each with a child switch (so its spine continues) and an AP
    // stack. The lower sibling's spine edge used to run through the row the
    // upper sibling's last AP was planned for, and the leaf pass then slid
    // the whole AP block rows away from its switch.
    const els = [
      node("fg", "fortigate"),
      node("p", "fortiswitch"),
      node("s", "fortiswitch"),
      node("s2", "fortiswitch"),
      node("s3", "fortiswitch"),
      node("a", "fortiswitch"),
      node("aChild", "fortiswitch"),
      node("b", "fortiswitch"),
      node("bChild", "fortiswitch"),
      edge("fg", "p"),
      edge("p", "s"),
      edge("s", "s2"),
      edge("s2", "s3"), // tallest chain → s holds the spine
      edge("p", "a"),
      edge("a", "aChild"),
      edge("p", "b"),
      edge("b", "bChild"),
    ];
    const apsBySwitch: Record<string, string[]> = { a: ["a1", "a2", "a3"], b: ["b1", "b2"] };
    for (const [sw, aps] of Object.entries(apsBySwitch)) {
      for (const ap of aps) {
        els.push(node(ap, "fortiap"));
        els.push(edge(sw, ap));
      }
    }
    const cols = computeTopologyColumns(els)!;
    expect(cols.a.depth).toBe(4);
    expect(cols.b.depth).toBe(4);
    const aLanes = apsBySwitch.a.map((x) => cols[x].lane).sort((x, y) => x - y);
    const bLanes = apsBySwitch.b.map((x) => cols[x].lane).sort((x, y) => x - y);
    // Each block starts one row below its switch (the spine edge owns the
    // switch's own row in the leaf column) and runs contiguously.
    expect(aLanes).toEqual([cols.a.lane + 1, cols.a.lane + 2, cols.a.lane + 3]);
    expect(bLanes).toEqual([cols.b.lane + 1, cols.b.lane + 2]);
    // b sits below a's whole block, and its spine row is not an AP row.
    expect(cols.b.lane).toBeGreaterThan(aLanes[aLanes.length - 1]);
    expect(aLanes).not.toContain(cols.b.lane);
    expect(cols.bChild.lane).toBe(cols.b.lane);
  });

  it("reserves the corridor of a child four columns out so its edge runs through no node", () => {
    // p's children: switch s (col 4, three APs in col 5) and mesh-root AP r
    // (weight 3 ranks it in col 6, four columns from p). r's fan-out edge
    // turns in the gutter at 3.5 and runs along r's row through columns 4
    // and 5 — so r may not take a row where s's APs sit.
    const cols = computeTopologyColumns([
      node("fg", "fortigate"),
      node("p", "fortiswitch"),
      node("s", "fortiswitch"),
      node("s1", "fortiap"),
      node("s2", "fortiap"),
      node("s3", "fortiap"),
      node("r", "fortiap"),
      node("rl", "fortiap"),
      edge("fg", "p"),
      edge("p", "s"),
      edge("s", "s1"),
      edge("s", "s2"),
      edge("s", "s3"),
      edge("p", "r"),
      meshEdge("r", "rl"),
    ])!;
    expect(cols.p.depth).toBe(2);
    expect(cols.s.depth).toBe(4);
    expect(cols.r.depth).toBe(6);
    const sApLanes = ["s1", "s2", "s3"].map((x) => cols[x].lane);
    expect(sApLanes.sort((x, y) => x - y)).toEqual([0, 1, 2]);
    expect(cols.r.lane).toBe(3); // first row whose corridor cells (4,L),(5,L) are free
    expect(sApLanes).not.toContain(cols.r.lane);
    expect(cols.rl.lane).toBe(cols.r.lane);
  });

  // A minimal stand-in for the Cytoscape edge collection markFanOutEdges reads
  // and stamps: data(key) reads, data({...}) merges.
  const fakeCy = (edges: Record<string, unknown>[]) => {
    const store = edges.map((d) => {
      const data: Record<string, unknown> = { ...d };
      return {
        data(arg?: string | Record<string, unknown>) {
          if (typeof arg === "string") return data[arg];
          if (arg) Object.assign(data, arg);
          return data;
        },
      };
    });
    return { edges: () => ({ forEach: (fn: (e: unknown) => void) => store.forEach(fn) }), store };
  };

  it("markFanOutEdges stamps orthogonal geometry on two-plus-column edges between different rows", () => {
    const columns: Cols = {
      fg: { depth: 0, lane: 0 },
      swA: { depth: 2, lane: 0 },
      swB: { depth: 2, lane: 3 },
      leafA: { depth: 3, lane: 0 },
      swC: { depth: 4, lane: 3 },
    };
    const cy = fakeCy([
      { source: "fg", target: "swB" },              // Δ2, rows differ, source shallow → +turn
      { source: "swC", target: "fg" },              // Δ4, stored deep → shallow → −turn (from target)
      { source: "fg", target: "swA" },              // same row → straight, not stamped
      { source: "swA", target: "leafA" },           // adjacent columns → not stamped
      { source: "fg", target: "swB", isInterGroup: 1 }, // cross-group → left to its own router
      { source: "swB", target: "ghost" },           // endpoint not in the grid → skipped
      { source: "fg", target: "swA", isFanOut: 1, fanOutTurn: 999 }, // stale flag → cleared
    ]);
    markFanOutEdges(cy, columns, { colSpacing: 130, orientation: "horizontal" });
    const d = (i: number) => cy.store[i].data() as Record<string, unknown>;
    expect(d(0)).toMatchObject({ isFanOut: 1, fanOutDir: "horizontal", fanOutTurn: 195 });
    expect(d(1)).toMatchObject({ isFanOut: 1, fanOutDir: "horizontal", fanOutTurn: -195 });
    expect(d(2).isFanOut).toBeUndefined();
    expect(d(3).isFanOut).toBeUndefined();
    expect(d(4).isFanOut).toBeUndefined();
    expect(d(5).isFanOut).toBeUndefined();
    expect(d(6).isFanOut).toBe(0);
  });

  it("markFanOutEdges follows the caller's axis and spacing (phone: depth → y)", () => {
    const columns: Cols = { fg: { depth: 0, lane: 0 }, sw: { depth: 2, lane: 1 } };
    const cy = fakeCy([{ source: "fg", target: "sw" }]);
    markFanOutEdges(cy, columns, { colSpacing: 110, orientation: "vertical" });
    expect(cy.store[0].data()).toMatchObject({ isFanOut: 1, fanOutDir: "vertical", fanOutTurn: 165 });
  });

  it("markFanOutEdges is a no-op without a grid", () => {
    const cy = fakeCy([{ source: "fg", target: "sw" }]);
    markFanOutEdges(cy, null, { colSpacing: 130 });
    expect((cy.store[0].data() as Record<string, unknown>).isFanOut).toBeUndefined();
  });
});
