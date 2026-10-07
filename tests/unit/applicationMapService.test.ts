/**
 * tests/unit/applicationMapService.test.ts
 *
 * Coverage for the PURE Application Map graph core (buildGraphFromRows):
 *   - process-level edge resolution (dest asset has a mapped listener on the
 *     port) vs asset-level fallback vs unknown-ip
 *   - compound node structure (asset parents, process children, deterministic
 *     ids), resolved-target assets materialized without children
 *   - inbound/outbound double-observation dedup (outbound wins)
 *   - same-process self-loop dropped; intra-asset proc→proc kept
 *   - noise-IP filtering (loopback / link-local / multicast / unspecified)
 *   - per-(source,target) edge merge with port breakdown + overflow
 *   - unknown-IP /24 grouping + hard cap + overflow node
 *   - stats
 *
 * Prisma never loads — the module is imported for its pure exports only, with
 * db mocked out.
 */

import { describe, it, expect, vi } from "vitest";

vi.mock("../../src/db.js", () => ({ prisma: {} }));

import {
  buildGraphFromRows,
  processNodeId,
  serviceNodeId,
  assetNodeId,
  isNoiseIp,
  isPublicIp,
  subnetKeyOf,
  pickHistoryHolder,
  resolvePtrNames,
  clearPtrCacheForTests,
  type MappedAssetLite,
  type ProcessConnectionRow,
  type ResolvedAssetLite,
  type IpNameHint,
  type IpHistoryCandidate,
} from "../../src/services/applicationMapService.js";

const T0 = new Date("2026-07-20T00:00:00Z");
const T1 = new Date("2026-07-21T00:00:00Z");

function asset(id: string, ip: string, mapped: string[], over: Partial<MappedAssetLite> = {}): MappedAssetLite {
  return {
    id, hostname: `${id}-host`, ipAddress: ip, assetType: "server",
    monitorStatus: "up", manufacturer: null, model: null,
    mappedProcesses: mapped, mappedServices: [],
    ...over,
  };
}

function row(assetId: string, processName: string, kind: string, proto: string, over: Partial<ProcessConnectionRow> = {}): ProcessConnectionRow {
  return {
    assetId, processName, unit: null, kind, proto,
    localAddr: "", localPort: 0, remoteIp: "", remotePort: 0,
    firstSeen: T0, lastSeen: T1,
    ...over,
  };
}

function ipMapOf(...assets: MappedAssetLite[]): Map<string, ResolvedAssetLite> {
  const m = new Map<string, ResolvedAssetLite>();
  for (const a of assets) {
    if (a.ipAddress) m.set(a.ipAddress, a);
  }
  return m;
}

