import { describe, it, expect } from "vitest";
import {
  genericApiObserved,
  genericApiSweepBlockedReason,
  resolveGenericAssetType,
} from "../../src/services/discovery/genericApiSync.js";
import { projectAssetFromSources } from "../../src/utils/assetProjection.js";
import { DEFAULT_LOCATION_ORDER } from "../../src/utils/assetSourceLocation.js";
import {
  genericApiExternalId,
  genericApiIdentityFromExternalId,
} from "../../src/utils/genericApiSource.js";
import { deriveAssetSources } from "../../src/utils/assetSourceDerivation.js";
import { assetMatchesIntegrationFilter } from "../../src/utils/integrationFilter.js";
import type { GenericApiMappedRecord } from "../../src/services/genericApiService.js";

const record: GenericApiMappedRecord = {
  identity: "42",
  hostname: "cam-lobby",
  ipAddress: "10.1.2.3",
  macs: ["AC:CC:8E:12:34:56"],
  serialNumber: "ACCC8E123456",
  manufacturer: "Axis Communications AB",
  model: "P3245-V",
  os: "AXIS OS",
  osVersion: "11.8",
  rawAssetType: "Network Camera",
  assetType: "camera",
  location: "HQ / Lobby",
};
const observed = genericApiObserved(record, "id", new Date("2026-10-09T00:00:00Z"));

describe("externalId vocabulary", () => {
  it("scopes the identity to the integration, and only reads back its own", () => {
    expect(genericApiExternalId("int-a", "42")).toBe("int-a:42");
    expect(genericApiIdentityFromExternalId("int-a", "int-a:42")).toBe("42");
    expect(genericApiIdentityFromExternalId("int-a", "int-b:42")).toBeNull();
    // An identity that itself contains a colon survives the round trip.
    expect(genericApiIdentityFromExternalId("int-a", genericApiExternalId("int-a", "AA:BB"))).toBe("AA:BB");
  });
});

describe("resolveGenericAssetType", () => {
  const known = new Set(["server", "switch", "printer", "other"]);
  it("takes the mapped type when the registry knows it, else the default, else other", () => {
    expect(resolveGenericAssetType("switch", "server", known)).toBe("switch");
    expect(resolveGenericAssetType("camera", "printer", known)).toBe("printer");
    expect(resolveGenericAssetType("camera", "Server ", known)).toBe("server");
    expect(resolveGenericAssetType("camera", "camera", known)).toBe("other");
    expect(resolveGenericAssetType(null, undefined, known)).toBe("other");
  });
});

describe("genericApiSweepBlockedReason (rule 70's guards)", () => {
  const whole = { complete: true, presentIdentities: ["1", "2"], unmapped: 0 };
  it("is off unless the operator opted in", () => {
    expect(genericApiSweepBlockedReason(whole, 2, false)).toMatch(/switched off/);
    expect(genericApiSweepBlockedReason(whole, 2, true)).toBeNull();
  });
  it("refuses an incomplete read", () => {
    expect(genericApiSweepBlockedReason({ ...whole, complete: false }, 2, true)).toMatch(/not read to the end/);
  });
  it("refuses an empty read against an integration that holds records, naming a mapping problem when there was one", () => {
    expect(genericApiSweepBlockedReason({ complete: true, presentIdentities: [], unmapped: 0 }, 5, true)).toMatch(/no records at all/);
    expect(genericApiSweepBlockedReason({ complete: true, presentIdentities: [], unmapped: 9 }, 5, true)).toMatch(/check the field mapping/);
    // A brand-new integration with an empty feed has nothing to sweep anyway.
    expect(genericApiSweepBlockedReason({ complete: true, presentIdentities: [], unmapped: 0 }, 0, true)).toBeNull();
  });
});

describe("projection — where a generic feed ranks", () => {
  it("speaks for every field on an asset nothing else holds", () => {
    const { projected } = projectAssetFromSources([{ sourceKind: "generic-api", inferred: false, observed }]);
    expect(projected).toMatchObject({
      hostname: "cam-lobby",
      ipAddress: "10.1.2.3",
      serialNumber: "ACCC8E123456",
      model: "P3245-V",
      os: "AXIS OS",
      osVersion: "11.8",
      learnedLocation: "HQ / Lobby",
    });
    expect(projected.manufacturer).toBeTruthy();
  });

  it("never overrides a first-party source", () => {
    const { projected } = projectAssetFromSources([
      { sourceKind: "generic-api", inferred: false, observed },
      { sourceKind: "ad", inferred: false, observed: { cn: "CAM-LOBBY-AD", dnsHostName: "cam-lobby-ad.corp.local", operatingSystem: "Windows 11 Pro" } },
    ]);
    expect(projected.hostname).not.toBe("cam-lobby");
    expect(projected.os).toBe("Windows 11 Pro");
  });

  it("outranks a DHCP client id for the name, but not the live DHCP binding for the IP", () => {
    const { projected } = projectAssetFromSources([
      { sourceKind: "generic-api", inferred: false, observed },
      { sourceKind: "fortigate-endpoint", inferred: false, observed: { hostname: "dhcp-random-1234", ipAddress: "10.9.9.9" } },
    ]);
    expect(projected.hostname).toBe("cam-lobby");
    expect(projected.ipAddress).toBe("10.9.9.9");
  });

  it("refuses a placeholder serial in the blob (rule 84) even if one got there", () => {
    const { projected } = projectAssetFromSources([
      { sourceKind: "generic-api", inferred: false, observed: { ...observed, serial: "Default string" } },
    ]);
    expect(projected.serialNumber).toBeNull();
  });

  it("is a location contributor, right after the sighting FortiGate", () => {
    expect(DEFAULT_LOCATION_ORDER.slice(0, 2)).toEqual(["fortigate-endpoint", "generic-api"]);
  });
});

describe("shadow-write and post-hoc filter", () => {
  it("a genericapi-tagged asset mints no manual source row", () => {
    expect(deriveAssetSources({ tags: ["genericapi", "auto-discovered"] } as any)).toEqual([]);
  });

  it("deviceInclude / deviceExclude apply to the hostname, as at discovery", () => {
    const intg = { type: "genericapi", config: { deviceExclude: ["lab-*"] } };
    expect(assetMatchesIntegrationFilter({ hostname: "lab-cam", learnedLocation: null }, intg).included).toBe(false);
    expect(assetMatchesIntegrationFilter({ hostname: "cam-1", learnedLocation: null }, intg).included).toBe(true);
  });
});
