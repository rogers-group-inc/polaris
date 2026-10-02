/**
 * tests/unit/azureArcService.test.ts
 *
 * Pure-helper coverage for the Azure Arc discovery service — no network, no
 * DB, no mocks. Mirrors tests/unit/vcenterService.test.ts: the service
 * deliberately exports its id-normalization, parsing, inference and filter
 * helpers so the interesting logic is testable without a tenant.
 *
 * The load-bearing cases (the ones that fail silently in production if they
 * regress) are called out inline:
 *   • all-zero vmUuid → null            — otherwise a whole fleet mass-merges
 *   • swapVmUuidEndianness involution   — otherwise Arc-on-VMware duplicates
 *   • ARG row ≡ RP list row             — otherwise the two read paths diverge
 *   • non-GUID subscription ids dropped — the only KQL injection surface
 */

import { describe, it, expect } from "vitest";
import {
  normalizeSubscriptionId,
  buildArcMachinesQuery,
  normalizeVmUuid,
  swapVmUuidEndianness,
  parseArmResourceId,
  normalizeArcMachine,
  extractIpAddresses,
  inferArcAssetType,
  arcStatusIsConnected,
  matchesTagFilter,
  filterArcMachines,
  arcHostnameCandidates,
  buildArcObservedBlob,
  describeAadTokenError,
  extractArmError,
  throttleDelayMs,
  parentMachineIdFromExtensionId,
  buildArcVmInstancesQuery,
  buildArcSqlInstancesQuery,
  normalizeArcVmInstance,
  normalizeArcSqlInstance,
  buildArcClustersQuery,
  normalizeArcCluster,
  buildArcClusterObservedBlob,
  azureTagsToAssetTags,
} from "../../src/services/azureArcService.js";

// ─── Fixtures ───────────────────────────────────────────────────────────────
// Synthetic all-zero-style GUIDs only — never a real tenant/subscription id.

const SUB = "11111111-1111-1111-1111-111111111111";
const ARM_ID = `/subscriptions/${SUB}/resourceGroups/rg-prod/providers/Microsoft.HybridCompute/machines/WEB01`;

/** A resource-provider list row, as `GET .../machines` returns it. */
const RP_ROW = {
  id: ARM_ID,
  name: "WEB01",
  type: "Microsoft.HybridCompute/machines",
  location: "eastus",
  tags: { env: "prod", owner: "infra" },
  properties: {
    status: "Connected",
    lastStatusChange: "2026-08-01T10:00:00Z",
    agentVersion: "1.45.02993",
    // Deliberately asymmetric: a fixture like 22222222-3333-4444-… is a
    // palindrome under the endian swap, which would make the swap assertions
    // below pass vacuously.
    vmUuid: "aabbccdd-1122-3344-5566-778899aabbcc",
    displayName: "WEB01",
    adFqdn: "web01.corp.local",
    dnsFqdn: "web01.corp.local",
    domainName: "corp.local",
    osType: "windows",
    osName: "Windows",
    osSku: "Windows Server 2022 Datacenter",
    osVersion: "10.0.20348",
    detectedProperties: {
      manufacturer: "VMware, Inc.",
      model: "VMware7,1",
      serialNumber: "VMware-56 4d aa bb",
      logicalCoreCount: "8",
      totalPhysicalMemoryInGigabytes: "32",
      cloudprovider: "VMware",
    },
  },
};

/**
 * The SAME machine as a Resource Graph row: lowercased type, subscriptionId
 * and resourceGroup as projected columns rather than derived from the id.
 */
const ARG_ROW = {
  id: ARM_ID.toLowerCase(),
  name: "WEB01",
  type: "microsoft.hybridcompute/machines",
  location: "eastus",
  tags: { env: "prod", owner: "infra" },
  properties: RP_ROW.properties,
  subscriptionId: SUB,
  resourceGroup: "rg-prod",
};

function machine(over: Partial<ReturnType<typeof norm>> = {}) {
  return { ...norm(RP_ROW), ...over };
}
function norm(row: any) {
  const m = normalizeArcMachine(row);
  if (!m) throw new Error("fixture failed to normalize");
  return m;
}

// ─── normalizeSubscriptionId ────────────────────────────────────────────────

describe("normalizeSubscriptionId", () => {
  it("accepts a bare GUID and lowercases it", () => {
    expect(normalizeSubscriptionId(SUB.toUpperCase())).toBe(SUB);
  });

  it("tolerates a pasted /subscriptions/<guid> prefix", () => {
    expect(normalizeSubscriptionId(`/subscriptions/${SUB}`)).toBe(SUB);
    expect(normalizeSubscriptionId(`subscriptions/${SUB}/resourceGroups/rg`)).toBe(SUB);
  });

  it("trims surrounding whitespace", () => {
    expect(normalizeSubscriptionId(`  ${SUB}  `)).toBe(SUB);
  });

  it("rejects anything that is not a GUID", () => {
    expect(normalizeSubscriptionId("not-a-guid")).toBeNull();
    expect(normalizeSubscriptionId("")).toBeNull();
    expect(normalizeSubscriptionId(null)).toBeNull();
    expect(normalizeSubscriptionId(12345)).toBeNull();
    // The injection shape: a quote-escape attempt is not a GUID.
    expect(normalizeSubscriptionId("' or true or '")).toBeNull();
  });
});

