/**
 * tests/unit/assetsMaintenanceCalendar.test.ts — pins the two pure helpers in
 * public/js/assets-maintenance.js that the Maintenance modal's calendar tab and
 * both ad-hoc entry points depend on.
 *
 *  • _maintOccurrenceDays / _maintChipTime — which day cells a window paints on.
 *    Occurrences are half-open server-local strings, so a 22:00 → 02:00 window
 *    spans two cells while an all-day window (00:00 → next 00:00) must claim
 *    exactly one; getting that wrong shows a phantom window on the next day.
 *
 *  • maintValidateAdhocEnd — the guard for "enter maintenance until…". A
 *    datetime-local with an untouched time half reads as "", which used to be
 *    silently dropped after a successful asset save: the operator saw
 *    "Asset updated" and no maintenance window anywhere.
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Window } from "happy-dom";

vi.mock("../../src/db.js", () => ({ prisma: {} }));

type Occ = { start: string; end: string };

const g = globalThis as Record<string, unknown>;
let occurrenceDays: (occ: Occ) => string[];
let chipTime: (occ: Occ, dayKey: string) => string;
let validateEnd: (v: unknown, nowMs?: number) => { ok: boolean; value?: string; error?: string };
let serverNow: () => Date;
let loadServerClock: () => Promise<void>;
let serverClockLabel: () => string;
let localIso: (d: Date) => string;
/** What the stubbed /server-time read answers with; null = read fails. */
let serverNowIso: string | null = null;

beforeAll(() => {
  const win = new Window();
  g.window = win;
  g.document = win.document;
  g.escapeHtml = (s: unknown) => String(s ?? "");
  g.showToast = () => {};
  g.showConfirm = async () => false;
  g.openModal = () => {};
  g.closeModal = () => {};
  g.tabbedBodyHTML = () => "";
  g.wireModalTabs = () => {};
  g.collectTagCriteria = () => null;
  g.api = {};
  // The shared recurrence editor, loaded before this file on every page that
  // carries it — the schedule editor's days-and-hours rows come from it.
  (0, eval)(readFileSync(resolve(__dirname, "../../public/js/recurrence-editor.js"), "utf8"));
  const src = readFileSync(resolve(__dirname, "../../public/js/assets-maintenance.js"), "utf8");
  (0, eval)(src);
  const w = win as unknown as {
    _maintOccurrenceDays: typeof occurrenceDays;
    _maintChipTime: typeof chipTime;
    maintValidateAdhocEnd: typeof validateEnd;
    maintServerNow: typeof serverNow;
    maintLoadServerClock: typeof loadServerClock;
    maintServerClockLabel: typeof serverClockLabel;
    maintLocalIso: typeof localIso;
  };
  occurrenceDays = w._maintOccurrenceDays;
  chipTime = w._maintChipTime;
  validateEnd = w.maintValidateAdhocEnd;
  serverNow = w.maintServerNow;
  loadServerClock = w.maintLoadServerClock;
  serverClockLabel = w.maintServerClockLabel;
  localIso = w.maintLocalIso;
});

describe("calendar day bucketing", () => {
  it("keeps a same-day window on one cell", () => {
    expect(occurrenceDays({ start: "2026-08-12T20:00", end: "2026-08-12T22:00" }))
      .toEqual(["2026-08-12"]);
  });

  it("paints a midnight-spanning window on both days", () => {
    expect(occurrenceDays({ start: "2026-08-12T22:00", end: "2026-08-13T02:00" }))
      .toEqual(["2026-08-12", "2026-08-13"]);
  });

  it("does NOT claim the next day for an all-day window (half-open end)", () => {
    expect(occurrenceDays({ start: "2026-08-12T00:00", end: "2026-08-13T00:00" }))
      .toEqual(["2026-08-12"]);
  });

  it("covers every day of a multi-day one-shot, crossing a month boundary", () => {
    expect(occurrenceDays({ start: "2026-07-30T18:00", end: "2026-08-02T06:00" }))
      .toEqual(["2026-07-30", "2026-07-31", "2026-08-01", "2026-08-02"]);
  });
});

describe("calendar chip labels", () => {
  it("shows the time range on a same-day window", () => {
    expect(chipTime({ start: "2026-08-12T20:00", end: "2026-08-12T22:00" }, "2026-08-12"))
      .toBe("20:00–22:00");
  });

  it("marks a window that runs past midnight, and its continuation the next day", () => {
    const occ = { start: "2026-08-12T22:00", end: "2026-08-13T02:00" };
    expect(chipTime(occ, "2026-08-12")).toBe("22:00 →");
    expect(chipTime(occ, "2026-08-13")).toBe("→ 02:00");
  });

  it("labels an all-day window", () => {
    expect(chipTime({ start: "2026-08-12T00:00", end: "2026-08-13T00:00" }, "2026-08-12"))
      .toBe("All day");
  });
});

