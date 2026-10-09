import { describe, it, expect, vi } from "vitest";

// workloadSync imports discoveryEngine (for the shared hostname / conflict
// helpers), which pulls the whole discovery graph and a DB client. The pure
// functions under test need none of it.
vi.mock("../../src/services/discovery/discoveryEngine.js", () => ({
  indexHostname: vi.fn(), lookupHostname: vi.fn(), normalizeMacKey: vi.fn(), upsertAssetConflict: vi.fn(),
}));
vi.mock("../../src/db.js", () => ({ prisma: {} }));

const {
  applyWorkloadFilters,
  buildWorkloadDependencyEdges,
  normalizeWorkloadState,
  passesNameFilter,
  resolveWorkloadHostAddress,
  staleContainerIps,
  workloadContainerExternalId,
  workloadContainerKey,
  workloadHostExternalId,
  workloadHostUsageKey,
  workloadSweepBlockedReason,
  workloadVmExternalId,
} = await import("../../src/services/discovery/workloadSync.js");

type Result = Parameters<typeof applyWorkloadFilters>[0];

function result(over: Partial<Result> = {}): Result {
  return {
    platform: "unraid",
    hosts: [{
      hostname: "tower", os: "Unraid", osVersion: "7.2.0", ip: "10.0.0.2", serial: null, manufacturer: null, model: null,
      cpuCount: 8, memTotalBytes: 32e9, uptimeSeconds: 100, pools: [], disks: [],
    }],
    vms: [],
    containers: [],
    inventoryComplete: true,
    presentVmNames: [],
    presentContainerNames: [],
    ...over,
  };
}

const vm = (name: string, uuid: string | null = null) => ({
  platformId: name, name, uuid, state: "running" as const, rawState: "RUNNING", cpuCount: 2, memoryBytes: 4e9, ip: null, macs: [], autostart: true,
});
const ctr = (name: string) => ({
  platformId: name, name, image: `img/${name}`, state: "running" as const, rawState: "RUNNING", ip: null, networkMode: "bridge",
  updateAvailable: null, version: null, latestVersion: null, memberCount: 1, ports: [], autostart: true,
});

describe("resolveWorkloadHostAddress", () => {
  const configured = (addrs: string[]) => async () => ({ lookup: async () => addrs.map((address) => ({ address })) });
  const failing = async () => ({ lookup: async () => { throw Object.assign(new Error("nx"), { code: "ENOTFOUND" }); } });

  it("passes an IP through with no DNS name", async () => {
    expect(await resolveWorkloadHostAddress("10.0.0.2", { configured: configured([]) })).toEqual({ ip: "10.0.0.2", dnsName: null });
    expect(await resolveWorkloadHostAddress("[fd00::2]")).toEqual({ ip: "fd00::2", dnsName: null });
  });

  it("resolves a name through the configured resolver and keeps it as dnsName", async () => {
    expect(await resolveWorkloadHostAddress("Tower.Lan.", { configured: configured(["10.0.0.9"]) }))
      .toEqual({ ip: "10.0.0.9", dnsName: "tower.lan" });
  });

  it("falls back to the system resolver", async () => {
    const system = vi.fn(async () => ({ address: "10.0.0.7" }));
    expect(await resolveWorkloadHostAddress("tower.lan", { configured: failing, system })).toEqual({ ip: "10.0.0.7", dnsName: "tower.lan" });
    expect(system).toHaveBeenCalledWith("tower.lan");
  });

  it("never returns the name as the IP when nothing resolves", async () => {
    const system = async () => { throw new Error("ENOTFOUND"); };
    expect(await resolveWorkloadHostAddress("tower.lan", { configured: configured([]), system })).toEqual({ ip: null, dnsName: "tower.lan" });
  });

  it("returns nothing for an empty host", async () => {
    expect(await resolveWorkloadHostAddress(null)).toEqual({ ip: null, dnsName: null });
  });
});

describe("normalizeWorkloadState", () => {
  it("maps both platforms' vocabularies onto four states", () => {
    expect(normalizeWorkloadState("RUNNING")).toBe("running");
    expect(normalizeWorkloadState("EXITED")).toBe("stopped");
    expect(normalizeWorkloadState("SHUTOFF")).toBe("stopped");
    expect(normalizeWorkloadState("CRASHED")).toBe("stopped");
    expect(normalizeWorkloadState("PMSUSPENDED")).toBe("paused");
    expect(normalizeWorkloadState("DEPLOYING")).toBe("other");
    expect(normalizeWorkloadState(null)).toBe("other");
  });
});

