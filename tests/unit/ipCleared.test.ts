/**
 * tests/unit/ipCleared.test.ts
 *
 * applyIpCleared + stagedIpOf — the pure guard behind business rule 40(j):
 * an operator blanks an offline device's address from a duplicate-IP card,
 * and discovery fills the blank with the next DIFFERENT address it reports,
 * while a re-report of the blanked address is held off as long as another
 * network-present asset still records it.
 */

import { describe, it, expect } from "vitest";
import { applyIpCleared, stagedIpOf } from "../../src/utils/assetInvariants.js";

describe("stagedIpOf", () => {
  it("reads the plain and nested shapes, trimmed", () => {
    expect(stagedIpOf({ ipAddress: " 10.0.0.1 " })).toBe("10.0.0.1");
    expect(stagedIpOf({ ipAddress: { set: "10.0.0.2" } })).toBe("10.0.0.2");
  });

  it("returns null for no address, a clear, or a non-string", () => {
    expect(stagedIpOf({})).toBeNull();
    expect(stagedIpOf({ ipAddress: null })).toBeNull();
    expect(stagedIpOf({ ipAddress: "  " })).toBeNull();
    expect(stagedIpOf({ ipAddress: { set: null } })).toBeNull();
    expect(stagedIpOf(null)).toBeNull();
  });
});

describe("applyIpCleared", () => {
  it("fills the blank with a different discovered address and releases the hold", () => {
    const data: Record<string, unknown> = { ipAddress: "172.23.87.77", ipSource: "fortigate" };
    expect(applyIpCleared(data, "172.23.87.40", true)).toEqual({ action: "filled", ip: "172.23.87.77" });
    expect(data).toEqual({ ipAddress: "172.23.87.77", ipSource: "fortigate", ipCleared: null });
  });

  it("fills from the nested shape too", () => {
    const data: Record<string, unknown> = { ipAddress: { set: "172.23.87.77" } };
    expect(applyIpCleared(data, "172.23.87.40", false)).toEqual({ action: "filled", ip: "172.23.87.77" });
    expect(data.ipCleared).toBeNull();
  });

  it("holds the blanked address off while another asset still records it", () => {
    const data: Record<string, unknown> = { ipAddress: "172.23.87.40", ipSource: "fortigate", hostname: "KM1DBD8D" };
    expect(applyIpCleared(data, "172.23.87.40", true)).toEqual({ action: "held", ip: "172.23.87.40" });
    // The address and its provenance are dropped; the rest of the write stands.
    expect(data).toEqual({ hostname: "KM1DBD8D" });
  });

  it("lets the blanked address back once nothing else holds it", () => {
    const data: Record<string, unknown> = { ipAddress: "172.23.87.40" };
    expect(applyIpCleared(data, "172.23.87.40", false)).toEqual({ action: "returned", ip: "172.23.87.40" });
    expect(data).toEqual({ ipAddress: "172.23.87.40", ipCleared: null });
  });

  it("leaves a staged clear alone — the blank stays blank", () => {
    const data: Record<string, unknown> = { ipAddress: null };
    expect(applyIpCleared(data, "172.23.87.40", true)).toEqual({ action: "none" });
    expect(data).toEqual({ ipAddress: null });
  });

  it("does nothing without a hold, without a staged address, or when the write sets ipCleared itself", () => {
    expect(applyIpCleared({ ipAddress: "10.0.0.1" }, null, true)).toEqual({ action: "none" });
    expect(applyIpCleared({ hostname: "x" }, "10.0.0.1", true)).toEqual({ action: "none" });
    const operator: Record<string, unknown> = { ipAddress: "10.0.0.1", ipCleared: null };
    expect(applyIpCleared(operator, "10.0.0.1", true)).toEqual({ action: "none" });
    expect(operator).toEqual({ ipAddress: "10.0.0.1", ipCleared: null });
  });
});
