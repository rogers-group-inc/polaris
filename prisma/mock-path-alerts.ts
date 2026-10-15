/**
 * prisma/mock-path-alerts.ts — the Path Monitor alert scenario.
 *
 * Seeds what is needed to SEE, in a real inbox, a path alert email with its
 * traceroute path graph, both ungrouped and grouped — and the grouped alert's
 * first-send hold (business rule 75) folding hosts that fail one poll apart
 * into one first email.
 *
 * What it creates:
 *   - three agent hosts `mock-plant-pc-01..03` (monitored, an ACTIVE agent row
 *     each — a Path Monitor automation only watches agent hosts);
 *   - "Mock: ERP HTTPS" (every 120 s) run from all three, and "Mock: VPN TCP"
 *     (every 120 s) run from pc-01 only, each with traceroutes — older traces
 *     that took a different branch, newest ones that stop short;
 *   - "Mock: ERP unreachable" (pathOk == 0 on the ERP check) inside the
 *     AlertGroup "Mock: Path Monitor", folded ONE ALERT PER AUTOMATION and
 *     emailing noc@example.test through the SMTP channel "Mock: Mailpit";
 *   - "Mock: VPN unreachable", the same trigger on the VPN check, NOT grouped,
 *     emailing directly — the ungrouped email with its one graph.
 *
 * Run (inside the dev container): `npm run mock:path-alerts` seeds and then
 * keeps writing one result per host per check every 120 s, so the alerts stay
 * up. The ERP check starts failing on pc-01 at once, on pc-02 one poll later
 * (it joins during the hold, so it is in the first email) and on pc-03 two
 * polls later (after the release, so it arrives as an [UPDATED] email).
 * `--once` seeds and exits. Ctrl-C (or killing it) stops the results; the
 * alerts then go quiet and clear as for any agent that stopped reporting.
 *
 * Mail goes to MAILPIT_HOST:MAILPIT_PORT (defaults `mailpit`:1025 — the
 * container name a dev stack's Mailpit is reachable by on the compose network).
 *
 * Idempotent: clears its own "Mock: " checks, rules, group, channel and hosts
 * first. Refuses to run with NODE_ENV=production.
 */

import { prisma } from "../src/db.js";

const HOSTS = ["mock-plant-pc-01", "mock-plant-pc-02", "mock-plant-pc-03"];
const ERP_CHECK = "Mock: ERP HTTPS";
const VPN_CHECK = "Mock: VPN TCP";
const ERP_RULE = "Mock: ERP unreachable";
const VPN_RULE = "Mock: VPN unreachable";
const GROUP = "Mock: Path Monitor";
const CHANNEL = "Mock: Mailpit";
const INTERVAL_SEC = 120;

/** Which poll (0 = the first) each host's ERP check starts failing on. */
const ERP_FAILS_FROM: Record<string, number> = { "mock-plant-pc-01": 0, "mock-plant-pc-02": 1, "mock-plant-pc-03": 2 };

type Hop = { ttl: number; ip: string | null; rdns?: string; hostname?: string; rttMs: number[] };

function route(variant: "a" | "b", complete: boolean, dest: string, destName: string, slowMs: number): { complete: boolean; hops: Hop[] } {
  const hops: Hop[] = [
    { ttl: 1, ip: "10.40.0.1", hostname: "plant-gw-01", rttMs: [0.9, 1.1, 1.0] },
    variant === "a"
      ? { ttl: 2, ip: "198.51.100.1", rdns: "isp-edge-1.example", rttMs: [7.8, 8.4, 8.1] }
      : { ttl: 2, ip: "198.51.100.9", rdns: "isp-edge-2.example", rttMs: [9.1, 9.4, 9.0] },
    { ttl: 3, ip: null, rttMs: [-1, -1, -1] },
    { ttl: 4, ip: "203.0.113.5", rdns: "core-1.example", rttMs: [19.5, 21.0, 20.2, -1] },
  ];
  if (complete) hops.push({ ttl: 5, ip: dest, hostname: destName, rttMs: [slowMs, slowMs + 2, slowMs - 1] });
  return { complete, hops };
}

