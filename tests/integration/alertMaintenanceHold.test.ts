/**
 * tests/integration/alertMaintenanceHold.test.ts
 *
 * Business rule 16 on the alert feeds: a maintenance window FREEZES an alert
 * that is already open (only down alerts are retired, 16(a)), so the alert
 * stays listed while paging nobody. The two feeds that list alerts say so:
 * `maintenanceHold` is "self" for a device in a window, "upstream" for one
 * suppressed behind a device in a window, null otherwise — including for a
 * device suppressed behind a parent that is merely DOWN, whose rule 78
 * dependency-down alert stays live and once wore MAINT for a window nobody
 * opened.
 *
 *  - maintenanceHoldsByAsset answers per asset, with one query;
 *  - the Active Alerts feed (getRecentAlerts) stamps every row;
 *  - the asset Alerts tab (getAssetNotifications) stamps every row of the tab.
 */

import { afterAll, beforeEach, expect, it } from "vitest";
import { prisma } from "../../src/db.js";
import { dbDescribe, dbReachable } from "./_helpers.js";
import { maintenanceHoldsByAsset, getAssetNotifications } from "../../src/services/notificationService.js";
import { getRecentAlerts } from "../../src/services/nocDashboardService.js";

const d = dbDescribe;
const HOST = "maint-hold-test";

const ids: Record<"held" | "child" | "plain" | "downGate" | "depChild", string> = {
  held: "", child: "", plain: "", downGate: "", depChild: "",
};

async function wipe(): Promise<void> {
  const assets = await prisma.asset.findMany({ where: { hostname: { startsWith: HOST } }, select: { id: true } });
  if (assets.length) {
    const aIds = assets.map((a) => a.id);
    await prisma.notification.deleteMany({ where: { assetId: { in: aIds } } });
    await prisma.asset.deleteMany({ where: { id: { in: aIds } } });
  }
}

async function seedAsset(name: string, data: Record<string, unknown>, alert: Record<string, unknown> = {}): Promise<string> {
  const a = await prisma.asset.create({
    data: { hostname: `${HOST}-${name}`, status: "active", monitored: true, assetType: "firewall", ...data } as never,
  });
  await prisma.notification.create({
    data: { assetId: a.id, assetHostname: `${HOST}-${name}`, severity: "warning", message: `${name} loss`, dimension: "Internet|wan1", ...alert } as never,
  });
  return a.id;
}

async function seedEdge(child: string, parent: string): Promise<void> {
  await prisma.assetDependencyParent.create({
    data: { assetId: child, parentAssetId: parent, source: "computed", detectedVia: "controller" },
  });
}

d("maintenance hold on the alert feeds (business rule 16)", () => {
  beforeEach(async () => {
    await wipe();
    ids.held = await seedAsset("held", { status: "maintenance" });
    ids.child = await seedAsset("child", { dependencySuppressed: true });
    await seedEdge(ids.child, ids.held);
    ids.plain = await seedAsset("plain", {});
    // The incident: the site gate is DOWN (no window anywhere), and a down
    // automation that opted in (rule 78) raised a dependency-down alert for
    // the server behind it.
    ids.downGate = await seedAsset("downgate", { monitorStatus: "down" });
    ids.depChild = await seedAsset("depchild", { assetType: "server", dependencySuppressed: true }, { dependencyDown: true });
    await seedEdge(ids.depChild, ids.downGate);
  });

  afterAll(async () => {
    if (dbReachable) await wipe();
  });

  it("answers self / upstream per asset and leaves the rest out", async () => {
    const holds = await maintenanceHoldsByAsset([ids.held, ids.child, ids.plain, ids.depChild, ""]);
    expect(holds.get(ids.held)).toBe("self");
    expect(holds.get(ids.child)).toBe("upstream");
    expect(holds.has(ids.plain)).toBe(false);
    expect(holds.has(ids.depChild)).toBe(false);
    expect((await maintenanceHoldsByAsset([])).size).toBe(0);
  });

  it("stamps every Active Alerts row", async () => {
    const { alerts } = await getRecentAlerts(null, [ids.held, ids.child, ids.plain, ids.depChild]);
    const byAsset = new Map(alerts.map((a) => [a.assetId, a.maintenanceHold]));
    expect(byAsset.get(ids.held)).toBe("self");
    expect(byAsset.get(ids.child)).toBe("upstream");
    expect(byAsset.get(ids.plain)).toBeNull();
    expect(byAsset.get(ids.depChild)).toBeNull();
  });

  it("stamps the asset Alerts tab's rows", async () => {
    expect((await getAssetNotifications(ids.held)).active.map((r) => r.maintenanceHold)).toEqual(["self"]);
    expect((await getAssetNotifications(ids.plain)).active.map((r) => r.maintenanceHold)).toEqual([null]);
    expect((await getAssetNotifications(ids.child)).active.map((r) => r.maintenanceHold)).toEqual(["upstream"]);
    expect((await getAssetNotifications(ids.depChild)).active.map((r) => r.maintenanceHold)).toEqual([null]);
  });
});
