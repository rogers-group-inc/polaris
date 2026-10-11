/**
 * tests/unit/pollingCapability.test.ts
 *
 * "Does a collector exist?" — the table that exposes the combinations which
 * validate, persist, resolve, and then silently gather nothing.
 *
 * This is a claim about code that lives elsewhere, so the assertions double as
 * the checklist: when one of these flips to implemented, the test says so and
 * the entry has to move with it.
 */

import { describe, it, expect } from "vitest";
import { collectorCapability, collectorExists } from "../../src/utils/pollingCapability.js";
import type { Stream } from "../../src/utils/pollingCompatibility.js";

const HEAVY: Stream[] = ["cpuMemory", "temperature", "interfaces", "lldp", "storage"];

describe("collectorCapability — the silent no-ops", () => {
  // agentlessHostService closed the cpuMemory / interfaces / storage / eventLog
  // half of this gap; temperature and LLDP are still genuinely absent over a
  // shell rather than merely unwired.
  it("SSH and WinRM deliver the host streams, but not temperature or LLDP", () => {
    for (const m of ["ssh", "winrm"] as const) {
      for (const s of ["responseTime", "processes", "cpuMemory", "interfaces", "storage", "eventLog"] as Stream[]) {
        expect(collectorExists("activedirectory", s, m), `${m}/${s}`).toBe(true);
      }
      for (const s of ["temperature", "lldp"] as Stream[]) {
        expect(collectorExists("activedirectory", s, m), `${m}/${s}`).toBe(false);
      }
    }
  });

  it("names a reason an operator can act on", () => {
    const v = collectorCapability("activedirectory", "temperature", "ssh");
    expect(v.implemented).toBe(false);
    expect(v.reason).toMatch(/not implemented/i);
    expect(v.reason).toMatch(/Agent/);
  });

  // Advertised in the matrix header as "SNMP (hrSWRunTable)" and filtered to
  // ssh|winrm in all three dispatch sites.
  it("SNMP processes is declared but unimplemented", () => {
    expect(collectorExists("manual", "processes", "snmp")).toBe(false);
    expect(collectorCapability("manual", "processes", "snmp").reason).toMatch(/hrSWRunTable/);
  });

  // The agent and the agentless transports both feed ingestOsEventLog; SNMP has
  // no event-log MIB and the FortiOS device-log collector was never written.
  it("eventLog is served by the agent and by ssh/winrm, and by nothing else", () => {
    for (const m of ["agent", "ssh", "winrm"] as const) {
      expect(collectorExists("activedirectory", "eventLog", m), m).toBe(true);
    }
    expect(collectorExists("activedirectory", "eventLog", "snmp")).toBe(false);
    expect(collectorExists("fortimanager", "eventLog", "rest_api")).toBe(false);
  });

  it("the agent collects everything except LLDP", () => {
    for (const s of ["responseTime", "cpuMemory", "temperature", "interfaces", "storage", "processes", "eventLog"] as Stream[]) {
      expect(collectorExists("activedirectory", s, "agent"), s).toBe(true);
    }
    expect(collectorExists("activedirectory", "lldp", "agent")).toBe(false);
  });

  it("ICMP answers only a response-time probe", () => {
    expect(collectorExists("manual", "responseTime", "icmp")).toBe(true);
    for (const s of HEAVY) {
      expect(collectorExists("manual", s, "icmp"), s).toBe(false);
    }
  });
});

describe("collectorCapability — Fortinet REST, which depends on the asset class", () => {
  it("a firewall gets the four REST streams but never storage", () => {
    for (const s of ["responseTime", "cpuMemory", "temperature", "interfaces", "lldp"] as Stream[]) {
      expect(collectorExists("fortimanager", s, "rest_api", { assetType: "firewall" }), s).toBe(true);
    }
    // collectSystemInfoFortinet hardcodes `storage: []` — the call succeeds and
    // returns nothing, which is worse than failing.
    expect(collectorExists("fortimanager", "storage", "rest_api", { assetType: "firewall" })).toBe(false);
    expect(collectorCapability("fortimanager", "storage", "rest_api", { assetType: "firewall" }).reason)
      .toMatch(/no mountable storage/i);
  });

  // The controller-status table reports up/down and nothing else for a switch.
  it("a managed FortiSwitch gets up/down over REST and nothing more", () => {
    expect(collectorExists("fortimanager", "responseTime", "rest_api", { assetType: "switch" })).toBe(true);
    for (const s of HEAVY) {
      expect(collectorExists("fortimanager", s, "rest_api", { assetType: "switch" }), s).toBe(false);
    }
  });

  // An AP is the exception: cpu_usage / mem_* / sensors_temperatures ride the
  // same cached wifi/managed_ap row the probe already reads.
  it("a managed FortiAP additionally gets cpu/memory and temperature", () => {
    expect(collectorExists("fortimanager", "responseTime", "rest_api", { assetType: "access_point" })).toBe(true);
    expect(collectorExists("fortimanager", "cpuMemory", "rest_api", { assetType: "access_point" })).toBe(true);
    expect(collectorExists("fortimanager", "temperature", "rest_api", { assetType: "access_point" })).toBe(true);
    for (const s of ["interfaces", "lldp", "storage"] as Stream[]) {
      expect(collectorExists("fortimanager", s, "rest_api", { assetType: "access_point" }), s).toBe(false);
    }
  });

  it("a manual REST credential drives the probe only", () => {
    expect(collectorExists("manual", "responseTime", "rest_api")).toBe(true);
    for (const s of HEAVY) {
      expect(collectorExists("manual", s, "rest_api"), s).toBe(false);
    }
  });
});

describe("collectorCapability — the methods that are fully wired", () => {
  it("SNMP covers every stream but processes and eventLog", () => {
    for (const s of ["responseTime", ...HEAVY] as Stream[]) {
      expect(collectorExists("fortimanager", s, "snmp"), s).toBe(true);
    }
  });

  it("vcenter and fortimanager are implemented wherever their matrix scoping allows them", () => {
    expect(collectorExists("vcenter", "cpuMemory", "vcenter")).toBe(true);
    expect(collectorExists("vcenter", "storage", "vcenter")).toBe(true);
    expect(collectorExists("fortimanager", "responseTime", "fortimanager")).toBe(true);
  });

  it("genericapi is implemented for every stream a monitor query can map (rule 100(i))", () => {
    for (const s of ["responseTime", "cpuMemory", "interfaces", "storage", "temperature", "lldp"] as Stream[]) {
      expect(collectorExists("genericapi", s, "genericapi"), s).toBe(true);
    }
  });

  // "disabled" means don't poll — always honoured, never a gap.
  it("disabled is always implemented", () => {
    for (const s of ["responseTime", ...HEAVY, "processes", "eventLog"] as Stream[]) {
      expect(collectorExists("fortimanager", s, "disabled"), s).toBe(true);
    }
  });
});