async function wipe(): Promise<void> {
  const rules = await prisma.notificationRule.findMany({ where: { name: { in: [ERP_RULE, VPN_RULE] } }, select: { id: true } });
  const ruleIds = rules.map((r) => r.id);
  if (ruleIds.length) {
    await prisma.notificationRuleState.deleteMany({ where: { ruleId: { in: ruleIds } } });
    await prisma.notification.deleteMany({ where: { ruleId: { in: ruleIds } } });
    await prisma.notificationRule.deleteMany({ where: { id: { in: ruleIds } } });
  }
  await prisma.alertGroup.deleteMany({ where: { name: GROUP } });
  const checks = await prisma.pathCheck.findMany({ where: { name: { in: [ERP_CHECK, VPN_CHECK] } }, select: { id: true } });
  const checkIds = checks.map((c) => c.id);
  if (checkIds.length) {
    await prisma.assetPathCheckSample.deleteMany({ where: { checkId: { in: checkIds } } });
    await prisma.assetPathCheckTraceroute.deleteMany({ where: { checkId: { in: checkIds } } });
    await prisma.pathCheck.deleteMany({ where: { id: { in: checkIds } } });
  }
  await prisma.asset.deleteMany({ where: { hostname: { in: HOSTS } } });
  await prisma.notificationChannel.deleteMany({ where: { name: CHANNEL } });
}

