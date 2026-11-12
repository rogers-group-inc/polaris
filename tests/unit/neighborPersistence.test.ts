/**
 * tests/unit/neighborPersistence.test.ts — CQ-T010:
 * src/services/monitoring/neighborPersistence.ts.
 *
 * Complements tests/integration/recordSystemInfoContract.test.ts (LLDP
 * stickiness against a real table), tests/unit/dependencyTreeService.test.ts
 * and tests/unit/wirelessRoamEventsGate.test.ts (the roam-event gate), and
 * tests/unit/systemInfoPersist.test.ts (which mocks this module away). Here
 * the four writers run on the shared _dbStub, with the real interface-identity,
 * FortiAP-alias and hostname-match helpers, and the SQL they hand to
 * $executeRawUnsafe is inspected as parameters:
 *
 *  - persistProcessConnections: empty push is a no-op, validation / dedup by
 *    business key, first unit wins, per-kind caps with stable ordering, the
 *    5-minute churn gate and the unit backfill clause;
 *  - persistLldpNeighbors: description-labelled ports keyed back to their port
 *    (and collapsed), the match arms (mgmt IP, chassis MAC, port MAC, hostname
 *    with rule 91 same-gate disambiguation, FQDN short form, never self), the
 *    48h sticky window, a different neighbour on the same port supersedes
 *    at once, added / removed change events;
 *  - persistManagedApLldpNeighbors: the live-SNMP ownership guard and the
 *    lan1 <-> eth0 alias cleanup;
 *  - persistWirelessStations: malformed MACs skipped, full replace with no
 *    grace, lastSeenAp stamped only on a move, in id order (deadlock fix),
 *    roam events only when wanted.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  loadInterfaceIdentity: vi.fn(),
  maybeEmitChangeEvents: vi.fn(),
  wirelessRoamEventsWanted: vi.fn(),
  getLldpAssetMatchIndex: vi.fn(),
  resolveMonitorSettings: vi.fn(),
}));

vi.mock("../../src/db.js", () => import("./_dbStub.js"));
vi.mock("../../src/services/eventLogService.js", (orig) =>
  import("./_eventLogStub.js").then((s) => s.withEventLogStubs(orig)));
vi.mock("../../src/services/interfaceInventoryService.js", () => ({ loadInterfaceIdentity: h.loadInterfaceIdentity }));
vi.mock("../../src/services/notificationChangeEvents.js", () => ({
  maybeEmitChangeEvents: h.maybeEmitChangeEvents,
  wirelessRoamEventsWanted: h.wirelessRoamEventsWanted,
}));
vi.mock("../../src/services/monitoring/lldpMatchIndex.js", () => ({ getLldpAssetMatchIndex: h.getLldpAssetMatchIndex }));
vi.mock("../../src/services/monitoring/monitorSettings.js", () => ({
  PROBE_ASSET_OMIT: {},
  resolveMonitorSettings: h.resolveMonitorSettings,
}));

import { prisma } from "../../src/db.js";
import { resetDbStub } from "./_dbStub.js";
import { eventLog, resetEventLogStub } from "./_eventLogStub.js";
import {
  persistLldpNeighbors,
  persistManagedApLldpNeighbors,
  persistProcessConnections,
  persistWirelessStations,
  type ProcessConnectionInput,
} from "../../src/services/monitoring/neighborPersistence.js";

const NOW = new Date("2026-06-10T12:00:00Z");
const HOUR = 3600_000;

function index(over: Partial<{ byIp: Map<string, string>; byMac: Map<string, string>; byHostnameAll: Map<string, string[]>; gateIdByAssetId: Map<string, string> }> = {}) {
  return { byIp: new Map(), byMac: new Map(), byHostnameAll: new Map(), gateIdByAssetId: new Map(), ...over };
}

function identity(names: string[] = [], labels: Array<[string, string]> = []) {
  return { names: new Set(names), labelToName: new Map(labels) };
}

/** Every `$executeRawUnsafe` call as { sql, params }. */
const rawCalls = () => vi.mocked(prisma.$executeRawUnsafe).mock.calls.map(([sql, ...params]) => ({ sql: sql as string, params }));

