/**
 * tests/unit/actionReferenceService.test.ts
 *
 * Business rule 167: a notification channel or an automation script that
 * something still names cannot be deleted — wherever the action that names it
 * lives. The script guard used to look at a rule's own actions and its
 * rule-level escalation tiers only; the channel had no guard at all, so an
 * automation whose channel was deleted went silent with nothing to say why.
 *
 * Each case puts the reference in ONE location and nowhere else, so a
 * location the walk stops visiting fails here by name.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  rules: [] as Array<Record<string, unknown>>,
  groups: [] as Array<Record<string, unknown>>,
  upgrades: 0,
  reboots: 0,
  channel: { id: "ch-1", name: "Ops email", type: "email" } as Record<string, unknown> | null,
  deleted: [] as string[],
  logEvent: vi.fn(async (_e: unknown) => {}),
}));

vi.mock("../../src/db.js", () => ({
  prisma: {
    notificationRule: { findMany: vi.fn(async () => h.rules) },
    alertGroup: { findMany: vi.fn(async () => h.groups) },
    firmwareUpgradeSchedule: { count: vi.fn(async () => h.upgrades) },
    rebootSchedule: { count: vi.fn(async () => h.reboots) },
    notificationChannel: {
      findUnique: vi.fn(async () => h.channel),
      delete: vi.fn(async ({ where }: { where: { id: string } }) => { h.deleted.push(where.id); return {}; }),
    },
  },
}));
vi.mock("../../src/services/eventLogService.js", () => ({ logEvent: h.logEvent }));

import { channelReferrers, scriptReferrers, findActionReferrers, summarizeReferrers } from "../../src/services/actionReferenceService.js";
import { deleteChannel } from "../../src/services/notificationChannelService.js";

const CH = "ch-1";
const SC = "sc-1";
const notify = (channelId = CH, extra: Record<string, unknown> = {}) => ({ type: "notify", channelId, ...extra });
const script = (scriptId = SC) => ({ type: "script", scriptId, runOn: "server" });
const other = () => notify("ch-other");
const tiers = (action: Record<string, unknown>) => ({ stopOn: "acknowledge", tiers: [{ afterMin: 10, actions: [action] }] });

/** A stored v2 rule with nothing in it but what the case adds. */
const rule = (name: string, over: Record<string, unknown>) => ({
  name, trigger: { metric: "cpu" }, targets: [], emailComposition: null, escalation: null, clearBehavior: "manual",
  clearAfterSec: null, reset: { mode: "manual" }, actions: [], severityBands: null, bandNotify: null, resetActions: null, repeat: null,
  ...over,
});
const band = (over: Record<string, unknown>) => ({ severity: "critical", threshold: 90, ...over });

beforeEach(() => {
  vi.clearAllMocks();
  h.rules = [];
  h.groups = [];
  h.upgrades = 0;
  h.reboots = 0;
  h.deleted = [];
  h.channel = { id: CH, name: "Ops email", type: "email" };
});

