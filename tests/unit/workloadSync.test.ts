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
  workloadContainerExternalId,
  workloadHostExternalId,
  workloadSweepBlockedReason,
  workloadVmExternalId,
} = await import("../../src/services/discovery/workloadSync.js");

type Result = Parameters<typeof applyWorkloadFilters>[0];

function result(over: Partial<Result> = {}): Result {
  return {
    platform: "unraid",
    host: {
      hostname: "tower", os: "Unraid", osVersion: "7.2.0", ip: "10.0.0.2", serial: null, manufacturer: null, model: null,
      cpuCount: 8, memTotalBytes: 32e9, uptimeSeconds: 100, pools: [], disks: [],
    },
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
  platformId: name, name, image: `img/${name}`, state: "running" as const, rawState: "RUNNING", ip: null,
  updateAvailable: null, version: null, latestVersion: null, memberCount: 1, ports: [], autostart: true,
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
