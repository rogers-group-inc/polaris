/**
 * tests/unit/snmpCollectors.test.ts — the SNMP collectors against a fake agent
 * (CQ-T010).
 *
 * Complements, does not repeat:
 *   - fcPortCounters.test.ts — snmpWwnFromPhysAddress, attachFcErrors
 *   - readProfileIdentity.test.ts — readProfileIdentity (rule 171)
 *   - probes.test.ts / systemInfoPersist.test.ts — mock this module wholesale
 *   - the pure decoders each collector leans on have their own util suites
 *     (ifMib, poePorts, macForwarding, hardwareSensors, portVlans, …)
 *
 * Here the real snmpWalk / snmpGetScalar / snmpMultiGet run against a fake
 * net-snmp session that answers from an in-memory OID table, so what is under
 * test is each collector's own choices: which tables it asks, which fallback
 * it takes when one answers nothing, how rows join and which ones it drops,
 * and the undefined-preserves / []-wipes contract. Nothing touches a socket.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import * as snmp from "net-snmp";

const h = vi.hoisted(() => ({
  profile: null as unknown,
  symbols: new Map<string, string>(),
  byMac: new Map<string, string>(),
}));

vi.mock("../../src/db.js", () => import("./_dbStub.js"));
vi.mock("../../src/services/monitoring/snmpCore.js", async (orig) => ({
  ...(await orig<object>()),
  // The real gate + session builder would open a UDP socket; hand the
  // collector the fake session instead.
  withSnmpSession: async (_host: string, _cfg: unknown, fn: (s: unknown) => Promise<unknown>) => fn(fakeSession),
}));
vi.mock("../../src/services/profileResolver.js", async (orig) => ({
  ...(await orig<object>()),
  pickDbProfile: vi.fn(() => h.profile),
}));
vi.mock("../../src/services/oidRegistry.js", async (orig) => ({
  ...(await orig<object>()),
  ensureRegistryLoaded: vi.fn(async () => undefined),
  resolveOidSync: vi.fn((symbol: string) => h.symbols.get(symbol) ?? null),
}));
vi.mock("../../src/services/monitoring/lldpMatchIndex.js", async (orig) => ({
  ...(await orig<object>()),
  getLldpAssetMatchIndex: vi.fn(async () => ({ byMac: h.byMac })),
}));

import { prisma } from "../../src/db.js";
import { resetDbStub, stubbed } from "./_dbStub.js";
import { OID } from "../../src/services/monitoring/snmpCore.js";
import { pickDbProfile } from "../../src/services/profileResolver.js";
import {
  profileSubjectFor,
  snmpVendorScope,
  snmpWalkRaw,
  collectTelemetrySnmp,
  collectHardwareSensorsSnmp,
  collectVendorDiskFallback,
  persistPhysicalEntities,
  persistTrunkMembers,
  persistMacTable,
  collectSystemInfoSnmp,
  collectFastFilteredSnmp,
  collectLldpOnlySnmp,
} from "../../src/services/monitoring/snmpCollectors.js";

// ─── The fake agent ─────────────────────────────────────────────────────────

type Vb = { type: number; value: unknown };
let agent = new Map<string, Vb>();
/** OIDs the agent was asked for by GET, in order. */
let gets: string[][] = [];
/** Subtrees walked, in order. */
let walks: string[] = [];

function cmpOid(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.min(pa.length, pb.length); i++) if (pa[i] !== pb[i]) return pa[i] - pb[i];
  return pa.length - pb.length;
}

const fakeSession = {
  subtree(base: string, _maxRep: number, feed: (vbs: unknown[]) => boolean | void, done: (err?: Error) => void) {
    walks.push(base);
    const rows = [...agent.entries()]
      .filter(([oid]) => oid.startsWith(base + "."))
      .sort(([a], [b]) => cmpOid(a, b))
      .map(([oid, vb]) => ({ oid, ...vb }));
    if (rows.length && feed(rows) === true) return;
    done();
  },
  get(oids: string[], cb: (err: Error | null, vbs: unknown[]) => void) {
    gets.push([...oids]);
    cb(null, oids.map((oid) => agent.get(oid)
      ? { oid, ...agent.get(oid)! }
      : { oid, type: snmp.ObjectType.NoSuchInstance, value: null }));
  },
};

const int = (n: number): Vb => ({ type: snmp.ObjectType.Integer, value: n });
const str = (s: string): Vb => ({ type: snmp.ObjectType.OctetString, value: Buffer.from(s) });
const oidv = (s: string): Vb => ({ type: snmp.ObjectType.OID, value: s });
const bytes = (b: number[]): Vb => ({ type: snmp.ObjectType.OctetString, value: Buffer.from(b) });
const set = (oid: string, vb: Vb) => agent.set(oid, vb);

let hostSeq = 0;
/** PoE and ipAddressTable caches are keyed by host; a fresh one per test keeps tests apart. */
const host = () => `10.0.0.${++hostSeq}`;

beforeEach(() => {
  resetDbStub();
  agent = new Map();
  gets = [];
  walks = [];
  h.profile = null;
  h.symbols = new Map();
  h.byMac = new Map();
  vi.mocked(pickDbProfile).mockClear();
});

// ─── Small pure-ish exports ─────────────────────────────────────────────────

