/**
 * tests/integration/nocSitesWithIssues.test.ts
 *
 * The Sites with Issues feed against a real database. The unit test mocks
 * every query; this one proves the totals query Postgres actually runs (the
 * COALESCE site key inside a subquery, `= ANY($1::text[])`, the asset-id
 * filter's $2) and the feed's premise: a site is listed by its assets' ACTIVE
 * ALERTS, never by a missed poll. Every call is scoped to this file's assets,
 * which keeps other suites' rows out of the assertions.
 */

import { afterAll, beforeAll, expect, it } from "vitest";
import { prisma } from "../../src/db.js";
import { dbDescribe, dbReachable } from "./_helpers.js";
import * as noc from "../../src/services/nocDashboardService.js";

const HOST = "noc-sites-issues";
const SITE_A = `${HOST} site A`;
const SITE_B = `${HOST} site B`;
const SITE_C = `${HOST} site C`;
let ids: string[] = [];

async function asset(suffix: string, location: string, over: Record<string, unknown> = {}) {
  const a = await prisma.asset.create({
    data: {
      hostname: `${HOST}-${suffix}`, location, status: "active", monitored: true, assetType: "switch",
      monitorStatus: "up", latitude: 36, longitude: -86, ...over,
    } as never,
  });
  return a.id;
}

async function alert(assetId: string, severity: string, cleared = false) {
  await prisma.notification.create({
    data: { assetId, assetHostname: HOST, severity, message: `${HOST} test`, cleared },
  });
}

async function cleanup() {
  const old = await prisma.asset.findMany({ where: { hostname: { startsWith: HOST } }, select: { id: true } });
  const oldIds = old.map((a) => a.id);
  await prisma.notification.deleteMany({ where: { message: `${HOST} test` } });
  if (oldIds.length) await prisma.asset.deleteMany({ where: { id: { in: oldIds } } });
}

beforeAll(async () => {
  if (!dbReachable) return;
  await cleanup();
  // Site A: one critical device, one warning device (with a second, lesser
  // alert), one quiet device — total 3, alerted 2.
  const a1 = await asset("a1", SITE_A);
  const a2 = await asset("a2", SITE_A);
  const a3 = await asset("a3", SITE_A);
  await alert(a1, "critical");
  await alert(a2, "warning");
  await alert(a2, "notice");
  // Site B: a missed poll (monitorStatus warning) and NO alert, plus a device
  // whose only alert has cleared — not an issue either way.
  const b1 = await asset("b1", SITE_B, { monitorStatus: "warning" });
  const b2 = await asset("b2", SITE_B);
  await alert(b2, "critical", true);
  // Site C: alerted, but in maintenance → excluded; a dependency-suppressed
  // child with an alert → excluded.
  const c1 = await asset("c1", SITE_C, { status: "maintenance" });
  const c2 = await asset("c2", SITE_C, { dependencySuppressed: true });
  await alert(c1, "critical");
  await alert(c2, "serious");
  ids = [a1, a2, a3, b1, b2, c1, c2];
});

afterAll(async () => {
  if (!dbReachable) return;
  await cleanup();
});

dbDescribe("Sites with Issues feed", () => {
  it("lists only sites whose assets carry an active alert, with per-severity counts and the site total", async () => {
    const r = await noc.getSitesWithIssues(25, ids);
    expect(r.map((s) => s.site)).toEqual([SITE_A]);
    expect(r[0]).toMatchObject({
      alertSeverity: "critical", alertedCount: 2, severityCounts: { critical: 1, warning: 1 },
      total: 3, lat: 36, lng: -86,
    });
    expect(r[0].nodes.map((n) => n.alertSeverity)).toEqual(["critical", "warning"]);
  });

  it("runs the totals query unscoped too", async () => {
    const r = await noc.getSitesWithIssues(null, null);
    const a = r.find((s) => s.site === SITE_A);
    expect(a).toMatchObject({ total: 3, alertedCount: 2 });
    expect(r.find((s) => s.site === SITE_B)).toBeUndefined();
    expect(r.find((s) => s.site === SITE_C)).toBeUndefined();
  });
});
