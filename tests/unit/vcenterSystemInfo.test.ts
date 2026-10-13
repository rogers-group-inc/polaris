/**
 * tests/unit/vcenterSystemInfo.test.ts
 *
 * `buildVcenterSystemInfo` — the pure mapping from one cached vCenter reading to
 * the interface + storage rows the System tab and the sample streams consume.
 * Three things it decides, none of which vCenter states outright:
 *
 *   - the interface HIERARCHY (vSwitch as an `aggregate` parent over its uplink
 *     pNICs and the VMkernel ports riding its port groups — the same shape
 *     overlayFortiswitchTrunkMembers draws for a trunk),
 *   - a vSwitch's own up/down, derived from its uplinks,
 *   - which VLAN a vmk is on, joined through its port group.
 *
 * It is also where the null-vs-empty contract from vcenterService lands: a VM
 * with VMware Tools off must produce an EMPTY interface list (which
 * recordSystemInfoResult skips) and never a wipe.
 */

import { describe, it, expect } from "vitest";
import { buildVcenterSystemInfo, type VcenterReading } from "../../src/services/monitoringService.js";

function hostReading(over: Partial<Parameters<typeof hostRow>[0]> = {}): VcenterReading {
  return { kind: "host", row: hostRow(over), datastores: [], fetchDurationMs: 12 };
}

function hostRow(over: Record<string, unknown> = {}): any {
  return {
    moref: "host-11",
    name: "esx01",
    connectionState: "connected",
    powerState: "poweredOn",
    inMaintenanceMode: false,
    uptimeSec: 1000,
    cpuUsageMhz: 100,
    cpuTotalMhz: 48000,
    memUsageBytes: 1,
    memTotalBytes: 2,
    pnics: [
      { device: "vmnic0", macAddress: "aa:00", speedMb: 10000, duplex: true, driver: "ixgben" },
      { device: "vmnic1", macAddress: "aa:01", speedMb: null,  duplex: null, driver: "ixgben" },
    ],
    vnics: [
      { device: "vmk0", portgroup: "Management Network", macAddress: "aa:00", ipAddress: "10.1.1.11", mtu: 1500 },
    ],
    vswitches: [
      { name: "vSwitch0", distributed: false, dvsUuid: null, mtu: 1500, numPorts: 128, numPortsAvailable: 100, uplinks: ["vmnic0", "vmnic1"], teamingPolicy: "loadbalance_srcid" },
    ],
    portgroups: [
      { name: "Management Network", vswitchName: "vSwitch0", vlanId: 12 },
    ],
    ...over,
  };
}

const byName = (rows: Array<{ ifName: string }>) =>
  Object.fromEntries(rows.map((r) => [r.ifName, r as any]));

describe("buildVcenterSystemInfo — ESXi host interface hierarchy", () => {
  it("nests uplink pNICs and VMkernel ports under their vSwitch", () => {
    const rows = byName(buildVcenterSystemInfo(hostReading()).interfaces);
    expect(rows["vmnic0"].ifParent).toBe("vSwitch0");
    expect(rows["vmnic1"].ifParent).toBe("vSwitch0");
    // The vmk's parent comes from its PORT GROUP's vswitchName, not from any
    // field on the vmk itself.
    expect(rows["vmk0"].ifParent).toBe("vSwitch0");
    expect(rows["vSwitch0"].ifType).toBe("aggregate");
  });

  it("gives a vmk the VLAN of the port group it rides", () => {
    const rows = byName(buildVcenterSystemInfo(hostReading()).interfaces);
    expect(rows["vmk0"].vlanId).toBe(12);
    // A vmk publishes no link state — it rides a port group, not an uplink.
    expect(rows["vmk0"].operStatus ?? null).toBeNull();
  });

  it("a pNIC that uplinks nothing has no parent", () => {
    const rows = byName(buildVcenterSystemInfo(hostReading({
      vswitches: [{ name: "vSwitch0", distributed: false, dvsUuid: null, mtu: 1500, numPorts: 8, numPortsAvailable: 8, uplinks: ["vmnic0"], teamingPolicy: null }],
    })).interfaces);
    expect(rows["vmnic0"].ifParent).toBe("vSwitch0");
    expect(rows["vmnic1"].ifParent ?? null).toBeNull();
  });

  it("a vSwitch is up while ANY uplink is up, and down only when all are dark", () => {
    // vmnic0 up + vmnic1 down => up. Redundancy loss is not an outage.
    expect(byName(buildVcenterSystemInfo(hostReading()).interfaces)["vSwitch0"].operStatus).toBe("up");

    const allDark = hostReading({
      pnics: [
        { device: "vmnic0", macAddress: "aa:00", speedMb: null, duplex: null, driver: "x" },
        { device: "vmnic1", macAddress: "aa:01", speedMb: null, duplex: null, driver: "x" },
      ],
    });
    expect(byName(buildVcenterSystemInfo(allDark).interfaces)["vSwitch0"].operStatus).toBe("down");
  });

  it("an internal-only vSwitch reports no state rather than 'down'", () => {
    // No uplinks is a legitimate configuration (VM-to-VM only). Calling it down
    // would invent an outage out of a working switch.
    const rows = byName(buildVcenterSystemInfo(hostReading({
      vswitches: [{ name: "vSwitch-internal", distributed: false, dvsUuid: null, mtu: 1500, numPorts: 8, numPortsAvailable: 8, uplinks: [], teamingPolicy: null }],
    })).interfaces);
    expect(rows["vSwitch-internal"].operStatus ?? null).toBeNull();
  });

  it("a distributed switch parents its uplinks by DVS name", () => {
    const rows = byName(buildVcenterSystemInfo(hostReading({
      vswitches: [{ name: "DVS-Prod", distributed: true, dvsUuid: "50 1e", mtu: 9000, numPorts: 1792, numPortsAvailable: null, uplinks: ["vmnic1"], teamingPolicy: null }],
    })).interfaces);
    expect(rows["vmnic1"].ifParent).toBe("DVS-Prod");
    expect(rows["DVS-Prod"].ifType).toBe("aggregate");
  });

  it("no vswitch data means flat rows, never a claim of no interfaces", () => {
    const flat = buildVcenterSystemInfo(hostReading({ vswitches: null, portgroups: null }));
    const rows = byName(flat.interfaces);
    expect(Object.keys(rows).sort()).toEqual(["vmk0", "vmnic0", "vmnic1"]);
    expect(rows["vmnic0"].ifParent ?? null).toBeNull();
    expect(rows["vmk0"].vlanId ?? null).toBeNull();
  });

  it("a host's storage is the datastores it mounts, used = capacity - free", () => {
    const withDs: VcenterReading = {
      kind: "host",
      row: hostRow(),
      datastores: [
        { moref: "datastore-1", name: "prod-ds01", dsType: "VMFS", capacityBytes: 1000, freeBytes: 400, provisionedBytes: null, accessible: true, hostMorefs: ["host-11"], backing: null, backingLabel: null },
      ],
      fetchDurationMs: 5,
    };
    expect(buildVcenterSystemInfo(withDs).storage).toEqual([
      { mountPath: "prod-ds01", totalBytes: 1000, usedBytes: 600 },
    ]);
  });
});