describe("buildGraphFromRows", () => {
  const web = asset("A", "10.0.0.1", ["nginx"]);
  const db  = asset("B", "10.0.0.5", ["postgres"]);

  it("resolves process→process when the destination has a mapped listener on that port", () => {
    const rows = [
      row("A", "nginx", "listen", "tcp", { localAddr: "0.0.0.0", localPort: 443 }),
      row("A", "nginx", "outbound", "tcp", { remoteIp: "10.0.0.5", remotePort: 5432 }),
      row("B", "postgres", "listen", "tcp", { localAddr: "0.0.0.0", localPort: 5432 }),
    ];
    const g = buildGraphFromRows([web, db], rows, ipMapOf(web, db));
    const e = g.edges.find((x) => x.kind === "process")!;
    expect(e.source).toBe(processNodeId("A", "nginx"));
    expect(e.target).toBe(processNodeId("B", "postgres"));
    expect(e.ports).toEqual([{ proto: "tcp", port: 5432, count: 1, firstSeen: T0.toISOString(), lastSeen: T1.toISOString(), ips: ["10.0.0.5"] }]);
    // Compound structure: process children carry parent = asset node.
    const procA = g.nodes.find((n) => n.id === processNodeId("A", "nginx"))!;
    expect(procA.parent).toBe(assetNodeId("A"));
    expect(procA.listenPorts).toEqual([{ proto: "tcp", port: 443 }]);
  });

  it("falls back to asset-level when the destination asset has no mapped listener on the port", () => {
    const fileSrv = asset("C", "10.0.0.9", []); // resolved target, nothing mapped
    const rows = [
      row("A", "nginx", "outbound", "tcp", { remoteIp: "10.0.0.9", remotePort: 445 }),
    ];
    const g = buildGraphFromRows([web], rows, ipMapOf(web, fileSrv));
    const e = g.edges[0];
    expect(e.kind).toBe("asset");
    expect(e.target).toBe(assetNodeId("C"));
    const cNode = g.nodes.find((n) => n.id === assetNodeId("C"))!;
    expect(cNode.hasMappedProcesses).toBe(false);
  });

  it("renders unresolved destinations as unknown-ip nodes", () => {
    const rows = [row("A", "nginx", "outbound", "tcp", { remoteIp: "8.8.8.8", remotePort: 53 })];
    const g = buildGraphFromRows([web], rows, ipMapOf(web));
    expect(g.edges[0].kind).toBe("external");
    expect(g.edges[0].target).toBe("ip:8.8.8.8");
    expect(g.nodes.find((n) => n.id === "ip:8.8.8.8")?.kind).toBe("unknown-ip");
  });

  // Polaris is the IP registry, so an unresolved internal endpoint is often
  // already named there even with no Asset record. The hint is LABEL-ONLY: it must
  // not turn the grey node into an asset node, because there's nothing to open.
  it("labels an unknown-ip from an IPAM name hint without making it an asset", () => {
    const rows = [row("A", "nginx", "outbound", "tcp", { remoteIp: "172.25.87.17", remotePort: 443 })];
    const hints = new Map<string, IpNameHint>([
      ["172.25.87.17", { hostname: "scale-plc-01", source: "reservation" }],
    ]);
    const g = buildGraphFromRows([web], rows, ipMapOf(web), hints);
    const n = g.nodes.find((x) => x.id === "ip:172.25.87.17")!;
    expect(n.kind).toBe("unknown-ip");
    expect(n.ipHostname).toBe("scale-plc-01");
    expect(n.ipNameSource).toBe("reservation");
    expect(n.assetId).toBeUndefined();
    expect(g.edges[0].kind).toBe("external");
  });

  it("leaves ipHostname null when the registry has no name for the IP", () => {
    const rows = [row("A", "nginx", "outbound", "tcp", { remoteIp: "8.8.8.8", remotePort: 53 })];
    const g = buildGraphFromRows([web], rows, ipMapOf(web), new Map());
    expect(g.nodes.find((x) => x.id === "ip:8.8.8.8")!.ipHostname).toBeNull();
  });

  it("omitting the hints map entirely is safe (back-compat)", () => {
    const rows = [row("A", "nginx", "outbound", "tcp", { remoteIp: "8.8.8.8", remotePort: 53 })];
    const g = buildGraphFromRows([web], rows, ipMapOf(web));
    expect(g.nodes.find((x) => x.id === "ip:8.8.8.8")!.ipHostname).toBeNull();
  });

  it("dedups a connection observed from both ends (outbound wins)", () => {
    const rows = [
      row("A", "nginx", "outbound", "tcp", { remoteIp: "10.0.0.5", remotePort: 5432 }),
      row("B", "postgres", "listen", "tcp", { localPort: 5432 }),
      // B saw A's connection arrive on its listening port:
      row("B", "postgres", "inbound", "tcp", { remoteIp: "10.0.0.1", localPort: 5432 }),
    ];
    const g = buildGraphFromRows([web, db], rows, ipMapOf(web, db));
    // ONE logical edge — the inbound observation must not add asset:A → proc:B.
    expect(g.edges).toHaveLength(1);
    expect(g.edges[0].kind).toBe("process");
  });

  it("keeps the inbound-derived edge when the source end wasn't observed", () => {
    const rows = [
      row("B", "postgres", "listen", "tcp", { localPort: 5432 }),
      row("B", "postgres", "inbound", "tcp", { remoteIp: "10.0.0.1", localPort: 5432 }),
    ];
    // A is known by IP but has no outbound observation (e.g. not yet scraped).
    const g = buildGraphFromRows([web, db], rows, ipMapOf(web, db));
    const e = g.edges[0];
    expect(e.kind).toBe("asset");
    expect(e.source).toBe(assetNodeId("A"));
    expect(e.target).toBe(processNodeId("B", "postgres"));
    expect(e.ports[0].port).toBe(5432);
  });

  it("renders unresolved inbound peers as ip → process edges", () => {
    const rows = [
      row("B", "postgres", "listen", "tcp", { localPort: 5432 }),
      row("B", "postgres", "inbound", "tcp", { remoteIp: "192.168.77.4", localPort: 5432 }),
    ];
    const g = buildGraphFromRows([db], rows, ipMapOf(db));
    const e = g.edges[0];
    expect(e.kind).toBe("external-inbound");
    expect(e.source).toBe("ip:192.168.77.4");
  });

  it("drops same-process self-loops but keeps intra-asset proc→proc edges", () => {
    const box = asset("D", "10.0.0.7", ["app", "redis"]);
    const rows = [
      row("D", "redis", "listen", "tcp", { localPort: 6379 }),
      row("D", "app", "outbound", "tcp", { remoteIp: "10.0.0.7", remotePort: 6379 }),  // app → redis, same box: keep
      row("D", "redis", "listen", "tcp", { localPort: 16379 }),
      row("D", "redis", "outbound", "tcp", { remoteIp: "10.0.0.7", remotePort: 16379 }), // redis → itself: drop
    ];
    const g = buildGraphFromRows([box], rows, ipMapOf(box));
    expect(g.edges).toHaveLength(1);
    expect(g.edges[0].source).toBe(processNodeId("D", "app"));
    expect(g.edges[0].target).toBe(processNodeId("D", "redis"));
  });

  it("filters noise IPs and ignores rows for unmapped processes", () => {
    const rows = [
      row("A", "nginx", "outbound", "tcp", { remoteIp: "127.0.0.1", remotePort: 80 }),
      row("A", "nginx", "outbound", "tcp", { remoteIp: "169.254.1.1", remotePort: 80 }),
      row("A", "nginx", "outbound", "udp", { remoteIp: "224.0.0.251", remotePort: 5353 }),
      row("A", "nginx", "outbound", "tcp", { remoteIp: "0.0.0.0", remotePort: 1 }),
      row("A", "not-mapped", "outbound", "tcp", { remoteIp: "8.8.4.4", remotePort: 53 }),
    ];
    const g = buildGraphFromRows([web], rows, ipMapOf(web));
    expect(g.edges).toHaveLength(0);
    expect(g.nodes.filter((n) => n.kind.startsWith("unknown"))).toHaveLength(0);
  });

  it("merges multi-port pairs into one edge with a capped port breakdown", () => {
    const rows = Array.from({ length: 20 }, (_, i) =>
      row("A", "nginx", "outbound", "tcp", { remoteIp: "10.0.0.5", remotePort: 8000 + i }));
    const g = buildGraphFromRows([web, db], rows, ipMapOf(web, db));
    expect(g.edges).toHaveLength(1);
    expect(g.edges[0].ports).toHaveLength(16);
    expect(g.edges[0].portOverflow).toBe(4);
  });

  it("groups >5 unknown IPs per /24 and caps the unknown-node count", () => {
    // 8 unknowns in one /24 → one group node; 2 in another /24 → plain nodes.
    const rows = [
      ...Array.from({ length: 8 }, (_, i) =>
        row("A", "nginx", "outbound", "tcp", { remoteIp: `203.0.113.${10 + i}`, remotePort: 443 })),
      row("A", "nginx", "outbound", "tcp", { remoteIp: "198.51.100.7", remotePort: 443 }),
      row("A", "nginx", "outbound", "tcp", { remoteIp: "198.51.100.8", remotePort: 443 }),
    ];
    const g = buildGraphFromRows([web], rows, ipMapOf(web));
    const group = g.nodes.find((n) => n.kind === "unknown-ip-group")!;
    expect(group.cidr).toBe("203.0.113.0/24");
    expect(group.ips).toHaveLength(8);
    expect(g.nodes.filter((n) => n.kind === "unknown-ip")).toHaveLength(2);
    // All 8 members' edges re-point at the group node and merge into one edge.
    const groupEdges = g.edges.filter((e) => e.target === group.id);
    expect(groupEdges).toHaveLength(1);
    expect(groupEdges[0].ports[0].count).toBe(8);
    expect(g.stats.unknownIpCount).toBe(3); // group + 2 plain
    expect(g.stats.truncated.unknownIps).toBe(0);
  });

  it("collapses unknowns past the 100-node cap into one overflow node", () => {
    // 130 unknowns in 130 distinct /24s (one per subnet, so no grouping) →
    // 100 kept + one overflow node absorbing the other 30.
    const rows = Array.from({ length: 130 }, (_, i) =>
      row("A", "nginx", "outbound", "tcp", { remoteIp: `198.18.${i}.9`, remotePort: 443 }));
    const g = buildGraphFromRows([web], rows, ipMapOf(web));
    expect(g.nodes.filter((n) => n.kind === "unknown-ip")).toHaveLength(100);
    const overflow = g.nodes.find((n) => n.kind === "unknown-overflow")!;
    expect(overflow.overflowCount).toBe(30);
    expect(g.stats.truncated.unknownIps).toBe(30);
    // Edges to dropped IPs re-point at the overflow node.
    expect(g.edges.some((e) => e.target === "ip:overflow")).toBe(true);
  });

  it("reports stats", () => {
    const rows = [
      row("A", "nginx", "listen", "tcp", { localPort: 443 }),
      row("A", "nginx", "outbound", "tcp", { remoteIp: "10.0.0.5", remotePort: 5432 }),
      row("B", "postgres", "listen", "tcp", { localPort: 5432 }),
    ];
    const g = buildGraphFromRows([web, db], rows, ipMapOf(web, db));
    expect(g.stats).toMatchObject({ assetCount: 2, processCount: 2, serviceCount: 0, edgeCount: 1, unknownIpCount: 0 });
  });
});

