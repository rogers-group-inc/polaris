/**
 * tests/unit/fortinetParentKey.test.ts
 *
 * Coverage for the shared Fortinet parent-resolution keys.
 *
 * The bug this module exists for: `fortinetTopology.controllerFortigate` holds
 * FortiManager's DEVICE NAME, while a firewall's `Asset.hostname` is projected
 * from the gate's own configured hostname. Every consumer matched the former
 * against the latter, so on any install where an operator named the FMG device
 * differently, switches/APs had no resolvable parent at all — which is why a
 * FortiGate in a maintenance window left its switches reading "Down" instead of
 * "Dep. Down", and why the Device Map drew that gate with no children.
 */

import { describe, it, expect } from "vitest";

import {
  buildInfraParentIndex,
  controllerGateIdOf,
  resolveInfraParentAsset,
  resolveInfraParentAssetDetailed,
  readControllerStamp,
  readParentSwitchStamp,
  readFirewallDeviceName,
  controllerStampWhereOr,
  controllerIdentityKeys,
  topologyStampWhereOr,
  parentAssetWhereOr,
  normalizeSerialKey,
  normalizeNameKey,
  type InfraParentCandidate,
} from "../../src/utils/fortinetParentKey.js";

/** A firewall whose FMG device name deliberately differs from its hostname —
 *  the prod case. */
function fw(
  id: string,
  opts: { hostname?: string | null; serial?: string | null; deviceName?: string | null } = {},
): InfraParentCandidate {
  return {
    id,
    hostname: opts.hostname ?? null,
    serialNumber: opts.serial ?? null,
    assetType: "firewall",
    fortinetTopology: opts.deviceName ? { role: "fortigate", deviceName: opts.deviceName } : null,
  };
}

describe("normalizeSerialKey / normalizeNameKey", () => {
  it("upper-cases serials and lower-cases names, trimming both", () => {
    expect(normalizeSerialKey("  fg100f1234  ")).toBe("FG100F1234");
    expect(normalizeNameKey("  FG-Edge-01  ")).toBe("fg-edge-01");
  });

  it("maps null / undefined / whitespace to the empty string", () => {
    for (const v of [null, undefined, "   "]) {
      expect(normalizeSerialKey(v)).toBe("");
      expect(normalizeNameKey(v)).toBe("");
    }
  });
});

describe("readControllerStamp / readParentSwitchStamp / readFirewallDeviceName", () => {
  it("reads both controller keys off a child stamp", () => {
    expect(readControllerStamp({ controllerFortigate: "FMG-NAME", controllerSerial: "FG1" }))
      .toEqual({ serial: "FG1", name: "FMG-NAME" });
  });

  it("tolerates a null / non-object / partial topology", () => {
    expect(readControllerStamp(null)).toEqual({});
    expect(readControllerStamp(undefined)).toEqual({});
    expect(readControllerStamp({ controllerFortigate: "X" })).toEqual({ serial: null, name: "X" });
    // Non-string values must not leak through as keys.
    expect(readControllerStamp({ controllerFortigate: 42, controllerSerial: {} }))
      .toEqual({ serial: null, name: null });
  });

  it("reads parentSwitch with no serial companion (the AP's LLDP table has none)", () => {
    expect(readParentSwitchStamp({ parentSwitch: "S248-1" })).toEqual({ serial: null, name: "S248-1" });
  });

  it("reads a firewall's own FMG device name, treating blank as absent", () => {
    expect(readFirewallDeviceName({ deviceName: " FMG-NAME " })).toBe("FMG-NAME");
    expect(readFirewallDeviceName({ deviceName: "   " })).toBeNull();
    expect(readFirewallDeviceName({})).toBeNull();
    expect(readFirewallDeviceName(null)).toBeNull();
  });
});

