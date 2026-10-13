/**
 * tests/unit/holdRecoveryWait.test.ts — the recovery wait that keeps a
 * rule-80 hold open after a device comes back.
 *
 * Pins business rule 115(a): with `rebootSince`, a reboot Polaris asked for
 * keeps its window open until monitoring has RECORDED the reboot
 * (`Asset.lastRebootAt` past the start), so the device.reboot Event lands
 * inside the window and the "Device recently rebooted" automation stays
 * quiet. Without it (a firmware flash) the first answer still ends the wait.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  state: {
    hold: { expiresAt: new Date(Date.now() + 3_600_000) } as { expiresAt: Date } | null,
    // Returned in order, one per poll; the last entry repeats.
    samples: [] as Array<{ timestamp: Date } | null>,
    assets: [] as Array<{ lastRebootAt: Date | null; lastUptimeSec: number | null }>,
    sampleCalls: 0,
    assetCalls: 0,
  },
}));

const next = <T>(list: T[], i: number): T => list[Math.min(i, list.length - 1)];

vi.mock("../../src/db.js", () => ({
  prisma: {
    maintenanceHold: {
      findUnique: vi.fn(async () => h.state.hold),
      update: vi.fn(async () => ({})),
    },
    assetMonitorSample: {
      findFirst: vi.fn(async () => next(h.state.samples, h.state.sampleCalls++)),
    },
    asset: {
      findUnique: vi.fn(async () => next(h.state.assets, h.state.assetCalls++)),
    },
  },
}));
vi.mock("../../src/utils/logger.js", () => ({ logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }));

import { holdUntilMonitorAnswers } from "../../src/services/holdRecoveryWait.js";

const T = { recoveryWaitMs: 200, recoveryPollMs: 5 };
const started = new Date(Date.now() - 60_000);
const run = () => {
  const msgs: string[] = [];
  return { msgs, r: { onWaiting: () => undefined, push: (_l: string, m: string) => { msgs.push(m); }, flush: async () => undefined } };
};

beforeEach(() => {
  h.state.hold = { expiresAt: new Date(Date.now() + 3_600_000) };
  h.state.samples = [];
  h.state.assets = [];
  h.state.sampleCalls = 0;
  h.state.assetCalls = 0;
});

describe("holdUntilMonitorAnswers", () => {
  it("without rebootSince, the first successful sample ends the wait", async () => {
    h.state.samples = [{ timestamp: new Date() }];
    const { r } = run();
    expect(await holdUntilMonitorAnswers("a1", "firmware-upgrade", T, r)).toBe(true);
    expect(h.state.assetCalls).toBe(0);
  });

  it("with rebootSince, an answer alone does not end the wait while monitoring reads uptime", async () => {
    h.state.samples = [{ timestamp: new Date() }];
    // Uptime is read (non-null) but the reboot is recorded only on the third look.
    h.state.assets = [
      { lastRebootAt: null, lastUptimeSec: 900_000 },
      { lastRebootAt: null, lastUptimeSec: 900_000 },
      { lastRebootAt: new Date(), lastUptimeSec: 30 },
    ];
    const { r, msgs } = run();
    expect(await holdUntilMonitorAnswers("a1", "device-reboot", T, r, started)).toBe(true);
    expect(h.state.assetCalls).toBe(3);
    expect(msgs.some((m) => /recorded the reboot/.test(m))).toBe(true);
  });

  it("ends at once when monitoring already recorded the reboot (an agent host, a monitor-proven run)", async () => {
    h.state.assets = [{ lastRebootAt: new Date(), lastUptimeSec: 12 }];
    const { r } = run();
    expect(await holdUntilMonitorAnswers("a1", "device-reboot", T, r, started)).toBe(true);
    expect(h.state.sampleCalls).toBe(0);
  });

  it("a reboot stamp from before the run does not count", async () => {
    h.state.samples = [null];
    h.state.assets = [{ lastRebootAt: new Date(started.getTime() - 1), lastUptimeSec: 900_000 }];
    const { r, msgs } = run();
    expect(await holdUntilMonitorAnswers("a1", "device-reboot", T, r, started)).toBe(false);
    expect(msgs.some((m) => /did not answer/.test(m))).toBe(true);
  });

  it("ends after the answer when monitoring reads no uptime for the device (no Event can come)", async () => {
    h.state.samples = [{ timestamp: new Date() }];
    h.state.assets = [{ lastRebootAt: null, lastUptimeSec: null }];
    const { r, msgs } = run();
    expect(await holdUntilMonitorAnswers("a1", "device-reboot", T, r, started)).toBe(true);
    expect(msgs.some((m) => /reads no uptime/.test(m))).toBe(true);
  });

  it("does not end on the no-uptime path before monitoring has answered", async () => {
    h.state.samples = [null];
    h.state.assets = [{ lastRebootAt: null, lastUptimeSec: null }];
    const { r } = run();
    expect(await holdUntilMonitorAnswers("a1", "device-reboot", T, r, started)).toBe(false);
  });

  it("answered but never recorded: ends at the cap and says an alert may follow", async () => {
    h.state.samples = [{ timestamp: new Date() }];
    h.state.assets = [{ lastRebootAt: null, lastUptimeSec: 900_000 }];
    const { r, msgs } = run();
    expect(await holdUntilMonitorAnswers("a1", "device-reboot", T, r, started)).toBe(true);
    expect(msgs.some((m) => /did not record the reboot/.test(m))).toBe(true);
  });

  it("no hold (an unmonitored device) means nothing to wait for", async () => {
    h.state.hold = null;
    const { r } = run();
    expect(await holdUntilMonitorAnswers("a1", "device-reboot", T, r, started)).toBe(false);
    expect(h.state.sampleCalls + h.state.assetCalls).toBe(0);
  });
});