describe("buildGraphFromRows — asset tags (the App Map's tag filter)", () => {
  it("carries Asset.tags on mapped and edge-target asset nodes, and omits the field when there are none", () => {
    const a = asset("A", "10.0.0.1", ["nginx"], { tags: ["prod", "web-tier"] });
    const b = asset("B", "10.0.0.2", ["postgres"]);
    const target: ResolvedAssetLite = {
      id: "C", hostname: "C-host", ipAddress: "10.0.0.3", assetType: "server",
      monitorStatus: "up", manufacturer: null, model: null, tags: ["db"],
    };
    const g = buildGraphFromRows(
      [a, b],
      [row("A", "nginx", "outbound", "tcp", { remoteIp: "10.0.0.3", remotePort: 5432 })],
      new Map([["10.0.0.3", target]]),
    );
    const node = (id: string) => g.nodes.find((n) => n.id === assetNodeId(id))!;
    expect(node("A").tags).toEqual(["prod", "web-tier"]);
    expect(node("C").tags).toEqual(["db"]);
    expect("tags" in node("B")).toBe(false);
    // Tags are asset-level: process children carry none.
    expect(g.nodes.find((n) => n.id === processNodeId("A", "nginx"))!.tags).toBeUndefined();
  });
});

describe("buildGraphFromRows — mapped services (Asset.mappedServices / unit)", () => {
  it("emits a service child node even when the service has zero connections", () => {
    const box = asset("S", "10.0.1.1", [], { mappedServices: ["nginx.service"] });
    const g = buildGraphFromRows([box], [], ipMapOf(box));
    const svc = g.nodes.find((n) => n.id === serviceNodeId("S", "nginx.service"))!;
    expect(svc.kind).toBe("service");
    expect(svc.parent).toBe(assetNodeId("S"));
    expect(svc.serviceUnit).toBe("nginx.service");
    expect(g.stats.serviceCount).toBe(1);
    // The owning asset renders (it's part of the operator's selection).
    expect(g.nodes.find((n) => n.id === assetNodeId("S"))?.hasMappedProcesses).toBe(true);
  });

  it("attributes a connection to a service node by its owning unit", () => {
    const app = asset("A", "10.0.1.2", [], { mappedServices: ["myapp.service"] });
    const rows = [
      // Backing process is `java`, NOT mapped as a process — only the unit is.
      row("A", "java", "outbound", "tcp", { unit: "myapp.service", remoteIp: "8.8.8.8", remotePort: 443 }),
    ];
    const g = buildGraphFromRows([app], rows, ipMapOf(app));
    const e = g.edges[0];
    expect(e.kind).toBe("external");
    expect(e.source).toBe(serviceNodeId("A", "myapp.service"));
    expect(e.target).toBe("ip:8.8.8.8");
  });

  it("resolves process→service when the destination unit listens on the port", () => {
    const web = asset("A", "10.0.1.3", ["curl"]);
    const dbSvc = asset("B", "10.0.1.4", [], { mappedServices: ["postgresql.service"] });
    const rows = [
      row("A", "curl", "outbound", "tcp", { remoteIp: "10.0.1.4", remotePort: 5432 }),
      row("B", "postgres", "listen", "tcp", { unit: "postgresql.service", localPort: 5432 }),
    ];
    const g = buildGraphFromRows([web, dbSvc], rows, ipMapOf(web, dbSvc));
    const e = g.edges.find((x) => x.kind === "process")!;
    expect(e.source).toBe(processNodeId("A", "curl"));
    expect(e.target).toBe(serviceNodeId("B", "postgresql.service"));
    const svc = g.nodes.find((n) => n.id === serviceNodeId("B", "postgresql.service"))!;
    expect(svc.listenPorts).toEqual([{ proto: "tcp", port: 5432 }]);
  });

  it("attributes a row to BOTH a process and a service when both are mapped", () => {
    const box = asset("A", "10.0.1.5", ["java"], { mappedServices: ["myapp.service"] });
    const rows = [
      row("A", "java", "outbound", "tcp", { unit: "myapp.service", remoteIp: "9.9.9.9", remotePort: 443 }),
    ];
    const g = buildGraphFromRows([box], rows, ipMapOf(box));
    // One edge from the process node, one from the service node — same peer.
    expect(g.edges).toHaveLength(2);
    const sources = g.edges.map((e) => e.source).sort();
    expect(sources).toEqual([processNodeId("A", "java"), serviceNodeId("A", "myapp.service")].sort());
  });
});

