/**
 * tests/unit/vcenterFmgCollectors.test.ts — the own suite for
 * src/services/monitoring/vcenterFmgCollectors.ts (CQ-T010).
 *
 * Pins the "ask the manager, not the device" probes and collectors:
 *   - the FortiManager roster probe keys by SERIAL (never the FMG device name,
 *     the fortinetParentKey trap), lets an ha_slave row win, and SKIPS rather
 *     than fails when FMG cannot be asked (the rule 30 posture);
 *   - readVcenterAsset's four outcomes (vm / host / absent / unreachable),
 *     resolved through the AssetSource row, a disabled integration being
 *     unreachable and a host-property failure never caching an empty map;
 *   - the warm caches: one upstream call per TTL, in-flight coalescing, a
 *     failure never cached;
 *   - probe / telemetry verdicts (power state vs connection state), and the
 *     system-info shaping (vSwitch as the aggregate parent of its uplinks, the
 *     vmk's VLAN through its port group, a no-uplink vSwitch reading null).
 *
 * Caches are module-level, so every test uses a fresh integration id.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { performance } from "node:perf_hooks";
import { prisma } from "../../src/db.js";
import { resetDbStub, stubbed } from "./_dbStub.js";

const m = vi.hoisted(() => ({ quick: vi.fn(), hostSnap: vi.fn(), roster: vi.fn() }));
vi.mock("../../src/db.js", () => import("./_dbStub.js"));
vi.mock("../../src/services/vcenterService.js", () => ({
  fetchVcenterQuickStats: m.quick,
  fetchVcenterHostSnapshot: m.hostSnap,
}));
vi.mock("../../src/services/fortimanagerService.js", () => ({ fetchRosterConnectivity: m.roster }));
vi.mock("../../src/utils/logger.js", () => ({ logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

const {
  probeFortimanagerNative,
  readVcenterAsset,
  probeVcenter,
  collectTelemetryVcenter,
  buildVcenterSystemInfo,
  collectSystemInfoVcenter,
} = await import("../../src/services/monitoring/vcenterFmgCollectors.js");

const findSource = stubbed(prisma.assetSource.findFirst);

let seq = 0;
const nextInt = () => `int-${++seq}`;

beforeEach(() => {
  resetDbStub();
  m.quick.mockReset();
  m.hostSnap.mockReset();
  m.roster.mockReset();
});
afterEach(() => {
  vi.useRealTimers();
});

const MIB = 1024 * 1024;

function vm(over: Record<string, unknown> = {}) {
  return {
    moref: "vm-1", instanceUuid: "uuid-1", cpuUsageMhz: 500, cpuMaxMhz: 2000, guestMemUsageMB: 1024, hostMemUsageMB: 2048,
    memTotalMB: 4096, memPrivateBytes: 1, memSharedBytes: 2, memBalloonedBytes: 3, memSwappedBytes: 4, memCompressedBytes: 5,
    cpuCorePcts: [10, 20], powerState: "poweredOn", uptimeSec: 3600, guestDisks: null, guestNics: null, ...over,
  };
}

function host(over: Record<string, unknown> = {}) {
  return {
    moref: "host-1", name: "esx1", connectionState: "connected", powerState: "poweredOn", inMaintenanceMode: false,
    uptimeSec: 86400, cpuUsageMhz: 4000, cpuTotalMhz: 16000, memUsageBytes: 100, memTotalBytes: 400, cpuCorePcts: [1, 2],
    memBalloonedBytes: 7, memSwappedBytes: 8, pnics: null, vnics: null, vswitches: null, portgroups: null, fcHbas: null, ...over,
  };
}

function vmSource(integrationId: string, externalId = "uuid-1", integration: Record<string, unknown> = {}) {
  findSource.mockResolvedValue({
    externalId, sourceKind: "vcenter-vm",
    integration: { id: integrationId, type: "vcenter", config: { host: "vc" }, enabled: true, ...integration },
  });
}
function hostSource(integrationId: string, externalId = `${integrationId}:host-1`) {
  findSource.mockResolvedValue({
    externalId, sourceKind: "vcenter-host",
    integration: { id: integrationId, type: "vcenter", config: { host: "vc" }, enabled: true },
  });
}

// ─── FortiManager native probe ───────────────────────────────────────────────

describe("probeFortimanagerNative", () => {
  const fmg = (id: string) => ({ id, type: "fortimanager", config: { host: "fmg" } });
  const row = (serial: string, over: Record<string, unknown> = {}) => ({ name: "gate", serial, connected: true, raw: "conn_status=1", haMember: false, ...over });

  it("refuses a non-FortiManager integration without asking anything", async () => {
    const r = await probeFortimanagerNative({ serialNumber: "FG1", hostname: "g" }, { id: nextInt(), type: "fortigate", config: {} }, performance.now());
    expect(r.success).toBe(false);
    expect(r.error).toBe("FortiManager polling requires a FortiManager integration");
    expect(m.roster).not.toHaveBeenCalled();
  });

  it("refuses an asset with no serial", async () => {
    const r = await probeFortimanagerNative({ serialNumber: "  ", hostname: "g" }, fmg(nextInt()), performance.now());
    expect(r.error).toBe("Cannot poll via FortiManager — asset has no serial number recorded");
    expect(m.roster).not.toHaveBeenCalled();
  });

  it("succeeds for a connected gate found by its trimmed, upper-cased serial — not its hostname", async () => {
    const id = nextInt();
    m.roster.mockResolvedValue([row("FGT60F0001", { name: "fmg-device-name" })]);
    const r = await probeFortimanagerNative({ serialNumber: " fgt60f0001 ", hostname: "configured-hostname" }, fmg(id), performance.now());
    expect(r.success).toBe(true);
    expect(r.responseTimeMs).toBeGreaterThanOrEqual(0);
    expect(r.skipped).toBeUndefined();
    expect(m.roster).toHaveBeenCalledWith({ host: "fmg" }, undefined, id);
  });

  it("fails a gate absent from the roster", async () => {
    m.roster.mockResolvedValue([row("OTHER")]);
    const r = await probeFortimanagerNative({ serialNumber: "FG1", hostname: null }, fmg(nextInt()), performance.now());
    expect(r).toMatchObject({ success: false, error: "Not present in FortiManager's device roster" });
    expect(r.skipped).toBeUndefined();
  });

  it("fails a gate FortiManager reports disconnected, quoting FMG's raw signal", async () => {
    m.roster.mockResolvedValue([row("FG1", { connected: false, raw: "conn_status=2" })]);
    const r = await probeFortimanagerNative({ serialNumber: "FG1", hostname: null }, fmg(nextInt()), performance.now());
    expect(r).toMatchObject({ success: false, error: "FortiManager reports the device disconnected (conn_status=2)" });
  });

  it("skips — never fails — when FortiManager cannot be asked", async () => {
    m.roster.mockRejectedValue(new Error("FMG login failed"));
    const r = await probeFortimanagerNative({ serialNumber: "FG1", hostname: null }, fmg(nextInt()), performance.now());
    expect(r).toEqual({ success: false, responseTimeMs: 0, skipped: true, error: "FMG login failed" });
  });

  it("uses a generic reason when the roster failure carries no message", async () => {
    m.roster.mockRejectedValue({});
    const r = await probeFortimanagerNative({ serialNumber: "FG1", hostname: null }, fmg(nextInt()), performance.now());
    expect(r.error).toBe("FortiManager roster query failed");
  });

  it("lets the ha_slave row win over the top-level row for the same serial", async () => {
    m.roster.mockResolvedValue([
      row("FG1", { connected: true, haMember: false }),
      row("FG1", { connected: false, raw: "ha down", haMember: true }),
      row("FG1", { connected: true, haMember: false }),
    ]);
    const r = await probeFortimanagerNative({ serialNumber: "FG1", hostname: null }, fmg(nextInt()), performance.now());
    expect(r.success).toBe(false);
    expect(r.error).toContain("ha down");
  });

  it("serves every gate on one integration from one roster read within the TTL", async () => {
    const id = nextInt();
    m.roster.mockResolvedValue([row("FG1"), row("FG2")]);
    await probeFortimanagerNative({ serialNumber: "FG1", hostname: null }, fmg(id), performance.now());
    await probeFortimanagerNative({ serialNumber: "FG2", hostname: null }, fmg(id), performance.now());
    expect(m.roster).toHaveBeenCalledTimes(1);
  });

  it("coalesces concurrent probes into one in-flight read", async () => {
    const id = nextInt();
    let release!: (v: unknown) => void;
    m.roster.mockReturnValue(new Promise((res) => { release = res; }));
    const a = probeFortimanagerNative({ serialNumber: "FG1", hostname: null }, fmg(id), performance.now());
    const b = probeFortimanagerNative({ serialNumber: "FG1", hostname: null }, fmg(id), performance.now());
    release([row("FG1")]);
    expect((await a).success).toBe(true);
    expect((await b).success).toBe(true);
    expect(m.roster).toHaveBeenCalledTimes(1);
  });

  it("re-reads after the 30 s TTL", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-13T10:00:00Z"));
    const id = nextInt();
    m.roster.mockResolvedValue([row("FG1")]);
    await probeFortimanagerNative({ serialNumber: "FG1", hostname: null }, fmg(id), performance.now());
    vi.setSystemTime(new Date("2026-11-13T10:00:29Z"));
    await probeFortimanagerNative({ serialNumber: "FG1", hostname: null }, fmg(id), performance.now());
    expect(m.roster).toHaveBeenCalledTimes(1);
    vi.setSystemTime(new Date("2026-11-13T10:00:31Z"));
    await probeFortimanagerNative({ serialNumber: "FG1", hostname: null }, fmg(id), performance.now());
    expect(m.roster).toHaveBeenCalledTimes(2);
  });

  it("never caches a failed read", async () => {
    const id = nextInt();
    m.roster.mockRejectedValueOnce(new Error("blip")).mockResolvedValueOnce([row("FG1")]);
    expect((await probeFortimanagerNative({ serialNumber: "FG1", hostname: null }, fmg(id), performance.now())).skipped).toBe(true);
    expect((await probeFortimanagerNative({ serialNumber: "FG1", hostname: null }, fmg(id), performance.now())).success).toBe(true);
  });
});

// ─── readVcenterAsset ────────────────────────────────────────────────────────

describe("readVcenterAsset", () => {
  it("looks the source up by asset with a vcenter-vm row winning", async () => {
    findSource.mockResolvedValue(null);
    await readVcenterAsset("a1");
    const q = findSource.mock.calls[0][0];
    expect(q.where).toEqual({ assetId: "a1", sourceKind: { in: ["vcenter-vm", "vcenter-host"] } });
    expect(q.orderBy).toEqual({ sourceKind: "asc" });
  });

  it("is absent when the asset carries no vCenter source", async () => {
    findSource.mockResolvedValue(null);
    expect(await readVcenterAsset("a1")).toEqual({ kind: "absent", error: expect.stringContaining("no vCenter source on file") });
  });

  it("is absent when the source is not linked to a vCenter integration", async () => {
    findSource.mockResolvedValue({ externalId: "x", sourceKind: "vcenter-vm", integration: null });
    expect((await readVcenterAsset("a1")).kind).toBe("absent");
    findSource.mockResolvedValue({ externalId: "x", sourceKind: "vcenter-vm", integration: { id: "i", type: "activedirectory", config: {}, enabled: true } });
    expect(await readVcenterAsset("a1")).toEqual({ kind: "absent", error: "The asset's vCenter source is not linked to a vCenter integration" });
  });

  it("is unreachable — not absent — when the integration is disabled", async () => {
    vmSource(nextInt(), "uuid-1", { enabled: false });
    expect(await readVcenterAsset("a1")).toEqual({ kind: "unreachable", error: "The linked vCenter integration is disabled" });
    expect(m.quick).not.toHaveBeenCalled();
  });

  it("finds a VM by its instanceUuid, asking for per-core CPU", async () => {
    const id = nextInt();
    vmSource(id);
    m.quick.mockResolvedValue([vm()]);
    const r = await readVcenterAsset("a1");
    expect(r.kind).toBe("vm");
    expect(m.quick).toHaveBeenCalledWith({ host: "vc" }, undefined, { withPerCoreCpu: true });
  });

  it("also finds a VM by the integration-scoped moref key", async () => {
    const id = nextInt();
    vmSource(id, `${id}:vm-1`);
    m.quick.mockResolvedValue([vm({ instanceUuid: null })]);
    const r = await readVcenterAsset("a1");
    expect(r.kind).toBe("vm");
  });

  it("passes an empty config when the integration stored none", async () => {
    const id = nextInt();
    vmSource(id, "uuid-1", { config: null });
    m.quick.mockResolvedValue([vm()]);
    await readVcenterAsset("a1");
    expect(m.quick.mock.calls[0][0]).toEqual({});
  });

  it("is absent when vCenter answered without the VM", async () => {
    vmSource(nextInt(), "uuid-gone");
    m.quick.mockResolvedValue([vm()]);
    expect(await readVcenterAsset("a1")).toEqual({ kind: "absent", error: "VM not present in the vCenter inventory (removed or renamed?)" });
  });

  it("is unreachable when the quickStats fetch fails", async () => {
    vmSource(nextInt());
    m.quick.mockRejectedValue(new Error("ServerFaultCode: session expired"));
    expect(await readVcenterAsset("a1")).toEqual({ kind: "unreachable", error: "ServerFaultCode: session expired" });
  });

  it("serves a second VM read from the warm cache", async () => {
    const id = nextInt();
    vmSource(id);
    m.quick.mockResolvedValue([vm()]);
    await readVcenterAsset("a1");
    await readVcenterAsset("a2");
    expect(m.quick).toHaveBeenCalledTimes(1);
  });

  it("returns a host with the datastores it mounts", async () => {
    const id = nextInt();
    hostSource(id);
    const ds1 = { moref: "ds-1", name: "shared", hostMorefs: ["host-1", "host-2"], capacityBytes: 10, freeBytes: 4 };
    const ds2 = { moref: "ds-2", name: "other", hostMorefs: ["host-2"], capacityBytes: 10, freeBytes: 4 };
    m.hostSnap.mockResolvedValue({ hosts: [host()], datastores: [ds1, ds2], hostError: null });
    const r = await readVcenterAsset("a1");
    expect(r.kind).toBe("host");
    if (r.kind !== "host") return;
    expect(r.row.moref).toBe("host-1");
    expect(r.datastores).toEqual([ds1]);
    expect(m.hostSnap).toHaveBeenCalledWith({ host: "vc" }, undefined, { withPerCoreCpu: true });
  });

  it("gives a host with no mounted datastore an empty list", async () => {
    hostSource(nextInt());
    m.hostSnap.mockResolvedValue({ hosts: [host()], datastores: [], hostError: null });
    const r = await readVcenterAsset("a1");
    expect(r.kind === "host" && r.datastores).toEqual([]);
  });

  it("is unreachable — never absent — when the host half of the snapshot was refused", async () => {
    const id = nextInt();
    hostSource(id);
    m.hostSnap.mockResolvedValue({ hosts: [], datastores: [], hostError: "NoPermission on HostSystem" });
    expect(await readVcenterAsset("a1")).toEqual({ kind: "unreachable", error: "NoPermission on HostSystem" });
    // …and the failure was not cached as an empty inventory.
    m.hostSnap.mockResolvedValue({ hosts: [host()], datastores: [], hostError: null });
    expect((await readVcenterAsset("a1")).kind).toBe("host");
  });

  it("is absent when vCenter answered without the host", async () => {
    hostSource(nextInt(), "x:host-99");
    m.hostSnap.mockResolvedValue({ hosts: [host()], datastores: [], hostError: null });
    expect(await readVcenterAsset("a1")).toEqual({ kind: "absent", error: "ESXi host not present in the vCenter inventory (removed from vCenter?)" });
  });

  it("uses a generic reason for a host fetch failure with no message", async () => {
    hostSource(nextInt());
    m.hostSnap.mockRejectedValue({});
    expect(await readVcenterAsset("a1")).toEqual({ kind: "unreachable", error: "vCenter host property fetch failed" });
  });
});

// ─── probeVcenter ────────────────────────────────────────────────────────────

describe("probeVcenter", () => {
  it("skips when vCenter is unreachable", async () => {
    vmSource(nextInt(), "uuid-1", { enabled: false });
    expect(await probeVcenter("a1", performance.now())).toEqual({
      success: false, responseTimeMs: 0, skipped: true, error: "The linked vCenter integration is disabled",
    });
  });

  it("fails — not skips — when the asset is absent", async () => {
    findSource.mockResolvedValue(null);
    const r = await probeVcenter("a1", performance.now());
    expect(r.success).toBe(false);
    expect(r.skipped).toBeUndefined();
    expect(r.responseTimeMs).toBeGreaterThanOrEqual(0);
  });

  it("succeeds for a powered-on VM and carries its uptime", async () => {
    vmSource(nextInt());
    m.quick.mockResolvedValue([vm()]);
    const r = await probeVcenter("a1", performance.now());
    expect(r).toMatchObject({ success: true, uptimeSec: 3600 });
  });

  it("accepts the REST spelling of powered on and omits a missing uptime", async () => {
    vmSource(nextInt());
    m.quick.mockResolvedValue([vm({ powerState: "POWERED_ON", uptimeSec: null })]);
    const r = await probeVcenter("a1", performance.now());
    expect(r.success).toBe(true);
    expect(r).not.toHaveProperty("uptimeSec");
  });

  it("skips a VM whose power state did not come back", async () => {
    vmSource(nextInt());
    m.quick.mockResolvedValue([vm({ powerState: null })]);
    expect(await probeVcenter("a1", performance.now())).toEqual({
      success: false, responseTimeMs: 0, skipped: true, error: "vCenter reported no power state for this VM",
    });
  });

  it("fails a powered-off VM", async () => {
    vmSource(nextInt());
    m.quick.mockResolvedValue([vm({ powerState: "poweredOff" })]);
    const r = await probeVcenter("a1", performance.now());
    expect(r).toMatchObject({ success: false, error: "VM is poweredOff" });
    expect(r.skipped).toBeUndefined();
  });

  it("succeeds for a connected, powered-on host with its uptime", async () => {
    hostSource(nextInt());
    m.hostSnap.mockResolvedValue({ hosts: [host()], datastores: [], hostError: null });
    expect(await probeVcenter("a1", performance.now())).toMatchObject({ success: true, uptimeSec: 86400 });
  });

  it("fails a host vCenter does not report connected", async () => {
    hostSource(nextInt());
    m.hostSnap.mockResolvedValue({ hosts: [host({ connectionState: "notResponding" })], datastores: [], hostError: null });
    expect((await probeVcenter("a1", performance.now())).error).toBe("ESXi host is notResponding in vCenter");
  });

  it("names a missing connection state as not connected", async () => {
    hostSource(nextInt());
    m.hostSnap.mockResolvedValue({ hosts: [host({ connectionState: null })], datastores: [], hostError: null });
    expect((await probeVcenter("a1", performance.now())).error).toBe("ESXi host is not connected in vCenter");
  });

  it("accepts a connected host whose power state did not come back", async () => {
    hostSource(nextInt());
    m.hostSnap.mockResolvedValue({ hosts: [host({ powerState: null, uptimeSec: null })], datastores: [], hostError: null });
    const r = await probeVcenter("a1", performance.now());
    expect(r.success).toBe(true);
    expect(r).not.toHaveProperty("uptimeSec");
  });

  it("fails a connected host in standby", async () => {
    hostSource(nextInt());
    m.hostSnap.mockResolvedValue({ hosts: [host({ powerState: "standBy" })], datastores: [], hostError: null });
    expect((await probeVcenter("a1", performance.now())).error).toBe("ESXi host is standBy");
  });
});

// ─── collectTelemetryVcenter ─────────────────────────────────────────────────

describe("collectTelemetryVcenter", () => {
  it("reports the reading's error when the asset is absent or vCenter unreachable", async () => {
    findSource.mockResolvedValue(null);
    const r = await collectTelemetryVcenter("a1");
    expect(r.supported).toBe(true);
    expect(r.error).toContain("no vCenter source");
    expect(r.data).toBeUndefined();
  });

  it("reports no data for a VM that is not powered on", async () => {
    vmSource(nextInt());
    m.quick.mockResolvedValue([vm({ powerState: "suspended" })]);
    expect(await collectTelemetryVcenter("a1")).toEqual({ supported: true, error: "VM is not powered on (suspended)" });
  });

  it("derives a VM's CPU % and converts guest / configured memory to bytes, with no consumed band", async () => {
    vmSource(nextInt());
    m.quick.mockResolvedValue([vm()]);
    const r = await collectTelemetryVcenter("a1");
    expect(r.data).toEqual({
      cpuPct: 25, memUsedBytes: 1024 * MIB, memTotalBytes: 4096 * MIB, cpuCorePcts: [10, 20],
      memPrivateBytes: 1, memSharedBytes: 2, memBalloonedBytes: 3, memSwappedBytes: 4, memCompressedBytes: 5,
    });
    expect(r.data).not.toHaveProperty("memConsumedBytes");
  });

  it("clamps a VM's CPU % to 100 and nulls it without a usable maximum", async () => {
    vmSource(nextInt());
    m.quick.mockResolvedValue([vm({ cpuUsageMhz: 5000, cpuMaxMhz: 2000 })]);
    expect((await collectTelemetryVcenter("a1")).data?.cpuPct).toBe(100);
    vmSource(nextInt());
    m.quick.mockResolvedValue([vm({ cpuMaxMhz: 0, guestMemUsageMB: null, memTotalMB: null })]);
    const r = await collectTelemetryVcenter("a1");
    expect(r.data).toMatchObject({ cpuPct: null, memUsedBytes: null, memTotalBytes: null });
  });

  it("reports no data for a host that is not connected", async () => {
    hostSource(nextInt());
    m.hostSnap.mockResolvedValue({ hosts: [host({ connectionState: "disconnected" })], datastores: [], hostError: null });
    expect(await collectTelemetryVcenter("a1")).toEqual({ supported: true, error: "ESXi host is disconnected in vCenter" });
  });

  it("derives a host's CPU % and mirrors consumed memory onto the used aggregate", async () => {
    hostSource(nextInt());
    m.hostSnap.mockResolvedValue({ hosts: [host()], datastores: [], hostError: null });
    expect((await collectTelemetryVcenter("a1")).data).toEqual({
      cpuPct: 25, memUsedBytes: 100, memTotalBytes: 400, cpuCorePcts: [1, 2],
      memConsumedBytes: 100, memBalloonedBytes: 7, memSwappedBytes: 8,
    });
  });

  it("nulls a host's CPU % when the total is unknown", async () => {
    hostSource(nextInt());
    m.hostSnap.mockResolvedValue({ hosts: [host({ cpuTotalMhz: null })], datastores: [], hostError: null });
    expect((await collectTelemetryVcenter("a1")).data?.cpuPct).toBeNull();
  });
});

// ─── buildVcenterSystemInfo / collectSystemInfoVcenter ───────────────────────

describe("buildVcenterSystemInfo", () => {
  it("returns empty lists for an absent or unreachable reading", () => {
    expect(buildVcenterSystemInfo({ kind: "absent", error: "x" })).toEqual({ interfaces: [], storage: [] });
    expect(buildVcenterSystemInfo({ kind: "unreachable", error: "x" })).toEqual({ interfaces: [], storage: [] });
  });

  it("turns a VM's absent Tools data into empty lists, never a crash", () => {
    expect(buildVcenterSystemInfo({ kind: "vm", row: vm() as never, fetchDurationMs: 1 })).toEqual({ interfaces: [], storage: [] });
  });

  it("maps a VM's guest vNICs and filesystems", () => {
    const row = vm({
      guestNics: [
        { label: "Network adapter 1", connected: true, macAddress: "00:50:56:00:00:01", ipAddress: "10.0.0.5", ipv6Address: null },
        { label: "Network adapter 2", connected: false, macAddress: null, ipAddress: null, ipv6Address: "fe80::1" },
        { label: "Network adapter 3", connected: null, macAddress: null, ipAddress: null, ipv6Address: null },
      ],
      guestDisks: [
        { path: "C:\\", capacityBytes: 100, freeBytes: 40 },
        { path: "/data", capacityBytes: 100, freeBytes: null },
      ],
    });
    const out = buildVcenterSystemInfo({ kind: "vm", row: row as never, fetchDurationMs: 1 });
    expect(out.interfaces.map((i) => i.operStatus)).toEqual(["up", "down", null]);
    expect(out.interfaces[0]).toEqual({ ifName: "Network adapter 1", operStatus: "up", macAddress: "00:50:56:00:00:01", ipAddress: "10.0.0.5", ipv6Address: null });
    expect(out.storage).toEqual([
      { mountPath: "C:\\", totalBytes: 100, usedBytes: 60 },
      { mountPath: "/data", totalBytes: 100, usedBytes: null },
    ]);
  });

  it("nests a host's uplinks and VMkernel ports under their vSwitch and derives each switch's state", () => {
    const row = host({
      pnics: [
        { device: "vmnic0", speedMb: 10000, duplex: true, macAddress: "aa" },
        { device: "vmnic1", speedMb: null, duplex: null, macAddress: "bb" },
        { device: "vmnic2", speedMb: 1000, duplex: false, macAddress: "cc" },
        { device: "vmnic3", speedMb: null, duplex: null, macAddress: "dd" },
      ],
      vnics: [
        { device: "vmk0", macAddress: "ee", ipAddress: "10.1.1.1", ipv6Address: null, portgroup: "Management" },
        { device: "vmk1", macAddress: "ff", ipAddress: null, ipv6Address: null, portgroup: "Unknown PG" },
        { device: "vmk2", macAddress: "gg", ipAddress: null, ipv6Address: null, portgroup: null },
      ],
      vswitches: [
        { name: "vSwitch0", uplinks: ["vmnic0", "vmnic1"] },
        { name: "vSwitch1", uplinks: ["vmnic3"] },
        { name: "vSwitchInternal", uplinks: [] },
        { name: "vSwitchDup", uplinks: ["vmnic0", "vmnic-missing"] },
      ],
      portgroups: [{ name: "Management", vswitchName: "vSwitch0", vlanId: 10 }],
    });
    const ds = { name: "datastore1", capacityBytes: 1000, freeBytes: 250 };
    const out = buildVcenterSystemInfo({ kind: "host", row: row as never, datastores: [ds as never], fetchDurationMs: 1 });
    const byName = Object.fromEntries(out.interfaces.map((i) => [i.ifName, i]));

    expect(byName.vmnic0).toEqual({ ifName: "vmnic0", operStatus: "up", speedBps: 10_000_000_000, duplex: "full", macAddress: "aa", ifType: "physical", ifParent: "vSwitch0" });
    expect(byName.vmnic1).toMatchObject({ operStatus: "down", speedBps: null, duplex: null, ifParent: "vSwitch0" });
    expect(byName.vmnic2).toMatchObject({ operStatus: "up", duplex: "half", ifParent: null });
    expect(byName.vmnic3.ifParent).toBe("vSwitch1");

    expect(byName.vmk0).toEqual({ ifName: "vmk0", macAddress: "ee", ipAddress: "10.1.1.1", ipv6Address: null, vlanId: 10, ifParent: "vSwitch0" });
    expect(byName.vmk0).not.toHaveProperty("operStatus");
    expect(byName.vmk1).toMatchObject({ vlanId: null, ifParent: null });
    expect(byName.vmk2).toMatchObject({ vlanId: null, ifParent: null });

    expect(byName.vSwitch0).toEqual({ ifName: "vSwitch0", ifType: "aggregate", operStatus: "up" });
    expect(byName.vSwitch1.operStatus).toBe("down");
    expect(byName.vSwitchInternal.operStatus).toBeNull();
    expect(byName.vSwitchDup.operStatus).toBe("up");
    expect(byName.vSwitch0).not.toHaveProperty("speedBps");
    // The first vSwitch to name an uplink keeps it.
    expect(byName.vmnic0.ifParent).toBe("vSwitch0");
    // Switch rows come last, after every port.
    expect(out.interfaces.slice(-4).map((i) => i.ifName)).toEqual(["vSwitch0", "vSwitch1", "vSwitchInternal", "vSwitchDup"]);

    expect(out.storage).toEqual([{ mountPath: "datastore1", totalBytes: 1000, usedBytes: 750 }]);
  });

  it("reports nothing for a disconnected host's absent NIC lists and a datastore with no free figure", () => {
    const out = buildVcenterSystemInfo({ kind: "host", row: host() as never, datastores: [{ name: "nfs", capacityBytes: null, freeBytes: 5 } as never], fetchDurationMs: 1 });
    expect(out.interfaces).toEqual([]);
    expect(out.storage).toEqual([{ mountPath: "nfs", totalBytes: null, usedBytes: null }]);
  });
});

describe("collectSystemInfoVcenter", () => {
  const BOTH = { interfacesPolling: "vcenter", storagePolling: "vcenter" };

  it("reports the reading's error without data", async () => {
    findSource.mockResolvedValue(null);
    const r = await collectSystemInfoVcenter("a1", BOTH);
    expect(r.supported).toBe(true);
    expect(r.error).toBeTruthy();
    expect(r.data).toBeUndefined();
  });

  it("returns both streams when both resolve to vcenter", async () => {
    vmSource(nextInt());
    m.quick.mockResolvedValue([vm({ guestNics: [{ label: "n1", connected: true, macAddress: null, ipAddress: null, ipv6Address: null }], guestDisks: [{ path: "/", capacityBytes: 10, freeBytes: 5 }] })]);
    const r = await collectSystemInfoVcenter("a1", BOTH);
    expect(r.data?.interfaces).toHaveLength(1);
    expect(r.data?.storage).toHaveLength(1);
  });

  it("empties each stream whose own polling method is not vcenter", async () => {
    const id = nextInt();
    vmSource(id);
    m.quick.mockResolvedValue([vm({ guestNics: [{ label: "n1", connected: true, macAddress: null, ipAddress: null, ipv6Address: null }], guestDisks: [{ path: "/", capacityBytes: 10, freeBytes: 5 }] })]);
    const a = await collectSystemInfoVcenter("a1", { interfacesPolling: "snmp", storagePolling: "vcenter" });
    expect(a.data?.interfaces).toEqual([]);
    expect(a.data?.storage).toHaveLength(1);
    const b = await collectSystemInfoVcenter("a1", { interfacesPolling: "vcenter", storagePolling: null });
    expect(b.data?.interfaces).toHaveLength(1);
    expect(b.data?.storage).toEqual([]);
  });
});
