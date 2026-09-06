/**
 * tests/unit/recurrenceEditor.test.ts — the shared day/hours editor
 * (`window.PolarisRecurrence`, public/js/recurrence-editor.js) that the
 * Maintenance modal and the automations wizard's quiet time both build on.
 *
 * Three things are worth pinning, because each is silent when it breaks:
 *
 *  • the COLLAPSE. Seven rows become either the compact form (`hours`, and
 *    `freq: "daily"` when every day is ticked) or per-day `hoursByDay` — never
 *    a mix, so a shape this editor wrote never depends on the engine's
 *    fallback order to be read back the way it looked on screen.
 *  • `{empty}` vs `{error}`. "No days" means "nothing to save" to the
 *    Maintenance modal and "no weekly window, the API supplied the others" to
 *    the wizard; collapsing the two would either block a legitimate save or
 *    swallow a real typo.
 *  • the overlap refusal, in the same words the server uses — each range is
 *    its own occurrence, and two over one instant make "which occurrence is
 *    this" unanswerable (business rules 16 and 44).
 *
 * The round trip matters as much as the collapse: what `dayEditorHtml` renders
 * from a stored shape must collect back to that same shape, or editing a
 * schedule without touching it would rewrite it.
 */

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Window } from "happy-dom";

type Range = { startTime: string; endTime: string };
type Shape = Record<string, unknown>;
type Collected = { freq?: string; daysOfWeek?: number[]; hours?: Range[]; hoursByDay?: { dow: number; hours: Range[] }[]; error?: string; empty?: boolean };

interface Rec {
  summary: (shape: unknown) => string;
  dayRanges: (shape: unknown, dow: number) => Range[] | null;
  dayEditorHtml: (opts?: Record<string, unknown>) => string;
  collectDayEditor: (host: unknown) => Collected;
  hoursListHtml: (ranges: Range[]) => string;
  collectHoursList: (host: unknown, label: string) => { ranges?: Range[]; error?: string };
  wire: (host: unknown, onChange?: () => void) => void;
}

const g = globalThis as Record<string, unknown>;
let rec: Rec;
let doc: Window["document"];

beforeAll(() => {
  const win = new Window();
  g.window = win;
  g.document = win.document;
  g.escapeHtml = (s: unknown) => String(s ?? "");
  (0, eval)(readFileSync(resolve(__dirname, "../../public/js/recurrence-editor.js"), "utf8"));
  rec = (win as unknown as { PolarisRecurrence: Rec }).PolarisRecurrence;
  doc = win.document;
});

/** Render the editor into a detached host and hand it back. */
function mount(opts?: Record<string, unknown>): Element {
  const host = doc.createElement("div");
  host.innerHTML = rec.dayEditorHtml(opts || {});
  doc.body.appendChild(host);
  return host as unknown as Element;
}

/** Tick or untick one day row. */
function setDay(host: Element, dow: number, on: boolean): void {
  const row = host.querySelector(`.rc-day[data-dow="${dow}"]`)!;
  (row.querySelector(".rc-on") as unknown as { checked: boolean }).checked = on;
}

/** Replace one day's hours ([] = all day). */
function setHours(host: Element, dow: number, ranges: Range[]): void {
  const row = host.querySelector(`.rc-day[data-dow="${dow}"]`)!;
  const hours = row.querySelector(".rc-hours")!;
  (hours.querySelector(".rc-allday") as unknown as { checked: boolean }).checked = ranges.length === 0;
  hours.querySelector(".rc-ranges")!.innerHTML = ranges
    .map((r) => `<div class="rc-range"><input type="time" class="rc-start" value="${r.startTime}">` +
      `<input type="time" class="rc-end" value="${r.endTime}"></div>`)
    .join("");
}

beforeEach(() => {
  doc.body.innerHTML = "";
});