// ─── buildArcMachinesQuery ──────────────────────────────────────────────────

describe("buildArcMachinesQuery", () => {
  it("filters to the Arc machine type and projects the columns the sync reads", () => {
    const q = buildArcMachinesQuery();
    expect(q).toContain("microsoft.hybridcompute/machines");
    expect(q).toContain("project id, name, type, location, tags, properties, subscriptionId, resourceGroup");
    expect(q).not.toContain("subscriptionId in~");
  });

  it("scopes to the given subscriptions", () => {
    const q = buildArcMachinesQuery({ subscriptionIds: [SUB] });
    expect(q).toContain(`subscriptionId in~ ('${SUB}')`);
  });

  it("drops non-GUID subscription ids rather than interpolating them", () => {
    // This is the entire KQL injection surface — everything else is filtered
    // client-side, so a value that isn't a bare GUID must never reach the query.
    const q = buildArcMachinesQuery({
      subscriptionIds: ["' | project 1 | where '", SUB, "drop table"],
    });
    expect(q).toContain(`subscriptionId in~ ('${SUB}')`);
    expect(q).not.toContain("drop table");
    expect(q).not.toContain("project 1");
  });

  it("omits the subscription clause entirely when nothing validates", () => {
    const q = buildArcMachinesQuery({ subscriptionIds: ["nope"] });
    expect(q).not.toContain("subscriptionId in~");
  });
});

// ─── normalizeVmUuid / swapVmUuidEndianness ─────────────────────────────────

describe("normalizeVmUuid", () => {
  it("lowercases and strips braces", () => {
    expect(normalizeVmUuid("{AABBCCDD-1122-3344-5566-778899AABBCC}"))
      .toBe("aabbccdd-1122-3344-5566-778899aabbcc");
  });

  it("rejects the all-zero GUID", () => {
    // Load-bearing: some BIOSes report all-zero. If these collapsed onto one
    // map key every such machine would merge into a single asset.
    expect(normalizeVmUuid("00000000-0000-0000-0000-000000000000")).toBeNull();
  });

  it("rejects the all-F GUID some hypervisors emit", () => {
    expect(normalizeVmUuid("ffffffff-ffff-ffff-ffff-ffffffffffff")).toBeNull();
  });

  it("rejects malformed or non-string input", () => {
    expect(normalizeVmUuid("not a uuid")).toBeNull();
    expect(normalizeVmUuid("")).toBeNull();
    expect(normalizeVmUuid(null)).toBeNull();
    expect(normalizeVmUuid(42)).toBeNull();
  });
});

describe("swapVmUuidEndianness", () => {
  const uuid = "aabbccdd-1122-3344-5566-778899aabbcc";

  it("byte-swaps the first three fields only", () => {
    expect(swapVmUuidEndianness(uuid)).toBe("ddccbbaa-2211-4433-5566-778899aabbcc");
  });

  it("is involutive — swapping twice returns the original", () => {
    // The whole point: the same physical machine can present either form
    // depending on who read SMBIOS, so both must round-trip.
    expect(swapVmUuidEndianness(swapVmUuidEndianness(uuid))).toBe(uuid);
  });

  it("returns null for null or malformed input", () => {
    expect(swapVmUuidEndianness(null)).toBeNull();
    expect(swapVmUuidEndianness("nope")).toBeNull();
  });
});

// ─── parseArmResourceId ─────────────────────────────────────────────────────

describe("parseArmResourceId", () => {
  it("parses a machine resource id", () => {
    expect(parseArmResourceId(ARM_ID)).toEqual({
      subscriptionId: SUB,
      resourceGroup: "rg-prod",
      provider: "Microsoft.HybridCompute",
      type: "machines",
      name: "WEB01",
    });
  });

  it("reports the child provider for an extension resource (the Phase-2 shape)", () => {
    const child = `${ARM_ID}/providers/Microsoft.ConnectedVMwarevSphere/virtualMachineInstances/default`;
    const parsed = parseArmResourceId(child);
    expect(parsed?.provider).toBe("Microsoft.ConnectedVMwarevSphere");
    expect(parsed?.type).toBe("virtualMachineInstances");
    expect(parsed?.name).toBe("default");
    // The subscription and resource group still resolve from the parent path.
    expect(parsed?.subscriptionId).toBe(SUB);
    expect(parsed?.resourceGroup).toBe("rg-prod");
  });

  it("returns null for malformed ids", () => {
    expect(parseArmResourceId("/subscriptions/only")).toBeNull();
    expect(parseArmResourceId("")).toBeNull();
    expect(parseArmResourceId(null)).toBeNull();
  });
});

// ─── normalizeArcMachine ────────────────────────────────────────────────────

