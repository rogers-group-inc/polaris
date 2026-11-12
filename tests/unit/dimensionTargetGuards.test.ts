/**
 * tests/unit/dimensionTargetGuards.test.ts
 *
 * Business rule 167(a): a path check, custom widget or state probe that an
 * automation's condition is narrowed to is not deleted out from under it, and
 * a firing alert about one that HAS gone is retired instead of standing for
 * ever behind "the device reported nothing".
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  rules: [] as Array<Record<string, unknown>>,
  checks: [] as string[],
  widgets: [] as string[],
  calls: [] as string[],
}));

vi.mock("../../src/db.js", () => ({
  prisma: {
    notificationRule: { findMany: vi.fn(async () => h.rules) },
    alertGroup: { findMany: vi.fn(async () => []) },
    pathCheck: {
      findMany: vi.fn(async ({ where }: { where: { id: { in: string[] } } }) => {
        h.calls.push("pathCheck");
        return where.id.in.filter((id) => h.checks.includes(id)).map((id) => ({ id }));
      }),
    },
    manufacturerCustomWidget: {
      findMany: vi.fn(async ({ where }: { where: { id: { in: string[] } } }) => {
        h.calls.push("widget");
        return where.id.in.filter((id) => h.widgets.includes(id)).map((id) => ({ id }));
      }),
    },
  },
}));

import { dimensionTargetReferrers } from "../../src/services/actionReferenceService.js";
import { deletedTargetGone, sdwanCollectionStopped, type SweepStateRow } from "../../src/services/notifications/readings.js";

const leaf = (df: Record<string, unknown>, metric = "pathOk") => ({ type: "asset_metric", metric, operator: "==", threshold: 0, dimensionFilter: df });
const rule = (name: string, trigger: unknown, reset: unknown = null) => ({ name, trigger, reset });

beforeEach(() => {
  h.rules = [];
  h.checks = [];
  h.widgets = [];
  h.calls = [];
});

describe("rule 167(a): dimensionTargetReferrers", () => {
  it("finds a single-condition automation narrowed to the check", async () => {
    h.rules = [rule("Portal down", leaf({ checkId: "c1" })), rule("Other", leaf({ checkId: "c2" }))];
    expect(await dimensionTargetReferrers(["checkId"], ["c1"])).toEqual(['automation "Portal down"']);
  });

  it("finds it inside a nested composite tree", async () => {
    h.rules = [rule("Tree", { type: "composite", op: "and", children: [
      leaf({}, "cpuPct"),
      { op: "or", children: [leaf({ hostnamePattern: "x" }), leaf({ widgetId: "w1" }, "customWidgetValue")] },
    ] })];
    expect(await dimensionTargetReferrers(["widgetId", "stateProbeId"], ["w1"])).toEqual(['automation "Tree"']);
  });

  it("finds it under a reset condition", async () => {
    h.rules = [rule("Reset", leaf({}), { mode: "condition", condition: { op: "and", children: [leaf({ stateProbeId: "p1" }, "customStateValue")] } })];
    expect(await dimensionTargetReferrers(["widgetId", "stateProbeId"], ["p1"])).toEqual(['automation "Reset"']);
  });

  it("does not confuse one id field for another, or a blank filter for a match", async () => {
    h.rules = [rule("A", leaf({ widgetId: "x1" }, "customWidgetValue")), rule("B", leaf({})), rule("C", leaf({ checkId: "" }))];
    expect(await dimensionTargetReferrers(["checkId"], ["x1"])).toEqual([]);
    expect(await dimensionTargetReferrers(["checkId"], [""])).toEqual([]);
  });

  it("survives a stored trigger that is not an object, and asks nothing for no ids", async () => {
    h.rules = [rule("Bad", "nonsense"), rule("Null", null)];
    expect(await dimensionTargetReferrers(["checkId"], ["c1"])).toEqual([]);
    expect(await dimensionTargetReferrers(["checkId"], [])).toEqual([]);
  });

  it("names every automation over several ids at once (a profile's widgets)", async () => {
    h.rules = [rule("One", leaf({ widgetId: "w1" }, "customWidgetValue")), rule("Two", leaf({ stateProbeId: "w2" }, "customStateValue"))];
    expect(await dimensionTargetReferrers(["widgetId", "stateProbeId"], ["w1", "w2", "w3"])).toEqual(['automation "One"', 'automation "Two"']);
  });
});

const st = (id: string, dimensionKey: string, assetId: string | null = "a1"): SweepStateRow =>
  ({ id, assetId, dimensionKey, state: "firing", notificationId: `n-${id}` });
const dbRule = (trigger: unknown) => ({ id: "r1", name: "R", trigger }) as never;

describe("rule 167(a): deletedTargetGone", () => {
  it("retires a row whose path check no longer exists and keeps one whose check does", async () => {
    h.checks = ["c-live"];
    const gone = await deletedTargetGone(dbRule(leaf({})), [st("s1", "c-live"), st("s2", "c-dead"), st("s3", "c-dead", "")]);
    expect([...gone].sort()).toEqual(["s2", "s3"]);
    expect(h.calls).toEqual(["pathCheck"]);
  });

  it("reads a state probe's id off the front of its `<probe>|<row>` key", async () => {
    h.widgets = ["p-live"];
    const gone = await deletedTargetGone(dbRule(leaf({}, "customStateValue")), [st("s1", "p-live|1.3"), st("s2", "p-dead|1.3"), st("s3", "p-dead|2")]);
    expect([...gone].sort()).toEqual(["s2", "s3"]);
    expect(h.calls).toEqual(["widget"]);
  });

  it("handles a numeric custom widget", async () => {
    h.widgets = [];
    const gone = await deletedTargetGone(dbRule(leaf({}, "customWidgetValue")), [st("s1", "w-dead")]);
    expect([...gone]).toEqual(["s1"]);
  });

  it("asks nothing, and retires nothing, for any other metric — an interface name is not an id", async () => {
    const gone = await deletedTargetGone(dbRule(leaf({}, "ifOperStatus")), [st("s1", "port1")]);
    expect(gone.size).toBe(0);
    const composite = await deletedTargetGone(dbRule({ type: "composite", op: "and", children: [leaf({})] }), [st("s2", "c-dead")]);
    expect(composite.size).toBe(0);
    expect(h.calls).toEqual([]);
  });

  it("ignores rows with no dimension and an empty list", async () => {
    expect((await deletedTargetGone(dbRule(leaf({})), [st("s1", "")])).size).toBe(0);
    expect((await deletedTargetGone(dbRule(leaf({})), [])).size).toBe(0);
    expect(h.calls).toEqual([]);
  });
});

describe("rule 174: sdwanCollectionStopped", () => {
  const state = (field: string) => ({ type: "asset_state", field, operator: "==", value: "down" });
  const polled = (table: Record<string, number | null>) => async (id: string) => {
    h.calls.push(`resolve:${id}`);
    return table[id] ?? null;
  };

  it("retires every parked row of a gate nothing polls, and keeps a gate that is still polled", async () => {
    const rows = [st("s1", "to-internet", "gate-off"), st("s2", "to-dc", "gate-off"), st("s3", "to-internet", "gate-on")];
    const gone = await sdwanCollectionStopped(dbRule(state("sdwanRuleStatus")), rows, polled({ "gate-off": null, "gate-on": 60 }));
    expect([...gone].sort()).toEqual(["s1", "s2"]);
    // One resolve per gate, not per row.
    expect(h.calls.sort()).toEqual(["resolve:gate-off", "resolve:gate-on"]);
  });

  it("covers the SLA metrics too", async () => {
    const gone = await sdwanCollectionStopped(dbRule(leaf({}, "sdwanPacketLoss")), [st("s1", "hc|wan1", "gate-off")], polled({ "gate-off": null }));
    expect([...gone]).toEqual(["s1"]);
  });

  it("asks nothing for a condition that is not SD-WAN", async () => {
    const gone = await sdwanCollectionStopped(dbRule(state("ifOperStatus")), [st("s1", "port1", "gate-off")], polled({ "gate-off": null }));
    expect(gone.size).toBe(0);
    expect(h.calls).toEqual([]);
  });

  it("a resolve that throws proves nothing: the row stays parked", async () => {
    const gone = await sdwanCollectionStopped(dbRule(state("sdwanSelectedMember")), [st("s1", "r", "gate-x")], async () => { throw new Error("db down"); });
    expect(gone.size).toBe(0);
  });
});
