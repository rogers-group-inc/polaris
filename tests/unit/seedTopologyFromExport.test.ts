/**
 * tests/unit/seedTopologyFromExport.test.ts
 *
 * scripts/seed-topology-from-export.ts turns an anonymised Device Map export
 * back into rows. Round trip, no database: the seed plan is served by an
 * in-memory Prisma stand-in to the REAL buildSiteTopology, and its payload to
 * the REAL buildTopologyElements (topology-render.js in a vm context). The
 * drawn device-to-device links and each node's location path must be exactly
 * the export's. A small synthetic export always runs; set
 * SEED_TOPOLOGY_EXPORT=<file> to also round-trip a real one.
 */

import { describe, it, expect, beforeAll, vi } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import vm from "node:vm";

/* eslint-disable @typescript-eslint/no-explicit-any */
const db = vi.hoisted(() => ({
  assets: [] as any[],
  lldp: [] as any[],
  interfaces: [] as any[],
  samples: [] as any[],
}));

vi.mock("../../src/db.js", () => {
  const inIds = (w: any, key: string, row: any) => !w?.[key]?.in || w[key].in.includes(row[key]);
  const stampMatches = (row: any, or: any[]) =>
    or.some((c) => {
      const p = c.fortinetTopology;
      return p && row.fortinetTopology?.[p.path[0]] === p.equals;
    });
  const asset = {
    findFirst: async ({ where }: any) => db.assets.find((a) => a.id === where.id) ?? null,
    findUnique: async ({ where }: any) => db.assets.find((a) => a.id === where.id) ?? null,
    findMany: async ({ where }: any = {}) => {
      // site siblings: switch / AP children of one controller stamp
      if (Array.isArray(where?.OR) && where.OR.some((c: any) => c.assetType === "switch")) {
        const stamps = where.AND?.[0]?.OR ?? [];
        return db.assets.filter((a) => (a.assetType === "switch" || a.assetType === "access_point") && stampMatches(a, stamps));
      }
      if (where?.assetType?.notIn) return []; // endpoints
      if (where?.assetType === "firewall") return []; // HA standbys
      return db.assets; // interface-inference inventory
    },
  };
  const fresh = (w: any, r: any) => !w?.lastSeen?.gt || r.lastSeen > w.lastSeen.gt;
  const models: Record<string, any> = {
    asset,
    assetLldpNeighbor: {
      findMany: async ({ where }: any) =>
        db.lldp
          .filter((r) => inIds(where, "assetId", r))
          .map((r) => ({ ...r, matchedAsset: db.assets.find((a) => a.id === r.matchedAssetId) ?? null })),
    },
    assetInterface: {
      findMany: async ({ where }: any) => db.interfaces.filter((r) => inIds(where, "assetId", r) && fresh(where, r)),
    },
    assetMonitorSample: {
      findMany: async ({ where, take }: any) => db.samples.filter((s) => s.assetId === where.assetId).slice(0, take ?? 10),
    },
  };
  const empty = { findMany: async () => [], findFirst: async () => null, findUnique: async () => null };
  const prisma = new Proxy({} as any, {
    get: (_t, k: string) => (k === "$queryRaw" ? async () => [] : models[k] ?? empty),
  });
  return { prisma, prismaBase: prisma };
});

import { buildSeedPlan, type TopologyExport } from "../../scripts/seed-topology-from-export.js";
import { buildSiteTopology } from "../../src/services/topologyGraphService.js";

let sb: Record<string, any>;
beforeAll(() => {
  const here = dirname(fileURLToPath(import.meta.url));
  const health = { up: "#2e7d32", degraded: "#f9a825", down: "#c62828", maintenance: "#9575cd", unknown: "#9e9e9e", unmonitored: "#757575", passive: "#1565c0" };
  sb = { window: { addEventListener() {}, removeEventListener() {}, POLARIS_HEALTH_COLORS: health }, setTimeout, clearTimeout, console };
  sb.self = sb.window;
  vm.createContext(sb);
  vm.runInContext(readFileSync(resolve(here, "../../public/js/vendor/cytoscape.min.js"), "utf8"), sb);
  vm.runInContext(readFileSync(resolve(here, "../../public/js/topology-render.js"), "utf8"), sb);
  vm.runInContext(
    "function elementsOf(j) { return JSON.stringify(window.PolarisTopologyRender.buildTopologyElements(JSON.parse(j))); }",
    sb,
  );
});

async function roundTrip(exp: TopologyExport) {
  const plan = buildSeedPlan(exp);
  const now = new Date();
  db.assets = plan.assets.map((a) => ({ ...a, lastSeen: now, dependencyLayer: null, dependencySuppressed: false, notes: null, learnedLocation: null }));
  db.lldp = plan.lldp.map((r) => ({ ...r, id: `${r.assetId}|${r.localIfName}`, lastSeen: now, managementIp: null, systemDescription: null, capabilities: [] }));
  db.interfaces = plan.interfaces.map((r) => ({ ...r, ifType: "physical", ifParent: null, operStatus: "up", inErrors: 0n, outErrors: 0n, lastSeen: now }));
  db.samples = plan.samples;
  const fg = plan.assets.find((a) => a.assetType === "firewall")!;
  const payload = await buildSiteTopology(fg.id);
  const els = JSON.parse(sb.elementsOf(JSON.stringify(payload))) as Array<{ data: any }>;
  const exportIdOf = new Map(plan.assets.map((a) => [a.id, a.exportId]));
  const nodes = els.filter((e) => !e.data.source);
  const edges = els.filter((e) => e.data.source);
  return { plan, payload, nodes, edges, exportIdOf };
}