describe("profileSubjectFor (rule 173)", () => {
  it("is the asset's own identity, never a MIB pin", () => {
    expect(profileSubjectFor({ manufacturer: "Fortinet", model: "FS-148F" })).toEqual({
      manufacturer: "Fortinet", os: null, model: "FS-148F", assetType: null, mibModule: null,
    });
  });
});

describe("snmpVendorScope (rule 131)", () => {
  it("scopes at the asset's manufacturer/model, then the governing profile's", () => {
    h.profile = { profileManufacturer: "APC" };
    expect(snmpVendorScope({ manufacturer: "Schneider", model: "SMT1500", assetType: "ups" }))
      .toEqual({ manufacturer: "Schneider", model: "SMT1500", profileManufacturer: "APC" });
    expect(pickDbProfile).toHaveBeenCalledWith({ manufacturer: "Schneider", os: null, model: "SMT1500", assetType: "ups" });
  });

  it("names no profile manufacturer when nothing covers the asset", () => {
    expect(snmpVendorScope({ manufacturer: "Acme" }).profileManufacturer).toBeUndefined();
  });
});

// ─── snmpWalkRaw (the SNMP Walk tab) ────────────────────────────────────────

describe("snmpWalkRaw", () => {
  it("returns full OIDs with the ASN.1 type name and a printable value", async () => {
    set("1.3.6.1.2.1.1.1.0", str("FortiGate-60F v7.6.3  "));
    set("1.3.6.1.2.1.1.2.0", oidv("1.3.6.1.4.1.12356.101.1.1"));
    set("1.3.6.1.2.1.1.3.0", { type: snmp.ObjectType.TimeTicks, value: 12345 });
    set("1.3.6.1.2.1.1.9.0", { type: snmp.ObjectType.IpAddress, value: Buffer.from([10, 1, 2, 3]) });
    set("1.3.6.1.2.1.1.10.0", bytes([0x00, 0x1a, 0xff]));
    const r = await snmpWalkRaw(host(), {}, "1.3.6.1.2.1.1", 100);
    expect(r.truncated).toBe(false);
    expect(r.rows).toEqual([
      { oid: "1.3.6.1.2.1.1.1.0", type: "OctetString", value: "FortiGate-60F v7.6.3" },
      { oid: "1.3.6.1.2.1.1.2.0", type: "OID", value: "1.3.6.1.4.1.12356.101.1.1" },
      { oid: "1.3.6.1.2.1.1.3.0", type: "TimeTicks", value: "12345" },
      { oid: "1.3.6.1.2.1.1.9.0", type: "IpAddress", value: "10.1.2.3" },
      { oid: "1.3.6.1.2.1.1.10.0", type: "OctetString", value: "00 1A FF" },
    ]);
    expect(r.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("stops at the requested row cap and says it was truncated", async () => {
    for (let i = 1; i <= 10; i++) set(`1.3.6.1.2.1.2.2.1.2.${i}`, str(`port${i}`));
    const r = await snmpWalkRaw(host(), {}, "1.3.6.1.2.1.2.2.1.2", 3);
    expect(r.rows.map((x) => x.value)).toEqual(["port1", "port2", "port3"]);
    expect(r.truncated).toBe(true);
  });

  it("never asks for fewer than one row", async () => {
    set("1.3.6.1.2.1.2.2.1.2.1", str("a"));
    set("1.3.6.1.2.1.2.2.1.2.2", str("b"));
    const r = await snmpWalkRaw(host(), {}, "1.3.6.1.2.1.2.2.1.2", 0);
    expect(r.rows).toHaveLength(1);
    expect(r.truncated).toBe(true);
  });

  it("refuses an agent whose OIDs go backwards rather than looping forever", async () => {
    const looping = {
      subtree(_b: string, _m: number, feed: (vbs: unknown[]) => boolean | void, done: () => void) {
        feed([
          { oid: "1.3.6.1.2.1.1.5.0", ...str("x") },
          { oid: "1.3.6.1.2.1.1.1.0", ...str("y") },
        ]);
        done();
      },
    };
    // Swap the session's walk for this one test.
    const saved = fakeSession.subtree;
    fakeSession.subtree = looping.subtree as typeof fakeSession.subtree;
    try {
      await expect(snmpWalkRaw(host(), {}, "1.3.6.1.2.1.1", 100)).rejects.toThrow();
    } finally {
      fakeSession.subtree = saved;
    }
  });
});

// ─── Telemetry ──────────────────────────────────────────────────────────────

function hostResourcesRam(allocUnit: number, size: number, used: number) {
  set(`${OID.hrStorageType}.1`, oidv(OID.hrStorageFixedDisk));
  set(`${OID.hrStorageType}.3`, oidv(OID.hrStorageRam));
  set(`${OID.hrStorageAllocationUnits}.3`, int(allocUnit));
  set(`${OID.hrStorageSize}.3`, int(size));
  set(`${OID.hrStorageUsed}.3`, int(used));
}

describe("collectTelemetrySnmp", () => {
  it("with no profile, averages hrProcessorLoad", async () => {
    set(`${OID.hrProcessorLoad}.196608`, int(10));
    set(`${OID.hrProcessorLoad}.196609`, int(30));
    const t = await collectTelemetrySnmp(host(), {});
    expect(t.cpuPct).toBe(20);
  });

  // Was a bug until 2026-11-12 (fixed with this suite): collectMemoryHostResources walked
  // `hrStorageAllocationUnits.<ramIdx>` (and Size / Used) — a single LEAF
  // instance — then reads the result at key "". A subtree walk is GETNEXT /
  // GETBULK from the base OID, which never returns the base itself, and
  // snmpWalk only keeps OIDs under `base + "."`, so the map is always empty and
  // every HOST-RESOURCES memory figure is null. Any SNMP host with no vendor
  // memory row (net-snmp on Linux, Windows SNMP) gets no memory at all. A GET
  // of the three instances (snmpMultiGet / snmpGetScalar) is what was meant.
  it("with no profile, reads RAM from hrStorage (HOST-RESOURCES memory)", async () => {
    hostResourcesRam(1024, 1000, 250);
    const t = await collectTelemetrySnmp(host(), {});
    expect(t).toMatchObject({ memPct: 25, memUsedBytes: 256_000, memTotalBytes: 1_024_000 });
  });

  it("reads nothing as null, never as zero", async () => {
    const t = await collectTelemetrySnmp(host(), {});
    expect(t).toEqual({ cpuPct: null, memPct: null, memUsedBytes: null, memTotalBytes: null });
  });

  it("a scalar vendor CPU symbol wins over HOST-RESOURCES", async () => {
    h.profile = { vendor: "Fortinet", profileManufacturer: "Fortinet", cpu: { symbol: "fsSysCpuUsage", mode: "scalar" } };
    h.symbols.set("fsSysCpuUsage", "1.3.6.1.4.1.12356.106.4.1.2");
    set("1.3.6.1.4.1.12356.106.4.1.2.0", int(42));
    set(`${OID.hrProcessorLoad}.1`, int(90));
    const t = await collectTelemetrySnmp(host(), {}, "Fortinet", "FS-148F");
    expect(t.cpuPct).toBe(42);
  });

  it("falls back to HOST-RESOURCES when the vendor scalar is unanswered (not a confident 0)", async () => {
    h.profile = { vendor: "Fortinet", profileManufacturer: "Fortinet", cpu: { symbol: "fsSysCpuUsage", mode: "scalar" } };
    h.symbols.set("fsSysCpuUsage", "1.3.6.1.4.1.12356.106.4.1.2");
    set(`${OID.hrProcessorLoad}.1`, int(90));
    const t = await collectTelemetrySnmp(host(), {}, "Fortinet");
    expect(t.cpuPct).toBe(90);
  });

  it("falls back when the vendor symbol's MIB is not uploaded (unresolved)", async () => {
    h.profile = { vendor: "Juniper", cpu: { symbol: "jnxOperatingCPU", mode: "walk-avg" } };
    set(`${OID.hrProcessorLoad}.1`, int(55));
    const t = await collectTelemetrySnmp(host(), {}, "Juniper");
    expect(t.cpuPct).toBe(55);
  });

  it("walk-avg averages every row of the vendor column", async () => {
    h.profile = { vendor: "Juniper", cpu: { symbol: "jnxOperatingCPU", mode: "walk-avg" } };
    h.symbols.set("jnxOperatingCPU", "1.3.6.1.4.1.2636.3.1.13.1.8");
    set("1.3.6.1.4.1.2636.3.1.13.1.8.9.1", int(4));
    set("1.3.6.1.4.1.2636.3.1.13.1.8.9.2", int(8));
    const t = await collectTelemetrySnmp(host(), {}, "Juniper");
    expect(t.cpuPct).toBe(6);
  });

  it("vendor memory: used + free completes the total and the percentage", async () => {
    h.profile = { vendor: "X", memory: { usedBytesSymbol: "memUsed", freeBytesSymbol: "memFree" } };
    h.symbols.set("memUsed", "1.3.6.1.4.1.9.1");
    h.symbols.set("memFree", "1.3.6.1.4.1.9.2");
    set("1.3.6.1.4.1.9.1.0", int(300));
    set("1.3.6.1.4.1.9.2.0", int(700));
    hostResourcesRam(1, 10, 9); // must NOT be consulted
    const t = await collectTelemetrySnmp(host(), {}, "X");
    expect(t).toMatchObject({ memUsedBytes: 300, memTotalBytes: 1000, memPct: 30 });
  });

  it("vendor memory: a walked percentage column is averaged across rows, not summed", async () => {
    h.profile = { vendor: "Juniper", memory: { pctSymbol: "jnxOperatingBuffer", walkSubtree: true } };
    h.symbols.set("jnxOperatingBuffer", "1.3.6.1.4.1.2636.3.1.13.1.11");
    set("1.3.6.1.4.1.2636.3.1.13.1.11.1", int(40));
    set("1.3.6.1.4.1.2636.3.1.13.1.11.2", int(60));
    const t = await collectTelemetrySnmp(host(), {}, "Juniper");
    expect(t.memPct).toBe(50);
    expect(t.memUsedBytes).toBeNull();
  });

  // Same bug as above (fixed): the fallback was taken, but HOST-RESOURCES memory read null.
  it("vendor memory that answers nothing falls back to HOST-RESOURCES", async () => {
    h.profile = { vendor: "X", memory: { usedBytesSymbol: "memUsed", totalBytesSymbol: "memTotal" } };
    h.symbols.set("memUsed", "1.3.6.1.4.1.9.1");
    h.symbols.set("memTotal", "1.3.6.1.4.1.9.3");
    hostResourcesRam(1, 200, 50);
    const t = await collectTelemetrySnmp(host(), {}, "X");
    expect(t).toMatchObject({ memUsedBytes: 50, memTotalBytes: 200, memPct: 25 });
  });
});

// ─── Hardware sensors ───────────────────────────────────────────────────────

describe("collectHardwareSensorsSnmp", () => {
  it("scales ENTITY-SENSOR readings by SI prefix and precision", async () => {
    // celsius(8), units(9), precision 1 → 452 means 45.2
    set(`${OID.entPhySensorType}.1`, int(8));
    set(`${OID.entPhySensorType}.2`, int(4)); // voltsDC — a second code makes the type column trusted
    set(`${OID.entPhySensorValue}.1`, int(452));
    set(`${OID.entPhySensorValue}.2`, int(12));
    set(`${OID.entPhySensorScale}.1`, int(9));
    set(`${OID.entPhySensorPrecision}.1`, int(1));
    set(`${OID.entPhySensorOperStatus}.1`, int(1));
    set(`${OID.entPhySensorOperStatus}.2`, int(1));
    set(`${OID.entPhysicalDescr}.1`, str("CPU Temp"));
    const rows = await collectHardwareSensorsSnmp(fakeSession);
    expect(rows[0]).toMatchObject({ sensorName: "CPU Temp", sensorClass: "temperature", value: 45.2, alarmStatus: "ok" });
    // No descr → a positional name rather than an empty one.
    expect(rows[1]).toMatchObject({ sensorName: "sensor-2", value: 12 });
  });

  it("keeps a broken sensor's row with a null value — the row is the fault signal", async () => {
    set(`${OID.entPhySensorType}.7`, int(8));
    set(`${OID.entPhySensorValue}.7`, int(0));
    set(`${OID.entPhySensorOperStatus}.7`, int(3)); // nonoperational
    set(`${OID.entPhysicalDescr}.7`, str("Inlet Temp"));
    const rows = await collectHardwareSensorsSnmp(fakeSession);
    expect(rows).toEqual([expect.objectContaining({ sensorName: "Inlet Temp", value: null, alarmStatus: "alarm" })]);
  });

  it("appends unit-level PoE: consumption carries the PSE alarm, the budget does not", async () => {
    set(`${OID.pethMainPsePower}.1`, int(370));
    set(`${OID.pethMainPseConsumptionPower}.1`, int(55));
    set(`${OID.pethMainPseOperStatus}.1`, int(3)); // faulty
    const rows = await collectHardwareSensorsSnmp(fakeSession);
    expect(rows).toEqual([
      { sensorName: "PoE Power Consumption", sensorClass: "poe", value: 55, unit: "W", alarmStatus: "alarm" },
      { sensorName: "PoE Power Budget", sensorClass: "poe", value: 370, unit: "W", alarmStatus: null },
    ]);
  });

  it("suffixes PoE rows with the PSE index only on a multi-PSE device", async () => {
    set(`${OID.pethMainPseConsumptionPower}.1`, int(10));
    set(`${OID.pethMainPseConsumptionPower}.2`, int(20));
    const rows = await collectHardwareSensorsSnmp(fakeSession);
    expect(rows.map((r) => r.sensorName)).toEqual(["PoE Power Consumption (PSE 1)", "PoE Power Consumption (PSE 2)"]);
  });

  it("a scalar temperature profile is read when ENTITY-SENSOR is silent, through its transform", async () => {
    const profile = { vendor: "Fortinet", temperature: { mode: "scalar", symbol: "fapTemperature", transform: "tenths_to_units", sensorName: "AP" } };
    h.symbols.set("fapTemperature", "1.3.6.1.4.1.12356.120.3.44");
    set("1.3.6.1.4.1.12356.120.3.44.0", int(487));
    const rows = await collectHardwareSensorsSnmp(fakeSession, profile as never, {});
    expect(rows).toEqual([{ sensorName: "AP", sensorClass: "temperature", value: 48.7, unit: "°C", alarmStatus: null }]);
  });

  it("an unresolved scalar symbol yields no rows rather than a guess", async () => {
    const profile = { vendor: "Fortinet", temperature: { mode: "scalar", symbol: "fapTemperature" } };
    const rows = await collectHardwareSensorsSnmp(fakeSession, profile as never, {});
    expect(rows).toEqual([]);
  });

  it("a table profile whose walk is empty falls through to ENTITY-SENSOR", async () => {
    const profile = { vendor: "Fortinet", temperature: { mode: "table", symbol: "fgHwSensorEntValue" } };
    h.symbols.set("fgHwSensorEntValue", "1.3.6.1.4.1.12356.101.4.3.2.1.3");
    set(`${OID.entPhySensorType}.1`, int(8));
    set(`${OID.entPhySensorValue}.1`, int(30));
    set(`${OID.entPhySensorOperStatus}.1`, int(1));
    set(`${OID.entPhysicalDescr}.1`, str("Board"));
    const rows = await collectHardwareSensorsSnmp(fakeSession, profile as never, {});
    expect(rows).toEqual([expect.objectContaining({ sensorName: "Board", value: 30 })]);
    expect(walks).toContain("1.3.6.1.4.1.12356.101.4.3.2.1.3");
  });
});

// ─── Vendor disk fallback ───────────────────────────────────────────────────

describe("collectVendorDiskFallback", () => {
  const scope = {};

  it("is null without a disk block, or with fewer than two resolvable symbols", async () => {
    expect(await collectVendorDiskFallback(fakeSession, null, scope)).toBeNull();
    h.symbols.set("diskUsed", "1.3.6.1.4.1.1.1");
    const p = { disk: { usedBytesSymbol: "diskUsed", totalBytesSymbol: "diskTotal" } };
    expect(await collectVendorDiskFallback(fakeSession, p as never, scope)).toBeNull();
    expect(gets).toEqual([]); // nothing dialed
  });

  it("completes used/total from whichever pair the profile names", async () => {
    h.symbols.set("diskTotal", "1.3.6.1.4.1.1.2");
    h.symbols.set("diskFree", "1.3.6.1.4.1.1.3");
    set("1.3.6.1.4.1.1.2.0", int(1000));
    set("1.3.6.1.4.1.1.3.0", int(250));
    const p = { disk: { totalBytesSymbol: "diskTotal", freeBytesSymbol: "diskFree", mountPath: "/flash" } };
    expect(await collectVendorDiskFallback(fakeSession, p as never, scope)).toEqual({ mountPath: "/flash", usedBytes: 750, totalBytes: 1000 });
  });

  it("never GETs a symbol the profile did not declare, and defaults the mount to 'system'", async () => {
    h.symbols.set("diskUsed", "1.3.6.1.4.1.1.1");
    h.symbols.set("diskFree", "1.3.6.1.4.1.1.3");
    h.symbols.set("diskTotal", "1.3.6.1.4.1.1.2");
    set("1.3.6.1.4.1.1.1.0", int(10));
    set("1.3.6.1.4.1.1.3.0", int(30));
    const p = { disk: { usedBytesSymbol: "diskUsed", freeBytesSymbol: "diskFree" } };
    expect(await collectVendorDiskFallback(fakeSession, p as never, scope)).toEqual({ mountPath: "system", usedBytes: 10, totalBytes: 40 });
    expect(gets.flat()).not.toContain("1.3.6.1.4.1.1.2.0");
  });

  it("is null when both readings come back empty", async () => {
    h.symbols.set("diskUsed", "1.3.6.1.4.1.1.1");
    h.symbols.set("diskTotal", "1.3.6.1.4.1.1.2");
    const p = { disk: { usedBytesSymbol: "diskUsed", totalBytesSymbol: "diskTotal" } };
    expect(await collectVendorDiskFallback(fakeSession, p as never, scope)).toBeNull();
  });
});

// ─── Persisters ─────────────────────────────────────────────────────────────

describe("persistPhysicalEntities", () => {
  const row = (entIndex: number, serialNum: string | null) => ({
    entIndex, entClass: "module", descr: null, name: null, hardwareRev: null, firmwareRev: null,
    serialNum, mfgName: null, modelName: "SFP-10G", isFru: true, ifName: null,
  });

  it("delete-replaces, keeping firstSeen for a module still in its slot and resetting it for a swap", async () => {
    const march = new Date("2026-03-01T00:00:00Z");
    stubbed(prisma.assetPhysicalEntity.findMany).mockResolvedValue([
      { entIndex: 1, serialNum: "AAA", firstSeen: march },
      { entIndex: 2, serialNum: "BBB", firstSeen: march },
    ]);
    await persistPhysicalEntities("a1", [row(1, "AAA"), row(2, "CCC"), row(3, null)]);
    expect(prisma.assetPhysicalEntity.deleteMany).toHaveBeenCalledWith({ where: { assetId: "a1" } });
    const data = stubbed(prisma.assetPhysicalEntity.createMany).mock.calls[0][0].data;
    expect(data[0].firstSeen).toBe(march);
    expect(data[1].firstSeen).not.toBe(march);
    expect(data[1].firstSeen).toEqual(data[1].lastSeen);
    expect(data[2]).toMatchObject({ assetId: "a1", entIndex: 3 });
  });

  it("an empty inventory only deletes", async () => {
    stubbed(prisma.assetPhysicalEntity.findMany).mockResolvedValue([]);
    await persistPhysicalEntities("a1", []);
    expect(prisma.assetPhysicalEntity.deleteMany).toHaveBeenCalled();
    expect(prisma.assetPhysicalEntity.createMany).not.toHaveBeenCalled();
  });
});

describe("persistTrunkMembers", () => {
  it("matches the peer by serial suffix, refuses an ambiguous tail, keeps firstSeen", async () => {
    const then = new Date("2026-01-01T00:00:00Z");
    stubbed(prisma.assetTrunkMember.findMany).mockResolvedValue([{ trunkName: "8EF5920000001-0", localPort: "port23", firstSeen: then }]);
    stubbed(prisma.asset.findMany).mockResolvedValue([
      { id: "peer", serialNumber: "S108EF5920000001" },
      { id: "x1", serialNumber: "AAZZ7777777777" },
      { id: "x2", serialNumber: "BBZZ7777777777" },
    ]);
    await persistTrunkMembers("sw", [
      { trunkName: "8EF5920000001-0", localPort: "port23", peerSerialTail: "8EF5920000001" },
      { trunkName: "ZZ7777777777-0", localPort: "port24", peerSerialTail: "ZZ7777777777" },
    ]);
    expect(prisma.asset.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { serialNumber: { not: null } } }));
    const data = stubbed(prisma.assetTrunkMember.createMany).mock.calls[0][0].data;
    expect(data[0]).toMatchObject({ assetId: "sw", matchedAssetId: "peer", firstSeen: then });
    expect(data[1].matchedAssetId).toBeNull();
  });
});

describe("persistMacTable", () => {
  it("matches each MAC through the shared LLDP index and keeps firstSeen per (mac, vlan)", async () => {
    const then = new Date("2026-02-02T00:00:00Z");
    h.byMac.set("AA:BB:CC:00:00:01", "printer");
    stubbed(prisma.assetMacTableEntry.findMany).mockResolvedValue([
      { macAddress: "AA:BB:CC:00:00:01", vlanId: 10, firstSeen: then },
      { macAddress: "AA:BB:CC:00:00:02", vlanId: null, firstSeen: then },
    ]);
    await persistMacTable("sw", [
      { macAddress: "AA:BB:CC:00:00:01", vlanId: 10, basePort: 5, ifName: "port5", status: "learned" },
      { macAddress: "AA:BB:CC:00:00:01", vlanId: 20, basePort: 5, ifName: "port5", status: "learned" },
      { macAddress: "AA:BB:CC:00:00:02", vlanId: null, basePort: null, ifName: null, status: "learned" },
    ]);
    const data = stubbed(prisma.assetMacTableEntry.createMany).mock.calls[0][0].data;
    expect(data[0]).toMatchObject({ matchedAssetId: "printer", firstSeen: then });
    expect(data[1].firstSeen).not.toBe(then); // same MAC, new VLAN → a new sighting
    expect(data[2]).toMatchObject({ matchedAssetId: null, firstSeen: then });
  });
});

// ─── Full system-info pass ──────────────────────────────────────────────────

function twoPortSwitch() {
  set(`${OID.ifDescr}.1`, str("port1 descr"));
  set(`${OID.ifName}.1`, str("port1"));
  set(`${OID.ifName}.2`, str("port2"));
  set(`${OID.ifDescr}.99`, str("")); // no name, no descr → dropped
  set(`${OID.ifOperStatus}.99`, int(1));
  set(`${OID.ifAdminStatus}.1`, int(1));
  set(`${OID.ifOperStatus}.1`, int(1));
  set(`${OID.ifAdminStatus}.2`, int(1));
  set(`${OID.ifOperStatus}.2`, int(2));
  set(`${OID.ifHighSpeed}.1`, int(10_000));
  set(`${OID.ifSpeed}.2`, int(100_000_000));
  set(`${OID.ifHCInOctets}.1`, int(5_000_000_000));
  set(`${OID.ifInOctets}.1`, int(7));
  set(`${OID.ifInOctets}.2`, int(77));
  set(`${OID.ifType}.1`, int(6));
  set(`${OID.ifAlias}.1`, str("  uplink  "));
  set(`${OID.ifAlias}.2`, str("   "));
  set(`${OID.ifPhysAddress}.1`, bytes([0, 9, 15, 0xaa, 0xbb, 0xcc]));
  set(`${OID.dot3StatsDuplexStatus}.1`, int(3));
  set(`${OID.dot3StatsDuplexStatus}.2`, int(3)); // stale on a down link
}

describe("collectSystemInfoSnmp", () => {
  it("assembles interfaces: HC counters and ifHighSpeed preferred, duplex only while up, nameless rows dropped", async () => {
    twoPortSwitch();
    const s = await collectSystemInfoSnmp(host(), {}, { includeLldp: false });
    expect(s.interfaces.map((i) => i.ifName)).toEqual(["port1", "port2"]);
    const [p1, p2] = s.interfaces;
    expect(p1).toMatchObject({
      adminStatus: "up", operStatus: "up", speedBps: 10_000_000_000, inOctets: 5_000_000_000,
      ifType: "physical", alias: "uplink", duplex: "full", macAddress: "00:09:0F:AA:BB:CC",
    });
    expect(p2).toMatchObject({ operStatus: "down", speedBps: 100_000_000, inOctets: 77, alias: null, duplex: null });
    expect(s.lldpSource).toBeUndefined();
    expect(s.lldpNeighbors).toBeUndefined();
  });

  it("collects fixed and removable disks from hrStorage, scaled by allocation unit", async () => {
    set(`${OID.hrStorageType}.1`, oidv(OID.hrStorageFixedDisk));
    set(`${OID.hrStorageType}.2`, oidv(OID.hrStorageRam));
    set(`${OID.hrStorageType}.3`, oidv(OID.hrStorageRemovableDisk));
    set(`${OID.hrStorageDescr}.1`, str("/"));
    set(`${OID.hrStorageAllocationUnits}.1`, int(4096));
    set(`${OID.hrStorageSize}.1`, int(100));
    set(`${OID.hrStorageUsed}.1`, int(25));
    const s = await collectSystemInfoSnmp(host(), {}, { includeLldp: false });
    expect(s.storage).toEqual([
      { mountPath: "/", totalBytes: 409_600, usedBytes: 102_400 },
      { mountPath: "disk-3", totalBytes: null, usedBytes: null },
    ]);
  });

  it("uses the vendor disk fallback only when hrStorage has no disks", async () => {
    h.profile = { vendor: "Fortinet", disk: { usedBytesSymbol: "u", totalBytesSymbol: "t" } };
    h.symbols.set("u", "1.3.6.1.4.1.5.1");
    h.symbols.set("t", "1.3.6.1.4.1.5.2");
    set("1.3.6.1.4.1.5.1.0", int(5));
    set("1.3.6.1.4.1.5.2.0", int(50));
    const s = await collectSystemInfoSnmp(host(), {}, { includeLldp: false, manufacturer: "Fortinet" });
    expect(s.storage).toEqual([{ mountPath: "system", usedBytes: 5, totalBytes: 50 }]);
  });

  it("reads sysDescr, sysName and sysObjectID in one batch and keeps them on the sample", async () => {
    set("1.3.6.1.2.1.1.1.0", str("Linux nas 6.1"));
    set("1.3.6.1.2.1.1.5.0", str("nas01"));
    set("1.3.6.1.2.1.1.2.0", oidv("1.3.6.1.4.1.8072.3.2.10"));
    const s = await collectSystemInfoSnmp(host(), {}, { includeLldp: false });
    expect(s.sysDescr).toBe("Linux nas 6.1");
    expect(s.sysObjectId).toBe("1.3.6.1.4.1.8072.3.2.10");
    expect(s.selfIdentity).toMatchObject({ hostname: "nas01" });
    expect(gets[0]).toEqual(expect.arrayContaining(["1.3.6.1.2.1.1.1.0", "1.3.6.1.2.1.1.5.0", "1.3.6.1.2.1.1.2.0"]));
  });

  it("a profile model row is read and parsed; it then outranks the chassis model", async () => {
    h.profile = { vendor: "Fortinet", model: { symbol: "fsSysVersion", parse: (raw: string) => raw.split(" ")[0] } };
    h.symbols.set("fsSysVersion", "1.3.6.1.4.1.12356.106.4.1.1");
    set("1.3.6.1.4.1.12356.106.4.1.1.0", str("S548DF v7.4.2"));
    set("1.3.6.1.2.1.1.5.0", str("sw1"));
    set(`${OID.entPhysicalClass}.1`, int(3)); // chassis
    set(`${OID.entPhysicalModelName}.1`, str("FS-548D-FPOE"));
    const s = await collectSystemInfoSnmp(host(), {}, { includeLldp: false, manufacturer: "Fortinet" });
    expect(s.detectedModel).toBe("S548DF");
    expect(s.selfIdentity?.model).toBeUndefined();
  });

  it("overlays per-port PoE onto the interfaces by inferred port number", async () => {
    twoPortSwitch();
    set(`${OID.pethPsePortDetectionStatus}.1.1`, int(3));
    set(`${OID.pethPsePortPowerClassifications}.1.1`, int(4));
    const s = await collectSystemInfoSnmp(host(), {}, { includeLldp: false });
    expect(s.interfaces[0]).toMatchObject({ poeStatus: "delivering", poeClass: "class3" });
    expect(s.interfaces[1].poeStatus).toBeUndefined();
  });

  it("keeps FRU inventory, drops scaffolding, and returns undefined physical entities only when the table is absent", async () => {
    let s = await collectSystemInfoSnmp(host(), {}, { includeLldp: false });
    expect(s.physicalEntities).toEqual([]);
    set(`${OID.entPhysicalClass}.10`, int(9)); // module
    set(`${OID.entPhysicalSerialNum}.10`, str("SFP123"));
    set(`${OID.entPhysicalClass}.11`, int(9)); // module, nothing identifying
    set(`${OID.entPhysicalClass}.12`, int(10)); // port, FRU
    set(`${OID.entPhysicalIsFRU}.12`, int(1));
    s = await collectSystemInfoSnmp(host(), {}, { includeLldp: false });
    expect(s.physicalEntities!.map((e) => e.entIndex)).toEqual([10, 12]);
    expect(s.physicalEntities![0]).toMatchObject({ serialNum: "SFP123", isFru: false, ifName: null });
  });

  it("walks the forwarding database on a switch only, Q-BRIDGE first, joined through dot1dBasePort", async () => {
    twoPortSwitch();
    set(`${OID.dot1dBasePortIfIndex}.5`, int(2));
    const mac = "170.187.204.0.0.1";
    set(`${OID.dot1qTpFdbPort}.10.${mac}`, int(5));
    set(`${OID.dot1qTpFdbStatus}.10.${mac}`, int(3));
    set(`${OID.dot1qTpFdbPort}.10.170.187.204.0.0.2`, int(5));
    set(`${OID.dot1qTpFdbStatus}.10.170.187.204.0.0.2`, int(2)); // invalid — aged out
    let s = await collectSystemInfoSnmp(host(), {}, { includeLldp: false, assetType: "server" });
    expect(s.macTable).toBeUndefined();
    s = await collectSystemInfoSnmp(host(), {}, { includeLldp: false, assetType: "switch" });
    expect(s.macTable).toEqual([{ macAddress: "AA:BB:CC:00:00:01", vlanId: 10, basePort: 5, ifName: "port2", status: "learned" }]);
    expect(walks).not.toContain(OID.dot1dTpFdbPort);
  });

  it("falls back to BRIDGE-MIB when Q-BRIDGE answers nothing (no VLAN dimension)", async () => {
    twoPortSwitch();
    set(`${OID.dot1dBasePortIfIndex}.1`, int(1));
    set(`${OID.dot1dTpFdbPort}.170.187.204.0.0.3`, int(1));
    set(`${OID.dot1dTpFdbStatus}.170.187.204.0.0.3`, int(3));
    const s = await collectSystemInfoSnmp(host(), {}, { includeLldp: false, assetType: "switch" });
    expect(s.macTable).toEqual([{ macAddress: "AA:BB:CC:00:00:03", vlanId: null, basePort: 1, ifName: "port1", status: "learned" }]);
    expect(s.trunkMembers).toBeUndefined(); // no fsTrunkMember: preserve, never wipe
  });

  it("LLDP: undefined when the device has no LLDP-MIB, so stored neighbours survive", async () => {
    const s = await collectSystemInfoSnmp(host(), {}, {});
    expect(s.lldpSource).toBe("snmp");
    expect(s.lldpNeighbors).toBeUndefined();
  });
});

// ─── Fast filtered pass ─────────────────────────────────────────────────────

describe("collectFastFilteredSnmp", () => {
  it("returns only the pinned interfaces and storage, from one multi-GET", async () => {
    twoPortSwitch();
    set(`${OID.hrStorageDescr}.31`, str("/var"));
    set(`${OID.hrStorageDescr}.32`, str("/tmp"));
    set(`${OID.hrStorageAllocationUnits}.31`, int(1024));
    set(`${OID.hrStorageSize}.31`, int(10));
    set(`${OID.hrStorageUsed}.31`, int(4));
    const s = await collectFastFilteredSnmp(host(), {}, { wantedIfaces: ["port1", "gone9"], wantedStorage: ["/var"] });
    expect(s.interfaces).toHaveLength(1);
    expect(s.interfaces[0]).toMatchObject({ ifName: "port1", speedBps: 10_000_000_000, inOctets: 5_000_000_000, duplex: "full", alias: "uplink", fcErrors: null });
    expect(s.storage).toEqual([{ mountPath: "/var", totalBytes: 10_240, usedBytes: 4096 }]);
    expect(s.lldpNeighbors).toBeUndefined();
    // Discovery walks only the name columns, never the counter columns.
    expect(walks).not.toContain(OID.ifHCInOctets);
    const asked = gets.flat();
    expect(asked).toContain(`${OID.ifHCInOctets}.1`);
    expect(asked).not.toContain(`${OID.ifHCInOctets}.2`);
  });

  it("matches a pinned name through ifDescr when the device has no ifName", async () => {
    set(`${OID.ifDescr}.4`, str("eth0"));
    set(`${OID.ifOperStatus}.4`, int(1));
    const s = await collectFastFilteredSnmp(host(), {}, { wantedIfaces: ["eth0"], wantedStorage: [] });
    expect(s.interfaces.map((i) => i.ifName)).toEqual(["eth0"]);
  });

  it("asks nothing beyond the discovery walk when no pinned name resolves", async () => {
    twoPortSwitch();
    const s = await collectFastFilteredSnmp(host(), {}, { wantedIfaces: ["nope"], wantedStorage: [] });
    expect(s.interfaces).toEqual([]);
    expect(gets).toEqual([]);
    expect(walks).not.toContain(OID.hrStorageDescr);
  });
});

// ─── LLDP only ──────────────────────────────────────────────────────────────

describe("collectLldpOnlySnmp", () => {
  it("is undefined when the device publishes no LLDP tables", async () => {
    expect(await collectLldpOnlySnmp(host(), {})).toBeUndefined();
  });

  it("is [] when the local port table answers but no neighbour does (the caller wipes)", async () => {
    set(`${OID.lldpLocPortDesc}.3`, str("port3"));
    expect(await collectLldpOnlySnmp(host(), {})).toEqual([]);
  });

  it("builds a neighbour: local port label, MAC chassis id, names and the IPv4 management address", async () => {
    // Local port 3 by interfaceName subtype (5).
    set(`${OID.lldpLocPortIdSubtype}.3`, int(5));
    set(`${OID.lldpLocPortId}.3`, str("port3"));
    const sfx = "0.3.1";
    set(`${OID.lldpRemChassisIdSubtype}.${sfx}`, int(4));
    set(`${OID.lldpRemChassisId}.${sfx}`, bytes([0x00, 0x09, 0x0f, 0x01, 0x02, 0x03]));
    set(`${OID.lldpRemSysName}.${sfx}`, str(" core-sw "));
    set(`${OID.lldpRemPortDesc}.${sfx}`, str(""));
    set(`${OID.lldpRemManAddr}.3.0.3.1.1.4.10.9.8.7`, int(2));
    const n = await collectLldpOnlySnmp(host(), {});
    expect(n).toHaveLength(1);
    expect(n![0]).toMatchObject({
      localIfName: "port3",
      chassisId: "00:09:0F:01:02:03",
      systemName: "core-sw",
      portDescription: null,
      managementIp: "10.9.8.7",
    });
  });

  it("names an unlabelled local port by its number", async () => {
    set(`${OID.lldpRemChassisId}.0.7.1`, str("chassis-x"));
    const n = await collectLldpOnlySnmp(host(), {});
    expect(n![0]).toMatchObject({ localIfName: "port-7", chassisId: "chassis-x", managementIp: null });
  });
});
