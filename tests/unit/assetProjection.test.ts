/**
 * tests/unit/assetProjection.test.ts
 */

import { describe, it, expect } from "vitest";
import {
  projectAssetFromSources,
  type AssetSourceForProjection,
} from "../../src/utils/assetProjection.js";

function src(
  sourceKind: string,
  observed: Record<string, unknown>,
  inferred = false,
): AssetSourceForProjection {
  return { sourceKind, observed, inferred };
}

describe("projectAssetFromSources — empty + edge cases", () => {
  it("returns all-null projection for an asset with no sources", () => {
    const { projected, provenance } = projectAssetFromSources([]);
    expect(projected).toEqual({
      hostname: null,
      serialNumber: null,
      manufacturer: null,
      model: null,
      os: null,
      osVersion: null,
      learnedLocation: null,
      ipAddress: null,
      latitude: null,
      longitude: null,
      snmpLocation: null,
      learnedAddress: null,
      productType: null,
    });
    expect(provenance).toEqual({});
  });

  it("ignores inferred sources entirely (phase-1 backfill skeletons)", () => {
    const { projected, provenance } = projectAssetFromSources([
      src("ad", { dnsHostName: "old-laptop.contoso.com", operatingSystem: "Windows 10" }, true),
    ]);
    expect(projected.hostname).toBeNull();
    expect(projected.os).toBeNull();
    expect(provenance).toEqual({});
  });

  it("treats empty strings as no-opinion (falls through to next priority)", () => {
    const { projected, provenance } = projectAssetFromSources([
      src("intune", { deviceName: "   " }), // whitespace-only
      src("entra", { displayName: "LAPTOP-01" }),
    ]);
    expect(projected.hostname).toBe("LAPTOP-01");
    expect(provenance.hostname).toBe("entra");
  });
});

describe("projectAssetFromSources — hostname priority", () => {
  it("AD's FQDN wins over Intune+Entra short forms (hybrid Windows endpoint)", () => {
    // Tuned from production drift: ~7k entries/24h showed Asset.hostname
    // (FQDN) drifting against an Intune/Entra-preferred projection (short).
    // AD's FQDN is more useful — operators search for it in DNS / logs.
    const { projected, provenance } = projectAssetFromSources([
      src("intune", { deviceName: "MP2YZAC2" }),
      src("entra", { displayName: "MP2YZAC2" }),
      src("ad", { dnsHostName: "mp2yzac2.contoso.com", cn: "MP2YZAC2" }),
    ]);
    expect(projected.hostname).toBe("mp2yzac2.contoso.com");
    expect(provenance.hostname).toBe("ad");
  });

  it("intune wins over entra when no AD source", () => {
    const { projected, provenance } = projectAssetFromSources([
      src("intune", { deviceName: "INTUNE-NAME" }),
      src("entra", { displayName: "ENTRA-NAME" }),
    ]);
    expect(projected.hostname).toBe("INTUNE-NAME");
    expect(provenance.hostname).toBe("intune");
  });

  it("intune wins when AD's dnsHostName is short-form (no dot — not FQDN)", () => {
    // The FQDN-first rule only kicks in when AD's dnsHostName contains a
    // dot. Short-form dnsHostName falls through to the regular priority.
    const { projected, provenance } = projectAssetFromSources([
      src("intune", { deviceName: "LAPTOP-01" }),
      src("ad", { dnsHostName: "LAPTOP-01" }), // no dot
    ]);
    expect(projected.hostname).toBe("LAPTOP-01");
    expect(provenance.hostname).toBe("intune");
  });

  it("falls through to entra when intune deviceName is missing", () => {
    const { projected, provenance } = projectAssetFromSources([
      src("intune", { serialNumber: "ABC123" }), // no deviceName
      src("entra", { displayName: "ENTRA-NAME" }),
    ]);
    expect(projected.hostname).toBe("ENTRA-NAME");
    expect(provenance.hostname).toBe("entra");
  });

  it("AD-only device: dnsHostName preferred (FQDN form)", () => {
    const { projected } = projectAssetFromSources([
      src("ad", { cn: "SHORTNAME", dnsHostName: "shortname.contoso.com" }),
    ]);
    expect(projected.hostname).toBe("shortname.contoso.com");
  });

  it("AD-only device: falls back to cn when dnsHostName is missing", () => {
    const { projected } = projectAssetFromSources([
      src("ad", { cn: "SHORTNAME" }),
    ]);
    expect(projected.hostname).toBe("SHORTNAME");
  });

  it("FortiGate firewall hostname when no other source contributes", () => {
    const { projected, provenance } = projectAssetFromSources([
      src("fortigate-firewall", { hostname: "fw-riverbend", serial: "FGT60FTK22000001" }),
    ]);
    expect(projected.hostname).toBe("fw-riverbend");
    expect(provenance.hostname).toBe("fortigate-firewall");
  });
});

