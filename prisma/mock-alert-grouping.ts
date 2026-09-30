/**
 * prisma/mock-alert-grouping.ts — the grouped-alerts scenario (business rule 75).
 *
 * Seeds the case the feature exists for and cannot be seen without: a switch
 * whose power supply browned out, faulting SEVERAL PoE ports at once, plus a
 * second condition on the same device so the AlertGroup half has something to
 * fold across.
 *
 * What it creates:
 *   - `mock-sw-idf3`, a monitored 24-port switch with 8 PoE ports in `fault`
 *     (and healthy/idle ports either side, so the alert has to be selective);
 *   - "Mock: PoE port fault", a per-component automation with `groupByAsset`
 *     ON — eight faulted ports, ONE alert;
 *   - "Mock: Switch uplink down", a second automation on the same device;
 *   - "Mock: Switch health", an AlertGroup holding both — so whatever they
 *     raise about sw-idf3 folds into a single alert, delivered by the group.
 *
 * The engine tick is 60s, so the alerts appear on their own shortly after this
 * runs. Nothing here writes a Notification by hand: the point is to watch the
 * REAL fire path fold them, which a hand-written row would not prove.
 *
 * Run (inside the dev container), after mock:compare:
 *   npm run mock:alert-grouping
 *
 * Idempotent: clears its own "Mock: " rules, group and device first. Refuses
 * to run with NODE_ENV=production.
 */

import { prisma } from "../src/db.js";

const HOSTNAME = "mock-sw-idf3";
const GROUP_NAME = "Mock: Switch health";
const POE_RULE = "Mock: PoE port fault";
const UPLINK_RULE = "Mock: Switch uplink down";

/** The eight ports the failing PSU took down, with the kit that was on them —
 *  the alias is what the alert renders, so it is worth being real. */
const FAULTED: { ifName: string; alias: string }[] = [
  { ifName: "port2", alias: "AP-IDF3-Lobby" },
  { ifName: "port5", alias: "AP-IDF3-Corridor" },
  { ifName: "port6", alias: "CAM-IDF3-Door" },
  { ifName: "port9", alias: "AP-IDF3-Breakroom" },
  { ifName: "port12", alias: "CAM-IDF3-Dock" },
  { ifName: "port14", alias: "AP-IDF3-Office-N" },
  { ifName: "port18", alias: "Phone-IDF3-Recept" },
  { ifName: "port21", alias: "AP-IDF3-Warehouse" },
];

