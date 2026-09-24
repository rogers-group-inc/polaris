/**
 * tests/integration/agentSilenceDown.test.ts
 *
 * Business rule 86 end to end against a real database: an asset whose Polaris
 * Agent deployed successfully and then went silent must reach `down` through
 * the ordinary probe path — probeAsset → recordProbeResult → the covering
 * automation's missedPolls — so the "Asset down" automation can fire.
 *
 * Before the rule, probeAsset returned a synthetic success for every
 * agent-mode asset and recordProbeResult discarded it, so a dead host's status
 * froze at `up` forever. The verdict arithmetic is in tests/unit/agentSilence.
 */

import { afterAll, beforeEach, expect, it } from "vitest";
import { prisma } from "../../src/db.js";
import { dbDescribe, dbReachable } from "./_helpers.js";
import {
  __resetAgentSilenceStateForTests,
  probeAsset,
  recordProbeResult,
} from "../../src/services/monitoringService.js";
import { flushProbePatchBuffer } from "../../src/services/probePatchBuffer.js";
import { flushAllSampleBuffers } from "../../src/services/sampleWriteBuffer.js";
import { resetDownDetectionStateForTests } from "../../src/services/downDetectionService.js";

const d = dbDescribe;
const HOST = "agent-silence-test";
const RULE = "agent-silence-test down rule";

let assetId = "";

async function wipe(): Promise<void> {
  await prisma.notificationRule.deleteMany({ where: { name: RULE } });
  const assets = await prisma.asset.findMany({ where: { hostname: { startsWith: HOST } }, select: { id: true } });
  const ids = assets.map((a) => a.id);
  if (ids.length) {
    await prisma.assetMonitorSample.deleteMany({ where: { assetId: { in: ids } } });
    await prisma.managedAgent.deleteMany({ where: { assetId: { in: ids } } });
    await prisma.asset.deleteMany({ where: { id: { in: ids } } });
  }
}

async function seedAgentAsset(hostname: string, agent: Record<string, unknown>): Promise<string> {
  const asset = await prisma.asset.create({
    data: {
      hostname,
      assetType: "server",
      status: "active",
      monitored: true,
      monitorStatus: "up",
      responseTimePolling: "agent",
      monitorIntervalSec: 60,
    } as never,
  });
  await prisma.managedAgent.create({
    data: {
      assetId: asset.id,
      osPlatform: "linux",
      arch: "amd64",
      installStatus: "active",
      installedBy: "test",
      serverCertFingerprint: "sha256:" + "e".repeat(64),
      additionalServerCertFingerprints: [],
      bearerPrefix: "polaris_" + hostname.slice(-4),
      bearerHash: "$argon2id$not-a-real-hash",
      bearerIssuedAt: new Date(Date.now() - 86_400_000),
      ...agent,
    } as never,
  });
  return asset.id;
}

/** One monitor tick, exactly as the pg-boss worker runs it (minus the cadence gate). */
async function tick(): Promise<Awaited<ReturnType<typeof probeAsset>>> {
  const probe = await probeAsset(assetId);
  await recordProbeResult(assetId, probe);
  await flushProbePatchBuffer();
  return probe;
}

async function status(): Promise<string | null> {
  const a = await prisma.asset.findUnique({ where: { id: assetId }, select: { monitorStatus: true } });
  return a?.monitorStatus ?? null;
}

d("business rule 86 — a silent agent is a missed poll", () => {
  beforeEach(async () => {
    await wipe();
    // A witness agent that IS reporting: proves the ingest is up, so the
    // fleet-wide guard cannot mistake this test's silence for Polaris's own.
    await seedAgentAsset(`${HOST}-witness`, { lastSeenAt: new Date() });
    assetId = await seedAgentAsset(`${HOST}-subject`, { lastSeenAt: new Date(Date.now() - 30 * 60_000) });
    await prisma.notificationRule.create({
      data: {
        name: RULE,
        enabled: true,
        severity: "critical",
        trigger: { type: "asset_state", field: "monitorStatus", operator: "==", value: "down", missedPolls: 3 },
        scope: { assetIds: [assetId] },
        reset: { mode: "auto" },
        actions: [],
      } as never,
    });
    resetDownDetectionStateForTests();
    __resetAgentSilenceStateForTests(new Date(0));
  });

  afterAll(async () => {
    if (!dbReachable) return;
    await wipe();
  });

  it("walks a silent agent asset warning → warning → down on the covering automation's missedPolls", async () => {
    const first = await tick();
    expect(first).toMatchObject({ success: false, agentSilent: true });
    expect(first.error).toMatch(/has not reported since/);
    expect(await status()).toBe("warning");
    await tick();
    expect(await status()).toBe("warning");
    await tick();
    expect(await status()).toBe("down");

    // Each miss is a real failed sample, so the chart dives with the outage.
    await flushAllSampleBuffers();
    const misses = await prisma.assetMonitorSample.count({ where: { assetId, success: false } });
    expect(misses).toBeGreaterThanOrEqual(3);
  });

  it("the agent's next real sample starts the recovery", async () => {
    for (let i = 0; i < 3; i++) await tick();
    expect(await status()).toBe("down");
    await recordProbeResult(assetId, { success: true, responseTimeMs: 4 }, null, { fromAgent: true });
    await flushProbePatchBuffer();
    expect(await status()).toBe("recovering");
  });

  it("an agent still inside its window leaves the status alone", async () => {
    await prisma.managedAgent.update({ where: { assetId }, data: { lastSeenAt: new Date() } });
    const probe = await tick();
    expect(probe.success).toBe(true);
    expect(probe.agentSilent).toBeUndefined();
    expect(await status()).toBe("up");
  });

  it("a revoked agent is not expected to report, so its silence accuses nobody", async () => {
    await prisma.managedAgent.update({ where: { assetId }, data: { bearerRevokedAt: new Date() } });
    for (let i = 0; i < 3; i++) await tick();
    expect(await status()).toBe("up");
  });

  it("an agent that never finished deploying is never judged", async () => {
    await prisma.managedAgent.update({ where: { assetId }, data: { installStatus: "enrolling" } });
    for (let i = 0; i < 3; i++) await tick();
    expect(await status()).toBe("up");
  });

  it("a monitor process that has only just started does not accuse agents yet", async () => {
    __resetAgentSilenceStateForTests(new Date());
    for (let i = 0; i < 3; i++) await tick();
    expect(await status()).toBe("up");
  });
});