describe("projectAssetFromSources — manufacturer + model + serial", () => {
  it("intune supplies hardware identity for endpoints", () => {
    // manufacturer flows through normalizeManufacturer; for inputs not in
    // the alias cache (which is empty in tests), it returns the value
    // unchanged. Real production has "Dell Inc." → "Dell" canonicalization
    // — covered by the manufacturerAliasService tests separately.
    const { projected } = projectAssetFromSources([
      src("intune", {
        serialNumber: "MP2YZAC2",
        manufacturer: "LENOVO",
        model: "83DG",
      }),
      src("entra", { displayName: "MP2YZAC2" }),
    ]);
    expect(projected.serialNumber).toBe("MP2YZAC2");
    expect(projected.manufacturer).toBe("LENOVO");
    expect(projected.model).toBe("83DG");
  });

  it("Fortinet manufacturer is always 'Fortinet' for firewall/switch/AP sources", () => {
    expect(
      projectAssetFromSources([src("fortigate-firewall", { serial: "FGT001" })]).projected.manufacturer,
    ).toBe("Fortinet");
    expect(
      projectAssetFromSources([src("fortiswitch", { serial: "S001" })]).projected.manufacturer,
    ).toBe("Fortinet");
    expect(
      projectAssetFromSources([src("fortiap", { serial: "AP001" })]).projected.manufacturer,
    ).toBe("Fortinet");
  });

  it("intune manufacturer wins over Fortinet fallback when both present", () => {
    // Hypothetical edge case — same asset has both sources. Intune wins.
    const { projected, provenance } = projectAssetFromSources([
      src("intune", { manufacturer: "LENOVO" }),
      src("fortigate-firewall", { serial: "FGT001" }),
    ]);
    expect(projected.manufacturer).toBe("LENOVO");
    expect(provenance.manufacturer).toBe("intune");
  });
});

describe("projectAssetFromSources — os + osVersion", () => {
  it("AD wins on os when present (verbose Windows edition); Intune wins on osVersion (specific build)", () => {
    // Tuned from production drift: AD's verbose `operatingSystem` ("Windows
    // 10 Pro") carries the edition info Intune/Entra collapse out. For
    // version, Intune's 4-part build is more specific than AD's "10.0
    // (build)".
    const { projected, provenance } = projectAssetFromSources([
      src("intune", { operatingSystem: "Windows", osVersion: "10.0.26100" }),
      src("entra", { operatingSystem: "Windows", operatingSystemVersion: "10.0.22000" }),
      src("ad", { operatingSystem: "Windows 11 Pro", operatingSystemVersion: "10.0 (22621)" }),
    ]);
    expect(projected.os).toBe("Windows 11 Pro");
    // The winning raw value is "10.0.26100"; normalizeWindowsOs then labels the
    // build with its marketing release (see utils/osNormalize.ts). Provenance
    // still names the source the raw value came from.
    expect(projected.osVersion).toBe("24H2 (10.0.26100)");
    expect(provenance.os).toBe("ad");
    expect(provenance.osVersion).toBe("intune");
  });

  it("Intune wins on os when no AD source", () => {
    const { projected, provenance } = projectAssetFromSources([
      src("intune", { operatingSystem: "iOS" }),
      src("entra", { operatingSystem: "iPadOS" }),
    ]);
    expect(projected.os).toBe("iOS");
    expect(provenance.os).toBe("intune");
  });

  it("FortiGate firewall osVersion when no Microsoft sources", () => {
    const { projected } = projectAssetFromSources([
      src("fortigate-firewall", { serial: "FGT001", osVersion: "v7.4.5" }),
    ]);
    expect(projected.osVersion).toBe("v7.4.5");
  });
});

