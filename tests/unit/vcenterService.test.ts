/**
 * tests/unit/vcenterService.test.ts
 *
 * Pure helpers of the vCenter discovery service: external-id selection,
 * cluster mapping, the vMotion-safe dependency-edge builder, VM name
 * filtering, NAA vendor identification, SOAP response parsing, the REST
 * VM-detail parser, and the two decisions behind the disappearance sweep
 * (is this inventory trustworthy, and which stale rows really vanished).
 */

import { describe, it, expect } from "vitest";

import {
  pickVmExternalId,
  hostExternalId,
  buildClusterHostMap,
  buildVcenterDependencyEdges,
  matchesVmWildcard,
  filterVms,
  vendorFromNaa,
  backingLabelFor,
  extractObjectBlocks,
  parseObjRef,
  parsePropValue,
  parseQuickStatsBlock,
  parseGuestDisks,
  parseGuestNics,
  parseHostPnics,
  parseHostVnics,
  parseHostVswitches,
  parseHostProxySwitches,
  parseHostPortgroups,
  parseHostStatsBlock,
  parseDatastoreBlock,
  parseVmDetail,
  vcenterSweepBlockedReason,
  partitionStaleVcenterSources,
  parsePerfCounterIds,
  parsePerfResponse,
} from "../../src/services/vcenterService.js";

const INTG = "11111111-2222-3333-4444-555555555555";

// ─── external ids ───────────────────────────────────────────────────────────

describe("pickVmExternalId / hostExternalId", () => {
  it("prefers instanceUuid (survives vMotion, unique per vCenter)", () => {
    expect(pickVmExternalId({ moref: "vm-42", instanceUuid: "50aa-bb" }, INTG)).toBe("50aa-bb");
  });

  it("falls back to the integration-scoped moref when the uuid is missing", () => {
    expect(pickVmExternalId({ moref: "vm-42", instanceUuid: null }, INTG)).toBe(`${INTG}:vm-42`);
  });

  it("host externalId is always integration-scoped (morefs repeat across vCenters)", () => {
    expect(hostExternalId("host-10", INTG)).toBe(`${INTG}:host-10`);
  });
});

// ─── cluster map + dependency edges ─────────────────────────────────────────

describe("buildClusterHostMap", () => {
  it("maps cluster morefs to member host morefs", () => {
    const map = buildClusterHostMap([
      { clusterMoref: "domain-c8", hostMorefs: ["host-1", "host-2"] },
      { clusterMoref: "domain-c9", hostMorefs: ["host-3"] },
    ]);
    expect(map.get("domain-c8")).toEqual(["host-1", "host-2"]);
    expect(map.get("domain-c9")).toEqual(["host-3"]);
  });
});

describe("buildVcenterDependencyEdges — vMotion-safe multi-parent", () => {
  const hostAssets = new Map([
    ["host-1", "asset-h1"],
    ["host-2", "asset-h2"],
    ["host-3", "asset-h3"],
  ]);
  const clusterByHost = new Map([
    ["host-1", "domain-c8"],
    ["host-2", "domain-c8"],
  ]);
  const clusterMembers = new Map([["domain-c8", ["host-1", "host-2"]]]);

  it("clustered VM gets one edge per cluster-member host (all-down semantics)", () => {
    const edges = buildVcenterDependencyEdges(
      [{ vmAssetId: "asset-vm1", hostMoref: "host-1" }],
      hostAssets,
      clusterByHost,
      clusterMembers,
    );
    expect(edges).toEqual([
      { assetId: "asset-vm1", parentAssetId: "asset-h1" },
      { assetId: "asset-vm1", parentAssetId: "asset-h2" },
    ]);
  });

  it("standalone host → single edge", () => {
    const edges = buildVcenterDependencyEdges(
      [{ vmAssetId: "asset-vm2", hostMoref: "host-3" }],
      hostAssets,
      clusterByHost,
      clusterMembers,
    );
    expect(edges).toEqual([{ assetId: "asset-vm2", parentAssetId: "asset-h3" }]);
  });

  it("hosts without a Polaris asset are skipped, not fabricated", () => {
    const edges = buildVcenterDependencyEdges(
      [{ vmAssetId: "asset-vm3", hostMoref: "host-unknown" }],
      hostAssets,
      clusterByHost,
      clusterMembers,
    );
    expect(edges).toEqual([]);
  });

  it("dedupes repeated (vm, parent) pairs and never self-parents", () => {
    const selfMap = new Map([["host-1", "asset-vm4"]]); // pathological: vm IS the host asset
    const edges = buildVcenterDependencyEdges(
      [
        { vmAssetId: "asset-vm4", hostMoref: "host-1" },
        { vmAssetId: "asset-vm4", hostMoref: "host-1" },
      ],
      selfMap,
      new Map(),
      new Map(),
    );
    expect(edges).toEqual([]);
  });
});

// ─── VM name filter ─────────────────────────────────────────────────────────

