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

vi.mock("../../src/db.js", () => import("./_dbStub.js"));
vi.mock("../../src/services/eventLogService.js", (orig) => import("./_eventLogStub.js").then((s) => s.withEventLogStubs(orig)));
import { resetEventLogStub } from "./_eventLogStub.js";
beforeEach(() => resetEventLogStub());
vi.mock("../../src/services/notificationRecipientService.js", () => ({
  expandDeliveries: vi.fn(async () => {}),
  scopeRegionTagsOf: vi.fn(() => []),
}));

import { evaluateAllNotificationRules, loadScopeRegionSnapshots, previewRule } from "../../src/services/notificationEngine.js";
import { clearAssetDetailCache } from "../../src/services/notifications/assetDetail.js";
import { prisma } from "../../src/db.js";
import { resetDbStub, stubbed } from "./_dbStub.js";

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

const assetReads = () => stubbed(prisma.asset.findMany).mock.calls.length;

beforeEach(() => resetDbStub());

beforeEach(() => {
  vi.clearAllMocks();
  clearAssetDetailCache();
  stubbed(prisma.notificationRuleState.findMany).mockResolvedValue([]);
  stubbed(prisma.notification.create).mockResolvedValue({ id: "n1" });
  stubbed(prisma.notification.findMany).mockResolvedValue([]);
  stubbed(prisma.notificationRuleState.findUnique).mockResolvedValue(null);
  stubbed(prisma.setting.findUnique).mockResolvedValue(null);
  stubbed(prisma.event.findMany).mockResolvedValue([]);
  stubbed(prisma.asset.findMany).mockResolvedValue([scopeAsset("a1")]);
});

describe("per-tick scope memo", () => {
  it("resolves one shared fleet read for many rules on the same scope", async () => {
    stubbed(prisma.notificationRule.findMany).mockResolvedValue([
      RULE,
      { ...RULE, id: "r2", name: "Second" },
      { ...RULE, id: "r3", name: "Third" },
    ]);
    await evaluateAllNotificationRules();
    expect(assetReads()).toBe(1);
  });

  it("still reads separately for scopes that differ", async () => {
    stubbed(prisma.notificationRule.findMany).mockResolvedValue([
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
    stubbed(prisma.notificationRule.findMany).mockResolvedValue([RULE]);
    await evaluateAllNotificationRules();
    await evaluateAllNotificationRules();
    // One per pass — a device that changed between ticks must be seen.
    expect(assetReads()).toBe(2);
  });

  it("leaves the operator-triggered preview reading live", async () => {
    stubbed(prisma.notificationRule.findMany).mockResolvedValue([RULE]);
    await evaluateAllNotificationRules();
    const before = assetReads();
    // Same scope the tick just resolved: the preview must NOT be served from
    // the tick's snapshot.
    await previewRule({ scope: { allAssets: true } } as any);
    expect(assetReads()).toBeGreaterThan(before);
  });

  it("disarms even when the pass throws, so the next preview is live", async () => {
    stubbed(prisma.notificationRule.findMany).mockResolvedValue([RULE]);
    // Fail the pass after the memo is armed.
    stubbed(prisma.notificationRuleState.findMany).mockRejectedValueOnce(new Error("boom"));
    await evaluateAllNotificationRules().catch(() => {});
    const before = assetReads();
    await previewRule({ scope: { allAssets: true } } as any);
    expect(assetReads()).toBeGreaterThan(before);
  });
});

describe("loadScopeRegionSnapshots", () => {
  it("returns each distinct region set of the scope's devices once, stripped, skipping untagged ones", async () => {
    stubbed(prisma.asset.findMany).mockResolvedValue([
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
