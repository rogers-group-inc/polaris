/**
 * tests/integration/monitorOverrideRecompute.test.ts
 *
 * recomputeMonitorOverrideForAssets — the ONE place `Asset.monitorOverride` is
 * derived (a single SQL UPDATE, run from every operator write path) — against a
 * real database. Override = the operator's `monitored` differs from what the
 * discovering integration's class block would have chosen.
 *
 * Until 2026-11-12 the rule was specified by a JS twin, `computeMonitorOverride`,
 * that production never called (CQ-B010 note (c)); the SQL had one integration
 * case (no integration link). The twin is deleted and its cases run here,
 * plus the four places the SQL is the rule and the twin was silent: a
 * standalone FortiGate always monitors its gate, an HA standby's default is
 * "not monitored", a Generic API asset never carries an override, and a class
 * block with no flag compares against "off".
 *
 * Skips cleanly when DATABASE_URL isn't reachable; see _helpers.ts.
 */

import { it, expect, beforeEach, afterAll } from "vitest";
import { prisma } from "../../src/db.js";
import { recomputeMonitorOverrideForAssets } from "../../src/services/monitorOverrideService.js";
import { dbDescribe, dbReachable } from "./_helpers.js";

const NAME = "mo-recompute-test";

async function cleanup(): Promise<void> {
  const intgs = await prisma.integration.findMany({ where: { name: { startsWith: NAME } }, select: { id: true } });
  const ids = intgs.map((i) => i.id);
  await prisma.asset.deleteMany({ where: { hostname: { startsWith: NAME } } });
  if (ids.length) await prisma.integration.deleteMany({ where: { id: { in: ids } } });
}

beforeEach(async () => {
  if (!dbReachable) return;
  await cleanup();
});

afterAll(async () => {
  if (!dbReachable) return;
  await cleanup();
});

async function integration(type: string, config: Record<string, unknown>): Promise<string> {
  const i = await prisma.integration.create({ data: { type, name: `${NAME}-${type}`, config: config as object, enabled: true } });
  return i.id;
}

/** Create an asset, recompute, and return the override the SQL stamped. */
async function overrideFor(input: {
  integrationId: string | null;
  assetType: string;
  monitored: boolean;
  haRole?: string;
  start?: boolean;
}): Promise<boolean> {
  const a = await prisma.asset.create({
    data: {
      hostname: `${NAME}-${Math.random().toString(36).slice(2, 8)}`,
      assetType: input.assetType as never,
      status: "active",
      monitored: input.monitored,
      monitorOverride: input.start ?? false,
      discoveredByIntegrationId: input.integrationId,
      ...(input.haRole ? { fortinetTopology: { haRole: input.haRole } } : {}),
    },
  });
  await recomputeMonitorOverrideForAssets(prisma, [a.id]);
  const fresh = await prisma.asset.findUnique({ where: { id: a.id }, select: { monitorOverride: true } });
  return fresh!.monitorOverride;
}

const block = (key: string, addAsMonitored: unknown) => ({ [key]: { addAsMonitored } });

dbDescribe("recomputeMonitorOverrideForAssets — the divergence rule, in SQL", () => {
  it("no override when the operator's choice matches the class flag", async () => {
    const fmgOn = await integration("fortimanager", block("fortigateMonitor", true));
    expect(await overrideFor({ integrationId: fmgOn, assetType: "firewall", monitored: true })).toBe(false);
    const fmgOff = await integration("fortimanager", block("fortiswitchMonitor", false));
    expect(await overrideFor({ integrationId: fmgOff, assetType: "switch", monitored: false })).toBe(false);
  });

  it("override when the operator's choice diverges from the flag, either way", async () => {
    const on = await integration("fortimanager", block("fortiapMonitor", true));
    expect(await overrideFor({ integrationId: on, assetType: "access_point", monitored: false })).toBe(true);
    const off = await integration("activedirectory", block("workstationMonitor", false));
    expect(await overrideFor({ integrationId: off, assetType: "workstation", monitored: true })).toBe(true);
  });

  it("a recompute also CLEARS a stale override once the choices converge", async () => {
    const on = await integration("fortimanager", block("fortigateMonitor", true));
    expect(await overrideFor({ integrationId: on, assetType: "firewall", monitored: true, start: true })).toBe(false);
  });

  it("a class block with no flag compares against off (COALESCE false)", async () => {
    const none = await integration("fortimanager", {});
    expect(await overrideFor({ integrationId: none, assetType: "switch", monitored: true })).toBe(true);
    expect(await overrideFor({ integrationId: none, assetType: "switch", monitored: false })).toBe(false);
  });

  it("a standalone FortiGate always monitors its own gate, whatever the block says", async () => {
    const fgt = await integration("fortigate", block("fortigateMonitor", false));
    expect(await overrideFor({ integrationId: fgt, assetType: "firewall", monitored: true })).toBe(false);
    expect(await overrideFor({ integrationId: fgt, assetType: "firewall", monitored: false })).toBe(true);
  });

  it("an HA standby's default is not-monitored, so monitoring it on purpose is the override", async () => {
    const fmg = await integration("fortimanager", block("fortigateMonitor", true));
    expect(await overrideFor({ integrationId: fmg, assetType: "firewall", monitored: true, haRole: "secondary" })).toBe(true);
    expect(await overrideFor({ integrationId: fmg, assetType: "firewall", monitored: false, haRole: "secondary" })).toBe(false);
  });

  it("servers read vmMonitor on a hypervisor integration and serverMonitor on a directory one", async () => {
    const vc = await integration("vcenter", { ...block("vmMonitor", true), ...block("serverMonitor", false) });
    expect(await overrideFor({ integrationId: vc, assetType: "server", monitored: true })).toBe(false);
    const ad = await integration("activedirectory", { ...block("vmMonitor", true), ...block("serverMonitor", false) });
    expect(await overrideFor({ integrationId: ad, assetType: "server", monitored: true })).toBe(true);
  });

  it("leaves alone a Generic API asset, an asset with no integration, and a class with no block", async () => {
    const gen = await integration("genericapi", block("serverMonitor", false));
    expect(await overrideFor({ integrationId: gen, assetType: "server", monitored: true })).toBe(false);
    expect(await overrideFor({ integrationId: null, assetType: "server", monitored: true })).toBe(false);
    const fmg = await integration("fortimanager", block("fortigateMonitor", false));
    expect(await overrideFor({ integrationId: fmg, assetType: "printer", monitored: true })).toBe(false);
  });
});