/** The LLDP upsert's per-row (localIfName, matchedAssetId, source) — read from positional params. */
function lldpRows() {
  const { params } = rawCalls()[0]!;
  // Rows are id, assetId, localIfName, ... matchedAssetId, source, first, last; capabilities precede each row.
  const rows: Array<{ id: unknown; localIfName: unknown; matched: unknown; source: unknown }> = [];
  for (let i = 0; i < params.length; i++) {
    if (params[i] === "a1" && typeof params[i - 1] === "string" && /^[0-9a-f-]{36}$|^old-/.test(params[i - 1] as string)) {
      rows.push({ id: params[i - 1], localIfName: params[i + 1], matched: params[i + 10], source: params[i + 11] });
    }
  }
  return rows;
}

beforeEach(() => {
  resetDbStub();
  resetEventLogStub();
  for (const f of Object.values(h)) f.mockReset();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  h.loadInterfaceIdentity.mockResolvedValue(identity());
  h.getLldpAssetMatchIndex.mockResolvedValue(index());
  h.wirelessRoamEventsWanted.mockResolvedValue(false);
  vi.mocked(prisma.assetLldpNeighbor.findMany).mockResolvedValue([] as never);
  vi.mocked(prisma.assetWirelessStation.findMany).mockResolvedValue([] as never);
  vi.mocked(prisma.asset.findMany).mockResolvedValue([] as never);
});

// ─── process connections ────────────────────────────────────────────────────

describe("persistProcessConnections", () => {
  const conn = (over: Partial<ProcessConnectionInput> = {}): ProcessConnectionInput =>
    ({ processName: "nginx", kind: "listen", proto: "tcp", localAddr: "0.0.0.0", localPort: 443, ...over });

  it("an empty push is a no-op (rows age out, they are not deleted)", async () => {
    await persistProcessConnections("a1", []);
    expect(prisma.$executeRawUnsafe).not.toHaveBeenCalled();
  });

  it("drops invalid kinds / protos / names / out-of-range ports; nothing valid → no statement", async () => {
    await persistProcessConnections("a1", [
      conn({ kind: "bogus" as never }), conn({ proto: "icmp" as never }), conn({ processName: "  " }), conn({ localPort: 70000 }),
    ]);
    expect(prisma.$executeRawUnsafe).not.toHaveBeenCalled();
  });

  it("normalizes case, dedups the business key (first unit wins), and sentinels missing fields", async () => {
    await persistProcessConnections("a1", [
      conn({ kind: "LISTEN" as never, proto: "TCP" as never, unit: " nginx.service " }),
      conn({ unit: "other.service" }),
      conn({ processName: "sshd", localAddr: null, localPort: -1, remoteIp: null, remotePort: 1.5 }),
    ]);
    const { sql, params } = rawCalls()[0]!;
    expect(params.length).toBe(2 * 12);
    expect(params.slice(1, 10)).toEqual(["a1", "nginx", "listen", "tcp", "0.0.0.0", 443, "", 0, "nginx.service"]);
    expect(params.slice(13, 22)).toEqual(["a1", "sshd", "listen", "tcp", "", 0, "", 0, ""]);
    expect(params[10]).toBe(NOW.toISOString());
    expect(sql).toContain(`interval '5 minutes'`);
    expect(sql).toContain(`OR ("asset_process_connections"."unit" = '' AND EXCLUDED."unit" <> '')`);
  });

  it("caps each (process, kind) group, keeping the same sorted subset every scrape", async () => {
    const many = Array.from({ length: 210 }, (_, i) => conn({ localPort: 1000 + (209 - i) }));
    await persistProcessConnections("a1", many);
    const { params } = rawCalls()[0]!;
    expect(params.length / 12).toBe(200);
    const ports = params.filter((_, i) => i % 12 === 6);
    expect(ports[0]).toBe(1000);
    expect(ports[199]).toBe(1199);
  });

  it("outbound caps at 500, independently of listen", async () => {
    const out = Array.from({ length: 520 }, (_, i) => conn({ kind: "outbound", remoteIp: "10.0.0.1", remotePort: i + 1, localPort: 0 }));
    await persistProcessConnections("a1", [...out, conn()]);
    expect(rawCalls()[0]!.params.length / 12).toBe(501);
  });
});