describe("matchesVmWildcard / filterVms", () => {
  it("supports prefix, suffix, contains, exact, and star", () => {
    expect(matchesVmWildcard("prod-*", "PROD-SQL01")).toBe(true);
    expect(matchesVmWildcard("*-template", "win2022-template")).toBe(true);
    expect(matchesVmWildcard("*sql*", "prod-SQL01")).toBe(true);
    expect(matchesVmWildcard("exact", "exact")).toBe(true);
    expect(matchesVmWildcard("*", "anything")).toBe(true);
    expect(matchesVmWildcard("prod-*", "dev-sql")).toBe(false);
  });

  it("include wins over exclude when both are set (AD OU-filter semantics)", () => {
    const vms = [{ name: "prod-a" }, { name: "dev-b" }];
    expect(filterVms(vms, ["prod-*"], ["*"])).toEqual([{ name: "prod-a" }]);
    expect(filterVms(vms, [], ["dev-*"])).toEqual([{ name: "prod-a" }]);
    expect(filterVms(vms, [], [])).toEqual(vms);
  });
});

// ─── NAA vendor identification ──────────────────────────────────────────────

describe("vendorFromNaa / backingLabelFor", () => {
  it("identifies known array vendors by NAA OUI prefix", () => {
    expect(vendorFromNaa("naa.624a9370f8a5c2e1d4b3000011112222")).toBe("Pure Storage");
    expect(vendorFromNaa("NAA.624A9370AABBCCDD")).toBe("Pure Storage"); // case-insensitive
    expect(vendorFromNaa("naa.600a098038314c65")).toBe("NetApp");
    expect(vendorFromNaa("naa.60060160abcd")).toBe("Dell EMC Unity/VNX");
    expect(vendorFromNaa("naa.6000c295деад")).toBe("VMware Virtual Disk");
  });

  it("returns null for unknown prefixes and empty input", () => {
    expect(vendorFromNaa("naa.6999999900000000")).toBeNull();
    expect(vendorFromNaa("")).toBeNull();
    expect(vendorFromNaa(null)).toBeNull();
  });

  it("backing label joins distinct VMFS vendors and labels NFS by remote host", () => {
    expect(
      backingLabelFor({
        vmfs: [
          { diskName: "naa.624a9370aa", vendor: "Pure Storage" },
          { diskName: "naa.624a9370bb", vendor: "Pure Storage" },
        ],
      }),
    ).toBe("Pure Storage");
    expect(backingLabelFor({ nas: { remoteHost: "filer01.corp", remotePath: "/vol/ds1" } })).toBe("NFS: filer01.corp");
    expect(backingLabelFor({ vmfs: [{ diskName: "naa.unknown", vendor: null }] })).toBeNull();
    expect(backingLabelFor(null)).toBeNull();
  });
});

// ─── SOAP parsing ───────────────────────────────────────────────────────────

const QUICKSTATS_XML =
  `<returnval><objects>` +
  `<obj type="VirtualMachine">vm-42</obj>` +
  `<propSet><name>config.hardware.memoryMB</name><val xsi:type="xsd:int">8192</val></propSet>` +
  `<propSet><name>config.instanceUuid</name><val xsi:type="xsd:string">50aa-bb</val></propSet>` +
  `<propSet><name>runtime.powerState</name><val xsi:type="VirtualMachinePowerState">poweredOn</val></propSet>` +
  `<propSet><name>summary.quickStats.guestMemoryUsage</name><val xsi:type="xsd:int">2048</val></propSet>` +
  `<propSet><name>summary.quickStats.overallCpuUsage</name><val xsi:type="xsd:int">450</val></propSet>` +
  `<propSet><name>summary.runtime.maxCpuUsage</name><val xsi:type="xsd:int">4400</val></propSet>` +
  `<propSet><name>summary.quickStats.uptimeSeconds</name><val xsi:type="xsd:int">86400</val></propSet>` +
  `<propSet><name>guest.disk</name><val xsi:type="ArrayOfGuestDiskInfo">` +
  `<GuestDiskInfo><diskPath>/</diskPath><capacity>100</capacity><freeSpace>40</freeSpace></GuestDiskInfo>` +
  `<GuestDiskInfo><diskPath>/var</diskPath><capacity>50</capacity></GuestDiskInfo>` +
  `</val></propSet>` +
  `<propSet><name>guest.net</name><val xsi:type="ArrayOfGuestNicInfo">` +
  `<GuestNicInfo><network>VM Network</network><macAddress>00:50:56:aa:bb:cc</macAddress><connected>true</connected>` +
  `<deviceConfigId>4000</deviceConfigId><ipAddress>fe80::1</ipAddress><ipAddress>10.1.2.3</ipAddress></GuestNicInfo>` +
  `<GuestNicInfo><network>DMZ</network><macAddress>00:50:56:dd:ee:ff</macAddress><connected>false</connected>` +
  `<deviceConfigId>4001</deviceConfigId></GuestNicInfo>` +
  `</val></propSet>` +
  `</objects><objects>` +
  `<obj type="VirtualMachine">vm-43</obj>` +
  `<propSet><name>runtime.powerState</name><val xsi:type="VirtualMachinePowerState">poweredOff</val></propSet>` +
  `</objects></returnval>`;

