/**
 * tests/unit/alertChartRenderMemo.test.ts — one alert renders its charts once
 * per drain pass, however many delivery rows it produced.
 *
 * One alert routinely drains as several rows: an automation with more than one
 * notify action, several channels, or a web-push target with a row per
 * enrolled device. The charts are built in the DRAIN rather than at fire time —
 * deliberately, so an escalation at T+90min shows the current hour — so without
 * a memo each of those rows would run the same sample queries and rasterize the
 * same graphs again, on a job that ticks every 15s.
 *
 * (Composed emails used to fan out one row per RECIPIENT so each could carry
 * its own acknowledge token, which made this memo urgent rather than merely
 * right. Acknowledgement is a logged-in page now — business rule 25 — so a
 * composed email is one row again, and the memo covers the cases above.)
 *
 * The memo is scoped to one drain pass, which is the half that can't be
 * asserted here: a module-level cache would pass this test and quietly serve a
 * stale snapshot to the next escalation.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

// Everything the vi.mock factories close over has to be hoisted with them —
// the factories run before this module's top-level bindings exist.
const { sent, updated, buildAlertCharts, rows } = vi.hoisted(() => {
  const rows = ["d1", "d2", "d3"].map((id, i) => ({
    id,
    channelId: "c-mail",
    transport: "email",
    target: `person${i}@example.com`,
    // Three rows, one alert, one body — a fanned-out composed email.
    meta: { composed: true, to: [`person${i}@example.com`], subject: "S", text: "CPU {chart.cpu}" },
    attempts: 0,
    notification: {
      id: "n1",
      message: "CPU high",
      severity: "error",
      assetId: "a1",
      assetHostname: "sw-1",
      dimension: null,
      metric: "cpuPct",
      ruleId: "r1",
      triggeredAt: new Date("2026-08-27T12:00:00Z"),
    },
  }));
  return {
    sent: [] as unknown[],
    updated: [] as unknown[],
    buildAlertCharts: vi.fn(async () => new Map()),
    rows,
  };
});

vi.mock("../../src/db.js", () => ({
  prisma: {
    notificationDelivery: {
      findMany: vi.fn(async () => rows),
      updateMany: vi.fn(async (a: unknown) => { updated.push(a); return { count: 3 }; }),
      update: vi.fn(async (a: unknown) => { updated.push(a); return {}; }),
    },
    notificationChannel: {
      findMany: vi.fn(async () => [
        { id: "c-mail", type: "smtp", enabled: true, config: { host: "mail", from: "a@b.c" } },
      ]),
    },
    notificationRule: { findUnique: vi.fn(async () => ({ trigger: {} })) },
    pushSubscription: { deleteMany: vi.fn(async () => ({ count: 0 })) },
  },
}));

vi.mock("../../src/services/alertChartService.js", () => ({
  CHART_TOKENS: ["chart.cpu"],
  buildAlertCharts,
  chartTokensIn: () => new Set(["chart.cpu"]),
  substituteChartTokens: (t: string) => t,
  attachmentsFor: () => [],
  isStorageScopedAlert: () => false,
  storageThresholdFromTrigger: () => null,
}));

vi.mock("../../src/services/alertInterfaceService.js", () => ({
  buildInterfaceLldpBlocks: vi.fn(async () => ({ text: "", html: "" })),
  interfaceTokensIn: () => new Set(),
  substituteInterfaceTokens: (t: string) => t,
}));

vi.mock("../../src/services/alertBrandService.js", () => ({
  buildAlertBrandBlock: vi.fn(async () => ({ text: "", html: "", attachment: null })),
  brandTokensIn: () => new Set(),
  substituteBrandTokens: (t: string) => t,
  BRAND_LOGO_CID: "brand",
}));

vi.mock("../../src/services/notificationChannels/emailChannel.js", () => ({
  sendSmtpEmail: vi.fn(async (_cfg: unknown, msg: unknown) => { sent.push(msg); }),
  sendM365Email: vi.fn(async () => {}),
}));

vi.mock("../../src/services/eventLogService.js", () => ({ logEvent: vi.fn(async () => {}) }));

import { drainPendingDeliveries } from "../../src/services/notificationDeliveryService.js";

beforeEach(() => {
  sent.length = 0;
  updated.length = 0;
  buildAlertCharts.mockClear();
});

describe("drain-pass chart memo", () => {
  it("builds one alert's charts once across every fanned-out recipient", async () => {
    const res = await drainPendingDeliveries();
    expect(res.sent).toBe(3);
    expect(sent).toHaveLength(3); // three emails...
    expect(buildAlertCharts).toHaveBeenCalledTimes(1); // ...one chart build
  });
});