describe("projectAssetFromSources — learnedLocation", () => {
  it("AD ouPath answers when it is the only field contributor", () => {
    const { projected, provenance } = projectAssetFromSources([
      src("ad", { ouPath: "OU=HQ/OU=Workstations" }),
    ]);
    expect(projected.learnedLocation).toBe("OU=HQ/OU=Workstations");
    expect(provenance.learnedLocation).toBe("ad");
  });

  it("by default a cloud source outranks AD's OU path", () => {
    // An OU path is org structure, not a place — the default order says so.
    // An operator who wants the OU reorders the Sources card.
    const { projected, provenance } = projectAssetFromSources([
      src("ad", { ouPath: "OU=HQ/OU=Workstations" }),
      src("entra", { displayName: "WS-01" }),
    ]);
    expect(projected.learnedLocation).toBe("Microsoft Entra ID");
    expect(provenance.learnedLocation).toBe("entra");
  });

  it("FortiSwitch reports controllerFortigate as location", () => {
    const { projected } = projectAssetFromSources([
      src("fortiswitch", { serial: "S001", controllerFortigate: "fw-riverbend" }),
    ]);
    expect(projected.learnedLocation).toBe("fw-riverbend");
  });

  it("operator priority reorders the winner, and an explicit order beats process state", () => {
    // The whole feature: an asset known to AD, Arc and a FortiGate has three
    // competing answers to "where is it?" and the operator picks.
    const sources = [
      src("ad", { ouPath: "OU=HQ" }),
      src("arc", { resourceGroup: "rg-prod" }),
      src("fortigate-endpoint", { learnedLocation: "FW-NASH" }),
    ];
    // Default: the sighting gate — the only one of the three naming a place.
    const byDefault = projectAssetFromSources(sources);
    expect(byDefault.projected.learnedLocation).toBe("FW-NASH");
    expect(byDefault.provenance.learnedLocation).toBe("fortigate-endpoint");

    const adFirst = projectAssetFromSources(sources, {
      learnedLocation: {
        order: ["ad", "fortigate-endpoint", "arc", "intune", "entra"],
        integrationPrefix: false,
      },
    });
    expect(adFirst.projected.learnedLocation).toBe("OU=HQ");
    expect(adFirst.provenance.learnedLocation).toBe("ad");

    const arcFirst = projectAssetFromSources(sources, {
      learnedLocation: { order: ["arc", "ad"], integrationPrefix: false },
    });
    expect(arcFirst.projected.learnedLocation).toBe("Azure Arc");
  });

  it("integrationPrefix renders <integration>:<fortigate> for Fortinet sources", () => {
    const sources = [src("fortigate-endpoint", { learnedLocation: "FW-NASH", integrationName: "FMG-Prod" })];
    expect(projectAssetFromSources(sources, {
      learnedLocation: { order: ["fortigate-endpoint"], integrationPrefix: true },
    }).projected.learnedLocation).toBe("FMG-Prod:FW-NASH");
    expect(projectAssetFromSources(sources, {
      learnedLocation: { order: ["fortigate-endpoint"], integrationPrefix: false },
    }).projected.learnedLocation).toBe("FW-NASH");
  });

  it("a Fortinet infra source suppresses the endpoint sighting whatever the operator order says", () => {
    // Invariant, not a preference: a firewall's site label is its own hostname
    // and a switch/AP's is its controller. The gate that sighted the device as
    // a DHCP client pre-adoption is not its location, and that stale endpoint
    // row survives the adoption.
    const { projected } = projectAssetFromSources(
      [
        src("fortigate-firewall", { hostname: "FW-NASH", serial: "FGT001" }),
        src("fortigate-endpoint", { learnedLocation: "FW-MEMPHIS" }),
      ],
      { learnedLocation: { order: ["fortigate-endpoint", "ad"], integrationPrefix: false } },
    );
    expect(projected.learnedLocation).toBeNull();

    for (const infra of [
      src("fortiswitch", { serial: "S124", controllerFortigate: "FW-NASH" }),
      src("fortiap", { serial: "FP231", controllerFortigate: "FW-NASH" }),
    ]) {
      const adopted = projectAssetFromSources(
        [infra, src("fortigate-endpoint", { learnedLocation: "FW-MEMPHIS" })],
        { learnedLocation: { order: ["fortigate-endpoint", "fortiswitch", "fortiap"], integrationPrefix: false } },
      );
      expect(adopted.projected.learnedLocation).toBe("FW-NASH");
    }
  });

  it("label-only sources answer when nothing else does", () => {
    const { projected, provenance } = projectAssetFromSources([
      src("entra", { displayName: "WS-01" }),
      src("intune", { deviceName: "WS-01" }),
    ]);
    // Previously null — the Sources column now names who knows the device
    // rather than sitting blank.
    expect(projected.learnedLocation).toBe("Microsoft Intune");
    expect(provenance.learnedLocation).toBe("intune");
  });

  it("FortiGate firewall does NOT project learnedLocation", () => {
    // The firewall's learnedLocation in legacy code is its own hostname,
    // which is already on Asset.hostname — projection deliberately leaves
    // learnedLocation null for firewalls so legacy "set when null"
    // behaviour continues to work.
    const { projected } = projectAssetFromSources([
      src("fortigate-firewall", { hostname: "fw-riverbend", serial: "FGT001" }),
    ]);
    expect(projected.learnedLocation).toBeNull();
  });
});

describe("projectAssetFromSources — ipAddress + lat/long", () => {
  it("FortiGate firewall mgmtIp + coordinates come from fortigate-firewall source", () => {
    const { projected, provenance } = projectAssetFromSources([
      src("fortigate-firewall", {
        serial: "FGT001",
        mgmtIp: "10.0.0.1",
        latitude: 38.123,
        longitude: -85.678,
      }),
    ]);
    expect(projected.ipAddress).toBe("10.0.0.1");
    expect(projected.latitude).toBe(38.123);
    expect(projected.longitude).toBe(-85.678);
    expect(provenance.ipAddress).toBe("fortigate-firewall");
    expect(provenance.latitude).toBe("fortigate-firewall");
  });

  it("endpoints (entra/intune/ad-only) get null ipAddress — DHCP-set values stay on Asset", () => {
    const { projected } = projectAssetFromSources([
      src("intune", { deviceName: "LAPTOP-01", serialNumber: "ABC123" }),
      src("entra", { displayName: "LAPTOP-01" }),
      src("ad", { dnsHostName: "laptop-01.contoso.com" }),
    ]);
    expect(projected.ipAddress).toBeNull();
    expect(projected.latitude).toBeNull();
    expect(projected.longitude).toBeNull();
  });

  it("fortigate-endpoint DHCP/ARP binding wins for plain endpoints (no infra source)", () => {
    const { projected, provenance } = projectAssetFromSources([
      src("intune", { deviceName: "LAPTOP-01" }),
      src("fortigate-endpoint", { ipAddress: "10.0.200.55", learnedLocation: "LAKESIDE-91G-1" }),
    ]);
    expect(projected.ipAddress).toBe("10.0.200.55");
    expect(provenance.ipAddress).toBe("fortigate-endpoint");
    expect(projected.learnedLocation).toBe("LAKESIDE-91G-1");
  });

  it("infrastructure mgmtIp beats a stale pre-adoption fortigate-endpoint sighting", () => {
    // The deployed-then-adopted scenario: a new FortiGate is first sighted
    // as a DHCP client of an existing gate (endpoint source with the leased
    // IP), then adopted into FMG (firewall source with the mgmt IP). The
    // mgmt IP must win or monitoring keeps probing the pre-adoption lease.
    const { projected, provenance } = projectAssetFromSources([
      src("fortigate-endpoint", { ipAddress: "10.0.200.30", learnedLocation: "LAKESIDE-91G-1", hostname: "RIVERBEND-201G-1" }),
      src("fortigate-firewall", { serial: "FG2H1GT0000", mgmtIp: "10.255.250.201", hostname: "RIVERBEND-201G-1" }),
    ]);
    expect(projected.ipAddress).toBe("10.255.250.201");
    expect(provenance.ipAddress).toBe("fortigate-firewall");
    // And the sighting gate must not become the firewall's site label —
    // a firewall's learnedLocation is its own hostname, stamped inline by
    // the firewall sync (projection stays silent).
    expect(projected.learnedLocation).toBeNull();
  });

  it("adopted FortiSwitch: mgmtIp + controllerFortigate beat the endpoint sighting", () => {
    const { projected, provenance } = projectAssetFromSources([
      src("fortigate-endpoint", { ipAddress: "10.0.200.40", learnedLocation: "SOME-OTHER-GATE" }),
      src("fortiswitch", { switchId: "SW-LAB", serial: "S124FLAB", mgmtIp: "10.255.250.60", controllerFortigate: "LAKESIDE-91G-1" }),
    ]);
    expect(projected.ipAddress).toBe("10.255.250.60");
    expect(provenance.ipAddress).toBe("fortiswitch");
    expect(projected.learnedLocation).toBe("LAKESIDE-91G-1");
    expect(provenance.learnedLocation).toBe("fortiswitch");
  });

  it("infra source without a mgmtIp falls back to the endpoint sighting", () => {
    const { projected, provenance } = projectAssetFromSources([
      src("fortigate-firewall", { serial: "FGT002" }), // no mgmtIp observed
      src("fortigate-endpoint", { ipAddress: "10.0.200.30" }),
    ]);
    expect(projected.ipAddress).toBe("10.0.200.30");
    expect(provenance.ipAddress).toBe("fortigate-endpoint");
  });

  it("non-numeric latitude/longitude is treated as missing", () => {
    const { projected } = projectAssetFromSources([
      src("fortigate-firewall", {
        serial: "FGT001",
        latitude: "38.123", // string, not number
        longitude: null,
      }),
    ]);
    expect(projected.latitude).toBeNull();
    expect(projected.longitude).toBeNull();
  });
});

