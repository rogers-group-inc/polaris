/**
 * tests/unit/assetSourceState.test.ts
 *
 * The account-disagreement call-out is the Sources tab's
 * _assetSourceAccountStatesDisagree — tested in assetsSources.accountDisagreement.test.ts.
 */

import { describe, it, expect } from "vitest";
import { deriveAssetSourceState } from "../../src/utils/assetSourceState.js";

describe("deriveAssetSourceState — directory sources", () => {
  it("reads Entra's accountEnabled straight", () => {
    expect(deriveAssetSourceState("entra", { accountEnabled: true })).toEqual({
      state: "enabled", kind: "account", label: "Enabled", field: "accountEnabled", value: "true",
    });
    expect(deriveAssetSourceState("entra", { accountEnabled: false })).toMatchObject({
      state: "disabled", kind: "account", label: "Disabled",
    });
  });

  it("inverts AD's accountDisabled", () => {
    expect(deriveAssetSourceState("ad", { accountDisabled: true })).toMatchObject({
      state: "disabled", kind: "account", label: "Disabled", field: "accountDisabled",
    });
    expect(deriveAssetSourceState("ad", { accountDisabled: false })).toMatchObject({
      state: "enabled", kind: "account", label: "Enabled",
    });
  });

  it("does not guess when the account field is absent or non-boolean", () => {
    expect(deriveAssetSourceState("entra", { displayName: "PC-1" }).state).toBe("unknown");
    expect(deriveAssetSourceState("entra", { accountEnabled: "true" }).state).toBe("unknown");
    expect(deriveAssetSourceState("ad", { accountDisabled: null }).state).toBe("unknown");
  });

  it("reports nothing for Intune, which has no lifecycle field", () => {
    expect(deriveAssetSourceState("intune", { complianceState: "compliant" })).toMatchObject({
      state: "unknown", kind: "none", label: "State not reported", field: null,
    });
  });
});

describe("deriveAssetSourceState — vCenter", () => {
  it("maps VM power state, counting suspended as not-enabled", () => {
    expect(deriveAssetSourceState("vcenter-vm", { powerState: "POWERED_ON" })).toMatchObject({
      state: "enabled", kind: "runtime", label: "Powered on",
    });
    expect(deriveAssetSourceState("vcenter-vm", { powerState: "POWERED_OFF" })).toMatchObject({
      state: "disabled", label: "Powered off",
    });
    expect(deriveAssetSourceState("vcenter-vm", { powerState: "SUSPENDED" })).toMatchObject({
      state: "disabled", label: "Suspended",
    });
    expect(deriveAssetSourceState("vcenter-vm", { powerState: "" }).state).toBe("unknown");
  });

  it("prefers a host's connectionState over its power state", () => {
    expect(
      deriveAssetSourceState("vcenter-host", { connectionState: "DISCONNECTED", powerState: "POWERED_ON" }),
    ).toMatchObject({ state: "disabled", label: "Disconnected", field: "connectionState" });
    expect(deriveAssetSourceState("vcenter-host", { connectionState: "NOT_RESPONDING" })).toMatchObject({
      state: "disabled", label: "Not responding",
    });
  });

  it("falls back to a host's power state when connectionState is absent", () => {
    expect(deriveAssetSourceState("vcenter-host", { powerState: "STANDBY" })).toMatchObject({
      state: "disabled", label: "Standby", field: "powerState",
    });
    expect(deriveAssetSourceState("vcenter-host", { powerState: "POWERED_ON" })).toMatchObject({
      state: "enabled", label: "Powered on",
    });
  });
});

describe("deriveAssetSourceState — Fortinet", () => {
  it("reads the FortiSwitch connected flag", () => {
    expect(deriveAssetSourceState("fortiswitch", { connected: true })).toMatchObject({
      state: "enabled", kind: "runtime", label: "Connected",
    });
    expect(deriveAssetSourceState("fortiswitch", { connected: false })).toMatchObject({
      state: "disabled", label: "Disconnected",
    });
    // `connected` is nulled out when the CMDB row didn't carry the field.
    expect(deriveAssetSourceState("fortiswitch", { connected: null, state: "authorized" }).state).toBe("unknown");
  });

  it("accepts both FortiAP online vocabularies and leaves admission states unjudged", () => {
    expect(deriveAssetSourceState("fortiap", { status: "online" }).state).toBe("enabled");
    expect(deriveAssetSourceState("fortiap", { status: "Connected" }).state).toBe("enabled");
    expect(deriveAssetSourceState("fortiap", { status: "offline" })).toMatchObject({
      state: "disabled", label: "Offline",
    });
    // "discovered" is an admission state, not an up/down statement.
    expect(deriveAssetSourceState("fortiap", { status: "discovered" }).state).toBe("unknown");
    expect(deriveAssetSourceState("fortiap", { status: "" }).state).toBe("unknown");
  });

  it("treats endpoint sightings as presence evidence, not a lifecycle statement", () => {
    expect(deriveAssetSourceState("fortigate-endpoint", { mac: "AA:BB:CC:DD:EE:FF" }).state).toBe("unknown");
    expect(deriveAssetSourceState("fortigate-firewall", { serial: "FG100F0000" }).state).toBe("unknown");
  });
});

describe("deriveAssetSourceState — malformed input", () => {
  it("never throws on a missing, null, array or scalar observed blob", () => {
    for (const bad of [undefined, null, [], "nope", 42]) {
      expect(deriveAssetSourceState("entra", bad).state).toBe("unknown");
    }
  });

  it("returns not-reported for an unknown source kind", () => {
    expect(deriveAssetSourceState("some-future-source", { accountEnabled: false }).state).toBe("unknown");
  });
});

describe("deriveAssetSourceState — Azure Arc", () => {
  it("reads a machine's connectivity as a RUNTIME state, not an account one", () => {
    // A Disconnected Arc agent is a reachability fact; unlike a
    // directory-disabled account it never decommissions the asset, so it must
    // not be compared as an "account" reading.
    const r = deriveAssetSourceState("arc", { status: "Connected" });
    expect(r.state).toBe("enabled");
    expect(r.kind).toBe("runtime");
    expect(r.field).toBe("status");
  });

  it("maps Disconnected and Expired to disabled", () => {
    expect(deriveAssetSourceState("arc", { status: "Disconnected" }).state).toBe("disabled");
    expect(deriveAssetSourceState("arc", { status: "Expired" }).state).toBe("disabled");
  });

  it("reads a connected cluster from connectivityStatus", () => {
    const r = deriveAssetSourceState("arc-k8s", { connectivityStatus: "Connected" });
    expect(r.state).toBe("enabled");
    expect(r.kind).toBe("runtime");
    expect(deriveAssetSourceState("arc-k8s", { connectivityStatus: "Offline" }).state).toBe("disabled");
  });

  it("reports nothing for an unrecognized or absent status", () => {
    expect(deriveAssetSourceState("arc", { status: "Connecting" }).state).toBe("unknown");
    expect(deriveAssetSourceState("arc", {}).state).toBe("unknown");
  });
});
