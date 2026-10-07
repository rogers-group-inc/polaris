/**
 * tests/unit/monitorOverrideService.test.ts
 *
 * Pure-logic coverage for the convergent monitor-override model:
 *  - getAddAsMonitoredFromConfig — JSON-path read of per-class addAsMonitored,
 *    gated by integration type ↔ asset-class compatibility.
 *  - computeMonitorOverride / resolveMonitorOverride — override is set exactly
 *    when the operator's `monitored` choice diverges from the integration flag.
 *  - classBlockKeyForAssetType — assetType → config block-key mapping.
 *  - buildMonitoredSweep — discovery-side add/remove decision (operator wins).
 *  - AUTO_MONITOR_ASSET_TYPES — the five participating classes.
 *
 * The DB-touching helpers (recomputeMonitorOverrideForAssets,
 * sweepMonitoredForIntegration) are integration territory and are not
 * exercised here. `monitorOverride` is now an explicit operator-intent bit:
 * recompute runs ONLY from operator write paths (the bit is never re-derived
 * from incidental divergence by a boot job or integration save), but that
 * wiring is route-level and out of scope for these pure-logic tests.
 */

import { describe, it, expect } from "vitest";

import {
  getAddAsMonitoredFromConfig,
  computeMonitorOverride,
  resolveMonitorOverride,
  classBlockKeyForAssetType,
  snapshotAddAsMonitoredByAssetType,
  buildMonitoredSweep,
  AUTO_MONITOR_ASSET_TYPES,
  type AddAsMonitoredAssetType,
} from "../../src/services/monitorOverrideService.js";

// Convenient config builders ------------------------------------------------

const cfg = (block: string, addAsMonitored: unknown): Record<string, unknown> => ({
  [block]: { addAsMonitored },
});

describe("getAddAsMonitoredFromConfig — per-class flag read + type gating", () => {
  it("reads the fortigateMonitor block for firewall on a fortimanager integration", () => {
    expect(
      getAddAsMonitoredFromConfig("fortimanager", cfg("fortigateMonitor", true), "firewall"),
    ).toBe(true);
  });

  it("reads the fortigateMonitor block for firewall on a standalone fortigate integration", () => {
    expect(
      getAddAsMonitoredFromConfig("fortigate", cfg("fortigateMonitor", true), "firewall"),
    ).toBe(true);
  });

  it("maps switch → fortiswitchMonitor", () => {
    expect(
      getAddAsMonitoredFromConfig("fortimanager", cfg("fortiswitchMonitor", true), "switch"),
    ).toBe(true);
  });

  it("maps access_point → fortiapMonitor", () => {
    expect(
      getAddAsMonitoredFromConfig("fortigate", cfg("fortiapMonitor", true), "access_point"),
    ).toBe(true);
  });

  it("maps workstation → workstationMonitor on a directory integration", () => {
    expect(
      getAddAsMonitoredFromConfig("activedirectory", cfg("workstationMonitor", true), "workstation"),
    ).toBe(true);
    expect(
      getAddAsMonitoredFromConfig("entraid", cfg("workstationMonitor", true), "workstation"),
    ).toBe(true);
    expect(
      getAddAsMonitoredFromConfig("windowsserver", cfg("workstationMonitor", true), "workstation"),
    ).toBe(true);
  });

  it("maps server → serverMonitor on a directory integration", () => {
    expect(
      getAddAsMonitoredFromConfig("windowsserver", cfg("serverMonitor", true), "server"),
    ).toBe(true);
  });

  it("maps server → vmMonitor on a vcenter integration (VMs are typed server)", () => {
    expect(
      getAddAsMonitoredFromConfig("vcenter", cfg("vmMonitor", true), "server"),
    ).toBe(true);
    // The directory block on a vcenter integration is ignored for servers.
    expect(
      getAddAsMonitoredFromConfig("vcenter", cfg("serverMonitor", true), "server"),
    ).toBe(false);
  });

  it("maps hypervisor → hostMonitor on a vcenter integration only", () => {
    expect(
      getAddAsMonitoredFromConfig("vcenter", cfg("hostMonitor", true), "hypervisor"),
    ).toBe(true);
    expect(
      getAddAsMonitoredFromConfig("activedirectory", cfg("hostMonitor", true), "hypervisor"),
    ).toBeNull();
  });

  it("returns false when the per-class block is missing", () => {
    expect(getAddAsMonitoredFromConfig("fortimanager", {}, "firewall")).toBe(false);
  });

  it("returns false when addAsMonitored is absent inside an existing block", () => {
    expect(
      getAddAsMonitoredFromConfig("fortimanager", { fortigateMonitor: {} }, "firewall"),
    ).toBe(false);
  });

  it("treats any non-true addAsMonitored value as false (strict === true)", () => {
    expect(getAddAsMonitoredFromConfig("fortimanager", cfg("fortigateMonitor", false), "firewall")).toBe(false);
    expect(getAddAsMonitoredFromConfig("fortimanager", cfg("fortigateMonitor", "true"), "firewall")).toBe(false);
    expect(getAddAsMonitoredFromConfig("fortimanager", cfg("fortigateMonitor", 1), "firewall")).toBe(false);
    expect(getAddAsMonitoredFromConfig("fortimanager", cfg("fortigateMonitor", null), "firewall")).toBe(false);
  });

  it("returns false when the block exists but is not an object", () => {
    expect(
      getAddAsMonitoredFromConfig("fortimanager", { fortigateMonitor: "nope" }, "firewall"),
    ).toBe(false);
  });

  // --- type/integration incompatibility → null (override doesn't apply) ---

  it("returns null when a fortinet class is read against a directory integration", () => {
    expect(getAddAsMonitoredFromConfig("activedirectory", cfg("fortigateMonitor", true), "firewall")).toBeNull();
    expect(getAddAsMonitoredFromConfig("entraid", cfg("fortiswitchMonitor", true), "switch")).toBeNull();
    expect(getAddAsMonitoredFromConfig("windowsserver", cfg("fortiapMonitor", true), "access_point")).toBeNull();
  });

  it("returns null when a directory class is read against a fortinet integration", () => {
    expect(getAddAsMonitoredFromConfig("fortimanager", cfg("workstationMonitor", true), "workstation")).toBeNull();
    expect(getAddAsMonitoredFromConfig("fortigate", cfg("serverMonitor", true), "server")).toBeNull();
  });

  it("returns null for an asset type outside the five participating classes", () => {
    expect(getAddAsMonitoredFromConfig("fortimanager", cfg("fortigateMonitor", true), "printer")).toBeNull();
    expect(getAddAsMonitoredFromConfig("fortimanager", cfg("fortigateMonitor", true), "other")).toBeNull();
  });

  it("returns null when integration type / config / assetType are nullish (manual asset)", () => {
    expect(getAddAsMonitoredFromConfig(null, cfg("fortigateMonitor", true), "firewall")).toBeNull();
    expect(getAddAsMonitoredFromConfig("fortimanager", null, "firewall")).toBeNull();
    expect(getAddAsMonitoredFromConfig("fortimanager", cfg("fortigateMonitor", true), null)).toBeNull();
    expect(getAddAsMonitoredFromConfig(undefined, undefined, undefined)).toBeNull();
  });
});

