/**
 * tests/integration/alertGroupUpdateCadence.test.ts
 *
 * Business rule 75, the update cadence and the per-check automation fold:
 *  - after a grouped alert's first send, a device that joins or recovers is
 *    not emailed the tick it happens — it is queued (`pendingChanges`) and ONE
 *    [UPDATED] send names it when `nextUpdateDueAt` passes, one polling
 *    interval after the previous send;
 *  - several changes inside one interval are one update;
 *  - an automation-folded group splits a Path Monitor automation per path
 *    check, its members the hosts failing that check.
 */

import { afterAll, beforeEach, expect, it } from "vitest";
import { prisma } from "../../src/db.js";
import { dbDescribe, dbReachable } from "./_helpers.js";
import { evaluateAllNotificationRules } from "../../src/services/notificationEngine.js";
import type { AlertMember, PendingGroupChanges } from "../../src/services/notificationTypes.js";
import { renderNotificationTemplate } from "../../src/utils/notificationTemplate.js";
import { DEFAULT_ALERT_SUBJECT } from "../../src/utils/alertEmailTemplate.js";

const d = dbDescribe;
const HOST = "update-cadence-test";
const NAME = "update-cadence-test";

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

/** A switch with three PoE ports, faulted or not (rule 57's carve-out: read
 *  off AssetInterface, no pin, no samples). */
async function seedSwitch(name: string, faulted: boolean): Promise<string> {
  const now = new Date();
  const asset = await prisma.asset.create({
    data: { hostname: `${HOST}-${name}`, status: "active", monitored: true, assetType: "switch", monitorStatus: "up", lastSeen: now, lastMonitorAt: now } as never,
    select: { id: true },
  });
  await prisma.assetInterface.createMany({
    data: ["port2", "port5"].map((ifName) => ({
      assetId: asset.id, ifName, poeStatus: faulted ? "fault" : "delivering", operStatus: "up", adminStatus: "up",
      ifType: "ethernetCsmacd", firstSeen: now, lastSeen: now,
    })),
  });
  return asset.id;
}
const setPoe = (assetId: string, poeStatus: string) => prisma.assetInterface.updateMany({ where: { assetId }, data: { poeStatus } });

async function seedGroup(foldBy: string, trigger: Record<string, unknown>, scopeTag?: string): Promise<{ groupId: string; ruleId: string }> {
  const g = await prisma.alertGroup.create({
    data: { name: `${NAME} group`, enabled: true, requireAckNote: false, foldBy, actions: [{ type: "notify", channelId, addresses: ["noc@example.test"] }] } as never,
    select: { id: true },
  });
  const r = await prisma.notificationRule.create({
    data: {
      name: `${NAME} rule`, enabled: true, severity: "serious", trigger,
      scope: scopeTag
        ? { condition: { op: "and", children: [{ field: "tag", operator: "has", value: scopeTag }] } }
        : { condition: { op: "and", children: [{ field: "hostname", operator: "startsWith", value: HOST }] } },
      reset: { mode: "auto" }, actions: [], channels: ["in_app"], alertGroupId: g.id,
    } as never,
    select: { id: true },
  });
  return { groupId: g.id, ruleId: r.id };
}
const poeTrigger = { type: "asset_state", field: "poeStatus", operator: "==", value: "fault" };

const deliveries = (ruleId: string) => prisma.notificationDelivery.count({ where: { notification: { ruleId } } });
const liveAlert = async (ruleId: string) => (await prisma.notification.findMany({ where: { ruleId, cleared: false } }))[0]!;
/** Move the alert's clocks to "due now", as the clock would one interval later. */
const expire = (ruleId: string, field: "firstSendDueAt" | "nextUpdateDueAt") =>
  prisma.notification.updateMany({ where: { ruleId, cleared: false }, data: { [field]: new Date(Date.now() - 1000) } });

/** Open the alert and release its first send. */
async function openAndRelease(ruleId: string): Promise<void> {
  await evaluateAllNotificationRules();
  await expire(ruleId, "firstSendDueAt");
  await evaluateAllNotificationRules();
}

