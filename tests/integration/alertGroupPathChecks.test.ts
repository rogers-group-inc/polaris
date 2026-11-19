/**
 * tests/integration/alertGroupPathChecks.test.ts
 *
 * Business rule 194: an alert group may govern only some path checks.
 *  - on an automation fold, only the listed checks fold into group alerts; a
 *    check outside the list alerts on its own per host (`rule:` key, no group
 *    stamp), exactly like a device outside the group's scope;
 *  - on a whole-group fold, only the listed checks are in the one alert;
 *  - an empty list is every check;
 *  - changing the list retires the group's live alerts;
 *  - an unknown check id is refused.
 */

import { afterAll, beforeEach, expect, it } from "vitest";
import { prisma } from "../../src/db.js";
import { dbDescribe, dbReachable } from "./_helpers.js";
import { evaluateAllNotificationRules } from "../../src/services/notificationEngine.js";
import { createGroup, updateGroup } from "../../src/services/alertGroupService.js";

const d = dbDescribe;
const HOST = "grp-path-checks-test";
const NAME = "grp-path-checks-test";

let channelId = "";

async function wipe(): Promise<void> {
  const rules = await prisma.notificationRule.findMany({ where: { name: { startsWith: NAME } }, select: { id: true } });
  const ids = rules.map((r) => r.id);
  if (ids.length) {
    await prisma.notificationRuleState.deleteMany({ where: { ruleId: { in: ids } } });
    await prisma.notification.deleteMany({ where: { ruleId: { in: ids } } });
    await prisma.notificationRule.deleteMany({ where: { id: { in: ids } } });
  }
  await prisma.alertGroup.deleteMany({ where: { name: { startsWith: NAME } } });
  await prisma.notificationChannel.deleteMany({ where: { name: { startsWith: NAME } } });
  const checks = await prisma.pathCheck.findMany({ where: { name: { startsWith: NAME } }, select: { id: true } });
  await prisma.assetPathCheckSample.deleteMany({ where: { checkId: { in: checks.map((c) => c.id) } } });
  await prisma.pathCheck.deleteMany({ where: { name: { startsWith: NAME } } });
  await prisma.asset.deleteMany({ where: { hostname: { startsWith: HOST } } });
}

/** Two agent hosts and three checks, every host failing every check. */
async function seedFleet(): Promise<{ hosts: string[]; erp: string; vpn: string; crm: string }> {
  const now = new Date();
  const hosts: string[] = [];
  for (const n of ["pc-01", "pc-02"]) {
    const a = await prisma.asset.create({
      data: { hostname: `${HOST}-${n}`, status: "active", monitored: true, assetType: "workstation", monitorStatus: "up", lastSeen: now, lastMonitorAt: now, tags: [NAME] } as never,
      select: { id: true },
    });
    await prisma.managedAgent.create({ data: { assetId: a.id, osPlatform: "windows", arch: "amd64", installStatus: "active", installedBy: "tester", serverCertFingerprint: "x" } as never });
    hosts.push(a.id);
  }
  const mk = async (n: string) => (await prisma.pathCheck.create({
    data: { name: `${NAME} ${n}`, kind: "https", target: `https://${n}.example.test`, intervalSec: 120, traceroute: {}, scope: { assetIds: hosts }, assetIds: hosts, definitionSha256: "0".repeat(64) } as never,
    select: { id: true },
  })).id;
  const erp = await mk("erp");
  const vpn = await mk("vpn");
  const crm = await mk("crm");
  await prisma.assetPathCheckSample.createMany({
    data: hosts.flatMap((assetId) => [erp, vpn, crm].map((checkId) => ({ assetId, checkId, timestamp: now, ok: false, error: "timeout" }))) as never,
  });
  return { hosts, erp, vpn, crm };
}

async function seedRule(): Promise<string> {
  const r = await prisma.notificationRule.create({
    data: {
      name: `${NAME} rule`, enabled: true, severity: "serious",
      trigger: { type: "asset_metric", metric: "pathOk", aggregation: "latest", windowSec: 0, operator: "==", threshold: 0, forDurationSec: 0 },
      scope: { condition: { op: "and", children: [{ field: "tag", operator: "has", value: NAME }] } },
      reset: { mode: "auto" }, actions: [], channels: ["in_app"],
    } as never,
    select: { id: true },
  });
  return r.id;
}