// ─── LLDP ───────────────────────────────────────────────────────────────────

describe("persistLldpNeighbors — matching", () => {
  const nb = (over: Record<string, unknown> = {}) => ({ localIfName: "port1", chassisId: "c1", portId: "p1", ...over }) as any;

  it("matches by management IP first, never to the scraping asset itself", async () => {
    h.getLldpAssetMatchIndex.mockResolvedValue(index({ byIp: new Map([["10.0.0.2", "b"], ["10.0.0.1", "a1"]]) }));
    await persistLldpNeighbors("a1", [nb({ managementIp: "10.0.0.2" }), nb({ localIfName: "port2", managementIp: "10.0.0.1" })], NOW, "snmp");
    expect(lldpRows().map((r) => [r.localIfName, r.matched, r.source])).toEqual([["port1", "b", "snmp"], ["port2", null, "snmp"]]);
  });

  it("matches a chassis MAC and a port MAC (upper-cased)", async () => {
    h.getLldpAssetMatchIndex.mockResolvedValue(index({ byMac: new Map([["AA:BB:CC:DD:EE:01", "m1"], ["AA:BB:CC:DD:EE:02", "m2"]]) }));
    await persistLldpNeighbors("a1", [
      nb({ chassisIdSubtype: "macAddress", chassisId: "aa:bb:cc:dd:ee:01" }),
      nb({ localIfName: "port2", chassisId: "x", portIdSubtype: "macAddress", portId: "aa:bb:cc:dd:ee:02" }),
    ], NOW, "snmp");
    expect(lldpRows().map((r) => r.matched)).toEqual(["m1", "m2"]);
  });

  it("hostname: a shared name resolves only to the candidate under the same gate (rule 91)", async () => {
    h.getLldpAssetMatchIndex.mockResolvedValue(index({
      byHostnameAll: new Map([["sw-1", ["x", "y"]], ["core", ["z"]]]),
      gateIdByAssetId: new Map([["a1", "g1"], ["x", "g2"], ["y", "g1"]]),
    }));
    await persistLldpNeighbors("a1", [nb({ systemName: "SW-1" }), nb({ localIfName: "port2", systemName: "core.example.com" })], NOW, "snmp");
    expect(lldpRows().map((r) => r.matched)).toEqual(["y", "z"]);
  });

  it("a non-MAC chassisId is tried as a hostname; a MAC-shaped one is not", async () => {
    h.getLldpAssetMatchIndex.mockResolvedValue(index({ byHostnameAll: new Map([["host7", ["h7"]], ["aa:bb:cc:dd:ee:ff", ["bad"]]]) }));
    await persistLldpNeighbors("a1", [
      nb({ chassisIdSubtype: "local", chassisId: "HOST7" }),
      nb({ localIfName: "port2", chassisIdSubtype: "local", chassisId: "aa:bb:cc:dd:ee:ff" }),
    ], NOW, "snmp");
    expect(lldpRows().map((r) => r.matched)).toEqual(["h7", null]);
  });
});

