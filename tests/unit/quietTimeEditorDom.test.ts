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
    expect(got.config).toEqual({
      windows: [{ version: 1, kind: "recurring", freq: "daily", hours: [{ startTime: "22:00", endTime: "06:00" }] }],
      holds: "all",
      severities: null,
      summaryAt: null,
      recurrenceThreshold: null,
      summaryChannelId: null,
    });
    expect(() => quietTimeConfigSchema.parse(got.config)).not.toThrow();
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
    expect(got.config).toEqual(stored);
  });

  it("the follow-ups mode hides the summary section and saves no summary fields", () => {
    const root = mountEditor(null);
    set(root, '.qte-holds[value="followUps"]', true);
    expect((root.querySelector(".qte-summary") as HTMLElement).hidden).toBe(true);
    const got = qte.collect(root);
    expect(got.config.holds).toBe("followUps");
    expect(got.config.summaryAt).toBeNull();
    expect(got.config.recurrenceThreshold).toBeNull();
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

  it("a summary time inside the quiet period is refused; one outside is kept", () => {
    const root = mountEditor(null);
    set(root, '.qte-sendat[value="time"]', true);
    (root.querySelector(".qte-summary-time") as HTMLInputElement).value = "05:00";
    expect(qte.collect(root).error).toMatch(/falls inside the quiet period/);
    (root.querySelector(".qte-summary-time") as HTMLInputElement).value = "07:30";
    expect(qte.collect(root).config.summaryAt).toBe("07:30");
  });

  it("the channel picker offers only email channels", () => {
    const root = mountEditor(null);
    const opts = Array.from(root.querySelectorAll(".qte-channel option")).map((o) => (o as HTMLOptionElement).value);
    expect(opts).toEqual(["", "c1"]);
  });

  it("summarises a policy in one line both surfaces can print", () => {
    expect(qte.summary({ windows: [{ version: 1, kind: "recurring", freq: "daily", hours: [{ startTime: "22:00", endTime: "06:00" }] }], holds: "all", summaryAt: "07:30", severities: ["warning"], recurrenceThreshold: 2 }))
      .toBe("Daily 22:00–06:00 · everything held, summary at 07:30 · warning · recurring > 2× reported");
    expect(qte.summary({ windows: [{ version: 1, kind: "recurring", freq: "daily" }], holds: "followUps" }))
      .toBe("Daily all day · only reminders and escalations held");
  });
});