describe("the day editor collapses to the compact shape when it can", () => {
  it("all seven days, one shared range → freq daily + hours", () => {
    const host = mount();
    const got = rec.collectDayEditor(host);
    expect(got).toEqual({ freq: "daily", hours: [{ startTime: "22:00", endTime: "06:00" }] });
    // Deliberately NOT daysOfWeek: "daily" already says every day, and the
    // schema treats the field as weekly-only.
    expect(got.daysOfWeek).toBeUndefined();
  });

  it("a subset sharing one range → freq weekly + daysOfWeek + hours", () => {
    const host = mount();
    [0, 2, 3, 4, 5, 6].forEach((d) => setDay(host, d, false));
    const got = rec.collectDayEditor(host);
    expect(got).toEqual({ freq: "weekly", daysOfWeek: [1], hours: [{ startTime: "22:00", endTime: "06:00" }] });
  });

  it("all seven, all day → freq daily and NO hours at all", () => {
    const host = mount();
    for (let d = 0; d < 7; d++) setHours(host, d, []);
    expect(rec.collectDayEditor(host)).toEqual({ freq: "daily" });
  });

  it("days that differ → hoursByDay for EVERY chosen day, never a mix", () => {
    const host = mount();
    [0, 3, 4, 5].forEach((d) => setDay(host, d, false));
    setHours(host, 1, [{ startTime: "22:00", endTime: "06:00" }, { startTime: "12:00", endTime: "13:00" }]);
    setHours(host, 2, [{ startTime: "22:00", endTime: "06:00" }]);
    setHours(host, 6, []);
    const got = rec.collectDayEditor(host);
    expect(got.freq).toBe("weekly");
    expect(got.daysOfWeek).toEqual([1, 2, 6]);
    expect(got.hours).toBeUndefined();
    expect(got.hoursByDay).toEqual([
      { dow: 1, hours: [{ startTime: "22:00", endTime: "06:00" }, { startTime: "12:00", endTime: "13:00" }] },
      { dow: 2, hours: [{ startTime: "22:00", endTime: "06:00" }] },
      { dow: 6, hours: [] },
    ]);
  });
});

describe("what the editor refuses, and what it merely reports as empty", () => {
  it("reports NO DAYS as empty rather than as an error", () => {
    const host = mount();
    for (let d = 0; d < 7; d++) setDay(host, d, false);
    const got = rec.collectDayEditor(host);
    expect(got.empty).toBe(true);
    expect(got.error).toBeUndefined();
  });

  it("refuses two ranges that overlap on one day, naming both", () => {
    const host = mount();
    setHours(host, 1, [{ startTime: "22:00", endTime: "06:00" }, { startTime: "23:00", endTime: "01:00" }]);
    const got = rec.collectDayEditor(host);
    expect(got.error).toContain("Mon");
    expect(got.error).toContain("22:00–06:00");
    expect(got.error).toContain("23:00–01:00");
  });

  it("allows ranges that merely abut", () => {
    const host = mount();
    setHours(host, 1, [{ startTime: "09:00", endTime: "11:00" }, { startTime: "11:00", endTime: "12:00" }]);
    expect(rec.collectDayEditor(host).error).toBeUndefined();
  });

  it("refuses a row with a half-filled time pair", () => {
    const host = mount();
    setHours(host, 1, [{ startTime: "09:00", endTime: "" }]);
    expect(rec.collectDayEditor(host).error).toContain("Mon");
  });

  it("renders every day OFF when the host says so", () => {
    // A quiet time whose only window is an API-authored monthly freeze: seven
    // ticked days would add a window nobody asked for on the next save.
    const host = mount({ allOff: true });
    expect(rec.collectDayEditor(host).empty).toBe(true);
  });
});

describe("round trip", () => {
  const cases: { name: string; shape: Shape }[] = [
    {
      name: "the legacy single startTime/endTime pair",
      shape: { version: 1, kind: "recurring", freq: "daily", startTime: "20:00", endTime: "02:00" },
    },
    {
      name: "a weekly subset with two ranges",
      shape: {
        version: 1, kind: "recurring", freq: "weekly", daysOfWeek: [1, 3],
        hours: [{ startTime: "09:00", endTime: "11:00" }, { startTime: "14:00", endTime: "16:00" }],
      },
    },
    {
      name: "per-day hours with an all-day day",
      shape: {
        version: 1, kind: "recurring", freq: "weekly", daysOfWeek: [1, 6],
        hours: [{ startTime: "22:00", endTime: "06:00" }],
        hoursByDay: [{ dow: 6, hours: [] }],
      },
    },
  ];

  for (const c of cases) {
    it(`re-collects ${c.name} to the same days and hours`, () => {
      const host = mount({ shape: c.shape });
      const got = rec.collectDayEditor(host);
      // Compare through the resolver rather than field by field: the legacy
      // pair legitimately comes back as `hours`, which is the same schedule.
      const before = [0, 1, 2, 3, 4, 5, 6].map((d) => rec.dayRanges(c.shape, d));
      const after = [0, 1, 2, 3, 4, 5, 6].map((d) =>
        rec.dayRanges({ version: 1, kind: "recurring", ...got }, d));
      const days = c.shape.freq === "daily" ? [0, 1, 2, 3, 4, 5, 6] : (c.shape.daysOfWeek as number[]);
      for (const d of days) expect(after[d]).toEqual(before[d]);
    });
  }
});