describe("normalizeArcMachine", () => {
  it("maps a resource-provider list row onto the typed record", () => {
    const m = norm(RP_ROW);
    expect(m.armId).toBe(ARM_ID.toLowerCase());
    expect(m.name).toBe("WEB01");
    expect(m.subscriptionId).toBe(SUB);
    expect(m.resourceGroup).toBe("rg-prod");
    expect(m.azureRegion).toBe("eastus");
    expect(m.displayName).toBe("WEB01");
    expect(m.osSku).toBe("Windows Server 2022 Datacenter");
    expect(m.status).toBe("Connected");
    expect(m.manufacturer).toBe("VMware, Inc.");
    expect(m.serialNumber).toBe("VMware-56 4d aa bb");
    expect(m.processorCount).toBe(8);
    expect(m.totalPhysicalMemoryBytes).toBe(32 * 1024 ** 3);
    expect(m.cloudProvider).toBe("VMware");
    expect(m.tags).toEqual({ env: "prod", owner: "infra" });
  });

  it("normalizes an ARG row identically to the RP list row", () => {
    // The regression guard for the dual read path: if these diverge, the
    // Resource Graph and per-subscription fallback would produce different
    // assets for the same machine.
    expect(normalizeArcMachine(ARG_ROW)).toEqual(normalizeArcMachine(RP_ROW));
  });

  it("derives subscription and resource group from the id when ARG columns are absent", () => {
    const m = norm({ ...RP_ROW, subscriptionId: undefined, resourceGroup: undefined });
    expect(m.subscriptionId).toBe(SUB);
    expect(m.resourceGroup).toBe("rg-prod");
  });

  it("indexes both vmUuid endian variants", () => {
    const m = norm(RP_ROW);
    expect(m.vmUuid).toBe("aabbccdd-1122-3344-5566-778899aabbcc");
    expect(m.vmUuidSwapped).toBe("ddccbbaa-2211-4433-5566-778899aabbcc");
    expect(m.vmUuidSwapped).not.toBe(m.vmUuid);
  });

  it("survives a missing detectedProperties bag", () => {
    // Its keys vary by Connected Machine agent version, so every read is
    // defensive — an older agent must not throw.
    const m = norm({ ...RP_ROW, properties: { ...RP_ROW.properties, detectedProperties: undefined } });
    expect(m.manufacturer).toBeNull();
    expect(m.model).toBeNull();
    expect(m.serialNumber).toBeNull();
    expect(m.processorCount).toBeNull();
    expect(m.totalPhysicalMemoryBytes).toBeNull();
  });

  it("tolerates lowercased detectedProperties keys", () => {
    const m = norm({
      ...RP_ROW,
      properties: { ...RP_ROW.properties, detectedProperties: { serialnumber: "ABC123" } },
    });
    expect(m.serialNumber).toBe("ABC123");
  });

  it("survives a missing properties object entirely", () => {
    const m = norm({ id: ARM_ID, name: "WEB01" });
    expect(m.armId).toBe(ARM_ID.toLowerCase());
    expect(m.status).toBeNull();
    expect(m.displayName).toBe("WEB01");
  });

  it("returns null when there is no usable resource id", () => {
    expect(normalizeArcMachine({ name: "orphan" })).toBeNull();
    expect(normalizeArcMachine(null)).toBeNull();
    expect(normalizeArcMachine("nope")).toBeNull();
  });

  it("prefers an explicit displayName over the resource name", () => {
    const m = norm({ ...RP_ROW, properties: { ...RP_ROW.properties, displayName: "web01-friendly" } });
    expect(m.displayName).toBe("web01-friendly");
  });
});

// ─── extractIpAddresses ─────────────────────────────────────────────────────

describe("extractIpAddresses", () => {
  it("pulls addresses out of the networkProfile NIC list", () => {
    expect(extractIpAddresses({
      networkInterfaces: [
        { ipAddresses: [{ address: "10.0.0.5", ipAddressVersion: "IPv4" }] },
        { ipAddresses: [{ address: "fe80::1", ipAddressVersion: "IPv6" }] },
      ],
    })).toEqual(["10.0.0.5", "fe80::1"]);
  });

  it("de-duplicates repeated addresses", () => {
    expect(extractIpAddresses({
      networkInterfaces: [
        { ipAddresses: [{ address: "10.0.0.5" }] },
        { ipAddresses: [{ address: "10.0.0.5" }] },
      ],
    })).toEqual(["10.0.0.5"]);
  });

  it("returns an empty array for missing or malformed input", () => {
    expect(extractIpAddresses(undefined)).toEqual([]);
    expect(extractIpAddresses({})).toEqual([]);
    expect(extractIpAddresses({ networkInterfaces: "nope" })).toEqual([]);
  });
});

// ─── inferArcAssetType ──────────────────────────────────────────────────────