describe("computeMonitorOverride — divergence rule", () => {
  it("returns false when addAsMonitored is null (no per-class block → no override)", () => {
    expect(computeMonitorOverride(true, null)).toBe(false);
    expect(computeMonitorOverride(false, null)).toBe(false);
  });

  it("no override when operator choice matches the flag (converged)", () => {
    expect(computeMonitorOverride(true, true)).toBe(false);
    expect(computeMonitorOverride(false, false)).toBe(false);
  });

  it("override set when operator choice diverges from the flag", () => {
    // flag says auto-monitor ON but operator turned it OFF
    expect(computeMonitorOverride(false, true)).toBe(true);
    // flag says auto-monitor OFF but operator turned it ON
    expect(computeMonitorOverride(true, false)).toBe(true);
  });
});

describe("resolveMonitorOverride — config-aware convenience wrapper", () => {
  it("override true when monitored diverges from a resolved ON flag", () => {
    expect(
      resolveMonitorOverride({
        monitored: false,
        assetType: "firewall",
        integrationType: "fortimanager",
        integrationConfig: cfg("fortigateMonitor", true),
      }),
    ).toBe(true);
  });

  it("override false when monitored converges with the resolved flag", () => {
    expect(
      resolveMonitorOverride({
        monitored: true,
        assetType: "firewall",
        integrationType: "fortimanager",
        integrationConfig: cfg("fortigateMonitor", true),
      }),
    ).toBe(false);
  });

  it("override false when the flag resolves to null (incompatible class/type)", () => {
    // directory integration can't carry a firewall flag → null → no override
    expect(
      resolveMonitorOverride({
        monitored: true,
        assetType: "firewall",
        integrationType: "activedirectory",
        integrationConfig: cfg("fortigateMonitor", true),
      }),
    ).toBe(false);
  });

  it("override false for a manually-created asset (no integration)", () => {
    expect(
      resolveMonitorOverride({
        monitored: true,
        assetType: "firewall",
        integrationType: null,
        integrationConfig: null,
      }),
    ).toBe(false);
  });

  it("override true when operator keeps a device monitored but the flag is OFF", () => {
    expect(
      resolveMonitorOverride({
        monitored: true,
        assetType: "server",
        integrationType: "windowsserver",
        integrationConfig: cfg("serverMonitor", false),
      }),
    ).toBe(true);
  });
});

