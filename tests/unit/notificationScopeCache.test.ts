/**
 * tests/unit/notificationScopeCache.test.ts
 *
 * The engine resolves each distinct rule scope ONCE per tick instead of once
 * per rule. The seeded baseline set alone is ~30 automations, most of them
 * `allAssets`, so a 60s pass used to issue dozens of identical fleet reads
 * over SCOPE_SELECT (which carries three array columns per row).
 *
 * The half that actually needs pinning is the SCOPING, not the saving: the
 * memo belongs to one pass. `previewRule` and the dimension-value picker call
 * the same loader, and if the cache stayed armed between ticks an operator's
 * preview would answer from a stale fleet snapshot — a wrong answer, not just
 * a slow one. So: dedupe within a tick, distinct scopes still read separately,
 * and nothing is reused across a tick boundary or by a preview.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  prisma: {
    notificationRule: { findMany: vi.fn() },
    notificationRuleState: { findMany: vi.fn(), update: vi.fn(), upsert: vi.fn(), findUnique: vi.fn() },
    notification: { create: vi.fn(), createMany: vi.fn(), updateMany: vi.fn(), findMany: vi.fn() },
    asset: { findMany: vi.fn(), findUnique: vi.fn() },
    event: { findMany: vi.fn() },
    setting: { findUnique: vi.fn(), upsert: vi.fn() },
    hostMetricsSample: { findMany: vi.fn() },
  },
}));

vi.mock("../../src/db.js", () => ({ prisma: h.prisma }));
vi.mock("../../src/services/eventLogService.js", () => ({ logEvent: vi.fn(async () => {}) }));
vi.mock("../../src/services/notificationRecipientService.js", () => ({
  expandDeliveries: vi.fn(async () => {}),
  scopeRegionTagsOf: vi.fn(() => []),
}));

import {
  clearAssetDetailCache,
  evaluateAllNotificationRules,
  loadScopeRegionSnapshots,
  previewRule,
} from "../../src/services/notificationEngine.js";

function scopeAsset(id: string, over: Record<string, unknown> = {}) {
  return {
    id,
    hostname: id.toUpperCase(),
    assetType: "server",
    tags: [],
    discoveredByIntegrationId: null,
    monitorStatus: "up",
    status: "active",
    consecutiveFailures: 0,
    dependencySuppressed: false,
    quarantinedAt: null,
    monitored: true,
    ipAddress: null,
    manufacturer: null,
    model: null,
    os: null,
    monitoredInterfaces: [] as string[],
    ...over,
  };
}

const RULE = {
  id: "r1",
  name: "Down rule",
  description: null,
  enabled: true,
  severity: "warning",
  trigger: { type: "asset_state", field: "monitorStatus", operator: "==", value: "down", forDurationSec: 0 },
  scope: { allAssets: true },
  clearBehavior: "manual",
  clearAfterSec: null,
  cooldownSec: null,
  messageTemplate: null,
  channels: ["in_app"],
  targets: [],
  emailComposition: null,
  escalation: null,
};

const assetReads = () => h.prisma.asset.findMany.mock.calls.length;

beforeEach(() => {
  vi.clearAllMocks();
  clearAssetDetailCache();
  h.prisma.notificationRuleState.findMany.mockResolvedValue([]);
  h.prisma.notification.create.mockResolvedValue({ id: "n1" });
  h.prisma.notification.findMany.mockResolvedValue([]);
  h.prisma.notificationRuleState.findUnique.mockResolvedValue(null);
  h.prisma.setting.findUnique.mockResolvedValue(null);
  h.prisma.event.findMany.mockResolvedValue([]);
  h.prisma.asset.findMany.mockResolvedValue([scopeAsset("a1")]);
});

describe("per-tick scope memo", () => {
  it("resolves one shared fleet read for many rules on the same scope", async () => {
    h.prisma.notificationRule.findMany.mockResolvedValue([
      RULE,
      { ...RULE, id: "r2", name: "Second" },
      { ...RULE, id: "r3", name: "Third" },
    ]);
    await evaluateAllNotificationRules();
    expect(assetReads()).toBe(1);
  });

  it("still reads separately for scopes that differ", async () => {
    h.prisma.notificationRule.findMany.mockResolvedValue([
      RULE,
      { ...RULE, id: "r2", scope: { assetTypes: ["firewall"] } },
      { ...RULE, id: "r3", scope: { assetTypes: ["switch"] } },
      // Same scope as r2 — shares its read, so three distinct scopes total.
      { ...RULE, id: "r4", scope: { assetTypes: ["firewall"] } },
    ]);
    await evaluateAllNotificationRules();
    expect(assetReads()).toBe(3);
  });

  it("does not carry a snapshot across tick boundaries", async () => {
    h.prisma.notificationRule.findMany.mockResolvedValue([RULE]);
    await evaluateAllNotificationRules();
    await evaluateAllNotificationRules();
    // One per pass — a device that changed between ticks must be seen.
    expect(assetReads()).toBe(2);
  });

  it("leaves the operator-triggered preview reading live", async () => {
    h.prisma.notificationRule.findMany.mockResolvedValue([RULE]);
    await evaluateAllNotificationRules();
    const before = assetReads();
    // Same scope the tick just resolved: the preview must NOT be served from
    // the tick's snapshot.
    await previewRule({ scope: { allAssets: true } } as any);
    expect(assetReads()).toBeGreaterThan(before);
  });

  it("disarms even when the pass throws, so the next preview is live", async () => {
    h.prisma.notificationRule.findMany.mockResolvedValue([RULE]);
    // Fail the pass after the memo is armed.
    h.prisma.notificationRuleState.findMany.mockRejectedValueOnce(new Error("boom"));
    await evaluateAllNotificationRules().catch(() => {});
    const before = assetReads();
    await previewRule({ scope: { allAssets: true } } as any);
    expect(assetReads()).toBeGreaterThan(before);
  });
});

describe("loadScopeRegionSnapshots", () => {
  it("returns each distinct region set of the scope's devices once, stripped, skipping untagged ones", async () => {
    h.prisma.asset.findMany.mockResolvedValue([
      scopeAsset("a1", { tags: ["region:Atlanta", "core"] }),
      scopeAsset("a2", { tags: ["region:atlanta"] }),
      scopeAsset("a3", { tags: ["region:Nashville", "region:Central"] }),
      scopeAsset("a4", { tags: ["region:Central", "region:Nashville"] }),
      scopeAsset("a5", { tags: ["lab"] }),
    ]);
    const snaps = await loadScopeRegionSnapshots({ allAssets: true } as any);
    expect(snaps).toEqual([["Atlanta"], ["Nashville", "Central"]]);
  });
});
