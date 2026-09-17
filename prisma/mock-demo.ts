/**
 * prisma/mock-demo.ts — presentation polish for the seeded demo fleet, so the
 * documentation screenshots (scripts/capture-screenshots.mjs) show a system
 * that is actually being monitored rather than one that has never polled.
 *
 * The other seeds get the rows in place but leave every monitored asset with
 * `monitorStatus = null`, which the UI labels "Pending" — so the Assets table,
 * the NOC status tiles and every health widget read as a fresh install that has
 * not done anything yet. This script stamps a plausible steady state: mostly
 * up, one down, one missing polls, with staggered transition times so the
 * "how long has this been down" durations are not all identical.
 *
 * It also takes the word "Mock" out of the alert feed. mock-notifications.ts
 * prefixes its rules "Mock: " and its pre-triggered rows "Mock demo: " so it
 * can clear its own work on a re-run — sensible for a dev seed, wrong in a
 * screenshot, where it reads as if the product shipped placeholder alerts.
 *
 * Run (inside the dev container) LAST, after db:seed + seed-review-assets +
 * mock:compare + mock:notifications:
 *   npm run mock:demo
 *
 * Idempotent: every write is an absolute assignment or a prefix strip, and the
 * rename drops an already-stripped twin first, so re-running this after another
 * mock:notifications cannot leave two copies of a rule behind.
 * Refuses to run with NODE_ENV=production.
 */

import { prisma } from "../src/db.js";

// hostname → the state it should present in a screenshot. Everything monitored
// and not named here is set "up". Two deliberate exceptions so the status
// tiles, the Down Nodes widget and the alert feed all have something to show.
const DOWN = "MEMP-SCALE-PC";
const MISSED = "ASHF-CORE-SW2";

const MIN = 60_000;

async function main() {
  if (process.env.NODE_ENV === "production") {
    throw new Error("mock-demo.ts refuses to run with NODE_ENV=production");
  }

  const assets = await prisma.asset.findMany({
    where:  { monitored: true },
    select: { id: true, hostname: true, assetType: true },
  });

  if (assets.length === 0) {
    console.log("No monitored assets — run db:seed, seed-review-assets.ts and mock:compare first.");
    return;
  }

  const now = Date.now();
  const updates = assets.map((a, i) => {
    const isDown = a.hostname === DOWN;
    const isMissed = a.hostname === MISSED;
    const status = isDown ? "down" : isMissed ? "warning" : "up";

    // Staggered so the durations differ: the outage is ~37m old, the missed
    // poll ~6m, and the healthy devices last changed state hours ago.
    const changedMinutesAgo = isDown ? 37 : isMissed ? 6 : 180 + i * 47;

    // Firewalls and switches answer faster than the workstations/servers here;
    // a down device keeps its last successful reading.
    const base = a.assetType === "firewall" || a.assetType === "switch" ? 3 : 12;

    return prisma.asset.update({
      where: { id: a.id },
      data:  {
        monitorStatus:          status,
        monitorStatusChangedAt: new Date(now - changedMinutesAgo * MIN),
        // A down device's last successful poll is the moment it went down; the
        // rest polled on the most recent tick.
        lastMonitorAt:          isDown ? new Date(now - 37 * MIN) : new Date(now - 20_000),
        lastResponseTimeMs:     base + ((i * 7) % 9),
        // Whole seconds of device uptime — a few days, varied per device.
        lastUptimeSec:          86_400 * (3 + (i % 9)) + i * 613,
      },
    });
  });

  await prisma.$transaction(updates);

  const down = assets.filter((a) => a.hostname === DOWN).length;
  const missed = assets.filter((a) => a.hostname === MISSED).length;
  console.log(
    `Demo monitor state: ${assets.length} monitored assets ` +
      `(${assets.length - down - missed} up, ${down} down, ${missed} missed).`,
  );

  await deMock();
}

// Strip the dev-seed prefixes out of everything an operator can see.
async function deMock() {
  // 1. Rule names: "Mock: Server CPU high" → "Server CPU high". Any rule that
  //    already carries the stripped name is removed first, so a second pass
  //    (mock:notifications re-seeded the "Mock: " twins) collapses back to one.
  const mockRules = await prisma.notificationRule.findMany({
    where:  { name: { startsWith: "Mock: " } },
    select: { id: true, name: true },
  });
  let renamed = 0;
  for (const rule of mockRules) {
    const clean = rule.name.slice("Mock: ".length);
    await prisma.notificationRule.deleteMany({ where: { name: clean, id: { not: rule.id } } });
    await prisma.notificationRule.update({ where: { id: rule.id }, data: { name: clean } });
    renamed++;
  }

  // 2. Alert bodies carry the prefix inline, and the temperature rule's
  //    dimension is the widget name "Mock CPU Temp".
  const noisy = await prisma.notification.findMany({
    where: {
      OR: [
        { message: { contains: "Mock" } },
        { dimension: { contains: "Mock" } },
      ],
    },
    select: { id: true, message: true, dimension: true },
  });
  let cleaned = 0;
  for (const n of noisy) {
    const message = n.message
      .replace(/^Mock demo: /, "")
      .replace(/^Mock: /, "")
      .replace(/Mock CPU Temp/g, "CPU Temp");
    const dimension = n.dimension ? n.dimension.replace(/^Mock /, "") : n.dimension;
    if (message !== n.message || dimension !== n.dimension) {
      await prisma.notification.update({ where: { id: n.id }, data: { message, dimension } });
      cleaned++;
    }
  }

  // 3. mock-notifications seeds a few already-triggered rows with no rule
  //    behind them. The alert feed takes a row's TITLE from its rule, so those
  //    render as a bare severity pill with no headline — which looks like a
  //    broken widget rather than demo data.
  const orphans = await prisma.notification.deleteMany({ where: { ruleId: null } });

  console.log(
    `De-mocked: ${renamed} rule name${renamed === 1 ? "" : "s"}, ` +
      `${cleaned} alert message${cleaned === 1 ? "" : "s"}, ` +
      `${orphans.count} rule-less alert${orphans.count === 1 ? "" : "s"} removed.`,
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