describe("persistLldpNeighbors — keys, stickiness and events", () => {
  const nb = (over: Record<string, unknown> = {}) => ({ localIfName: "port1", chassisId: "c1", portId: "p1", systemName: "peer", ...over }) as any;
  const row = (over: Record<string, unknown> = {}) => ({ id: "old-1", localIfName: "port1", chassisId: "c1", portId: "p1", systemName: "peer", lastSeen: NOW, ...over });

  it("a description-labelled local port is keyed to its port, and a collision collapses", async () => {
    h.loadInterfaceIdentity.mockResolvedValue(identity(["port9"], [["MORGAN-221E-1", "port9"]]));
    await persistLldpNeighbors("a1", [nb({ localIfName: "MORGAN-221E-1" }), nb({ localIfName: "port9" })], NOW, "snmp");
    expect(lldpRows().map((r) => r.localIfName)).toEqual(["port9"]);
  });

  it("an existing row keeps its id (firstSeen survives)", async () => {
    vi.mocked(prisma.assetLldpNeighbor.findMany).mockResolvedValue([row()] as never);
    await persistLldpNeighbors("a1", [nb()], NOW, "snmp");
    expect(lldpRows()[0]!.id).toBe("old-1");
    expect(prisma.assetLldpNeighbor.deleteMany).not.toHaveBeenCalled();
  });

  it("a vanished neighbour stays for 48h, then goes", async () => {
    vi.mocked(prisma.assetLldpNeighbor.findMany).mockResolvedValue([
      row({ id: "young", localIfName: "port5", lastSeen: new Date(NOW.getTime() - 47 * HOUR) }),
      row({ id: "old", localIfName: "port6", lastSeen: new Date(NOW.getTime() - 49 * HOUR) }),
    ] as never);
    await persistLldpNeighbors("a1", [], NOW, "snmp");
    expect(prisma.assetLldpNeighbor.deleteMany).toHaveBeenCalledWith({ where: { id: { in: ["old"] } } });
    expect(prisma.$executeRawUnsafe).not.toHaveBeenCalled();
  });

  it("a different neighbour on the same port supersedes immediately", async () => {
    vi.mocked(prisma.assetLldpNeighbor.findMany).mockResolvedValue([row({ id: "prev", chassisId: "c-old" })] as never);
    await persistLldpNeighbors("a1", [nb()], NOW, "snmp");
    expect(prisma.assetLldpNeighbor.deleteMany).toHaveBeenCalledWith({ where: { id: { in: ["prev"] } } });
  });

  it("a stored row keyed by a port DESCRIPTION is deleted at once (no grace)", async () => {
    h.loadInterfaceIdentity.mockResolvedValue(identity(["port9"], [["Tim Smith", "port9"]]));
    vi.mocked(prisma.assetLldpNeighbor.findMany).mockResolvedValue([row({ id: "lbl", localIfName: "Tim Smith" })] as never);
    await persistLldpNeighbors("a1", [], NOW, "snmp");
    expect(prisma.assetLldpNeighbor.deleteMany).toHaveBeenCalledWith({ where: { id: { in: ["lbl"] } } });
  });

  it("emits added and removed change events with the asset name", async () => {
    vi.mocked(prisma.assetLldpNeighbor.findMany).mockResolvedValue([row({ id: "prev", chassisId: "c-old", systemName: null })] as never);
    vi.mocked(prisma.asset.findUnique).mockResolvedValue({ hostname: "sw1" } as never);
    await persistLldpNeighbors("a1", [nb()], NOW, "snmp");
    expect(h.maybeEmitChangeEvents).toHaveBeenCalledWith("change.lldp.neighbor_added", "a1", "sw1", [expect.objectContaining({ label: "peer on port1" })]);
    expect(h.maybeEmitChangeEvents).toHaveBeenCalledWith("change.lldp.neighbor_removed", "a1", "sw1", [expect.objectContaining({ label: "c-old on port1" })]);
  });

  it("no change → no events and no name lookup", async () => {
    vi.mocked(prisma.assetLldpNeighbor.findMany).mockResolvedValue([row()] as never);
    await persistLldpNeighbors("a1", [nb()], NOW, "snmp");
    expect(h.maybeEmitChangeEvents).not.toHaveBeenCalled();
    expect(prisma.asset.findUnique).not.toHaveBeenCalled();
  });

  it("capabilities become an explicit text[] expression", async () => {
    await persistLldpNeighbors("a1", [nb({ capabilities: ["bridge", "router"] }), nb({ localIfName: "port2" })], NOW, "snmp");
    const { sql, params } = rawCalls()[0]!;
    expect(sql).toContain("ARRAY[$1,$2]::text[]");
    expect(sql).toContain("ARRAY[]::text[]");
    expect(params.slice(0, 2)).toEqual(["bridge", "router"]);
  });
});