describe("rule 167: every place an action can live is searched", () => {
  const LOCATIONS: Array<[string, (a: Record<string, unknown>) => Record<string, unknown>]> = [
    ["the rule's own actions", (a) => ({ actions: [a] })],
    ["a per-action escalation tier", (a) => ({ actions: [{ ...other(), escalation: tiers(a) }] })],
    ["the rule-level escalation", (a) => ({ actions: [other()], escalation: tiers(a) })],
    ["a severity band's actions", (a) => ({ severityBands: [band({ actions: [a] })] })],
    ["a severity band's escalation", (a) => ({ severityBands: [band({ actions: [other()], escalation: tiers(a) })] })],
    ["a band action's own escalation tier", (a) => ({ severityBands: [band({ actions: [{ ...other(), escalation: tiers(a) }] })] })],
    ["the all-clear (resolved) actions", (a) => ({ severityBands: [band({ actions: [other()] })], bandNotify: { resolvedActions: [a] } })],
    ["the reset actions", (a) => ({ actions: [other()], resetActions: [a] })],
  ];

  for (const [where, build] of LOCATIONS) {
    it(`finds a channel named only in ${where}`, async () => {
      h.rules = [rule("R", build(notify()))];
      expect(await channelReferrers(CH)).toEqual(['automation "R"']);
      expect(await channelReferrers("ch-unused")).toEqual([]);
    });

    it(`finds a script named only in ${where}`, async () => {
      h.rules = [rule("R", build(script()))];
      expect(await scriptReferrers(SC)).toEqual(['automation "R"']);
      expect(await scriptReferrers("sc-unused")).toEqual([]);
    });
  }

  it("finds a channel listed in a notify action's channelIds, not only its first channel", async () => {
    h.rules = [rule("R", { actions: [notify("ch-first", { channelIds: ["ch-first", CH] })] })];
    expect(await channelReferrers(CH)).toEqual(['automation "R"']);
  });

  it("walks a pre-v2 rule's legacy targets", async () => {
    h.rules = [rule("Legacy", { actions: null, targets: [{ channelId: CH }] })];
    expect(await channelReferrers(CH)).toEqual(['automation "Legacy"']);
  });

  it("searches alert groups: their actions, tiers and reset actions", async () => {
    h.groups = [
      { name: "G actions", actions: [notify()], resetActions: null, escalation: null },
      { name: "G tier", actions: [other()], resetActions: null, escalation: tiers(script()) },
      { name: "G reset", actions: [other()], resetActions: [notify()], escalation: null },
      { name: "G clean", actions: [other()], resetActions: null, escalation: null },
    ];
    expect(await channelReferrers(CH)).toEqual(['alert group "G actions"', 'alert group "G reset"']);
    expect(await scriptReferrers(SC)).toEqual(['alert group "G tier"']);
  });

  it("names each referrer once, however many of its actions match", async () => {
    h.rules = [rule("Twice", { actions: [notify(), notify()], resetActions: [notify()] })];
    expect(await channelReferrers(CH)).toEqual(['automation "Twice"']);
  });

  it("a stored action that no longer parses is skipped, not thrown on", async () => {
    h.rules = [rule("Broken", { actions: [{ type: "nonsense" }, notify()] })];
    h.groups = [{ name: "G", actions: [{ nope: true }], resetActions: "x", escalation: 7 }];
    expect(await channelReferrers(CH)).toEqual(['automation "Broken"']);
  });

  it("counts booked firmware upgrades and reboots that list the channel", async () => {
    h.upgrades = 2;
    h.reboots = 1;
    expect(await channelReferrers(CH)).toEqual(["2 scheduled firmware upgrades", "1 scheduled reboot"]);
  });

  it("findActionReferrers takes any predicate", async () => {
    h.rules = [rule("A", { actions: [{ type: "api_call", method: "POST", url: "https://hooks.example.test/x" }] }), rule("B", { actions: [notify()] })];
    expect(await findActionReferrers((a) => a.type === "api_call")).toEqual(['automation "A"']);
  });

  it("summarizeReferrers caps the list and says how many more", () => {
    expect(summarizeReferrers(["a", "b"])).toBe("a, b");
    expect(summarizeReferrers(["a", "b", "c", "d", "e", "f", "g"])).toBe("a, b, c, d, e, … (+2 more)");
  });
});

describe("rule 167: deleting a channel", () => {
  it("is refused while anything still sends through it, naming what does", async () => {
    h.rules = [rule("Core down", { severityBands: [band({ actions: [notify()] })] })];
    h.reboots = 1;
    await expect(deleteChannel(CH, "tester")).rejects.toMatchObject({
      httpStatus: 409,
      message: 'Channel "Ops email" is still used by automation "Core down", 1 scheduled reboot. Point those at another channel first.',
    });
    expect(h.deleted).toEqual([]);
    expect(h.logEvent).not.toHaveBeenCalled();
  });

  it("goes ahead once nothing names it", async () => {
    h.rules = [rule("Core down", { actions: [other()] })];
    await deleteChannel(CH, "tester");
    expect(h.deleted).toEqual([CH]);
    expect(h.logEvent).toHaveBeenCalledWith(expect.objectContaining({ action: "notification_channel.deleted" }));
  });

  it("is still a 404 for a channel that is not there", async () => {
    h.channel = null;
    await expect(deleteChannel("nope")).rejects.toMatchObject({ httpStatus: 404 });
  });
});
