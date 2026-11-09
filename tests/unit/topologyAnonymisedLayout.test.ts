/**
 * tests/unit/topologyAnonymisedLayout.test.ts
 *
 * Export › Layout data (topology-render.js → anonymisedLayout): the topology
 * as drawn, for review outside the app, with nothing that identifies the
 * site. Device and location-box names, IPs, MACs, serials, asset ids and
 * SSIDs must not appear anywhere in the output; aliases (FW-1, SW-2, AP-1,
 * AREA-1, BLDG-1 …) stand in for them, box nesting and link kinds survive,
 * and port names are kept. Real Cytoscape, headless, in a vm context.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import vm from "node:vm";

let sb: Record<string, any>;

beforeAll(() => {
  const here = dirname(fileURLToPath(import.meta.url));
  const health = { up: "#2e7d32", degraded: "#f9a825", down: "#c62828", maintenance: "#9575cd", unknown: "#9e9e9e", unmonitored: "#757575" };
  sb = { window: { addEventListener() {}, removeEventListener() {}, POLARIS_HEALTH_COLORS: health }, setTimeout, clearTimeout, console };
  sb.self = sb.window;
  vm.createContext(sb);
  vm.runInContext(readFileSync(resolve(here, "../../public/js/vendor/cytoscape.min.js"), "utf8"), sb);
  vm.runInContext(readFileSync(resolve(here, "../../public/js/topology-render.js"), "utf8"), sb);
  vm.runInContext(
    "function exportSite(j, salt) {" +
    "  var R = window.PolarisTopologyRender;" +
    "  var els = R.buildTopologyElements(JSON.parse(j));" +
    "  var cols = R.computeGroupedLayout(els);" +
    "  var pos = {}; Object.keys(cols).forEach(function (id) { pos[id] = { x: cols[id].depth * 130, y: cols[id].lane * 130 }; });" +
    "  var cy = cytoscape({ headless: true, styleEnabled: true, elements: els, style: R.topologyStylesheet('dark', {}), layout: { name: 'preset', positions: pos } });" +
    "  R.renderLocationGroups(cy);" +
    "  var spec = JSON.parse(j); var view = 'a|' + cy.getElementById(spec.switches[0].id).data('locA');" +
    "  var out = R.anonymisedLayout(cy, { view: view, salt: salt || 'site-salt-1', pane: { w: 1600, h: 900 } });" +
    "  cy.destroy(); return JSON.stringify(out); }",
    sb,
  );
});

const loc = (a: string | null, b: string | null) => ({ area: a, building: b, floor: null, room: null, junctionBox: null });
const SECRET = {
  fg: { id: "a1b2c3-fg", hostname: "BOONE-201G-1", ip: "10.20.30.1", mac: "AA:BB:CC:00:11:22", serial: "FG201GTK000001" },
  sw: { id: "d4e5f6-sw", hostname: "BOONE-112F-PUG57", ip: "10.20.30.57" },
  sw2: { id: "778899-sw", hostname: "BOONE-112F-PUG8", ip: "10.20.30.8" },
  ap: { id: "aabbcc-ap", hostname: "BOONE-234F-PUG57", ip: "10.20.31.57" },
  ap2: { id: "ddeeff-ap", hostname: "BOONE-234F-PUGCSB", ip: "10.20.31.58" },
};
function site() {
  const node = (s: { id: string; hostname: string; ip: string }, l: unknown, extra: Record<string, unknown> = {}) =>
    ({ id: s.id, hostname: s.hostname, ipAddress: s.ip, monitorHealth: "up", monitored: true, location: l, ...extra });
  return {
    fortigate: { ...node(SECRET.fg, loc("Old Office", "Basement")), serialNumber: SECRET.fg.serial, macAddress: SECRET.fg.mac },
    switches: [node(SECRET.sw, loc("Pugmill Loadouts", "57 Loudout")), node(SECRET.sw2, loc("Pugmill Loadouts", "8s Loadout"))],
    aps: [
      node(SECRET.ap, loc("Pugmill Loadouts", "57 Loudout"), { stations: [{ id: SECRET.ap2.id, ssid: "BOONE-MESH-SECRET", signalDbm: -70 }] }),
      node(SECRET.ap2, loc("Pugmill Loadouts", "CSB Loadout"), { stations: [] }),
    ],
    edges: [], lldpEdges: [], mclagEdges: [], bridgeEdges: [], remoteAssetNodes: [],
    interfaceEdges: [
      { source: SECRET.fg.id, target: SECRET.sw.id, label: "port18 ↔ port12" },
      { source: SECRET.sw.id, target: SECRET.ap.id, label: "port7 ↔ lan1" },
      { source: SECRET.sw.id, target: SECRET.sw2.id, label: "port9 ↔ port17" },
    ],
  };
}

describe("anonymisedLayout", () => {
  it("leaves no device, box or site name, address, serial, id or SSID in the output", () => {
    const json: string = sb.exportSite(JSON.stringify(site()));
    const forbidden = [
      ...Object.values(SECRET).flatMap((s) => Object.values(s)),
      "Old Office", "Basement", "Pugmill", "Loudout", "Loadout", "BOONE", "MESH-SECRET", "a|pugmill", "pugmill",
    ];
    for (const word of forbidden) expect(json.toLowerCase(), word).not.toContain(String(word).toLowerCase());
  });

  it("aliases devices by role and boxes by level, keeps nesting, link kinds, speeds and port names", () => {
    const out = JSON.parse(sb.exportSite(JSON.stringify(site())));
    expect(out.format).toBe("polaris-topology-layout/1");
    expect(out.pane).toEqual({ w: 1600, h: 900 });
    const ids: string[] = out.devices.map((d: { id: string }) => d.id);
    expect(ids.map((i) => i.split("-")[0]).sort()).toEqual(["AP", "AP", "FW", "SW", "SW"]);
    for (const i of ids) expect(i).toMatch(/^(FW|SW|AP)-[0-9a-f]{5}$/);
    for (const d of out.devices) {
      expect(typeof d.x).toBe("number");
      expect(d.health).toBe("up");
    }
    const kinds = out.boxes.map((b: { kind: string }) => b.kind).sort();
    expect(kinds).toEqual(["area", "area", "building", "building", "building", "building"]);
    // Every building box sits in an area box.
    for (const b of out.boxes.filter((x: { kind: string }) => x.kind === "building")) {
      expect(String(b.parent)).toMatch(/^AREA-[0-9a-f]{5}$/);
    }
    // The view key named a real area — exported as its alias.
    expect(out.view).toMatch(/^AREA-[0-9a-f]{5}$/);
    expect(out.boxes.map((b: { id: string }) => b.id)).toContain(out.view);
    // Port pairs survive (they identify nothing); the mesh link's SSID does not.
    const ports = out.links.map((l: { ports?: string }) => l.ports).filter(Boolean);
    expect(ports).toEqual(expect.arrayContaining(["port18 ↔ port12", "port7 ↔ lan1", "port9 ↔ port17"]));
    const mesh = out.links.find((l: { flags: string[] }) => l.flags.includes("mesh"));
    expect(mesh.ports).toBeUndefined();
    expect(mesh.signal).toBe("fair");
    for (const l of out.links) {
      expect(l.a).toMatch(/^(STUB:)?(FW|SW|AP|AREA|BLDG|FLOOR|ROOM|JB)-[0-9a-f]{5}$|^STUB:base$/);
      expect(l.b).toMatch(/^(STUB:)?(FW|SW|AP|AREA|BLDG|FLOOR|ROOM|JB)-[0-9a-f]{5}$|^STUB:base$/);
    }
  });

  // The first build numbered aliases in screen order per file, so the same
  // switch was SW-9 in one export and SW-3 in the next, and every drill-down
  // was "BLDG-1": files from one site could not be compared.
  it("gives a device and a box the same alias in every export of one site, and different ones elsewhere", () => {
    const a = JSON.parse(sb.exportSite(JSON.stringify(site()), "site-A"));
    const b = JSON.parse(sb.exportSite(JSON.stringify(site()), "site-A"));
    const c = JSON.parse(sb.exportSite(JSON.stringify(site()), "site-B"));
    const ids = (o: { devices: { id: string }[]; boxes: { id: string }[] }) => [...o.devices.map((d) => d.id), ...o.boxes.map((x) => x.id)].sort();
    expect(ids(a)).toEqual(ids(b));
    expect(a.view).toBe(b.view);
    expect(ids(c)).not.toEqual(ids(a));
  });
});