async function main() {
  if (process.env.NODE_ENV === "production") {
    console.error("Refusing to seed mock data: NODE_ENV=production.");
    process.exit(1);
  }

  // ── Idempotency ───────────────────────────────────────────────────────────
  // Order matters: the rules reference the group, and the interfaces cascade
  // from the asset.
  await prisma.notificationRule.deleteMany({ where: { name: { in: [POE_RULE, UPLINK_RULE] } } });
  await prisma.alertGroup.deleteMany({ where: { name: GROUP_NAME } });
  const prior = await prisma.asset.findFirst({ where: { hostname: HOSTNAME }, select: { id: true } });
  if (prior) {
    await prisma.notification.deleteMany({ where: { assetId: prior.id } });
    await prisma.asset.delete({ where: { id: prior.id } });
  }

  const now = new Date();

  // ── The switch ────────────────────────────────────────────────────────────
  // `monitored` is required for ANY automation to fire about it (business rule
  // 37), and `status: active` keeps it out of the unmonitorable set (rule 10).
  const sw = await prisma.asset.create({
    data: {
      hostname: HOSTNAME,
      ipAddress: "10.90.3.11",
      assetType: "switch",
      manufacturer: "Fortinet",
      model: "FortiSwitch 224E-POE",
      status: "active",
      monitored: true,
      monitorStatus: "up",
      lastSeen: now,
      lastMonitorAt: now,
      tags: ["mock-alert-grouping"],
      notes: "Seeded by mock:alert-grouping — the grouped-alerts scenario (business rule 75).",
    },
    select: { id: true, hostname: true },
  });

  // ── Its ports ─────────────────────────────────────────────────────────────
  // The PoE-fault carve-out reads AssetInterface directly rather than the
  // sample table (rule 57), with a 48h `lastSeen` floor — so these rows ARE
  // the readings, and they must be fresh.
  //
  // RFC 3621 vocabulary: `searching` is an empty port, `disabled` a switched-
  // off one, `delivering` a working one. Only `fault` means the PSE detected a
  // powered device and failed to power it, which is why the carve-out is
  // `== fault` and not `!= delivering`.
  const ports: {
    ifName: string; alias: string | null; poeStatus: string | null;
    operStatus: string; adminStatus: string; poeClass: string | null;
  }[] = [];

  for (const f of FAULTED) {
    ports.push({ ifName: f.ifName, alias: f.alias, poeStatus: "fault", operStatus: "down", adminStatus: "up", poeClass: "class4" });
  }
  // Healthy powered ports — these must NOT appear on the alert.
  for (const [ifName, alias] of [["port1", "AP-IDF3-Stair"], ["port3", "CAM-IDF3-Yard"], ["port7", "Phone-IDF3-Desk"]] as const) {
    ports.push({ ifName, alias, poeStatus: "delivering", operStatus: "up", adminStatus: "up", poeClass: "class4" });
  }
  // Empty and switched-off PoE ports — the storm the pin gate exists to stop.
  // An `!= delivering` rule would name all of these; `== fault` must not.
  for (let i = 0; i < 10; i++) {
    ports.push({ ifName: `port${22 + i}`, alias: null, poeStatus: "searching", operStatus: "down", adminStatus: "up", poeClass: null });
  }
  ports.push({ ifName: "port4", alias: "(reserved)", poeStatus: "disabled", operStatus: "down", adminStatus: "down", poeClass: null });
  // Two non-PoE uplinks. The uplink automation is about these.
  ports.push({ ifName: "uplink1", alias: "to core-1", poeStatus: null, operStatus: "up", adminStatus: "up", poeClass: null });
  ports.push({ ifName: "uplink2", alias: "to core-2", poeStatus: null, operStatus: "down", adminStatus: "up", poeClass: null });

  await prisma.assetInterface.createMany({
    data: ports.map((p) => ({
      assetId: sw.id,
      ifName: p.ifName,
      alias: p.alias,
      poeStatus: p.poeStatus,
      poeClass: p.poeClass,
      operStatus: p.operStatus,
      adminStatus: p.adminStatus,
      ifType: "ethernetCsmacd",
      firstSeen: now,
      lastSeen: now,
    })),
  });

  // ── The group, and the two automations that deliver through it ────────────
  // The group owns DELIVERY; the automations own DETECTION. Neither rule
  // carries a notify action of its own here — the group does the telling,
  // which is exactly the shape the removal-impact warning is about.
  const group = await prisma.alertGroup.create({
    data: {
      name: GROUP_NAME,
      description: "Everything wrong with one access switch, as one alert.",
      enabled: true,
      requireAckNote: false,
      // An audit Event per fire, and nothing else: this dev stack has no SMTP
      // channel, and a notify action pointing at a channel that cannot send
      // would fail the delivery rather than demonstrate the fold.
      actions: [{ type: "event" }],
      repeat: { everyMin: 15, stopOn: "acknowledge" },
      createdBy: "system:mock-alert-grouping",
    },
    select: { id: true, name: true },
  });

  const poeRule = await prisma.notificationRule.create({
    data: {
      name: POE_RULE,
      description: "A PoE port detected a powered device and failed to power it.",
      enabled: true,
      severity: "serious",
      trigger: {
        type: "asset_state",
        field: "poeStatus",
        operator: "==",
        value: "fault",
        // No forPolls hold: an unpinned PoE reading counts FULL SCRAPES
        // (600s default), so a hold here would mean waiting ten minutes per
        // count before anything appeared.
      },
      scope: { assetIds: [sw.id] },
      reset: { mode: "auto" },
      actions: [{ type: "event" }],
      channels: ["in_app"],
      // THE POINT: eight faulted ports, one alert.
      groupByAsset: true,
      alertGroupId: group.id,
      createdBy: "system:mock-alert-grouping",
    },
    select: { id: true, name: true },
  });

  const uplinkRule = await prisma.notificationRule.create({
    data: {
      name: UPLINK_RULE,
      description: "A switch uplink is down.",
      enabled: true,
      severity: "critical",
      trigger: { type: "asset_state", field: "ifOperStatus", operator: "==", value: "down" },
      scope: { assetIds: [sw.id] },
      reset: { mode: "auto" },
      actions: [{ type: "event" }],
      channels: ["in_app"],
      groupByAsset: true,
      alertGroupId: group.id,
      createdBy: "system:mock-alert-grouping",
    },
    select: { id: true, name: true },
  });

  // `ifOperStatus` is PIN-gated (rule 57 — only the PoE FAULT value is carved
  // out), so the uplink automation sees nothing unless its port is pinned.
  // That gate is the reason the second automation needs this line and the
  // first does not.
  await prisma.asset.update({
    where: { id: sw.id },
    data: { monitoredInterfaces: ["uplink1", "uplink2"] },
  });

  // …and the pin is only half of it. `ifOperStatus` reads the SAMPLE table;
  // only the PoE fault VALUE is carved out to read current state (rule 57b),
  // so an AssetInterface row alone gives the uplink automation nothing to see.
  // Without these samples the second automation never contributes and the
  // cross-automation fold cannot be observed at all — which is the whole
  // point of the group.
  //
  // A short series rather than one row: the engine reads the newest sample
  // that CARRIES the field, and a single row is indistinguishable from a
  // collection gap if anything else writes one.
  const sampleRows: { assetId: string; timestamp: Date; ifName: string; operStatus: string; adminStatus: string; alias: string | null }[] = [];
  for (let i = 0; i < 5; i++) {
    const ts = new Date(now.getTime() - i * 60_000);
    sampleRows.push({ assetId: sw.id, timestamp: ts, ifName: "uplink2", operStatus: "down", adminStatus: "up", alias: "to core-2" });
    sampleRows.push({ assetId: sw.id, timestamp: ts, ifName: "uplink1", operStatus: "up", adminStatus: "up", alias: "to core-1" });
  }
  await prisma.assetInterfaceSample.createMany({ data: sampleRows });

  console.log(`Seeded ${sw.hostname}: ${FAULTED.length} faulted PoE ports, ${ports.length} interfaces total.`);
  console.log(`  Group:      ${group.name}`);
  console.log(`  Automations: ${poeRule.name}, ${uplinkRule.name}`);
  console.log("");
  console.log("Within ~60s the engine should raise ONE alert for this device naming every");
  console.log("affected port — not eight, and not one per automation. Watch it at");
  console.log("Dashboard → Active Alerts, or on the device's Alerts tab.");
}

main()
  .catch((err) => { console.error(err); process.exit(1); })
  .finally(async () => { await prisma.$disconnect(); });