describe("maintValidateAdhocEnd", () => {
  const now = new Date(2026, 7, 12, 9, 0, 0).getTime();

  it("accepts a future local date-time and trims to the minute", () => {
    expect(validateEnd("2026-08-12T17:30", now)).toEqual({ ok: true, value: "2026-08-12T17:30" });
    expect(validateEnd("2026-08-12T17:30:00", now)).toEqual({ ok: true, value: "2026-08-12T17:30" });
  });

  it("rejects the date-without-time case a datetime-local reports as empty", () => {
    // This is the actual failure mode: the operator filled the date half, the
    // field's value stayed "", and the request was dropped without a word.
    for (const v of ["", "   ", null, undefined]) {
      const r = validateEnd(v, now);
      expect(r.ok).toBe(false);
      expect(r.error).toMatch(/date AND time/i);
    }
  });

  it("rejects a malformed value", () => {
    expect(validateEnd("tomorrow", now).ok).toBe(false);
    expect(validateEnd("2026-08-12", now).ok).toBe(false);
  });

  it("rejects an end time that is already past (the window would never open)", () => {
    expect(validateEnd("2026-08-12T08:59", now)).toEqual({
      ok: false, error: "The end time must be in the future.",
    });
    expect(validateEnd("2026-08-12T09:00", now).ok).toBe(false); // exactly now
    expect(validateEnd("2026-08-12T09:01", now).ok).toBe(true);
  });
});

// ─── Grid rendering + click-to-create ───────────────────────────────────────
//
// A DOM-level smoke test: the calendar reads a dozen element ids across two
// tab panels, and a typo in any of them is invisible until an operator opens
// the tab. This drives the real render/wire/click path against a stub API.

describe("calendar grid", () => {
  const g2 = globalThis as Record<string, any>;
  let occurrencesArgs: string[][] = [];

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 7, 12, 9, 0, 0)); // Wed 2026-08-12 09:00
    occurrencesArgs = [];
    g2.api = {
      maintenanceSchedules: {
        occurrences: (from: string, to: string) => {
          occurrencesArgs.push([from, to]);
          return Promise.resolve({
            truncated: false,
            occurrences: [
              { scheduleId: "s1", name: "Nightly patching", enabled: true, kind: "recurring",
                adhoc: false, start: "2026-08-12T22:00", end: "2026-08-13T02:00" },
              { scheduleId: "s2", name: "Ad-hoc — SW1", enabled: false, kind: "oneshot",
                adhoc: true, start: "2026-08-12T10:00", end: "2026-08-12T12:00" },
            ],
          });
        },
        list: () => Promise.resolve({ schedules: [] }),
        preview: () => Promise.resolve({ total: 0, assets: [] }),
      },
      assetTypes: { list: () => Promise.resolve([]) },
      integrations: { list: () => Promise.resolve({ integrations: [] }) },
      assets: { list: () => Promise.resolve({ assets: [] }) },
    };
    (g2.document as Document).body.innerHTML =
      '<div id="maint-tabs"><button class="page-tab" data-tab="create"></button>' +
      '<button class="page-tab" data-tab="calendar"></button></div>' +
      '<div id="maint-tab-create">' + g2._maintEditorHTML() + "</div>" +
      '<div id="maint-tab-calendar">' + g2._maintCalendarHTML() + "</div>";
    g2._maintWireCalendar();
  });

  it("asks for whole weeks around the visible month and paints chips on both days a window spans", async () => {
    await g2._maintRenderCalendar();
    // August 2026 starts on a Saturday, so the grid opens on Sun 2026-07-26.
    expect(occurrencesArgs[0]).toEqual(["2026-07-26", "2026-09-05"]);
    expect((g2.document as Document).getElementById("maint-cal-title")!.textContent).toBe("Aug 2026");

    const dayEl = (key: string) =>
      (g2.document as Document).querySelector(`.maint-cal-day[data-day="${key}"]`)!;
    expect(dayEl("2026-08-12").querySelectorAll(".maint-cal-chip")).toHaveLength(2);
    // The 22:00 → 02:00 window continues onto the 13th…
    expect(dayEl("2026-08-13").querySelectorAll(".maint-cal-chip")).toHaveLength(1);
    // …and the disabled ad-hoc one is styled as both.
    const adhoc = dayEl("2026-08-12").querySelector(".maint-cal-chip-adhoc")!;
    expect(adhoc.className).toContain("maint-cal-chip-off");
    expect(dayEl("2026-08-12").className).toContain("maint-cal-day-today");
    expect(dayEl("2026-07-26").className).toContain("maint-cal-day-out");
  });

  it("month nav moves the window and refetches", async () => {
    await g2._maintRenderCalendar();
    (g2.document as Document).getElementById("maint-cal-next")!.dispatchEvent(new g2.window.Event("click", { bubbles: true }));
    await vi.waitFor(() => expect(occurrencesArgs).toHaveLength(2));
    expect((g2.document as Document).getElementById("maint-cal-title")!.textContent).toBe("Sep 2026");
  });

  it("clicking a future day prefills a one-time evening window in the editor", async () => {
    await g2._maintRenderCalendar();
    const doc = g2.document as Document;
    doc.querySelector('.maint-cal-day[data-day="2026-08-20"]')!
      .dispatchEvent(new g2.window.Event("click", { bubbles: true }));
    expect((doc.getElementById("maint-kind-oneshot") as HTMLInputElement).checked).toBe(true);
    expect((doc.getElementById("maint-start") as HTMLInputElement).value).toBe("2026-08-20T20:00");
    expect((doc.getElementById("maint-end") as HTMLInputElement).value).toBe("2026-08-20T22:00");
  });

  it("clicking today prefills a window starting now, not at 20:00", async () => {
    await g2._maintRenderCalendar();
    const doc = g2.document as Document;
    doc.querySelector('.maint-cal-day[data-day="2026-08-12"] .maint-cal-daynum')!
      .dispatchEvent(new g2.window.Event("click", { bubbles: true }));
    expect((doc.getElementById("maint-start") as HTMLInputElement).value).toBe("2026-08-12T09:00");
    expect((doc.getElementById("maint-end") as HTMLInputElement).value).toBe("2026-08-12T11:00");
  });
});