describe("SOAP quickStats parsing", () => {
  it("splits object blocks and reads the moref", () => {
    const blocks = extractObjectBlocks(QUICKSTATS_XML);
    expect(blocks).toHaveLength(2);
    expect(parseObjRef(blocks[0])).toBe("vm-42");
    expect(parseObjRef(blocks[1])).toBe("vm-43");
  });

  it("parses scalar propSet values by name", () => {
    const block = extractObjectBlocks(QUICKSTATS_XML)[0];
    expect(parsePropValue(block, "config.instanceUuid")).toBe("50aa-bb");
    expect(parsePropValue(block, "runtime.powerState")).toBe("poweredOn");
    expect(parsePropValue(block, "missing.property")).toBeNull();
  });

  it("maps a full block to quickStats and degrades absent fields to null", () => {
    const blocks = extractObjectBlocks(QUICKSTATS_XML);
    const full = parseQuickStatsBlock(blocks[0]);
    expect(full).toMatchObject({
      moref: "vm-42",
      instanceUuid: "50aa-bb",
      cpuUsageMhz: 450,
      cpuMaxMhz: 4400,
      guestMemUsageMB: 2048,
      hostMemUsageMB: null,
      memTotalMB: 8192,
      powerState: "poweredOn",
      uptimeSec: 86400,
    });
    const sparse = parseQuickStatsBlock(blocks[1]);
    expect(sparse?.moref).toBe("vm-43");
    expect(sparse?.cpuUsageMhz).toBeNull();
    expect(sparse?.instanceUuid).toBeNull();
  });

  it("parses guest filesystems, and a missing capacity/free degrades to null", () => {
    const block = extractObjectBlocks(QUICKSTATS_XML)[0];
    expect(parseGuestDisks(block)).toEqual([
      { path: "/",    capacityBytes: 100, freeBytes: 40 },
      { path: "/var", capacityBytes: 50,  freeBytes: null },
    ]);
  });

  it("names a vNIC from its device key, not its portgroup, and picks the IPv4", () => {
    const block = extractObjectBlocks(QUICKSTATS_XML)[0];
    const nics = parseGuestNics(block);
    // Key 4000 is adapter 1 by VMware convention. Two NICs on one portgroup
    // would collide if the portgroup were the identity.
    expect(nics?.[0]).toEqual({
      deviceConfigId: 4000,
      label: "Network adapter 1",
      network: "VM Network",
      macAddress: "00:50:56:aa:bb:cc",
      connected: true,
      ipAddress: "10.1.2.3",
    });
    expect(nics?.[1]).toMatchObject({ label: "Network adapter 2", connected: false, ipAddress: null });
  });

  it("absent Tools reads as null, never as an empty inventory", () => {
    // The VM that reported nothing but its power state. `null` is what stops
    // recordSystemInfoResult from wiping a guest's interface inventory and
    // stops the storage stream from claiming the guest has no mounts.
    const sparse = extractObjectBlocks(QUICKSTATS_XML)[1];
    expect(parseGuestDisks(sparse)).toBeNull();
    expect(parseGuestNics(sparse)).toBeNull();
  });
});

// ─── ESXi host stats ────────────────────────────────────────────────────────

