/**
 * tests/integration/agentSamplesIngest.test.ts
 *
 * Coverage for POST /api/v1/agents/samples — the agent-fleet ingest path.
 * Written as the PREREQUISITE for splitting the 11-branch handler (2026-08
 * audit): every stream's contract is pinned here first, so the later
 * re-homing has a net.
 *
 * Assertion strategy: streams whose branch performs DIRECT synchronous DB
 * writes (telemetry's lastTelemetryAt, interfaces' MAC fold + lastSystemInfoAt,
 * storage's stamp, the process/service inventory full-replaces, the
 * processConnections mapped-only filter, eventLog's disabled gate) are
 * asserted against the database. Streams that only enqueue into the
 * sample-write buffer (responseTime, processTelemetry, processLog,
 * serviceLog) are asserted on the HTTP contract only — their rows land
 * asynchronously via the buffer flush and probePatchBuffer.
 */

import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import request from "supertest";
import { app } from "../../src/app.js";
import { prisma } from "../../src/db.js";
import { dbDescribe, dbReachable } from "./_helpers.js";
import { generateRawToken, TOKEN_INDEX_PREFIX_LEN } from "../../src/utils/bearerToken.js";
import { hashPassword } from "../../src/utils/password.js";

const d = dbDescribe;

let assetId = "";
let bearer = "";

async function seedAgentAsset(extra: Record<string, unknown> = {}): Promise<void> {
  await prisma.managedAgent.deleteMany({ where: { asset: { hostname: "samples-ingest-test" } } });
  await prisma.asset.deleteMany({ where: { hostname: "samples-ingest-test" } });
  const asset = await prisma.asset.create({
    data: {
      hostname: "samples-ingest-test",
      assetType: "server",
      status: "active",
      ipAddress: "10.98.0.10",
      monitored: true,
      ...extra,
    } as never,
  });
  assetId = asset.id;
  bearer = generateRawToken();
  await prisma.managedAgent.create({
    data: {
      assetId: asset.id,
      osPlatform: "linux",
      arch: "amd64",
      installStatus: "active",
      installedBy: "test",
      serverCertFingerprint: "sha256:" + "d".repeat(64),
      additionalServerCertFingerprints: [],
      bearerPrefix: bearer.slice(0, TOKEN_INDEX_PREFIX_LEN),
      bearerHash: await hashPassword(bearer),
    },
  });
}

function post(body: unknown) {
  return request(app)
    .post("/api/v1/agents/samples")
    .set("Authorization", `Bearer ${bearer}`)
    .send(body as object);
}

beforeAll(async () => {
  if (!dbReachable) return;
  await prisma.$connect();
});

afterAll(async () => {
  if (!dbReachable) return;
  try {
    await prisma.managedAgent.deleteMany({ where: { asset: { hostname: "samples-ingest-test" } } });
    await prisma.asset.deleteMany({ where: { hostname: "samples-ingest-test" } });
    await prisma.$disconnect();
  } catch { /* noop */ }
});

beforeEach(async () => {
  if (!dbReachable) return;
  await seedAgentAsset();
});