/**
 * The reported bug: a bulk-selected batch of switches/APs was put into a
 * maintenance window and none of them ever entered it.
 *
 * Every maintenance time is SERVER-local wall clock with no offset. The editor
 * prefilled its one-shot pickers from the BROWSER's clock and posted those
 * digits for the server to read as its own, so on a UTC-clocked host with a
 * Central operator a "now → now + 2h" window mapped onto one that started five
 * hours ago and had ALREADY ENDED: the schedule saved cleanly, isInWindow was
 * false forever, and the assets kept showing Down. These pin the skew math the
 * fix routes every picker through.
 */
describe("server-clock skew", () => {
  // Own the shared globals for this suite: the calendar describe above replaces
  // globalThis.api wholesale and installs fake timers, and the skew loader needs
  // a real clock plus its own /server-time stub.
  beforeEach(() => {
    // Pinned to an exact minute boundary. The skew is rounded to the minute (the
    // pickers are minute-granular and the round trip adds sub-second noise), so
    // racing the real clock would make these assertions flap by a minute.
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 7, 19, 9, 0, 0, 0));
    g.api = {
      maintenanceSchedules: {
        // serverNowIso is the server's wall clock; null makes the read fail so
        // the browser-clock fallback is exercised.
        serverTime: async () => {
          if (serverNowIso === null) throw new Error("unreachable");
          return { now: serverNowIso, timeZone: "America/Chicago", offsetMinutes: -300 };
        },
      },
    };
  });

  it("falls back to the browser clock before the read lands", () => {
    // The skew cache is module-level and unread at this point.
    expect(Math.abs(serverNow().getTime() - Date.now())).toBeLessThan(2000);
    expect(serverClockLabel()).toBe("");
  });

  it("shifts server-now by the whole browser↔server difference", async () => {
    // Browser reads 09:00 Central; the server is UTC-clocked, so its wall clock
    // reads 14:00 — the exact shape of the reported bug.
    serverNowIso = "2026-08-19T14:00";
    await loadServerClock();
    // maintServerNow's browser-local digits must now equal the server's.
    expect(localIso(serverNow())).toBe("2026-08-19T14:00");
  });

  it("labels the zone and the current server time once known", () => {
    const label = serverClockLabel();
    expect(label).toContain("America/Chicago");
    expect(label).toContain("server time now");
  });

  it("caches: a second read cannot move an established skew", async () => {
    const before = localIso(serverNow());
    serverNowIso = "1999-01-01T00:00";
    await loadServerClock();
    expect(localIso(serverNow())).toBe(before);
  });

  it("judges an end time against the SERVER clock, not the browser's", () => {
    // Skew is +5h from the test above. "Now + 2h" in the BROWSER is 11:00, which
    // is 3h BEHIND the server's 14:00 — exactly the end time that used to be
    // accepted and then closed the window on the very next reconcile.
    expect(validateEnd("2026-08-19T11:00").ok).toBe(false);
    // Ahead of the SERVER's clock is accepted.
    expect(validateEnd("2026-08-19T15:00").ok).toBe(true);
  });

  it("still honours an explicitly passed nowMs", () => {
    const pinned = new Date(2030, 0, 1, 12, 0);
    expect(validateEnd("2030-01-01T13:00", pinned.getTime()).ok).toBe(true);
    expect(validateEnd("2030-01-01T11:00", pinned.getTime()).ok).toBe(false);
  });
});
