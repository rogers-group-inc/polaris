/**
 * tests/unit/assetProjectionSnmpIdentity.test.ts
 *
 * Business rule 154 — where the `snmp-identity` enrichment source ranks in
 * the projection (utils/assetProjection.ts). Pinned:
 *
 *   - it fills hostname, model, serial, manufacturer and firmware for an
 *     asset only a gate's device inventory knows (the MDS 9148S case);
 *   - it beats the gate's fingerprint and a Generic API feed (rule 100);
 *   - it loses to every source that manages the device — agent, controller,
 *     directory — and to the vendor-format sysDescr parse;
 *   - it is enrichment: never a claim of existence.
 */

import { describe, it, expect } from "vitest";
import { projectAssetFromSources, ENRICHMENT_SOURCE_KINDS, type AssetSourceForProjection } from "../../src/utils/assetProjection.js";

function src(sourceKind: string, observed: Record<string, unknown>): AssetSourceForProjection {
  return { sourceKind, inferred: false, observed, lastSeen: new Date() };
}

const SELF = {
  hostname: "metro-9148s-1",
  model: "DS-C9148S-K9",
  serialNumber: "JAF1234ABCD",
  manufacturer: "Cisco Systems, Inc.",
  osVersion: "8.4(2c)",
};

describe("projectAssetFromSources — snmp-identity (rule 154)", () => {
  it("fills every identity field of an asset only a gate's inventory knows", () => {
    const { projected, provenance } = projectAssetFromSources([
      src("fortigate-endpoint", { hardwareVendor: "Cisco" }),
      src("snmp-identity", SELF),
    ]);
    expect(projected.hostname).toBe("metro-9148s-1");
    expect(projected.model).toBe("DS-C9148S-K9");
    expect(projected.serialNumber).toBe("JAF1234ABCD");
    expect(projected.osVersion).toBe("8.4(2c)");
    // Through normalizeManufacturer; the alias table that folds this to
    // "Cisco" is DB-loaded, so a unit test sees the device's own spelling.
    expect(projected.manufacturer).toBe("Cisco Systems, Inc.");
    expect(provenance.hostname).toBe("snmp-identity");
    expect(provenance.serialNumber).toBe("snmp-identity");
  });

  it("beats the gate's DHCP name and fingerprint, and a Generic API feed", () => {
    const { projected } = projectAssetFromSources([
      src("fortigate-endpoint", { hostname: "dhcp-client-id", model: "network device" }),
      src("generic-api", { hostname: "cmdb-name", model: "CMDB model", serial: "CMDB-SERIAL-1" }),
      src("snmp-identity", SELF),
    ]);
    expect(projected.hostname).toBe("metro-9148s-1");
    expect(projected.model).toBe("DS-C9148S-K9");
    expect(projected.serialNumber).toBe("JAF1234ABCD");
  });

  it("loses to a source that manages the device", () => {
    const fsw = projectAssetFromSources([
      src("fortiswitch", { switchId: "S548DF-CORE", serial: "S548DFTF00000001", osVersion: "7.2.5" }),
      src("snmp-identity", { hostname: "factory-name", serialNumber: "OTHER-SERIAL-9", osVersion: "1.0" }),
    ]);
    expect(fsw.projected.hostname).toBe("S548DF-CORE");
    expect(fsw.projected.serialNumber).toBe("S548DFTF00000001");
    expect(fsw.projected.osVersion).toBe("7.2.5");

    const agent = projectAssetFromSources([
      src("polaris-agent", { hostname: "host1", model: "PowerEdge R740", serialNumber: "ABC1234" }),
      src("snmp-identity", SELF),
    ]);
    expect(agent.projected.hostname).toBe("host1");
    expect(agent.projected.model).toBe("PowerEdge R740");
  });

  it("ranks under the vendor-format sysDescr parse", () => {
    const { projected } = projectAssetFromSources([
      src("snmp-identity", { model: "entity-model", osVersion: "9.9" }),
      src("snmp-sysdescr", { model: "M2036-LE", osVersion: "10.12.114" }),
    ]);
    expect(projected.model).toBe("M2036-LE");
    expect(projected.osVersion).toBe("10.12.114");
  });

  it("ranks a factory-default sysName below every name anyone chose (rule 154(a))", () => {
    // An APC card's "apc" + last-3-MAC-octets name loses even to the DHCP
    // client identifier and a Generic API feed…
    const named = projectAssetFromSources([
      src("fortigate-endpoint", { hostname: "dc-pdu-a3" }),
      src("snmp-identity", { hostname: "apc8F29C4" }),
    ]);
    expect(named.projected.hostname).toBe("dc-pdu-a3");
    expect(named.provenance.hostname).toBe("fortigate-endpoint");

    // …but is still used when it is the only name there is.
    const alone = projectAssetFromSources([src("snmp-identity", { hostname: "apc8F29C4" })]);
    expect(alone.projected.hostname).toBe("apc8F29C4");

    // A name someone set keeps the snmp-identity rung above the DHCP name.
    const chosen = projectAssetFromSources([
      src("fortigate-endpoint", { hostname: "dhcp-name" }),
      src("snmp-identity", { hostname: "dc-pdu-a3" }),
    ]);
    expect(chosen.projected.hostname).toBe("dc-pdu-a3");
  });

  it("takes a rack PDU's serial from the sysDescr parse, above ENTITY-MIB (rule 161)", () => {
    const { projected, provenance } = projectAssetFromSources([
      src("snmp-identity", { serialNumber: "ENTITY-SERIAL-1" }),
      src("snmp-sysdescr", { model: "AP8870", serialNumber: "ZA2406030655" }),
    ]);
    expect(projected.serialNumber).toBe("ZA2406030655");
    expect(provenance.serialNumber).toBe("snmp-sysdescr");
  });

  it("is enrichment, never a claim that the device exists", () => {
    expect(ENRICHMENT_SOURCE_KINDS).toContain("snmp-identity");
  });
});