d("POST /agents/samples", () => {
  it("rejects a missing bearer with 401 and an unknown stream with 400", async () => {
    const noAuth = await request(app)
      .post("/api/v1/agents/samples")
      .send({ stream: "telemetry", samples: [] });
    expect(noAuth.status).toBe(401);

    const badStream = await post({ stream: "not-a-stream", samples: [] });
    expect(badStream.status).toBe(400);
  });

  it("telemetry: accepts samples and stamps lastTelemetryAt", async () => {
    const resp = await post({
      stream: "telemetry",
      samples: [{ cpuPct: 12.5, memPct: 40, temperatures: [{ sensorName: "cpu", celsius: 51 }] }],
    });
    expect(resp.status).toBe(200);
    expect(resp.body.accepted).toBe(1);
    const asset = await prisma.asset.findUnique({ where: { id: assetId }, select: { lastTelemetryAt: true } });
    expect(asset?.lastTelemetryAt).not.toBeNull();
  });

  it("interfaces: folds NIC MACs into range rows and pins lastSystemInfoAt to the sample timestamp", async () => {
    const ts = "2026-08-05T12:00:00.000Z";
    const resp = await post({
      stream: "interfaces",
      samples: [
        { ifName: "eth0", timestamp: ts, operStatus: "up", adminStatus: "up", macAddress: "AA:BB:CC:00:00:01" },
        { ifName: "eth1", timestamp: ts, operStatus: "down", adminStatus: "up", macAddress: "AA:BB:CC:00:00:02" },
      ],
    });
    expect(resp.status).toBe(200);
    expect(resp.body.accepted).toBe(2);

    const asset = await prisma.asset.findUnique({ where: { id: assetId }, select: { lastSystemInfoAt: true } });
    expect(asset?.lastSystemInfoAt?.toISOString()).toBe(ts);

    // Contiguous MACs coalesce into one interface-fold RANGE row.
    const macRows = await prisma.assetMacAddress.findMany({ where: { assetId, source: "monitor-interface" } });
    expect(macRows).toHaveLength(1);
    expect(macRows[0].mac).toBe("AA:BB:CC:00:00:01");
    expect(macRows[0].macEnd).toBe("AA:BB:CC:00:00:02");
  });

  it("storage: classifies pinned mounts fast and stamps lastSystemInfoAt", async () => {
    await prisma.asset.update({ where: { id: assetId }, data: { monitoredStorage: ["/data"] } });
    const resp = await post({
      stream: "storage",
      samples: [
        { mountPath: "/data", totalBytes: 1000, usedBytes: 500 },
        { mountPath: "/", totalBytes: 2000, usedBytes: 100 },
      ],
    });
    expect(resp.status).toBe(200);
    expect(resp.body.accepted).toBe(2);
    const asset = await prisma.asset.findUnique({ where: { id: assetId }, select: { lastSystemInfoAt: true } });
    expect(asset?.lastSystemInfoAt).not.toBeNull();
  });

  it("processInventory: full-replaces the asset_processes rows", async () => {
    let resp = await post({
      stream: "processInventory",
      samples: [
        { name: "postgres", instanceCount: 3, cpuPct: 5, memRssBytes: 1024, serviceUnit: "postgresql.service" },
        { name: "nginx", instanceCount: 2 },
      ],
    });
    expect(resp.status).toBe(200);
    expect(resp.body.accepted).toBe(2);
    let rows = await prisma.assetProcess.findMany({ where: { assetId }, orderBy: { name: "asc" } });
    expect(rows.map((r) => r.name)).toEqual(["nginx", "postgres"]);
    expect(rows.find((r) => r.name === "postgres")?.controllable).toBe(true);
    expect(rows.find((r) => r.name === "nginx")?.controllable).toBe(false);

    // Second push replaces in full — nginx drops out.
    resp = await post({ stream: "processInventory", samples: [{ name: "postgres", instanceCount: 1 }] });
    expect(resp.status).toBe(200);
    rows = await prisma.assetProcess.findMany({ where: { assetId } });
    expect(rows.map((r) => r.name)).toEqual(["postgres"]);
  });

  it("serviceInventory: full-replaces the asset_services rows", async () => {
    const resp = await post({
      stream: "serviceInventory",
      samples: [
        { unit: "sshd.service", platform: "systemd", activeState: "active", loadState: "loaded" },
        { unit: "cron.service", platform: "systemd", activeState: "inactive", loadState: "loaded" },
      ],
    });
    expect(resp.status).toBe(200);
    expect(resp.body.accepted).toBe(2);
    const rows = await prisma.assetService.findMany({ where: { assetId }, orderBy: { unit: "asc" } });
    expect(rows.map((r) => r.unit)).toEqual(["cron.service", "sshd.service"]);
  });

  it("serviceInventory: stores a Windows service's CPU, memory and description", async () => {
    const resp = await post({
      stream: "serviceInventory",
      samples: [{
        unit: "Spooler", platform: "windows", displayName: "Print Spooler",
        description: "Spools print jobs.", activeState: "running", enabledState: "auto-delayed",
        mainPid: 6616, mainProcess: "spoolsv.exe", memBytes: 12_000_000, cpuPct: 0.75,
      }],
    });
    expect(resp.status).toBe(200);
    const row = await prisma.assetService.findFirstOrThrow({ where: { assetId, unit: "Spooler" } });
    expect(row.description).toBe("Spools print jobs.");
    expect(row.cpuPct).toBe(0.75);
    expect(row.memBytes).toBe(12_000_000n);
    expect(row.enabledState).toBe("auto-delayed");
  });

  it("processConnections: keeps only rows whose name or unit is mapped", async () => {
    await prisma.asset.update({
      where: { id: assetId },
      data: { mappedProcesses: ["postgres"], mappedServices: ["nginx.service"] },
    });
    const resp = await post({
      stream: "processConnections",
      samples: [
        { name: "postgres", kind: "listen", proto: "tcp", localAddr: "0.0.0.0", localPort: 5432 },
        { name: "java", kind: "listen", proto: "tcp", localAddr: "0.0.0.0", localPort: 8080, unit: "nginx.service" },
        { name: "curl", kind: "outbound", proto: "tcp", remoteIp: "10.0.0.9", remotePort: 443 },
      ],
    });
    expect(resp.status).toBe(200);
    // postgres (mapped by name) + java (mapped by unit); curl dropped.
    expect(resp.body.accepted).toBe(2);
    const rows = await prisma.assetProcessConnection.findMany({ where: { assetId }, orderBy: { processName: "asc" } });
    expect(rows.map((r) => r.processName)).toEqual(["java", "postgres"]);
  });

  it("eventLog: the disabled master switch drops the push (accepted 0)", async () => {
    // agentEventLog defaults to disabled; make it explicit for the assertion.
    await prisma.setting.upsert({
      where: { key: "agentEventLog" },
      update: { value: { enabled: false } as never },
      create: { key: "agentEventLog", value: { enabled: false } as never },
    });
    const resp = await post({
      stream: "eventLog",
      samples: [{ channel: "System", level: "error", message: "test event" }],
    });
    expect(resp.status).toBe(200);
    expect(resp.body.accepted).toBe(0);
  });

  it("buffered streams honor the accepted-count contract", async () => {
    const rt = await post({ stream: "responseTime", samples: [{ success: true, responseTimeMs: 4 }] });
    expect(rt.status).toBe(200);
    expect(rt.body.accepted).toBe(1);

    const pt = await post({ stream: "processTelemetry", samples: [{ name: "postgres", cpuPct: 1 }, { name: "nginx", cpuPct: 2 }] });
    expect(pt.status).toBe(200);
    expect(pt.body.accepted).toBe(2);

    const pl = await post({ stream: "processLog", samples: [{ name: "postgres", message: "log line" }] });
    expect(pl.status).toBe(200);
    expect(pl.body.accepted).toBe(1);

    const sl = await post({ stream: "serviceLog", samples: [{ unit: "sshd.service", message: "unit log line" }] });
    expect(sl.status).toBe(200);
    expect(sl.body.accepted).toBe(1);
  });
});
