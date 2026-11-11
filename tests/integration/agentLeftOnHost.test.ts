/**
 * tests/integration/agentLeftOnHost.test.ts — business rule 163, the server's
 * half: which assets have a Polaris Agent (asked before a delete is
 * confirmed), and the record written when a delete or a merge leaves one
 * installed on its host.
 *
 * The dialog that asks is tests/unit/assetDeleteAgentDialogDom.test.ts.
 *
 * Skips cleanly when DATABASE_URL isn't reachable; see _helpers.ts.
 */

import { it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { app } from "../../src/app.js";
import { prisma } from "../../src/db.js";
import { authedAgent, dbDescribe, dbReachable, ensureTestUser, waitForEventCount } from "./_helpers.js";
import { mergeAssets } from "../../src/services/assetMergeService.js";
import { revokeBearer } from "../../src/services/agentTokenService.js";

const d = dbDescribe;
const PFX = "agent-left-test";

async function cleanup() {
  await prisma.event.deleteMany({ where: { action: "agent.left_on_host", resourceName: { startsWith: PFX } } });
  await prisma.asset.deleteMany({ where: { hostname: { startsWith: PFX } } }); // agents cascade
}

const mkAsset = (suffix: string) =>
  prisma.asset.create({ data: { hostname: `${PFX}-${suffix}`, assetType: "server", status: "active" } as never });
const mkAgent = (assetId: string, over: Record<string, unknown> = {}) =>
  prisma.managedAgent.create({
    data: { assetId, osPlatform: "linux", arch: "amd64", installedBy: "t", serverCertFingerprint: "x", installStatus: "active", agentVersion: "0.30.0", ...over } as never,
  });

beforeAll(async () => {
  if (!dbReachable) return;
  await prisma.$connect();
  await ensureTestUser();
});
beforeEach(async () => {
  if (!dbReachable) return;
  await cleanup();
});
afterAll(async () => {
  if (!dbReachable) return;
  await cleanup();
  await prisma.$disconnect();
});

d("which assets have a Polaris Agent (rule 163)", () => {
  it("POST /assets/agent-hosts names the ones that do, in any install state", async () => {
    const a = await mkAsset("with-agent");
    const b = await mkAsset("failed-agent");
    const c = await mkAsset("no-agent");
    await mkAgent(a.id);
    await mkAgent(b.id, { installStatus: "uninstall_failed" });

    const adm = await authedAgent(app);
    const res = await adm.agent.post("/api/v1/assets/agent-hosts").set("X-CSRF-Token", adm.csrf).send({ ids: [a.id, b.id, c.id, "no-such-id"] });
    expect(res.status).toBe(200);
    const byId = Object.fromEntries(res.body.hosts.map((h: { assetId: string }) => [h.assetId, h]));
    expect(Object.keys(byId).sort()).toEqual([a.id, b.id].sort());
    expect(byId[a.id]).toMatchObject({ name: `${PFX}-with-agent`, installStatus: "active", agentVersion: "0.30.0" });
    expect(byId[b.id].installStatus).toBe("uninstall_failed");
    // Nothing secret rides along.
    expect(JSON.stringify(res.body)).not.toMatch(/bearer|token|fingerprint/i);
  });

  it("answers an empty list for no ids, and refuses a body that is not a list", async () => {
    const adm = await authedAgent(app);
    const none = await adm.agent.post("/api/v1/assets/agent-hosts").set("X-CSRF-Token", adm.csrf).send({ ids: [] });
    expect(none.body).toEqual({ hosts: [] });
    const bad = await adm.agent.post("/api/v1/assets/agent-hosts").set("X-CSRF-Token", adm.csrf).send({ ids: "a1" });
    expect(bad.status).toBe(400);
  });
});

d("an agent left on its host is on the record (rule 163)", () => {
  it("deleting an asset that has an agent writes a warning Event naming the host", async () => {
    const a = await mkAsset("deleted");
    const agent = await mkAgent(a.id);
    const adm = await authedAgent(app);
    expect((await adm.agent.delete(`/api/v1/assets/${a.id}`).set("X-CSRF-Token", adm.csrf)).status).toBeLessThan(300);
    expect(await prisma.managedAgent.findUnique({ where: { id: agent.id } })).toBeNull();

    await waitForEventCount("agent.left_on_host", 1, agent.id);
    const ev = await prisma.event.findFirst({ where: { action: "agent.left_on_host", resourceId: agent.id } });
    expect(ev!.level).toBe("warning");
    expect(ev!.resourceName).toBe(`${PFX}-deleted`);
    expect(ev!.message).toContain("is still installed on");
    expect(ev!.message).toContain("remove it on the host");
    expect(ev!.details).toMatchObject({ reason: "asset-deleted", assetId: a.id, agentVersion: "0.30.0" });
  });

  it("deleting an asset with no agent writes no such Event", async () => {
    const a = await mkAsset("plain");
    const adm = await authedAgent(app);
    expect((await adm.agent.delete(`/api/v1/assets/${a.id}`).set("X-CSRF-Token", adm.csrf)).status).toBeLessThan(300);
    await new Promise((r) => setTimeout(r, 300));
    expect(await prisma.event.count({ where: { action: "agent.left_on_host", resourceName: `${PFX}-plain` } })).toBe(0);
  });

  it("the bulk delete records each agent host", async () => {
    const a = await mkAsset("bulk-a");
    const b = await mkAsset("bulk-b");
    const c = await mkAsset("bulk-c");
    const ag1 = await mkAgent(a.id);
    const ag2 = await mkAgent(b.id);
    const adm = await authedAgent(app);
    const res = await adm.agent.delete("/api/v1/assets").set("X-CSRF-Token", adm.csrf).send({ ids: [a.id, b.id, c.id] });
    expect(res.status).toBeLessThan(300);
    await waitForEventCount("agent.left_on_host", 1, ag1.id);
    await waitForEventCount("agent.left_on_host", 1, ag2.id);
    expect(await prisma.event.count({ where: { action: "agent.left_on_host", resourceName: { startsWith: `${PFX}-bulk` } } })).toBe(2);
  });

  it("a merge where BOTH records have an agent records the absorbed one's; a merge that moves the agent records nothing", async () => {
    // Both have agents: the survivor keeps its own, the ghost's cascades away.
    const keep = await mkAsset("merge-keep");
    const ghost = await mkAsset("merge-ghost");
    await mkAgent(keep.id);
    const ghostAgent = await mkAgent(ghost.id);
    await mergeAssets({ canonicalId: keep.id, ghostId: ghost.id } as never);
    await waitForEventCount("agent.left_on_host", 1, ghostAgent.id);
    const ev = await prisma.event.findFirst({ where: { action: "agent.left_on_host", resourceId: ghostAgent.id } });
    expect(ev!.resourceName).toBe(`${PFX}-merge-ghost`);
    expect(ev!.message).toContain(`merged into "${PFX}-merge-keep"`);
    expect(ev!.details).toMatchObject({ reason: "asset-merged" });

    // Only the ghost has one: it moves to the survivor and nothing is stranded.
    const keep2 = await mkAsset("move-keep");
    const ghost2 = await mkAsset("move-ghost");
    const moved = await mkAgent(ghost2.id);
    await mergeAssets({ canonicalId: keep2.id, ghostId: ghost2.id } as never);
    expect((await prisma.managedAgent.findUnique({ where: { id: moved.id } }))!.assetId).toBe(keep2.id);
    await new Promise((r) => setTimeout(r, 300));
    expect(await prisma.event.count({ where: { action: "agent.left_on_host", resourceId: moved.id } })).toBe(0);
  });
});

d("revoking an agent's token (rule 163)", () => {
  it("still revokes, and is idempotent, now that it also closes the live session", async () => {
    const a = await mkAsset("revoke");
    const agent = await mkAgent(a.id);
    expect(await revokeBearer(agent.id)).toBe(true);
    expect((await prisma.managedAgent.findUnique({ where: { id: agent.id } }))!.bearerRevokedAt).not.toBeNull();
    expect(await revokeBearer(agent.id)).toBe(false);
  });
});