describe("summary", () => {
  it("groups adjacent days keeping the same hours, in calendar order", () => {
    expect(rec.summary({
      version: 1, kind: "recurring", freq: "weekly", daysOfWeek: [1, 2, 3, 6],
      hours: [{ startTime: "22:00", endTime: "06:00" }],
      hoursByDay: [{ dow: 6, hours: [] }],
    })).toBe("Mon, Tue, Wed 22:00–06:00; Sat all day");
  });

  it("says Daily for all seven, and lists several ranges", () => {
    expect(rec.summary({
      version: 1, kind: "recurring", freq: "daily",
      hours: [{ startTime: "22:00", endTime: "06:00" }, { startTime: "12:00", endTime: "13:00" }],
    })).toBe("Daily 22:00–06:00, 12:00–13:00");
  });

  it("still reads a one-shot and the legacy pair", () => {
    expect(rec.summary({ version: 1, kind: "oneshot", startAt: "2026-07-12T22:00", endAt: "2026-07-13T02:00" }))
      .toBe("One-time Jul 12 2026 22:00 → Jul 13 2026 02:00");
    expect(rec.summary({ version: 1, kind: "recurring", freq: "weekly", daysOfWeek: [0, 6], startTime: "01:00", endTime: "03:00" }))
      .toBe("Sun, Sat 01:00–03:00");
  });

  it("keeps the active-date suffix", () => {
    expect(rec.summary({
      version: 1, kind: "recurring", freq: "daily", activeFrom: "2026-07-01", activeUntil: "2026-12-31",
    })).toBe("Daily all day · Jul 1 2026 – Dec 31 2026");
  });
});

describe("wiring", () => {
  it("adds and removes hour ranges through delegated handlers", () => {
    const host = mount();
    rec.wire(host);
    const row = host.querySelector('.rc-day[data-dow="1"]')!;
    (row.querySelector(".rc-add") as unknown as { click: () => void }).click();
    expect(row.querySelectorAll(".rc-range")).toHaveLength(2);
    (row.querySelectorAll(".rc-remove")[1] as unknown as { click: () => void }).click();
    expect(row.querySelectorAll(".rc-range")).toHaveLength(1);
    // Removing the LAST range means all day rather than an empty list with an
    // Add button under it.
    (row.querySelector(".rc-remove") as unknown as { click: () => void }).click();
    expect((row.querySelector(".rc-allday") as unknown as { checked: boolean }).checked).toBe(true);
    expect(rec.collectDayEditor(host).hoursByDay).toEqual([
      { dow: 0, hours: [{ startTime: "22:00", endTime: "06:00" }] },
      { dow: 1, hours: [] },
      { dow: 2, hours: [{ startTime: "22:00", endTime: "06:00" }] },
      { dow: 3, hours: [{ startTime: "22:00", endTime: "06:00" }] },
      { dow: 4, hours: [{ startTime: "22:00", endTime: "06:00" }] },
      { dow: 5, hours: [{ startTime: "22:00", endTime: "06:00" }] },
      { dow: 6, hours: [{ startTime: "22:00", endTime: "06:00" }] },
    ]);
  });

  it("paints its own summary line, and the reason when there isn't one", () => {
    const host = mount();
    rec.wire(host);
    expect(host.querySelector(".rc-summary")!.textContent).toBe("Daily 22:00–06:00");
    for (let d = 0; d < 7; d++) setDay(host, d, false);
    (host.querySelector('.rc-day[data-dow="0"] .rc-on') as unknown as { dispatchEvent: (e: unknown) => void })
      .dispatchEvent(new (g.window as InstanceType<typeof Window>).Event("change", { bubbles: true }));
    expect(host.querySelector(".rc-summary")!.textContent).toBe("No days picked.");
  });
});