describe("identity", () => {
  it("keys a host on the integration, a container on its name, a VM on its UUID", () => {
    expect(workloadHostExternalId("i1")).toBe("i1:host");
    expect(workloadContainerExternalId("i1", "plex")).toBe("i1:ctr:plex");
    expect(workloadVmExternalId("i1", { uuid: "ABCD-1234", name: "win11" })).toBe("abcd-1234");
  });
  it("keys a cluster node on its name, and leaves the single-host id exactly as it was", () => {
    expect(workloadHostExternalId("i1", "pve2")).toBe("i1:node:pve2");
    expect(workloadHostExternalId("i1", null)).toBe("i1:host");
    expect(workloadHostUsageKey(null)).toBe("");
    expect(workloadHostUsageKey("pve2")).toBe("pve2");
  });
  it("keys a container on its identityKey when the platform sets one, else its name", () => {
    expect(workloadContainerKey({ name: "web", identityKey: "105" })).toBe("105");
    expect(workloadContainerKey({ name: "plex" })).toBe("plex");
    expect(workloadContainerKey({ name: "plex", identityKey: null })).toBe("plex");
  });
  it("falls back to the name for a missing or placeholder UUID", () => {
    expect(workloadVmExternalId("i1", { uuid: null, name: "win11" })).toBe("i1:vm:win11");
    expect(workloadVmExternalId("i1", { uuid: "00000000-0000-0000-0000-000000000000", name: "win11" })).toBe("i1:vm:win11");
  });
});

describe("filters", () => {
  it("include wins; exclude only when no include", () => {
    expect(passesNameFilter("plex", ["pl*"], ["plex"])).toBe(true);
    expect(passesNameFilter("radarr", [], ["rad*"])).toBe(false);
    expect(passesNameFilter("radarr", [], [])).toBe(true);
  });
  it("filters the lists but keeps the pre-filter names", () => {
    const r = applyWorkloadFilters(
      result({ vms: [vm("a"), vm("test-b")], containers: [ctr("plex"), ctr("tmp")], presentVmNames: ["a", "test-b"], presentContainerNames: ["plex", "tmp"] }),
      { vmExclude: ["test-*"], containerInclude: ["plex"] },
    );
    expect(r.vms.map((v) => v.name)).toEqual(["a"]);
    expect(r.containers.map((c) => c.name)).toEqual(["plex"]);
    expect(r.presentVmNames).toEqual(["a", "test-b"]);
  });
});

describe("workloadSweepBlockedReason", () => {
  it("refuses scoped runs, partial reads and an empty read of a populated host", () => {
    expect(workloadSweepBlockedReason(result(), "scoped", 5)).toMatch(/scoped/);
    expect(workloadSweepBlockedReason(result({ inventoryComplete: false }), "full", 5)).toMatch(/could not be read/);
    expect(workloadSweepBlockedReason(result(), "full", 5)).toMatch(/no VMs and no containers/);
  });
  it("allows an empty read of a host that never had workloads, and any normal read", () => {
    expect(workloadSweepBlockedReason(result(), "full", 0)).toBeNull();
    expect(workloadSweepBlockedReason(result({ presentContainerNames: ["plex"] }), "full", 5)).toBeNull();
  });
});

describe("buildWorkloadDependencyEdges", () => {
  it("parents every child on the host, deduped, never the host itself", () => {
    expect(buildWorkloadDependencyEdges(["v1", "c1", "c1", "h"], "h")).toEqual([
      { assetId: "v1", parentAssetId: "h" },
      { assetId: "c1", parentAssetId: "h" },
    ]);
  });
  it("writes nothing when the host itself could not be synced (pending conflict)", () => {
    expect(buildWorkloadDependencyEdges(["v1"], null)).toEqual([]);
  });
});

describe("staleContainerIps", () => {
  const kind = "unraid-container";
  it("names the host's address and the address this platform last reported", () => {
    expect(staleContainerIps("10.0.0.2", [{ sourceKind: kind, observed: { ip: "10.0.0.53" } }], kind)).toEqual(["10.0.0.2", "10.0.0.53"]);
  });
  it("never names an address the platform did not report (an operator's own stays)", () => {
    expect(staleContainerIps("10.0.0.2", [{ sourceKind: "ad", observed: { ip: "10.0.0.99" } }], kind)).toEqual(["10.0.0.2"]);
    expect(staleContainerIps(null, undefined, kind)).toEqual([]);
  });
});