describe("resolveInfraParentAsset", () => {
  it("resolves on the definitive serial even when every name disagrees", () => {
    // The prod shape: FMG calls the gate "SITE-01-FW", the gate calls itself
    // "fg-edge-01.corp", and the switch stamped the FMG name.
    const index = buildInfraParentIndex([fw("fg1", { hostname: "fg-edge-01.corp", serial: "FG100F0001" })]);
    const hit = resolveInfraParentAsset(index, { serial: "FG100F0001", name: "SITE-01-FW" }, "firewall");
    expect(hit?.id).toBe("fg1");
  });

  it("resolves on the gate's own FMG device-name stamp when no serial is stamped", () => {
    // This is the pre-`controllerSerial` data path — the fix has to work here
    // WITHOUT waiting for a re-discovery, which is the whole point of matching
    // deviceName rather than only the serial.
    const index = buildInfraParentIndex([
      fw("fg1", { hostname: "fg-edge-01.corp", serial: "FG100F0001", deviceName: "SITE-01-FW" }),
    ]);
    const hit = resolveInfraParentAsset(index, { serial: null, name: "SITE-01-FW" }, "firewall");
    expect(hit?.id).toBe("fg1");
  });

  it("still resolves by hostname — the pre-fix behavior is preserved", () => {
    const index = buildInfraParentIndex([fw("fg1", { hostname: "FG-EDGE-01" })]);
    expect(resolveInfraParentAsset(index, { name: "FG-EDGE-01" }, "firewall")?.id).toBe("fg1");
  });

  it("matches case-insensitively in both directions", () => {
    const index = buildInfraParentIndex([
      fw("fg1", { hostname: "FG-Edge-01", serial: "fg100f0001", deviceName: "Site-01-FW" }),
    ]);
    expect(resolveInfraParentAsset(index, { serial: "FG100F0001" }, "firewall")?.id).toBe("fg1");
    expect(resolveInfraParentAsset(index, { name: "fg-edge-01" }, "firewall")?.id).toBe("fg1");
    expect(resolveInfraParentAsset(index, { name: "SITE-01-fw" }, "firewall")?.id).toBe("fg1");
  });

  it("treats a name that is really a serial as a match (a switch-id)", () => {
    // An AP's LLDP table reports its uplink switch's system name, which for a
    // FortiSwitch is the switch-id = the serial, while Asset.hostname may be an
    // operator label.
    const index = buildInfraParentIndex([
      { id: "sw1", hostname: "IDF-2-ACCESS", serialNumber: "S248EPTF0001", assetType: "switch" },
    ]);
    expect(resolveInfraParentAsset(index, { name: "S248EPTF0001" }, "switch")?.id).toBe("sw1");
  });

  it("prefers the serial over a name that points somewhere else", () => {
    const index = buildInfraParentIndex([
      fw("fgA", { hostname: "shared-name", serial: "FG100F000A" }),
      fw("fgB", { hostname: "other", serial: "FG100F000B", deviceName: "shared-name" }),
    ]);
    // Serial wins outright rather than the name landing on fgB.
    expect(resolveInfraParentAsset(index, { serial: "FG100F000A", name: "shared-name" }, "firewall")?.id).toBe("fgA");
  });

  it("returns null when the stamp resolves to the wrong asset type", () => {
    // A switch's controller must be a firewall — never build an edge to
    // whatever else happens to carry that name.
    const index = buildInfraParentIndex([
      { id: "sw1", hostname: "AMBIGUOUS", serialNumber: null, assetType: "switch" },
    ]);
    expect(resolveInfraParentAsset(index, { name: "AMBIGUOUS" }, "firewall")).toBeNull();
  });

  it("returns null for an empty stamp and for an unknown name", () => {
    const index = buildInfraParentIndex([fw("fg1", { hostname: "FG-EDGE-01" })]);
    expect(resolveInfraParentAsset(index, {})).toBeNull();
    expect(resolveInfraParentAsset(index, { name: "  " })).toBeNull();
    expect(resolveInfraParentAsset(index, { name: "NOT-DISCOVERED-YET" }, "firewall")).toBeNull();
  });

  it("accepts any asset type when expectedType is omitted", () => {
    const index = buildInfraParentIndex([
      { id: "sw1", hostname: "ANY", serialNumber: null, assetType: "switch" },
    ]);
    expect(resolveInfraParentAsset(index, { name: "ANY" })?.id).toBe("sw1");
  });
});

describe("buildInfraParentIndex", () => {
  it("first writer wins on a duplicate hostname rather than throwing", () => {
    // Duplicate hostnames genuinely exist — mergeDuplicateHostnameAssets is the
    // job that cleans them up — so the index must be stable, not fatal.
    const index = buildInfraParentIndex([
      fw("first", { hostname: "DUPE" }),
      fw("second", { hostname: "DUPE" }),
    ]);
    expect(index.byHostname.get("dupe")?.id).toBe("first");
  });

  it("skips empty identities instead of indexing the empty string", () => {
    const index = buildInfraParentIndex([fw("fg1", { hostname: "  ", serial: null })]);
    expect(index.byHostname.size).toBe(0);
    expect(index.bySerial.size).toBe(0);
    expect(index.byDeviceName.size).toBe(0);
  });
});

