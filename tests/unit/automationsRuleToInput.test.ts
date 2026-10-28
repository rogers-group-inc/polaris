/**
 * tests/unit/automationsRuleToInput.test.ts — pins the list page's
 * `_ruleToInput` (public/js/automations.js), the full-record rebuild the
 * inline enable/disable toggle sends to PUT /notification-rules/:id.
 *
 * The route validates the complete ruleInputSchema and the server treats an
 * absent JSON field as "clear it", so any v2 rule field this function forgets
 * to resend is silently stripped from the stored rule the first time an
 * operator flips the toggle. That exact bug shipped for severityBands /
 * bandNotify — a banded automation lost its tiers on disable/enable. This
 * test round-trips a fully-loaded v2 rule through _ruleToInput and the real
 * ruleInputSchema so a forgotten field fails loudly.
 */

import { describe, it, expect, beforeAll, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Window } from "happy-dom";
import { ruleInputSchema } from "../../src/services/notificationTypes.js";

vi.mock("../../src/db.js", () => ({ prisma: {} }));

const g = globalThis as Record<string, unknown>;
let ruleToInput: (r: Record<string, unknown>, overrides?: Record<string, unknown>) => Record<string, unknown>;

beforeAll(() => {
  const win = new Window();
  win.document.body.innerHTML = '<button id="btn-refresh"></button>';
  g.window = win;
  g.document = win.document;
  g.escapeHtml = (s: unknown) => String(s ?? "");
  g.showToast = () => {};
  g.showConfirm = async () => false;
  // permAtLeast=false keeps bootPage from initializing the rules table, so the
  // script loads inert — only the module-scope functions matter here.
  g.permAtLeast = () => false;
  g.api = {};
  const src = readFileSync(resolve(__dirname, "../../public/js/automations.js"), "utf8");
  (0, eval)(src);
  ruleToInput = (win as unknown as { _ruleToInput: typeof ruleToInput })._ruleToInput;
});

/** A rule record as GET /notification-rules returns it, with every v2 field populated. */
function loadedRule(): Record<string, unknown> {
  return {
    id: "r1",
    name: "High CPU",
    description: "desc",
    enabled: true,
    severity: "warning",
    trigger: { type: "asset_metric", metric: "cpuPct", aggregation: "avg", windowSec: 300, operator: ">", threshold: 80 },
    scope: { allAssets: true },
    reset: { mode: "auto", clearThreshold: 60 },
    actions: [{ type: "notify", channelId: "c1", addresses: ["noc@example.com"] }],
    cooldownSec: 600,
    messageTemplate: "{asset} cpu {value}",
    channels: ["in_app"],
    emailComposition: null,
    escalation: { stopOn: "acknowledge", tiers: [{ afterMin: 15, actions: [{ type: "notify", channelId: "c1", addresses: ["mgr@example.com"] }] }] },
    severityBands: [{ threshold: 90, severity: "serious", actions: [] }, { threshold: 95, severity: "critical", actions: [] }],
    bandNotify: { onIncrease: true, onDecrease: false, onResolved: true, resolvedMode: "reuse" },
    repeat: { everyMin: 15, stopOn: "acknowledge" },
    createdBy: "op",
  };
}

describe("_ruleToInput", () => {
  it("is exposed on window for the harness", () => {
    expect(typeof ruleToInput).toBe("function");
  });

  it("resends every v2 rule field (severityBands/bandNotify included)", () => {
    const body = ruleToInput(loadedRule(), { enabled: false });
    expect(body.enabled).toBe(false);
    expect(body.severityBands).toEqual(loadedRule().severityBands);
    expect(body.bandNotify).toEqual(loadedRule().bandNotify);
    expect(body.reset).toEqual(loadedRule().reset);
    expect(body.actions).toEqual(loadedRule().actions);
    expect(body.escalation).toEqual(loadedRule().escalation);
    expect(body.messageTemplate).toBe("{asset} cpu {value}");
    expect(body.cooldownSec).toBe(600);
    expect(body.repeat).toEqual(loadedRule().repeat);
  });

  it("resends the repeat config, so the enable toggle can't delete it", () => {
    // The list row's toggle PUTs the WHOLE record and the server maps an
    // omitted nullable Json to Prisma.DbNull, so an unlisted field is silently
    // cleared. Flipping enabled must not cost the operator their reminders.
    const body = ruleToInput(loadedRule(), { enabled: false });
    expect(body.repeat).toEqual({ everyMin: 15, stopOn: "acknowledge" });
    expect(ruleInputSchema.parse(body).repeat).toEqual({ everyMin: 15, stopOn: "acknowledge" });
  });

  it("resends the two boolean columns, so the enable toggle can't switch them off", () => {
    // updateRule stores each as `input.x === true`: an omitted flag is FALSE.
    // Grouping (rule 75) used to be lost on every flip of the list toggle.
    const grouped = { ...loadedRule(), groupByAsset: true };
    expect(ruleToInput(grouped, { enabled: false }).groupByAsset).toBe(true);
    const prio = {
      ...loadedRule(),
      trigger: { type: "asset_state", field: "monitorStatus", operator: "==", value: "down" },
      reset: { mode: "auto" },
      severityBands: null,
      bandNotify: null,
      severityFromPriorityTag: true,
    };
    const body = ruleToInput(prio, { enabled: false });
    expect(body.severityFromPriorityTag).toBe(true);
    expect(ruleInputSchema.parse(body).severityFromPriorityTag).toBe(true);
  });

  it("sends null for an automation that does not repeat", () => {
    const r = loadedRule();
    r.repeat = null;
    expect(ruleToInput(r).repeat).toBeNull();
  });

  it("produces a body the real ruleInputSchema accepts, preserving the bands", () => {
    const parsed = ruleInputSchema.parse(ruleToInput(loadedRule(), { enabled: false }));
    expect(parsed.severityBands).toHaveLength(2);
    expect(parsed.severityBands?.[1]?.severity).toBe("critical");
    expect(parsed.bandNotify?.onIncrease).toBe(true);
  });

  it("sends null (not undefined) for absent bands so pre-band rules stay unchanged", () => {
    const r = loadedRule();
    r.severityBands = null;
    r.bandNotify = null;
    const body = ruleToInput(r);
    expect(body.severityBands).toBeNull();
    expect(body.bandNotify).toBeNull();
  });
});