const HOST_XML =
  `<returnval><objects>` +
  `<obj type="HostSystem">host-11</obj>` +
  `<propSet><name>name</name><val xsi:type="xsd:string">esx01.corp.local</val></propSet>` +
  `<propSet><name>runtime.connectionState</name><val xsi:type="HostSystemConnectionState">connected</val></propSet>` +
  `<propSet><name>runtime.powerState</name><val xsi:type="HostSystemPowerState">poweredOn</val></propSet>` +
  `<propSet><name>runtime.inMaintenanceMode</name><val xsi:type="xsd:boolean">false</val></propSet>` +
  `<propSet><name>summary.quickStats.overallCpuUsage</name><val xsi:type="xsd:int">12000</val></propSet>` +
  `<propSet><name>summary.quickStats.overallMemoryUsage</name><val xsi:type="xsd:int">131072</val></propSet>` +
  `<propSet><name>summary.quickStats.uptime</name><val xsi:type="xsd:int">604800</val></propSet>` +
  `<propSet><name>summary.hardware.cpuMhz</name><val xsi:type="xsd:int">2400</val></propSet>` +
  `<propSet><name>summary.hardware.numCpuCores</name><val xsi:type="xsd:short">20</val></propSet>` +
  `<propSet><name>summary.hardware.memorySize</name><val xsi:type="xsd:long">274877906944</val></propSet>` +
  `<propSet><name>config.network.pnic</name><val xsi:type="ArrayOfPhysicalNic">` +
  `<PhysicalNic><key>key-vim.host.PhysicalNic-vmnic0</key><device>vmnic0</device><driver>ixgben</driver>` +
  `<linkSpeed><speedMb>10000</speedMb><duplex>true</duplex></linkSpeed>` +
  `<validLinkSpecification><speedMb>1000</speedMb><duplex>true</duplex></validLinkSpecification>` +
  `<spec><linkSpeed><speedMb>1000</speedMb><duplex>true</duplex></linkSpeed></spec>` +
  `<mac>3c:ec:ef:11:22:33</mac></PhysicalNic>` +
  `<PhysicalNic><key>key-vim.host.PhysicalNic-vmnic3</key><device>vmnic3</device><driver>ixgben</driver>` +
  `<validLinkSpecification><speedMb>10000</speedMb><duplex>true</duplex></validLinkSpecification>` +
  `<spec/><mac>3c:ec:ef:11:22:36</mac></PhysicalNic>` +
  `</val></propSet>` +
  `<propSet><name>config.network.vnic</name><val xsi:type="ArrayOfHostVirtualNic">` +
  `<HostVirtualNic><device>vmk0</device><portgroup>Management Network</portgroup>` +
  `<spec><ip><dhcp>false</dhcp><ipAddress>10.1.1.11</ipAddress><subnetMask>255.255.255.0</subnetMask></ip>` +
  `<mac>3c:ec:ef:11:22:33</mac><mtu>1500</mtu></spec></HostVirtualNic>` +
  `</val></propSet>` +
  `<propSet><name>config.network.vswitch</name><val xsi:type="ArrayOfHostVirtualSwitch">` +
  `<HostVirtualSwitch><name>vSwitch0</name><key>key-vim.host.VirtualSwitch-vSwitch0</key>` +
  `<numPorts>128</numPorts><numPortsAvailable>102</numPortsAvailable><mtu>1500</mtu>` +
  `<portgroup>key-vim.host.PortGroup-Management Network</portgroup>` +
  `<pnic>key-vim.host.PhysicalNic-vmnic0</pnic><pnic>key-vim.host.PhysicalNic-vmnic3</pnic>` +
  `<spec><numPorts>128</numPorts>` +
  `<bridge xsi:type="HostVirtualSwitchBondBridge"><nicDevice>vmnic0</nicDevice><nicDevice>vmnic3</nicDevice></bridge>` +
  `<policy><security><allowPromiscuous>false</allowPromiscuous></security>` +
  `<nicTeaming><policy>loadbalance_srcid</policy><reversePolicy>true</reversePolicy>` +
  `<nicOrder><activeNic>vmnic0</activeNic><standbyNic>vmnic3</standbyNic></nicOrder></nicTeaming>` +
  `<shapingPolicy><enabled>false</enabled></shapingPolicy></policy><mtu>1500</mtu></spec>` +
  `</HostVirtualSwitch>` +
  `<HostVirtualSwitch><name>vSwitch-internal</name><numPorts>8</numPorts><mtu>1500</mtu>` +
  `<spec><numPorts>8</numPorts><policy><nicTeaming><policy>failover_explicit</policy></nicTeaming></policy></spec>` +
  `</HostVirtualSwitch>` +
  `</val></propSet>` +
  `<propSet><name>config.network.proxySwitch</name><val xsi:type="ArrayOfHostProxySwitch">` +
  `<HostProxySwitch><dvsUuid>50 1e aa bb</dvsUuid><dvsName>DVS-Prod</dvsName>` +
  `<numPorts>1792</numPorts><mtu>9000</mtu>` +
  `<pnic>key-vim.host.PhysicalNic-vmnic1</pnic>` +
  `<spec><backing xsi:type="DistributedVirtualSwitchHostMemberPnicBacking">` +
  `<pnicSpec><pnicDevice>vmnic1</pnicDevice><uplinkPortKey>101</uplinkPortKey></pnicSpec>` +
  `</backing></spec></HostProxySwitch>` +
  `</val></propSet>` +
  `<propSet><name>config.network.portgroup</name><val xsi:type="ArrayOfHostPortGroup">` +
  `<HostPortGroup><key>key-vim.host.PortGroup-Management Network</key>` +
  `<computedPolicy><nicTeaming><policy>loadbalance_srcid</policy></nicTeaming></computedPolicy>` +
  `<spec><name>Management Network</name><vlanId>0</vlanId><vswitchName>vSwitch0</vswitchName></spec>` +
  `</HostPortGroup>` +
  `<HostPortGroup><key>key-vim.host.PortGroup-Trunk</key>` +
  `<spec><name>Trunk</name><vlanId>4095</vlanId><vswitchName>vSwitch0</vswitchName></spec>` +
  `</HostPortGroup>` +
  `</val></propSet>` +
  `</objects><objects>` +
  `<obj type="HostSystem">host-12</obj>` +
  `<propSet><name>name</name><val xsi:type="xsd:string">esx02.corp.local</val></propSet>` +
  `<propSet><name>runtime.connectionState</name><val xsi:type="HostSystemConnectionState">notResponding</val></propSet>` +
  `</objects></returnval>`;