describe("buildGraphFromRows — per-port observed IPs", () => {
  const web = asset("A", "10.0.0.1", ["nginx"]);
  const db  = asset("B", "10.0.0.5", ["postgres"]);

  it("records the dialed remote IP on outbound-derived edges", () => {
    const rows = [
      row("A", "nginx", "outbound", "tcp", { remoteIp: "10.0.0.5", remotePort: 5432 }),
      row("B", "postgres", "listen", "tcp", { localPort: 5432 }),
    ];
    const g = buildGraphFromRows([web, db], rows, ipMapOf(web, db));
    expect(g.edges[0].ports[0].ips).toEqual(["10.0.0.5"]);
  });

  it("records the landing local address on inbound-derived edges, skipping wildcard binds", () => {
    const rows = [
      row("B", "postgres", "listen", "tcp", { localPort: 5432 }),
      row("B", "postgres", "inbound", "tcp", { remoteIp: "10.0.0.1", localPort: 5432, localAddr: "10.0.0.5" }),
      row("B", "postgres", "inbound", "tcp", { remoteIp: "192.168.77.4", localPort: 5432, localAddr: "0.0.0.0" }),
    ];
    const g = buildGraphFromRows([web, db], rows, ipMapOf(web, db));
    const fromA = g.edges.find((e) => e.source === assetNodeId("A"))!;
    expect(fromA.ports[0].ips).toEqual(["10.0.0.5"]);
    const fromUnknown = g.edges.find((e) => e.source === "ip:192.168.77.4")!;
    expect(fromUnknown.ports[0].ips).toEqual([]);
  });

  it("dedups and caps observed IPs per port across merged rows", () => {
    // Same (source, target, port) seen against many distinct remote IPs — the
    // multi-homed-destination case. Cap is 6.
    const multi = asset("C", "10.0.0.9", []);
    const ipMap = ipMapOf(web);
    for (let i = 1; i <= 9; i++) ipMap.set(`10.9.9.${i}`, multi);
    const rows = Array.from({ length: 9 }, (_, i) =>
      row("A", "nginx", "outbound", "tcp", { remoteIp: `10.9.9.${i + 1}`, remotePort: 445 }));
    rows.push(row("A", "nginx", "outbound", "tcp", { remoteIp: "10.9.9.1", remotePort: 445 })); // dup
    const g = buildGraphFromRows([web], rows, ipMap);
    expect(g.edges).toHaveLength(1);
    expect(g.edges[0].ports[0].ips).toHaveLength(6);
    expect(new Set(g.edges[0].ports[0].ips).size).toBe(6);
  });

  it("keeps the observed IP on intra-asset service→service edges", () => {
    const box = asset("D", "10.0.0.7", ["app", "redis"]);
    const rows = [
      row("D", "redis", "listen", "tcp", { localPort: 6379 }),
      row("D", "app", "outbound", "tcp", { remoteIp: "10.0.0.7", remotePort: 6379 }),
    ];
    const g = buildGraphFromRows([box], rows, ipMapOf(box));
    expect(g.edges[0].ports[0].ips).toEqual(["10.0.0.7"]);
  });
});

