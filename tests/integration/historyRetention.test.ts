/**
 * tests/integration/historyRetention.test.ts — business rule 157 against a
 * real database: each prune deletes what is past its window and nothing else.
 *
 * The cases that matter are the survivors: an OPEN alert however old, a rule
 * state row the engine is still counting on, a queued discovery run, the
 * newest run of a Discovery, and everything when the operator chose "forever".
 *
 * Skips cleanly when DATABASE_URL isn't reachable; see _helpers.ts.
 */

import { it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { app } from "../../src/app.js";
import { prisma } from "../../src/db.js";
import { authedAgent, dbDescribe, dbReachable, ensureTestUser } from "./_helpers.js";
import { listRegions } from "../../src/services/mapRegionService.js";
import {
  pruneAlertHistory,
  pruneIdleRuleStates,
  pruneDiscoveryRuns,
  pruneSightings,
  pruneNetworkScanRuns,
  pruneHistory,
  pruneHiddenRegionIds,
  pruneOrphanTagAssignments,
  updateAlertHistorySettings,
  getAlertHistorySettings,
  RULE_STATE_IDLE_DAYS,
  SCAN_RUN_DAYS,
} from "../../src/services/historyRetentionService.js";

const d = dbDescribe;
const PFX = "history-retention-test";
const DAY = 24 * 3600 * 1000;
const ago = (days: number) => new Date(Date.now() - days * DAY);

let savedAlertSetting: unknown;
let savedSightingSetting: unknown;

async function cleanup() {
  await prisma.notification.deleteMany({ where: { message: { startsWith: PFX } } });
  await prisma.quietTimeSummary.deleteMany({ where: { sourceName: { startsWith: PFX } } });
  await prisma.notificationRule.deleteMany({ where: { name: { startsWith: PFX } } }); // states cascade
  await prisma.discoveryRun.deleteMany({ where: { integrationName: { startsWith: PFX } } });
  await prisma.networkScan.deleteMany({ where: { name: { startsWith: PFX } } }); // runs cascade
  await prisma.asset.deleteMany({ where: { hostname: { startsWith: PFX } } }); // sightings cascade
}

beforeAll(async () => {
  if (!dbReachable) return;
  await prisma.$connect();
  await ensureTestUser();
  savedAlertSetting = (await prisma.setting.findUnique({ where: { key: "alertHistoryRetention" } }))?.value;
  savedSightingSetting = (await prisma.setting.findUnique({ where: { key: "quarantineSightingSettings" } }))?.value;
});
beforeEach(async () => {
  if (!dbReachable) return;
  await cleanup();
  await prisma.setting.deleteMany({ where: { key: { in: ["alertHistoryRetention", "quarantineSightingSettings"] } } });
});
afterAll(async () => {
  if (!dbReachable) return;
  await cleanup();
  for (const [key, value] of [["alertHistoryRetention", savedAlertSetting], ["quarantineSightingSettings", savedSightingSetting]] as const) {
    await prisma.setting.deleteMany({ where: { key } });
    if (value !== undefined) await prisma.setting.create({ data: { key, value: value as object } });
  }
  await prisma.$disconnect();
});

d("alert history (rule 157)", () => {
  async function alert(name: string, over: Record<string, unknown>) {
    const n = await prisma.notification.create({ data: { message: `${PFX} ${name}`, ...over } as never });
    await prisma.notificationDelivery.create({ data: { notificationId: n.id, transport: "email", target: "ops@example.test" } as never });
    return n;
  }
  const exists = async (id: string) => (await prisma.notification.count({ where: { id } })) === 1;

  it("defaults to 365 days: deletes alerts that cleared before that, with their deliveries, and nothing open", async () => {
    const oldCleared = await alert("old cleared", { cleared: true, clearedAt: ago(400), triggeredAt: ago(401) });
    const recentCleared = await alert("recent cleared", { cleared: true, clearedAt: ago(300), triggeredAt: ago(301) });
    // Raised two years ago and STILL OPEN: an open alert is never history.
    const ancientOpen = await alert("ancient open", { cleared: false, triggeredAt: ago(800) });
    // Raised long ago but only just cleared: the clock starts at the clear.
    const longRunning = await alert("long running", { cleared: true, clearedAt: ago(2), triggeredAt: ago(700) });
    const summary = await prisma.quietTimeSummary.create({ data: { sourceKind: "rule", sourceId: "x", sourceName: `${PFX} old`, coveredFrom: ago(401), coveredTo: ago(400), status: "sent", createdAt: ago(400) } as never });
    const pending = await prisma.quietTimeSummary.create({ data: { sourceKind: "rule", sourceId: "x", sourceName: `${PFX} pending`, coveredFrom: ago(401), coveredTo: ago(400), status: "pending", createdAt: ago(400) } as never });

    expect((await getAlertHistorySettings()).alertHistoryDays).toBe(365);
    const res = await pruneAlertHistory();

    expect(res.alerts).toBe(1);
    expect(await exists(oldCleared.id)).toBe(false);
    expect(await prisma.notificationDelivery.count({ where: { notificationId: oldCleared.id } })).toBe(0);
    expect(await exists(recentCleared.id)).toBe(true);
    expect(await exists(ancientOpen.id)).toBe(true);
    expect(await exists(longRunning.id)).toBe(true);
    expect(await prisma.notificationDelivery.count({ where: { notificationId: ancientOpen.id } })).toBe(1);
    expect(await prisma.quietTimeSummary.count({ where: { id: summary.id } })).toBe(0);
    expect(await prisma.quietTimeSummary.count({ where: { id: pending.id } })).toBe(1);
  });

  it("follows the operator's period, and 0 keeps everything", async () => {
    const a = await alert("cleared 100d ago", { cleared: true, clearedAt: ago(100) });
    await updateAlertHistorySettings(0, "test");
    expect(await pruneAlertHistory()).toEqual({ alerts: 0, summaries: 0 });
    expect(await exists(a.id)).toBe(true);

    await updateAlertHistorySettings(90, "test");
    expect((await pruneAlertHistory()).alerts).toBe(1);
    expect(await exists(a.id)).toBe(false);
    // Shortening the period is on the record, at warning.
    const ev = await prisma.event.findFirst({ where: { action: "settings.alert_history_retention.updated" }, orderBy: { timestamp: "desc" } });
    expect(ev!.level).toBe("warning");
    expect(ev!.message).toMatch(/kept forever to 90 days/);
  });

  it("the setting is served and saved with the Events retention settings, and a blank field is refused", async () => {
    const adm = await authedAgent(app);
    const before = await adm.agent.get("/api/v1/events/retention-settings");
    expect(before.body.alertHistoryDays).toBe(365);
    expect(typeof before.body.retentionDays).toBe("number");

    const put = (body: object) => adm.agent.put("/api/v1/events/retention-settings").set("X-CSRF-Token", adm.csrf).send(body);
    const ok = await put({ retentionDays: before.body.retentionDays, minLevel: before.body.minLevel, alertHistoryDays: 180 });
    expect(ok.status).toBe(200);
    expect(ok.body.alertHistoryDays).toBe(180);

    // null is what a cleared number input sends; it must not become "forever".
    for (const bad of [null, 5, 99999, "soon"]) {
      const res = await put({ retentionDays: before.body.retentionDays, minLevel: before.body.minLevel, alertHistoryDays: bad });
      expect(res.status, JSON.stringify(bad)).toBe(400);
    }
    expect((await getAlertHistorySettings()).alertHistoryDays).toBe(180);

    // An older client that does not send the field leaves it alone.
    const legacy = await put({ retentionDays: before.body.retentionDays, minLevel: before.body.minLevel });
    expect(legacy.status).toBe(200);
    expect(legacy.body.alertHistoryDays).toBe(180);
  });
});

d("idle automation state rows (rule 157)", () => {
  it("deletes only rows that are clear, carry nothing, and have not been written for a week", async () => {
    const rule = await prisma.notificationRule.create({ data: { name: `${PFX} rule`, trigger: {}, enabled: false } as never });
    const mk = (assetId: string, over: Record<string, unknown> = {}) =>
      prisma.notificationRuleState.create({ data: { ruleId: rule.id, assetId, ...over } as never });
    const idle = await mk("idle");
    const fresh = await mk("fresh");
    const firing = await mk("firing", { state: "firing", notificationId: "n1" });
    const pending = await mk("pending", { state: "pending", conditionMetSince: ago(30) });
    const counting = await mk("counting", { metRun: 2 });
    const recovering = await mk("recovering", { recoveredSince: ago(30) });
    const banded = await mk("banded", { bandMetSince: { warning: 1 } });
    // Backdate every row but `fresh` (updatedAt is @updatedAt, so raw SQL).
    const stale = ago(RULE_STATE_IDLE_DAYS + 3);
    await prisma.$executeRaw`UPDATE "notification_rule_states" SET "updatedAt" = ${stale} WHERE "ruleId" = ${rule.id} AND "id" <> ${fresh.id}`;

    expect(await pruneIdleRuleStates()).toBe(1);

    const left = (await prisma.notificationRuleState.findMany({ where: { ruleId: rule.id }, select: { id: true } })).map((r) => r.id).sort();
    expect(left).toEqual([fresh.id, firing.id, pending.id, counting.id, recovering.id, banded.id].sort());
    expect(left).not.toContain(idle.id);
  });
});

d("finished discovery runs, sightings, Discovery scan runs (rule 157)", () => {
  it("deletes a finished discovery run whose integration is gone, and never one that is queued or still has its integration", async () => {
    // One row per integration (unique on integrationId, no foreign key).
    const live = await prisma.integration.create({ data: { name: `${PFX} live`, type: "fortigate", config: {} } as never });
    const mk = (integrationId: string, name: string, status: string) =>
      prisma.discoveryRun.create({ data: { integrationId, integrationName: `${PFX} ${name}`, type: "fortigate", actor: "t", status } as never });
    const goneDone = await mk(`${PFX}-deleted-1`, "gone done", "completed");
    const goneError = await mk(`${PFX}-deleted-2`, "gone error", "error");
    const goneQueued = await mk(`${PFX}-deleted-3`, "gone queued", "queued");
    const liveDone = await mk(live.id, "live done", "completed");
    try {
      expect(await pruneDiscoveryRuns()).toBe(2);
      const left = (await prisma.discoveryRun.findMany({ where: { integrationName: { startsWith: PFX } }, select: { id: true } })).map((r) => r.id).sort();
      expect(left).toEqual([goneQueued.id, liveDone.id].sort());
      expect(left).not.toContain(goneDone.id);
      expect(left).not.toContain(goneError.id);
    } finally {
      await prisma.integration.delete({ where: { id: live.id } });
    }
  });

  it("deletes sightings past the quarantine window, and none when the window is 'forever'", async () => {
    const asset = await prisma.asset.create({ data: { hostname: `${PFX}-host`, assetType: "server", status: "active" } as never });
    const mk = (gate: string, days: number) =>
      prisma.assetFortigateSighting.create({ data: { assetId: asset.id, fortigateDevice: gate, source: "dhcp", lastSeen: ago(days) } as never });
    const old = await mk("gate-old", 200);
    const recent = await mk("gate-recent", 20);

    await prisma.setting.create({ data: { key: "quarantineSightingSettings", value: { sightingMaxAgeDays: 0 } } });
    expect(await pruneSightings()).toBe(0);

    await prisma.setting.update({ where: { key: "quarantineSightingSettings" }, data: { value: { sightingMaxAgeDays: 180 } } });
    expect(await pruneSightings()).toBe(1);
    expect(await prisma.assetFortigateSighting.count({ where: { id: old.id } })).toBe(0);
    expect(await prisma.assetFortigateSighting.count({ where: { id: recent.id } })).toBe(1);
  });

  it("deletes a Discovery's old finished runs but keeps its newest run, however old", async () => {
    const busy = await prisma.networkScan.create({ data: { name: `${PFX} busy`, visibility: "public", targets: [], methods: [] } as never });
    const dormant = await prisma.networkScan.create({ data: { name: `${PFX} dormant`, visibility: "public", targets: [], methods: [] } as never });
    const run = (scanId: string, days: number, status = "completed") =>
      prisma.networkScanRun.create({ data: { scanId, actor: "t", status, createdAt: ago(days) } as never });
    const b1 = await run(busy.id, SCAN_RUN_DAYS + 60);
    const b2 = await run(busy.id, SCAN_RUN_DAYS + 30);
    const b3 = await run(busy.id, 5);
    // The dormant Discovery's ONLY run is old — it is still "the last run".
    const d1 = await run(dormant.id, SCAN_RUN_DAYS + 200);

    expect(await pruneNetworkScanRuns()).toBe(2);
    const left = (await prisma.networkScanRun.findMany({ where: { scanId: { in: [busy.id, dormant.id] } }, select: { id: true } })).map((r) => r.id).sort();
    expect(left).toEqual([b3.id, d1.id].sort());
    expect(left).not.toContain(b1.id);
    expect(left).not.toContain(b2.id);
  });

  it("drops hidden-region ids for regions that no longer exist, and keeps the ones that do", async () => {
    const live = (await listRegions())[0];
    const role = await prisma.role.findUnique({ where: { name: "readonly" } });
    const keepIds = live ? [live.id] : [];
    const u = await prisma.user.create({ data: { username: `${PFX}-hider`, passwordHash: "x", roleId: role!.id, authProvider: "local", hiddenMapRegionIds: [...keepIds, "deleted-region-1", "deleted-region-2"] } });
    try {
      expect(await pruneHiddenRegionIds()).toBeGreaterThanOrEqual(2);
      expect((await prisma.user.findUnique({ where: { id: u.id } }))!.hiddenMapRegionIds).toEqual(keepIds);
      expect(await pruneHiddenRegionIds()).toBe(0);
    } finally {
      await prisma.user.delete({ where: { id: u.id } });
    }
  });

  it("deletes tag provenance rows whose tag is gone, and keeps a live tag's", async () => {
    const tag = await prisma.tag.create({ data: { name: `${PFX}-tag` } });
    await prisma.tagAutoAssignment.createMany({ data: [
      { tagId: tag.id, assetId: `${PFX}-asset-a` },
      { tagId: `${PFX}-deleted-tag`, assetId: `${PFX}-asset-a` },
      { tagId: `${PFX}-deleted-tag`, assetId: `${PFX}-asset-b` },
    ] });
    try {
      expect(await pruneOrphanTagAssignments()).toBe(2);
      expect(await prisma.tagAutoAssignment.count({ where: { tagId: tag.id } })).toBe(1);
    } finally {
      await prisma.tagAutoAssignment.deleteMany({ where: { assetId: { startsWith: PFX } } });
      await prisma.tag.delete({ where: { id: tag.id } });
    }
  });

  it("pruneHistory runs every prune and reports each count", async () => {
    await prisma.notification.create({ data: { message: `${PFX} gone`, cleared: true, clearedAt: ago(500) } as never });
    const { result, errors } = await pruneHistory();
    expect(errors).toEqual([]);
    expect(result.alerts).toBeGreaterThanOrEqual(1);
    expect(Object.keys(result).sort()).toEqual(["alerts", "discoveryRuns", "hiddenRegionIds", "ruleStates", "scanRuns", "sightings", "summaries", "tagAssignments"]);
  });
});
