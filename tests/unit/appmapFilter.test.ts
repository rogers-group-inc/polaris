/**
 * tests/unit/appmapFilter.test.ts
 *
 * Unit tests for the Application Map's pill-filter core — applyGraphFilter(),
 * buildFilterCatalog() and rankSuggestions() in public/js/appmap.js. Those live
 * in a browser IIFE (no module export), so we evaluate the file in a Node vm
 * context with a stub `window` and pull them off window.PolarisAppMap — same
 * approach as tests/unit/topologyColumns.test.ts.
 *
 * The behaviour under test is the semantic the operator was promised: pills
 * combine OR WITHIN a kind and AND ACROSS kinds. Also covers consolidatePorts(),
 * the listening-port range collapser from the same module.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import vm from "node:vm";

interface Node {
  id: string;
  kind: string;
  parent?: string;
  assetId?: string;
  hostname?: string;
  ipAddress?: string;
  assetType?: string;
  processName?: string;
  serviceUnit?: string;
  listenPorts?: Array<{ proto: string; port: number }>;
  ip?: string;
  cidr?: string;
  ips?: string[];
  hasMappedProcesses?: boolean;
  tags?: string[];
}
interface Port { proto: string; port: number; count?: number; firstSeen?: string; lastSeen?: string }
interface Edge { id: string; source: string; target: string; kind: string; ports: Port[]; portOverflow?: number; lastSeen: string }
interface Pill { kind: string; value: string }
interface Filter { ageMs: number; hideExternal: boolean; hideWorkstations?: boolean; pills: Pill[]; excludeEdges?: Record<string, boolean> }
interface Result { nodes: Node[]; edges: Array<{ edge: Edge; ports: Port[] }> }

let applyGraphFilter: (n: Node[], e: Edge[], f: Filter, now: number) => Result;
let buildFilterCatalog: (n: Node[], e: Edge[]) => Pill[];
let rankSuggestions: (c: Pill[], q: string) => Pill[];
let consolidatePorts: (p: Array<{ proto: string; port: number }>) =>
  Array<{ proto: string; label: string; from: number; to: number; count: number }>;

beforeAll(() => {
  const here = dirname(fileURLToPath(import.meta.url));
  const file = resolve(here, "../../public/js/appmap.js");
  const code = readFileSync(file, "utf8");
  // The IIFE registers a DOMContentLoaded listener and touches `document` only
  // from inside handlers, so a bare stub is enough to evaluate it.
  const sandbox: { window: Record<string, any>; document: any } = {
    window: {},
    document: { addEventListener() {}, getElementById: () => null, documentElement: { getAttribute: () => "dark" } },
  };
  (sandbox.window as any).document = sandbox.document;
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);
  applyGraphFilter = sandbox.window.PolarisAppMap.applyGraphFilter;
  buildFilterCatalog = sandbox.window.PolarisAppMap.buildFilterCatalog;
  rankSuggestions = sandbox.window.PolarisAppMap.rankSuggestions;
  consolidatePorts = sandbox.window.PolarisAppMap.consolidatePorts;
  edgePortKey = sandbox.window.PolarisAppMap.edgePortKey;
  assignPortColors = sandbox.window.PolarisAppMap.assignPortColors;
  PORT_PALETTE = sandbox.window.PolarisAppMap.PORT_PALETTE;
  buildPortLegend = sandbox.window.PolarisAppMap.buildPortLegend;
  portHiddenEdges = sandbox.window.PolarisAppMap.portHiddenEdges;
  cleanHiddenPorts = sandbox.window.PolarisAppMap.cleanHiddenPorts;
});

interface LegendRow { key: string; color: string | null; count: number; hidden: boolean }
interface Legend { colors: Record<string, string>; rows: LegendRow[]; other: { count: number; hidden: boolean } }
let buildPortLegend: (keys: Array<string | null>, prev: Record<string, string>, hidden: string[], palette?: string[]) => Legend;
let portHiddenEdges: (edges: Array<{ edge: Edge; ports: Port[] }>, legend: Legend) => Record<string, boolean>;
let cleanHiddenPorts: (list: unknown) => string[];

let edgePortKey: (p: Port[]) => string | null;
let assignPortColors: (keys: Array<string | null>, prev: Record<string, string>, palette?: string[]) => {
  colors: Record<string, string>;
  legend: Array<{ key: string; color: string; count: number }>;
  otherCount: number;
};
let PORT_PALETTE: string[];

const NOW = Date.parse("2026-07-28T12:00:00Z");
const iso = (minutesAgo: number) => new Date(NOW - minutesAgo * 60_000).toISOString();

// Two hosts. web01 runs nginx (a mapped process) and myapp.service (a mapped
// service); db01 runs postgres. Plus one external IP.
function fixture(): { nodes: Node[]; edges: Edge[] } {
  const nodes: Node[] = [
    { id: "asset:A", kind: "asset", assetId: "A", hostname: "web01", ipAddress: "10.0.0.1", assetType: "server", hasMappedProcesses: true },
    { id: "proc:A:nginx", kind: "process", parent: "asset:A", assetId: "A", processName: "nginx", listenPorts: [{ proto: "tcp", port: 443 }] },
    { id: "svc:A:myapp", kind: "service", parent: "asset:A", assetId: "A", serviceUnit: "myapp.service", listenPorts: [{ proto: "tcp", port: 8080 }] },
    { id: "asset:B", kind: "asset", assetId: "B", hostname: "db01", ipAddress: "10.0.0.2", assetType: "workstation", hasMappedProcesses: true },
    { id: "proc:B:postgres", kind: "process", parent: "asset:B", assetId: "B", processName: "postgres", listenPorts: [{ proto: "tcp", port: 5432 }] },
    { id: "ip:203.0.113.9", kind: "unknown-ip", ip: "203.0.113.9" },
  ];
  const edges: Edge[] = [
    // web01's nginx → db01's postgres, tcp/5432
    { id: "e1", source: "proc:A:nginx", target: "proc:B:postgres", kind: "process", ports: [{ proto: "tcp", port: 5432 }], lastSeen: iso(2) },
    // web01's service → an external IP over udp/514
    { id: "e2", source: "svc:A:myapp", target: "ip:203.0.113.9", kind: "external", ports: [{ proto: "udp", port: 514 }], lastSeen: iso(2) },
    // db01's postgres → external, tcp/80, and OLD
    { id: "e3", source: "proc:B:postgres", target: "ip:203.0.113.9", kind: "external", ports: [{ proto: "tcp", port: 80 }], lastSeen: iso(600) },
  ];
  return { nodes, edges };
}

const noFilter = (over: Partial<Filter> = {}): Filter =>
  ({ ageMs: 0, hideExternal: false, pills: [], ...over });

const run = (f: Filter) => {
  const { nodes, edges } = fixture();
  return applyGraphFilter(nodes, edges, f, NOW);
};
const edgeIds = (r: Result) => r.edges.map((x) => x.edge.id).sort();
const nodeIds = (r: Result) => r.nodes.map((n) => n.id).sort();

describe("applyGraphFilter — no pills (baseline behaviour preserved)", () => {
  it("keeps every asset/child node and every edge", () => {
    const r = run(noFilter());
    expect(edgeIds(r)).toEqual(["e1", "e2", "e3"]);
    expect(nodeIds(r)).toContain("asset:A");
    expect(nodeIds(r)).toContain("svc:A:myapp");
  });

  it("age filter drops edges older than the window", () => {
    const r = run(noFilter({ ageMs: 60 * 60_000 }));
    expect(edgeIds(r)).toEqual(["e1", "e2"]);
  });

  it("hideExternal drops unknown nodes and any edge touching them", () => {
    const r = run(noFilter({ hideExternal: true }));
    expect(edgeIds(r)).toEqual(["e1"]);
    expect(nodeIds(r)).not.toContain("ip:203.0.113.9");
  });

  // db01 is assetType "workstation" in the fixture.
  it("hideWorkstations drops workstation boxes, their children, and their edges", () => {
    const r = run(noFilter({ hideWorkstations: true }));
    expect(edgeIds(r)).toEqual(["e2"]);
    expect(nodeIds(r)).not.toContain("asset:B");
    expect(nodeIds(r)).not.toContain("proc:B:postgres");
    // web01 and its children survive, as does the external node e2 references.
    expect(nodeIds(r)).toContain("asset:A");
    expect(nodeIds(r)).toContain("ip:203.0.113.9");
  });

  it("hideWorkstations composes with hideExternal", () => {
    const r = run(noFilter({ hideWorkstations: true, hideExternal: true }));
    expect(edgeIds(r)).toEqual([]);
    expect(nodeIds(r)).toContain("asset:A"); // mapped parents keep rendering
  });
});

describe("applyGraphFilter — OR within a kind", () => {
  it("a proto pill keeps only edges with a matching port", () => {
    expect(edgeIds(run(noFilter({ pills: [{ kind: "proto", value: "udp" }] })))).toEqual(["e2"]);
  });

  it("two proto pills union rather than intersect", () => {
    const r = run(noFilter({ pills: [{ kind: "proto", value: "tcp" }, { kind: "proto", value: "udp" }] }));
    expect(edgeIds(r)).toEqual(["e1", "e2", "e3"]);
  });

  it("a port pill matches the port number", () => {
    expect(edgeIds(run(noFilter({ pills: [{ kind: "port", value: "5432" }] })))).toEqual(["e1"]);
  });

  it("two asset pills union", () => {
    const r = run(noFilter({ pills: [{ kind: "asset", value: "web01" }, { kind: "asset", value: "db01" }] }));
    expect(edgeIds(r)).toEqual(["e1", "e2", "e3"]);
  });
});

describe("applyGraphFilter — AND across kinds", () => {
  it("proto AND asset both have to hold", () => {
    // web01 has a tcp edge (e1) and a udp edge (e2); tcp+web01 leaves only e1.
    const r = run(noFilter({ pills: [{ kind: "proto", value: "tcp" }, { kind: "asset", value: "web01" }] }));
    expect(edgeIds(r)).toEqual(["e1"]);
  });

  it("an asset pill covers traffic flowing through its children", () => {
    // e2's endpoint is svc:A:myapp, not asset:A — the asset group is expanded to
    // its children, otherwise filtering by a hostname would find nothing.
    expect(edgeIds(run(noFilter({ pills: [{ kind: "asset", value: "web01" }] })))).toEqual(["e1", "e2"]);
  });

  it("service AND asset agree via the parent/child proxy", () => {
    const r = run(noFilter({ pills: [{ kind: "service", value: "myapp.service" }, { kind: "asset", value: "web01" }] }));
    expect(edgeIds(r)).toEqual(["e2"]);
    expect(nodeIds(r)).toContain("svc:A:myapp");
    expect(nodeIds(r)).toContain("asset:A"); // compound box renders
  });

  it("a service on the WRONG host is excluded by the asset pill", () => {
    const r = run(noFilter({ pills: [{ kind: "service", value: "myapp.service" }, { kind: "asset", value: "db01" }] }));
    expect(edgeIds(r)).toEqual([]);
    expect(nodeIds(r)).not.toContain("svc:A:myapp");
  });

  it("the three-pill case from the request: proto + host + service", () => {
    const r = run(noFilter({
      pills: [
        { kind: "proto", value: "udp" },
        { kind: "asset", value: "web01" },
        { kind: "service", value: "myapp.service" },
      ],
    }));
    expect(edgeIds(r)).toEqual(["e2"]);
  });
});

describe("applyGraphFilter — device type", () => {
  it("a type pill keeps only traffic touching assets of that type", () => {
    // web01 is a server: its edges are e1 (to db01) and e2 (to external).
    expect(edgeIds(run(noFilter({ pills: [{ kind: "type", value: "server" }] })))).toEqual(["e1", "e2"]);
  });

  it("covers traffic flowing through a matching asset's children", () => {
    // e2's endpoint is svc:A:myapp, not asset:A — the type group must expand to
    // children or filtering by device type would find almost nothing.
    const r = run(noFilter({ pills: [{ kind: "type", value: "workstation" }] }));
    expect(edgeIds(r)).toEqual(["e1", "e3"]);
    expect(nodeIds(r)).toContain("proc:B:postgres");
  });

  it("two type pills union", () => {
    const r = run(noFilter({ pills: [{ kind: "type", value: "server" }, { kind: "type", value: "workstation" }] }));
    expect(edgeIds(r)).toEqual(["e1", "e2", "e3"]);
  });

  it("ANDs across kinds like any other pill", () => {
    const r = run(noFilter({ pills: [{ kind: "type", value: "server" }, { kind: "proto", value: "udp" }] }));
    expect(edgeIds(r)).toEqual(["e2"]);
  });

  it("a type nothing matches yields an empty graph", () => {
    expect(edgeIds(run(noFilter({ pills: [{ kind: "type", value: "firewall" }] })))).toEqual([]);
  });

  it("does NOT leak into free-text matching", () => {
    // A bare "server" as free text would otherwise match most of the fleet and
    // read as a broken filter.
    expect(edgeIds(run(noFilter({ pills: [{ kind: "text", value: "server" }] })))).toEqual([]);
  });
});

describe("applyGraphFilter — asset tags", () => {
  // web01 is tagged prod + web-tier; db01 production + db. `prod` must not
  // select db01: tags are labels, not search fragments.
  const tagged = () => {
    const { nodes, edges } = fixture();
    nodes.find((n) => n.id === "asset:A")!.tags = ["prod", "web-tier"];
    nodes.find((n) => n.id === "asset:B")!.tags = ["production", "db"];
    return { nodes, edges };
  };
  const runTagged = (f: Filter) => { const { nodes, edges } = tagged(); return applyGraphFilter(nodes, edges, f, NOW); };

  it("a tag pill keeps only traffic touching assets carrying that tag, through their children", () => {
    // web01's edges: e1 (nginx → postgres) and e2 (myapp.service → external) —
    // e2's endpoint is the service child, so the tag must expand to children.
    const r = runTagged(noFilter({ pills: [{ kind: "tag", value: "web-tier" }] }));
    expect(edgeIds(r)).toEqual(["e1", "e2"]);
    expect(nodeIds(r)).toContain("svc:A:myapp");
  });

  it("matches the whole tag, not a fragment of one", () => {
    // `prod` is web01's tag; db01's `production` merely contains it.
    expect(edgeIds(runTagged(noFilter({ pills: [{ kind: "tag", value: "prod" }] })))).toEqual(["e1", "e2"]);
    expect(edgeIds(runTagged(noFilter({ pills: [{ kind: "tag", value: "produc" }] })))).toEqual([]);
  });

  it("ignores case", () => {
    expect(edgeIds(runTagged(noFilter({ pills: [{ kind: "tag", value: "DB" }] })))).toEqual(["e1", "e3"]);
  });

  it("two tag pills union, and a tag ANDs with other kinds", () => {
    expect(edgeIds(runTagged(noFilter({ pills: [{ kind: "tag", value: "prod" }, { kind: "tag", value: "db" }] }))))
      .toEqual(["e1", "e2", "e3"]);
    expect(edgeIds(runTagged(noFilter({ pills: [{ kind: "tag", value: "db" }, { kind: "proto", value: "tcp" }, { kind: "port", value: "80" }] }))))
      .toEqual(["e3"]);
  });

  it("an untagged map matches nothing, and tags stay out of free text", () => {
    expect(edgeIds(run(noFilter({ pills: [{ kind: "tag", value: "prod" }] })))).toEqual([]);
    expect(edgeIds(runTagged(noFilter({ pills: [{ kind: "text", value: "web-tier" }] })))).toEqual([]);
  });

  it("offers each tag once in the suggestions", () => {
    const { nodes, edges } = tagged();
    nodes.find((n) => n.id === "asset:B")!.tags = ["production", "db", "prod"];
    const tags = buildFilterCatalog(nodes, edges).filter((c) => c.kind === "tag").map((c) => c.value).sort();
    expect(tags).toEqual(["db", "prod", "production", "web-tier"]);
    expect(rankSuggestions(buildFilterCatalog(nodes, edges), "web-t")[0]).toEqual({ kind: "tag", value: "web-tier" });
  });
});

describe("applyGraphFilter — narrowing and visibility", () => {
  it("an active scope drops unrelated asset boxes (it narrows, not just centers)", () => {
    const r = run(noFilter({ pills: [{ kind: "service", value: "myapp.service" }] }));
    expect(nodeIds(r)).not.toContain("proc:B:postgres");
  });

  it("a scoped node with no surviving edges still renders", () => {
    // nginx listens on 443 but has no tcp/443 edge in the fixture.
    const r = run(noFilter({ pills: [{ kind: "process", value: "nginx" }, { kind: "port", value: "443" }] }));
    expect(edgeIds(r)).toEqual([]);
    expect(nodeIds(r)).toContain("proc:A:nginx");
    expect(nodeIds(r)).toContain("asset:A");
  });

  it("never emits a child whose parent is absent, or an edge with a missing endpoint", () => {
    // Dangling refs make cytoscape-dagre throw and kill the whole render.
    const orphan: Node[] = [
      { id: "proc:GONE:x", kind: "process", parent: "asset:GONE", assetId: "GONE", processName: "x" },
    ];
    const { nodes, edges } = fixture();
    const r = applyGraphFilter(
      nodes.concat(orphan),
      edges.concat([{ id: "e9", source: "proc:GONE:x", target: "ip:198.51.100.7", kind: "external", ports: [], lastSeen: iso(1) }]),
      noFilter(),
      NOW,
    );
    const ids = nodeIds(r);
    expect(ids).not.toContain("proc:GONE:x");
    expect(edgeIds(r)).not.toContain("e9");
    r.edges.forEach((x) => {
      expect(ids).toContain(x.edge.source);
      expect(ids).toContain(x.edge.target);
    });
  });

  it("a genuinely port-less edge survives a proto pill", () => {
    // Port-less edges carry no proto to contradict the filter; dropping them
    // would silently hide asset-level connectivity.
    const { nodes } = fixture();
    const r = applyGraphFilter(
      nodes,
      [{ id: "e0", source: "asset:A", target: "asset:B", kind: "asset", ports: [], lastSeen: iso(1) }],
      noFilter({ pills: [{ kind: "proto", value: "tcp" }] }),
      NOW,
    );
    expect(edgeIds(r)).toEqual(["e0"]);
  });

  it("a free-text pill matches across node kinds", () => {
    expect(edgeIds(run(noFilter({ pills: [{ kind: "text", value: "postgres" }] })))).toEqual(["e1", "e3"]);
  });
});

describe("buildFilterCatalog / rankSuggestions", () => {
  it("offers every filterable dimension exactly once", () => {
    const { nodes, edges } = fixture();
    const cat = buildFilterCatalog(nodes, edges);
    const of = (k: string) => cat.filter((c) => c.kind === k).map((c) => c.value);
    expect(of("proto").sort()).toEqual(["tcp", "udp"]);
    expect(of("asset").sort()).toEqual(["db01", "web01"]);
    expect(of("type").sort()).toEqual(["server", "workstation"]);
    expect(of("process").sort()).toEqual(["nginx", "postgres"]);
    expect(of("service")).toEqual(["myapp.service"]);
    expect(of("external")).toEqual(["203.0.113.9"]);
    // Ports come from edge ports AND node listenPorts.
    expect(of("port")).toEqual(["80", "443", "514", "5432", "8080"]);
    expect(cat.length).toBe(new Set(cat.map((c) => c.kind + " " + c.value)).size);
  });

  it("typing \"tc\" surfaces tcp first", () => {
    const { nodes, edges } = fixture();
    const hits = rankSuggestions(buildFilterCatalog(nodes, edges), "tc");
    expect(hits[0]).toEqual({ kind: "proto", value: "tcp" });
  });

  it("prefix matches outrank interior matches", () => {
    const cat: Pill[] = [
      { kind: "asset", value: "prod-web01" },
      { kind: "asset", value: "web01" },
    ];
    expect(rankSuggestions(cat, "web")[0].value).toBe("web01");
  });

  it("an empty query lists the catalog, and a miss lists nothing", () => {
    const { nodes, edges } = fixture();
    const cat = buildFilterCatalog(nodes, edges);
    expect(rankSuggestions(cat, "").length).toBe(cat.length);
    expect(rankSuggestions(cat, "zzzzz")).toEqual([]);
  });
});

describe("consolidatePorts", () => {
  const P = (proto: string, ports: number[]) => ports.map((port) => ({ proto, port }));
  const labels = (rows: Array<{ label: string }>) => rows.map((r) => r.label);

  it("collapses a run of three or more into a range", () => {
    // The real case: Oracle GoldenGate holding tcp/9000-9004 was five near-identical
    // rows that buried the shape of the allocation.
    expect(labels(consolidatePorts(P("tcp", [9000, 9001, 9002, 9003, 9004]))))
      .toEqual(["tcp/9000-9004"]);
  });

  it("leaves a PAIR listed separately — '9000, 9001' beats '9000-9001'", () => {
    expect(labels(consolidatePorts(P("tcp", [9000, 9001])))).toEqual(["tcp/9000", "tcp/9001"]);
  });

  it("leaves an isolated port alone", () => {
    expect(labels(consolidatePorts(P("udp", [1901])))).toEqual(["udp/1901"]);
  });

  it("emits several ranges and singletons in port order", () => {
    expect(labels(consolidatePorts(P("tcp", [9000, 9001, 9002, 9003, 9004, 9011, 9012, 9013, 9014]))))
      .toEqual(["tcp/9000-9004", "tcp/9011-9014"]);
  });

  it("never merges across protocols", () => {
    const rows = consolidatePorts([...P("tcp", [80, 81, 82]), ...P("udp", [83, 84, 85])]);
    expect(labels(rows)).toEqual(["tcp/80-82", "udp/83-85"]);
  });

  it("sorts numerically, not lexically, and dedups repeated ports", () => {
    // A service bound on several addresses reports the same port twice; unsorted
    // input must not fragment a contiguous block.
    expect(labels(consolidatePorts(P("tcp", [9002, 9000, 9001, 9002, 9003]))))
      .toEqual(["tcp/9000-9003"]);
  });

  it("reports the range width so the UI can show how many ports it covers", () => {
    const [row] = consolidatePorts(P("tcp", [100, 101, 102, 103]));
    expect(row).toMatchObject({ proto: "tcp", from: 100, to: 103, count: 4 });
  });

  it("is empty for empty / missing input and skips unusable entries", () => {
    expect(consolidatePorts([])).toEqual([]);
    expect(consolidatePorts(undefined as never)).toEqual([]);
    expect(consolidatePorts([{ proto: "tcp", port: NaN }])).toEqual([]);
  });
});

describe("edgePortKey", () => {
  it("picks the most-seen port, ties to the lower port number", () => {
    expect(edgePortKey([{ proto: "tcp", port: 8443, count: 2 }, { proto: "tcp", port: 443, count: 9 }])).toBe("tcp/443");
    expect(edgePortKey([{ proto: "udp", port: 161, count: 3 }, { proto: "udp", port: 53, count: 3 }])).toBe("udp/53");
  });

  it("keys protocol and port together and tolerates a missing proto/count", () => {
    expect(edgePortKey([{ proto: "UDP", port: 53 }])).toBe("udp/53");
    expect(edgePortKey([{ port: 22 } as Port])).toBe("tcp/22");
  });

  it("returns null for a port-less edge", () => {
    expect(edgePortKey([])).toBeNull();
    expect(edgePortKey(undefined as never)).toBeNull();
  });
});

describe("assignPortColors", () => {
  const PAL = ["#a", "#b", "#c"];

  it("colours the most common keys, in rank order, and counts the rest as Other", () => {
    const keys = ["tcp/443", "tcp/443", "tcp/443", "tcp/22", "tcp/22", "udp/53", "tcp/3389", null];
    const r = assignPortColors(keys, {}, PAL);
    expect(r.legend).toEqual([
      { key: "tcp/443", color: "#a", count: 3 },
      { key: "tcp/22", color: "#b", count: 2 },
      { key: "udp/53", color: "#c", count: 1 },
    ]);
    expect(r.colors["tcp/3389"]).toBeUndefined();
    expect(r.otherCount).toBe(1);
  });

  it("keeps a port's previous colour and gives newcomers the free ones", () => {
    const r = assignPortColors(["tcp/443", "tcp/22", "tcp/22"], { "tcp/443": "#c", "tcp/1433": "#a" }, PAL);
    expect(r.colors).toEqual({ "tcp/22": "#a", "tcp/443": "#c" });
  });

  it("never hands one colour to two keys, even from a corrupt previous map", () => {
    const r = assignPortColors(["tcp/443", "tcp/22"], { "tcp/443": "#a", "tcp/22": "#a" }, PAL);
    expect(new Set(Object.values(r.colors)).size).toBe(2);
  });

  it("ignores a stale colour that is not in the palette", () => {
    const r = assignPortColors(["tcp/443"], { "tcp/443": "#zzz" }, PAL);
    expect(r.colors["tcp/443"]).toBe("#a");
  });

  it("ships a palette of distinct colours with no red and no grey", () => {
    expect(new Set(PORT_PALETTE).size).toBe(PORT_PALETTE.length);
    for (const hex of PORT_PALETTE) {
      const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
      const max = Math.max(r, g, b), min = Math.min(r, g, b);
      expect(max - min, `${hex} is too grey`).toBeGreaterThan(60);
      const isRed = r === max && r - Math.max(g, b) > 90 && Math.abs(g - b) < 40;
      expect(isRed, `${hex} reads as red`).toBe(false);
    }
  });
});

describe("applyGraphFilter — excludeEdges (Ports key switched a row off)", () => {
  it("drops the edge and prunes an external node it alone referenced", () => {
    const r = run(noFilter({ excludeEdges: { e2: true, e3: true } }));
    expect(edgeIds(r)).toEqual(["e1"]);
    expect(nodeIds(r)).not.toContain("ip:203.0.113.9");
    // Mapped asset boxes stay, exactly as they do for any filtered-out edge.
    expect(nodeIds(r)).toContain("svc:A:myapp");
  });
});

describe("buildPortLegend", () => {
  const PAL = ["#a", "#b"];
  const keys = ["tcp/443", "tcp/443", "tcp/443", "tcp/22", "tcp/22", "udp/53", "tcp/3389", null];

  it("marks hidden rows without moving colours or counts", () => {
    const shown = buildPortLegend(keys, {}, [], PAL);
    const hidden = buildPortLegend(keys, {}, ["tcp/443"], PAL);
    expect(hidden.colors).toEqual(shown.colors);
    expect(hidden.rows.map((r) => [r.key, r.count, r.hidden])).toEqual([
      ["tcp/443", 3, true],
      ["tcp/22", 2, false],
    ]);
    expect(hidden.other).toEqual({ count: 2, hidden: false });
  });

  it("gives a hidden port outside the coloured set its own row, out of Other", () => {
    const l = buildPortLegend(keys, {}, ["udp/53"], PAL);
    expect(l.rows[2]).toEqual({ key: "udp/53", color: null, count: 1, hidden: true });
    expect(l.other.count).toBe(1);
  });

  it("ignores a hidden port that is not in view, and flags a hidden Other", () => {
    const l = buildPortLegend(keys, {}, ["tcp/9999", "other"], PAL);
    expect(l.rows.map((r) => r.key)).toEqual(["tcp/443", "tcp/22"]);
    expect(l.other).toEqual({ count: 2, hidden: true });
  });
});

describe("portHiddenEdges", () => {
  const E = (id: string, port: number, proto = "tcp") =>
    ({ edge: { id, source: "a", target: "b", kind: "process", ports: [{ proto, port, count: 1 }], lastSeen: iso(1) }, ports: [{ proto, port, count: 1 }] });
  const edges = [E("x1", 443), E("x2", 443), E("x3", 22), E("x4", 53, "udp"), E("x5", 3389)];
  const keys = ["tcp/443", "tcp/443", "tcp/22", "udp/53", "tcp/3389"];

  it("returns the edges of a hidden coloured row", () => {
    const l = buildPortLegend(keys, {}, ["tcp/443"], ["#a", "#b"]);
    expect(portHiddenEdges(edges, l)).toEqual({ x1: true, x2: true });
  });

  it("hiding Other removes the uncoloured tail but not an explicitly listed port", () => {
    const l = buildPortLegend(keys, {}, ["other"], ["#a", "#b"]);
    expect(portHiddenEdges(edges, l)).toEqual({ x4: true, x5: true });
  });

  it("never hides a port-less edge", () => {
    const bare = { edge: { id: "z", source: "a", target: "b", kind: "asset", ports: [], lastSeen: iso(1) }, ports: [] };
    const l = buildPortLegend([null], {}, ["other"], ["#a"]);
    expect(portHiddenEdges([bare], l)).toEqual({});
  });
});

describe("cleanHiddenPorts", () => {
  it("keeps proto/port keys and Other, dropping junk and duplicates", () => {
    expect(cleanHiddenPorts(["tcp/443", "other", "tcp/443", "", 5, "443", "tcp/abc", "tcp/1234567"]))
      .toEqual(["tcp/443", "other"]);
  });

  it("treats a missing list (a filter saved before ports could be hidden) as none", () => {
    expect(cleanHiddenPorts(undefined)).toEqual([]);
    expect(cleanHiddenPorts("tcp/443")).toEqual([]);
  });
});
