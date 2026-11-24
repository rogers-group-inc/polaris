/**
 * tests/unit/seedAddressPollingRuns.test.ts — the rule-103 polling seed runs
 * once per install (marker `seedAddressPollingRunsAt`).
 *
 * Re-run at every boot it scanned 30 days of probe samples for 13 minutes on
 * prod (2026-11-24), holding asset_monitor_samples while the boot-time
 * compression ALTER queued every sample write behind it. Pinned here:
 *   • a stamped install never runs the seed again;
 *   • an install that already has polling runs (it ran the seed before the
 *     marker existed) is stamped without the scan;
 *   • a fresh install seeds once and stamps;
 *   • a failed seed stamps nothing, so the next boot retries.
 * The job runs on import, so each case re-imports it.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const hasRunMarker = vi.fn();
const stampRunMarker = vi.fn();
const seedPollingRuns = vi.fn();
const findFirst = vi.fn();

vi.mock("../../src/db.js", () => ({ prisma: { asset: { findFirst: (...a: unknown[]) => findFirst(...a) } } }));
vi.mock("../../src/jobs/_runOnce.js", () => ({
  hasRunMarker: (...a: unknown[]) => hasRunMarker(...a),
  stampRunMarker: (...a: unknown[]) => stampRunMarker(...a),
}));
vi.mock("../../src/jobs/_metrics.js", () => ({ runInstrumentedJob: (_n: string, fn: () => Promise<void>) => fn() }));
vi.mock("../../src/services/addressConfidenceService.js", () => ({ seedPollingRuns: () => seedPollingRuns() }));
vi.mock("../../src/utils/logger.js", () => ({ logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() } }));

async function runJob(): Promise<void> {
  vi.resetModules();
  await import("../../src/jobs/seedAddressPollingRuns.js");
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
}

beforeEach(() => {
  hasRunMarker.mockReset().mockResolvedValue(false);
  stampRunMarker.mockReset().mockResolvedValue(undefined);
  seedPollingRuns.mockReset().mockResolvedValue(3);
  findFirst.mockReset().mockResolvedValue(null);
});

describe("seedAddressPollingRuns — once per install", () => {
  it("does nothing on an install that already stamped the marker", async () => {
    hasRunMarker.mockResolvedValue(true);
    await runJob();
    expect(hasRunMarker).toHaveBeenCalledWith("seedAddressPollingRunsAt");
    expect(seedPollingRuns).not.toHaveBeenCalled();
    expect(stampRunMarker).not.toHaveBeenCalled();
  });

  it("stamps without scanning when polling runs already exist", async () => {
    findFirst.mockResolvedValue({ id: "a1" });
    await runJob();
    expect(seedPollingRuns).not.toHaveBeenCalled();
    expect(stampRunMarker).toHaveBeenCalledWith("seedAddressPollingRunsAt", expect.objectContaining({ seeded: 0 }));
  });

  it("seeds once on a fresh install and stamps the count", async () => {
    await runJob();
    expect(seedPollingRuns).toHaveBeenCalledTimes(1);
    expect(stampRunMarker).toHaveBeenCalledWith("seedAddressPollingRunsAt", { seeded: 3 });
  });

  it("stamps nothing when the seed fails, so the next boot retries", async () => {
    seedPollingRuns.mockRejectedValue(new Error("statement timeout"));
    await runJob();
    expect(stampRunMarker).not.toHaveBeenCalled();
  });
});
