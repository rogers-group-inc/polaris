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
import { collectorCapability } from "../../src/utils/pollingCapability.js";
import type { Stream } from "../../src/utils/pollingCompatibility.js";

const HEAVY: Stream[] = ["cpuMemory", "temperature", "interfaces", "lldp", "storage"];

describe("collectorCapability — the silent no-ops", () => {
  // agentlessHostService closed the cpuMemory / interfaces / storage / eventLog
  // half of this gap; temperature and LLDP are still genuinely absent over a
  // shell rather than merely unwired.
  it("SSH and WinRM deliver the host streams, but not temperature or LLDP", () => {
    for (const m of ["ssh", "winrm"] as const) {
      for (const s of ["responseTime", "processes", "cpuMemory", "interfaces", "storage", "eventLog"] as Stream[]) {
        expect(collectorCapability("activedirectory", s, m).implemented, `${m}/${s}`).toBe(true);
      }
      for (const s of ["temperature", "lldp"] as Stream[]) {
        expect(collectorCapability("activedirectory", s, m).implemented, `${m}/${s}`).toBe(false);
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
    expect(collectorCapability("manual", "processes", "snmp").implemented).toBe(false);
    expect(collectorCapability("manual", "processes", "snmp").reason).toMatch(/hrSWRunTable/);
  });

  // The agent and the agentless transports both feed ingestOsEventLog; SNMP has
  // no event-log MIB and the FortiOS device-log collector was never written.
  it("eventLog is served by the agent and by ssh/winrm, and by nothing else", () => {
    for (const m of ["agent", "ssh", "winrm"] as const) {
      expect(collectorCapability("activedirectory", "eventLog", m).implemented, m).toBe(true);
    }
    expect(collectorCapability("activedirectory", "eventLog", "snmp").implemented).toBe(false);
    expect(collectorCapability("fortimanager", "eventLog", "rest_api").implemented).toBe(false);
  });

  it("the agent collects everything except LLDP", () => {
    for (const s of ["responseTime", "cpuMemory", "temperature", "interfaces", "storage", "processes", "eventLog"] as Stream[]) {
      expect(collectorCapability("activedirectory", s, "agent").implemented, s).toBe(true);
    }
    expect(collectorCapability("activedirectory", "lldp", "agent").implemented).toBe(false);
  });

  it("ICMP answers only a response-time probe", () => {
    expect(collectorCapability("manual", "responseTime", "icmp").implemented).toBe(true);
    for (const s of HEAVY) {
      expect(collectorCapability("manual", s, "icmp").implemented, s).toBe(false);
    }
  });
});

describe("collectorCapability — Fortinet REST, which depends on the asset class", () => {
  it("a firewall gets the four REST streams but never storage", () => {
    for (const s of ["responseTime", "cpuMemory", "temperature", "interfaces", "lldp"] as Stream[]) {
      expect(collectorCapability("fortimanager", s, "rest_api", { assetType: "firewall" }).implemented, s).toBe(true);
    }
    // collectSystemInfoFortinet hardcodes `storage: []` — the call succeeds and
    // returns nothing, which is worse than failing.
    expect(collectorCapability("fortimanager", "storage", "rest_api", { assetType: "firewall" }).implemented).toBe(false);
    expect(collectorCapability("fortimanager", "storage", "rest_api", { assetType: "firewall" }).reason)
      .toMatch(/no mountable storage/i);
  });

  // The controller-status table reports up/down and nothing else for a switch.
  it("a managed FortiSwitch gets up/down over REST and nothing more", () => {
    expect(collectorCapability("fortimanager", "responseTime", "rest_api", { assetType: "switch" }).implemented).toBe(true);
    for (const s of HEAVY) {
      expect(collectorCapability("fortimanager", s, "rest_api", { assetType: "switch" }).implemented, s).toBe(false);
    }
  });

  // An AP is the exception: cpu_usage / mem_* / sensors_temperatures ride the
  // same cached wifi/managed_ap row the probe already reads.
  it("a managed FortiAP additionally gets cpu/memory and temperature", () => {
    expect(collectorCapability("fortimanager", "responseTime", "rest_api", { assetType: "access_point" }).implemented).toBe(true);
    expect(collectorCapability("fortimanager", "cpuMemory", "rest_api", { assetType: "access_point" }).implemented).toBe(true);
    expect(collectorCapability("fortimanager", "temperature", "rest_api", { assetType: "access_point" }).implemented).toBe(true);
    for (const s of ["interfaces", "lldp", "storage"] as Stream[]) {
      expect(collectorCapability("fortimanager", s, "rest_api", { assetType: "access_point" }).implemented, s).toBe(false);
    }
  });

  it("a manual REST credential drives the probe only", () => {
    expect(collectorCapability("manual", "responseTime", "rest_api").implemented).toBe(true);
    for (const s of HEAVY) {
      expect(collectorCapability("manual", s, "rest_api").implemented, s).toBe(false);
    }
  });
});

describe("collectorCapability — the methods that are fully wired", () => {
  it("SNMP covers every stream but processes and eventLog", () => {
    for (const s of ["responseTime", ...HEAVY] as Stream[]) {
      expect(collectorCapability("fortimanager", s, "snmp").implemented, s).toBe(true);
    }
  });

  it("vcenter and fortimanager are implemented wherever their matrix scoping allows them", () => {
    expect(collectorCapability("vcenter", "cpuMemory", "vcenter").implemented).toBe(true);
    expect(collectorCapability("vcenter", "storage", "vcenter").implemented).toBe(true);
    expect(collectorCapability("fortimanager", "responseTime", "fortimanager").implemented).toBe(true);
  });

  it("genericapi is implemented for every stream a monitor query can map (rule 100(i))", () => {
    for (const s of ["responseTime", "cpuMemory", "interfaces", "storage", "temperature", "lldp"] as Stream[]) {
      expect(collectorCapability("genericapi", s, "genericapi").implemented, s).toBe(true);
    }
  });

  // "disabled" means don't poll — always honoured, never a gap.
  it("disabled is always implemented", () => {
    for (const s of ["responseTime", ...HEAVY, "processes", "eventLog"] as Stream[]) {
      expect(collectorCapability("fortimanager", s, "disabled").implemented, s).toBe(true);
    }
  });
});
