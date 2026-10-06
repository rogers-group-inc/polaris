import { describe, it, expect } from "vitest";
import { judgeRosterFirewall, type RosterFirewallContext } from "../../src/services/discovery/discoveryEngine.js";

// Business rule 41(a): FortiManager's serial swap keeps the device NAME, so the
// old chassis's asset used to match the roster by name forever and was never
// retired (prod 2026-10-05). The name is now a keep only when it cannot be told
// apart from the same chassis.

function ctx(over: Partial<RosterFirewallContext> = {}): RosterFirewallContext {
  return {
    knownFirewallSerialsUc: new Set(["FGT60FNEW0000001"]),
    knownDeviceNamesLc: new Set(["site-fw"]),
    haRosterPublishedUc: new Set(),
    clusterSerialsByDevice: new Map([["site-fw", new Set(["FGT60FNEW0000001"])]]),
    ...over,
  };
}

const OLD = { hostname: "SITE-FW", serialNumber: "FGT60FOLD0000001", fortinetTopology: null };

describe("judgeRosterFirewall", () => {
  it("keeps a gate whose chassis is still on the roster", () => {
    expect(judgeRosterFirewall({ ...OLD, serialNumber: "fgt60fnew0000001" }, ctx())).toEqual({ kind: "keep" });
  });

  it("calls a same-name gate with a different chassis REPLACED", () => {
    expect(judgeRosterFirewall(OLD, ctx())).toEqual({
      kind: "replaced",
      oldSerial: "FGT60FOLD0000001",
      newSerials: ["FGT60FNEW0000001"],
    });
  });

  it("matches the FMG device name on the topology blob, not only the hostname", () => {
    const asset = { hostname: "fortigate-60f", serialNumber: "FGT60FOLD0000001", fortinetTopology: { deviceName: "SITE-FW" } };
    expect(judgeRosterFirewall(asset, ctx()).kind).toBe("replaced");
  });

  it("keeps a same-name gate nobody READ this run — absence is not evidence", () => {
    expect(judgeRosterFirewall(OLD, ctx({ clusterSerialsByDevice: new Map() }))).toEqual({ kind: "keep" });
  });

  it("keeps a same-name gate whose read published no serial", () => {
    expect(judgeRosterFirewall(OLD, ctx({ clusterSerialsByDevice: new Map([["site-fw", new Set()]]) }))).toEqual({ kind: "keep" });
  });

  it("keeps a legacy row with no serial when its name is on the roster", () => {
    expect(judgeRosterFirewall({ ...OLD, serialNumber: null }, ctx())).toEqual({ kind: "keep" });
  });

  it("treats a placeholder serial as no serial (rule 84)", () => {
    expect(judgeRosterFirewall({ ...OLD, serialNumber: "Default string" }, ctx())).toEqual({ kind: "keep" });
  });

  it("never reports an HA failover as a replacement — the old serial is still on the roster", () => {
    const c = ctx({
      knownFirewallSerialsUc: new Set(["FGT60FNEW0000001", "FGT60FOLD0000001"]),
      clusterSerialsByDevice: new Map([["site-fw", new Set(["FGT60FNEW0000001", "FGT60FOLD0000001"])]]),
    });
    expect(judgeRosterFirewall(OLD, c)).toEqual({ kind: "keep" });
  });

  it("protects a standby whose cluster roster went unread", () => {
    const standby = {
      hostname: "SITE-FW-B",
      serialNumber: "FGT60FSTBY000001",
      fortinetTopology: { haRole: "secondary", haPeerSerial: "FGT60FNEW0000001" },
    };
    expect(judgeRosterFirewall(standby, ctx())).toEqual({ kind: "keep" });
  });

  it("calls a gate gone from the roster entirely STALE", () => {
    expect(judgeRosterFirewall({ ...OLD, hostname: "OTHER-FW" }, ctx())).toEqual({ kind: "stale" });
  });

  it("never judges a row with nothing to identify it by", () => {
    expect(judgeRosterFirewall({ hostname: null, serialNumber: "FGT60FOLD0000001", fortinetTopology: null }, ctx())).toEqual({ kind: "keep" });
  });
});
