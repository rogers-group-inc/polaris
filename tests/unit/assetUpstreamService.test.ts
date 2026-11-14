/**
 * tests/unit/assetUpstreamService.test.ts — CQ-T010 own suite for
 * src/services/assetUpstreamService.ts.
 *
 * tests/unit/assetUpstream.test.ts already pins the two pure helpers
 * (`splitLastSeenSwitch`, `pickFirewallEntry`). This suite drives the two
 * DB-backed resolvers — `resolveAssetUpstream` and `resolveFirewallRefsByName`
 * — against an in-memory asset table whose `findMany` honours the `where`
 * shapes the service builds, so the real `fortinetParentKey` precedence runs.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../src/db.js", () => import("./_dbStub.js"));

const ipam = vi.hoisted(() => ({ resolveOwningGateContexts: vi.fn() }));
vi.mock("../../src/services/ipUpstreamChainService.js", () => ipam);

import { prisma } from "../../src/db.js";
import { resetDbStub, stubbed } from "./_dbStub.js";
import { resolveAssetUpstream, resolveFirewallRefsByName } from "../../src/services/assetUpstreamService.js";

// ─── An in-memory Asset table that understands the service's where shapes ────

type Row = {
  id: string;
  hostname: string | null;
  serialNumber: string | null;
  assetType: string;
  status: string;
  monitorStatus: string | null;
  ipAddress: string | null;
  fortinetTopology: unknown;
  managementAccess: unknown;
  lastSeenSwitch?: string | null;
  lastSeenAp?: string | null;
};

function row(id: string, assetType: string, extra: Partial<Row> = {}): Row {
  return {
    id, hostname: id, serialNumber: null, assetType, status: "active", monitorStatus: "up",
    ipAddress: null, fortinetTopology: null, managementAccess: null, ...extra,
  };
}

function matches(r: Record<string, unknown>, where: Record<string, unknown>): boolean {
  for (const [k, v] of Object.entries(where)) {
    if (k === "OR") {
      if (!(v as Array<Record<string, unknown>>).some((w) => matches(r, w))) return false;
    } else if (k === "fortinetTopology") {
      const { path, equals } = v as { path: string[]; equals: unknown };
      const t = r.fortinetTopology as Record<string, unknown> | null;
      if (!t || t[path[0]] !== equals) return false;
    } else if (v && typeof v === "object" && "not" in (v as object)) {
      if (r[k] === (v as { not: unknown }).not) return false;
    } else if (r[k] !== v) {
      return false;
    }
  }
  return true;
}

let table: Row[] = [];
const findUnique = stubbed(prisma.asset.findUnique);
const findMany = stubbed(prisma.asset.findMany);
const sightingFind = stubbed(prisma.assetFortigateSighting.findMany);
const macFind = stubbed(prisma.assetMacTableEntry.findMany);

function seed(rows: Row[]): void {
  table = rows;
}

beforeEach(() => {
  resetDbStub();
  ipam.resolveOwningGateContexts.mockReset();
  ipam.resolveOwningGateContexts.mockResolvedValue(new Map());
  table = [];
  findUnique.mockImplementation(async (args: { where: { id: string } }) => table.find((r) => r.id === args.where.id) ?? null);
  findMany.mockImplementation(async (args: { where: Record<string, unknown> }) => table.filter((r) => matches(r, args.where)));
  sightingFind.mockResolvedValue([]);
  macFind.mockResolvedValue([]);
});

const gateTopo = (deviceName: string) => ({ deviceName });
const underGate = (serial: string, extra: Record<string, unknown> = {}) => ({ controllerSerial: serial, ...extra });

// ─── resolveAssetUpstream ────────────────────────────────────────────────────

describe("resolveAssetUpstream — basics", () => {
  it("returns null when the asset itself is gone", async () => {
    expect(await resolveAssetUpstream("missing")).toBeNull();
    expect(findMany).not.toHaveBeenCalled();
  });

  it("resolves switch by serial, AP by hostname and firewall by FMG device name in ONE candidate query", async () => {
    seed([
      row("ep", "workstation", { lastSeenSwitch: "S248EPTF0000001/port15", lastSeenAp: "AP-LOBBY", ipAddress: null }),
      row("sw", "switch", { hostname: "IDF-1", serialNumber: "S248EPTF0000001", managementAccess: { mgmtIp: "10.0.0.2", https: true, ssh: false, protocols: ["https"] } }),
      row("ap", "access_point", { hostname: "AP-LOBBY" }),
      row("fgt", "firewall", { hostname: "fgt-hostname", serialNumber: "FGT60F0000000001", fortinetTopology: gateTopo("BRANCH-FGT") }),
    ]);
    const seen = new Date("2026-11-01T10:00:00Z");
    sightingFind.mockResolvedValue([{ fortigateDevice: "BRANCH-FGT", lastSeen: seen }]);

    const out = await resolveAssetUpstream("ep");

    expect(out!.switch).toMatchObject({ name: "S248EPTF0000001", port: "port15", asset: { id: "sw", hostname: "IDF-1" } });
    expect(out!.switch!.asset!.managementAccess).toEqual({ mgmtIp: "10.0.0.2", protocols: ["https"], https: true, ssh: false });
    expect(out!.ap).toMatchObject({ name: "AP-LOBBY", asset: { id: "ap" } });
    expect(out!.firewall).toEqual(expect.objectContaining({
      name: "BRANCH-FGT", source: "sighting", lastSeen: seen.toISOString(), asset: expect.objectContaining({ id: "fgt" }),
    }));
    expect(out!.visibility).toEqual({ firewall: true, subnetGate: false });
    expect(findMany).toHaveBeenCalledTimes(1);
    expect(findMany.mock.calls[0][0].where.id).toEqual({ not: "ep" });
  });

  it("omits the port when lastSeenSwitch carried none, and reports no rows for blank inputs", async () => {
    seed([row("ep", "printer", { lastSeenSwitch: "IDF-1", lastSeenAp: "   " }), row("sw", "switch", { hostname: "IDF-1" })]);
    const out = await resolveAssetUpstream("ep");
    expect(out!.switch).toEqual({ name: "IDF-1", asset: expect.objectContaining({ id: "sw" }) });
    expect(out!.ap).toBeNull();
    expect(out!.firewall).toBeNull();
  });

  it("skips the candidate query entirely when there is nothing to resolve", async () => {
    seed([row("ep", "workstation")]);
    const out = await resolveAssetUpstream("ep");
    expect(out).toMatchObject({ switch: null, ap: null, firewall: null });
    expect(findMany).not.toHaveBeenCalled();
  });

  it("reports an unresolved name as the name with a null asset, never an error", async () => {
    seed([row("ep", "workstation", { lastSeenSwitch: "UNADOPTED/port1", lastSeenAp: "GHOST-AP" })]);
    sightingFind.mockResolvedValue([{ fortigateDevice: "NOT-AN-ASSET", lastSeen: null }]);
    const out = await resolveAssetUpstream("ep");
    expect(out!.switch).toEqual({ name: "UNADOPTED", port: "port1", asset: null });
    expect(out!.ap).toEqual({ name: "GHOST-AP", asset: null });
    // No lastSeen on the sighting → no lastSeen key on the entry.
    expect(out!.firewall).toEqual({ name: "NOT-AN-ASSET", source: "sighting", asset: null });
  });

  it("never resolves to the asset being viewed (self-link refusal)", async () => {
    seed([row("sw", "switch", { hostname: "IDF-1", lastSeenSwitch: "IDF-1/port48" })]);
    const out = await resolveAssetUpstream("sw");
    expect(out!.switch).toEqual({ name: "IDF-1", port: "port48", asset: null });
  });

  it("does not let a switch and a gate sharing a hostname shadow each other", async () => {
    seed([
      row("ep", "workstation", { lastSeenSwitch: "CORE/port1" }),
      row("sw", "switch", { hostname: "CORE" }),
      row("fgt", "firewall", { hostname: "CORE" }),
    ]);
    sightingFind.mockResolvedValue([{ fortigateDevice: "CORE", lastSeen: new Date() }]);
    const out = await resolveAssetUpstream("ep");
    expect(out!.switch!.asset!.id).toBe("sw");
    expect(out!.firewall!.asset!.id).toBe("fgt");
  });

  it("reads at most 50 sightings, newest first, ignoring blank device names, and folds duplicate names into one branch", async () => {
    seed([row("ep", "workstation"), row("fgt", "firewall", { hostname: "GATE" })]);
    sightingFind.mockResolvedValue([
      { fortigateDevice: " GATE ", lastSeen: new Date("2026-11-02T00:00:00Z") },
      { fortigateDevice: "GATE", lastSeen: new Date("2026-11-01T00:00:00Z") },
    ]);
    const out = await resolveAssetUpstream("ep");
    const args = sightingFind.mock.calls[0][0];
    expect(args).toMatchObject({ where: { assetId: "ep", NOT: { fortigateDevice: "" } }, orderBy: { lastSeen: "desc" }, take: 50 });
    const branches = findMany.mock.calls[0][0].where.OR as Array<{ assetType: string }>;
    expect(branches.filter((b) => b.assetType === "firewall")).toHaveLength(1);
    expect(out!.firewall).toMatchObject({ name: "GATE", lastSeen: "2026-11-02T00:00:00.000Z", asset: { id: "fgt" } });
  });

  it("passes over a sighting whose gate is decommissioned for an older live one", async () => {
    seed([
      row("ep", "workstation"),
      row("old", "firewall", { hostname: "OLD-GATE", status: "decommissioned" }),
      row("new", "firewall", { hostname: "NEW-GATE" }),
    ]);
    sightingFind.mockResolvedValue([
      { fortigateDevice: "OLD-GATE", lastSeen: new Date("2026-11-03T00:00:00Z") },
      { fortigateDevice: "NEW-GATE", lastSeen: new Date("2026-10-01T00:00:00Z") },
    ]);
    const out = await resolveAssetUpstream("ep");
    expect(out!.firewall).toMatchObject({ name: "NEW-GATE", source: "sighting", asset: { id: "new" } });
  });
});

describe("resolveAssetUpstream — a firewall asset", () => {
  it("runs no sighting query and no IPAM lookup for a gate", async () => {
    seed([row("fgt", "firewall", { ipAddress: "10.0.0.1" })]);
    const out = await resolveAssetUpstream("fgt");
    expect(sightingFind).not.toHaveBeenCalled();
    expect(ipam.resolveOwningGateContexts).not.toHaveBeenCalled();
    expect(out!.firewall).toBeNull();
    expect(out!.visibility.subnetGate).toBe(false);
  });

  // BUG: the service contract says "All three are null for an assetType:
  // firewall" (the General tab hides the rows for a gate). A firewall whose own
  // lastSeenSwitch is "IDF-1/port1" and lastSeenAp is "AP-1" gets non-null
  // switch / ap entries back (only the firewall row is suppressed); the right
  // output is { switch: null, ap: null, firewall: null }.
  it.fails("reports all three rows null for a firewall, even with lastSeenSwitch / lastSeenAp set", async () => {
    seed([
      row("fgt", "firewall", { lastSeenSwitch: "IDF-1/port1", lastSeenAp: "AP-1" }),
      row("sw", "switch", { hostname: "IDF-1" }),
      row("ap", "access_point", { hostname: "AP-1" }),
    ]);
    const out = await resolveAssetUpstream("fgt");
    expect(out).toMatchObject({ switch: null, ap: null, firewall: null });
  });
});

describe("resolveAssetUpstream — controller-managed switch / AP", () => {
  it("answers an AP's firewall row with its controller gate, serial first, with no sighting or IPAM read", async () => {
    seed([
      row("ap", "access_point", { ipAddress: "10.1.1.5", fortinetTopology: underGate("FGT60F0000000009", { controllerFortigate: "FMG-NAME" }) }),
      row("gate", "firewall", { hostname: "real-host", serialNumber: "FGT60F0000000009" }),
    ]);
    const out = await resolveAssetUpstream("ap", { includeFirewall: false, includeSubnetGate: true });
    expect(out!.firewall).toEqual({ name: "FMG-NAME", source: "controller", asset: expect.objectContaining({ id: "gate" }) });
    expect(out!.firewall).not.toHaveProperty("lastSeen");
    expect(sightingFind).not.toHaveBeenCalled();
    expect(ipam.resolveOwningGateContexts).not.toHaveBeenCalled();
    // The stamp is on the asset row, so the row is shown without assetsQuarantine:read.
    expect(out!.visibility).toEqual({ firewall: true, subnetGate: false });
  });

  it("names the controller by the gate's hostname, then the serial, when the stamp carries no name", async () => {
    seed([
      row("sw", "switch", { fortinetTopology: underGate("FGT60F0000000009") }),
      row("gate", "firewall", { hostname: "gate-host", serialNumber: "FGT60F0000000009" }),
    ]);
    expect((await resolveAssetUpstream("sw"))!.firewall).toMatchObject({ name: "gate-host", source: "controller" });

    seed([row("sw", "switch", { fortinetTopology: underGate("FGT60F0000000009") })]);
    expect((await resolveAssetUpstream("sw"))!.firewall).toEqual({ name: "FGT60F0000000009", source: "controller", asset: null });
  });

  it("resolves a name-only controller stamp through the gate's FMG device name", async () => {
    seed([
      row("sw", "switch", { fortinetTopology: { controllerFortigate: "BRANCH-FGT" } }),
      row("gate", "firewall", { hostname: "something-else", fortinetTopology: gateTopo("BRANCH-FGT") }),
    ]);
    expect((await resolveAssetUpstream("sw"))!.firewall).toMatchObject({ name: "BRANCH-FGT", asset: { id: "gate" } });
  });

  it("treats a blank controller stamp as no controller (falls back to the sighting half)", async () => {
    seed([row("sw", "switch", { fortinetTopology: { controllerFortigate: "   ", controllerSerial: "" } })]);
    await resolveAssetUpstream("sw");
    expect(sightingFind).toHaveBeenCalledTimes(1);
  });

  it("never treats a controller stamp on an endpoint as a controller", async () => {
    seed([row("ep", "workstation", { fortinetTopology: underGate("FGT60F0000000009") })]);
    const out = await resolveAssetUpstream("ep");
    expect(sightingFind).toHaveBeenCalledTimes(1);
    expect(out!.firewall).toBeNull();
  });
});

describe("resolveAssetUpstream — permission halves and the IPAM fallback (rule 55)", () => {
  it("skips the sighting half without assetsQuarantine:read and says so", async () => {
    seed([row("ep", "workstation")]);
    const out = await resolveAssetUpstream("ep", { includeFirewall: false, includeSubnetGate: false });
    expect(sightingFind).not.toHaveBeenCalled();
    expect(out!.firewall).toBeNull();
    expect(out!.visibility).toEqual({ firewall: false, subnetGate: false });
  });

  it("answers from IPAM when nothing sighted the device: source subnet, the cidr, and NO lastSeen", async () => {
    seed([row("ep", "workstation", { ipAddress: " 10.9.0.20 " }), row("gate", "firewall", { hostname: "NEW-FGT" })]);
    ipam.resolveOwningGateContexts.mockResolvedValue(new Map([["10.9.0.20", { subnetId: "s1", subnetCidr: "10.9.0.0/24", gateAssetId: "gate" }]]));
    const out = await resolveAssetUpstream("ep");
    expect(ipam.resolveOwningGateContexts).toHaveBeenCalledWith(["10.9.0.20"]);
    expect(out!.firewall).toEqual({ name: "NEW-FGT", source: "subnet", subnetCidr: "10.9.0.0/24", asset: expect.objectContaining({ id: "gate" }) });
    expect(out!.visibility).toEqual({ firewall: true, subnetGate: true });
    // Resolved by id in the same candidate query.
    expect(findMany).toHaveBeenCalledTimes(1);
  });

  it("answers from IPAM without assetsQuarantine:read but with subnets:read", async () => {
    seed([row("ep", "workstation", { ipAddress: "10.9.0.20" }), row("gate", "firewall", { hostname: null, serialNumber: "FGT-SER" })]);
    ipam.resolveOwningGateContexts.mockResolvedValue(new Map([["10.9.0.20", { subnetId: "s1", subnetCidr: "10.9.0.0/24", gateAssetId: "gate" }]]));
    const out = await resolveAssetUpstream("ep", { includeFirewall: false });
    expect(out!.firewall).toMatchObject({ name: "FGT-SER", source: "subnet" });
    expect(out!.visibility).toEqual({ firewall: false, subnetGate: true });
  });

  it("a live sighting outranks the IPAM gate", async () => {
    seed([
      row("ep", "workstation", { ipAddress: "10.9.0.20" }),
      row("sighted", "firewall", { hostname: "SIGHTED" }),
      row("owner", "firewall", { hostname: "OWNER" }),
    ]);
    sightingFind.mockResolvedValue([{ fortigateDevice: "SIGHTED", lastSeen: new Date() }]);
    ipam.resolveOwningGateContexts.mockResolvedValue(new Map([["10.9.0.20", { subnetId: "s1", subnetCidr: "10.9.0.0/24", gateAssetId: "owner" }]]));
    const out = await resolveAssetUpstream("ep");
    expect(out!.firewall).toMatchObject({ source: "sighting", asset: { id: "sighted" } });
  });

  it("falls to the IPAM gate when every sighted gate is gone", async () => {
    seed([row("ep", "workstation", { ipAddress: "10.9.0.20" }), row("owner", "firewall", { hostname: "OWNER" })]);
    sightingFind.mockResolvedValue([{ fortigateDevice: "DELETED-GATE", lastSeen: new Date() }]);
    ipam.resolveOwningGateContexts.mockResolvedValue(new Map([["10.9.0.20", { subnetId: "s1", subnetCidr: "10.9.0.0/24", gateAssetId: "owner" }]]));
    expect((await resolveAssetUpstream("ep"))!.firewall).toMatchObject({ source: "subnet", asset: { id: "owner" } });
  });

  it("yields no row when the IPAM gate has no Asset row", async () => {
    seed([row("ep", "workstation", { ipAddress: "10.9.0.20" })]);
    ipam.resolveOwningGateContexts.mockResolvedValue(new Map([["10.9.0.20", { subnetId: "s1", subnetCidr: "10.9.0.0/24", gateAssetId: "vanished" }]]));
    expect((await resolveAssetUpstream("ep"))!.firewall).toBeNull();
  });

  it("does not consult IPAM for an asset with no address, or without subnets:read", async () => {
    seed([row("ep", "workstation", { ipAddress: "  " })]);
    expect((await resolveAssetUpstream("ep"))!.visibility.subnetGate).toBe(false);
    seed([row("ep", "workstation", { ipAddress: "10.0.0.5" })]);
    expect((await resolveAssetUpstream("ep", { includeSubnetGate: false }))!.visibility.subnetGate).toBe(false);
    expect(ipam.resolveOwningGateContexts).not.toHaveBeenCalled();
  });
});

describe("resolveAssetUpstream — a switch name several devices share (rule 91)", () => {
  const fleet = () => [
    row("gA", "firewall", { hostname: "GATE-A", serialNumber: "FGTA000000000001" }),
    row("gB", "firewall", { hostname: "GATE-B", serialNumber: "FGTB000000000001" }),
    row("swA", "switch", { hostname: "IDF-1", serialNumber: "S1A", fortinetTopology: underGate("FGTA000000000001") }),
    row("swB", "switch", { hostname: "IDF-1", serialNumber: "S1B", fortinetTopology: underGate("FGTB000000000001") }),
  ];

  it("settles the name by the gate that sighted the endpoint", async () => {
    seed([row("ep", "workstation", { lastSeenSwitch: "IDF-1/port3" }), ...fleet()]);
    sightingFind.mockResolvedValue([{ fortigateDevice: "GATE-B", lastSeen: new Date() }]);
    const out = await resolveAssetUpstream("ep");
    expect(out!.switch!.asset!.id).toBe("swB");
    // first query + the controllers query
    expect(findMany).toHaveBeenCalledTimes(2);
    expect(macFind).toHaveBeenCalledTimes(1);
    expect(macFind.mock.calls[0][0].where).toMatchObject({ matchedAssetId: "ep", status: "learned" });
  });

  it("prefers the switch whose MAC table holds the endpoint over the sighted gate", async () => {
    seed([row("ep", "workstation", { lastSeenSwitch: "IDF-1/port3" }), ...fleet()]);
    sightingFind.mockResolvedValue([{ fortigateDevice: "GATE-B", lastSeen: new Date() }]);
    macFind.mockResolvedValue([{ assetId: "swA" }]);
    expect((await resolveAssetUpstream("ep"))!.switch!.asset!.id).toBe("swA");
  });

  it("uses the IPAM owning gate as scope even when it is not the firewall row's answer", async () => {
    seed([row("ep", "workstation", { lastSeenSwitch: "IDF-1/port3", ipAddress: "10.2.0.9" }), ...fleet()]);
    ipam.resolveOwningGateContexts.mockResolvedValue(new Map([["10.2.0.9", { subnetId: "s", subnetCidr: "10.2.0.0/24", gateAssetId: "gA" }]]));
    expect((await resolveAssetUpstream("ep"))!.switch!.asset!.id).toBe("swA");
  });

  it("leaves the row unresolved when nothing decides — never the first row returned", async () => {
    seed([row("ep", "workstation", { lastSeenSwitch: "IDF-1/port3" }), ...fleet()]);
    expect((await resolveAssetUpstream("ep"))!.switch).toEqual({ name: "IDF-1", port: "port3", asset: null });
  });

  it("does not load the scope when the name is unique", async () => {
    seed([row("ep", "workstation", { lastSeenSwitch: "IDF-1/port3" }), ...fleet().filter((r) => r.id !== "swB")]);
    expect((await resolveAssetUpstream("ep"))!.switch!.asset!.id).toBe("swA");
    expect(macFind).not.toHaveBeenCalled();
  });

  // BUG: rule 91 names "the child's own controller" as a gateIds source of
  // the scope. An AP stamped controllerSerial FGTB… whose lastSeenSwitch is
  // "IDF-1/port3", with two IDF-1 switches (one under gate A, one under gate B)
  // and no MAC-table / sighting / IPAM evidence, resolves the switch to null;
  // the AP's own controller (gate B) singles out swB. (The service entry's
  // scope list — [sighted gate, IPAM gate] — omits the controller, and the
  // sighting half never runs for a controller-managed device, so its gateIds
  // are always empty.)
  it.fails("settles a controller-managed AP's shared upstream switch name by the AP's own controller", async () => {
    seed([
      row("ap", "access_point", { lastSeenSwitch: "IDF-1/port3", fortinetTopology: underGate("FGTB000000000001") }),
      ...fleet(),
    ]);
    expect((await resolveAssetUpstream("ap"))!.switch!.asset?.id).toBe("swB");
  });
});

// ─── resolveFirewallRefsByName ───────────────────────────────────────────────

describe("resolveFirewallRefsByName", () => {
  it("returns an empty map without querying for no usable names", async () => {
    expect((await resolveFirewallRefsByName([])).size).toBe(0);
    expect((await resolveFirewallRefsByName(["", "   ", null as unknown as string])).size).toBe(0);
    expect(findMany).not.toHaveBeenCalled();
  });

  it("resolves FMG device names and hostnames to firewalls in one query, keyed by the trimmed name", async () => {
    seed([
      row("a", "firewall", { hostname: "host-a", fortinetTopology: gateTopo("FMG-A") }),
      row("b", "firewall", { hostname: "GATE-B" }),
      row("sw", "switch", { hostname: "GATE-C" }),
    ]);
    const out = await resolveFirewallRefsByName([" FMG-A ", "GATE-B", "GATE-B", "GATE-C", "NOPE"]);
    expect(findMany).toHaveBeenCalledTimes(1);
    expect([...out.keys()].sort()).toEqual(["FMG-A", "GATE-B"]);
    expect(out.get("FMG-A")).toMatchObject({ id: "a", hostname: "host-a", assetType: "firewall", managementAccess: null });
    // A switch with the name is not a firewall.
    expect(out.has("GATE-C")).toBe(false);
    const branches = findMany.mock.calls[0][0].where.OR as Array<{ assetType: string }>;
    expect(branches).toHaveLength(4); // FMG-A, GATE-B, GATE-C, NOPE — deduped
    expect(branches.every((b) => b.assetType === "firewall")).toBe(true);
  });

  it("leaves a name two firewalls share by hostname unresolved", async () => {
    seed([row("a", "firewall", { hostname: "DUP" }), row("b", "firewall", { hostname: "DUP" })]);
    expect((await resolveFirewallRefsByName(["DUP"])).has("DUP")).toBe(false);
  });
});
