/**
 * tests/unit/monitorSettingsCacheExpiry.test.ts
 *
 * Business rule 176: the monitoring-settings cache expires. Its explicit
 * invalidation only reaches the process that saved the change; on a
 * production install that is the web role, and the monitor and discovery roles
 * are other processes. So a change made "elsewhere" — modelled here as the
 * database answering differently with no invalidate call — must be seen once
 * MONITOR_SETTINGS_CACHE_TTL_MS has passed, and the cached value must keep
 * being served, never dropped, until the reload lands.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../../src/db.js", () => ({
  prisma: {
    setting: { findUnique: vi.fn() },
    integration: { findUnique: vi.fn() },
    monitorClassOverride: { findFirst: vi.fn() },
    asset: { findMany: vi.fn() },
  },
}));

import { resolveMonitorSettings, invalidateMonitorSettingsCache } from "../../src/services/monitoringService.js";
import { MONITOR_SETTINGS_CACHE_TTL_MS } from "../../src/services/monitoring/monitorSettings.js";
import { prisma } from "../../src/db.js";

const setting = prisma.setting.findUnique as unknown as ReturnType<typeof vi.fn>;
const integration = prisma.integration.findUnique as unknown as ReturnType<typeof vi.fn>;
const override = prisma.monitorClassOverride.findFirst as unknown as ReturnType<typeof vi.fn>;

const MANUAL_KEY = "manualMonitorSettings";
/** Reads of the manual tier's own row; the resolver reads other Setting keys too. */
let manualReads = 0;
let manualValue: unknown = null;
const manual = (intervalSeconds: number) => ({ key: MANUAL_KEY, value: { intervalSeconds } });
/** The manual tier's row as the database holds it now. */
function stored(value: unknown) {
  manualValue = value;
}
const readManual = async (args: { where: { key: string } }) => {
  if (args?.where?.key !== MANUAL_KEY) return null;
  manualReads += 1;
  return typeof manualValue === "function" ? (manualValue as () => unknown)() : manualValue;
};
const asset = (over: Record<string, unknown> = {}) => ({
  assetType: "server",
  discoveredByIntegrationId: null,
  monitorIntervalSec: null,
  cpuMemoryIntervalSec: null,
  temperatureIntervalSec: null,
  systemInfoIntervalSec: null,
  ...over,
}) as never;

let now = 1_000_000;
beforeEach(() => {
  now = 1_000_000;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  setting.mockReset();
  manualReads = 0;
  manualValue = null;
  setting.mockImplementation(readManual);
  integration.mockReset();
  override.mockReset();
  override.mockResolvedValue(null);
  invalidateMonitorSettingsCache();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("rule 176: the monitoring-settings cache expires", () => {
  it("serves the cached tier inside the TTL and re-reads it after", async () => {
    stored(manual(60));
    expect((await resolveMonitorSettings(asset())).intervalSeconds).toBe(60);
    expect(manualReads).toBe(1);

    // Saved by another process: no invalidate reaches this one.
    stored(manual(15));
    now += MONITOR_SETTINGS_CACHE_TTL_MS - 1;
    expect((await resolveMonitorSettings(asset())).intervalSeconds).toBe(60);
    expect(manualReads).toBe(1);

    now += 2;
    expect((await resolveMonitorSettings(asset())).intervalSeconds).toBe(15);
    expect(manualReads).toBe(2);
  });

  it("an integration tier and a class override expire the same way", async () => {
    integration.mockResolvedValue({ type: "generic", pollInterval: null, config: { monitorSettings: { intervalSeconds: 120 } } });
    const a = asset({ discoveredByIntegrationId: "int-1" });
    expect((await resolveMonitorSettings(a)).intervalSeconds).toBe(120);

    integration.mockResolvedValue({ type: "generic", pollInterval: null, config: { monitorSettings: { intervalSeconds: 30 } } });
    override.mockResolvedValue({ intervalSeconds: 45 });
    expect((await resolveMonitorSettings(a)).intervalSeconds).toBe(120);

    now += MONITOR_SETTINGS_CACHE_TTL_MS + 1;
    // The class override, re-read too, now wins over the integration tier.
    expect((await resolveMonitorSettings(a)).intervalSeconds).toBe(45);
    expect(integration).toHaveBeenCalledTimes(2);
  });

  it("many resolves of one stale key reload it once, and none of them waits on an empty cache", async () => {
    stored(manual(60));
    await resolveMonitorSettings(asset());
    now += MONITOR_SETTINGS_CACHE_TTL_MS + 1;

    let release: (v: unknown) => void = () => {};
    stored(() => new Promise((res) => { release = res; }));
    const first = resolveMonitorSettings(asset());
    // While the reload is in flight, the others are served the old value.
    const others = await Promise.all([resolveMonitorSettings(asset()), resolveMonitorSettings(asset()), resolveMonitorSettings(asset())]);
    expect(others.map((o) => o.intervalSeconds)).toEqual([60, 60, 60]);
    expect(manualReads).toBe(2);

    release(manual(20));
    expect((await first).intervalSeconds).toBe(20);
    expect((await resolveMonitorSettings(asset())).intervalSeconds).toBe(20);
    expect(manualReads).toBe(2);
  });

  it("an explicit invalidate is still immediate", async () => {
    stored(manual(60));
    await resolveMonitorSettings(asset());
    stored(manual(10));
    invalidateMonitorSettingsCache({ integrationId: null });
    expect((await resolveMonitorSettings(asset())).intervalSeconds).toBe(10);
  });
});