describe("classBlockKeyForAssetType — assetType → config block key", () => {
  it("maps each of the participating classes", () => {
    expect(classBlockKeyForAssetType("firewall")).toBe("fortigateMonitor");
    expect(classBlockKeyForAssetType("switch")).toBe("fortiswitchMonitor");
    expect(classBlockKeyForAssetType("access_point")).toBe("fortiapMonitor");
    expect(classBlockKeyForAssetType("workstation")).toBe("workstationMonitor");
    expect(classBlockKeyForAssetType("server")).toBe("serverMonitor");
    expect(classBlockKeyForAssetType("hypervisor")).toBe("hostMonitor");
  });

  it("server is integration-type-dependent: vcenter → vmMonitor, else serverMonitor", () => {
    expect(classBlockKeyForAssetType("server", "vcenter")).toBe("vmMonitor");
    expect(classBlockKeyForAssetType("server", "windowsserver")).toBe("serverMonitor");
    expect(classBlockKeyForAssetType("server", null)).toBe("serverMonitor");
    // Azure Arc must land on the DIRECTORY branch, not vmMonitor — it reuses
    // the workstationMonitor / serverMonitor block names verbatim, which is
    // what lets the raw-SQL sweeps resolve it with no extra CASE arm.
    expect(classBlockKeyForAssetType("server", "azurearc")).toBe("serverMonitor");
    expect(classBlockKeyForAssetType("workstation", "azurearc")).toBe("workstationMonitor");
  });

  it("maps kubernetes_cluster to k8sMonitor, on Azure Arc only", () => {
    // The one Arc class that is NOT workstation/server shaped, and therefore
    // the only one that needed its own block key + raw-SQL CASE arm.
    expect(classBlockKeyForAssetType("kubernetes_cluster", "azurearc")).toBe("k8sMonitor");
    expect(getAddAsMonitoredFromConfig("azurearc", cfg("k8sMonitor", true), "kubernetes_cluster")).toBe(true);
    // No other integration type owns connected clusters.
    expect(getAddAsMonitoredFromConfig("vcenter", cfg("k8sMonitor", true), "kubernetes_cluster")).toBeNull();
    expect(getAddAsMonitoredFromConfig("entraid", cfg("k8sMonitor", true), "kubernetes_cluster")).toBeNull();
  });

  it("includes kubernetes_cluster in the auto-monitor asset-type set", () => {
    expect(AUTO_MONITOR_ASSET_TYPES.has("kubernetes_cluster")).toBe(true);
  });

  it("maps the Unraid / TrueNAS classes onto vCenter's block names plus containerMonitor", () => {
    for (const t of ["unraid", "truenas"]) {
      expect(classBlockKeyForAssetType("server", t)).toBe("vmMonitor");
      expect(classBlockKeyForAssetType("hypervisor", t)).toBe("hostMonitor");
      expect(classBlockKeyForAssetType("container", t)).toBe("containerMonitor");
      expect(getAddAsMonitoredFromConfig(t, cfg("vmMonitor", true), "server")).toBe(true);
      expect(getAddAsMonitoredFromConfig(t, cfg("hostMonitor", true), "hypervisor")).toBe(true);
      expect(getAddAsMonitoredFromConfig(t, cfg("containerMonitor", true), "container")).toBe(true);
      expect(getAddAsMonitoredFromConfig(t, {}, "container")).toBe(false);
    }
    // Only the two workload integrations own containers.
    expect(getAddAsMonitoredFromConfig("vcenter", cfg("containerMonitor", true), "container")).toBeNull();
    expect(getAddAsMonitoredFromConfig("azurearc", cfg("containerMonitor", true), "container")).toBeNull();
  });

  it("reads the directory class blocks on an azurearc integration", () => {
    expect(getAddAsMonitoredFromConfig("azurearc", cfg("workstationMonitor", true), "workstation")).toBe(true);
    expect(getAddAsMonitoredFromConfig("azurearc", cfg("serverMonitor", true), "server")).toBe(true);
    // Arc owns no hypervisor class.
    expect(getAddAsMonitoredFromConfig("azurearc", cfg("hostMonitor", true), "hypervisor")).toBeNull();
  });

  it("returns null for non-participating / nullish asset types", () => {
    expect(classBlockKeyForAssetType("printer")).toBeNull();
    expect(classBlockKeyForAssetType("router")).toBeNull();
    expect(classBlockKeyForAssetType("other")).toBeNull();
    expect(classBlockKeyForAssetType(null)).toBeNull();
    expect(classBlockKeyForAssetType(undefined)).toBeNull();
  });
});