describe("inferArcAssetType", () => {
  it("types Windows Server SKUs as servers", () => {
    expect(inferArcAssetType({ osType: "windows", osSku: "Windows Server 2022 Datacenter", osName: "Windows" }))
      .toBe("server");
    expect(inferArcAssetType({ osType: "windows", osSku: "Windows Server 2019 Standard", osName: null }))
      .toBe("server");
  });

  it("types Windows client SKUs as workstations", () => {
    expect(inferArcAssetType({ osType: "windows", osSku: "Windows 11 Enterprise", osName: "Windows" }))
      .toBe("workstation");
    expect(inferArcAssetType({ osType: "windows", osSku: "Windows 10 Pro", osName: null }))
      .toBe("workstation");
  });

  it("types Linux as a server unless it advertises a desktop", () => {
    // Arc-enabled Linux is overwhelmingly server-class — the opposite default
    // from Entra, where Linux endpoints are frequently laptops.
    expect(inferArcAssetType({ osType: "linux", osSku: "Ubuntu 22.04.4 LTS", osName: "linux" }))
      .toBe("server");
    expect(inferArcAssetType({ osType: "linux", osSku: "Ubuntu 22.04 Desktop", osName: "linux" }))
      .toBe("workstation");
  });

  it("types Windows as a server when no CLIENT marker is present", () => {
    // Regression: this used to return "workstation" for any Windows machine
    // whose SKU text lacked "server"/"datacenter". Arc frequently reports only
    // osName:"windows" with no osSku, so real Server 2019/2022 hosts were
    // silently typed workstations — which then routed them through
    // workstationMonitor instead of serverMonitor.
    expect(inferArcAssetType({ osType: "windows", osSku: null, osName: "windows" })).toBe("server");
    expect(inferArcAssetType({ osType: "windows", osSku: null, osName: null })).toBe("server");
    expect(inferArcAssetType({ osType: "windows", osSku: "Standard", osName: "windows" })).toBe("server");
  });

  it("still types an explicit client SKU as a workstation", () => {
    expect(inferArcAssetType({ osType: "windows", osSku: "Windows 11 Enterprise", osName: "windows" }))
      .toBe("workstation");
    expect(inferArcAssetType({ osType: "windows", osSku: "Windows 10 Pro", osName: "windows" }))
      .toBe("workstation");
  });

  it("sniffs osType from the SKU text when an older agent omits it", () => {
    expect(inferArcAssetType({ osType: null, osSku: null, osName: "Windows" })).toBe("server");
    expect(inferArcAssetType({ osType: null, osSku: null, osName: "Linux" })).toBe("server");
  });

  it("falls back to other only when Arc says nothing at all", () => {
    expect(inferArcAssetType({ osType: null, osSku: null, osName: null })).toBe("other");
    expect(inferArcAssetType({ osType: null, osSku: null, osName: "" })).toBe("other");
  });
});

// ─── arcStatusIsConnected ───────────────────────────────────────────────────

describe("arcStatusIsConnected", () => {
  it("is true only for Connected", () => {
    expect(arcStatusIsConnected("Connected")).toBe(true);
    expect(arcStatusIsConnected("connected")).toBe(true);
    expect(arcStatusIsConnected("  Connected ")).toBe(true);
  });

  it("is false for every other state", () => {
    expect(arcStatusIsConnected("Disconnected")).toBe(false);
    expect(arcStatusIsConnected("Expired")).toBe(false);
    expect(arcStatusIsConnected(null)).toBe(false);
    expect(arcStatusIsConnected(undefined)).toBe(false);
  });
});

// ─── matchesTagFilter ───────────────────────────────────────────────────────

describe("matchesTagFilter", () => {
  const tags = { env: "prod", owner: "infra", Tier: "gold" };

  it("matches an exact key=value", () => {
    expect(matchesTagFilter(tags, "env=prod")).toBe(true);
    expect(matchesTagFilter(tags, "env=dev")).toBe(false);
  });

  it("matches key=* as any value of that key", () => {
    expect(matchesTagFilter(tags, "owner=*")).toBe(true);
    expect(matchesTagFilter(tags, "missing=*")).toBe(false);
  });

  it("supports wildcards on the value", () => {
    expect(matchesTagFilter(tags, "env=pro*")).toBe(true);
    expect(matchesTagFilter(tags, "env=*rod")).toBe(true);
    expect(matchesTagFilter(tags, "env=*ro*")).toBe(true);
  });

  it("matches the key case-insensitively", () => {
    expect(matchesTagFilter(tags, "tier=gold")).toBe(true);
  });

  it("treats a bare key as key presence", () => {
    expect(matchesTagFilter(tags, "owner")).toBe(true);
    expect(matchesTagFilter(tags, "nothere")).toBe(false);
  });

  it("never matches on an empty line", () => {
    expect(matchesTagFilter(tags, "")).toBe(false);
    expect(matchesTagFilter(tags, "   ")).toBe(false);
    expect(matchesTagFilter(tags, "=prod")).toBe(false);
  });
});

// ─── filterArcMachines ──────────────────────────────────────────────────────