describe("buildVcenterSystemInfo — VM rows", () => {
  function vmReading(over: Record<string, unknown> = {}): VcenterReading {
    return {
      kind: "vm",
      fetchDurationMs: 7,
      row: {
        moref: "vm-1",
        instanceUuid: "uuid-1",
        cpuUsageMhz: 100,
        cpuMaxMhz: 4400,
        guestMemUsageMB: 512,
        hostMemUsageMB: null,
        memTotalMB: 4096,
        powerState: "poweredOn",
        uptimeSec: 60,
        guestDisks: [{ path: "C:\\", capacityBytes: 100, freeBytes: 25 }],
        guestNics: [{ deviceConfigId: 4000, label: "Network adapter 1", network: "VM Network", macAddress: "00:50:56:aa", connected: true, ipAddress: "10.2.0.5" }],
        ...over,
      } as any,
    };
  }

  it("maps guest vNICs and filesystems", () => {
    const out = buildVcenterSystemInfo(vmReading());
    expect(out.interfaces).toEqual([
      { ifName: "Network adapter 1", operStatus: "up", macAddress: "00:50:56:aa", ipAddress: "10.2.0.5" },
    ]);
    expect(out.storage).toEqual([{ mountPath: "C:\\", totalBytes: 100, usedBytes: 75 }]);
  });

  it("Tools off yields EMPTY lists — which the persist layer skips, not a wipe", () => {
    // vcenterService returns null for both arrays when Tools didn't answer.
    // Turning that into [] here is safe ONLY because recordSystemInfoResult
    // skips an empty interface list; returning rows would be the wipe.
    const out = buildVcenterSystemInfo(vmReading({ guestDisks: null, guestNics: null }));
    expect(out.interfaces).toEqual([]);
    expect(out.storage).toEqual([]);
  });

  it("a disconnected vNIC reports down, and an unknown connected state reports nothing", () => {
    const down = buildVcenterSystemInfo(vmReading({
      guestNics: [{ deviceConfigId: 4001, label: "Network adapter 2", network: "DMZ", macAddress: "00:50:56:bb", connected: false, ipAddress: null }],
    }));
    expect(down.interfaces[0].operStatus).toBe("down");

    const unknown = buildVcenterSystemInfo(vmReading({
      guestNics: [{ deviceConfigId: 4001, label: "Network adapter 2", network: "DMZ", macAddress: "00:50:56:bb", connected: null, ipAddress: null }],
    }));
    expect(unknown.interfaces[0].operStatus).toBeNull();
  });

  it("a capacity with no free space reports no usage rather than guessing zero", () => {
    const out = buildVcenterSystemInfo(vmReading({
      guestDisks: [{ path: "/var", capacityBytes: 50, freeBytes: null }],
    }));
    expect(out.storage).toEqual([{ mountPath: "/var", totalBytes: 50, usedBytes: null }]);
  });
});

describe("buildVcenterSystemInfo — pNIC duplex", () => {
  it("maps the linkSpeed duplex flag onto full / half, and a down pNIC to null", () => {
    const rows = byName(buildVcenterSystemInfo(hostReading({
      pnics: [
        { device: "vmnic0", macAddress: "aa:00", speedMb: 10000, duplex: true,  driver: "x" },
        { device: "vmnic1", macAddress: "aa:01", speedMb: 100,   duplex: false, driver: "x" },
        { device: "vmnic2", macAddress: "aa:02", speedMb: null,  duplex: null,  driver: "x" },
      ],
    })).interfaces);
    expect(rows["vmnic0"].duplex).toBe("full");
    expect(rows["vmnic1"].duplex).toBe("half");
    expect(rows["vmnic2"].duplex).toBeNull();
  });
});