async function main(): Promise<void> {
  if (process.env.NODE_ENV === "production") {
    console.error("Refusing to seed mock data: NODE_ENV=production.");
    process.exit(1);
  }
  const once = process.argv.includes("--once");
  await wipe();
  const now = new Date();

  const hostIds: Record<string, string> = {};
  for (const [i, hostname] of HOSTS.entries()) {
    const a = await prisma.asset.create({
      data: {
        hostname, ipAddress: `10.40.1.${11 + i}`, status: "active", assetType: "workstation", monitored: true,
        monitorStatus: "up", lastSeen: now, lastMonitorAt: now, tags: ["mock-path"],
      } as never,
      select: { id: true },
    });
    hostIds[hostname] = a.id;
    await prisma.managedAgent.create({
      data: {
        assetId: a.id, osPlatform: "windows", arch: "amd64", agentVersion: "0.25.0", installStatus: "active",
        installedBy: "system:mock-path-alerts", serverCertFingerprint: "mock",
      } as never,
    });
  }

  const tr = { enabled: true, everyNRuns: 1, maxHops: 20, probesPerHop: 3 };
  const mkCheck = (name: string, kind: string, target: string, ids: string[]) =>
    prisma.pathCheck.create({
      data: {
        name, kind, target, intervalSec: INTERVAL_SEC, timeoutMs: 5000, traceroute: tr,
        scope: { assetIds: ids }, assetIds: ids, definitionSha256: "0".repeat(64),
        ...(kind === "https" ? { http: { method: "GET", expectStatus: [200] } } : {}),
      } as never,
      select: { id: true },
    });
  const allIds = HOSTS.map((h) => hostIds[h]!);
  const erp = await mkCheck(ERP_CHECK, "https", "https://erp.example.test/health", allIds);
  const vpn = await mkCheck(VPN_CHECK, "tcp", "vpn.example.test:443", [hostIds[HOSTS[0]!]!]);
  await prisma.pathCheckSource.createMany({
    data: [
      ...allIds.map((assetId) => ({ checkId: erp.id, assetId, explicit: true })),
      { checkId: vpn.id, assetId: hostIds[HOSTS[0]!]!, explicit: true },
    ],
  });

  // Half an hour of healthy history, so the Paths tab has a line to break.
  const history: object[] = [];
  for (let k = 15; k >= 1; k--) {
    const ts = new Date(now.getTime() - k * INTERVAL_SEC * 1000);
    for (const id of allIds) history.push({ assetId: id, checkId: erp.id, timestamp: ts, ok: true, latencyMs: 60 + (k % 5), httpStatus: 200 });
    history.push({ assetId: allIds[0], checkId: vpn.id, timestamp: ts, ok: true, latencyMs: 30 + (k % 3) });
  }
  await prisma.assetPathCheckSample.createMany({ data: history as never });

  // Older traces took the other ISP edge and got through.
  for (const [i, id] of allIds.entries()) {
    for (const k of [12, 8, 4]) {
      const r = route(k === 8 ? "b" : "a", true, "192.0.2.10", "erp.example.test", 62 + i * 4);
      await prisma.assetPathCheckTraceroute.create({
        data: { assetId: id, checkId: erp.id, timestamp: new Date(now.getTime() - k * INTERVAL_SEC * 1000), destinationIp: "192.0.2.10", complete: true, hopCount: r.hops.length, pathHash: `mock-${k % 2}`, hops: r.hops } as never,
      });
    }
  }
  const vr = route("a", true, "192.0.2.20", "vpn.example.test", 31);
  await prisma.assetPathCheckTraceroute.create({
    data: { assetId: allIds[0], checkId: vpn.id, timestamp: new Date(now.getTime() - 4 * INTERVAL_SEC * 1000), destinationIp: "192.0.2.20", complete: true, hopCount: vr.hops.length, pathHash: "mock-v", hops: vr.hops } as never,
  });

  const channel = await prisma.notificationChannel.create({
    data: {
      name: CHANNEL, type: "smtp", enabled: true, createdBy: "system:mock-path-alerts",
      config: { host: process.env.MAILPIT_HOST || "mailpit", port: Number(process.env.MAILPIT_PORT || 1025), security: "none", username: "", password: "", from: "polaris@example.test" },
    } as never,
    select: { id: true },
  });
  const notify = (addr: string) => ({ type: "notify", channelId: channel.id, addresses: [addr] });

  const group = await prisma.alertGroup.create({
    data: { name: GROUP, enabled: true, requireAckNote: false, foldBy: "automation", actions: [notify("noc@example.test")] } as never,
    select: { id: true },
  });
  const pathRule = (name: string, checkId: string, alertGroupId: string | null, actions: object[]) =>
    prisma.notificationRule.create({
      data: {
        name, enabled: true, severity: "serious",
        trigger: { type: "asset_metric", metric: "pathOk", aggregation: "latest", windowSec: 0, operator: "==", threshold: 0, forDurationSec: 0, dimensionFilter: { checkId } },
        scope: { condition: { op: "and", children: [{ field: "tag", operator: "has", value: "mock-path" }] } },
        reset: { mode: "auto" }, actions, channels: ["in_app"], alertGroupId,
      } as never,
    });
  await pathRule(ERP_RULE, erp.id, group.id, []);
  await pathRule(VPN_RULE, vpn.id, null, [notify("network-team@example.test")]);

  console.log(`Seeded ${HOSTS.length} agent hosts, 2 path checks, the "${GROUP}" group (one alert per automation) and the "${CHANNEL}" channel.`);
  if (once) return;

  // The results the agents would push, one per host per check per interval.
  for (let poll = 0; ; poll++) {
    const ts = new Date();
    const rows: object[] = [];
    for (const [i, h] of HOSTS.entries()) {
      const failing = poll >= ERP_FAILS_FROM[h]!;
      rows.push(failing
        ? { assetId: hostIds[h], checkId: erp.id, timestamp: ts, ok: false, error: "connect timeout after 5000 ms" }
        : { assetId: hostIds[h], checkId: erp.id, timestamp: ts, ok: true, latencyMs: 61 + i, httpStatus: 200 });
      // A failing run is followed by a trace that stops short (reason "transition").
      if (failing && poll === ERP_FAILS_FROM[h]) {
        const r = route("a", false, "192.0.2.10", "erp.example.test", 0);
        await prisma.assetPathCheckTraceroute.create({
          data: { assetId: hostIds[h], checkId: erp.id, timestamp: ts, destinationIp: "192.0.2.10", complete: false, hopCount: r.hops.length, pathHash: "mock-broken", reason: "transition", hops: r.hops } as never,
        });
      }
    }
    rows.push({ assetId: hostIds[HOSTS[0]!], checkId: vpn.id, timestamp: ts, ok: false, error: "connection refused" });
    if (poll === 0) {
      const r = route("b", false, "192.0.2.20", "vpn.example.test", 0);
      await prisma.assetPathCheckTraceroute.create({
        data: { assetId: hostIds[HOSTS[0]!], checkId: vpn.id, timestamp: ts, destinationIp: "192.0.2.20", complete: false, hopCount: r.hops.length, pathHash: "mock-vb", reason: "transition", hops: r.hops } as never,
      });
    }
    await prisma.assetPathCheckSample.createMany({ data: rows as never });
    console.log(`${ts.toISOString()} poll ${poll}: wrote ${rows.length} results`);
    await new Promise((r) => setTimeout(r, INTERVAL_SEC * 1000));
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => { await prisma.$disconnect(); });