describe("persistManagedApLldpNeighbors", () => {
  const apNb = (localIfName: string) => ({ localIfName, chassisId: "c", portId: "p" }) as any;

  it("an unknown asset is skipped", async () => {
    vi.mocked(prisma.asset.findUnique).mockResolvedValue(null as never);
    expect(await persistManagedApLldpNeighbors("a1", [], NOW)).toBe("skipped");
  });

  it("defers to a LIVE SNMP LLDP stream", async () => {
    vi.mocked(prisma.asset.findUnique).mockResolvedValue({ id: "a1", monitored: true, discoveredByIntegration: { type: "fortigate" } } as never);
    h.resolveMonitorSettings.mockResolvedValue({ lldpPolling: "snmp" });
    vi.mocked(prisma.assetLldpNeighbor.findFirst).mockResolvedValue({ id: "x" } as never);
    expect(await persistManagedApLldpNeighbors("a1", [apNb("lan1")], NOW)).toBe("skipped");
    const where = vi.mocked(prisma.assetLldpNeighbor.findFirst).mock.calls[0]![0]!.where as any;
    expect(where.lastSeen.gte).toEqual(new Date(NOW.getTime() - 48 * HOUR));
  });

  it("a configured-but-dead SNMP stream does not own the table", async () => {
    vi.mocked(prisma.asset.findUnique).mockResolvedValue({ id: "a1", monitored: true, discoveredByIntegration: null } as never);
    h.resolveMonitorSettings.mockResolvedValue({ lldpPolling: "snmp" });
    vi.mocked(prisma.assetLldpNeighbor.findFirst).mockResolvedValue(null as never);
    vi.mocked(prisma.assetInterface.findMany).mockResolvedValue([] as never);
    expect(await persistManagedApLldpNeighbors("a1", [apNb("lan1")], NOW)).toBe("persisted");
  });

  it("normalizes lan1 → eth0 when the AP reports eth0, deletes rows on the alias, and writes source managed-ap", async () => {
    vi.mocked(prisma.asset.findUnique).mockResolvedValue({ id: "a1", monitored: false } as never);
    vi.mocked(prisma.assetInterface.findMany).mockResolvedValue([{ ifName: "eth0" }] as never);
    expect(await persistManagedApLldpNeighbors("a1", [apNb("lan1")], NOW)).toBe("persisted");
    expect(prisma.assetLldpNeighbor.deleteMany).toHaveBeenCalledWith({ where: { assetId: "a1", localIfName: { in: ["lan1"] } } });
    expect(lldpRows().map((r) => [r.localIfName, r.source])).toEqual([["eth0", "managed-ap"]]);
    expect(h.resolveMonitorSettings).not.toHaveBeenCalled();
  });
});

// ─── wireless stations ──────────────────────────────────────────────────────