describe("projectAssetFromSources — learnedAddress", () => {
  it("comes from the fortigate-firewall metavarAddress", () => {
    const { projected, provenance } = projectAssetFromSources([
      src("fortigate-firewall", { serial: "FGT001", metavarAddress: "421 Great Circle Rd, Ashfield TN" }),
    ]);
    expect(projected.learnedAddress).toBe("421 Great Circle Rd, Ashfield TN");
    expect(provenance.learnedAddress).toBe("fortigate-firewall");
  });

  it("is null when no source carries an address metavar", () => {
    const { projected, provenance } = projectAssetFromSources([
      src("fortigate-firewall", { serial: "FGT001", mgmtIp: "10.0.0.1" }),
      src("ad", { dnsHostName: "fw.contoso.com" }),
    ]);
    expect(projected.learnedAddress).toBeNull();
    expect(provenance.learnedAddress).toBeUndefined();
  });
});

describe("projectAssetFromSources — hybrid Windows laptop (full integration scenario)", () => {
  it("merges entra + intune + ad correctly with priorities", () => {
    const { projected, provenance } = projectAssetFromSources([
      src("entra", {
        deviceId: "8f4e-...",
        displayName: "MP2YZAC2",
        operatingSystem: "Windows",
        operatingSystemVersion: "10.0",
        accountEnabled: true,
        onPremisesSecurityIdentifier: "S-1-5-21-...",
      }),
      src("intune", {
        azureADDeviceId: "8f4e-...",
        deviceName: "MP2YZAC2",
        operatingSystem: "Windows",
        osVersion: "10.0.26200.8246",
        serialNumber: "MP2YZAC2",
        manufacturer: "LENOVO",
        model: "83DG",
        userPrincipalName: "alice@contoso.com",
      }),
      src("ad", {
        objectGuid: "1234abcd...",
        cn: "MP2YZAC2",
        dnsHostName: "mp2yzac2.contoso.com",
        ouPath: "OU=HQ/OU=Workstations",
        operatingSystem: "Windows 11 Pro",
        operatingSystemVersion: "10.0 (26200)",
      }),
    ]);
    expect(projected).toEqual({
      hostname: "mp2yzac2.contoso.com", // ad FQDN wins
      serialNumber: "MP2YZAC2",
      manufacturer: "LENOVO",
      model: "83DG",
      os: "Windows 11 Pro", // ad wins (edition info)
      osVersion: "25H2 (10.0.26200.8246)", // intune wins (specific build), then release-labeled
      learnedLocation: "Microsoft Intune", // default order ranks the cloud sources above AD's OU path
      ipAddress: null, // no source carries endpoint IP
      latitude: null,
      longitude: null,
      snmpLocation: null, // not a fortigate-firewall source
      learnedAddress: null, // not a fortigate-firewall source
      productType: null,
    });
    expect(provenance.hostname).toBe("ad");
    expect(provenance.os).toBe("ad");
    expect(provenance.osVersion).toBe("intune");
    expect(provenance.learnedLocation).toBe("intune");
  });
});

// ─── vCenter sources (definitive below the agent) ───────────────────────────

