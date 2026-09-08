import { describe, it, expect } from "vitest";
import { sweepPhaseEnabled, assetOnlyPostSyncPassesEnabled, cascadeControllerOf, isVouchedManagedDevice, type SyncMode, type ManagedDeviceSightings } from "../../src/services/discovery/discoveryEngine.js";

// The mode→sweep-phase matrix behind syncDhcpSubnets' destructive phases.
// Getting this wrong on a scoped run mass-deprecates subnets (Phase 2) or
// decommissions healthy firewalls (Phase 2a) — knownFirewallSerials is built
// from result.devices (the processed chunks, one device in a scoped run),
// not the raw ADOM roster.

const PHASES = ["2", "2a", "2b", "2c"] as const;

describe("sweepPhaseEnabled — SyncMode × sweep-phase matrix", () => {
  it("finalize-scoped runs ONLY Phase 2b (per-controller switch/AP decommission)", () => {
    expect(sweepPhaseEnabled("finalize-scoped", "2b")).toBe(true);
    expect(sweepPhaseEnabled("finalize-scoped", "2")).toBe(false);
    expect(sweepPhaseEnabled("finalize-scoped", "2a")).toBe(false);
    expect(sweepPhaseEnabled("finalize-scoped", "2c")).toBe(false);
  });

  it("skip-deprecation runs no sweep phase (the per-device pass)", () => {
    for (const phase of PHASES) {
      expect(sweepPhaseEnabled("skip-deprecation", phase)).toBe(false);
    }
  });

  it("full / finalize / deprecation-only run every sweep phase (pre-feature behavior)", () => {
    for (const mode of ["full", "finalize", "deprecation-only"] as SyncMode[]) {
      for (const phase of PHASES) {
        expect(sweepPhaseEnabled(mode, phase)).toBe(true);
      }
    }
  });
});

// Phase 2a controller cascade — a decommissioned FortiGate takes its managed
// FortiSwitches/FortiAPs with it. The matcher must be case-insensitive on the
// controller name (FMG device names vs FortiOS hostnames can disagree in case)
// and must never match a child with no controllerFortigate stamp.
describe("cascadeControllerOf — Phase 2a switch/AP cascade matcher", () => {
  const stale = new Set(["riverbend-101f-1", "glenrose-61f-1"]);

  it("matches a child whose controllerFortigate is a decommissioned gate, returning the stamped name", () => {
    expect(cascadeControllerOf({ controllerFortigate: "RIVERBEND-101F-1" }, stale)).toBe("RIVERBEND-101F-1");
    expect(cascadeControllerOf({ controllerFortigate: "glenrose-61f-1" }, stale)).toBe("glenrose-61f-1");
  });

  it("does not match a child managed by a surviving gate", () => {
    expect(cascadeControllerOf({ controllerFortigate: "SPRINGDALE-61F-1" }, stale)).toBeNull();
  });

  it("does not match when the topology stamp is missing, null, or carries no controller", () => {
    expect(cascadeControllerOf(null, stale)).toBeNull();
    expect(cascadeControllerOf(undefined, stale)).toBeNull();
    expect(cascadeControllerOf({}, stale)).toBeNull();
    expect(cascadeControllerOf({ controllerFortigate: null }, stale)).toBeNull();
    expect(cascadeControllerOf({ controllerFortigate: "" }, stale)).toBeNull();
    expect(cascadeControllerOf({ controllerFortigate: 42 }, stale)).toBeNull();
  });

  it("matches nothing against an empty stale set (no gates decommissioned this run)", () => {
    expect(cascadeControllerOf({ controllerFortigate: "RIVERBEND-101F-1" }, new Set())).toBeNull();
  });
});