describe("persistWirelessStations", () => {
  const sta = (mac: string, over: Record<string, unknown> = {}) => ({ staMacAddr: mac, ...over }) as any;

  beforeEach(() => {
    vi.mocked(prisma.asset.findUnique).mockResolvedValue({ hostname: "AP-1" } as never);
  });

  it("skips malformed MACs and upper-cases the rest; source reflects the REST overlay", async () => {
    await persistWirelessStations("ap", [sta("nope"), sta("aa:bb:cc:dd:ee:01"), sta("aa:bb:cc:dd:ee:02", { signalStrength: -60 })]);
    const { params } = rawCalls()[0]!;
    expect(params.length).toBe(2 * 19);
    expect(params[2]).toBe("AA:BB:CC:DD:EE:01");
    expect(params[16]).toBe("snmp");
    expect(params[19 + 16]).toBe("snmp+rest");
  });

  it("full replace with no grace: a station absent from the scrape is deleted", async () => {
    vi.mocked(prisma.assetWirelessStation.findMany).mockResolvedValue([
      { id: "s1", staMacAddr: "AA:BB:CC:DD:EE:01" }, { id: "s2", staMacAddr: "AA:BB:CC:DD:EE:02" },
    ] as never);
    await persistWirelessStations("ap", [sta("aa:bb:cc:dd:ee:01")]);
    expect(rawCalls()[0]!.params[0]).toBe("s1");
    expect(prisma.assetWirelessStation.deleteMany).toHaveBeenCalledWith({ where: { id: { in: ["s2"] } } });
  });

  it("stamps lastSeenAp only on endpoints that moved, in id order, skipping vanished ones", async () => {
    h.getLldpAssetMatchIndex.mockResolvedValue(index({ byMac: new Map([
      ["AA:BB:CC:DD:EE:01", "z-end"], ["AA:BB:CC:DD:EE:02", "a-end"], ["AA:BB:CC:DD:EE:03", "same"], ["AA:BB:CC:DD:EE:04", "gone"],
    ]) }));
    vi.mocked(prisma.asset.findMany).mockResolvedValue([
      { id: "z-end", lastSeenAp: "AP-0", hostname: "z", ipAddress: null },
      { id: "a-end", lastSeenAp: null, hostname: null, ipAddress: "10.0.0.7" },
      { id: "same", lastSeenAp: " ap-1 ", hostname: "s", ipAddress: null },
    ] as never);
    vi.mocked(prisma.asset.update).mockImplementation(((args: any) => Promise.resolve(args.where.id)) as never);
    await persistWirelessStations("ap", ["01", "02", "03", "04"].map((n) => sta(`aa:bb:cc:dd:ee:${n}`)));
    expect(vi.mocked(prisma.asset.update).mock.calls.map((c) => (c[0] as any).where.id)).toEqual(["a-end", "z-end"]);
    expect(eventLog.logEventsBatch).not.toHaveBeenCalled();
  });

  it("writes roam / connect events only while an automation wants them", async () => {
    h.wirelessRoamEventsWanted.mockResolvedValue(true);
    h.getLldpAssetMatchIndex.mockResolvedValue(index({ byMac: new Map([["AA:BB:CC:DD:EE:01", "e1"], ["AA:BB:CC:DD:EE:02", "e2"]]) }));
    vi.mocked(prisma.asset.findMany).mockResolvedValue([
      { id: "e1", lastSeenAp: "AP-0", hostname: "laptop", ipAddress: null },
      { id: "e2", lastSeenAp: null, hostname: null, ipAddress: "10.0.0.7" },
    ] as never);
    await persistWirelessStations("ap", [sta("aa:bb:cc:dd:ee:01"), sta("aa:bb:cc:dd:ee:02")]);
    const evs = eventLog.logEventsBatch.mock.calls[0]![0];
    expect(evs.map((e) => e.message)).toEqual([
      'Asset "laptop" roamed to AP "AP-1" (was "AP-0")',
      'Asset "10.0.0.7" connected to AP "AP-1"',
    ]);
  });

  it("the AP itself, and an AP with no hostname, stamp nothing", async () => {
    h.getLldpAssetMatchIndex.mockResolvedValue(index({ byMac: new Map([["AA:BB:CC:DD:EE:01", "ap"]]) }));
    await persistWirelessStations("ap", [sta("aa:bb:cc:dd:ee:01")]);
    expect(prisma.asset.findMany).not.toHaveBeenCalled();

    h.getLldpAssetMatchIndex.mockResolvedValue(index({ byMac: new Map([["AA:BB:CC:DD:EE:01", "e1"]]) }));
    vi.mocked(prisma.asset.findUnique).mockResolvedValue({ hostname: null } as never);
    await persistWirelessStations("ap", [sta("aa:bb:cc:dd:ee:01")]);
    expect(prisma.asset.findMany).not.toHaveBeenCalled();
  });

  it("an empty scrape with nothing stored writes nothing", async () => {
    await persistWirelessStations("ap", []);
    expect(prisma.$executeRawUnsafe).not.toHaveBeenCalled();
    expect(prisma.assetWirelessStation.deleteMany).not.toHaveBeenCalled();
  });
});
