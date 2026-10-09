import { describe, it, expect } from "vitest";
import {
  LOCATION_CONTRIBUTORS,
  DEFAULT_LOCATION_ORDER,
  defaultSourceLocationPriority,
  locationContributor,
  normalizeSourceLocationPriority,
  contributedLocation,
  bareFortinetDeviceName,
} from "../../src/utils/assetSourceLocation.js";

describe("assetSourceLocation — catalogue", () => {
  it("has no duplicate kinds", () => {
    const kinds = LOCATION_CONTRIBUTORS.map((c) => c.kind);
    expect(new Set(kinds).size).toBe(kinds.length);
  });

  it("gives every field contributor at least one observed key", () => {
    for (const c of LOCATION_CONTRIBUTORS) {
      if (c.mode !== "field") continue;
      expect(c.observedKeys, `${c.kind} declares no observed keys`).toBeTruthy();
      expect(c.observedKeys!.length).toBeGreaterThan(0);
    }
  });

  it("defaults to the catalogue order with the prefix off", () => {
    expect(defaultSourceLocationPriority()).toEqual({
      order: DEFAULT_LOCATION_ORDER,
      integrationPrefix: false,
    });
  });

  it("pins the default order — closest-to-a-place first", () => {
    // Deliberate, and load-bearing for every install that never opens the
    // Sources card. See the catalogue's header comment for the reasoning.
    expect(DEFAULT_LOCATION_ORDER).toEqual([
      "fortigate-endpoint",
      // A Generic API record's MAPPED location — a field someone wrote down
      // as a place; contributes nothing when no location is mapped.
      "generic-api",
      "arc",
      "intune",
      "entra",
      "arc-k8s",
      "vcenter-vm",
      "vcenter-host",
      // Unraid / TrueNAS workloads: placed on their host, vCenter's tier.
      "unraid-vm",
      "unraid-container",
      "truenas-vm",
      "truenas-app",
      "ad",
      "fortiswitch",
      "fortiap",
    ]);
    // The two that carry the most weight, stated as properties rather than
    // positions: the sighting gate is the only contributor naming a physical
    // place, and an OU path is org structure that must not beat it.
    expect(DEFAULT_LOCATION_ORDER[0]).toBe("fortigate-endpoint");
    expect(DEFAULT_LOCATION_ORDER.indexOf("ad"))
      .toBeGreaterThan(DEFAULT_LOCATION_ORDER.indexOf("fortigate-endpoint"));
  });

  it("resolves a contributor by kind, and nothing for unknown kinds", () => {
    expect(locationContributor("arc")?.label).toBe("Azure Arc");
    expect(locationContributor("polaris-agent")).toBeUndefined();
    expect(locationContributor("manual")).toBeUndefined();
    expect(locationContributor("fortigate-firewall")).toBeUndefined();
  });
});

describe("assetSourceLocation — normalizeSourceLocationPriority", () => {
  it("returns the default order for junk input", () => {
    for (const raw of [undefined, null, 42, "nope", [], {}]) {
      expect(normalizeSourceLocationPriority(raw).order).toEqual(DEFAULT_LOCATION_ORDER);
    }
  });

  it("honors a partial order and appends the rest in default order", () => {
    const { order } = normalizeSourceLocationPriority({ order: ["fortigate-endpoint", "arc"] });
    expect(order.slice(0, 2)).toEqual(["fortigate-endpoint", "arc"]);
    expect(new Set(order)).toEqual(new Set(DEFAULT_LOCATION_ORDER));
    expect(order.length).toBe(DEFAULT_LOCATION_ORDER.length);
  });

  it("drops unknown kinds and collapses duplicates to the first mention", () => {
    const { order } = normalizeSourceLocationPriority({
      order: ["arc", "not-a-source", "arc", "ad"],
    });
    expect(order.slice(0, 2)).toEqual(["arc", "ad"]);
    expect(order).not.toContain("not-a-source");
    expect(order.filter((k) => k === "arc").length).toBe(1);
  });

  it("treats integrationPrefix as strictly boolean-true opt-in", () => {
    expect(normalizeSourceLocationPriority({ integrationPrefix: true }).integrationPrefix).toBe(true);
    for (const v of ["true", 1, {}, undefined, null, false]) {
      expect(normalizeSourceLocationPriority({ integrationPrefix: v }).integrationPrefix).toBe(false);
    }
  });
});

