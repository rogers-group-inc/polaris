/**
 * tests/integration/assetRemoval.test.ts — business rule 156 against a real
 * database: deleting an asset leaves nothing naming it, merging one moves the
 * operator's intent to the survivor, and neither ever widens a target.
 *
 * Skips cleanly when DATABASE_URL isn't reachable; see _helpers.ts.
 */

import { it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { app } from "../../src/app.js";
import { prisma } from "../../src/db.js";
import { authedAgent, dbDescribe, dbReachable, ensureTestUser } from "./_helpers.js";
import { afterAssetsDeleted, afterAssetMerged } from "../../src/services/assetRemovalService.js";
import { mergeAssets } from "../../src/services/assetMergeService.js";
import { getConfig as getAppMapConfig, saveConfig as saveAppMapConfig, SETTING_KEY as APP_MAP_KEY } from "../../src/services/appMapDiscoveryService.js";
import { listScans, getScanForWrite } from "../../src/services/networkScanService.js";

const d = dbDescribe;
const PFX = "asset-removal-test";

let appMapBefore: unknown = undefined;

async function mkAsset(suffix: string) {
  return prisma.asset.create({ data: { hostname: `${PFX}-${suffix}`, assetType: "server", status: "active" } as never });
}

async function cleanup() {
  const assets = await prisma.asset.findMany({ where: { hostname: { startsWith: PFX } }, select: { id: true } });
  const ids = assets.map((a) => a.id);
  await prisma.pathCheck.deleteMany({ where: { name: { startsWith: PFX } } });
  await prisma.contact.deleteMany({ where: { email: { startsWith: PFX } } });
  await prisma.maintenanceSchedule.deleteMany({ where: { name: { startsWith: PFX } } });
  await prisma.notificationRule.deleteMany({ where: { name: { startsWith: PFX } } });
  await prisma.logFlagRule.deleteMany({ where: { name: { startsWith: PFX } } });
  await prisma.networkScan.deleteMany({ where: { name: { startsWith: PFX } } });
  await prisma.assetProcessConfig.deleteMany({ where: { name: { startsWith: PFX } } });
  await prisma.assetProcess.deleteMany({ where: { name: { startsWith: PFX } } });
  await prisma.assetService.deleteMany({ where: { unit: { startsWith: PFX } } });
  await prisma.assetSdwanRule.deleteMany({ where: { ruleName: { startsWith: PFX } } });
  await prisma.agentCommand.deleteMany({ where: { target: { startsWith: PFX } } });
  await prisma.automationScriptRun.deleteMany({ where: { scriptName: { startsWith: PFX } } });
  if (ids.length) await prisma.asset.deleteMany({ where: { id: { in: ids } } });
  await prisma.user.deleteMany({ where: { username: { startsWith: PFX } } });
}

/** Everything that can name an asset without a foreign key, all naming `assetId`. */
async function seedReferences(assetId: string, otherId: string, tag: string) {
  const n = `${PFX}-${tag}`;
  const [check, soloCheck, contact, schedule, rule, logRule] = await Promise.all([
    prisma.pathCheck.create({ data: { name: `${n}-check`, kind: "tcp", target: "example.test:443", traceroute: {}, scope: {}, definitionSha256: "x", assetIds: [otherId, assetId] } as never }),
    prisma.pathCheck.create({ data: { name: `${n}-solo`, kind: "tcp", target: "example.test:443", traceroute: {}, scope: {}, definitionSha256: "x", assetIds: [assetId] } as never }),
    prisma.contact.create({ data: { email: `${n}@example.test`, assetIds: [assetId] } as never }),
    prisma.maintenanceSchedule.create({ data: { name: `${n}-maint`, schedule: {}, assetIds: [assetId, otherId] } as never }),
    prisma.notificationRule.create({ data: { name: `${n}-rule`, trigger: {}, scope: { assetIds: [assetId] }, enabled: false } as never }),
    prisma.logFlagRule.create({ data: { name: `${n}-log`, scope: "asset", assetId, pattern: "error" } }),
  ]);
  await Promise.all([
    prisma.assetProcessConfig.create({ data: { assetId, name: `${n}-nginx`, logPathGlob: "/var/log/nginx/*.log" } }),
    prisma.assetProcess.create({ data: { assetId, name: `${n}-proc` } as never }),
    prisma.assetService.create({ data: { assetId, unit: `${n}.service`, platform: "linux" } as never }),
    prisma.assetSdwanRule.create({ data: { assetId, ruleName: `${n}-sdwan`, status: "up" } as never }),
    prisma.assetInventoryScrape.create({ data: { assetId, kind: "processes", scrapedAt: new Date() } }),
    prisma.agentCommand.create({ data: { assetId, managedAgentId: "no-such-agent", action: "run_script", target: `${n}.sh` } }),
    prisma.automationScriptRun.create({ data: { scriptName: `${n}.sh`, sha256: "0".repeat(64), runOn: "agent", assetId, timeoutSec: 60 } }),
  ]);
  return { check, soloCheck, contact, schedule, rule, logRule };
}

beforeAll(async () => {
  if (!dbReachable) return;
  await prisma.$connect();
  await ensureTestUser();
  const row = await prisma.setting.findUnique({ where: { key: APP_MAP_KEY } });
  appMapBefore = row?.value;
});
beforeEach(async () => {
  if (!dbReachable) return;
  await cleanup();
});
afterAll(async () => {
  if (!dbReachable) return;
  await cleanup();
  if (appMapBefore === undefined) await prisma.setting.deleteMany({ where: { key: APP_MAP_KEY } });
  else await prisma.setting.update({ where: { key: APP_MAP_KEY }, data: { value: appMapBefore as object } });
  await prisma.$disconnect();
});

d("deleting an asset (rule 156)", () => {
  it("DELETE /assets/:id prunes its pins and purges every row that named it", async () => {
    const gone = await mkAsset("gone");
    const other = await mkAsset("other");
    const refs = await seedReferences(gone.id, other.id, "del");

    const adm = await authedAgent(app);
    expect((await adm.agent.delete(`/api/v1/assets/${gone.id}`).set("X-CSRF-Token", adm.csrf)).status).toBeLessThan(300);

    // Pin lists: the dead id is gone, the live one stays.
    expect((await prisma.pathCheck.findUnique({ where: { id: refs.check.id } }))!.assetIds).toEqual([other.id]);
    expect((await prisma.pathCheck.findUnique({ where: { id: refs.soloCheck.id } }))!.assetIds).toEqual([]);
    expect((await prisma.contact.findUnique({ where: { id: refs.contact.id } }))!.assetIds).toEqual([]);
    expect((await prisma.maintenanceSchedule.findUnique({ where: { id: refs.schedule.id } }))!.assetIds).toEqual([other.id]);

    // An automation's scope is NOT emptied: an empty list means every device.
    expect(((await prisma.notificationRule.findUnique({ where: { id: refs.rule.id } }))!.scope as { assetIds: string[] }).assetIds).toEqual([gone.id]);

    // Rows with no foreign key.
    const where = { assetId: gone.id };
    expect(await prisma.logFlagRule.count({ where })).toBe(0);
    expect(await prisma.assetProcessConfig.count({ where })).toBe(0);
    expect(await prisma.assetProcess.count({ where })).toBe(0);
    expect(await prisma.assetService.count({ where })).toBe(0);
    expect(await prisma.assetSdwanRule.count({ where })).toBe(0);
    expect(await prisma.assetInventoryScrape.count({ where })).toBe(0);

    // What was waiting on the device is withdrawn, not left pending forever.
    const cmd = await prisma.agentCommand.findFirst({ where });
    expect(cmd!.status).toBe("failed");
    expect(cmd!.error).toMatch(/deleted or merged away/);
    expect((await prisma.automationScriptRun.findFirst({ where }))!.status).toBe("failed");
  });

  it("the bulk delete does the same for every id", async () => {
    const a = await mkAsset("bulk-a");
    const b = await mkAsset("bulk-b");
    const keep = await mkAsset("bulk-keep");
    const ra = await seedReferences(a.id, keep.id, "bulk-a");
    await seedReferences(b.id, keep.id, "bulk-b");

    const adm = await authedAgent(app);
    const res = await adm.agent.delete("/api/v1/assets").set("X-CSRF-Token", adm.csrf).send({ ids: [a.id, b.id] });
    expect(res.status).toBeLessThan(300);

    expect((await prisma.pathCheck.findUnique({ where: { id: ra.check.id } }))!.assetIds).toEqual([keep.id]);
    expect(await prisma.assetProcess.count({ where: { assetId: { in: [a.id, b.id] } } })).toBe(0);
    expect(await prisma.logFlagRule.count({ where: { assetId: { in: [a.id, b.id] } } })).toBe(0);
    expect(await prisma.agentCommand.count({ where: { assetId: { in: [a.id, b.id] }, status: "pending" } })).toBe(0);
  });

  it("never widens an Application Map rule: an auto rule goes with its last device, a manual one keeps the dead id", async () => {
    const gone = await mkAsset("appmap-gone");
    const other = await mkAsset("appmap-other");
    const block = { names: ["nginx"], patterns: [], regex: false };
    const empty = { names: [], patterns: [], regex: false };
    const base = { enabled: true, mode: "map", scope: null, processes: block, services: empty };
    await saveAppMapConfig({ version: 2, rules: [
      { ...base, id: "11111111-1111-4111-8111-111111111111", name: `${PFX} auto solo`, source: "auto", assetIds: [gone.id] },
      { ...base, id: "22222222-2222-4222-8222-222222222222", name: `${PFX} auto pair`, source: "auto", assetIds: [gone.id, other.id] },
      { ...base, id: "33333333-3333-4333-8333-333333333333", name: `${PFX} manual solo`, source: "manual", assetIds: [gone.id] },
    ] } as never);

    await afterAssetsDeleted([gone.id]);

    const rules = (await getAppMapConfig()).rules;
    expect(rules.map((r) => r.name)).toEqual([`${PFX} auto pair`, `${PFX} manual solo`]);
    expect(rules[0].assetIds).toEqual([other.id]);
    // {scope: null, assetIds: []} would read as "every monitored asset".
    expect(rules[1].assetIds).toEqual([gone.id]);
  });
});

d("merging an asset (rule 156)", () => {
  it("moves pins, automation scope, log rules and process log config to the survivor", async () => {
    const ghost = await mkAsset("ghost");
    const keep = await mkAsset("keep");
    const refs = await seedReferences(ghost.id, keep.id, "merge");
    // The survivor already has its own config for one program: its own wins.
    await prisma.assetProcessConfig.create({ data: { assetId: ghost.id, name: `${PFX}-clash`, logPathGlob: "/ghost/*.log" } });
    await prisma.assetProcessConfig.create({ data: { assetId: keep.id, name: `${PFX}-clash`, logPathGlob: "/keep/*.log" } });

    await mergeAssets({ canonicalId: keep.id, ghostId: ghost.id } as never);
    expect(await prisma.asset.findUnique({ where: { id: ghost.id } })).toBeNull();

    // Both were pinned: the survivor is listed once.
    expect((await prisma.pathCheck.findUnique({ where: { id: refs.check.id } }))!.assetIds).toEqual([keep.id]);
    // Only the ghost was pinned: the survivor takes its place.
    expect((await prisma.pathCheck.findUnique({ where: { id: refs.soloCheck.id } }))!.assetIds).toEqual([keep.id]);
    expect((await prisma.contact.findUnique({ where: { id: refs.contact.id } }))!.assetIds).toEqual([keep.id]);
    expect((await prisma.maintenanceSchedule.findUnique({ where: { id: refs.schedule.id } }))!.assetIds).toEqual([keep.id]);
    expect(((await prisma.notificationRule.findUnique({ where: { id: refs.rule.id } }))!.scope as { assetIds: string[] }).assetIds).toEqual([keep.id]);

    expect((await prisma.logFlagRule.findUnique({ where: { id: refs.logRule.id } }))!.assetId).toBe(keep.id);
    const configs = await prisma.assetProcessConfig.findMany({ where: { assetId: keep.id }, orderBy: { name: "asc" } });
    expect(configs.map((c) => [c.name, c.logPathGlob])).toEqual([
      [`${PFX}-clash`, "/keep/*.log"],
      [`${PFX}-merge-nginx`, "/var/log/nginx/*.log"],
    ]);

    // Nothing is left under the absorbed id.
    const where = { assetId: ghost.id };
    expect(await prisma.assetProcessConfig.count({ where })).toBe(0);
    expect(await prisma.assetProcess.count({ where })).toBe(0);
    expect(await prisma.assetService.count({ where })).toBe(0);
    expect(await prisma.logFlagRule.count({ where })).toBe(0);
    // A command for an agent that did not survive the merge is withdrawn.
    expect((await prisma.agentCommand.findFirst({ where }))!.status).toBe("failed");
  });

  it("re-points an Application Map rule instead of dropping it", async () => {
    const ghost = await mkAsset("am-ghost");
    const keep = await mkAsset("am-keep");
    const block = { names: ["nginx"], patterns: [], regex: false };
    const empty = { names: [], patterns: [], regex: false };
    await saveAppMapConfig({ version: 2, rules: [
      { id: "44444444-4444-4444-8444-444444444444", name: `${PFX} auto solo`, enabled: true, mode: "map", source: "auto", scope: null, assetIds: [ghost.id], processes: block, services: empty },
    ] } as never);

    await afterAssetMerged(ghost.id, keep.id);

    expect((await getAppMapConfig()).rules[0].assetIds).toEqual([keep.id]);
  });
});

d("a private Discovery whose owner was deleted (rule 156(d))", () => {
  it("is reachable by the housekeeping level, and only by it", async () => {
    const role = await prisma.role.findUnique({ where: { name: "readonly" } });
    const owner = await prisma.user.create({ data: { username: `${PFX}-owner`, passwordHash: "x", roleId: role!.id, authProvider: "local" } });
    const scan = await prisma.networkScan.create({ data: { name: `${PFX}-private`, visibility: "private", ownerId: owner.id, targets: [], methods: [] } as never });
    const theirs = await prisma.networkScan.create({ data: { name: `${PFX}-still-owned`, visibility: "private", ownerId: (await prisma.user.findFirst({ where: { username: { not: owner.username } } }))!.id, targets: [], methods: [] } as never });

    await prisma.user.delete({ where: { id: owner.id } });
    expect((await prisma.networkScan.findUnique({ where: { id: scan.id } }))!.ownerId).toBeNull();

    const names = async (id: string | null, housekeeping: boolean) => (await listScans(id, housekeeping)).map((s) => s.name).filter((n) => n.startsWith(PFX));
    expect(await names("some-other-user", false)).toEqual([]);
    expect(await names("some-other-user", true)).toEqual([`${PFX}-private`]);
    await expect(getScanForWrite(scan.id, "some-other-user", false)).rejects.toThrow(/not found/i);
    expect((await getScanForWrite(scan.id, "some-other-user", true)).id).toBe(scan.id);
    // Someone else's private Discovery stays theirs at any level.
    await expect(getScanForWrite(theirs.id, "some-other-user", true)).rejects.toThrow(/not found/i);

    // And the housekeeper can delete it through the API.
    const adm = await authedAgent(app);
    const list = await adm.agent.get("/api/v1/network-scans");
    expect(list.body.scans.map((s: { name: string }) => s.name)).toContain(`${PFX}-private`);
    expect((await adm.agent.delete(`/api/v1/network-scans/${scan.id}`).set("X-CSRF-Token", adm.csrf)).status).toBe(204);
    expect(await prisma.networkScan.findUnique({ where: { id: scan.id } })).toBeNull();
  });
});

d("the clean-up migration (what earlier deletes left on an existing install)", () => {
  it("removes references to assets that no longer exist and touches nothing else", async () => {
    const live = await mkAsset("mig-live");
    const dead = await mkAsset("mig-dead");
    const deadRefs = await seedReferences(dead.id, live.id, "mig-dead");
    const liveRefs = await seedReferences(live.id, live.id, "mig-live");
    // Remove the asset the way a pre-156 release did: the row only.
    await prisma.$executeRaw`DELETE FROM "assets" WHERE "id" = ${dead.id}`;
    expect(await prisma.assetProcess.count({ where: { assetId: dead.id } })).toBe(1);

    const sql = readFileSync(resolve(__dirname, "../../prisma/migrations/20261111120000_orphan_asset_references/migration.sql"), "utf8");
    const statements = sql.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n").split(";").map((s) => s.trim()).filter(Boolean);
    expect(statements.length).toBe(11);
    for (const s of statements) await prisma.$executeRawUnsafe(s);

    const where = { assetId: dead.id };
    expect((await prisma.pathCheck.findUnique({ where: { id: deadRefs.check.id } }))!.assetIds).toEqual([live.id]);
    expect((await prisma.contact.findUnique({ where: { id: deadRefs.contact.id } }))!.assetIds).toEqual([]);
    expect((await prisma.maintenanceSchedule.findUnique({ where: { id: deadRefs.schedule.id } }))!.assetIds).toEqual([live.id]);
    expect(await prisma.logFlagRule.count({ where })).toBe(0);
    expect(await prisma.assetProcessConfig.count({ where })).toBe(0);
    expect(await prisma.assetProcess.count({ where })).toBe(0);
    expect(await prisma.assetService.count({ where })).toBe(0);
    expect(await prisma.assetSdwanRule.count({ where })).toBe(0);
    expect(await prisma.assetInventoryScrape.count({ where })).toBe(0);
    expect((await prisma.agentCommand.findFirst({ where }))!.status).toBe("failed");
    expect((await prisma.automationScriptRun.findFirst({ where }))!.status).toBe("failed");
    // An automation's scope is left alone (an empty list means every device).
    expect(((await prisma.notificationRule.findUnique({ where: { id: deadRefs.rule.id } }))!.scope as { assetIds: string[] }).assetIds).toEqual([dead.id]);

    // The asset that still exists keeps everything.
    const keep = { assetId: live.id };
    expect((await prisma.pathCheck.findUnique({ where: { id: liveRefs.soloCheck.id } }))!.assetIds).toEqual([live.id]);
    expect(await prisma.logFlagRule.count({ where: keep })).toBe(1);
    expect(await prisma.assetProcessConfig.count({ where: keep })).toBe(1);
    expect(await prisma.assetProcess.count({ where: keep })).toBe(1);
    expect(await prisma.assetService.count({ where: keep })).toBe(1);
    expect((await prisma.agentCommand.findFirst({ where: keep }))!.status).toBe("pending");
  });
});
