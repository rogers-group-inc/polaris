/**
 * tests/unit/fortigateEndpointOsFingerprint.test.ts
 *
 * Business rule 198 — a gate's detected-device OS fingerprint is a SOURCE
 * claim. Phase 7 stages it, Phase 10 stamps it on the fortigate-endpoint row,
 * Phase 11's projection decides what the asset shows.
 *
 * The reported case (2026-11-24): an Arc-enrolled RHEL host also in Intune and
 * sighted by a FortiGate. Arc reports "Red Hat Enterprise Linux 8.10 (Ootpa)"
 * and the kernel; Entra / Intune / the gate report "Linux" / "8.10". Phase 7
 * wrote the gate's "8.10" straight onto the asset every run, Phase 11 put the
 * kernel back, and the netted-out change logged nothing.
 */

import { describe, it, expect } from "vitest";
import { buildFortigateEndpointObservedBlob } from "../../src/services/discovery/discoveryEngine.js";
import { projectAssetFromSources } from "../../src/utils/assetProjection.js";

const ARC_OS = "Red Hat Enterprise Linux 8.10 (Ootpa)";
const ARC_VER = "4.18.0-553.125.1.el8_10.x86_64";

const asset = (over: Record<string, unknown> = {}) => ({
  macAddress: "3c:ec:ef:d1:76:12", hostname: "rhel8test", ipAddress: "172.25.36.11",
  os: ARC_OS, osVersion: ARC_VER, manufacturer: "Supermicro", model: "SYS-E300-9D-4CN8TP",
  ...over,
});

describe("buildFortigateEndpointObservedBlob — OS facts (rule 198)", () => {
  it("records the gate's own fingerprint, not the asset's projected OS", () => {
    const blob = buildFortigateEndpointObservedBlob(asset(), "fortimanager", "FMG", "FGT-A", {
      fingerprint: { os: "Linux", osVersion: "8.10" },
    });
    expect(blob).toMatchObject({ os: "Linux", osVersion: "8.10", mac: "3C:EC:EF:D1:76:12" });
  });

  it("keeps what the row said last when this run's inventory said nothing", () => {
    const blob = buildFortigateEndpointObservedBlob(asset(), "fortimanager", "FMG", "FGT-A", {
      fingerprint: null,
      priorObserved: { os: "Linux", osVersion: "8.10" },
    });
    expect(blob).toMatchObject({ os: "Linux", osVersion: "8.10" });
  });

  it("fills one missing half of the fingerprint from the prior row", () => {
    const blob = buildFortigateEndpointObservedBlob(asset(), "fortimanager", "FMG", "FGT-A", {
      fingerprint: { os: null, osVersion: "8.10" },
      priorObserved: { os: "Linux", osVersion: "8.9" },
    });
    expect(blob).toMatchObject({ os: "Linux", osVersion: "8.10" });
  });

  it("falls back to the asset only with neither a fingerprint nor a prior row", () => {
    const blob = buildFortigateEndpointObservedBlob(asset(), "fortimanager", "FMG", "FGT-A");
    expect(blob).toMatchObject({ os: ARC_OS, osVersion: ARC_VER });
  });
});

describe("the reported source set projects to Arc's OS (rule 198)", () => {
  const sources = [
    { sourceKind: "entra", inferred: false, observed: { operatingSystem: "Linux", operatingSystemVersion: "8.10" } },
    { sourceKind: "intune", inferred: false, observed: { operatingSystem: "Linux", osVersion: "8.10" } },
    {
      sourceKind: "fortigate-endpoint", inferred: false,
      observed: buildFortigateEndpointObservedBlob(asset(), "fortimanager", "FMG", "FGT-A", {
        fingerprint: { os: "Linux", osVersion: "8.10" },
      }),
    },
    { sourceKind: "arc", inferred: false, observed: { osSku: ARC_OS, osName: "linux", osVersion: ARC_VER } },
  ];

  it("Arc wins both fields, so Phase 11 has nothing to correct", () => {
    const { projected } = projectAssetFromSources(sources);
    expect(projected.os).toBe(ARC_OS);
    expect(projected.osVersion).toBe(ARC_VER);
  });

  it("with Arc gone, the gate's own fingerprint and the directory agree on Linux / 8.10", () => {
    const { projected } = projectAssetFromSources(sources.filter((s) => s.sourceKind !== "arc"));
    expect(projected.os).toBe("Linux");
    expect(projected.osVersion).toBe("8.10");
  });

  it("a FortiGate-only endpoint still takes the gate's fingerprint", () => {
    const { projected } = projectAssetFromSources(sources.filter((s) => s.sourceKind === "fortigate-endpoint"));
    expect(projected.os).toBe("Linux");
    expect(projected.osVersion).toBe("8.10");
  });
});
