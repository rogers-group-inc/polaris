/**
 * tests/integration/dependencyDownAckInherit.test.ts
 *
 * Business rule 78a against a real database: acknowledging a gate's own down
 * alert acknowledges the dependency-down alerts whose ROOT CAUSE is that gate
 * (the JSON-path match on `dependencyBlame.rootCause.id`), copies the note,
 * stamps `acknowledgedVia`, and the Active Alerts feed hands the root cause's
 * name to the ack pill. An alert naming a different root, or naming this gate
 * only as an in-maintenance root, is left alone.
 */

import { afterAll, beforeEach, expect, it } from "vitest";
import { prisma } from "../../src/db.js";
import { dbDescribe } from "./_helpers.js";
import { acknowledgeNotifications, rootCauseAckFor } from "../../src/services/notificationService.js";
import { getRecentAlerts } from "../../src/services/nocDashboardService.js";

const d = dbDescribe;
const HOST = "dep-ack-inherit-test";

async function wipe(): Promise<void> {
  const assets = await prisma.asset.findMany({ where: { hostname: { startsWith: HOST } }, select: { id: true } });
  const aIds = assets.map((a) => a.id);
  await prisma.notification.deleteMany({ where: { assetHostname: { startsWith: HOST } } });
  if (aIds.length) await prisma.asset.deleteMany({ where: { id: { in: aIds } } });
}

async function seedAsset(name: string): Promise<string> {
  const a = await prisma.asset.create({
    data: { hostname: `${HOST}-${name}`, status: "active", monitored: true, assetType: "firewall" } as never,
  });
  return a.id;
}

async function seedAlert(assetId: string, name: string, data: Record<string, unknown>): Promise<string> {
  const n = await prisma.notification.create({
    data: { assetId, assetHostname: `${HOST}-${name}`, severity: "critical", message: `${name} down`, ...data } as never,
  });
  return n.id;
}

const blame = (rootId: string, rootName: string, reason = "down") => ({
  upstream: { id: rootId, hostname: rootName },
  rootCause: { id: rootId, hostname: rootName, reason },
  chain: [{ id: rootId, hostname: rootName, reason }],
  hops: 1,
  truncated: false,
  ownStatus: "down",
});

d("a dependency-down alert inherits its root cause's acknowledgement (business rule 78a)", () => {
  const ids = { gate: "", otherGate: "", rootAlert: "", depA: "", depB: "", depOther: "", depMaint: "" };

  beforeEach(async () => {
    await wipe();
    ids.gate = await seedAsset("gate");
    ids.otherGate = await seedAsset("othergate");
    const plcA = await seedAsset("plc-a");
    const plcB = await seedAsset("plc-b");
    const plcC = await seedAsset("plc-c");
    const plcD = await seedAsset("plc-d");
    ids.rootAlert = await seedAlert(ids.gate, "gate", { metric: "monitorStatus" });
    const gateName = `${HOST}-gate`;
    ids.depA = await seedAlert(plcA, "plc-a", { metric: "monitorStatus", dependencyDown: true, dependencyBlame: blame(ids.gate, gateName) });
    ids.depB = await seedAlert(plcB, "plc-b", { metric: "monitorStatus", dependencyDown: true, dependencyBlame: blame(ids.gate, gateName) });
    ids.depOther = await seedAlert(plcC, "plc-c", { metric: "monitorStatus", dependencyDown: true, dependencyBlame: blame(ids.otherGate, `${HOST}-othergate`) });
    ids.depMaint = await seedAlert(plcD, "plc-d", { metric: "monitorStatus", dependencyDown: true, dependencyBlame: blame(ids.gate, gateName, "maintenance") });
  });

  afterAll(async () => {
    await wipe();
  });

  it("cascades to the dependency alerts naming the gate as a DOWN root cause, and no others", async () => {
    const count = await acknowledgeNotifications([ids.rootAlert], "jsmith", "ISP fibre cut, ticket 4411");
    expect(count).toBe(1);

    const rows = await prisma.notification.findMany({
      where: { id: { in: [ids.depA, ids.depB, ids.depOther, ids.depMaint] } },
      select: { id: true, acknowledged: true, acknowledgedBy: true, acknowledgeNote: true, acknowledgedVia: true },
    });
    const byId = new Map(rows.map((r) => [r.id, r]));
    for (const id of [ids.depA, ids.depB]) {
      expect(byId.get(id)).toMatchObject({
        acknowledged: true,
        acknowledgedBy: "jsmith",
        acknowledgeNote: "ISP fibre cut, ticket 4411",
        acknowledgedVia: { notificationId: ids.rootAlert, assetId: ids.gate, hostname: `${HOST}-gate` },
      });
    }
    expect(byId.get(ids.depOther)!.acknowledged).toBe(false);
    expect(byId.get(ids.depMaint)!.acknowledged).toBe(false);

    const events = await prisma.event.findMany({
      where: { action: "notification.acknowledged", actor: "jsmith" },
      orderBy: { timestamp: "desc" },
      take: 5,
    });
    expect(events.some((e) => (e.details as { inheritedFrom?: string[] } | null)?.inheritedFrom?.includes(ids.rootAlert))).toBe(true);
  });

  it("the Active Alerts feed names the root cause on an inherited acknowledgement only", async () => {
    await acknowledgeNotifications([ids.rootAlert], "jsmith", "ISP fibre cut");
    const feed = await getRecentAlerts(null);
    const row = (id: string) => feed.alerts.find((a) => a.id === id)!;
    expect(row(ids.depA).ackInheritedFrom).toBe(`${HOST}-gate`);
    expect(row(ids.depA).acknowledgeNote).toBe("ISP fibre cut");
    // The gate's own alert was acknowledged directly.
    expect(row(ids.rootAlert).ackInheritedFrom).toBeNull();
    expect(row(ids.depOther).ackInheritedFrom).toBeNull();
  });

  it("rootCauseAckFor finds the acknowledged root alert, and nothing before it is acknowledged", async () => {
    expect(await rootCauseAckFor(ids.gate)).toBeNull();
    await acknowledgeNotifications([ids.rootAlert], "jsmith", "on it");
    expect(await rootCauseAckFor(ids.gate)).toMatchObject({
      notificationId: ids.rootAlert, assetId: ids.gate, acknowledgedBy: "jsmith", acknowledgeNote: "on it",
    });
  });

  it("acknowledging a dependency alert acknowledges nothing upstream", async () => {
    await acknowledgeNotifications([ids.depA], "plant-op", "seen");
    const root = await prisma.notification.findUnique({ where: { id: ids.rootAlert }, select: { acknowledged: true } });
    expect(root!.acknowledged).toBe(false);
  });
});