describe("projectAssetFromSources — vCenter priority", () => {
  it("vcenter-vm beats AD / Intune / Entra / fortigate-endpoint on every field it carries", () => {
    const { projected, provenance } = projectAssetFromSources([
      src("ad", { dnsHostName: "sql01.corp.local", operatingSystem: "Windows Server 2019 Standard" }),
      src("intune", { deviceName: "SQL01", operatingSystem: "Windows", manufacturer: "Dell Inc.", model: "PowerEdge R750" }),
      src("fortigate-endpoint", { hostname: "sql01-dhcp", ipAddress: "10.1.1.50", os: "Windows" }),
      src("vcenter-vm", {
        guestHostname: "sql01.corp.local",
        name: "prod-sql01",
        guestOsFullName: "Microsoft Windows Server 2022 (64-bit)",
        guestIp: "10.1.1.51",
      }),
    ]);
    expect(projected.hostname).toBe("sql01.corp.local");
    expect(provenance.hostname).toBe("vcenter-vm");
    expect(projected.os).toBe("Microsoft Windows Server 2022 (64-bit)");
    expect(provenance.os).toBe("vcenter-vm");
    // Live Tools-reported IP beats the DHCP sighting.
    expect(projected.ipAddress).toBe("10.1.1.51");
    expect(provenance.ipAddress).toBe("vcenter-vm");
    // Constant manufacturer/model for VMs (normalizeManufacturer preserves
    // the raw vendor string here; the ManufacturerAlias registry canonicalizes
    // at runtime when the operator has an alias configured).
    expect(projected.manufacturer).toBe("VMware, Inc.");
    expect(provenance.manufacturer).toBe("vcenter-vm");
    expect(projected.model).toBe("VMware Virtual Platform");
  });

  it("polaris-agent still wins over vcenter-vm (in-guest truth beats hypervisor view)", () => {
    const { projected, provenance } = projectAssetFromSources([
      src("vcenter-vm", { guestHostname: "sql01", guestOsFullName: "Ubuntu Linux (64-bit)" }),
      src("polaris-agent", { hostname: "sql01.internal", os: "Ubuntu 24.04.1 LTS", manufacturer: "VMware, Inc.", model: "VMware Virtual Platform" }),
    ]);
    expect(projected.hostname).toBe("sql01.internal");
    expect(provenance.hostname).toBe("polaris-agent");
    expect(projected.os).toBe("Ubuntu 24.04.1 LTS");
    expect(provenance.os).toBe("polaris-agent");
  });

  it("vcenter-vm falls back to the VM display name when Tools is off (no guestHostname)", () => {
    const { projected } = projectAssetFromSources([
      src("vcenter-vm", { name: "appliance-01", guestHostname: null }),
    ]);
    expect(projected.hostname).toBe("appliance-01");
  });

  it("vcenter-host projects name / constant ESXi os / resolved IP, and never a serial", () => {
    const { projected, provenance } = projectAssetFromSources([
      src("vcenter-host", { name: "esx01.corp.local", resolvedIp: "10.0.0.11" }),
    ]);
    expect(projected.hostname).toBe("esx01.corp.local");
    expect(projected.os).toBe("VMware ESXi");
    expect(projected.ipAddress).toBe("10.0.0.11");
    expect(provenance.ipAddress).toBe("vcenter-host");
    expect(projected.serialNumber).toBeNull();
    expect(projected.osVersion).toBeNull(); // version not exposed by REST — no rule
  });

  it("infrastructure mgmtIp still outranks the vcenter-vm guest IP (virtual FortiGate)", () => {
    const { projected, provenance } = projectAssetFromSources([
      src("vcenter-vm", { guestIp: "10.9.9.9", name: "fgt-vm01" }),
      src("fortigate-firewall", { hostname: "fgt-vm01", mgmtIp: "10.0.0.254" }),
    ]);
    expect(projected.ipAddress).toBe("10.0.0.254");
    expect(provenance.ipAddress).toBe("fortigate-firewall");
  });
  // ─── Azure Arc ────────────────────────────────────────────────────────────
  // The Connected Machine agent runs IN the guest, so Arc reports the running
  // OS SKU, the real domain-joined FQDN, and live SMBIOS data. It therefore
  // sits directly under polaris-agent for hardware/OS facts — but stays BELOW
  // vCenter for hostname, deliberately leaving the "vCenter is definitive"
  // decision untouched.

  it("arc dnsFqdn outranks AD dnsHostName for hostname", () => {
    const { projected, provenance } = projectAssetFromSources([
      src("ad", { dnsHostName: "web01.old.corp.local", cn: "WEB01" }),
      src("arc", { dnsFqdn: "web01.corp.local", displayName: "WEB01" }),
    ]);
    expect(projected.hostname).toBe("web01.corp.local");
    expect(provenance.hostname).toBe("arc");
  });

  it("arc still loses hostname to vCenter and to the Polaris Agent", () => {
    const viaVcenter = projectAssetFromSources([
      src("arc", { dnsFqdn: "web01.corp.local" }),
      src("vcenter-vm", { guestHostname: "web01.vc.local" }),
    ]);
    expect(viaVcenter.projected.hostname).toBe("web01.vc.local");

    const viaAgent = projectAssetFromSources([
      src("arc", { dnsFqdn: "web01.corp.local" }),
      src("polaris-agent", { hostname: "web01-agent" }),
    ]);
    expect(viaAgent.projected.hostname).toBe("web01-agent");
  });

  it("a dot-less arc FQDN does not win the FQDN rule", () => {
    const { projected, provenance } = projectAssetFromSources([
      src("ad", { dnsHostName: "web01.corp.local" }),
      src("arc", { adFqdn: "WEB01", displayName: "WEB01" }),
    ]);
    expect(projected.hostname).toBe("web01.corp.local");
    expect(provenance.hostname).toBe("ad");
  });

  it("arc osSku beats AD's stale operatingSystem", () => {
    const { projected, provenance } = projectAssetFromSources([
      src("ad", { operatingSystem: "Windows Server 2016 Standard" }),
      src("arc", { osSku: "Windows Server 2022 Datacenter", osVersion: "10.0.20348" }),
    ]);
    expect(projected.os).toBe("Windows Server 2022 Datacenter");
    expect(provenance.os).toBe("arc");
    expect(projected.osVersion).toBe("10.0.20348");
  });

  it("arc serial beats Intune's enrollment-time value", () => {
    const { projected, provenance } = projectAssetFromSources([
      src("intune", { serialNumber: "OLD-ENROLL-123" }),
      src("arc", { serialNumber: "SMBIOS-999" }),
    ]);
    expect(projected.serialNumber).toBe("SMBIOS-999");
    expect(provenance.serialNumber).toBe("arc");
  });

  it("the Polaris Agent still outranks arc on every hardware/OS field", () => {
    const { projected } = projectAssetFromSources([
      src("arc", { osSku: "Ubuntu 22.04.4 LTS", serialNumber: "ARC-1", manufacturer: "Dell Inc.", model: "ARC-MODEL" }),
      src("polaris-agent", { os: "Red Hat Enterprise Linux 9.4", serialNumber: "AGENT-1", manufacturer: "HP", model: "AGENT-MODEL" }),
    ]);
    expect(projected.os).toBe("Red Hat Enterprise Linux 9.4");
    expect(projected.serialNumber).toBe("AGENT-1");
    expect(projected.model).toBe("AGENT-MODEL");
  });

  it("arc contributes \"Azure Arc\" as its location, and by default outranks an AD OU path", () => {
    const withAd = projectAssetFromSources([
      src("arc", { resourceGroup: "rg-arc-onboarding" }),
      src("ad", { ouPath: "OU=Servers,DC=corp,DC=local" }),
    ]);
    expect(withAd.projected.learnedLocation).toBe("Azure Arc");

    // The resource group is a billing/management container whose name says
    // nothing about where the machine is ("updatemanager", "rg-prod"), so the
    // column names the source instead. The RG stays on the observed blob.
    const arcOnly = projectAssetFromSources([src("arc", { resourceGroup: "rg-prod" })]);
    expect(arcOnly.projected.learnedLocation).toBe("Azure Arc");
  });

  it("arc never supplies coordinates, snmpLocation, or an Azure region as a location", () => {
    const { projected } = projectAssetFromSources([
      src("arc", { resourceGroup: "rg-prod", azureRegion: "eastus" }),
    ]);
    // The region says where the Arc RECORD lives, not where the machine is.
    expect(projected.learnedLocation).toBe("Azure Arc");
    expect(projected.latitude).toBeNull();
    expect(projected.longitude).toBeNull();
    expect(projected.snmpLocation).toBeNull();
  });

  it("arc ipAddresses fill ipAddress but lose to the live vCenter guest IP", () => {
    const arcOnly = projectAssetFromSources([src("arc", { ipAddresses: ["10.0.0.5", "fe80::1"] })]);
    expect(arcOnly.projected.ipAddress).toBe("10.0.0.5");

    const withVcenter = projectAssetFromSources([
      src("arc", { ipAddresses: ["10.0.0.5"] }),
      src("vcenter-vm", { guestIp: "10.0.0.6" }),
    ]);
    expect(withVcenter.projected.ipAddress).toBe("10.0.0.6");
  });
});