async function seedGroup(foldBy: string, ruleId: string, pathCheckIds: string[] | null): Promise<string> {
  const g = await createGroup({
    name: `${NAME} group`, foldBy: foldBy as never, ruleIds: [ruleId], pathCheckIds,
    actions: [{ type: "notify", channelId, addresses: ["noc@example.test"] }],
  }, "tester");
  return g.id;
}

const liveFor = (ruleId: string) => prisma.notification.findMany({ where: { ruleId, cleared: false } });

d("alert group path-check filter (business rule 194)", () => {
  beforeEach(async () => {
    await wipe();
    const ch = await prisma.notificationChannel.create({ data: { name: `${NAME} smtp`, type: "smtp", enabled: true, config: {} }, select: { id: true } });
    channelId = ch.id;
  });
  afterAll(async () => {
    if (dbReachable) await wipe();
  });

  it("folds only the listed checks; an unlisted check alerts on its own per host", async () => {
    const { hosts, erp, vpn, crm } = await seedFleet();
    const ruleId = await seedRule();
    const groupId = await seedGroup("automation", ruleId, [erp, vpn]);
    await evaluateAllNotificationRules();

    const alerts = await liveFor(ruleId);
    const grouped = alerts.filter((a) => a.alertGroupId === groupId);
    expect(grouped.map((a) => a.groupKey).sort()).toEqual(
      [`grp:${groupId}|auto:${ruleId}/${erp}`, `grp:${groupId}|auto:${ruleId}/${vpn}`].sort(),
    );
    // crm: not governed — one alert per host under the automation's own key.
    const own = alerts.filter((a) => a.alertGroupId === null);
    expect(own.map((a) => a.groupKey).sort()).toEqual(hosts.map((h) => `rule:${ruleId}|${h}`).sort());
    for (const a of own) expect(a.dimension).toBe(crm);
  });

  it("a whole-group fold holds only the listed checks", async () => {
    const { hosts, erp } = await seedFleet();
    const ruleId = await seedRule();
    const groupId = await seedGroup("deviceAutomation", ruleId, [erp]);
    await evaluateAllNotificationRules();

    const alerts = await liveFor(ruleId);
    const grouped = alerts.filter((a) => a.alertGroupId === groupId);
    expect(grouped).toHaveLength(1);
    expect(grouped[0]!.groupKey).toBe(`grp:${groupId}|all`);
    expect(await prisma.notificationRuleState.count({ where: { notificationId: grouped[0]!.id, state: "firing" } })).toBe(hosts.length);
    // vpn + crm alert per host on their own.
    expect(alerts.filter((a) => a.alertGroupId === null)).toHaveLength(hosts.length);
  });

  it("an empty list governs every check", async () => {
    await seedFleet();
    const ruleId = await seedRule();
    const groupId = await seedGroup("automation", ruleId, []);
    await evaluateAllNotificationRules();
    const alerts = await liveFor(ruleId);
    expect(alerts).toHaveLength(3);
    expect(alerts.every((a) => a.alertGroupId === groupId)).toBe(true);
    expect((await prisma.alertGroup.findUniqueOrThrow({ where: { id: groupId } })).pathCheckIds).toEqual([]);
  });

  it("changing the list retires live alerts; omitting it changes nothing", async () => {
    const { erp, vpn } = await seedFleet();
    const ruleId = await seedRule();
    const groupId = await seedGroup("automation", ruleId, [erp]);
    await evaluateAllNotificationRules();
    const before = (await liveFor(ruleId)).length;
    expect(before).toBeGreaterThan(0);

    // A rename that does not send the list keeps it, and retires nothing.
    await updateGroup(groupId, { name: `${NAME} group renamed` }, "tester");
    expect((await liveFor(ruleId)).length).toBe(before);
    expect((await prisma.alertGroup.findUniqueOrThrow({ where: { id: groupId } })).pathCheckIds).toEqual([erp]);

    await updateGroup(groupId, { name: `${NAME} group renamed`, pathCheckIds: [erp, vpn] }, "tester");
    expect(await prisma.notification.count({ where: { alertGroupId: groupId, cleared: false } })).toBe(0);
  });

  it("refuses a check that does not exist", async () => {
    const ruleId = await seedRule();
    await expect(seedGroup("automation", ruleId, ["00000000-0000-0000-0000-000000000000"])).rejects.toMatchObject({ httpStatus: 400 });
  });
});