// Phase 2b sighting decision — serial is authoritative when the asset has one
// on file. The regression this pins: a replaced (RMA'd) switch/AP keeps the
// old unit's hostname, and the former `seenBySerial || seenByHostname` OR let
// the replacement's live hostname sighting vouch for the dead serial's asset
// forever (prod 2026-08: three RIVERBEND-112F-7 switch assets, distinct
// serials, only one still on the gate — the stale two never decommissioned).
describe("isVouchedManagedDevice — Phase 2b stale switch/AP sighting decision", () => {
  const sightings = (over: Partial<ManagedDeviceSightings> = {}): ManagedDeviceSightings => ({
    seenSerials: new Set(),
    seenHostnamesByController: new Map(),
    cmdbSerialsByController: new Map(),
    ...over,
  });

  it("vouches for a serial seen in the live monitor query", () => {
    const s = sightings({ seenSerials: new Set(["SR12FPTY26000001"]) });
    expect(isVouchedManagedDevice({ serialNumber: "SR12FPTY26000001", hostname: "RIVERBEND-112F-7" }, "RIVERBEND-112F-1", s)).toBe(true);
  });

  it("does NOT let a same-hostname sighting vouch for a different serial (replaced-unit regression)", () => {
    // The replacement unit is live under the same hostname; the old serial is gone.
    const s = sightings({
      seenSerials: new Set(["SR12FPTY26000001"]),
      seenHostnamesByController: new Map([["riverbend-112f-1", new Set(["RIVERBEND-112F-7"])]]),
    });
    expect(isVouchedManagedDevice({ serialNumber: "SR12FPTY25000002", hostname: "RIVERBEND-112F-7" }, "RIVERBEND-112F-1", s)).toBe(false);
  });

  it("vouches via the OWN controller's CMDB roster (configured-but-offline protection)", () => {
    const s = sightings({ cmdbSerialsByController: new Map([["riverbend-112f-1", new Set(["SR12FPTY25000001"])]]) });
    expect(isVouchedManagedDevice({ serialNumber: "SR12FPTY25000001", hostname: null }, "RIVERBEND-112F-1", s)).toBe(true);
  });

  it("ignores ANOTHER controller's CMDB roster (staged/offline gate must not vouch fleet-wide)", () => {
    const s = sightings({ cmdbSerialsByController: new Map([["riverbend-201g-1", new Set(["SR12FPTY25000001"])]]) });
    expect(isVouchedManagedDevice({ serialNumber: "SR12FPTY25000001", hostname: null }, "RIVERBEND-112F-1", s)).toBe(false);
  });

  it("falls back to hostname ONLY when no serial is on file, scoped to the own controller, case-insensitive on the controller", () => {
    const s = sightings({ seenHostnamesByController: new Map([["riverbend-112f-1", new Set(["RIVERBEND-112F-7"])]]) });
    expect(isVouchedManagedDevice({ serialNumber: null, hostname: "RIVERBEND-112F-7" }, "Riverbend-112F-1", s)).toBe(true);
    // Same hostname sighted behind a different gate does not vouch.
    expect(isVouchedManagedDevice({ serialNumber: null, hostname: "RIVERBEND-112F-7" }, "GLENROSE-61F-1", s)).toBe(false);
  });

  it("does not vouch for a serial-less, hostname-less asset (decommission proceeds)", () => {
    const s = sightings({ seenHostnamesByController: new Map([["riverbend-112f-1", new Set(["RIVERBEND-112F-7"])]]) });
    expect(isVouchedManagedDevice({ serialNumber: null, hostname: null }, "RIVERBEND-112F-1", s)).toBe(false);
  });
});

// The asset-only (Entra / AD / vCenter / Arc) post-sync passes: agent
// auto-deploy, interface+storage auto-monitor, presence verification, GAL sync.
// All four read the DB fleet-wide rather than the run's result, so a SCOPED
// single-device run must skip them. Auto-deploy is the expensive one to get
// wrong — a scoped run that ran it would start agent installs across every
// agent-less device in the fleet because one operator clicked Discover Now on
// one workstation.
describe("assetOnlyPostSyncPassesEnabled", () => {
  it("runs the passes on a full, un-aborted asset-only run", () => {
    expect(assetOnlyPostSyncPassesEnabled({ assetsOnly: true, scoped: false, aborted: false })).toBe(true);
  });

  it("SKIPS every pass on a scoped run", () => {
    expect(assetOnlyPostSyncPassesEnabled({ assetsOnly: true, scoped: true, aborted: false })).toBe(false);
  });

  it("skips on an aborted run, scoped or not", () => {
    expect(assetOnlyPostSyncPassesEnabled({ assetsOnly: true, scoped: false, aborted: true })).toBe(false);
    expect(assetOnlyPostSyncPassesEnabled({ assetsOnly: true, scoped: true, aborted: true })).toBe(false);
  });

  it("never runs for a non-asset-only (Fortinet) integration", () => {
    for (const scoped of [false, true]) {
      for (const aborted of [false, true]) {
        expect(assetOnlyPostSyncPassesEnabled({ assetsOnly: false, scoped, aborted })).toBe(false);
      }
    }
  });
});