describe("assetProjection — Azure Arc Kubernetes clusters", () => {
  it("projects the cluster name, a constant OS, and the k8s version", () => {
    const { projected, provenance } = projectAssetFromSources([
      src("arc-k8s", {
        name: "prod-cluster",
        kubernetesVersion: "1.29.4",
        distribution: "aks_edge",
        resourceGroup: "rg-k8s",
      }),
    ]);
    expect(projected.hostname).toBe("prod-cluster");
    expect(projected.os).toBe("Kubernetes (aks_edge)");
    expect(projected.osVersion).toBe("1.29.4");
    // Same reasoning as plain Arc: the resource group is a billing container,
    // so the location column names the source instead.
    expect(projected.learnedLocation).toBe("Azure Arc (Kubernetes)");
    expect(provenance.os).toBe("arc-k8s");
  });

  it("falls back to a bare Kubernetes label when no distribution is reported", () => {
    const { projected } = projectAssetFromSources([
      src("arc-k8s", { name: "c1", kubernetesVersion: "1.30.0" }),
    ]);
    expect(projected.os).toBe("Kubernetes");
  });

  it("never supplies hardware fields — a cluster has no serial or model", () => {
    const { projected } = projectAssetFromSources([
      src("arc-k8s", { name: "c1", kubernetesVersion: "1.30.0" }),
    ]);
    expect(projected.serialNumber).toBeNull();
    expect(projected.manufacturer).toBeNull();
    expect(projected.model).toBeNull();
    expect(projected.ipAddress).toBeNull();
  });
});