describe("pickHistoryHolder", () => {
  const d = (s: string) => new Date(s);
  const cand = (assetId: string, from: string, to: string): IpHistoryCandidate =>
    ({ assetId, firstSeen: d(from), lastSeen: d(to) });

  it("returns null for no candidates", () => {
    expect(pickHistoryHolder([], Date.now())).toBeNull();
  });

  it("prefers the row whose interval covers the observation time", () => {
    const rows = [
      cand("old", "2026-01-01T00:00:00Z", "2026-03-01T00:00:00Z"),
      cand("cur", "2026-03-02T00:00:00Z", "2026-08-01T00:00:00Z"),
    ];
    expect(pickHistoryHolder(rows, Date.parse("2026-07-15T00:00:00Z"))).toBe("cur");
    expect(pickHistoryHolder(rows, Date.parse("2026-02-01T00:00:00Z"))).toBe("old");
  });

  it("with several covering rows, the most recent taker wins", () => {
    const rows = [
      cand("early", "2026-01-01T00:00:00Z", "2026-08-01T00:00:00Z"),
      cand("late",  "2026-06-01T00:00:00Z", "2026-08-01T00:00:00Z"),
    ];
    expect(pickHistoryHolder(rows, Date.parse("2026-07-01T00:00:00Z"))).toBe("late");
  });

  it("with no covering row, the interval closest to the observation wins", () => {
    const rows = [
      cand("far",  "2025-01-01T00:00:00Z", "2025-06-01T00:00:00Z"),
      cand("near", "2026-01-01T00:00:00Z", "2026-05-01T00:00:00Z"),
    ];
    expect(pickHistoryHolder(rows, Date.parse("2026-07-01T00:00:00Z"))).toBe("near");
  });
});