describe("filterArcMachines", () => {
  const prod = machine({ resourceGroup: "rg-prod", displayName: "WEB01", tags: { env: "prod" } });
  const lab = machine({ resourceGroup: "rg-lab", displayName: "LAB-SQL", tags: { env: "dev" } });
  const all = [prod, lab];

  it("returns everything when no filter is set", () => {
    expect(filterArcMachines(all, {})).toEqual(all);
  });

  it("applies a resource-group include with wildcards", () => {
    expect(filterArcMachines(all, { resourceGroupInclude: ["rg-prod*"] })).toEqual([prod]);
    expect(filterArcMachines(all, { resourceGroupInclude: ["*-lab"] })).toEqual([lab]);
    expect(filterArcMachines(all, { resourceGroupInclude: ["*"] })).toEqual(all);
  });

  it("applies a resource-group exclude", () => {
    expect(filterArcMachines(all, { resourceGroupExclude: ["rg-lab"] })).toEqual([prod]);
  });

  it("lets include win when both are set on the same axis", () => {
    expect(filterArcMachines(all, {
      resourceGroupInclude: ["rg-lab"],
      resourceGroupExclude: ["rg-lab"],
    })).toEqual([lab]);
  });

  it("filters on display name", () => {
    expect(filterArcMachines(all, { deviceInclude: ["WEB*"] })).toEqual([prod]);
    expect(filterArcMachines(all, { deviceExclude: ["*SQL"] })).toEqual([prod]);
  });

  it("filters on tags", () => {
    expect(filterArcMachines(all, { tagInclude: ["env=prod"] })).toEqual([prod]);
    expect(filterArcMachines(all, { tagExclude: ["env=dev"] })).toEqual([prod]);
  });

  it("ANDs across axes", () => {
    expect(filterArcMachines(all, {
      resourceGroupInclude: ["rg-prod"],
      tagInclude: ["env=dev"],
    })).toEqual([]);
  });

  it("ignores blank filter lines", () => {
    expect(filterArcMachines(all, { resourceGroupInclude: ["", "  "] })).toEqual(all);
  });
});

// ─── arcHostnameCandidates ──────────────────────────────────────────────────

describe("arcHostnameCandidates", () => {
  it("prefers dnsFqdn over adFqdn", () => {
    expect(arcHostnameCandidates({
      dnsFqdn: "web01.corp.local",
      adFqdn: "web01.ad.local",
      displayName: "WEB01",
      name: "WEB01",
    }).fqdn).toBe("web01.corp.local");
  });

  it("falls back to adFqdn", () => {
    expect(arcHostnameCandidates({
      dnsFqdn: null, adFqdn: "web01.ad.local", displayName: "WEB01", name: "WEB01",
    }).fqdn).toBe("web01.ad.local");
  });

  it("does not report a dot-less value as an FQDN", () => {
    // A short name in the adFqdn field must not reach the FQDN projection rule.
    const c = arcHostnameCandidates({ dnsFqdn: null, adFqdn: "WEB01", displayName: "WEB01", name: "WEB01" });
    expect(c.fqdn).toBeNull();
    expect(c.short).toBe("WEB01");
  });

  it("derives a short name from the FQDN when nothing else is set", () => {
    expect(arcHostnameCandidates({
      dnsFqdn: "web01.corp.local", adFqdn: null, displayName: "", name: "",
    }).short).toBe("web01");
  });
});

// ─── buildArcObservedBlob ───────────────────────────────────────────────────

describe("buildArcObservedBlob", () => {
  const blob = buildArcObservedBlob(norm(RP_ROW), new Date("2026-08-07T12:00:00Z"));

  it("carries every key the projection rules read", () => {
    for (const key of [
      "dnsFqdn", "adFqdn", "displayName", "name",
      "osSku", "osName", "osVersion",
      "manufacturer", "model", "serialNumber",
      "resourceGroup", "ipAddresses",
    ]) {
      expect(blob).toHaveProperty(key);
    }
  });

  it("records the Azure region as azureRegion, never as a location", () => {
    // The region describes where the Arc RECORD lives, not the machine — it
    // must never be projected into Asset.learnedLocation.
    expect(blob.azureRegion).toBe("eastus");
    expect(blob).not.toHaveProperty("location");
    expect(blob).not.toHaveProperty("learnedLocation");
  });

  it("stamps the sync time and source kind", () => {
    expect(blob.kind).toBe("arc");
    expect(blob.syncedAt).toBe("2026-08-07T12:00:00.000Z");
  });

  it("keeps the Azure resource tags under azureTags", () => {
    // Deliberately NOT mirrored into Asset.tags — an unbounded stream of cloud
    // tags would fight tagAssignmentService's managed add-and-remove sync.
    expect(blob.azureTags).toEqual({ env: "prod", owner: "infra" });
  });
});

// ─── Error surfaces ─────────────────────────────────────────────────────────

describe("describeAadTokenError", () => {
  it("translates the three AADSTS codes operators actually hit", () => {
    expect(describeAadTokenError(
      JSON.stringify({ error_description: "AADSTS7000215: Invalid client secret provided." }), 401,
    )).toBe("Client secret is invalid or expired.");

    expect(describeAadTokenError(
      JSON.stringify({ error_description: "AADSTS700016: Application not found." }), 400,
    )).toContain("Client ID not found");

    expect(describeAadTokenError(
      JSON.stringify({ error_description: "AADSTS90002: Tenant not found." }), 400,
    )).toContain("Tenant not found");
  });

  it("falls back to the first line of the description", () => {
    expect(describeAadTokenError(
      JSON.stringify({ error_description: "Something odd\nTrace ID: abc" }), 400,
    )).toBe("Something odd");
  });

  it("falls back to the status code for an unparseable body", () => {
    expect(describeAadTokenError("", 503)).toBe("HTTP 503");
  });
});

