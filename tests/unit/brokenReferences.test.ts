/**
 * tests/unit/brokenReferences.test.ts
 *
 * Business rule 177: each automation in the list says what it names that no
 * longer exists — a delivery channel or automation script in any action
 * location, or a path check, custom widget or state probe a condition is
 * narrowed to. The list shows only a marker; the messages are its hover text
 * and the editor's warning.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  channels: [] as string[],
  scripts: [] as string[],
  checks: [] as string[],
  widgets: [] as string[],
  reads: [] as string[],
  live(name: string, pool: () => string[]) {
    return {
      findMany: async ({ where }: { where: { id: { in: string[] } } }) => {
        h.reads.push(name);
        return where.id.in.filter((id) => pool().includes(id)).map((id) => ({ id }));
      },
    };
  },
}));

vi.mock("../../src/db.js", () => ({
  prisma: {
    notificationChannel: h.live("channel", () => h.channels),
    automationScript: h.live("script", () => h.scripts),
    pathCheck: h.live("check", () => h.checks),
    manufacturerCustomWidget: h.live("widget", () => h.widgets),
  },
}));

import { brokenReferencesByRule, withBrokenReferences } from "../../src/services/actionReferenceService.js";

const leaf = (metric: string, dimensionFilter: Record<string, string> = {}) =>
  ({ type: "asset_metric", metric, operator: ">", threshold: 1, aggregation: "latest", dimensionFilter });
const rule = (id: string, extra: Record<string, unknown> = {}) =>
  ({ id, trigger: leaf("cpuPct"), reset: { mode: "auto" }, actions: [], ...extra });
const notify = (channelId: string) => ({ type: "notify", channelId });
const script = (scriptId: string) => ({ type: "script", scriptId, runOn: "server" });

beforeEach(() => {
  h.channels = ["ch-live"];
  h.scripts = ["sc-live"];
  h.checks = ["pc-live"];
  h.widgets = ["w-live"];
  h.reads = [];
});

describe("rule 177: brokenReferencesByRule", () => {
  it("names a deleted channel and a deleted script in the actions, and nothing live", async () => {
    const out = await brokenReferencesByRule([
      rule("r1", { actions: [notify("ch-live"), notify("ch-gone"), script("sc-gone")] }),
      rule("r2", { actions: [notify("ch-live"), script("sc-live")] }),
    ]);
    expect(out.get("r2")).toBeUndefined();
    expect(out.get("r1")!.map((b) => b.kind)).toEqual(["channel", "script"]);
    expect(out.get("r1")![0]!.message).toBe("Action 2 sends to a delivery channel that was deleted, so it sends nothing through it.");
    expect(out.get("r1")![1]!.message).toBe("Action 3 runs an automation script that was deleted, so it runs nothing.");
  });

  it("finds a deleted channel in an escalation tier and a reset action", async () => {
    const out = await brokenReferencesByRule([rule("r1", {
      actions: [{ ...notify("ch-live"), escalation: { stopOn: "acknowledge", tiers: [{ afterMin: 10, actions: [notify("ch-gone")] }] } }],
      resetActions: [notify("ch-gone2")],
    })]);
    const messages = out.get("r1")!.map((b) => b.message);
    expect(messages.some((m) => m.startsWith("Action 1 escalation tier 1 sends to a delivery channel that was deleted"))).toBe(true);
    expect(messages.some((m) => m.startsWith("Reset action 1 sends to a delivery channel that was deleted"))).toBe(true);
  });

  it("names a deleted path check, widget and state probe a condition is narrowed to, in the trigger or the reset", async () => {
    const out = await brokenReferencesByRule([
      rule("check", { trigger: leaf("pathOk", { checkId: "pc-gone" }) }),
      rule("widget", { trigger: leaf("customWidgetValue", { widgetId: "w-gone" }) }),
      rule("probe", { trigger: { type: "composite", op: "and", children: [leaf("cpuPct")] }, reset: { mode: "condition", condition: { op: "and", children: [leaf("customStateValue", { stateProbeId: "p-gone" })] } } }),
      rule("fine", { trigger: leaf("pathOk", { checkId: "pc-live" }) }),
    ]);
    expect(out.get("check")!.map((b) => b.kind)).toEqual(["pathCheck"]);
    expect(out.get("widget")!.map((b) => b.kind)).toEqual(["widget"]);
    expect(out.get("probe")!.map((b) => b.kind)).toEqual(["stateProbe"]);
    expect(out.get("fine")).toBeUndefined();
  });

  it("reads each kind of object once for the whole list, and not at all when nothing names it", async () => {
    await brokenReferencesByRule([
      rule("a", { actions: [notify("ch-gone")] }),
      rule("b", { actions: [notify("ch-live")] }),
      rule("c", { actions: [notify("ch-x")] }),
    ]);
    expect(h.reads).toEqual(["channel"]);
  });

  it("does not repeat one message, and survives a row whose actions do not parse", async () => {
    const out = await brokenReferencesByRule([
      rule("dup", { actions: [notify("ch-gone")], severityBands: [] }),
      rule("bad", { actions: "nonsense" }),
    ]);
    expect(out.get("dup")!.length).toBe(1);
    expect(out.get("bad")).toBeUndefined();
  });

  it("withBrokenReferences gives every row the field, empty when nothing is broken", async () => {
    const rows = await withBrokenReferences([rule("ok"), rule("gone", { actions: [script("sc-gone")] })]);
    expect(rows[0]!.brokenReferences).toEqual([]);
    expect(rows[1]!.brokenReferences.map((b) => b.kind)).toEqual(["script"]);
  });
});
