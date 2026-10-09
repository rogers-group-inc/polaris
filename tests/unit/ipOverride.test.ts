/**
 * tests/unit/ipOverride.test.ts
 *
 * applyIpOverride — the pure guard behind the operator IP pin
 * (Asset.ipOverride). The db.ts Prisma extension calls it on every asset
 * update/upsert that stages `ipAddress`, passing the row's current override.
 * Unlike the hostname pin, discovery gets a vote: a staged IP equal to the
 * override releases the pin ("released"); a different staged IP is rewritten
 * back to the override ("reasserted", carrying the discovered IP so the
 * caller can raise a Conflict). The operator's own set/clear write (which
 * stages `ipOverride` itself) is never rewritten.
 */

import { describe, it, expect } from "vitest";
import { applyIpBlankPin, applyIpOverride } from "../../src/utils/assetInvariants.js";

describe("applyIpOverride", () => {
  it("releases the pin when the staged IP equals the override", () => {
    const data: Record<string, unknown> = { ipAddress: "10.0.1.50", ipSource: "fortimanager" };
    expect(applyIpOverride(data, "10.0.1.50")).toEqual({ action: "released", ip: "10.0.1.50" });
    expect(data.ipAddress).toBe("10.0.1.50"); // staged value passes through
    expect(data.ipOverride).toBeNull();       // pin self-disables
    expect(data.ipSource).toBe("fortimanager"); // provenance untouched on release
  });

  it("releases on a whitespace-only formatting difference", () => {
    const data: Record<string, unknown> = { ipAddress: " 10.0.1.50 " };
    expect(applyIpOverride(data, "10.0.1.50")).toEqual({ action: "released", ip: "10.0.1.50" });
    expect(data.ipOverride).toBeNull();
  });

  it("re-asserts the pin over a different staged IP and reports the discovered IP", () => {
    const data: Record<string, unknown> = { ipAddress: "10.0.9.9", ipSource: "fortigate" };
    expect(applyIpOverride(data, "10.0.1.50")).toEqual({ action: "reasserted", discoveredIp: "10.0.9.9" });
    expect(data.ipAddress).toBe("10.0.1.50");
    expect(data.ipSource).toBe("manual"); // provenance follows the pinned value
    expect(data).not.toHaveProperty("ipOverride"); // pin itself untouched
  });

  it("re-asserts through the nested { set } shape", () => {
    const data: Record<string, unknown> = { ipAddress: { set: "10.0.9.9" } };
    expect(applyIpOverride(data, "10.0.1.50")).toEqual({ action: "reasserted", discoveredIp: "10.0.9.9" });
    expect(data.ipAddress).toEqual({ set: "10.0.1.50" });
  });

  it("releases through the nested { set } shape", () => {
    const data: Record<string, unknown> = { ipAddress: { set: "10.0.1.50" } };
    expect(applyIpOverride(data, "10.0.1.50")).toEqual({ action: "released", ip: "10.0.1.50" });
    expect(data.ipAddress).toEqual({ set: "10.0.1.50" });
    expect(data.ipOverride).toBeNull();
  });

  it("re-asserts a staged clear without reporting a discovered IP", () => {
    // A source losing its opinion is not a disagreement — no conflict fodder.
    for (const cleared of [null, ""] as const) {
      const data: Record<string, unknown> = { ipAddress: cleared };
      expect(applyIpOverride(data, "10.0.1.50")).toEqual({ action: "reasserted", discoveredIp: null });
      expect(data.ipAddress).toBe("10.0.1.50");
    }
  });

  it("is a no-op when the row has no override", () => {
    for (const override of [null, undefined, ""] as const) {
      const data: Record<string, unknown> = { ipAddress: "10.0.9.9" };
      expect(applyIpOverride(data, override)).toEqual({ action: "none" });
      expect(data.ipAddress).toBe("10.0.9.9");
      expect(data).not.toHaveProperty("ipOverride");
    }
  });

  it("is a no-op when the write does not stage ipAddress", () => {
    const data: Record<string, unknown> = { lastSeen: new Date() };
    expect(applyIpOverride(data, "10.0.1.50")).toEqual({ action: "none" });
    expect(data).not.toHaveProperty("ipAddress");
  });

  it("never rewrites the operator set/clear path (write stages ipOverride)", () => {
    // Set: PUT pins a new override alongside ipAddress.
    const setData: Record<string, unknown> = { ipAddress: "10.0.2.2", ipOverride: "10.0.2.2" };
    expect(applyIpOverride(setData, "10.0.1.50")).toEqual({ action: "none" });
    expect(setData.ipAddress).toBe("10.0.2.2");

    // Clear: PUT releases the pin and reverts ipAddress to the projection.
    const clearData: Record<string, unknown> = { ipAddress: "10.0.3.3", ipOverride: null };
    expect(applyIpOverride(clearData, "10.0.1.50")).toEqual({ action: "none" });
    expect(clearData.ipAddress).toBe("10.0.3.3");
  });

  it("tolerates non-object data", () => {
    expect(applyIpOverride(null as unknown as Record<string, unknown>, "x")).toEqual({ action: "none" });
    expect(applyIpOverride(undefined as unknown as Record<string, unknown>, "x")).toEqual({ action: "none" });
  });
});

describe("applyIpBlankPin", () => {
  it("drops a staged address on a blank-pinned row and names it for the conflict", () => {
    const data: Record<string, unknown> = { ipAddress: "10.0.1.50", ipSource: "fortigate" };
    expect(applyIpBlankPin(data, true)).toEqual({ action: "reasserted", discoveredIp: "10.0.1.50" });
    expect(data.ipAddress).toBeNull();
    expect(data.ipSource).toBeNull();
  });

  it("handles the nested { set } shape", () => {
    const data: Record<string, unknown> = { ipAddress: { set: "10.0.1.50" }, ipSource: { set: "agent" } };
    applyIpBlankPin(data, true);
    expect(data.ipAddress).toEqual({ set: null });
    expect(data.ipSource).toEqual({ set: null });
  });

  it("keeps the pin when a source stages a clear — it does not self-release", () => {
    const data: Record<string, unknown> = { ipAddress: null };
    expect(applyIpBlankPin(data, true)).toEqual({ action: "none" });
    expect("ipBlankPinned" in data).toBe(false);
  });

  it("never touches an operator / conflict-accept write, or a row with no pin", () => {
    const typed: Record<string, unknown> = { ipAddress: "10.0.1.7", ipOverride: "10.0.1.7", ipBlankPinned: false };
    expect(applyIpBlankPin(typed, true)).toEqual({ action: "none" });
    expect(typed.ipAddress).toBe("10.0.1.7");
    const accept: Record<string, unknown> = { ipAddress: "10.0.1.8", ipOverride: null };
    expect(applyIpBlankPin(accept, true)).toEqual({ action: "none" });
    expect(applyIpBlankPin({ ipAddress: "10.0.1.9" }, false)).toEqual({ action: "none" });
    expect(applyIpBlankPin({ notes: "x" }, true)).toEqual({ action: "none" });
  });
});