describe("assetSourceLocation — contributedLocation", () => {
  it("returns the label for label-mode sources regardless of the blob", () => {
    // The whole point of the Arc change: the resource group ("updatemanager")
    // is a billing container, not a place.
    expect(contributedLocation("arc", { resourceGroup: "updatemanager" })).toBe("Azure Arc");
    expect(contributedLocation("arc", null)).toBe("Azure Arc");
    expect(contributedLocation("arc-k8s", {})).toBe("Azure Arc (Kubernetes)");
    expect(contributedLocation("intune", {})).toBe("Microsoft Intune");
    expect(contributedLocation("entra", {})).toBe("Microsoft Entra ID");
  });

  it("reads the observed field for field-mode sources", () => {
    expect(contributedLocation("ad", { ouPath: "OU=Laptops,DC=corp" })).toBe("OU=Laptops,DC=corp");
    expect(contributedLocation("fortiswitch", { controllerFortigate: "FW-NASH" })).toBe("FW-NASH");
    expect(contributedLocation("fortigate-endpoint", { learnedLocation: "FW-NASH" })).toBe("FW-NASH");
  });

  it("falls through observed keys in order and trims", () => {
    expect(contributedLocation("vcenter-vm", { clusterName: "  Prod-Cluster  ", hostName: "esx1" }))
      .toBe("Prod-Cluster");
    expect(contributedLocation("vcenter-vm", { clusterName: "   ", hostName: "esx1" })).toBe("esx1");
    expect(contributedLocation("vcenter-vm", { clusterName: null, hostName: null })).toBeNull();
  });

  it("returns null for unknown / non-contributing kinds", () => {
    expect(contributedLocation("polaris-agent", { hostname: "web01" })).toBeNull();
    expect(contributedLocation("manual", {})).toBeNull();
    expect(contributedLocation("fortigate-firewall", { hostname: "FW-NASH" })).toBeNull();
  });

  it("prefixes Fortinet device names with the integration when opted in", () => {
    const observed = { learnedLocation: "FW-NASH", integrationName: "FMG-Prod" };
    expect(contributedLocation("fortigate-endpoint", observed)).toBe("FW-NASH");
    expect(contributedLocation("fortigate-endpoint", observed, { integrationPrefix: true }))
      .toBe("FMG-Prod:FW-NASH");
    expect(contributedLocation("fortiap", { controllerFortigate: "FW-NASH", integrationName: "FMG-Prod" }, { integrationPrefix: true }))
      .toBe("FMG-Prod:FW-NASH");
  });

  it("falls back to the bare name when the row predates the integrationName stamp", () => {
    // Rows written before this feature carry no integrationName — they must not
    // render a dangling ":FW-NASH".
    expect(contributedLocation("fortigate-endpoint", { learnedLocation: "FW-NASH" }, { integrationPrefix: true }))
      .toBe("FW-NASH");
    expect(contributedLocation("fortigate-endpoint", { learnedLocation: "FW-NASH", integrationName: "  " }, { integrationPrefix: true }))
      .toBe("FW-NASH");
  });

  it("never prefixes a non-Fortinet contributor", () => {
    expect(contributedLocation("ad", { ouPath: "OU=Laptops", integrationName: "CORP-AD" }, { integrationPrefix: true }))
      .toBe("OU=Laptops");
  });

  it("is idempotent under repeated prefixing — the prod runaway-prefix bug", () => {
    // The fortigate-endpoint blob is stamped FROM Asset.learnedLocation, which
    // is this function's own OUTPUT. Feeding a prefixed value back in must
    // produce the SAME string, not a longer one, or every discovery cycle adds
    // a segment (prod hit 32 of them before it was noticed).
    const observed = { learnedLocation: "FMG-Prod:FW-NASH", integrationName: "FMG-Prod" };
    const once = contributedLocation("fortigate-endpoint", observed, { integrationPrefix: true });
    expect(once).toBe("FMG-Prod:FW-NASH");
    expect(contributedLocation("fortigate-endpoint", { ...observed, learnedLocation: once! }, { integrationPrefix: true }))
      .toBe("FMG-Prod:FW-NASH");
  });

  it("heals an already-polluted blob, prefix on or off", () => {
    const polluted = "FMG-Prod:".repeat(32) + "FW-NASH";
    expect(contributedLocation("fortigate-endpoint", { learnedLocation: polluted, integrationName: "FMG-Prod" }, { integrationPrefix: true }))
      .toBe("FMG-Prod:FW-NASH");
    // Prefix off must not render the accumulated segments verbatim either —
    // turning the toggle back off is an operator's first instinct.
    expect(contributedLocation("fortigate-endpoint", { learnedLocation: polluted, integrationName: "FMG-Prod" }))
      .toBe("FW-NASH");
    // Renaming the integration mid-pollution still bares the device name,
    // because the strip keys on the colon, not on the stored name.
    expect(contributedLocation("fortiap", { controllerFortigate: polluted, integrationName: "FMG-New" }, { integrationPrefix: true }))
      .toBe("FMG-New:FW-NASH");
  });

  it("leaves colon-bearing non-Fortinet values alone", () => {
    // The strip is scoped to fortinetDevice contributors — a vSphere cluster or
    // an OU path is free to contain a colon.
    expect(contributedLocation("vcenter-vm", { clusterName: "DC:Prod-Cluster" })).toBe("DC:Prod-Cluster");
  });
});

describe("assetSourceLocation — bareFortinetDeviceName", () => {
  it("returns the last segment, or the value when there's no colon", () => {
    expect(bareFortinetDeviceName("FW-NASH")).toBe("FW-NASH");
    expect(bareFortinetDeviceName("FMG-Prod:FW-NASH")).toBe("FW-NASH");
    expect(bareFortinetDeviceName("A:B:C:FW-NASH")).toBe("FW-NASH");
  });

  it("falls back to the whole value rather than emptying it", () => {
    // A trailing colon is malformed input, not a reason to lose the name.
    expect(bareFortinetDeviceName("FMG-Prod:")).toBe("FMG-Prod:");
  });
});