describe("SOAP ESXi host parsing", () => {
  it("reads a down pNIC as down instead of borrowing a supported speed", () => {
    // vmnic3 publishes no <linkSpeed> — the link is down. Both
    // validLinkSpecification and spec carry <speedMb> elements of their own,
    // so a whole-entry match would report 10 Gb on a dark port.
    const block = extractObjectBlocks(HOST_XML)[0];
    const pnics = parseHostPnics(block);
    expect(pnics).toEqual([
      { device: "vmnic0", macAddress: "3c:ec:ef:11:22:33", speedMb: 10000, duplex: true, driver: "ixgben" },
      { device: "vmnic3", macAddress: "3c:ec:ef:11:22:36", speedMb: null,  duplex: null, driver: "ixgben" },
    ]);
  });

  it("reads VMkernel ports with their management address", () => {
    const block = extractObjectBlocks(HOST_XML)[0];
    expect(parseHostVnics(block)).toEqual([
      { device: "vmk0", portgroup: "Management Network", macAddress: "3c:ec:ef:11:22:33", ipAddress: "10.1.1.11", mtu: 1500 },
    ]);
  });

  it("derives total CPU from cores × clock and normalises memory to bytes", () => {
    const host = parseHostStatsBlock(extractObjectBlocks(HOST_XML)[0]);
    expect(host).toMatchObject({
      moref: "host-11",
      name: "esx01.corp.local",
      connectionState: "connected",
      powerState: "poweredOn",
      inMaintenanceMode: false,
      uptimeSec: 604800,
      cpuUsageMhz: 12000,
      cpuTotalMhz: 48000,
      memUsageBytes: 131072 * 1024 * 1024,
      memTotalBytes: 274877906944,
    });
  });

  it("a disconnected host publishes no config, so its NIC lists are null", () => {
    const host = parseHostStatsBlock(extractObjectBlocks(HOST_XML)[1]);
    expect(host?.connectionState).toBe("notResponding");
    expect(host?.pnics).toBeNull();
    expect(host?.vnics).toBeNull();
    expect(host?.vswitches).toBeNull();
    expect(host?.portgroups).toBeNull();
    expect(host?.cpuTotalMhz).toBeNull();
  });
});

// ─── ESXi virtual networking ────────────────────────────────────────────────

describe("SOAP ESXi vSwitch / port-group parsing", () => {
  it("takes uplinks from the bridge device names, not the opaque pnic keys", () => {
    // `<pnic>` holds key-vim.host.PhysicalNic-vmnic0; only spec.bridge.nicDevice
    // carries the name the interface rows join on.
    const sw = parseHostVswitches(extractObjectBlocks(HOST_XML)[0]);
    expect(sw?.[0]).toEqual({
      name: "vSwitch0",
      distributed: false,
      dvsUuid: null,
      mtu: 1500,
      numPorts: 128,
      numPortsAvailable: 102,
      uplinks: ["vmnic0", "vmnic3"],
      teamingPolicy: "loadbalance_srcid",
    });
  });

  it("reads the teaming policy from inside nicTeaming, not from spec.policy", () => {
    // `spec.policy` is ALSO an element named <policy>; only the teaming one has
    // a text value, and relying on that is too subtle to leave untested.
    const sw = parseHostVswitches(extractObjectBlocks(HOST_XML)[0]);
    expect(sw?.[1]).toMatchObject({
      name: "vSwitch-internal",
      teamingPolicy: "failover_explicit",
      // An internal-only vSwitch has no bridge at all. Empty uplinks is a
      // legitimate configuration, not a parse miss — and it is what stops the
      // interface layer from calling the switch "down".
      uplinks: [],
      numPortsAvailable: null,
    });
  });

  it("reads a distributed switch's host end: name, uuid, and this host's uplinks", () => {
    const dvs = parseHostProxySwitches(extractObjectBlocks(HOST_XML)[0]);
    expect(dvs).toEqual([{
      name: "DVS-Prod",
      distributed: true,
      dvsUuid: "50 1e aa bb",
      mtu: 9000,
      numPorts: 1792,
      numPortsAvailable: null,
      // Teaming belongs to the DVS object, not to the host's proxy switch —
      // left null rather than guessed.
      teamingPolicy: null,
      uplinks: ["vmnic1"],
    }]);
  });

  it("merges standard and distributed switches into one list", () => {
    const host = parseHostStatsBlock(extractObjectBlocks(HOST_XML)[0]);
    expect(host?.vswitches?.map((s) => s.name)).toEqual(["vSwitch0", "vSwitch-internal", "DVS-Prod"]);
    expect(host?.vswitches?.filter((s) => s.distributed)).toHaveLength(1);
  });

  it("reads port groups from the spec, keeping the raw VLAN id", () => {
    // The head carries the opaque key, the port list and computedPolicy — the
    // name/vlanId/vswitchName only exist in the spec. 4095 is VGT, not a VLAN.
    const pgs = parseHostPortgroups(extractObjectBlocks(HOST_XML)[0]);
    expect(pgs).toEqual([
      { name: "Management Network", vswitchName: "vSwitch0", vlanId: 0 },
      { name: "Trunk",              vswitchName: "vSwitch0", vlanId: 4095 },
    ]);
  });
});

