import { describe, it, expect } from "vitest";
import {
  ALL_WORKLOAD_SOURCE_KINDS,
  assetTypeForWorkloadRole,
  isWorkloadPlatform,
  parseWorkloadSourceKind,
  workloadContainerNoun,
  workloadPlatformLabel,
  workloadSourceKind,
  workloadSourceKindsFor,
} from "../../src/utils/workloadSources.js";
import { projectAssetFromSources } from "../../src/utils/assetProjection.js";
import { assetMatchesIntegrationFilter } from "../../src/utils/integrationFilter.js";

describe("workload source kinds", () => {
  it("names one kind per platform + role, TrueNAS containers being Apps", () => {
    expect(workloadSourceKindsFor("unraid")).toEqual(["unraid-host", "unraid-vm", "unraid-container"]);
    expect(workloadSourceKindsFor("truenas")).toEqual(["truenas-host", "truenas-vm", "truenas-app"]);
    expect(workloadSourceKindsFor("proxmox")).toEqual(["proxmox-node", "proxmox-qemu", "proxmox-lxc"]);
    expect(workloadSourceKind("truenas", "container")).toBe("truenas-app");
    expect(ALL_WORKLOAD_SOURCE_KINDS).toHaveLength(9);
  });

  it("names the container role the way each platform does", () => {
    expect(workloadContainerNoun("truenas")).toBe("App");
    expect(workloadContainerNoun("unraid")).toBe("Container");
    expect(workloadContainerNoun("proxmox")).toBe("Container");
  });

  it("parses every kind back, and nothing else", () => {
    for (const kind of ALL_WORKLOAD_SOURCE_KINDS) {
      const parsed = parseWorkloadSourceKind(kind)!;
      expect(workloadSourceKind(parsed.platform, parsed.role)).toBe(kind);
    }
    expect(parseWorkloadSourceKind("vcenter-vm")).toBeNull();
    expect(parseWorkloadSourceKind(null)).toBeNull();
  });

  it("maps roles to asset types and platforms to labels", () => {
    expect(assetTypeForWorkloadRole("host")).toBe("hypervisor");
    expect(assetTypeForWorkloadRole("vm")).toBe("server");
    expect(assetTypeForWorkloadRole("container")).toBe("container");
    expect(workloadPlatformLabel("truenas")).toBe("TrueNAS SCALE");
    expect(workloadPlatformLabel("proxmox")).toBe("Proxmox VE");
    expect(isWorkloadPlatform("unraid")).toBe(true);
    expect(isWorkloadPlatform("proxmox")).toBe(true);
    expect(isWorkloadPlatform("vcenter")).toBe(false);
    expect(isWorkloadPlatform(undefined)).toBe(false);
  });
});

describe("workload projection rules", () => {
  it("projects a host's identity off its own report", () => {
    const { projected } = projectAssetFromSources([{
      sourceKind: "truenas-host", inferred: false,
      observed: { hostname: "nas01", os: "TrueNAS SCALE", osVersion: "25.10.1", serial: "ABC123", manufacturer: "iXsystems", model: "TrueNAS Mini X", ip: "10.0.0.5" },
    }]);
    expect(projected.hostname).toBe("nas01");
    expect(projected.os).toBe("TrueNAS SCALE");
    expect(projected.osVersion).toBe("25.10.1");
    expect(projected.serialNumber).toBe("ABC123");
    expect(projected.model).toBe("TrueNAS Mini X");
    expect(projected.ipAddress).toBe("10.0.0.5");
  });

  it("refuses a placeholder board serial (rule 84)", () => {
    const { projected } = projectAssetFromSources([{
      sourceKind: "unraid-host", inferred: false,
      observed: { hostname: "tower", serial: "To Be Filled By O.E.M." },
    }]);
    expect(projected.serialNumber ?? null).toBeNull();
  });

  it("projects a container's image as its OS and leaves a shared address unset", () => {
    const { projected } = projectAssetFromSources([{
      sourceKind: "unraid-container", inferred: false,
      observed: { name: "plex", image: "lscr.io/linuxserver/plex:latest", ip: null },
    }]);
    expect(projected.hostname).toBe("plex");
    expect(projected.os).toBe("lscr.io/linuxserver/plex:latest");
    expect(projected.ipAddress ?? null).toBeNull();
  });
});

describe("workload integration filter", () => {
  const intg = (config: Record<string, unknown>) => ({ type: "unraid", config });

  it("filters VMs and containers on their own pairs; hosts never", () => {
    const cfg = intg({ vmExclude: ["test-*"], containerInclude: ["plex", "sonarr"] });
    expect(assetMatchesIntegrationFilter({ hostname: "test-vm1", learnedLocation: null, assetType: "server" }, cfg).included).toBe(false);
    expect(assetMatchesIntegrationFilter({ hostname: "prod-vm1", learnedLocation: null, assetType: "server" }, cfg).included).toBe(true);
    expect(assetMatchesIntegrationFilter({ hostname: "plex", learnedLocation: null, assetType: "container" }, cfg).included).toBe(true);
    expect(assetMatchesIntegrationFilter({ hostname: "radarr", learnedLocation: null, assetType: "container" }, cfg).included).toBe(false);
    expect(assetMatchesIntegrationFilter({ hostname: "test-host", learnedLocation: null, assetType: "hypervisor" }, cfg).included).toBe(true);
  });

  it("prefers the platform's name over the merged hostname", () => {
    const cfg = { type: "truenas", config: { vmInclude: ["win-*"] } };
    expect(assetMatchesIntegrationFilter(
      { hostname: "DESKTOP-ABC", vmName: "win-11", learnedLocation: null, assetType: "server" }, cfg,
    ).included).toBe(true);
  });
});
