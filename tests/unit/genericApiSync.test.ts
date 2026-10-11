import { describe, it, expect } from "vitest";
import {
  genericApiFeedFieldUpdates,
  genericApiObserved,
  genericApiSweepBlockedReason,
  mergeGenericFeedTags,
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
  assetTag: null,
  department: null,
  assignedTo: null,
  description: null,
  tags: [],
  acquiredAt: null,
  warrantyExpiry: null,
  purchaseOrder: null,
  latitude: null,
  longitude: null,
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

describe("genericApiFeedFieldUpdates — the feed changes only what it wrote", () => {
  const ctx = { integrationId: "g1", assetIdByTag: new Map<string, string>() };

  it("fills a blank column", () => {
    const { data } = genericApiFeedFieldUpdates({ id: "a1" }, null, { department: "Ops", warrantyExpiry: "2027-03-01T00:00:00.000Z" }, ctx);
    expect(data.department).toBe("Ops");
    expect(data.warrantyExpiry).toEqual(new Date("2027-03-01T00:00:00.000Z"));
  });

  it("changes a value that is still the one it wrote last run", () => {
    const { data } = genericApiFeedFieldUpdates({ id: "a1", department: "Ops" }, { department: "Ops" }, { department: "NOC" }, ctx);
    expect(data.department).toBe("NOC");
  });

  it("never overwrites a value an operator or another source wrote", () => {
    // The asset says "Facilities", the feed last wrote "Ops": someone changed it.
    const { data } = genericApiFeedFieldUpdates({ id: "a1", department: "Facilities" }, { department: "Ops" }, { department: "NOC" }, ctx);
    expect(data).toEqual({});
    // First sight with a value already there: not the feed's to replace.
    expect(genericApiFeedFieldUpdates({ id: "a1", assignedTo: "x@example.com" }, null, { assignedTo: "y@example.com" }, ctx).data).toEqual({});
  });

  it("never clears a column", () => {
    expect(genericApiFeedFieldUpdates({ id: "a1", department: "Ops" }, { department: "Ops" }, { department: null }, ctx).data).toEqual({});
  });

  it("compares dates as instants, so a stored Date equal to the feed's string is no change", () => {
    const asset = { id: "a1", acquiredAt: new Date("2024-02-03T00:00:00.000Z") };
    expect(genericApiFeedFieldUpdates(asset, null, { acquiredAt: "2024-02-03T00:00:00.000Z" }, ctx).data).toEqual({});
  });

  it("does not write a description on a device another integration owns (description sync could push it)", () => {
    expect(genericApiFeedFieldUpdates({ id: "a1", discoveredByIntegrationId: "fmg" }, null, { description: "Lobby" }, ctx).data).toEqual({});
    expect(genericApiFeedFieldUpdates({ id: "a1", discoveredByIntegrationId: "g1" }, null, { description: "Lobby" }, ctx).data).toEqual({ description: "Lobby" });
  });

  it("holds back an asset tag another asset already carries, and says so", () => {
    const tags = { integrationId: "g1", assetIdByTag: new Map([["ACME-1", "other-asset"], ["ACME-2", "a1"]]) };
    const held = genericApiFeedFieldUpdates({ id: "a1" }, null, { assetTag: "ACME-1" }, tags);
    expect(held.data).toEqual({});
    expect(held.held[0]).toMatch(/ACME-1.*another asset/);
    expect(genericApiFeedFieldUpdates({ id: "a1", assetTag: null }, null, { assetTag: "ACME-2" }, tags).data).toEqual({ assetTag: "ACME-2" });
  });
});

describe("mergeGenericFeedTags", () => {
  it("adds the feed's tags, drops the ones it stopped listing, and keeps everyone else's", () => {
    expect(mergeGenericFeedTags(["critical", "east", "old"], ["east", "old"], ["east", "lobby"])).toEqual(["critical", "east", "lobby"]);
    expect(mergeGenericFeedTags([], [], ["a", "a"])).toEqual(["a"]);
  });
});

describe("the observed blob and the projection — coordinates", () => {
  it("projects the feed's pair when nothing better has one", () => {
    const observed = genericApiObserved({ ...record, latitude: 36.16, longitude: -86.78 }, "id", new Date("2026-10-11T00:00:00Z"));
    const { projected } = projectAssetFromSources([{ sourceKind: "generic-api", inferred: false, observed }]);
    expect([projected.latitude, projected.longitude]).toEqual([36.16, -86.78]);
  });

  it("ranks below a FortiGate's coordinates", () => {
    const observed = genericApiObserved({ ...record, latitude: 36.16, longitude: -86.78 }, "id", new Date());
    const { projected } = projectAssetFromSources([
      { sourceKind: "generic-api", inferred: false, observed },
      { sourceKind: "fortigate-firewall", inferred: false, observed: { latitude: 40.1, longitude: -75.2 } },
    ]);
    expect([projected.latitude, projected.longitude]).toEqual([40.1, -75.2]);
  });
});
