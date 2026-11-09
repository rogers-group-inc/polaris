/**
 * tests/unit/topologyBoxChains.test.ts
 *
 * Device Map box overhead (public/js/topology-render.js):
 *  - collapseLocationChains drops a box whose devices are exactly those of a
 *    box nested in it (building › floor › room around one switch drew three
 *    walls ~21× the icon's area) and the kept box still names the whole path
 *    on hover (locationGroupTooltipParts);
 *  - a box with no box inside it hugs its devices (LOC_LEAF_PAD), while a box
 *    holding boxes keeps its level's padding.
 * Vendored Cytoscape runs headless in a vm context (inputs built inside it —
 * see topologyRouteBendClearance.test.ts).
 */

import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import vm from "node:vm";

type Group = { key: string; kind: string; name: string; scope: string[]; memberIds: string[]; absorbed?: { kind: string; name: string }[] };
type Hull = { id: string; kind: string; label: string; w: number; h: number; tip: string[] };

let sb: Record<string, any>;

beforeAll(() => {
  const here = dirname(fileURLToPath(import.meta.url));
  sb = { window: { addEventListener() {}, removeEventListener() {} }, setTimeout, clearTimeout, console };
  sb.self = sb.window;
  vm.createContext(sb);
  vm.runInContext(readFileSync(resolve(here, "../../public/js/vendor/cytoscape.min.js"), "utf8"), sb);
  vm.runInContext(readFileSync(resolve(here, "../../public/js/topology-render.js"), "utf8"), sb);
  vm.runInContext(
    "function collapse(j) { return JSON.stringify(window.PolarisTopologyRender.collapseLocationChains(JSON.parse(j))); }" +
    "function hulls(j) {" +
    "  var R = window.PolarisTopologyRender; var spec = JSON.parse(j);" +
    "  var els = spec.map(function (n) { return { data: Object.assign({ role: 'fortiswitch', nodeColor: '#2e7d32' }, n.data), position: n.position }; });" +
    "  var cy = cytoscape({ headless: true, styleEnabled: true, elements: els, layout: { name: 'preset' }, style: R.topologyStylesheet('dark', {}) });" +
    "  R.renderLocationGroups(cy);" +
    "  var out = cy.nodes('[isLocGroup]').map(function (h) { return { id: h.id(), kind: h.data('locKind'), label: h.data('label')," +
    "    w: h.width(), h: h.height(), tip: R.locationGroupTooltipParts(cy, h).map(function (p) { return p.kind + ':' + p.name; }) }; });" +
    "  cy.destroy(); return JSON.stringify(out); }",
    sb,
  );
});

const collapse = (g: Group[]): Group[] => JSON.parse(sb.collapse(JSON.stringify(g)));
const hulls = (spec: unknown): Hull[] => JSON.parse(sb.hulls(JSON.stringify(spec)));

function dev(id: string, x: number, y: number, loc: Record<string, string>) {
  return { data: { id, label: "", ...loc }, position: { x, y } };
}
const SHOP = { locB: "shop", locBName: "Shop" };
const F2 = { ...SHOP, locF: "2", locFName: "Floor 2" };

describe("collapseLocationChains", () => {
  it("keeps only the deepest box of a single-child chain, naming the dropped levels", () => {
    const out = collapse([
      { key: "b|a|shop", kind: "building", name: "Shop", scope: ["a", "shop"], memberIds: ["s1"] },
      { key: "f|a|shop|2", kind: "floor", name: "Floor 2", scope: ["a", "shop", "2"], memberIds: ["s1"] },
      { key: "r|a|shop|2|n", kind: "room", name: "North", scope: ["a", "shop", "2", "n"], memberIds: ["s1"] },
    ]);
    expect(out.map((g) => g.key)).toEqual(["r|a|shop|2|n"]);
    expect(out[0].absorbed).toEqual([{ kind: "building", name: "Shop" }, { kind: "floor", name: "Floor 2" }]);
  });

  it("keeps nesting that means something: two rooms on one floor, a device straight on the floor", () => {
    const twoRooms = collapse([
      { key: "f|x|b|1", kind: "floor", name: "1", scope: ["x", "b", "1"], memberIds: ["s1", "s2"] },
      { key: "r|x|b|1|n", kind: "room", name: "N", scope: ["x", "b", "1", "n"], memberIds: ["s1"] },
      { key: "r|x|b|1|s", kind: "room", name: "S", scope: ["x", "b", "1", "s"], memberIds: ["s2"] },
    ]);
    expect(twoRooms.map((g) => g.key)).toEqual(["f|x|b|1", "r|x|b|1|n", "r|x|b|1|s"]);
    const onFloor = collapse([
      { key: "f|x|b|1", kind: "floor", name: "1", scope: ["x", "b", "1"], memberIds: ["s1", "s2"] },
      { key: "r|x|b|1|n", kind: "room", name: "N", scope: ["x", "b", "1", "n"], memberIds: ["s1"] },
    ]);
    expect(onFloor.map((g) => g.key)).toEqual(["f|x|b|1", "r|x|b|1|n"]);
  });

  it("never merges unrelated groups that happen to hold the same devices' ids", () => {
    const out = collapse([
      { key: "b|a|one", kind: "building", name: "One", scope: ["a", "one"], memberIds: ["s1"] },
      { key: "b|a|two", kind: "building", name: "Two", scope: ["a", "two"], memberIds: ["s1"] },
    ]);
    expect(out).toHaveLength(2);
  });
});

describe("renderLocationGroups box overhead", () => {
  it("draws one box for building › floor › room around one switch, its hover naming all three", () => {
    const out = hulls([dev("s1", 0, 0, { ...F2, locR: "n", locRName: "North" })]);
    expect(out.map((h) => h.kind)).toEqual(["room"]);
    expect(out[0].label).toBe("North");
    expect(out[0].tip).toEqual(["building:Shop", "floor:Floor 2", "room:North"]);
  });

  it("a box with nothing nested hugs its device; a box holding boxes keeps its level padding", () => {
    // Floor 2 holds two rooms → stays a floor with its own padding; each
    // room is a leaf. Names are empty so the name strip and name width are
    // out of the sums.
    const out = hulls([
      dev("s1", 0, 0, { ...F2, locFName: "", locBName: "", locR: "n", locRName: "" }),
      dev("s2", 0, 400, { ...F2, locFName: "", locBName: "", locR: "s", locRName: "" }),
    ]);
    const rooms = out.filter((h) => h.kind === "room");
    const floor = out.find((h) => h.kind === "floor")!;
    expect(rooms).toHaveLength(2);
    const icon = rooms[0].w - 2 * 10; // LOC_LEAF_PAD each side
    expect(icon).toBeGreaterThanOrEqual(44);
    expect(icon).toBeLessThanOrEqual(48);
    expect(rooms[0].h).toBe(rooms[0].w); // unnamed: pad above and below, no label metrics headless
    // The floor steps 26 px (its level padding) outside its rooms.
    expect(floor.w).toBe(rooms[0].w + 2 * 26);
  });
});