describe("projectAssetFromSources — freshest same-kind row speaks for the kind", () => {
  // fortigate-endpoint is keyed by MAC, so a device that changed NICs keeps
  // one row per MAC on the same asset. The freshest row (lastSeen) must win
  // the pick; before this, the first row in (unordered) list order did, so a
  // stale NIC's blob could keep reverting ipAddress on every projection apply.
  it("prefers the fortigate-endpoint row with the freshest lastSeen", () => {
    const { projected, provenance } = projectAssetFromSources([
      {
        sourceKind: "fortigate-endpoint",
        inferred: false,
        observed: { ipAddress: "10.1.1.50", hostname: "laptop-dock" },
        lastSeen: new Date("2026-08-01T00:00:00Z"),
      },
      {
        sourceKind: "fortigate-endpoint",
        inferred: false,
        observed: { ipAddress: "10.2.2.60", hostname: "laptop-wifi" },
        lastSeen: new Date("2026-08-20T00:00:00Z"),
      },
    ]);
    expect(projected.ipAddress).toBe("10.2.2.60");
    expect(projected.hostname).toBe("laptop-wifi");
    expect(provenance.ipAddress).toBe("fortigate-endpoint");
  });

  it("freshest-row order does not depend on list order", () => {
    const fresh: AssetSourceForProjection = {
      sourceKind: "fortigate-endpoint",
      inferred: false,
      observed: { ipAddress: "10.2.2.60" },
      lastSeen: new Date("2026-08-20T00:00:00Z"),
    };
    const stale: AssetSourceForProjection = {
      sourceKind: "fortigate-endpoint",
      inferred: false,
      observed: { ipAddress: "10.1.1.50" },
      lastSeen: new Date("2026-08-01T00:00:00Z"),
    };
    expect(projectAssetFromSources([fresh, stale]).projected.ipAddress).toBe("10.2.2.60");
    expect(projectAssetFromSources([stale, fresh]).projected.ipAddress).toBe("10.2.2.60");
  });

  it("keeps first-row behavior when lastSeen is absent (legacy callers)", () => {
    const { projected } = projectAssetFromSources([
      src("fortigate-endpoint", { ipAddress: "10.1.1.50" }),
      src("fortigate-endpoint", { ipAddress: "10.2.2.60" }),
    ]);
    expect(projected.ipAddress).toBe("10.1.1.50");
  });

  it("a row WITH lastSeen beats rows without one", () => {
    const { projected } = projectAssetFromSources([
      src("fortigate-endpoint", { ipAddress: "10.1.1.50" }),
      {
        sourceKind: "fortigate-endpoint",
        inferred: false,
        observed: { ipAddress: "10.2.2.60" },
        lastSeen: new Date("2026-08-20T00:00:00Z"),
      },
    ]);
    expect(projected.ipAddress).toBe("10.2.2.60");
  });

  it("does not change cross-kind priority — infra mgmtIp still beats a fresher endpoint row", () => {
    const { projected, provenance } = projectAssetFromSources([
      {
        sourceKind: "fortiswitch",
        inferred: false,
        observed: { mgmtIp: "10.0.0.2" },
        lastSeen: new Date("2026-08-01T00:00:00Z"),
      },
      {
        sourceKind: "fortigate-endpoint",
        inferred: false,
        observed: { ipAddress: "10.2.2.60" },
        lastSeen: new Date("2026-08-20T00:00:00Z"),
      },
    ]);
    expect(projected.ipAddress).toBe("10.0.0.2");
    expect(provenance.ipAddress).toBe("fortiswitch");
  });
});

