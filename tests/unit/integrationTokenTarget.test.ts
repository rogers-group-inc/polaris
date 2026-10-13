/**
 * tests/unit/integrationTokenTarget.test.ts — business rule 111(c): an asset
 * address change that would send a FortiManager / FortiGate integration's API
 * token somewhere new needs Integrations Read-Write. The 2026-10-13 re-scan
 * found duplicate-IP reassign (F1) and asset merge (F72) without the check;
 * every address-writing path now calls these two functions.
 */

import { describe, it, expect } from "vitest";
import {
  assertIpChangeMayRetargetIntegrationToken,
  assertMergeMayRetargetIntegrationToken,
  isFortinetTokenTarget,
} from "../../src/utils/integrationTokenTarget.js";

const fgt = (ip: string | null) => ({ ipAddress: ip, discoveredByIntegration: { type: "fortigate" } });
const fmg = (ip: string | null) => ({ ipAddress: ip, discoveredByIntegration: { type: "fortimanager" } });
const manual = (ip: string | null) => ({ ipAddress: ip, discoveredByIntegration: null });

describe("isFortinetTokenTarget", () => {
  it("keys on the managing integration, not the asset type", () => {
    expect(isFortinetTokenTarget(fgt("10.0.0.1"))).toBe(true);
    expect(isFortinetTokenTarget(fmg("10.0.0.1"))).toBe(true);
    expect(isFortinetTokenTarget({ discoveredByIntegration: { type: "vcenter" } })).toBe(false);
    expect(isFortinetTokenTarget(manual("10.0.0.1"))).toBe(false);
  });
});

describe("assertIpChangeMayRetargetIntegrationToken", () => {
  it("refuses a new address on a managed device without integrations:write", () => {
    expect(() => assertIpChangeMayRetargetIntegrationToken(false, fgt("10.0.0.1"), "203.0.113.9")).toThrow(/Integrations Read-Write/);
  });
  it("allows it with integrations:write", () => {
    expect(() => assertIpChangeMayRetargetIntegrationToken(true, fgt("10.0.0.1"), "203.0.113.9")).not.toThrow();
  });
  it("lets through what sends the token nowhere new", () => {
    for (const next of [undefined, null, "", "  ", "10.0.0.1", " 10.0.0.1 "]) {
      expect(() => assertIpChangeMayRetargetIntegrationToken(false, fgt("10.0.0.1"), next)).not.toThrow();
    }
  });
  it("leaves unmanaged assets an ordinary Assets edit", () => {
    expect(() => assertIpChangeMayRetargetIntegrationToken(false, manual("10.0.0.1"), "203.0.113.9")).not.toThrow();
  });
});

describe("assertMergeMayRetargetIntegrationToken (either side)", () => {
  it("refuses a managed survivor taking the absorbed record's address", () => {
    expect(() => assertMergeMayRetargetIntegrationToken(false, fgt("10.0.0.1"), manual("203.0.113.9"), "203.0.113.9")).toThrow(/Integrations Read-Write/);
  });
  it("refuses a hand-made survivor absorbing a managed device and keeping its own address", () => {
    expect(() => assertMergeMayRetargetIntegrationToken(false, manual("203.0.113.9"), fgt("10.0.0.1"), "203.0.113.9")).toThrow(/Integrations Read-Write/);
  });
  it("allows a merge whose address is a managed member's own (an RMA chassis swap)", () => {
    expect(() => assertMergeMayRetargetIntegrationToken(false, fgt("10.0.0.2"), fgt("10.0.0.1"), "10.0.0.2")).not.toThrow();
    expect(() => assertMergeMayRetargetIntegrationToken(false, manual(null), fgt("10.0.0.1"), "10.0.0.1")).not.toThrow();
  });
  it("allows anything with integrations:write, and merges of two unmanaged records", () => {
    expect(() => assertMergeMayRetargetIntegrationToken(true, manual("203.0.113.9"), fgt("10.0.0.1"), "203.0.113.9")).not.toThrow();
    expect(() => assertMergeMayRetargetIntegrationToken(false, manual("1.1.1.1"), manual("2.2.2.2"), "2.2.2.2")).not.toThrow();
  });
  it("a merge that leaves no address sends the token nowhere", () => {
    expect(() => assertMergeMayRetargetIntegrationToken(false, manual(null), fgt("10.0.0.1"), null)).not.toThrow();
  });
});
