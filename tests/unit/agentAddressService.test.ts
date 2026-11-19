/**
 * tests/unit/agentAddressService.test.ts — business rule 195: the agent's
 * confirmed address, written on its push and held off discovery's ladder.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({ logEvent: vi.fn() }));

vi.mock("../../src/db.js", () => import("./_dbStub.js"));
vi.mock("../../src/services/eventLogService.js", () => ({ logEvent: h.logEvent }));

import { prisma } from "../../src/db.js";
import { resetDbStub, stubbed } from "./_dbStub.js";
import {
  applyAgentAddress,
  confirmedAgentAddress,
  loadAgentHeldAddressAssetIds,
} from "../../src/services/agentAddressService.js";

const db = prisma as any;
const NOW = new Date("2026-11-19T12:00:00Z");

const unpinned = {
  id: "a1", hostname: "HICKMAN-HMI2", ipAddress: "172.22.174.134",
  ipOverride: null, ipBlankPinned: false, primaryAddressIp: null,
};
const hmiSources = [
  { sourceKind: "fortigate-endpoint", inferred: false, observed: { ipAddress: "172.22.174.134" }, lastSeen: NOW },
  { sourceKind: "polaris-agent", inferred: false, observed: { confirmedIp: "172.22.175.193" }, lastSeen: NOW },
];

beforeEach(() => {
  resetDbStub();
  h.logEvent.mockReset();
});

describe("confirmedAgentAddress", () => {
  it("checks the source address against the agent's interface rows", async () => {
    stubbed(db.assetAssociatedIp.findMany).mockResolvedValue([{ ip: "172.22.175.193" }, { ip: "172.29.0.1" }]);
    expect(await confirmedAgentAddress("a1", "172.22.175.193", "172.29.0.1")).toBe("172.22.175.193");
    expect(db.assetAssociatedIp.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { assetId: "a1", source: "agent-interface" },
    }));
  });

  it("reads nothing without a source address", async () => {
    expect(await confirmedAgentAddress("a1", null, "10.0.0.1")).toBeNull();
    expect(db.assetAssociatedIp.findMany).not.toHaveBeenCalled();
  });
});

describe("applyAgentAddress", () => {
  it("moves the primary to the agent's address and audits it", async () => {
    stubbed(db.asset.findUnique).mockResolvedValue(unpinned);
    stubbed(db.assetSource.findMany).mockResolvedValue(hmiSources);
    expect(await applyAgentAddress("a1", NOW)).toBe("172.22.175.193");
    expect(db.asset.update).toHaveBeenCalledWith({
      where: { id: "a1" },
      data: { ipAddress: "172.22.175.193", ipSource: "polaris-agent" },
    });
    expect(h.logEvent).toHaveBeenCalledWith(expect.objectContaining({
      action: "asset.address.agent",
      details: expect.objectContaining({ from: "172.22.174.134", to: "172.22.175.193" }),
    }));
  });

  it("writes nothing when the address already matches", async () => {
    stubbed(db.asset.findUnique).mockResolvedValue({ ...unpinned, ipAddress: "172.22.175.193" });
    stubbed(db.assetSource.findMany).mockResolvedValue(hmiSources);
    expect(await applyAgentAddress("a1", NOW)).toBeNull();
    expect(db.asset.update).not.toHaveBeenCalled();
  });

  it.each([
    ["a typed override", { ipOverride: "10.0.0.7" }],
    ["a blank pin", { ipBlankPinned: true }],
    ["a primary-address pin", { primaryAddressIp: "172.22.174.134" }],
  ])("leaves %s alone", async (_label, pin) => {
    stubbed(db.asset.findUnique).mockResolvedValue({ ...unpinned, ...pin });
    expect(await applyAgentAddress("a1", NOW)).toBeNull();
    expect(db.assetSource.findMany).not.toHaveBeenCalled();
    expect(db.asset.update).not.toHaveBeenCalled();
  });

  it("writes nothing when another source wins — that is discovery's write", async () => {
    stubbed(db.asset.findUnique).mockResolvedValue(unpinned);
    stubbed(db.assetSource.findMany).mockResolvedValue([
      hmiSources[0],
      { sourceKind: "polaris-agent", inferred: false, observed: { primaryIp: "172.22.175.193" }, lastSeen: NOW },
    ]);
    expect(await applyAgentAddress("a1", NOW)).toBeNull();
    expect(db.asset.update).not.toHaveBeenCalled();
  });
});

describe("loadAgentHeldAddressAssetIds", () => {
  it("returns only fresh agent rows that carry a confirmed address", async () => {
    stubbed(db.assetSource.findMany).mockResolvedValue([
      { assetId: "a1", observed: { confirmedIp: "10.0.0.1" } },
      { assetId: "a2", observed: { primaryIp: "10.0.0.2" } },
      { assetId: "a3", observed: { confirmedIp: "" } },
      { assetId: "a4", observed: null },
    ]);
    expect([...await loadAgentHeldAddressAssetIds(NOW)]).toEqual(["a1"]);
    const where = stubbed(db.assetSource.findMany).mock.calls[0][0].where;
    expect(where.sourceKind).toBe("polaris-agent");
    expect(where.lastSeen.gte).toEqual(new Date(NOW.getTime() - 24 * 60 * 60 * 1000));
  });
});
