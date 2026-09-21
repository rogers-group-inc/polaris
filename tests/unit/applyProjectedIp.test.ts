/**
 * tests/unit/applyProjectedIp.test.ts
 *
 * Discovery removing an address it can no longer find (business rule 81).
 *
 * Every discovery update path used to blank-fill the IP — `if (projected
 * !== null) write` — which can add or change an address but never take one
 * away. A device re-addressed into another VLAN, a VM whose NIC was pulled,
 * a firewall whose management interface was renumbered: discovery reads it,
 * finds no address, and the asset shows the old one forever. Everything
 * downstream treats that column as fact, so the stale value is worse than
 * nothing — Polaris probes it, charts it and matches it into a subnet.
 *
 * The danger in fixing it is the reason this function takes `readThisRun` as
 * a required argument, and it is what most of this file tests: a null
 * projection means BOTH "the device has no address" and "we never got to
 * ask". Treating the second as the first empties the address off a whole
 * fleet the first time an upstream goes quiet, and every probe afterwards
 * fails with "Asset has no IP address". A wrongly-kept address is a stale
 * row someone can correct; a wrongly-stripped one is an outage.
 */

import { describe, it, expect } from "vitest";
import { applyProjectedIp } from "../../src/utils/assetProjection.js";

describe("applyProjectedIp — an address that was found", () => {
  it("writes the address and its provenance", () => {
    const data: Record<string, unknown> = {};
    applyProjectedIp(data, "10.1.2.3", { readThisRun: true, ipSource: "fgt-branch-01" });
    expect(data).toEqual({ ipAddress: "10.1.2.3", ipSource: "fgt-branch-01" });
  });

  it("writes the address even when the device was not read this run", () => {
    // `readThisRun` gates the STRIP, never the write. A cached roster that
    // still carries an address is better evidence than nothing, and this is
    // exactly the pre-existing blank-fill behaviour, unchanged.
    const data: Record<string, unknown> = {};
    applyProjectedIp(data, "10.1.2.3", { readThisRun: false, ipSource: "fgt-branch-01" });
    expect(data).toEqual({ ipAddress: "10.1.2.3", ipSource: "fgt-branch-01" });
  });

  it("leaves ipSource alone when the caller does not supply one", () => {
    // The vCenter and Arc call sites pass no provenance — the existing column
    // value is theirs to keep, and writing `undefined` would be a change.
    const data: Record<string, unknown> = {};
    applyProjectedIp(data, "10.1.2.3", { readThisRun: true });
    expect(data).toEqual({ ipAddress: "10.1.2.3" });
    expect("ipSource" in data).toBe(false);
  });
});

describe("applyProjectedIp — the device was read and has no address", () => {
  it("STRIPS the address, which is the whole point of the rule", () => {
    const data: Record<string, unknown> = {};
    applyProjectedIp(data, null, { readThisRun: true, ipSource: "fgt-branch-01" });
    expect(data).toEqual({ ipAddress: null, ipSource: null });
  });

  it("clears ipSource with it, so no provenance is left claiming a gone value", () => {
    // A row reading `ipAddress: null, ipSource: "fortimanager"` says
    // FortiManager told us this device has no address, which is not what
    // happened and is rendered on the Sources tab.
    const data: Record<string, unknown> = {};
    applyProjectedIp(data, null, { readThisRun: true, ipSource: "fortimanager" });
    expect(data.ipSource).toBeNull();
  });

  it("strips even when the caller supplied no ipSource", () => {
    const data: Record<string, unknown> = {};
    applyProjectedIp(data, null, { readThisRun: true });
    expect(data).toEqual({ ipAddress: null, ipSource: null });
  });
});

describe("applyProjectedIp — the device was NOT read", () => {
  it("writes NOTHING, so the stored address survives", () => {
    // The offline FortiGate / disconnected ESXi host / Tools-less VM / Arc
    // integration with fetchNetworkProfile off. Staging nothing is what
    // leaves the column untouched — staging null would erase it.
    const data: Record<string, unknown> = {};
    applyProjectedIp(data, null, { readThisRun: false, ipSource: "fgt-branch-01" });
    expect(data).toEqual({});
    expect("ipAddress" in data).toBe(false);
    expect("ipSource" in data).toBe(false);
  });

  it("does not disturb other staged fields", () => {
    const data: Record<string, unknown> = { hostname: "sw-01", model: "FortiSwitch 148F" };
    applyProjectedIp(data, null, { readThisRun: false });
    expect(data).toEqual({ hostname: "sw-01", model: "FortiSwitch 148F" });
  });
});

describe("applyProjectedIp — the fleet-wide failure this guards against", () => {
  it("an upstream that goes quiet for every device strips none of them", () => {
    // One FortiManager hiccup, 200 gates in the roster, every one reported
    // offline-with-no-address. Before the guard this pass would have emptied
    // the address off all 200 and taken monitoring down with it.
    const fleet = Array.from({ length: 200 }, (_, i) => ({
      id: `asset-${i}`,
      data: {} as Record<string, unknown>,
    }));
    for (const a of fleet) {
      applyProjectedIp(a.data, null, { readThisRun: false, ipSource: "fortimanager" });
    }
    expect(fleet.every((a) => Object.keys(a.data).length === 0)).toBe(true);
  });

  it("…while the same fleet READ and genuinely addressless is stripped", () => {
    // The mirror case, so the guard cannot be satisfied by never stripping.
    const fleet = Array.from({ length: 200 }, () => ({}) as Record<string, unknown>);
    for (const data of fleet) {
      applyProjectedIp(data, null, { readThisRun: true, ipSource: "fortimanager" });
    }
    expect(fleet.every((d) => d.ipAddress === null && d.ipSource === null)).toBe(true);
  });
});