describe("projectAssetFromSources — snmp-sysdescr (the device's own word)", () => {
  // The real prod reading, and the real fingerprint it competes with: a
  // FortiGate's device inventory answers the CATEGORY "ip camera" where the
  // camera itself answers its model.
  const DESCR = "; AXIS M2036-LE; Bullet Camera; 10.12.114; Oct 03 2022 14:20; 7EC.1; 1";
  const sysdescr = {
    manufacturer: "Axis Communications",
    model: "M2036-LE",
    osVersion: "10.12.114",
    productType: "Bullet Camera",
    // The whole reading, kept as the record of what the device said. Not
    // offered to any projection rule — see the `os` test below.
    sysDescr: DESCR,
  };

  it("beats a gate's fingerprint on model and firmware", () => {
    const { projected, provenance } = projectAssetFromSources([
      src("fortigate-endpoint", { model: "ip camera", os: "IP Camera", hardwareVendor: "Axis" }),
      src("snmp-sysdescr", sysdescr),
    ]);
    expect(projected.model).toBe("M2036-LE");
    expect(provenance.model).toBe("snmp-sysdescr");
    expect(projected.osVersion).toBe("10.12.114");
    expect(projected.productType).toBe("Bullet Camera");
    expect(provenance.productType).toBe("snmp-sysdescr");
  });

  it("contributes NO `os`, so the raw descr never prints as the OS", () => {
    // The asset page renders OS / Firmware as `[os, osVersion]`, so a raw
    // sysDescr here printed the whole semicolon-delimited string where the
    // version belonged. The reading is kept verbatim on the source row
    // instead; whatever else states an os keeps stating it.
    const withGate = projectAssetFromSources([
      src("fortigate-endpoint", { os: "IP Camera" }),
      src("snmp-sysdescr", sysdescr),
    ]);
    expect(withGate.projected.os).toBe("IP Camera");
    expect(withGate.provenance.os).toBe("fortigate-endpoint");

    const alone = projectAssetFromSources([src("snmp-sysdescr", sysdescr)]);
    expect(alone.projected.os).toBeNull();
    // …while the firmware it parsed out DOES land.
    expect(alone.projected.osVersion).toBe("10.12.114");
  });

  it("wins regardless of the order the rows come back in", () => {
    // The rule list decides, not the query. Both orders, same answer.
    const { projected } = projectAssetFromSources([
      src("snmp-sysdescr", sysdescr),
      src("fortigate-endpoint", { model: "ip camera" }),
    ]);
    expect(projected.model).toBe("M2036-LE");
  });

  it("loses to an agent, Arc and MDM — they read the running system", () => {
    // The deliberate ceiling on this source: it is a parse of a text field,
    // not a look inside the machine.
    const agent = projectAssetFromSources([
      src("polaris-agent", { model: "PowerEdge R740", manufacturer: "Dell Inc." }),
      src("snmp-sysdescr", sysdescr),
    ]);
    expect(agent.projected.model).toBe("PowerEdge R740");
    expect(agent.provenance.model).toBe("polaris-agent");

    const arc = projectAssetFromSources([
      src("arc", { model: "OptiPlex 7090" }),
      src("snmp-sysdescr", sysdescr),
    ]);
    expect(arc.projected.model).toBe("OptiPlex 7090");

    const intune = projectAssetFromSources([
      src("intune", { model: "Surface Laptop 5" }),
      src("snmp-sysdescr", sysdescr),
    ]);
    expect(intune.projected.model).toBe("Surface Laptop 5");
  });

  it("loses to Fortinet infrastructure rows, which state their own model", () => {
    const { projected } = projectAssetFromSources([
      src("fortiap", { model: "FAP-431F" }),
      src("snmp-sysdescr", sysdescr),
    ]);
    expect(projected.model).toBe("FAP-431F");
  });

  it("canonicalizes the vendor it contributes", () => {
    // Mirrors every other manufacturer rule: the projected value has to match
    // what the db.ts extension stamps on the column, or the two differ on
    // every pass and drift fires forever.
    const { projected } = projectAssetFromSources([src("snmp-sysdescr", sysdescr)]);
    expect(projected.manufacturer).toBe("Axis Communications");
  });

  it("contributes nothing from a row with no readable fields", () => {
    // A device whose layout the parser did not recognize never gets a row at
    // all; an empty one must not blank what another source stated.
    const { projected } = projectAssetFromSources([
      src("fortigate-endpoint", { model: "ip camera" }),
      src("snmp-sysdescr", {}),
    ]);
    expect(projected.model).toBe("ip camera");
  });

  it("supplies identity for a device with no other source at all", () => {
    const { projected } = projectAssetFromSources([src("snmp-sysdescr", sysdescr)]);
    expect(projected.model).toBe("M2036-LE");
    expect(projected.osVersion).toBe("10.12.114");
    // And states nothing it cannot know.
    expect(projected.hostname).toBeNull();
    expect(projected.serialNumber).toBeNull();
    expect(projected.ipAddress).toBeNull();
  });
});

describe("projectAssetFromSources — a placeholder serial is not a serial", () => {
  it("falls through to the next source when the agent reports a placeholder", () => {
    // The shape after the pre-0.20.1 Windows collector bug: the agent is the
    // TOP-priority serial source, so without the guard its junk would bury a
    // real serial Intune already had.
    const { projected, provenance } = projectAssetFromSources([
      src("polaris-agent", { serialNumber: "To Be Filled By O.E.M." }),
      src("intune", { serialNumber: "MP2YZAC2" }),
    ]);
    expect(projected.serialNumber).toBe("MP2YZAC2");
    expect(provenance.serialNumber).toBe("intune");
  });

  it("keeps falling through past every placeholder in the ladder", () => {
    const { projected, provenance } = projectAssetFromSources([
      src("polaris-agent", { serialNumber: "Default string" }),
      src("arc", { serialNumber: "0000000000" }),
      src("intune", { serialNumber: "System Serial Number" }),
      src("fortigate-firewall", { serial: "FGT60FTK21000123" }),
    ]);
    expect(projected.serialNumber).toBe("FGT60FTK21000123");
    expect(provenance.serialNumber).toBe("fortigate-firewall");
  });

  it("projects null when every source reports a placeholder", () => {
    // Null is the honest answer and it is what lets the agents.ts write-back
    // clear a junk value that an earlier agent stored.
    const { projected, provenance } = projectAssetFromSources([
      src("polaris-agent", { serialNumber: "None" }),
      src("intune", { serialNumber: "XXXXXXXX" }),
    ]);
    expect(projected.serialNumber).toBeNull();
    expect(provenance.serialNumber).toBeUndefined();
  });

  it("still lets a real agent serial outrank Arc and Intune", () => {
    const { projected, provenance } = projectAssetFromSources([
      src("polaris-agent", { serialNumber: "MP2YZAC2" }),
      src("arc", { serialNumber: "SMBIOS-999" }),
      src("intune", { serialNumber: "OLD-ENROLL-123" }),
    ]);
    expect(projected.serialNumber).toBe("MP2YZAC2");
    expect(provenance.serialNumber).toBe("polaris-agent");
  });

  it("trims a serial that is real but padded", () => {
    const { projected } = projectAssetFromSources([
      src("polaris-agent", { serialNumber: "  MP2YZAC2  " }),
    ]);
    expect(projected.serialNumber).toBe("MP2YZAC2");
  });
});