const pairKey = (a: string, b: string) => [a, b].sort().join(" ~ ");

async function expectSameSite(exp: TopologyExport) {
  const { plan, payload, nodes, edges, exportIdOf } = await roundTrip(exp);
  expect(plan.warnings).toEqual([]);
  // every device is a node of this one site
  expect(1 + payload.switches.length + payload.aps.length).toBe(exp.devices.length);
  expect(nodes.map((n) => exportIdOf.get(n.data.id)).sort()).toEqual(exp.devices.map((d) => d.id).sort());
  // the drawn links, by device pair
  const drawn = edges.map((e) => pairKey(exportIdOf.get(e.data.source)!, exportIdOf.get(e.data.target)!)).sort();
  expect(drawn).toEqual(exp.links.map((l) => pairKey(l.a, l.b)).sort());
  // link kind, port pair and speed class per pair
  const byPair = new Map(edges.map((e) => [pairKey(exportIdOf.get(e.data.source)!, exportIdOf.get(e.data.target)!), e.data]));
  for (const l of exp.links) {
    const d = byPair.get(pairKey(l.a, l.b))!;
    const flipped = exportIdOf.get(d.source) !== l.a;
    const ports = String(l.ports || "").split(" ↔ ");
    expect(d.label, `${l.a}–${l.b}`).toBe(flipped ? `${ports[1]} ↔ ${ports[0]}` : l.ports);
    expect(d.linkSpeed, `${l.a}–${l.b} speed`).toBe(l.speed || "unknown");
    for (const f of ["verifiedUplink", "apLink", "iface"]) {
      if (l.flags.includes(f)) expect(d["is" + f[0].toUpperCase() + f.slice(1)], `${l.a}–${l.b} ${f}`).toBeTruthy();
    }
  }
  // location path per node = the export's boxes for that device
  const kinds = new Map(exp.boxes.map((b) => [b.id, b.kind]));
  for (const n of nodes) {
    const dev = exp.devices.find((d) => d.id === exportIdOf.get(n.data.id))!;
    const want: Record<string, string> = {};
    for (const b of dev.boxes) want[kinds.get(b)!] = b;
    const got: Record<string, string> = {};
    const names: Record<string, string> = { locAName: "area", locBName: "building", locFName: "floor", locRName: "room", locJbName: "jb" };
    for (const [k, kind] of Object.entries(names)) if (n.data[k]) got[kind] = n.data[k];
    expect(got, dev.id).toEqual(want);
    // health, read back the way the export reads it (node colour → key)
    const colours = sb.window.POLARIS_HEALTH_COLORS as Record<string, string>;
    const health = Object.keys(colours).find((k) => colours[k] === n.data.nodeColor);
    expect(health, `${dev.id} health`).toBe(dev.health);
  }
}

const MINI: TopologyExport = {
  format: "polaris-topology-layout/1",
  devices: [
    { id: "FW-1", role: "fortigate", health: "up", boxes: ["BLDG-1", "FLOOR-1"] },
    { id: "SW-1", role: "fortiswitch", health: "up", boxes: ["BLDG-1", "FLOOR-1"] },
    { id: "SW-2", role: "fortiswitch", health: "down", boxes: ["BLDG-1", "FLOOR-1", "ROOM-1", "JB-1"] },
    { id: "SW-3", role: "fortiswitch", health: "unmonitored", boxes: ["AREA-1", "BLDG-2"] },
    { id: "AP-1", role: "fortiap", health: "up", boxes: ["BLDG-1", "FLOOR-1", "ROOM-1"] },
    { id: "AP-2", role: "fortiap", health: "unmonitored", boxes: [] },
  ],
  boxes: [
    { id: "AREA-1", kind: "area", parent: null },
    { id: "BLDG-1", kind: "building", parent: null },
    { id: "BLDG-2", kind: "building", parent: "AREA-1" },
    { id: "FLOOR-1", kind: "floor", parent: "BLDG-1" },
    { id: "ROOM-1", kind: "room", parent: "FLOOR-1" },
    { id: "JB-1", kind: "jb", parent: "ROOM-1" },
  ],
  links: [
    { a: "FW-1", b: "SW-1", flags: ["verifiedUplink"], ports: "x1 ↔ port52", speed: "10g" },
    { a: "SW-1", b: "SW-2", flags: ["iface"], ports: "port49 ↔ port50", speed: "1g" },
    { a: "SW-2", b: "SW-3", flags: ["iface", "interGroup"], ports: "port9 ↔ unknown", speed: "1g" },
    { a: "SW-2", b: "AP-1", flags: ["apLink"], ports: "port8 ↔ lan1", speed: "100m" },
  ],
};

describe("seed-topology-from-export round trip", () => {
  it("redraws a synthetic export's devices, links, ports, speeds and boxes", async () => {
    await expectSameSite(MINI);
  });

  it("writes FMG-device-name controller stamps, not the gate hostname", () => {
    const plan = buildSeedPlan(MINI);
    const fg = plan.assets.find((a) => a.assetType === "firewall")!;
    expect(fg.fortinetTopology.deviceName).not.toBe(fg.hostname);
    for (const a of plan.assets.filter((x) => x.assetType !== "firewall")) {
      expect(a.fortinetTopology.controllerFortigate).toBe(fg.fortinetTopology.deviceName);
      expect(a.hostname.startsWith("EXP-")).toBe(true);
    }
  });

  const real = process.env.SEED_TOPOLOGY_EXPORT;
  it.skipIf(!real || !existsSync(real))("redraws the export named by SEED_TOPOLOGY_EXPORT", async () => {
    await expectSameSite(JSON.parse(readFileSync(real!, "utf8")) as TopologyExport);
  });
});
