/**
 * tests/unit/agentAddress.test.ts — business rule 195: which connect-from
 * address the agent may vouch for.
 */

import { describe, it, expect } from "vitest";
import { confirmAgentAddress } from "../../src/utils/agentAddress.js";

describe("confirmAgentAddress", () => {
  it("confirms a private source address the agent's interface report lists", () => {
    expect(confirmAgentAddress({
      sourceIp: "172.22.175.193", primaryIp: "172.29.0.1",
      reportedIps: ["172.29.0.1", "172.22.175.193", "172.22.174.134"],
    })).toBe("172.22.175.193");
  });

  it("confirms a source address equal to primaryIp before any interface report", () => {
    expect(confirmAgentAddress({ sourceIp: "10.0.0.5", primaryIp: "10.0.0.5", reportedIps: [] })).toBe("10.0.0.5");
  });

  it("unwraps the IPv4-mapped form Node reports on a dual-stack socket", () => {
    expect(confirmAgentAddress({ sourceIp: "::ffff:10.0.0.5", primaryIp: "10.0.0.5", reportedIps: [] })).toBe("10.0.0.5");
  });

  it("refuses an address the host does not report — NAT sits in between", () => {
    expect(confirmAgentAddress({
      sourceIp: "10.9.9.1", primaryIp: "192.168.1.20", reportedIps: ["192.168.1.20"],
    })).toBeNull();
  });

  it("refuses loopback — an unresolved proxy hop", () => {
    expect(confirmAgentAddress({ sourceIp: "127.0.0.1", primaryIp: "127.0.0.1", reportedIps: ["127.0.0.1"] })).toBeNull();
    expect(confirmAgentAddress({ sourceIp: "::1", primaryIp: null, reportedIps: ["::1"] })).toBeNull();
  });

  it("refuses a public address even when the host reports it", () => {
    expect(confirmAgentAddress({ sourceIp: "8.8.4.4", primaryIp: "8.8.4.4", reportedIps: ["8.8.4.4"] })).toBeNull();
  });

  it("refuses when there is no source address", () => {
    expect(confirmAgentAddress({ sourceIp: null, primaryIp: "10.0.0.5", reportedIps: ["10.0.0.5"] })).toBeNull();
  });
});