describe("isPublicIp", () => {
  it("classifies", () => {
    for (const ip of ["8.8.8.8", "52.1.2.3", "203.0.113.9", "2001:db8::1"]) {
      expect(isPublicIp(ip), ip).toBe(true);
    }
    for (const ip of [
      "10.0.0.1", "172.16.5.4", "192.168.1.1",       // RFC1918
      "100.64.0.1", "100.127.255.254",                // CGN
      "127.0.0.1", "::1", "169.254.9.9", "fe80::1",   // noise
      "224.0.0.1", "0.0.0.0", "", "not-an-ip",
      "fd00::1", "fc00::5",                            // ULA
    ]) {
      expect(isPublicIp(ip), ip).toBe(false);
    }
  });
});

describe("resolvePtrNames", () => {
  it("resolves public IPs via the injected lookup, skips private, caches negatives", async () => {
    clearPtrCacheForTests();
    const calls: string[] = [];
    const lookup = async (ip: string): Promise<string[]> => {
      calls.push(ip);
      if (ip === "8.8.8.8") return ["dns.google"];
      throw new Error("NXDOMAIN");
    };
    const hints = await resolvePtrNames(["8.8.8.8", "52.9.9.9", "10.0.0.1"], lookup);
    expect(hints.get("8.8.8.8")).toEqual({ hostname: "dns.google", source: "dns" });
    expect(hints.has("52.9.9.9")).toBe(false);
    expect(hints.has("10.0.0.1")).toBe(false);
    expect(calls.sort()).toEqual(["52.9.9.9", "8.8.8.8"]); // private IP never queried

    // Second call answers from cache — positive AND negative.
    const calls2: string[] = [];
    const lookup2 = async (ip: string): Promise<string[]> => { calls2.push(ip); return []; };
    const again = await resolvePtrNames(["8.8.8.8", "52.9.9.9"], lookup2);
    expect(again.get("8.8.8.8")?.hostname).toBe("dns.google");
    expect(calls2).toEqual([]);
    clearPtrCacheForTests();
  });
});

describe("helpers", () => {
  it("isNoiseIp classifies", () => {
    for (const ip of ["127.0.0.1", "::1", "0.0.0.0", "::", "169.254.9.9", "fe80::1", "224.0.0.1", "239.255.255.250", "255.255.255.255", "ff02::fb", ""]) {
      expect(isNoiseIp(ip), ip).toBe(true);
    }
    for (const ip of ["10.0.0.1", "8.8.8.8", "2001:db8::1", "172.16.5.4"]) {
      expect(isNoiseIp(ip), ip).toBe(false);
    }
  });

  it("subnetKeyOf buckets v4 by /24 and v6 by /64", () => {
    expect(subnetKeyOf("10.1.2.3")).toBe("10.1.2.0/24");
    expect(subnetKeyOf("2001:db8:1:2:3:4:5:6")).toBe("2001:db8:1:2::/64");
    expect(subnetKeyOf("2001:db8::9")).toBe("2001:db8:0:0::/64");
  });

  it("processNodeId is deterministic and collision-safe for odd names", () => {
    expect(processNodeId("A", "tmux: server")).toBe(processNodeId("A", "tmux: server"));
    expect(processNodeId("A", "a|b")).not.toBe(processNodeId("A", "a:b"));
  });
});