describe("extractArmError", () => {
  it("reads the nested ARM error message", () => {
    expect(extractArmError(JSON.stringify({
      error: { code: "AuthorizationFailed", message: "does not have authorization" },
    }))).toContain("does not have authorization");
  });

  it("appends Resource Graph detail entries", () => {
    expect(extractArmError(JSON.stringify({
      error: { code: "BadRequest", message: "Query failed", details: [{ message: "bad syntax" }] },
    }))).toBe("Query failed (bad syntax)");
  });

  it("truncates an unparseable body rather than throwing", () => {
    expect(extractArmError("<html>nope</html>")).toBe("<html>nope</html>");
  });
});

describe("throttleDelayMs", () => {
  const headers = (map: Record<string, string>) => ({
    get: (n: string) => map[n.toLowerCase()] ?? null,
  });

  it("prefers Retry-After seconds", () => {
    expect(throttleDelayMs(headers({ "retry-after": "12" }))).toBe(12_000);
  });

  it("falls back to the Resource Graph quota reset duration", () => {
    expect(throttleDelayMs(headers({ "x-ms-user-quota-resets-after": "00:00:05" }))).toBe(5_000);
    expect(throttleDelayMs(headers({ "x-ms-user-quota-resets-after": "00:00:45" }))).toBe(45_000);
  });

  it("defaults to 5s when neither header is present", () => {
    expect(throttleDelayMs(headers({}))).toBe(5_000);
  });

  it("clamps to 60s so a garbled header cannot wedge a run", () => {
    expect(throttleDelayMs(headers({ "retry-after": "99999" }))).toBe(60_000);
  });
});

// ─── Phase 2/3: extension resources ─────────────────────────────────────────

describe("parentMachineIdFromExtensionId", () => {
  const child = ARM_ID + "/providers/Microsoft.ConnectedVMwarevSphere/virtualMachineInstances/default";

  it("returns the owning machine id, lowercased", () => {
    expect(parentMachineIdFromExtensionId(child)).toBe(ARM_ID.toLowerCase());
  });

  it("returns null for a plain machine id (no nested provider segment)", () => {
    expect(parentMachineIdFromExtensionId(ARM_ID)).toBeNull();
  });

  it("returns null when the parent is not a HybridCompute machine", () => {
    expect(parentMachineIdFromExtensionId(
      `/subscriptions/${SUB}/resourceGroups/rg/providers/Microsoft.Compute/virtualMachines/vm1`
        + "/providers/Microsoft.Foo/bars/default",
    )).toBeNull();
  });

  it("returns null for junk", () => {
    expect(parentMachineIdFromExtensionId("")).toBeNull();
    expect(parentMachineIdFromExtensionId(null)).toBeNull();
    expect(parentMachineIdFromExtensionId(42)).toBeNull();
  });
});

describe("buildArcVmInstancesQuery / buildArcSqlInstancesQuery", () => {
  it("targets both VMware and SCVMM instance types in one query", () => {
    const q = buildArcVmInstancesQuery();
    expect(q).toContain("microsoft.connectedvmwarevsphere/virtualmachineinstances");
    expect(q).toContain("microsoft.scvmm/virtualmachineinstances");
  });

  it("targets the Arc SQL instance type", () => {
    expect(buildArcSqlInstancesQuery()).toContain("microsoft.azurearcdata/sqlserverinstances");
  });

  it("scopes to validated subscriptions and drops non-GUIDs", () => {
    // Same injection boundary as the machines query.
    for (const q of [
      buildArcVmInstancesQuery({ subscriptionIds: [SUB, "' | project 1 | where '"] }),
      buildArcSqlInstancesQuery({ subscriptionIds: [SUB, "' | project 1 | where '"] }),
    ]) {
      expect(q).toContain(`subscriptionId in~ ('${SUB}')`);
      expect(q).not.toContain("project 1");
    }
  });
});

