/**
 * tests/integration/sdwanCadenceRunner.test.ts
 *
 * runSdwanFor — the SD-WAN cadence's worker (split out of the system-info pass
 * 2026-09). Pins the three things a per-minute cadence cannot get wrong:
 *
 *   - the pickup re-check: a job published before the toggle was switched off
 *     (or the gate moved off REST) does nothing and leaves the anchor alone;
 *   - the anchor is stamped EVEN ON FAILURE, so an unreachable or
 *     misconfigured gate is asked once per interval, not once per 5s tick;
 *   - a failed poll never wipes the stored rules. The old ride-along replaced
 *     them with [] whenever the CMDB read failed, which at 60s would blank the
 *     SD-WAN tab on every blip.
 *
 * The unreachable case dials 127.0.0.1:443, where nothing listens on a CI
 * runner or a dev box, so the refusal is immediate.
 */

import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { prisma } from "../../src/db.js";
import { dbDescribe, dbReachable } from "./_helpers.js";
import { runSdwanFor, resolveSdwanPollIntervalForAsset, invalidateMonitorSettingsCache } from "../../src/services/monitoringService.js";

const PFX = "sdwan-runner-test";
const labels = { transport: "rest_api", assetType: "firewall" };

let assetId = "";

async function seedIntegration(config: Record<string, unknown>): Promise<string> {
  await prisma.integration.deleteMany({ where: { name: { startsWith: PFX } } });
  const i = await prisma.integration.create({
    data: { name: `${PFX}-fgt`, type: "fortigate", enabled: false, config: config as never },
  });
  invalidateMonitorSettingsCache();
  return i.id;
}

async function seedGate(integrationId: string, extra: Record<string, unknown> = {}): Promise<void> {
  await prisma.asset.deleteMany({ where: { hostname: PFX } });
  const a = await prisma.asset.create({
    data: {
      hostname: PFX,
      assetType: "firewall",
      status: "active",
      ipAddress: "127.0.0.1",
      monitored: true,
      discoveredByIntegrationId: integrationId,
      ...extra,
    } as never,
  });
  assetId = a.id;
  await prisma.assetSdwanRule.create({
    data: { assetId, ruleName: "keep-me", status: "up", availableMembers: ["wan1"] } as never,
  });
}

async function anchor(): Promise<Date | null> {
  const a = await prisma.asset.findUnique({ where: { id: assetId }, select: { lastSdwanAt: true } });
  return a?.lastSdwanAt ?? null;
}

async function ruleNames(): Promise<string[]> {
  const rows = await prisma.assetSdwanRule.findMany({ where: { assetId }, select: { ruleName: true } });
  return rows.map((r) => r.ruleName);
}

beforeAll(async () => {
  if (!dbReachable) return;
  await prisma.$connect();
});

afterAll(async () => {
  if (!dbReachable) return;
  try {
    const assets = await prisma.asset.findMany({ where: { hostname: PFX }, select: { id: true } });
    await prisma.assetSdwanRule.deleteMany({ where: { assetId: { in: assets.map((a) => a.id) } } });
    await prisma.asset.deleteMany({ where: { hostname: PFX } });
    await prisma.integration.deleteMany({ where: { name: { startsWith: PFX } } });
    invalidateMonitorSettingsCache();
  } catch { /* noop */ }
});

beforeEach(() => {
  assetId = "";
});

dbDescribe("runSdwanFor", () => {
  it("does nothing, and leaves the anchor alone, when the integration no longer pulls SD-WAN", async () => {
    const id = await seedIntegration({ pullSdwan: false, apiToken: "t" });
    await seedGate(id);
    expect(await runSdwanFor(assetId, labels)).toBe("success");
    expect(await anchor()).toBeNull();
    expect(await ruleNames()).toEqual(["keep-me"]);
  });

  it("does nothing for a gate moved off FortiOS REST", async () => {
    const id = await seedIntegration({ pullSdwan: true, apiToken: "t" });
    await seedGate(id, { interfacesPolling: "snmp" });
    expect(await runSdwanFor(assetId, labels)).toBe("success");
    expect(await anchor()).toBeNull();
  });

  it("stamps the anchor on a configuration failure (no API token) and keeps the rules", async () => {
    const id = await seedIntegration({ pullSdwan: true });
    await seedGate(id);
    expect(await runSdwanFor(assetId, labels)).toBe("failure");
    expect(await anchor()).not.toBeNull();
    expect(await ruleNames()).toEqual(["keep-me"]);
  });

  it("stamps the anchor when the gate does not answer, and does NOT wipe the stored rules", async () => {
    const id = await seedIntegration({ pullSdwan: true, apiToken: "t" });
    await seedGate(id);
    expect(await runSdwanFor(assetId, labels)).toBe("failure");
    expect(await anchor()).not.toBeNull();
    expect(await ruleNames()).toEqual(["keep-me"]);
  }, 30_000);
});

// The SD-WAN tab's freshness strips turn amber past this figure, so it must be
// the SD-WAN cadence the scheduler actually applies — not the system-info one
// (600s default) the stream used to ride.
dbDescribe("resolveSdwanPollIntervalForAsset", () => {
  it("reports the integration's SD-WAN interval, defaulting to 60s", async () => {
    const id = await seedIntegration({ pullSdwan: true, apiToken: "t" });
    await seedGate(id);
    expect(await resolveSdwanPollIntervalForAsset(assetId)).toBe(60);

    const slow = await seedIntegration({ pullSdwan: true, apiToken: "t", sdwanIntervalSeconds: 300 });
    await seedGate(slow);
    expect(await resolveSdwanPollIntervalForAsset(assetId)).toBe(300);
  });

  it("is null when nothing polls it: toggle off, off REST, or unmonitored", async () => {
    const off = await seedIntegration({ pullSdwan: false, apiToken: "t" });
    await seedGate(off);
    expect(await resolveSdwanPollIntervalForAsset(assetId)).toBeNull();

    const on = await seedIntegration({ pullSdwan: true, apiToken: "t" });
    await seedGate(on, { interfacesPolling: "snmp" });
    expect(await resolveSdwanPollIntervalForAsset(assetId)).toBeNull();

    await seedGate(on, { monitored: false });
    expect(await resolveSdwanPollIntervalForAsset(assetId)).toBeNull();
  });
});