describe("AUTO_MONITOR_ASSET_TYPES — the eight participating classes", () => {
  it("contains exactly firewall/switch/access_point/workstation/server/hypervisor/kubernetes_cluster/container", () => {
    expect([...AUTO_MONITOR_ASSET_TYPES].sort()).toEqual(
      ["access_point", "container", "firewall", "hypervisor", "kubernetes_cluster", "server", "switch", "workstation"],
    );
  });

  it("a class is in the set iff it maps to a block key", () => {
    const classes: AddAsMonitoredAssetType[] = [
      "firewall",
      "switch",
      "access_point",
      "workstation",
      "server",
      "hypervisor",
      "kubernetes_cluster",
      "container",
    ];
    for (const c of classes) {
      expect(AUTO_MONITOR_ASSET_TYPES.has(c)).toBe(true);
      expect(classBlockKeyForAssetType(c)).not.toBeNull();
    }
    expect(AUTO_MONITOR_ASSET_TYPES.has("printer" as AddAsMonitoredAssetType)).toBe(false);
  });
});

describe("snapshotAddAsMonitoredByAssetType — per-class flag snapshot", () => {
  it("resolves all five fortinet/directory flags for a fortinet integration (directory classes null)", () => {
    const snap = snapshotAddAsMonitoredByAssetType("fortimanager", {
      fortigateMonitor: { addAsMonitored: true },
      fortiswitchMonitor: { addAsMonitored: false },
      // fortiapMonitor absent → false
    });
    expect(snap.firewall).toBe(true);
    expect(snap.switch).toBe(false);
    expect(snap.access_point).toBe(false);
    // workstation/server blocks don't apply to a fortinet integration → null
    expect(snap.workstation).toBeNull();
    expect(snap.server).toBeNull();
  });

  it("resolves directory classes for a directory integration (fortinet classes null)", () => {
    const snap = snapshotAddAsMonitoredByAssetType("activedirectory", {
      workstationMonitor: { addAsMonitored: true },
      serverMonitor: { addAsMonitored: false },
    });
    expect(snap.workstation).toBe(true);
    expect(snap.server).toBe(false);
    expect(snap.firewall).toBeNull();
    expect(snap.switch).toBeNull();
    expect(snap.access_point).toBeNull();
  });

  it("resolves the vcenter classes: server → vmMonitor, hypervisor → hostMonitor", () => {
    const snap = snapshotAddAsMonitoredByAssetType("vcenter", {
      vmMonitor: { addAsMonitored: true },
      hostMonitor: { addAsMonitored: false },
    });
    expect(snap.server).toBe(true);
    expect(snap.hypervisor).toBe(false);
    expect(snap.workstation).toBeNull();
    expect(snap.firewall).toBeNull();
  });
});

describe("buildMonitoredSweep — discovery add/remove decision", () => {
  it("no-op when addAsMonitored is null (asset type not subject to sweep)", () => {
    expect(buildMonitoredSweep(null, { monitored: true, monitorOverride: false })).toEqual({});
    expect(buildMonitoredSweep(null, { monitored: false, monitorOverride: false })).toEqual({});
  });

  it("no-op when the operator override is set — operator wins, regardless of flag", () => {
    expect(buildMonitoredSweep(true, { monitored: false, monitorOverride: true })).toEqual({});
    expect(buildMonitoredSweep(false, { monitored: true, monitorOverride: true })).toEqual({});
  });

  it("flips monitored ON when the flag is ON and the asset isn't monitored", () => {
    expect(buildMonitoredSweep(true, { monitored: false, monitorOverride: false })).toEqual({ monitored: true });
    expect(buildMonitoredSweep(true, { monitored: null, monitorOverride: false })).toEqual({ monitored: true });
  });

  it("flips monitored OFF when the flag is OFF and the asset is monitored", () => {
    expect(buildMonitoredSweep(false, { monitored: true, monitorOverride: false })).toEqual({ monitored: false });
  });

  it("no-op when already converged (flag ON + monitored, flag OFF + not monitored)", () => {
    expect(buildMonitoredSweep(true, { monitored: true, monitorOverride: false })).toEqual({});
    expect(buildMonitoredSweep(false, { monitored: false, monitorOverride: false })).toEqual({});
    expect(buildMonitoredSweep(false, { monitored: null, monitorOverride: false })).toEqual({});
  });

  it("treats missing monitored/monitorOverride as falsy", () => {
    // no fields → monitorOverride falsy, monitored falsy
    expect(buildMonitoredSweep(true, {})).toEqual({ monitored: true });
    expect(buildMonitoredSweep(false, {})).toEqual({});
  });

  it("override flag overrides take priority over the null short-circuit ordering", () => {
    // null wins over override: type-not-subject check comes first
    expect(buildMonitoredSweep(null, { monitored: false, monitorOverride: true })).toEqual({});
  });
});