const DATASTORE_VMFS_XML =
  `<objects>` +
  `<obj type="Datastore">datastore-7</obj>` +
  `<propSet><name>host</name><val xsi:type="ArrayOfDatastoreHostMount">` +
  `<DatastoreHostMount><key xsi:type="ManagedObjectReference" type="HostSystem">host-1</key><mountInfo/></DatastoreHostMount>` +
  `<DatastoreHostMount><key xsi:type="ManagedObjectReference" type="HostSystem">host-2</key><mountInfo/></DatastoreHostMount>` +
  `</val></propSet>` +
  `<propSet><name>info</name><val xsi:type="VmfsDatastoreInfo">` +
  `<vmfs><extent><diskName>naa.624a93701234</diskName><partition>1</partition></extent></vmfs>` +
  `</val></propSet>` +
  `<propSet><name>name</name><val xsi:type="xsd:string">pure-ds01</val></propSet>` +
  `<propSet><name>summary.accessible</name><val xsi:type="xsd:boolean">true</val></propSet>` +
  `<propSet><name>summary.capacity</name><val xsi:type="xsd:long">1000</val></propSet>` +
  `<propSet><name>summary.freeSpace</name><val xsi:type="xsd:long">400</val></propSet>` +
  `<propSet><name>summary.type</name><val xsi:type="xsd:string">VMFS</val></propSet>` +
  `<propSet><name>summary.uncommitted</name><val xsi:type="xsd:long">250</val></propSet>` +
  `</objects>`;

const DATASTORE_NAS_XML =
  `<objects>` +
  `<obj type="Datastore">datastore-9</obj>` +
  `<propSet><name>info</name><val xsi:type="NasDatastoreInfo">` +
  `<nas><remoteHost>filer01.corp</remoteHost><remotePath>/vol/ds1</remotePath></nas>` +
  `</val></propSet>` +
  `<propSet><name>name</name><val xsi:type="xsd:string">nfs-ds01</val></propSet>` +
  `<propSet><name>summary.type</name><val xsi:type="xsd:string">NFS</val></propSet>` +
  `</objects>`;

describe("SOAP datastore parsing", () => {
  it("parses a VMFS datastore: host mounts, backing extents, provisioned math", () => {
    const block = extractObjectBlocks(`<r>${DATASTORE_VMFS_XML}</r>`)[0];
    const ds = parseDatastoreBlock(block);
    expect(ds).toMatchObject({
      moref: "datastore-7",
      name: "pure-ds01",
      dsType: "VMFS",
      capacityBytes: 1000,
      freeBytes: 400,
      // capacity - free + uncommitted = 1000 - 400 + 250
      provisionedBytes: 850,
      accessible: true,
      hostMorefs: ["host-1", "host-2"],
      backingLabel: "Pure Storage",
    });
    expect(ds?.backing?.vmfs).toEqual([{ diskName: "naa.624a93701234", vendor: "Pure Storage" }]);
  });

  it("parses an NFS datastore into nas backing with an NFS label", () => {
    const block = extractObjectBlocks(`<r>${DATASTORE_NAS_XML}</r>`)[0];
    const ds = parseDatastoreBlock(block);
    expect(ds?.backing).toEqual({ nas: { remoteHost: "filer01.corp", remotePath: "/vol/ds1" } });
    expect(ds?.backingLabel).toBe("NFS: filer01.corp");
    expect(ds?.provisionedBytes).toBeNull(); // no capacity trio → no math
  });
});

// ─── REST VM detail parsing ─────────────────────────────────────────────────

describe("parseVmDetail", () => {
  const dsByName = new Map([["pure-ds01", "datastore-7"]]);

  it("parses identity, hardware, NICs (connected flag), and disks with datastore names", () => {
    const vm = parseVmDetail("vm-42", "host-1", "list-name", "POWERED_ON", {
      name: "prod-sql01",
      power_state: "POWERED_ON",
      identity: { instance_uuid: "50aa-bb", bios_uuid: "42aa-cc" },
      cpu: { count: 4 },
      memory: { size_MiB: 8192 },
      nics: {
        "4000": { mac_address: "00:50:56:aa:bb:cc", state: "CONNECTED" },
        "4001": { mac_address: "00:50:56:dd:ee:ff", state: "NOT_CONNECTED" },
      },
      disks: {
        "2000": { label: "Hard disk 1", capacity: 107374182400, backing: { vmdk_file: "[pure-ds01] prod-sql01/prod-sql01.vmdk" } },
      },
    }, dsByName);
    expect(vm.instanceUuid).toBe("50aa-bb");
    expect(vm.biosUuid).toBe("42aa-cc");
    expect(vm.name).toBe("prod-sql01");
    expect(vm.cpuCount).toBe(4);
    expect(vm.memoryMiB).toBe(8192);
    expect(vm.nicMacs).toEqual([
      { mac: "00:50:56:aa:bb:cc", connected: true },
      { mac: "00:50:56:dd:ee:ff", connected: false },
    ]);
    expect(vm.disks).toEqual([
      {
        key: "2000",
        label: "Hard disk 1",
        capacityBytes: 107374182400,
        datastoreName: "pure-ds01",
        datastoreMoref: "datastore-7",
      },
    ]);
  });

  it("degrades gracefully on a sparse detail body (falls back to list values)", () => {
    const vm = parseVmDetail("vm-9", "host-2", "orphan-vm", "POWERED_OFF", {}, new Map());
    expect(vm.moref).toBe("vm-9");
    expect(vm.hostMoref).toBe("host-2");
    expect(vm.name).toBe("orphan-vm");
    expect(vm.powerState).toBe("POWERED_OFF");
    expect(vm.instanceUuid).toBeNull();
    expect(vm.nicMacs).toEqual([]);
    expect(vm.disks).toEqual([]);
  });
});