describe("normalizeArcVmInstance", () => {
  const vmwareRow = {
    id: ARM_ID + "/providers/Microsoft.ConnectedVMwarevSphere/virtualMachineInstances/default",
    name: "default",
    type: "microsoft.connectedvmwarevsphere/virtualmachineinstances",
    properties: {
      infrastructureProfile: {
        instanceUuid: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
        biosGuid: "12345678-1234-5678-9abc-def012345678",
        moRefId: "vm-1234",
        vCenterId: "/subscriptions/x/vcenters/vc1",
        inventoryItemId: "inv-1",
        folderPath: "DC/vm/Prod",
      },
      hardwareProfile: { numCPUs: 4, memorySizeMB: 8192 },
      hostName: "esx01.corp.local",
    },
  };

  it("maps a VMware instance and carries the vCenter join key", () => {
    const vm = normalizeArcVmInstance(vmwareRow);
    expect(vm?.platform).toBe("vmware");
    expect(vm?.parentMachineId).toBe(ARM_ID.toLowerCase());
    // The whole point of Phase 2 for dedupe: instanceUuid is exactly what
    // vcenterService.pickVmExternalId prefers as its externalId.
    expect(vm?.instanceUuid).toBe("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
    expect(vm?.biosGuid).toBe("12345678-1234-5678-9abc-def012345678");
    expect(vm?.moRefId).toBe("vm-1234");
    expect(vm?.cpuCount).toBe(4);
    expect(vm?.memoryMB).toBe(8192);
  });

  it("detects the SCVMM platform from the resource type", () => {
    const vm = normalizeArcVmInstance({
      ...vmwareRow, type: "microsoft.scvmm/virtualmachineinstances",
    });
    expect(vm?.platform).toBe("scvmm");
  });

  it("returns null when the row has no resolvable parent machine", () => {
    expect(normalizeArcVmInstance({ ...vmwareRow, id: "/nonsense" })).toBeNull();
    expect(normalizeArcVmInstance(null)).toBeNull();
  });

  it("survives a row with no profiles at all", () => {
    const vm = normalizeArcVmInstance({ id: vmwareRow.id, type: vmwareRow.type });
    expect(vm?.instanceUuid).toBeNull();
    expect(vm?.cpuCount).toBeNull();
    expect(vm?.parentMachineId).toBe(ARM_ID.toLowerCase());
  });

  it("rejects an all-zero instanceUuid rather than indexing it", () => {
    // Same mass-merge hazard as the SMBIOS vmUuid.
    const vm = normalizeArcVmInstance({
      ...vmwareRow,
      properties: { infrastructureProfile: { instanceUuid: "00000000-0000-0000-0000-000000000000" } },
    });
    expect(vm?.instanceUuid).toBeNull();
  });
});

describe("normalizeArcSqlInstance", () => {
  const sqlRow = {
    id: `/subscriptions/${SUB}/resourceGroups/rg-prod/providers/Microsoft.AzureArcData/sqlServerInstances/WEB01_MSSQLSERVER`,
    name: "WEB01_MSSQLSERVER",
    type: "microsoft.azurearcdata/sqlserverinstances",
    properties: {
      containerResourceId: ARM_ID,
      instanceName: "MSSQLSERVER",
      edition: "Standard",
      version: "SQL Server 2019",
      patchLevel: "15.0.4322.2",
      status: "Connected",
      licenseType: "Paid",
      vCore: "8",
    },
  };

  it("links to its machine via containerResourceId, not the id path", () => {
    // A SQL instance is a TOP-LEVEL resource that points at its machine, so
    // parentMachineIdFromExtensionId would never find it.
    const sql = normalizeArcSqlInstance(sqlRow);
    expect(sql?.parentMachineId).toBe(ARM_ID.toLowerCase());
    expect(sql?.instanceName).toBe("MSSQLSERVER");
    expect(sql?.edition).toBe("Standard");
    expect(sql?.version).toBe("SQL Server 2019");
    expect(sql?.vCoreCount).toBe(8);
  });

  it("returns null when the container link is missing or not a machine", () => {
    expect(normalizeArcSqlInstance({ ...sqlRow, properties: {} })).toBeNull();
    expect(normalizeArcSqlInstance({
      ...sqlRow,
      properties: { containerResourceId: `/subscriptions/${SUB}/resourceGroups/rg/providers/Microsoft.Compute/virtualMachines/vm1` },
    })).toBeNull();
    expect(normalizeArcSqlInstance(null)).toBeNull();
  });
});

describe("buildArcObservedBlob — Phase 2/3 fields", () => {
  it("carries null / empty when the toggles were never enabled", () => {
    // An operator who never opted in must see no change in the blob shape.
    const blob = buildArcObservedBlob(norm(RP_ROW), new Date("2026-08-07T12:00:00Z"));
    expect(blob.vmInstance).toBeNull();
    expect(blob.sqlInstances).toEqual([]);
  });

  it("carries the attached extension resources when present", () => {
    const m = norm(RP_ROW);
    m.vmInstance = {
      platform: "vmware",
      parentMachineId: m.armId,
      instanceUuid: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      biosGuid: null, moRefId: "vm-1", vCenterId: null, inventoryItemId: null,
      hostName: "esx01", cpuCount: 4, memoryMB: 8192, folderPath: null,
    };
    m.sqlInstances = [{
      parentMachineId: m.armId, name: "WEB01_MSSQLSERVER", instanceName: "MSSQLSERVER",
      edition: "Standard", version: "SQL Server 2019", patchLevel: null,
      status: "Connected", licenseType: "Paid", vCoreCount: 8,
    }];
    const blob = buildArcObservedBlob(m, new Date("2026-08-07T12:00:00Z")) as any;
    expect(blob.vmInstance.platform).toBe("vmware");
    expect(blob.sqlInstances).toHaveLength(1);
    expect(blob.sqlInstances[0].edition).toBe("Standard");
  });
});

// ─── Phase 4: connected Kubernetes clusters ─────────────────────────────────

describe("buildArcClustersQuery", () => {
  it("targets the connected-cluster type", () => {
    expect(buildArcClustersQuery()).toContain("microsoft.kubernetes/connectedclusters");
  });

  it("projects location and tags (a cluster is an asset, not just detail)", () => {
    const q = buildArcClustersQuery();
    expect(q).toContain("project id, name, type, location, tags, properties, subscriptionId, resourceGroup");
  });

  it("scopes to validated subscriptions and drops non-GUIDs", () => {
    const q = buildArcClustersQuery({ subscriptionIds: [SUB, "'; drop"] });
    expect(q).toContain(`subscriptionId in~ ('${SUB}')`);
    expect(q).not.toContain("drop");
  });
});

describe("normalizeArcCluster", () => {
  const CLUSTER_ID = `/subscriptions/${SUB}/resourceGroups/rg-k8s/providers/Microsoft.Kubernetes/connectedClusters/prod-cluster`;
  const row = {
    id: CLUSTER_ID,
    name: "prod-cluster",
    type: "microsoft.kubernetes/connectedclusters",
    location: "eastus",
    tags: { env: "prod" },
    properties: {
      kubernetesVersion: "1.29.4",
      distribution: "aks_edge",
      infrastructure: "azure_stack_hci",
      totalNodeCount: 6,
      totalCoreCount: 48,
      agentVersion: "1.16.3",
      connectivityStatus: "Connected",
      provisioningState: "Succeeded",
    },
  };

  it("maps a connected cluster", () => {
    const c = normalizeArcCluster(row);
    expect(c?.armId).toBe(CLUSTER_ID.toLowerCase());
    expect(c?.name).toBe("prod-cluster");
    expect(c?.subscriptionId).toBe(SUB);
    expect(c?.resourceGroup).toBe("rg-k8s");
    expect(c?.kubernetesVersion).toBe("1.29.4");
    expect(c?.distribution).toBe("aks_edge");
    expect(c?.totalNodeCount).toBe(6);
    expect(c?.connectivityStatus).toBe("Connected");
    expect(c?.tags).toEqual({ env: "prod" });
  });

  it("derives subscription and resource group from the id when ARG columns are absent", () => {
    const c = normalizeArcCluster({ ...row, subscriptionId: undefined, resourceGroup: undefined });
    expect(c?.subscriptionId).toBe(SUB);
    expect(c?.resourceGroup).toBe("rg-k8s");
  });

  it("survives a cluster with no properties", () => {
    const c = normalizeArcCluster({ id: CLUSTER_ID, name: "bare" });
    expect(c?.kubernetesVersion).toBeNull();
    expect(c?.totalNodeCount).toBeNull();
    expect(c?.armId).toBe(CLUSTER_ID.toLowerCase());
  });

  it("returns null without a usable resource id", () => {
    expect(normalizeArcCluster({ name: "orphan" })).toBeNull();
    expect(normalizeArcCluster(null)).toBeNull();
  });

  it("builds an observed blob the projection rules can read", () => {
    const c = normalizeArcCluster(row)!;
    const blob = buildArcClusterObservedBlob(c, new Date("2026-08-07T12:00:00Z"));
    expect(blob.kind).toBe("arc-k8s");
    expect(blob.name).toBe("prod-cluster");
    expect(blob.kubernetesVersion).toBe("1.29.4");
    expect(blob.resourceGroup).toBe("rg-k8s");
    // Region is metadata about the RECORD, never a physical location.
    expect(blob.azureRegion).toBe("eastus");
    expect(blob).not.toHaveProperty("location");
  });
});

// ─── azureTagsToAssetTags ───────────────────────────────────────────────────

describe("azureTagsToAssetTags", () => {
  const tags = { DefenderPlan: "P1", Environment: "Production", CreatedDate: "2026-01-02" };

  it("returns nothing while importAzureTags is off — the default", () => {
    expect(azureTagsToAssetTags(tags, {})).toEqual([]);
    expect(azureTagsToAssetTags(tags, null)).toEqual([]);
    expect(azureTagsToAssetTags(tags, { azureTagKeys: ["*"] })).toEqual([]);
  });

  it("mirrors every key as azure:Key=Value, sorted, when no keys are listed", () => {
    expect(azureTagsToAssetTags(tags, { importAzureTags: true })).toEqual([
      "azure:CreatedDate=2026-01-02",
      "azure:DefenderPlan=P1",
      "azure:Environment=Production",
    ]);
  });

  it("narrows by key, case-insensitively, with wildcards", () => {
    expect(azureTagsToAssetTags(tags, { importAzureTags: true, azureTagKeys: ["defenderplan", "Env*"] }))
      .toEqual(["azure:DefenderPlan=P1", "azure:Environment=Production"]);
  });

  it("ignores blank key lines rather than reading them as every key", () => {
    expect(azureTagsToAssetTags(tags, { importAzureTags: true, azureTagKeys: ["  ", "DefenderPlan"] }))
      .toEqual(["azure:DefenderPlan=P1"]);
  });

  it("drops the = for an empty value and trims both sides", () => {
    expect(azureTagsToAssetTags({ " Critical ": "", Owner: "  IT  " }, { importAzureTags: true }))
      .toEqual(["azure:Critical", "azure:Owner=IT"]);
  });

  it("returns nothing for a resource with no tags", () => {
    expect(azureTagsToAssetTags({}, { importAzureTags: true })).toEqual([]);
  });
});
