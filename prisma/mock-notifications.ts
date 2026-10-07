/**
 * prisma/mock-notifications.ts — mock data for the Notifications feature.
 *
 * Seeds example notification RULES, breaching telemetry / host-metrics / sensor
 * samples (so the engine fires them live within ~60s), a couple of change/event
 * audit rows (so the event-tail raises notifications for the event/change
 * rules), and a few already-triggered notifications so the View tab + asset tab
 * are populated immediately.
 *
 * Run (inside the dev container), AFTER mock:compare so the mock assets exist:
 *   npm run mock:notifications
 *
 * Idempotent: prior "Mock:" rules + "Mock demo:" notifications are cleared
 * first. Refuses to run with NODE_ENV=production.
 */

import { prisma } from "../src/db.js";

const GB = 1024 * 1024 * 1024;

async function findAsset(hostname: string) {
  return prisma.asset.findFirst({ where: { hostname }, select: { id: true, hostname: true, tags: true } });
}

async function main() {
  if (process.env.NODE_ENV === "production") {
    console.error("Refusing to seed mock data: NODE_ENV=production.");
    process.exit(1);
  }

  // ── Idempotency: clear prior mock rules + channels + demo notifications ──
  await prisma.notificationRule.deleteMany({ where: { name: { startsWith: "Mock:" } } });
  await prisma.notificationChannel.deleteMany({ where: { name: { startsWith: "Mock:" } } });
  await prisma.notification.deleteMany({ where: { message: { startsWith: "Mock demo:" } } });

  const now = new Date();

  // ── Delivery channels (registry) the mock rules route through ──
  const emailChannel = await prisma.notificationChannel.create({
    data: { name: "Mock: NOC email (SMTP)", type: "smtp", enabled: true, createdBy: "system:mock-notifications",
      config: { host: "smtp.example.com", port: 587, security: "starttls", username: "polaris", password: "mock-secret", from: "polaris@example.com" } },
  });
  const slackChannel = await prisma.notificationChannel.create({
    data: { name: "Mock: NOC Slack", type: "slack", enabled: true, createdBy: "system:mock-notifications",
      // Point at a https://webhook.site/<id> URL to watch deliveries arrive.
      config: { webhookUrl: "https://hooks.slack.com/services/MOCK/MOCK/MOCK" } },
  });

  // ── Region-tag a couple of mock assets so the Regions column has data ──
  const fw = await findAsset("core-fw-01");
  const db = await findAsset("db-srv-01");
  const sw = await findAsset("core-sw-01");
  if (fw && !fw.tags.includes("region:Atlanta")) {
    await prisma.asset.update({ where: { id: fw.id }, data: { tags: { set: [...fw.tags, "region:Atlanta"] } } });
  }
  if (db && !db.tags.includes("region:Atlanta")) {
    await prisma.asset.update({ where: { id: db.id }, data: { tags: { set: [...db.tags, "region:Atlanta"] } } });
  }

  // ── Host-metrics samples that breach (mem 92%, cpu 88%) ──
  const hostRows = [];
  for (let i = 0; i < 5; i++) {
    const ts = new Date(now.getTime() - i * 30_000);
    hostRows.push({
      timestamp: ts,
      cpuPct: 88 - i * 0.3,
      memUsedPct: 92 - i * 0.2,
      memUsedBytes: BigInt(Math.round(0.92 * 16 * GB)),
      memTotalBytes: BigInt(16) * BigInt(GB),
      loadAvg1: 7.5, loadAvg5: 6.9, loadAvg15: 6.1,
      procRssBytes: BigInt(900 * 1024 * 1024),
    });
  }
  await prisma.hostMetricsSample.createMany({ data: hostRows });

  // ── A hot temperature sensor on the firewall (78°C > 70) ──
  if (fw) {
    await prisma.assetHardwareSensorSample.deleteMany({ where: { assetId: fw.id, sensorName: "CPU Temp" } });
    await prisma.assetHardwareSensorSample.create({
      data: { assetId: fw.id, timestamp: now, sensorName: "CPU Temp", sensorClass: "temperature", value: 78, unit: "°C", alarmStatus: "alarm" },
    });
  }

  // ── Example rules ──
  const rules = [
    {
      name: "Mock: Polaris host memory high", severity: "error", clearBehavior: "auto",
      trigger: { type: "host_metric", metric: "memUsedPct", aggregation: "latest", windowSec: 0, operator: ">", threshold: 85, forDurationSec: 0 },
      scope: {}, messageTemplate: "Polaris host memory at {value}% (threshold {threshold}%)",
      // email by tag + explicit address — routes through the Mock SMTP channel.
      targets: [{ channelId: emailChannel.id, recipientTags: ["region:Atlanta"], addresses: ["oncall@example.com"] }],
    },
    {
      name: "Mock: Polaris host CPU high", severity: "warning", clearBehavior: "manual",
      trigger: { type: "host_metric", metric: "cpuPct", aggregation: "latest", windowSec: 0, operator: ">", threshold: 80, forDurationSec: 0 },
      scope: {}, messageTemplate: null,
      // Slack channel — posts to the channel's configured webhook destination.
      targets: [{ channelId: slackChannel.id }],
    },
    {
      name: "Mock: Server CPU high", severity: "warning", clearBehavior: "manual",
      trigger: { type: "asset_metric", metric: "cpuPct", aggregation: "latest", windowSec: 0, operator: ">", threshold: 70, forDurationSec: 0 },
      scope: { assetTypes: ["server"] }, messageTemplate: "{asset} CPU at {value}% (threshold {threshold}%)",
    },
    {
      name: "Mock: High device temperature", severity: "error", clearBehavior: "auto",
      trigger: { type: "asset_metric", metric: "hwSensorValue", aggregation: "latest", windowSec: 0, operator: ">", threshold: 70, forDurationSec: 0, dimensionFilter: { sensorClass: "temperature" } },
      scope: { allAssets: true }, messageTemplate: null,
    },
    {
      name: "Mock: Monitor status changed", severity: "warning", clearBehavior: "manual",
      trigger: { type: "event", actionPattern: "monitor.status_changed" },
      scope: {}, messageTemplate: null,
    },
    {
      name: "Mock: LLDP neighbor added", severity: "info", clearBehavior: "manual",
      trigger: { type: "change", changeType: "lldp_neighbor_added" },
      scope: { allAssets: true }, messageTemplate: null,
    },
  ];
  for (const r of rules) {
    await prisma.notificationRule.create({
      data: {
        name: r.name, severity: r.severity, enabled: true,
        trigger: r.trigger as any, scope: r.scope as any,
        clearBehavior: r.clearBehavior, messageTemplate: r.messageTemplate ?? null,
        channels: ["in_app"], targets: (r as any).targets ?? [], createdBy: "system:mock-notifications",
      },
    });
  }

  // ── Audit events the event-tail will turn into notifications (within 15m) ──
  if (sw) {
    await prisma.event.create({
      data: { timestamp: now, level: "warning", levelRank: 1, action: "monitor.status_changed",
        resourceType: "asset", resourceId: sw.id, resourceName: sw.hostname, actor: "system:monitor",
        message: `${sw.hostname} transitioned up → down` },
    });
  }
  if (db) {
    await prisma.event.create({
      data: { timestamp: now, level: "info", levelRank: 0, action: "change.lldp.neighbor_added",
        resourceType: "asset", resourceId: db.id, resourceName: db.hostname, actor: "system:change-detector",
        message: "change.lldp.neighbor_added: new-switch on eth0", details: { change: "change.lldp.neighbor_added" } },
    });
  }

  // ── A few already-triggered notifications so the View tab is populated now ──
  await prisma.notification.createMany({
    data: [
      { severity: "error", assetId: db?.id ?? null, assetHostname: db?.hostname ?? "db-srv-01",
        message: "Mock demo: CPU at 92% on db-srv-01", regionTags: ["Atlanta"], triggeredAt: new Date(now.getTime() - 5 * 60_000) },
      { severity: "warning", assetId: sw?.id ?? null, assetHostname: sw?.hostname ?? "core-sw-01",
        message: "Mock demo: monitor status changed to down", regionTags: [],
        acknowledged: true, acknowledgedBy: "demo.admin", acknowledgedAt: new Date(now.getTime() - 2 * 60_000),
        acknowledgeNote: "Investigated — transient link flap during maintenance window.", triggeredAt: new Date(now.getTime() - 10 * 60_000) },
      { severity: "info", assetId: null, assetHostname: "Polaris host",
        message: "Mock demo: Polaris host memory at 91%", regionTags: [], triggeredAt: new Date(now.getTime() - 15 * 60_000) },
    ],
  });

  console.log("Seeded notification rules + demo notifications. The engine fires the threshold/host/event/change rules within ~60s.");
  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