// ─── disappearance sweep ────────────────────────────────────────────────────

describe("vcenterSweepBlockedReason", () => {
  const full = { hosts: [{}] as any[], vms: [{}] as any[], inventoryComplete: true };

  it("allows the sweep on a complete, non-empty inventory", () => {
    expect(vcenterSweepBlockedReason(full as any)).toBeNull();
  });

  it("blocks on a partial read — a failed per-host VM list looks exactly like a deleted fleet", () => {
    expect(vcenterSweepBlockedReason({ ...full, inventoryComplete: false } as any)).toMatch(/incomplete/);
  });

  it("blocks on an empty read — zero hosts and zero VMs is usually a permission answer", () => {
    expect(vcenterSweepBlockedReason({ hosts: [], vms: [], inventoryComplete: true } as any)).toMatch(/empty/);
  });

  it("allows a vCenter with hosts but genuinely no VMs", () => {
    expect(vcenterSweepBlockedReason({ hosts: [{}], vms: [], inventoryComplete: true } as any)).toBeNull();
  });
});

describe("partitionStaleVcenterSources", () => {
  const vmRow = (externalId: string, moref: string | null) => ({
    externalId,
    sourceKind: "vcenter-vm",
    observed: moref === null ? {} : { moref },
  });

  it("treats a VM absent from the raw listing as gone", () => {
    const rows = [vmRow("uuid-a", "vm-1")];
    const { retained, gone } = partitionStaleVcenterSources(rows, ["vm-2"]);
    expect(retained).toEqual([]);
    expect(gone).toEqual(rows);
  });

  it("retains a VM still in the raw listing — filtered out, not deleted", () => {
    const rows = [vmRow("uuid-a", "vm-1")];
    const { retained, gone } = partitionStaleVcenterSources(rows, ["vm-1"]);
    expect(retained).toEqual(rows);
    expect(gone).toEqual([]);
  });

  it("never retains a host row — the host list arrives whole or throws", () => {
    const rows = [{ externalId: `${INTG}:host-9`, sourceKind: "vcenter-host", observed: { moref: "host-9" } }];
    const { retained, gone } = partitionStaleVcenterSources(rows, ["host-9"]);
    expect(retained).toEqual([]);
    expect(gone).toEqual(rows);
  });

  it("treats a row with no recorded moref as gone (nothing to match it against)", () => {
    const rows = [vmRow("uuid-a", null)];
    const { gone } = partitionStaleVcenterSources(rows, ["vm-1"]);
    expect(gone).toEqual(rows);
  });

  it("splits a mixed batch", () => {
    const kept = vmRow("uuid-a", "vm-1");
    const deleted = vmRow("uuid-b", "vm-2");
    const host = { externalId: `${INTG}:host-1`, sourceKind: "vcenter-host", observed: { moref: "host-1" } };
    const { retained, gone } = partitionStaleVcenterSources([kept, deleted, host], new Set(["vm-1"]));
    expect(retained).toEqual([kept]);
    expect(gone).toEqual([deleted, host]);
  });
});

// ─── PerformanceManager ─────────────────────────────────────────────────────
//
// Per-core CPU and a host's balloon/swap come from QueryPerf, not quickStats.
// Two things are worth pinning: the counter ids are resolved by NAME (they
// are not stable across vCenter builds, so a hard-coded id would read the
// wrong metric on someone else's appliance), and the scaling — cpu.usage is
// in HUNDREDTHS of a percent and the memory counters are in KB.

const PERF_COUNTERS_XML =
  `<returnval><key>2</key>` +
  `<nameInfo><label>Usage</label><key>usage</key></nameInfo>` +
  `<groupInfo><label>CPU</label><key>cpu</key></groupInfo>` +
  `<rollupType>none</rollupType><level>4</level></returnval>` +
  // The one we want: same group+name, rollupType average.
  `<returnval><key>6</key>` +
  `<nameInfo><label>Usage</label><key>usage</key></nameInfo>` +
  `<groupInfo><label>CPU</label><key>cpu</key></groupInfo>` +
  `<rollupType>average</rollupType><level>1</level></returnval>` +
  `<returnval><key>90</key>` +
  `<nameInfo><label>Balloon</label><key>vmmemctl</key></nameInfo>` +
  `<groupInfo><label>Memory</label><key>mem</key></groupInfo>` +
  `<rollupType>average</rollupType><level>1</level></returnval>` +
  `<returnval><key>98</key>` +
  `<nameInfo><label>Swap used</label><key>swapused</key></nameInfo>` +
  `<groupInfo><label>Memory</label><key>mem</key></groupInfo>` +
  `<rollupType>average</rollupType><level>2</level></returnval>`;

