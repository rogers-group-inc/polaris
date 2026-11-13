/**
 * tests/unit/preview.test.ts — src/services/notifications/preview.ts, the
 * automation builder's Test button and In-app Alert example (CQ-T010).
 *
 * Complements, does not repeat:
 *   - notificationCarveOut.test.ts — carveOutAggregate + applyCarveOutToMatches
 *     (rule 18), pure
 *   - templateVariableScope.test.ts — applicableTemplateTokens
 *   - notificationMonitoredGate / notificationEngineComposite /
 *     notificationScopeCache / storageForecast — previewRule reached through
 *     the engine for the monitored gate, composites, the scope cache and
 *     forecasts
 *
 * What was unreached: previewRule's own result contract with the readers
 * mocked — the device-list preview (monitored listed, unmonitored COUNTED,
 * carve-out from `carveOutTrigger` with its covered counts and specificity);
 * an event / change draft (unsupported with an unconstrained scope, the
 * device list plus the note once narrowed — rule 46); meetsCount over every
 * reading rather than the 200-row window; totalAssets as DISTINCT devices and
 * absent for a host draft; the severity a band puts each value in; the
 * hysteresis view (wouldClear / inDeadBand); the email sample taken from the
 * first MATCHING reading; and previewAlertMessage — candidates sorted and
 * capped, the asked-for device honoured, a host draft with no device, the
 * no-reading flag, band severity, and the event stand-in message.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../src/db.js", () => import("./_dbStub.js"));

const h = vi.hoisted(() => ({
  loadScopeAssets: vi.fn(),
  resolveAssetMetricReadings: vi.fn(),
  resolveAssetStateReadings: vi.fn(),
  resolveHostMetricReading: vi.fn(),
  buildComposedEmail: vi.fn(),
  decorateRelationLeafHits: vi.fn(async () => undefined),
  applyLinkedForecastLevels: vi.fn(async () => undefined),
}));
vi.mock("../../src/services/notifications/scope.js", async (orig) => ({
  ...(await orig<typeof import("../../src/services/notifications/scope.js")>()),
  loadScopeAssets: h.loadScopeAssets,
}));
vi.mock("../../src/services/notifications/readings.js", async (orig) => ({
  ...(await orig<typeof import("../../src/services/notifications/readings.js")>()),
  resolveAssetMetricReadings: h.resolveAssetMetricReadings,
  resolveAssetStateReadings: h.resolveAssetStateReadings,
  resolveHostMetricReading: h.resolveHostMetricReading,
}));
vi.mock("../../src/services/notificationRecipientService.js", async (orig) => ({
  ...(await orig<typeof import("../../src/services/notificationRecipientService.js")>()),
  buildComposedEmail: h.buildComposedEmail,
}));
vi.mock("../../src/services/scopeRelationIndex.js", async (orig) => ({
  ...(await orig<typeof import("../../src/services/scopeRelationIndex.js")>()),
  decorateRelationLeafHits: h.decorateRelationLeafHits,
}));
vi.mock("../../src/services/notifications/eventTail.js", async (orig) => ({
  ...(await orig<typeof import("../../src/services/notifications/eventTail.js")>()),
  applyLinkedForecastLevels: h.applyLinkedForecastLevels,
}));

import { prisma } from "../../src/db.js";
import { resetDbStub, stubbed } from "./_dbStub.js";
import { previewAlertMessage, previewRule } from "../../src/services/notifications/preview.js";
import type { PreviewRuleInput } from "../../src/services/notificationTypes.js";

function scopeAsset(id: string, over: Record<string, unknown> = {}) {
  return {
    id, hostname: id.toUpperCase(), assetType: "server", tags: [], discoveredByIntegrationId: null,
    monitorStatus: "up", status: "active", consecutiveFailures: 0, dependencySuppressed: false,
    quarantinedAt: null, monitored: true, ipAddress: null, fortilinkStatus: null, fortilinkCheckedAt: null,
    manufacturer: null, model: null, ...over,
  };
}
const reading = (assetId: string, value: number | string | null, dim = "") =>
  ({ assetId, hostname: assetId.toUpperCase(), tags: [], dimKey: dim, dimLabel: dim, value });

const CPU = { type: "asset_metric", metric: "cpuPct", operator: ">", threshold: 90 } as const;

function draft(over: Partial<PreviewRuleInput> & Record<string, unknown> = {}): PreviewRuleInput {
  return {
    name: "CPU high",
    severity: "warning",
    scope: { allAssets: true },
    reset: { mode: "manual" },
    actions: [],
    trigger: CPU,
    ...over,
  } as unknown as PreviewRuleInput;
}

beforeEach(() => {
  resetDbStub();
  for (const f of [h.loadScopeAssets, h.resolveAssetMetricReadings, h.resolveAssetStateReadings, h.resolveHostMetricReading, h.buildComposedEmail]) f.mockReset();
  h.loadScopeAssets.mockResolvedValue([]);
  h.resolveAssetMetricReadings.mockResolvedValue([]);
  h.resolveAssetStateReadings.mockResolvedValue([]);
  h.resolveHostMetricReading.mockResolvedValue(null);
  h.buildComposedEmail.mockReturnValue({ subject: "S", text: "T", html: "<p>H</p>" });
  stubbed(prisma.notificationRule.findMany).mockResolvedValue([]);
  stubbed(prisma.asset.findUnique).mockResolvedValue(null);
});

describe("previewRule — the device-list preview (no trigger)", () => {
  it("lists the monitored devices and COUNTS the unmonitored ones", async () => {
    h.loadScopeAssets.mockResolvedValue([scopeAsset("a"), scopeAsset("b", { monitored: false }), scopeAsset("c")]);
    const r = await previewRule(draft({ trigger: undefined }));
    expect(r).toMatchObject({ supported: true, totalEvaluated: 2, totalAssets: 2, meetsCount: 2, unmonitoredCount: 1 });
    expect(r.matches.map((m) => m.assetId)).toEqual(["a", "c"]);
    expect(r.specificity).toBeUndefined();
    expect(r.carveOut).toBeUndefined();
    // Loaded unfiltered, so the count can be stated.
    expect(h.loadScopeAssets).toHaveBeenCalledWith({ allAssets: true });
  });

  it("with carveOutTrigger: a more-specific peer's devices are stamped, ordered last, and subtracted", async () => {
    h.loadScopeAssets.mockResolvedValue([scopeAsset("a", { assetType: "firewall" }), scopeAsset("b")]);
    stubbed(prisma.notificationRule.findMany).mockResolvedValue([
      { id: "p1", name: "Firewall CPU", trigger: CPU, scope: { assetTypes: ["firewall"] } },
      { id: "p2", name: "Other trigger", trigger: { ...CPU, metric: "memPct" }, scope: { assetTypes: ["firewall"] } },
    ]);
    const r = await previewRule(draft({ trigger: undefined, carveOutTrigger: CPU as never, id: "self" }));
    expect(r.matches.map((m) => [m.assetId, m.excludedBy?.ruleId ?? null])).toEqual([["b", null], ["a", "p1"]]);
    expect(r).toMatchObject({ coveredEvaluated: 1, coveredAssets: 1, carveOut: { carvedOut: { count: 1 } } });
    expect(r.specificity).toEqual({ rank: 0, label: expect.any(String) });
    expect(stubbed(prisma.notificationRule.findMany).mock.calls[0]![0].where).toEqual({ enabled: true, id: { not: "self" } });
  });

  it("caps the listed devices at 200 but counts them all", async () => {
    h.loadScopeAssets.mockResolvedValue(Array.from({ length: 205 }, (_, i) => scopeAsset(`a${i}`)));
    const r = await previewRule(draft({ trigger: undefined }));
    expect(r.matches).toHaveLength(200);
    expect(r.totalEvaluated).toBe(205);
  });
});

describe("previewRule — event and change drafts (rule 46)", () => {
  it("an unconstrained scope has nothing to show: unsupported, with the note", async () => {
    const r = await previewRule(draft({ trigger: { type: "event", actionPattern: "integration.*" } as never }));
    expect(r).toEqual({ supported: false, note: expect.stringMatching(/^Event and change automations fire on new audit events/), totalEvaluated: 0, meetsCount: 0, matches: [] });
    expect(h.loadScopeAssets).not.toHaveBeenCalled();
  });

  it("a narrowed scope lists who it would fire ABOUT, and says so", async () => {
    h.loadScopeAssets.mockResolvedValue([scopeAsset("a")]);
    const r = await previewRule(draft({ trigger: { type: "change", changeType: "sdwan_failover" } as never, scope: { assetTypes: ["firewall"] } }));
    expect(r.supported).toBe(true);
    expect(r.matches.map((m) => m.assetId)).toEqual(["a"]);
    expect(r.note).toMatch(/These are the devices the filter selects — the automation only fires about these\.$/);
  });
});

describe("previewRule — metric drafts", () => {
  it("meets first; meetsCount over every reading; totalAssets counts DEVICES not readings", async () => {
    h.loadScopeAssets.mockResolvedValue([scopeAsset("a"), scopeAsset("b")]);
    h.resolveAssetMetricReadings.mockResolvedValue([
      reading("a", 50, "core0"), reading("a", 95, "core1"), reading("b", 99, "core0"), reading("b", null, "core1"),
    ]);
    const r = await previewRule(draft());
    expect(r).toMatchObject({ supported: true, totalEvaluated: 4, meetsCount: 2, totalAssets: 2 });
    expect(r.matches.map((m) => m.meets)).toEqual([true, true, false, false]);
    expect(r.matches[0]).toMatchObject({ assetId: "a", dimension: "core1", dimensionKey: "core1", value: 95 });
    expect(r.specificity).toEqual({ rank: 0, label: expect.any(String) });
    expect(h.loadScopeAssets).toHaveBeenCalledWith(expect.anything(), { monitoredOnly: true });
  });

  it("a severity ladder names each value's band (null below tier 0)", async () => {
    h.loadScopeAssets.mockResolvedValue([scopeAsset("a")]);
    h.resolveAssetMetricReadings.mockResolvedValue([reading("a", 80, "x"), reading("a", 92, "y"), reading("a", 99, "z")]);
    const r = await previewRule(draft({ severityBands: [{ threshold: 98, severity: "critical" }] as never }));
    const byDim = Object.fromEntries(r.matches.map((m) => [m.dimension, m.severity]));
    expect(byDim).toEqual({ x: null, y: "warning", z: "critical" });
  });

  it("auto reset with a clear threshold shows the dead band", async () => {
    h.loadScopeAssets.mockResolvedValue([scopeAsset("a")]);
    h.resolveAssetMetricReadings.mockResolvedValue([reading("a", 95, "hot"), reading("a", 85, "band"), reading("a", 70, "cool")]);
    const r = await previewRule(draft({ reset: { mode: "auto", clearThreshold: 80 } as never }));
    const byDim = Object.fromEntries(r.matches.map((m) => [m.dimension, [m.meets, m.wouldClear, m.inDeadBand]]));
    expect(byDim).toEqual({ hot: [true, false, false], band: [false, false, true], cool: [false, true, false] });
  });

  it("without auto reset there is no hysteresis view", async () => {
    h.loadScopeAssets.mockResolvedValue([scopeAsset("a")]);
    h.resolveAssetMetricReadings.mockResolvedValue([reading("a", 95)]);
    const r = await previewRule(draft());
    expect(r.matches[0]).not.toHaveProperty("wouldClear");
    expect(r.matches[0]).not.toHaveProperty("severity");
  });

  it("the email sample is built from the first MATCHING reading, and nothing is rendered with no readings", async () => {
    h.loadScopeAssets.mockResolvedValue([scopeAsset("a"), scopeAsset("b")]);
    h.resolveAssetMetricReadings.mockResolvedValue([reading("a", 10), reading("b", 97)]);
    stubbed(prisma.asset.findUnique).mockResolvedValue(null);
    const r = await previewRule(draft());
    expect(r.emailPreview).toEqual({ subject: "S", text: "T", html: "<p>H</p>" });
    const ctx = h.buildComposedEmail.mock.calls[0]![1] as Record<string, string>;
    expect(ctx.asset).toBe("B");
    expect(ctx.value).toContain("97");
    h.buildComposedEmail.mockClear();
    h.resolveAssetMetricReadings.mockResolvedValue([]);
    const empty = await previewRule(draft());
    expect(empty.emailPreview).toBeUndefined();
    expect(h.buildComposedEmail).not.toHaveBeenCalled();
  });

  it("a host draft reads the Polaris host and reports no device count", async () => {
    h.resolveHostMetricReading.mockResolvedValue({ assetId: "", hostname: "Polaris", tags: [], dimKey: "", dimLabel: "", value: 93 });
    const r = await previewRule(draft({ trigger: { type: "host_metric", metric: "cpuPct", operator: ">", threshold: 90 } as never }));
    expect(r).toMatchObject({ totalEvaluated: 1, meetsCount: 1 });
    expect(r).not.toHaveProperty("totalAssets");
    expect(r.matches[0]!.assetId).toBeNull();
    expect(r.specificity).toBeUndefined();
    expect(h.loadScopeAssets).not.toHaveBeenCalled();
  });

  it("a state draft evaluates the asset_state readings", async () => {
    h.loadScopeAssets.mockResolvedValue([scopeAsset("a")]);
    h.resolveAssetStateReadings.mockResolvedValue([reading("a", "down")]);
    const r = await previewRule(draft({ trigger: { type: "asset_state", field: "monitorStatus", operator: "==", value: "down" } as never }));
    expect(r).toMatchObject({ meetsCount: 1, totalAssets: 1 });
  });
});

describe("previewAlertMessage — the In-app Alert example", () => {
  it("candidates are the monitored scope sorted by name; the asked-for device is used", async () => {
    h.loadScopeAssets.mockResolvedValue([scopeAsset("zeta"), scopeAsset("alpha"), scopeAsset("mid", { hostname: null })]);
    h.resolveAssetMetricReadings.mockResolvedValue([reading("zeta", 50), reading("zeta", 96, "core3")]);
    const r = await previewAlertMessage(draft({ messageTemplate: "{asset} at {value}" } as never), "zeta");
    expect(r.candidates.map((c) => c.id)).toEqual(["alpha", "mid", "zeta"]);
    expect(r.truncated).toBe(false);
    expect(r.asset).toEqual({ id: "zeta", hostname: "ZETA" });
    expect(r.noReading).toBe(false);
    expect(r.message).toContain("ZETA");
    expect(r.message).toContain("96");
    expect(r.values.message).toBe(r.message);
    expect(r.applicable).toContain("{asset}");
  });

  it("caps the candidate list at 200 and says it was truncated", async () => {
    h.loadScopeAssets.mockResolvedValue(Array.from({ length: 201 }, (_, i) => scopeAsset(`a${String(i).padStart(3, "0")}`)));
    const r = await previewAlertMessage(draft(), "a000");
    expect(r.candidates).toHaveLength(200);
    expect(r.truncated).toBe(true);
  });

  it("a device with no current reading is flagged noReading", async () => {
    h.loadScopeAssets.mockResolvedValue([scopeAsset("a")]);
    const r = await previewAlertMessage(draft(), "a");
    expect(r.noReading).toBe(true);
  });

  it("a band lifts the example's severity when the reading reaches it", async () => {
    h.loadScopeAssets.mockResolvedValue([scopeAsset("a")]);
    h.resolveAssetMetricReadings.mockResolvedValue([reading("a", 99)]);
    const r = await previewAlertMessage(draft({ severityBands: [{ threshold: 98, severity: "critical" }] as never }), "a");
    expect(r.severity).toBe("critical");
  });

  it("an empty scope gives no device and no candidates", async () => {
    const r = await previewAlertMessage(draft(), "nope");
    expect(r).toMatchObject({ asset: null, candidates: [], truncated: false });
  });

  it("a host draft never loads a scope and is about Polaris itself", async () => {
    h.resolveHostMetricReading.mockResolvedValue(null);
    const r = await previewAlertMessage(draft({ trigger: { type: "host_metric", metric: "cpuPct", operator: ">", threshold: 90 } as never }));
    expect(h.loadScopeAssets).not.toHaveBeenCalled();
    expect(r).toMatchObject({ asset: null, noReading: true });
  });

  it("an event draft uses the stand-in for the source event's message", async () => {
    h.loadScopeAssets.mockResolvedValue([scopeAsset("a")]);
    const r = await previewAlertMessage(draft({ name: "Integration failed", trigger: { type: "event", actionPattern: "integration.sync.failed" } as never }), "a");
    expect(r.message).toBe("Integration failed: (the source event’s own message)");
    const withTemplate = await previewAlertMessage(draft({ trigger: { type: "event", actionPattern: "x.*" } as never, messageTemplate: "{asset}: {value}" } as never), "a");
    expect(withTemplate.message).toBe("A: (the source event’s own message)");
  });
});
