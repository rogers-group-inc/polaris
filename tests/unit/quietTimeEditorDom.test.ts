/**
 * tests/unit/quietTimeEditorDom.test.ts — the shared quiet-time policy editor
 * (`window.PolarisQuietTimeEditor`, public/js/quiet-time-editor.js) and the
 * whole-schedule composite it builds on (`PolarisRecurrence.scheduleEditorHtml`
 * / `collectScheduleEditor`), business rule 92.
 *
 * Both are rendered by two surfaces — the automation wizard's Quiet time step
 * and the global quiet-time wizard's Schedule step — so what is pinned here is
 * the CONTRACT between what the editor shows and what it saves: a stored
 * policy renders and collects back unchanged, the defaults are the ones the
 * server treats as "nothing special" (null severities = all, no summary time
 * = at the window end), the follow-ups mode drops the summary fields, and the
 * summary-time clash is refused in the browser with the same meaning the
 * server's `summaryTimeConflicts` gives it.
 *
 * Every shared module is reached as `window.X`, which is how the pages read
 * them and the one way the happy-dom harness resolves them.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Window } from "happy-dom";
import { quietTimeConfigSchema } from "../../src/utils/quietTime.js";
import { scheduleShapeSchema } from "../../src/utils/maintenanceRecurrence.js";
import { fixSelects } from "../fixtures/happyDomSelects.js";

type AnyFn = (...a: any[]) => any;
interface Rec { scheduleEditorHtml: AnyFn; wireScheduleEditor: AnyFn; collectScheduleEditor: AnyFn; summary: AnyFn }
interface QTE { html: AnyFn; wire: AnyFn; collect: AnyFn; summary: AnyFn }

const g = globalThis as Record<string, unknown>;
let doc: Window["document"];
let rec: Rec;
let qte: QTE;

beforeAll(() => {
  const win = new Window();
  g.window = win;
  g.document = win.document;
  doc = win.document;
  g.escapeHtml = (s: unknown) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  (0, eval)(readFileSync(resolve(__dirname, "../../public/js/recurrence-editor.js"), "utf8"));
  (0, eval)(readFileSync(resolve(__dirname, "../../public/js/quiet-time-editor.js"), "utf8"));
  rec = (win as unknown as { PolarisRecurrence: Rec }).PolarisRecurrence;
  qte = (win as unknown as { PolarisQuietTimeEditor: QTE }).PolarisQuietTimeEditor;
});

function mountSchedule(shape?: unknown): Element {
  const host = doc.createElement("div");
  host.innerHTML = rec.scheduleEditorHtml("t", { shape });
  doc.body.appendChild(host);
  fixSelects(host); // happy-dom's `<option selected>` bug; the markup is correct
  rec.wireScheduleEditor(host.querySelector(".rc-schedule"));
  return host.querySelector(".rc-schedule")!;
}

const META = {
  severities: ["notice", "informational", "warning", "serious", "critical"],
  channels: [{ id: "c1", name: "NOC mail", type: "smtp", enabled: true }, { id: "c2", name: "Push", type: "web_push", enabled: true }],
  serverClock: { timeZone: "America/Chicago", offsetMinutes: -300 },
};

function mountEditor(cfg: unknown, meta: Record<string, unknown> = META): Element {
  const host = doc.createElement("div");
  host.innerHTML = qte.html("q", cfg, meta);
  doc.body.appendChild(host);
  fixSelects(host);
  const root = host.querySelector(".qte")!;
  qte.wire(root, cfg, null);
  return root;
}

function set(el: Element, sel: string, value: string | boolean): void {
  const input = el.querySelector(sel) as unknown as { value: string; checked: boolean; type: string; name: string; dispatchEvent: (e: unknown) => void };
  if (typeof value === "boolean") {
    // happy-dom does not uncheck a radio's siblings when one is checked the
    // way a browser does, so a radio pick clears the group by hand first.
    if (input.type === "radio" && value) {
      el.querySelectorAll('input[type="radio"][name="' + input.name + '"]').forEach((r) => { (r as unknown as { checked: boolean }).checked = false; });
    }
    input.checked = value;
  } else {
    input.value = value;
  }
  input.dispatchEvent(new (g.window as Window).Event("change", { bubbles: true }));
}

describe("PolarisRecurrence.scheduleEditorHtml / collectScheduleEditor", () => {
  it("defaults to every day 22:00–06:00 and collects a daily shape the server accepts", () => {
    const got = rec.collectScheduleEditor(mountSchedule());
    expect(got.shape).toEqual({ version: 1, kind: "recurring", freq: "daily", hours: [{ startTime: "22:00", endTime: "06:00" }] });
    expect(() => scheduleShapeSchema.parse(got.shape)).not.toThrow();
  });

  it("round-trips a weekly shape with a date range", () => {
    const shape = { version: 1, kind: "recurring", freq: "weekly", daysOfWeek: [1, 2, 3], hours: [{ startTime: "20:00", endTime: "02:00" }], activeFrom: "2026-10-01", activeUntil: "2026-12-31" };
    expect(rec.collectScheduleEditor(mountSchedule(shape)).shape).toEqual(shape);
  });

  it("round-trips a monthly shape and a yearly one, showing their own blocks", () => {
    const monthly = { version: 1, kind: "recurring", freq: "monthly", dayOfMonth: 15, hours: [{ startTime: "01:00", endTime: "03:00" }] };
    const m = mountSchedule(monthly);
    expect((m.querySelector(".rc-monthly-block") as HTMLElement).style.display).toBe("");
    expect((m.querySelector(".rc-weekly-block") as HTMLElement).style.display).toBe("none");
    expect(rec.collectScheduleEditor(m).shape).toEqual(monthly);
    const yearly = { version: 1, kind: "recurring", freq: "yearly", month: 7, day: 4 };
    expect(rec.collectScheduleEditor(mountSchedule(yearly)).shape).toEqual(yearly);
  });

  it("switching the frequency swaps the blocks and the collected shape", () => {
    const s = mountSchedule();
    set(s, ".rc-freq", "monthly");
    expect((s.querySelector(".rc-period-block") as HTMLElement).style.display).toBe("");
    const got = rec.collectScheduleEditor(s);
    expect(got.shape.freq).toBe("monthly");
    expect(got.shape.dayOfMonth).toBe(1);
  });

  it("refuses a date range that ends before it starts", () => {
    const s = mountSchedule();
    (s.querySelector(".rc-active-from") as HTMLInputElement).value = "2026-12-01";
    (s.querySelector(".rc-active-until") as HTMLInputElement).value = "2026-11-01";
    expect(rec.collectScheduleEditor(s).error).toMatch(/ends before it starts/);
  });
});

describe("PolarisQuietTimeEditor", () => {
  it("a fresh editor collects the server's own defaults", () => {
    const got = qte.collect(mountEditor(null));
    expect(got.error).toBeUndefined();
    // Every severity ticked with every kind is the server's "everything":
    // no `held` map, null severities.
    expect(got.config).toEqual({
      windows: [{ version: 1, kind: "recurring", freq: "daily", hours: [{ startTime: "22:00", endTime: "06:00" }] }],
      severities: null,
      summaryAt: null,
      recurrenceThreshold: null,
      summaryChannelId: null,
    });
    expect(() => quietTimeConfigSchema.parse(got.config)).not.toThrow();
  });

  const ALL = { alerts: true, alertReminders: true, escalations: true, escalationReminders: true };

  it("renders the per-severity tree: ticking a severity ticks all four kinds, unticking its last kind unticks it", () => {
    const root = mountEditor({ windows: [{ version: 1, kind: "recurring", freq: "daily" }], severities: ["warning"] });
    const rows = Array.from(root.querySelectorAll(".qte-sevrow")) as HTMLElement[];
    expect(rows.map((r) => r.getAttribute("data-sev"))).toEqual(["notice", "informational", "warning", "serious", "critical"]);
    const warning = root.querySelector('.qte-sevrow[data-sev="warning"]')!;
    const critical = root.querySelector('.qte-sevrow[data-sev="critical"]')!;
    expect((warning.querySelector(".qte-sev") as HTMLInputElement).checked).toBe(true);
    expect((warning.querySelector(".qte-sev-kinds") as HTMLElement).hidden).toBe(false);
    expect(Array.from(warning.querySelectorAll(".qte-kind")).every((k) => (k as HTMLInputElement).checked)).toBe(true);
    expect((critical.querySelector(".qte-sev") as HTMLInputElement).checked).toBe(false);
    expect((critical.querySelector(".qte-sev-kinds") as HTMLElement).hidden).toBe(true);
    // Each parent has its own Reminders beneath it.
    expect(Array.from(warning.querySelectorAll(".qte-kind")).map((k) => k.getAttribute("data-kind")))
      .toEqual(["alerts", "escalations", "alertReminders", "escalationReminders"]);

    // Tick critical → all four on, kinds shown.
    set(critical, ".qte-sev", true);
    expect((critical.querySelector(".qte-sev-kinds") as HTMLElement).hidden).toBe(false);
    expect(Array.from(critical.querySelectorAll(".qte-kind")).every((k) => (k as HTMLInputElement).checked)).toBe(true);
    // Untick every kind on warning → the severity unticks itself.
    warning.querySelectorAll(".qte-kind").forEach((k) => { (k as HTMLInputElement).checked = false; });
    set(warning, '.qte-kind[data-kind="escalationReminders"]', false);
    expect((warning.querySelector(".qte-sev") as HTMLInputElement).checked).toBe(false);
    expect(qte.collect(root).config.held).toEqual({ critical: ALL });
    expect(qte.collect(root).config.severities).toEqual(["critical"]);
  });

  it("unticking Alerts everywhere leaves nothing to summarise: the summary section hides and saves no summary fields", () => {
    const root = mountEditor(null);
    root.querySelectorAll(".qte-sevrow").forEach((row) => set(row, '.qte-kind[data-kind="alerts"]', false));
    expect((root.querySelector(".qte-summary") as HTMLElement).hidden).toBe(true);
    const got = qte.collect(root);
    expect(got.config.held.warning).toEqual({ alerts: false, alertReminders: true, escalations: true, escalationReminders: true });
    expect(Object.keys(got.config.held)).toHaveLength(5);
    expect(got.config.summaryAt).toBeNull();
    expect(got.config.recurrenceThreshold).toBeNull();
    expect(() => quietTimeConfigSchema.parse(got.config)).not.toThrow();
    // Ticking Alerts back on one severity brings the summary section back.
    set(root.querySelector('.qte-sevrow[data-sev="serious"]')!, '.qte-kind[data-kind="alerts"]', true);
    expect((root.querySelector(".qte-summary") as HTMLElement).hidden).toBe(false);
  });

  it("reads a legacy follow-ups policy as every kind but Alerts, and re-saves it as the tree", () => {
    const root = mountEditor({ windows: [{ version: 1, kind: "recurring", freq: "daily" }], holds: "followUps", severities: ["warning", "serious"] });
    const warning = root.querySelector('.qte-sevrow[data-sev="warning"]')!;
    expect((warning.querySelector('.qte-kind[data-kind="alerts"]') as HTMLInputElement).checked).toBe(false);
    expect((warning.querySelector('.qte-kind[data-kind="alertReminders"]') as HTMLInputElement).checked).toBe(true);
    expect((root.querySelector(".qte-summary") as HTMLElement).hidden).toBe(true);
    const got = qte.collect(root);
    expect(got.config.holds).toBeUndefined();
    expect(got.config.held).toEqual({
      warning: { alerts: false, alertReminders: true, escalations: true, escalationReminders: true },
      serious: { alerts: false, alertReminders: true, escalations: true, escalationReminders: true },
    });
  });

  it("round-trips a stored policy, extras included", () => {
    const stored = {
      windows: [
        { version: 1, kind: "recurring", freq: "weekly", daysOfWeek: [5, 6], hours: [{ startTime: "18:00", endTime: "06:00" }] },
        { version: 1, kind: "oneshot", startAt: "2026-12-24T12:00", endAt: "2026-12-27T06:00" },
      ],
      holds: "all",
      severities: ["warning", "serious"],
      summaryAt: "07:30",
      summaryChannelId: "c1",
      recurrenceThreshold: 3,
    };
    const root = mountEditor(stored);
    // The one-shot is listed read-only, not editable.
    expect(root.querySelectorAll(".qte-extra")).toHaveLength(1);
    expect(root.querySelector(".qte-extra")!.textContent).toContain("One-time");
    const got = qte.collect(root);
    // The legacy `holds: "all"` + severities pair re-saves as the per-severity
    // tree saying the same thing; everything else is byte-identical.
    const { holds: _legacy, ...rest } = stored;
    expect(got.config).toEqual({ ...rest, held: { warning: ALL, serious: ALL } });
  });

  it("every severity ticked saves null; a subset saves the subset; none is refused", () => {
    const root = mountEditor(null);
    set(root, '.qte-sev[value="critical"]', false);
    expect(qte.collect(root).config.severities).toEqual(["notice", "informational", "warning", "serious"]);
    root.querySelectorAll(".qte-sev").forEach((b) => { (b as HTMLInputElement).checked = false; });
    expect(qte.collect(root).error).toMatch(/at least one severity/);
  });

  it("a host that asked the severity question itself hands the answer in", () => {
    const root = mountEditor(null, { ...META, showSeverities: false });
    expect(root.querySelector(".qte-sev")).toBeNull();
    expect(qte.collect(root, { severities: ["serious"] }).config.severities).toEqual(["serious"]);
  });

  it("a summary time inside the quiet period on every day it occurs is refused; one free on some day is kept", () => {
    // The default editor window is every night 22:00–06:00: 05:00 is quiet
    // every day, 07:30 is free every day.
    const root = mountEditor(null);
    set(root, '.qte-sendat[value="time"]', true);
    (root.querySelector(".qte-summary-time") as HTMLInputElement).value = "05:00";
    expect(qte.collect(root).error).toMatch(/inside the quiet period on every day it occurs/);
    (root.querySelector(".qte-summary-time") as HTMLInputElement).value = "07:30";
    expect(qte.collect(root).config.summaryAt).toBe("07:30");
  });

  it("nights and weekends with a 07:30 summary is accepted — weekday mornings are free", () => {
    const root = mountEditor(null);
    (root.querySelector('.rc-preset[data-preset="nights"]') as unknown as { click: () => void }).click();
    set(root, '.qte-sendat[value="time"]', true);
    (root.querySelector(".qte-summary-time") as HTMLInputElement).value = "07:30";
    const got = qte.collect(root);
    expect(got.error).toBeUndefined();
    expect(got.config.summaryAt).toBe("07:30");
  });

  it("the channel picker offers only email channels", () => {
    const root = mountEditor(null);
    const opts = Array.from(root.querySelectorAll(".qte-channel option")).map((o) => (o as HTMLOptionElement).value);
    expect(opts).toEqual(["", "c1"]);
  });

  it("summarises a policy in one line both surfaces can print", () => {
    expect(qte.summary({ windows: [{ version: 1, kind: "recurring", freq: "daily", hours: [{ startTime: "22:00", endTime: "06:00" }] }], holds: "all", summaryAt: "07:30", severities: ["warning"], recurrenceThreshold: 2 }))
      .toBe("Daily 22:00–06:00 · holds everything for warning · summary at 07:30 · recurring > 2× reported");
    expect(qte.summary({ windows: [{ version: 1, kind: "recurring", freq: "daily" }], holds: "followUps" }))
      .toBe("Daily all day · holds reminders and escalations only for every severity");
    expect(qte.summary({ windows: [{ version: 1, kind: "recurring", freq: "daily" }], held: {
      warning: ALL, serious: ALL,
      critical: { alerts: false, alertReminders: true, escalations: false, escalationReminders: false },
    } })).toBe("Daily all day · holds warning, serious: everything · critical: alert reminders · summary when it ends");
  });
});