describe("SOAP PerformanceManager parsing", () => {
  it("resolves counter ids by group+name+rollup, never by position", () => {
    const ids = parsePerfCounterIds(PERF_COUNTERS_XML);
    // key 2 is the same cpu.usage metric at a different rollup and must lose.
    expect(ids).toEqual({ cpuUsage: 6, memBalloon: 90, memSwapUsed: 98 });
  });

  it("reports a counter this vCenter does not publish as null", () => {
    const ids = parsePerfCounterIds("<returnval><key>1</key><rollupType>latest</rollupType></returnval>");
    expect(ids).toEqual({ cpuUsage: null, memBalloon: null, memSwapUsed: null });
  });

  const IDS = { cpuUsage: 6, memBalloon: 90, memSwapUsed: 98 };

  it("transposes per-instance series into a core vector and scales to percent", () => {
    const xml =
      `<returnval xsi:type="PerfEntityMetric"><entity type="VirtualMachine">vm-42</entity>` +
      `<value xsi:type="PerfMetricIntSeries"><id><counterId>6</counterId><instance>0</instance></id><value>2534</value></value>` +
      `<value xsi:type="PerfMetricIntSeries"><id><counterId>6</counterId><instance>1</instance></id><value>1000</value></value>` +
      `</returnval>`;
    const out = parsePerfResponse(xml, IDS);
    expect(out.get("vm-42")!.corePcts).toEqual([25.3, 10]);
  });

  it("discards the aggregate series", () => {
    // The caller has a better aggregate from quickStats, computed against the
    // entity's real clock rate. Two aggregates a rounding step apart would
    // read as the average line having lost its own cores.
    const xml =
      `<returnval><entity type="VirtualMachine">vm-42</entity>` +
      `<value><id><counterId>6</counterId><instance></instance></id><value>9900</value></value>` +
      `<value><id><counterId>6</counterId><instance>0</instance></id><value>1200</value></value>` +
      `</returnval>`;
    expect(parsePerfResponse(xml, IDS).get("vm-42")!.corePcts).toEqual([12]);
  });

  it("converts the memory counters from KB to bytes", () => {
    const xml =
      `<returnval><entity type="HostSystem">host-9</entity>` +
      `<value><id><counterId>90</counterId><instance></instance></id><value>4096</value></value>` +
      `<value><id><counterId>98</counterId><instance></instance></id><value>1024</value></value>` +
      `</returnval>`;
    const s = parsePerfResponse(xml, IDS).get("host-9")!;
    expect(s.balloonedBytes).toBe(4096 * 1024);
    expect(s.swappedBytes).toBe(1024 * 1024);
    // No cpu series in this response — null, never an empty array, which the
    // chart would read as "this host has no cores".
    expect(s.corePcts).toBeNull();
  });

  it("gives an entity that reported nothing a null vector rather than []", () => {
    const xml = `<returnval><entity type="VirtualMachine">vm-off</entity></returnval>`;
    expect(parsePerfResponse(xml, IDS).get("vm-off")!.corePcts).toBeNull();
  });

  it("ignores a counter the caller did not ask about", () => {
    const xml =
      `<returnval><entity type="HostSystem">host-9</entity>` +
      `<value><id><counterId>4242</counterId><instance>0</instance></id><value>5000</value></value>` +
      `</returnval>`;
    const s = parsePerfResponse(xml, IDS).get("host-9")!;
    expect(s.corePcts).toBeNull();
    expect(s.balloonedBytes).toBeNull();
  });
});

describe("quickStats memory breakdown", () => {
  const VM_BANDS_XML =
    `<returnval><objects>` +
    `<obj type="VirtualMachine">vm-77</obj>` +
    `<propSet><name>config.hardware.memoryMB</name><val xsi:type="xsd:int">8192</val></propSet>` +
    `<propSet><name>summary.quickStats.privateMemory</name><val xsi:type="xsd:int">2048</val></propSet>` +
    `<propSet><name>summary.quickStats.sharedMemory</name><val xsi:type="xsd:int">512</val></propSet>` +
    `<propSet><name>summary.quickStats.balloonedMemory</name><val xsi:type="xsd:int">256</val></propSet>` +
    `<propSet><name>summary.quickStats.swappedMemory</name><val xsi:type="xsd:int">64</val></propSet>` +
    `<propSet><name>summary.quickStats.compressedMemory</name><val xsi:type="xsd:long">2048</val></propSet>` +
    `</objects></returnval>`;

  it("reads the bands in bytes, and knows compressedMemory is KB not MB", () => {
    const b = parseQuickStatsBlock(extractObjectBlocks(VM_BANDS_XML)[0])!;
    expect(b.memPrivateBytes).toBe(2048 * 1024 * 1024);
    expect(b.memSharedBytes).toBe(512 * 1024 * 1024);
    expect(b.memBalloonedBytes).toBe(256 * 1024 * 1024);
    expect(b.memSwappedBytes).toBe(64 * 1024 * 1024);
    // 2048 KB, not 2048 MB — the one field VMware documents differently, and
    // reading it as MB would draw a 2 GB compressed band on an idle VM.
    expect(b.memCompressedBytes).toBe(2048 * 1024);
  });

  it("leaves the bands null on a source that published none", () => {
    const b = parseQuickStatsBlock(extractObjectBlocks(QUICKSTATS_XML)[1])!;
    expect(b.memPrivateBytes).toBeNull();
    expect(b.memBalloonedBytes).toBeNull();
    // And per-core stays null until the perf pass fills it — a property-only
    // fetch (discovery) must never claim to have measured cores.
    expect(b.cpuCorePcts).toBeNull();
  });
});
