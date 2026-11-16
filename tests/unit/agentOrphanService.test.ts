/**
 * tests/unit/agentOrphanService.test.ts — business rule 163: an agent left on a
 * host whose asset record is deleted or merged away is never silent.
 * listAgentHosts (read BEFORE the delete) and recordAgentsLeftOnHosts (AFTER):
 * any install state counts, one read per 500 ids, the Event's resource is the
 * agent, and the live session is closed.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../src/db.js", () => import("./_dbStub.js"));
vi.mock("../../src/services/eventLogService.js", (orig) => import("./_eventLogStub.js").then((s) => s.withEventLogStubs(orig)));
const detach = vi.hoisted(() => vi.fn());
vi.mock("../../src/services/agentChannelService.js", () => ({ detach }));

import { listAgentHosts, recordAgentsLeftOnHosts, type AgentHost } from "../../src/services/agentOrphanService.js";
import { prisma } from "../../src/db.js";
import { resetDbStub, stubbed } from "./_dbStub.js";
import { eventLog, resetEventLogStub } from "./_eventLogStub.js";

const findMany = () => stubbed(prisma.managedAgent.findMany);
const event = (i = 0) => eventLog.logEvent.mock.calls[i][0] as unknown as Record<string, any>;

beforeEach(() => {
  resetDbStub();
  resetEventLogStub();
  detach.mockReset();
});

describe("listAgentHosts", () => {
  it("returns nothing and reads nothing for no ids", async () => {
    expect(await listAgentHosts([])).toEqual([]);
    expect(findMany()).not.toHaveBeenCalled();
  });

  it("names a host by hostname, else IP, else asset id, in any install state", async () => {
    findMany().mockResolvedValue([
      { id: "m1", assetId: "a1", installStatus: "installed", agentVersion: "1.2.0", asset: { hostname: "SRV-01", ipAddress: "10.0.0.1" } },
      { id: "m2", assetId: "a2", installStatus: "uninstall_failed", agentVersion: null, asset: { hostname: null, ipAddress: "2001:db8::5" } },
      { id: "m3", assetId: "a3", installStatus: "failed", agentVersion: null, asset: null },
    ]);
    expect(await listAgentHosts(["a1", "a2", "a3"])).toEqual([
      { assetId: "a1", managedAgentId: "m1", name: "SRV-01", installStatus: "installed", agentVersion: "1.2.0" },
      { assetId: "a2", managedAgentId: "m2", name: "2001:db8::5", installStatus: "uninstall_failed", agentVersion: null },
      { assetId: "a3", managedAgentId: "m3", name: "a3", installStatus: "failed", agentVersion: null },
    ]);
    // No install-state filter: a failed or half-removed agent still counts.
    expect(findMany().mock.calls[0][0].where).toEqual({ assetId: { in: ["a1", "a2", "a3"] } });
  });

  it("dedupes ids and reads in chunks of 500", async () => {
    findMany().mockResolvedValue([]);
    const ids = Array.from({ length: 1100 }, (_, i) => `a${i}`);
    await listAgentHosts([...ids, "a0", "a1"]);
    expect(findMany()).toHaveBeenCalledTimes(3);
    const sizes = findMany().mock.calls.map((c: any[]) => c[0].where.assetId.in.length);
    expect(sizes).toEqual([500, 500, 100]);
  });
});

describe("recordAgentsLeftOnHosts", () => {
  const host = (over: Partial<AgentHost> = {}): AgentHost => ({ assetId: "a1", managedAgentId: "m1", name: "SRV-01", installStatus: "installed", agentVersion: "1.2.0", ...over });

  it("does nothing for no hosts", async () => {
    expect(await recordAgentsLeftOnHosts([], { reason: "asset-deleted" })).toBe(0);
    expect(detach).not.toHaveBeenCalled();
    expect(eventLog.logEvent).not.toHaveBeenCalled();
  });

  it("closes each agent's session and writes one warning Event per host against the agent", async () => {
    const n = await recordAgentsLeftOnHosts([host(), host({ assetId: "a2", managedAgentId: "m2", name: "SRV-02" })], { actor: "alice", reason: "asset-deleted" });
    expect(n).toBe(2);
    expect(detach.mock.calls).toEqual([["m1", "revoked"], ["m2", "revoked"]]);
    expect(eventLog.logEvent).toHaveBeenCalledTimes(2);
    expect(event()).toMatchObject({
      action: "agent.left_on_host", resourceType: "agent", resourceId: "m1", resourceName: "SRV-01", actor: "alice", level: "warning",
      details: { reason: "asset-deleted", assetId: "a1", managedAgentId: "m1", installStatus: "installed", agentVersion: "1.2.0" },
    });
    expect(event().message).toContain("still installed on SRV-01: its asset record was deleted");
  });

  it("names the survivor of a merge, or says 'another asset' when it is unknown", async () => {
    await recordAgentsLeftOnHosts([host()], { reason: "asset-merged", survivorName: "SRV-NEW" });
    expect(event(0).message).toContain('merged into "SRV-NEW", which already had an agent of its own');
    await recordAgentsLeftOnHosts([host()], { reason: "asset-merged" });
    expect(event(1).message).toContain("merged into another asset");
  });

  it("still records every host when closing a session throws", async () => {
    detach.mockImplementation(() => { throw new Error("no session"); });
    expect(await recordAgentsLeftOnHosts([host(), host({ managedAgentId: "m2" })], { reason: "asset-deleted" })).toBe(2);
    expect(eventLog.logEvent).toHaveBeenCalledTimes(2);
  });
});