describe("controllerIdentityKeys", () => {
  it("orders serial, device name, hostname and drops blanks + duplicates", () => {
    expect(controllerIdentityKeys({ hostname: "same", serialNumber: "SER", deviceName: "same" }))
      .toEqual(["SER", "same"]);
    expect(controllerIdentityKeys({ hostname: null, serialNumber: undefined, deviceName: "  " }))
      .toEqual([]);
  });
});

describe("controllerStampWhereOr", () => {
  it("emits a branch per distinct identity, serial first", () => {
    expect(controllerStampWhereOr({ hostname: "HOST", serialNumber: "SER", deviceName: "FMG" })).toEqual([
      { fortinetTopology: { path: ["controllerSerial"], equals: "SER" } },
      { fortinetTopology: { path: ["controllerFortigate"], equals: "FMG" } },
      { fortinetTopology: { path: ["controllerFortigate"], equals: "HOST" } },
    ]);
  });

  it("collapses a device name that equals the hostname to one branch", () => {
    expect(controllerStampWhereOr({ hostname: "SAME", deviceName: "SAME" })).toEqual([
      { fortinetTopology: { path: ["controllerFortigate"], equals: "SAME" } },
    ]);
  });

  it("returns empty when the gate exposes no identity", () => {
    // Callers must treat this as "no children" — an `OR: []` would match
    // nothing in a far less obvious way.
    expect(controllerStampWhereOr({})).toEqual([]);
    expect(controllerStampWhereOr({ hostname: null, serialNumber: null, deviceName: null })).toEqual([]);
  });
});

describe("topologyStampWhereOr", () => {
  it("matches one key against several identities, deduped", () => {
    expect(topologyStampWhereOr("parentSwitch", ["IDF-2", "S248EPTF0001"])).toEqual([
      { fortinetTopology: { path: ["parentSwitch"], equals: "IDF-2" } },
      { fortinetTopology: { path: ["parentSwitch"], equals: "S248EPTF0001" } },
    ]);
    expect(topologyStampWhereOr("parentSwitch", ["SAME", "SAME", null, undefined, ""])).toEqual([
      { fortinetTopology: { path: ["parentSwitch"], equals: "SAME" } },
    ]);
  });
});

describe("parentAssetWhereOr", () => {
  it("looks the parent up by serial, its device-name stamp, hostname, and name-as-serial", () => {
    expect(parentAssetWhereOr({ serial: "SER", name: "FMG-NAME" })).toEqual([
      { serialNumber: "SER" },
      { fortinetTopology: { path: ["deviceName"], equals: "FMG-NAME" } },
      { hostname: "FMG-NAME" },
      { serialNumber: "FMG-NAME" },
    ]);
  });

  it("returns empty for a stamp that names nothing", () => {
    expect(parentAssetWhereOr({})).toEqual([]);
    expect(parentAssetWhereOr({ serial: null, name: null })).toEqual([]);
  });
});