d("grouped alert updates go at most once per polling interval (business rule 75)", () => {
  beforeEach(async () => {
    await wipe();
    const ch = await prisma.notificationChannel.create({ data: { name: `${NAME} smtp`, type: "smtp", enabled: true, config: {} }, select: { id: true } });
    channelId = ch.id;
  });
  afterAll(async () => {
    if (dbReachable) await wipe();
  });

  it("a device joining after the first send is queued, then sent once when the interval passes", async () => {
    await seedSwitch("a", true);
    const late = await seedSwitch("b", false);
    const { ruleId } = await seedGroup("automation", poeTrigger);
    await openAndRelease(ruleId);
    const first = await deliveries(ruleId);
    expect(first).toBe(1);
    const opened = await liveAlert(ruleId);
    expect(opened.sendIntervalSec).toBeGreaterThan(0);
    expect(opened.nextUpdateDueAt!.getTime()).toBeGreaterThan(Date.now());

    await setPoe(late, "fault");
    await evaluateAllNotificationRules();
    // Joined, but not emailed: it waits for the interval.
    expect(await deliveries(ruleId)).toBe(1);
    const queued = (await liveAlert(ruleId)).pendingChanges as unknown as PendingGroupChanges;
    expect(queued.changes.map((c) => c.kind)).toContain("joined");

    await evaluateAllNotificationRules();
    expect(await deliveries(ruleId)).toBe(1);

    await expire(ruleId, "nextUpdateDueAt");
    await evaluateAllNotificationRules();
    expect(await deliveries(ruleId)).toBe(2);
    const after = await liveAlert(ruleId);
    expect(after.pendingChanges).toBeNull();
    expect(after.nextUpdateDueAt!.getTime()).toBeGreaterThan(Date.now());

    // Nothing more queued: the next due time sends nothing.
    await expire(ruleId, "nextUpdateDueAt");
    await evaluateAllNotificationRules();
    expect(await deliveries(ruleId)).toBe(2);
  });

  it("a device recovering mid-alert is an update too, and the stored context drops it", async () => {
    await seedSwitch("a", true);
    const b = await seedSwitch("b", true);
    const { ruleId } = await seedGroup("automation", poeTrigger);
    await openAndRelease(ruleId);
    expect(await deliveries(ruleId)).toBe(1);

    await setPoe(b, "delivering");
    await evaluateAllNotificationRules();
    expect(await deliveries(ruleId)).toBe(1);
    const mid = await liveAlert(ruleId);
    const queued = mid.pendingChanges as unknown as PendingGroupChanges;
    expect(queued.changes.every((c) => c.kind === "recovered")).toBe(true);
    expect((mid.templateCtx as Record<string, string>)["dimension"]).not.toContain(`${HOST}-b`);

    await expire(ruleId, "nextUpdateDueAt");
    await evaluateAllNotificationRules();
    expect(await deliveries(ruleId)).toBe(2);
  });

  it("several changes inside one interval are one update", async () => {
    await seedSwitch("a", true);
    const b = await seedSwitch("b", false);
    const c = await seedSwitch("c", true);
    const { ruleId } = await seedGroup("automation", poeTrigger);
    await openAndRelease(ruleId);

    await setPoe(b, "fault");
    await evaluateAllNotificationRules();
    await setPoe(c, "delivering");
    await evaluateAllNotificationRules();
    const queued = (await liveAlert(ruleId)).pendingChanges as unknown as PendingGroupChanges;
    expect(queued.changes.map((x) => x.kind).sort()).toEqual(["joined", "joined", "recovered", "recovered"]);

    await expire(ruleId, "nextUpdateDueAt");
    await evaluateAllNotificationRules();
    expect(await deliveries(ruleId)).toBe(2);
  });

  it("an automation group splits a Path Monitor automation per path check, hosts as members", async () => {
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
    const mkCheck = (n: string) => prisma.pathCheck.create({
      data: { name: `${NAME} ${n}`, kind: "https", target: `https://${n}.example.test`, intervalSec: 120, traceroute: {}, scope: { assetIds: hosts }, assetIds: hosts, definitionSha256: "0".repeat(64) } as never,
      select: { id: true },
    });
    const erp = await mkCheck("erp");
    const vpn = await mkCheck("vpn");
    await prisma.assetPathCheckSample.createMany({
      data: hosts.flatMap((assetId) => [erp.id, vpn.id].map((checkId) => ({ assetId, checkId, timestamp: now, ok: false, error: "timeout" }))) as never,
    });
    const { groupId, ruleId } = await seedGroup(
      "automation",
      { type: "asset_metric", metric: "pathOk", aggregation: "latest", windowSec: 0, operator: "==", threshold: 0, forDurationSec: 0 },
      NAME,
    );
    await evaluateAllNotificationRules();

    const alerts = await prisma.notification.findMany({ where: { ruleId, cleared: false } });
    expect(alerts.map((a) => a.groupKey).sort()).toEqual([`grp:${groupId}|auto:${ruleId}/${erp.id}`, `grp:${groupId}|auto:${ruleId}/${vpn.id}`].sort());
    const erpAlert = alerts.find((a) => a.groupKey!.endsWith(erp.id))!;
    const members = erpAlert.members as unknown as AlertMember[];
    expect(members.map((m) => m.label).sort()).toEqual([`${HOST}-pc-01`, `${HOST}-pc-02`]);
    expect(erpAlert.assetHostname).toBe(`${NAME} rule — ${NAME} erp`);
    // The default text says what is wrong with the check, not only where.
    expect(erpAlert.message).toBe(`${NAME} erp is down from 2 devices — ${HOST}-pc-01, ${HOST}-pc-02`);
    // The subject names the check, says what is wrong and counts the hosts —
    // "[SERIOUS] <check> is down · 2 devices — <rule>".
    const ctx = erpAlert.templateCtx as Record<string, string>;
    expect(ctx["asset"]).toBe(`${NAME} erp`);
    expect(ctx["condition.suffix"]).toBe(" is down");
    expect(ctx["dimension.suffix"]).toBe(" · 2 devices");
    expect(ctx["dimension"]).toBe(`${HOST}-pc-01, ${HOST}-pc-02`);
    expect(renderNotificationTemplate(DEFAULT_ALERT_SUBJECT, ctx)).toBe(`[SERIOUS] ${NAME} erp is down · 2 devices — ${NAME} rule`);
    // The email's headline leads with the check too, not "Path check result on … is 0".
    expect(ctx["trigger.summary"]).toBe(`${NAME} erp is down from ${HOST}-pc-01, ${HOST}-pc-02`);
  });

  it("device + automation folds every path check from every host into one alert, counted past the member cap", async () => {
    const now = new Date();
    // 25 hosts × 3 checks = 75 contributions, past MAX_GROUP_MEMBERS (64): the
    // counts must come from the state rows, not the capped snapshot.
    const hosts = (await Promise.all(Array.from({ length: 25 }, (_, i) => prisma.asset.create({
      data: { hostname: `${HOST}-wg-${String(i).padStart(2, "0")}`, status: "active", monitored: true, assetType: "workstation", monitorStatus: "up", lastSeen: now, lastMonitorAt: now, tags: [NAME] } as never,
      select: { id: true },
    })))).map((a) => a.id);
    await prisma.managedAgent.createMany({
      data: hosts.map((assetId) => ({ assetId, osPlatform: "windows", arch: "amd64", installStatus: "active", installedBy: "tester", serverCertFingerprint: "x" })) as never,
    });
    const checks = await Promise.all(["erp", "vpn", "crm"].map((n) => prisma.pathCheck.create({
      data: { name: `${NAME} ${n}`, kind: "https", target: `https://${n}.example.test`, intervalSec: 120, traceroute: {}, scope: { assetIds: hosts }, assetIds: hosts, definitionSha256: "0".repeat(64) } as never,
      select: { id: true },
    })));
    await prisma.assetPathCheckSample.createMany({
      data: hosts.flatMap((assetId) => checks.map((c) => ({ assetId, checkId: c.id, timestamp: now, ok: false, error: "timeout" }))) as never,
    });
    const { groupId, ruleId } = await seedGroup(
      "deviceAutomation",
      { type: "asset_metric", metric: "pathOk", aggregation: "latest", windowSec: 0, operator: "==", threshold: 0, forDurationSec: 0 },
      NAME,
    );
    await evaluateAllNotificationRules();

    const alerts = await prisma.notification.findMany({ where: { ruleId, cleared: false } });
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.groupKey).toBe(`grp:${groupId}|all`);
    const ctx = alerts[0]!.templateCtx as Record<string, string>;
    // "[SERIOUS] 3 path checks are down · 25 devices — <automation>" — one automation, so it names it.
    expect(ctx["asset"]).toBe("3 path checks");
    expect(ctx["condition.suffix"]).toBe(" are down");
    expect(ctx["dimension.suffix"]).toBe(" · 25 devices");
    expect(ctx["trigger.summary"]).toBe("3 path checks are down from 25 devices");
    expect(ctx["rule"]).toBe(`${NAME} rule`);
    expect(alerts[0]!.message).toMatch(/^3 path checks are down from 25 devices — /);
    expect(await prisma.notificationRuleState.count({ where: { notificationId: alerts[0]!.id, state: "firing" } })).toBe(75);

    // One host recovers from everything: the counts drop with it.
    await prisma.assetPathCheckSample.createMany({
      data: checks.map((c) => ({ assetId: hosts[0]!, checkId: c.id, timestamp: new Date(now.getTime() + 1000), ok: true })) as never,
    });
    await prisma.notification.updateMany({ where: { id: alerts[0]!.id }, data: { firstSentAt: new Date(), firstSendDueAt: new Date(Date.now() - 1000) } });
    await evaluateAllNotificationRules();
    const after = await prisma.notification.findUniqueOrThrow({ where: { id: alerts[0]!.id } });
    expect((after.templateCtx as Record<string, string>)["dimension.suffix"]).toBe(" · 24 devices");
    expect((after.templateCtx as Record<string, string>)["trigger.summary"]).toBe("3 path checks are down from 24 devices");
    expect(after.message).toMatch(/^3 path checks are down from 24 devices — /);
  });
});
