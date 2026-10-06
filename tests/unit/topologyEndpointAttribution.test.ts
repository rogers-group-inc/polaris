/**
 * tests/unit/topologyEndpointAttribution.test.ts — which of a site's switches
 * a Device Map endpoint sits on (business rule 91). The hostname prefix in
 * `lastSeenSwitch` used to be the attribution; on a FortiLink fleet whose
 * switch-ids repeat per site that put every site's "IDF-1" endpoints under
 * every site's IDF-1. The `switch-port` dependency edge is the attribution
 * now, and the prefix is trusted only for a fleet-unique name.
 */

import { describe, it, expect, vi } from "vitest";

vi.mock("../../src/db.js", () => ({ prisma: {} }));

import { attributeEndpointToSiteSwitch, portOfLastSeenSwitch } from "../../src/services/topologyGraphService.js";

const attribution = {
  siteSwitchIds: ["swA", "swCore"],
  // CORE-1 is unique fleet-wide; IDF-1 is not, so it is absent here.
  switchIdByUniqueHost: new Map([["core-1", "swCore"]]),
};

describe("attributeEndpointToSiteSwitch", () => {
  it("takes the switch-port edge to a site switch over the name", () => {
    expect(attributeEndpointToSiteSwitch(
      { lastSeenSwitch: "IDF-1/port7", dependencyParents: [{ parentAssetId: "swA" }] },
      attribution,
    )).toBe("swA");
  });

  it("ignores an edge to a switch outside the site", () => {
    // Another site's IDF-1 won: this endpoint is not here.
    expect(attributeEndpointToSiteSwitch(
      { lastSeenSwitch: "IDF-1/port7", dependencyParents: [{ parentAssetId: "swB-elsewhere" }] },
      attribution,
    )).toBeNull();
  });

  it("falls back to the hostname prefix only for a fleet-unique name, case-insensitively", () => {
    expect(attributeEndpointToSiteSwitch({ lastSeenSwitch: "core-1/port3" }, attribution)).toBe("swCore");
    expect(attributeEndpointToSiteSwitch({ lastSeenSwitch: "CORE-1/port3", dependencyParents: [] }, attribution)).toBe("swCore");
  });

  it("leaves a shared name with no edge OFF the map rather than on the first IDF-1", () => {
    expect(attributeEndpointToSiteSwitch({ lastSeenSwitch: "IDF-1/port7" }, attribution)).toBeNull();
    expect(attributeEndpointToSiteSwitch({ lastSeenSwitch: "IDF-1/port7", dependencyParents: [] }, attribution)).toBeNull();
  });

  it("returns null for a value with no device half", () => {
    expect(attributeEndpointToSiteSwitch({ lastSeenSwitch: null }, attribution)).toBeNull();
    expect(attributeEndpointToSiteSwitch({ lastSeenSwitch: "/port1" }, attribution)).toBeNull();
    expect(attributeEndpointToSiteSwitch({ lastSeenSwitch: "CORE-1" }, attribution)).toBeNull();
  });
});

describe("portOfLastSeenSwitch", () => {
  it("returns the port half, keeping a slash inside the port", () => {
    expect(portOfLastSeenSwitch("IDF-1/port7")).toBe("port7");
    expect(portOfLastSeenSwitch("SW-1/port1/1")).toBe("port1/1");
  });
  it("returns the empty string when there is no port", () => {
    expect(portOfLastSeenSwitch("IDF-1")).toBe("");
    expect(portOfLastSeenSwitch(null)).toBe("");
    expect(portOfLastSeenSwitch("/port1")).toBe("");
  });
});