// Business rule 91 — a hostname is not an identity. A FortiLink fleet that
// renames its switch-ids per site has an "IDF-1" behind every gate, and the
// name-keyed stamps carry nothing else. The resolver used to hand back the
// first writer; now it picks by the gate the child is known to sit under, and
// refuses to guess when nothing settles it.
describe("resolveInfraParentAsset — shared hostnames (rule 91)", () => {
  const gateA = fw("fgA", { hostname: "SITE-A-FW", serial: "FG100F000A", deviceName: "SITE-A" });
  const gateB = fw("fgB", { hostname: "SITE-B-FW", serial: "FG100F000B", deviceName: "SITE-B" });
  function sw(id: string, serial: string, controllerSerial: string): InfraParentCandidate {
    return {
      id, hostname: "IDF-1", serialNumber: serial, assetType: "switch",
      fortinetTopology: { role: "fortiswitch", controllerSerial },
    };
  }
  const swA = sw("swA", "S248EPTF000A", "FG100F000A");
  const swB = sw("swB", "S248EPTF000B", "FG100F000B");
  const index = () => buildInfraParentIndex([gateA, gateB, swA, swB]);

  it("keeps every same-named candidate in the index, first writer still first", () => {
    const idx = index();
    expect(idx.byHostnameAll.get("idf-1")?.map(c => c.id)).toEqual(["swA", "swB"]);
    expect(idx.byHostname.get("idf-1")?.id).toBe("swA");
  });

  it("returns null, not the first writer, when a shared name has no scope", () => {
    expect(resolveInfraParentAsset(index(), { name: "IDF-1" }, "switch")).toBeNull();
    const detailed = resolveInfraParentAssetDetailed(index(), { name: "IDF-1" }, "switch");
    expect(detailed.hit).toBeNull();
    expect(detailed.ambiguous).toBe(true);
    expect(detailed.candidates.map(c => c.id)).toEqual(["swA", "swB"]);
  });

  it("picks the candidate under the scoped gate — either site", () => {
    expect(resolveInfraParentAsset(index(), { name: "IDF-1" }, "switch", { gateIds: ["fgB"] })?.id).toBe("swB");
    expect(resolveInfraParentAsset(index(), { name: "idf-1" }, "switch", { gateIds: ["fgA"] })?.id).toBe("swA");
  });

  it("walks the gate list in order and takes the first gate that singles one out", () => {
    // A laptop sighted at site B last week and at site A today lists A first.
    expect(resolveInfraParentAsset(index(), { name: "IDF-1" }, "switch", { gateIds: ["fg-unknown", "fgA", "fgB"] })?.id).toBe("swA");
  });

  it("a scope naming neither gate leaves the name ambiguous", () => {
    const r = resolveInfraParentAssetDetailed(index(), { name: "IDF-1" }, "switch", { gateIds: ["fg-elsewhere"] });
    expect(r.hit).toBeNull();
    expect(r.ambiguous).toBe(true);
  });

  it("direct evidence (preferIds) outranks the gate scope", () => {
    // The MAC table of swB holds the device even though the freshest sighting
    // names gate A — the observation wins.
    expect(resolveInfraParentAsset(index(), { name: "IDF-1" }, "switch", { preferIds: ["swB"], gateIds: ["fgA"] })?.id).toBe("swB");
  });

  it("preferIds naming both candidates picks nothing on its own, then the gate decides", () => {
    expect(resolveInfraParentAsset(index(), { name: "IDF-1" }, "switch", { preferIds: ["swA", "swB"], gateIds: ["fgB"] })?.id).toBe("swB");
  });

  it("resolves a shared name by the gate's FMG device-name stamp when the switch has no controllerSerial", () => {
    // Pre-2026-08 rows: the switch stamps only `controllerFortigate`.
    const swOld: InfraParentCandidate = {
      id: "swOld", hostname: "IDF-1", serialNumber: "S248EPTF00LD", assetType: "switch",
      fortinetTopology: { controllerFortigate: "SITE-B" },
    };
    const idx = buildInfraParentIndex([gateA, gateB, swA, swOld]);
    expect(resolveInfraParentAsset(idx, { name: "IDF-1" }, "switch", { gateIds: ["fgB"] })?.id).toBe("swOld");
    expect(controllerGateIdOf(idx, swOld)).toBe("fgB");
    expect(controllerGateIdOf(idx, gateA)).toBeNull();
  });

  it("a workstation ghost carrying the switch's name neither shadows it nor makes it ambiguous", () => {
    const ghost: InfraParentCandidate = { id: "ghost", hostname: "IDF-1", serialNumber: null, assetType: "workstation" };
    const idx = buildInfraParentIndex([gateA, ghost, swA]);
    expect(resolveInfraParentAsset(idx, { name: "IDF-1" }, "switch")?.id).toBe("swA");
  });

  it("the name-as-serial step still settles a shared name", () => {
    // Two switches named after one serial (an operator label collision): the
    // stamp that IS that serial is definitive.
    const idx = buildInfraParentIndex([
      { id: "x", hostname: "S248EPTF0001", serialNumber: "S248EPTF0001", assetType: "switch" },
      { id: "y", hostname: "S248EPTF0001", serialNumber: "S248EPTF0002", assetType: "switch" },
    ]);
    expect(resolveInfraParentAsset(idx, { name: "S248EPTF0001" }, "switch")?.id).toBe("x");
  });

  it("two same-named candidates under ONE gate are refused, not guessed", () => {
    const twin = sw("swA2", "S248EPTF00A2", "FG100F000A");
    const idx = buildInfraParentIndex([gateA, swA, twin]);
    expect(resolveInfraParentAsset(idx, { name: "IDF-1" }, "switch", { gateIds: ["fgA"] })).toBeNull();
  });
});
