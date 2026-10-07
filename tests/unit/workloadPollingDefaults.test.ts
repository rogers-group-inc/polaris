/**
 * tests/unit/workloadPollingDefaults.test.ts
 *
 * Unraid / TrueNAS source defaults (operator decision 2026-10-07): response
 * time is ICMP for an asset with an address, and the platform's API state
 * check only for one without — a bridged container or a VM whose guest IP the
 * platform does not publish, where ICMP would fail every probe and call a
 * running workload down. Every other stream stays on the platform's method.
 */

import { describe, it, expect } from "vitest";
import { defaultPollingForSource } from "../../src/services/monitoringService.js";

describe("defaultPollingForSource — Unraid / TrueNAS", () => {
  for (const src of ["unraid", "truenas"] as const) {
    it(`${src}: response time is ICMP when the asset has an address`, () => {
      expect(defaultPollingForSource(src, "responseTime", { hasIp: true })).toBe("icmp");
    });
    it(`${src}: response time stays on the API state check without one`, () => {
      expect(defaultPollingForSource(src, "responseTime", { hasIp: false })).toBe(src);
      // A caller that never said is treated as "no address" — never a ping at nothing.
      expect(defaultPollingForSource(src, "responseTime")).toBe(src);
    });
    it(`${src}: every other stream is unchanged by the address`, () => {
      for (const hasIp of [true, false]) {
        expect(defaultPollingForSource(src, "cpuMemory", { hasIp })).toBe(src);
        expect(defaultPollingForSource(src, "interfaces", { hasIp })).toBe(src);
        expect(defaultPollingForSource(src, "storage", { hasIp })).toBe(src);
        expect(defaultPollingForSource(src, "temperature", { hasIp })).toBe(src);
        expect(defaultPollingForSource(src, "lldp", { hasIp })).toBeNull();
      }
    });
  }

  it("does not change any other source's response-time default", () => {
    expect(defaultPollingForSource("vcenter", "responseTime", { hasIp: true })).toBe("vcenter");
    expect(defaultPollingForSource("fortigate", "responseTime", { hasIp: false })).toBe("icmp");
    expect(defaultPollingForSource("manual", "responseTime", { hasIp: false })).toBe("icmp");
  });
});
