/**
 * tests/unit/notificationRuleService.test.ts — notificationRuleService's own
 * suite (CQ-T010).
 *
 * Complements, rather than repeats:
 *   - metricSeverityTiers.test.ts / rulesMatchingAssetCarveOut.test.ts (tier ladder, rule-18 carve-out)
 *   - notificationStrandedAlerts.test.ts (disable / delete clear the active alerts)
 *   - resetMatchEscalation.test.ts (assertResetLinks, rule 145)
 *   - rebootAutomationAction.test.ts (assertActionRefs' reboot branch, rule 115(c))
 *   - systemInfoPersist / wirelessRoamEventsGate (isChangeActionSubscribed, mocked)
 *   - tests/integration/interfaceTags + ssidDeviceFilter (listScopeOptions against a DB)
 *
 * What this adds: assertActionRefs' save-time gates for notify (channelId must
 * lead channelIds, no channel twice, every channel must exist, broadcast only
 * with a Web Push channel), api_call (unparseable URL, the SSRF host guard) and
 * script (missing, disabled, wrong runTarget) actions — and that a clean rule
 * reads nothing; createRule's legacy mirror, defaults, cache bumps and audit;
 * updateRule's identity-change and regroup clears, the nullable-Json "absent
 * keeps / null clears" rule, and the 404; the forecast level link's refusals
 * (itself, a vanished source, an ineligible source) and its stored copy;
 * the change-subscription cache (read once, invalidated by every rule write);
 * listRecipientCatalog's fallbacks; listScopeOptions' blank filtering, failed
 * groupBy tolerance and native-VLAN labels; and listRules' v2 fill.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../src/db.js", () => import("./_dbStub.js"));
import { prisma } from "../../src/db.js";
import { resetDbStub, stubbed } from "./_dbStub.js";

vi.mock("../../src/services/eventLogService.js", (orig) => import("./_eventLogStub.js").then((s) => s.withEventLogStubs(orig)));
import { eventLog, resetEventLogStub } from "./_eventLogStub.js";

const h = vi.hoisted(() => ({
  listRegions: vi.fn(),
  regionLevelIndex: vi.fn(),
  invalidateDownDetectionCache: vi.fn(),
  bumpQuietTimeCache: vi.fn(),
}));

vi.mock("../../src/services/mapRegionService.js", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  listRegions: h.listRegions,
}));
vi.mock("../../src/services/regionHierarchyService.js", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  regionLevelIndex: h.regionLevelIndex,
}));
vi.mock("../../src/services/downDetectionService.js", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  invalidateDownDetectionCache: h.invalidateDownDetectionCache,
}));
vi.mock("../../src/services/quietTimeHoldService.js", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  bumpQuietTimeCache: h.bumpQuietTimeCache,
}));

import {
  assertActionRefs,
  createRule,
  updateRule,
  deleteRule,
  listRules,
  isChangeActionSubscribed,
  listRecipientCatalog,
  listScopeOptions,
} from "../../src/services/notificationRuleService.js";
import { ruleInputSchema, type RuleInput } from "../../src/services/notificationTypes.js";
import { Prisma } from "../../src/generated/prisma/client.js";

const notify = (over: Record<string, unknown> = {}) => ({ type: "notify", channelId: "c-mail", ...over });
const carrier = (actions: unknown[], extra: Record<string, unknown> = {}) => ({ actions, ...extra }) as never;

const baseInput = (over: Record<string, unknown> = {}): RuleInput =>
  ruleInputSchema.parse({
    name: "Switch CPU",
    severity: "warning",
    trigger: { type: "asset_metric", metric: "cpuPct", aggregation: "latest", windowSec: 60, operator: ">=", threshold: 90 },
    scope: { allAssets: true },
    reset: { mode: "auto" },
    ...over,
  });

const stored = (over: Record<string, unknown> = {}) => ({
  id: "r1", name: "Switch CPU", description: null, enabled: true, severity: "warning",
  trigger: { type: "asset_metric", metric: "cpuPct", aggregation: "latest", windowSec: 60, operator: ">=", threshold: 90 },
  scope: { allAssets: true }, reset: { mode: "auto" }, actions: [], groupByAsset: false,
  clearBehavior: "auto", clearAfterSec: null, cooldownSec: null, messageTemplate: null, channels: ["in_app"], targets: [],
  emailComposition: null, escalation: null, severityBands: null, bandNotify: null, alertGroup: null,
  ...over,
});

beforeEach(() => {
  resetDbStub();
  resetEventLogStub();
  for (const f of Object.values(h)) f.mockReset();
  h.listRegions.mockResolvedValue([]);
  h.regionLevelIndex.mockResolvedValue({ maxLevel: 1, byName: new Map() });
  stubbed(prisma.notificationChannel.findMany).mockResolvedValue([
    { id: "c-mail", type: "smtp" },
    { id: "c-push", type: "web_push" },
  ]);
  stubbed(prisma.automationScript.findMany).mockResolvedValue([]);
  stubbed(prisma.notification.updateMany).mockResolvedValue({ count: 0 });
  stubbed(prisma.notificationRuleState.deleteMany).mockResolvedValue({ count: 0 });
  stubbed(prisma.notificationRule.findMany).mockResolvedValue([]);
});

// ─── assertActionRefs ───────────────────────────────────────────────────────

describe("assertActionRefs — notify", () => {
  it("passes a rule with no references without reading anything", async () => {
    await assertActionRefs(carrier([{ type: "event" }]));
    expect(prisma.notificationChannel.findMany).not.toHaveBeenCalled();
    expect(prisma.automationScript.findMany).not.toHaveBeenCalled();
  });

  it("passes existing channels, reading them once for every action", async () => {
    await assertActionRefs(carrier([notify(), notify({ channelId: "c-push", channelIds: ["c-push", "c-mail"] })]));
    expect(prisma.notificationChannel.findMany).toHaveBeenCalledTimes(1);
    expect(stubbed(prisma.notificationChannel.findMany).mock.calls[0][0].where.id.in.sort()).toEqual(["c-mail", "c-push"]);
  });

  it("refuses a channelId that is not the first of channelIds", async () => {
    await expect(assertActionRefs(carrier([notify({ channelIds: ["c-push", "c-mail"] })])))
      .rejects.toMatchObject({ httpStatus: 400, message: "Action 1: channelId must be the first entry of channelIds" });
  });

  it("refuses the same channel listed twice", async () => {
    await expect(assertActionRefs(carrier([notify({ channelIds: ["c-mail", "c-mail"] })])))
      .rejects.toMatchObject({ message: "Action 1: the same delivery channel is listed twice" });
  });

  it("refuses a deleted channel, naming where it is", async () => {
    await expect(assertActionRefs(carrier([notify()], { resetActions: [notify({ channelId: "gone" })] })))
      .rejects.toMatchObject({ message: "Reset action 1: references a delivery channel that no longer exists" });
  });

  it("refuses an all-users broadcast with no Web Push channel, allows it beside one", async () => {
    await expect(assertActionRefs(carrier([notify({ recipientAllUsers: true })])))
      .rejects.toMatchObject({ httpStatus: 400 });
    await expect(assertActionRefs(carrier([notify({ channelId: "c-mail", channelIds: ["c-mail", "c-push"], recipientAllRegions: true })])))
      .resolves.toBeUndefined();
  });
});

describe("assertActionRefs — api_call and script", () => {
  it("refuses an unparseable URL and a blocked host (SSRF guard)", async () => {
    await expect(assertActionRefs(carrier([{ type: "api_call", url: "not a url" }])))
      .rejects.toMatchObject({ message: "Action 1: api_call URL is not a valid URL" });
    await expect(assertActionRefs(carrier([{ type: "api_call", url: "http://169.254.169.254/latest/meta-data" }])))
      .rejects.toMatchObject({ httpStatus: 400, message: expect.stringContaining('api_call host "169.254.169.254" is blocked') });
    await expect(assertActionRefs(carrier([{ type: "api_call", url: "http://127.0.0.1:8080/x" }])))
      .rejects.toMatchObject({ httpStatus: 400 });
  });

  it("passes a routable api_call host", async () => {
    await expect(assertActionRefs(carrier([{ type: "api_call", url: "https://hooks.example.com/x" }]))).resolves.toBeUndefined();
  });

  it("refuses a script that is gone, disabled, or meant for the other side", async () => {
    stubbed(prisma.automationScript.findMany).mockResolvedValue([
      { id: "s-off", name: "Off", enabled: false, runTarget: "either" },
      { id: "s-srv", name: "Server only", enabled: true, runTarget: "server" },
      { id: "s-any", name: "Any", enabled: true, runTarget: "either" },
    ]);
    await expect(assertActionRefs(carrier([{ type: "script", scriptId: "s-gone", runOn: "server" }])))
      .rejects.toMatchObject({ message: "Action 1: references a script that no longer exists in the registry" });
    await expect(assertActionRefs(carrier([{ type: "script", scriptId: "s-off", runOn: "server" }])))
      .rejects.toMatchObject({ message: 'Action 1: script "Off" is disabled' });
    await expect(assertActionRefs(carrier([{ type: "script", scriptId: "s-srv", runOn: "asset" }])))
      .rejects.toMatchObject({ message: 'Action 1: script "Server only" only runs on server, but the action requests asset' });
    await expect(assertActionRefs(carrier([{ type: "script", scriptId: "s-any", runOn: "asset" }, { type: "script", scriptId: "s-any", runOn: "server" }])))
      .resolves.toBeUndefined();
    // De-duplicated read.
    expect(stubbed(prisma.automationScript.findMany).mock.calls.at(-1)![0].where.id.in).toEqual(["s-any"]);
  });
});

// ─── createRule ─────────────────────────────────────────────────────────────

describe("createRule", () => {
  beforeEach(() => {
    stubbed(prisma.notificationRule.create).mockImplementation(async (args: { data: Record<string, unknown> }) => ({ id: "new", ...args.data }));
  });

  it("stores the input with its legacy mirror and boolean defaults, bumps every cache and audits", async () => {
    await createRule(baseInput(), "dmoore");
    const data = stubbed(prisma.notificationRule.create).mock.calls[0][0].data;
    expect(data).toMatchObject({
      name: "Switch CPU", description: null, severity: "warning", clearBehavior: "auto",
      cooldownSec: null, messageTemplate: null, requireAckNote: false, groupByAsset: false, severityFromPriorityTag: false,
      createdBy: "dmoore",
    });
    expect(h.bumpQuietTimeCache).toHaveBeenCalledTimes(1);
    expect(h.invalidateDownDetectionCache).toHaveBeenCalledTimes(1);
    expect(eventLog.logEvent.mock.calls[0][0]).toMatchObject({
      action: "notification_rule.created", resourceId: "new", actor: "dmoore",
      message: 'Notification rule "Switch CPU" created (asset_metric)', details: { triggerType: "asset_metric", severity: "warning" },
    });
  });

  it("refuses a bad action reference before writing anything", async () => {
    const input = baseInput();
    (input as { actions: unknown[] }).actions = [notify({ channelId: "gone" })];
    await expect(createRule(input)).rejects.toMatchObject({ httpStatus: 400 });
    expect(prisma.notificationRule.create).not.toHaveBeenCalled();
  });
});

describe("forecast level link (createRule / updateRule)", () => {
  const forecastInput = (levelsFromRuleId: string) => baseInput({
    name: "Memory forecast",
    trigger: { type: "asset_metric", metric: "memForecastPct", aggregation: "latest", windowSec: 60, operator: ">=", threshold: 80, forecastDays: 14, levelsFromRuleId },
  });

  beforeEach(() => {
    stubbed(prisma.notificationRule.create).mockImplementation(async (args: { data: Record<string, unknown> }) => ({ id: "f", ...args.data }));
  });

  it("refuses a source that no longer exists", async () => {
    stubbed(prisma.notificationRule.findUnique).mockResolvedValue(null);
    await expect(createRule(forecastInput("r-gone"))).rejects.toMatchObject({ httpStatus: 400, message: expect.stringContaining("no longer exists") });
  });

  it("refuses a source that is not a single upward Memory utilization condition", async () => {
    stubbed(prisma.notificationRule.findUnique).mockResolvedValue({ trigger: { type: "asset_metric", metric: "cpuPct", operator: ">=", threshold: 90 }, severity: "warning", severityBands: null });
    await expect(createRule(forecastInput("r-cpu"))).rejects.toMatchObject({ httpStatus: 400 });
  });

  it("stores the source's levels on the forecast", async () => {
    stubbed(prisma.notificationRule.findUnique).mockResolvedValue({ trigger: { type: "asset_metric", metric: "memPct", operator: ">", threshold: 85 }, severity: "serious", severityBands: null });
    await createRule(forecastInput("r-mem"));
    const data = stubbed(prisma.notificationRule.create).mock.calls[0][0].data;
    expect(data.severity).toBe("serious");
    expect(data.trigger).toMatchObject({ operator: ">", threshold: 85, levelsFromRuleId: "r-mem" });
  });

  it("refuses a forecast linked to itself on update", async () => {
    stubbed(prisma.notificationRule.findUnique).mockResolvedValue(stored({ id: "self" }));
    await expect(updateRule("self", forecastInput("self"))).rejects.toMatchObject({ message: "A forecast cannot take its levels from itself" });
  });
});

// ─── updateRule / deleteRule ────────────────────────────────────────────────

describe("updateRule", () => {
  beforeEach(() => {
    stubbed(prisma.notificationRule.findUnique).mockResolvedValue(stored());
    stubbed(prisma.notificationRule.update).mockImplementation(async (args: { data: Record<string, unknown> }) => ({ id: "r1", ...args.data }));
  });

  it("is a 404 for a rule that does not exist", async () => {
    stubbed(prisma.notificationRule.findUnique).mockResolvedValue(null);
    await expect(updateRule("nope", baseInput())).rejects.toMatchObject({ httpStatus: 404 });
    expect(prisma.notificationRule.update).not.toHaveBeenCalled();
  });

  it("a changed trigger IDENTITY clears the rule's alerts as rule-edited and drops its state rows", async () => {
    const input = baseInput({ trigger: { type: "asset_metric", metric: "memPct", aggregation: "latest", windowSec: 60, operator: ">=", threshold: 90 } });
    await updateRule("r1", input, "op");
    const clear = stubbed(prisma.notification.updateMany).mock.calls[0][0];
    expect(clear.where).toEqual({ ruleId: "r1", cleared: false });
    expect(clear.data.clearedBy).toBe("system:rule-edited");
    expect(prisma.notificationRuleState.deleteMany).toHaveBeenCalledWith({ where: { ruleId: "r1" } });
    expect(eventLog.logEvent.mock.calls[0][0].details).toMatchObject({ triggerIdentityChanged: true });
  });

  it("a threshold edit keeps the identity and clears nothing", async () => {
    await updateRule("r1", baseInput({ trigger: { type: "asset_metric", metric: "cpuPct", aggregation: "latest", windowSec: 60, operator: ">", threshold: 50 } }));
    expect(prisma.notification.updateMany).not.toHaveBeenCalled();
    expect(eventLog.logEvent.mock.calls[0][0].details).not.toHaveProperty("triggerIdentityChanged");
  });

  it("turning the per-device fold off reshapes the alerts: cleared as rule-regrouped (rule 75)", async () => {
    stubbed(prisma.notificationRule.findUnique).mockResolvedValue(stored({ groupByAsset: true }));
    await updateRule("r1", baseInput());
    expect(stubbed(prisma.notification.updateMany).mock.calls[0][0].data.clearedBy).toBe("system:rule-regrouped");
  });

  it("an absent nullable-Json field is left alone; an explicit null clears it", async () => {
    const input = baseInput() as unknown as Record<string, unknown>;
    input.escalation = null;
    delete input.emailComposition;
    await updateRule("r1", input as unknown as RuleInput);
    const data = stubbed(prisma.notificationRule.update).mock.calls[0][0].data;
    expect(data.escalation).toBe(Prisma.DbNull);
    expect(data.emailComposition).toBeUndefined();
    expect(h.bumpQuietTimeCache).toHaveBeenCalled();
    expect(h.invalidateDownDetectionCache).toHaveBeenCalled();
  });
});

describe("deleteRule", () => {
  it("is a 404 for a rule that does not exist, and deletes nothing", async () => {
    stubbed(prisma.notificationRule.findUnique).mockResolvedValue(null);
    await expect(deleteRule("nope")).rejects.toMatchObject({ httpStatus: 404 });
    expect(prisma.notificationRule.delete).not.toHaveBeenCalled();
  });

  it("audits the deletion by name and bumps the caches", async () => {
    stubbed(prisma.notificationRule.findUnique).mockResolvedValue(stored());
    await deleteRule("r1", "op");
    expect(eventLog.logEvent.mock.calls[0][0]).toMatchObject({ action: "notification_rule.deleted", resourceId: "r1", resourceName: "Switch CPU", actor: "op" });
    expect(h.bumpQuietTimeCache).toHaveBeenCalled();
    expect(h.invalidateDownDetectionCache).toHaveBeenCalled();
  });
});

// ─── change-subscription cache ──────────────────────────────────────────────

describe("isChangeActionSubscribed", () => {
  it("reads the enabled change rules once, then answers from cache until a rule write", async () => {
    stubbed(prisma.notificationRule.findUnique).mockResolvedValue(stored());
    stubbed(prisma.notificationRule.delete).mockResolvedValue({});
    // Start from a clean cache whatever ran before.
    await deleteRule("r1");
    stubbed(prisma.notificationRule.findMany).mockReset();
    stubbed(prisma.notificationRule.findMany).mockResolvedValue([
      { trigger: { type: "change", changeType: "lldp_neighbor_added" } },
      { trigger: { type: "asset_metric", metric: "cpuPct" } },
    ]);

    expect(await isChangeActionSubscribed("change.lldp.neighbor_added")).toBe(true);
    expect(await isChangeActionSubscribed("change.process.started")).toBe(false);
    expect(prisma.notificationRule.findMany).toHaveBeenCalledTimes(1);
    expect(stubbed(prisma.notificationRule.findMany).mock.calls[0][0]).toEqual({ where: { enabled: true }, select: { trigger: true } });

    // A rule write invalidates: the next ask reads again.
    stubbed(prisma.notificationRule.findMany).mockResolvedValue([{ trigger: { type: "change", changeType: "process_started" } }]);
    await deleteRule("r1");
    expect(await isChangeActionSubscribed("change.process.started")).toBe(true);
    expect(prisma.notificationRule.findMany).toHaveBeenCalledTimes(2);
  });
});

// ─── catalogues ─────────────────────────────────────────────────────────────

describe("listRecipientCatalog", () => {
  it("returns sorted bare region names, the level index, roles, and the tag registry with a default category", async () => {
    h.listRegions.mockResolvedValue([{ name: "West" }, { name: " " }, { name: "East" }]);
    h.regionLevelIndex.mockResolvedValue({ maxLevel: 2, byName: new Map([["east", { level: 1 }], ["west", { level: 2 }]]) });
    stubbed(prisma.role.findMany).mockResolvedValue([{ id: "r", name: "Admin" }]);
    stubbed(prisma.tag.findMany).mockResolvedValue([{ name: "pci", category: null }, { name: "", category: "X" }, { name: "core", category: "  " }, { name: "dc", category: "Site" }]);
    const out = await listRecipientCatalog();
    expect(out).toEqual({
      regions: ["East", "West"],
      regionLevels: { maxLevel: 2, byName: { east: 1, west: 2 } },
      roles: [{ id: "r", name: "Admin" }],
      tagCatalog: [{ name: "pci", category: "General" }, { name: "core", category: "General" }, { name: "dc", category: "Site" }],
    });
  });

  it("degrades every part to empty / flat rather than failing the picker", async () => {
    h.listRegions.mockRejectedValue(new Error("x"));
    h.regionLevelIndex.mockRejectedValue(new Error("x"));
    stubbed(prisma.role.findMany).mockRejectedValue(new Error("x"));
    stubbed(prisma.tag.findMany).mockRejectedValue(new Error("x"));
    expect(await listRecipientCatalog()).toEqual({ regions: [], regionLevels: { maxLevel: 1, byName: {} }, roles: [], tagCatalog: [] });
  });
});

describe("listScopeOptions", () => {
  beforeEach(() => {
    stubbed(prisma.role.findMany).mockResolvedValue([]);
    stubbed(prisma.tag.findMany).mockResolvedValue([]);
    stubbed(prisma.subnet.findMany).mockResolvedValue([{ id: "s", name: "LAN", cidr: "10.0.0.0/24" }]);
    stubbed(prisma.ipBlock.findMany).mockResolvedValue([]);
  });

  it("offers only non-blank values from the MONITORED fleet", async () => {
    stubbed(prisma.asset.findMany).mockImplementation(async (args: { select: Record<string, boolean>; where: Record<string, unknown> }) => {
      expect(args.where.monitored).toBe(true);
      return args.select.manufacturer ? [{ manufacturer: "Fortinet" }, { manufacturer: " " }] : [{ model: "FGT-60F" }, { model: null }];
    });
    stubbed(prisma.assetInterface.groupBy).mockImplementation(async (args: { by: string[] }) => {
      if (args.by[0] === "ifName") return [{ ifName: "port1" }, { ifName: "" }];
      if (args.by[0] === "nativeVlan") return [{ nativeVlan: 30 }, { nativeVlan: 10 }, { nativeVlan: null }];
      // The VLAN interface names, capped at three per id.
      return [
        { vlanId: 30, ifName: "a" }, { vlanId: 30, ifName: "b" }, { vlanId: 30, ifName: "c" }, { vlanId: 30, ifName: "d" },
        { vlanId: 99, ifName: null },
      ];
    });
    stubbed(prisma.assetApVap.groupBy).mockResolvedValue([{ ssid: "Corp" }, { ssid: null }]);

    const out = await listScopeOptions();
    expect(out.manufacturers).toEqual(["Fortinet"]);
    expect(out.models).toEqual(["FGT-60F"]);
    expect(out.interfaceNames).toEqual(["port1"]);
    expect(out.ssids).toEqual(["Corp"]);
    expect(out.nativeVlans).toEqual([{ value: "10", label: "10" }, { value: "30", label: "30 · a / b / c" }]);
    expect(out.subnets).toHaveLength(1);
    // The subnet list is IPAM, not inventory: deprecated ones are the only exclusion.
    expect(stubbed(prisma.subnet.findMany).mock.calls[0][0].where).toEqual({ status: { not: "deprecated" } });
  });

  it("a failed interface / SSID / VLAN read empties that picker rather than the whole payload", async () => {
    stubbed(prisma.asset.findMany).mockResolvedValue([]);
    stubbed(prisma.assetInterface.groupBy).mockRejectedValue(new Error("timeout"));
    stubbed(prisma.assetApVap.groupBy).mockRejectedValue(new Error("timeout"));
    const out = await listScopeOptions();
    expect(out).toMatchObject({ interfaceNames: [], ssids: [], nativeVlans: [], subnets: [{ id: "s" }] });
  });
});

describe("listRules", () => {
  it("fills a pre-v2 row's NULL reset / actions from the normalizer, newest first", async () => {
    stubbed(prisma.notificationRule.findMany).mockResolvedValue([
      stored({ id: "v2" }),
      stored({ id: "old", reset: null, actions: null }),
    ]);
    const rows = await listRules();
    expect(stubbed(prisma.notificationRule.findMany).mock.calls[0][0].orderBy).toEqual({ createdAt: "desc" });
    expect(rows[0]).toBe((await stubbed(prisma.notificationRule.findMany).mock.results[0].value)[0]);
    expect(rows[1].reset).toBeTruthy();
    expect(Array.isArray(rows[1].actions)).toBe(true);
  });
});
