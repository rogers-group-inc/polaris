/**
 * tests/unit/opsCalendar.test.ts — the operations calendar
 * (public/js/ops-calendar.js, the Events page's Calendar tab): maintenance
 * windows, reboots and firmware upgrades, booked and past.
 *
 *  • Day bucketing and chip labels — items are half-open server-local strings,
 *    so a 22:00 → 02:00 window spans two days while an all-day window
 *    (00:00 → next 00:00) claims exactly one.
 *  • The Month / Week / Day / List grids, carried over from the Maintenance
 *    modal's calendar tab with their behaviour pinned unchanged.
 *  • Reboot and firmware items: a booking not yet run is a point at its time,
 *    a run spans its start → end, status colours the item, a click hands the
 *    item to the host, a kind the caller may not read is not offered.
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Window } from "happy-dom";

type Occ = { start: string; end: string; point?: boolean };

const g = globalThis as Record<string, any>;
let cal: {
  mount: (host: Element, opts: Record<string, unknown>) => Promise<void>;
  refresh: () => Promise<void>;
  _occurrenceDays: (o: Occ) => string[];
  _chipTime: (o: Occ, day: string) => string;
  _itemsOf: (res: Record<string, unknown>, hidden: Record<string, boolean>) => Array<Record<string, any>>;
  _statusClass: (s: string) => string;
};

beforeAll(() => {
  const win = new Window();
  g.window = win;
  g.document = win.document;
  g.localStorage = win.localStorage;
  g.escapeHtml = (s: unknown) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  (0, eval)(readFileSync(resolve(__dirname, "../../public/js/ops-calendar.js"), "utf8"));
  cal = (win as unknown as { PolarisOpsCalendar: typeof cal }).PolarisOpsCalendar;
});

describe("day bucketing", () => {
  it("keeps a same-day window on one cell", () => {
    expect(cal._occurrenceDays({ start: "2026-08-12T20:00", end: "2026-08-12T22:00" })).toEqual(["2026-08-12"]);
  });
  it("paints a midnight-spanning window on both days", () => {
    expect(cal._occurrenceDays({ start: "2026-08-12T22:00", end: "2026-08-13T02:00" })).toEqual(["2026-08-12", "2026-08-13"]);
  });
  it("does NOT claim the next day for an all-day window (half-open end)", () => {
    expect(cal._occurrenceDays({ start: "2026-08-12T00:00", end: "2026-08-13T00:00" })).toEqual(["2026-08-12"]);
  });
  it("covers every day of a multi-day one-shot, crossing a month boundary", () => {
    expect(cal._occurrenceDays({ start: "2026-07-30T18:00", end: "2026-08-02T06:00" }))
      .toEqual(["2026-07-30", "2026-07-31", "2026-08-01", "2026-08-02"]);
  });
});

describe("chip labels", () => {
  it("shows the time range on a same-day window", () => {
    expect(cal._chipTime({ start: "2026-08-12T20:00", end: "2026-08-12T22:00" }, "2026-08-12")).toBe("20:00–22:00");
  });
  it("marks a window that runs past midnight, and its continuation the next day", () => {
    const occ = { start: "2026-08-12T22:00", end: "2026-08-13T02:00" };
    expect(cal._chipTime(occ, "2026-08-12")).toBe("22:00 →");
    expect(cal._chipTime(occ, "2026-08-13")).toBe("→ 02:00");
  });
  it("labels an all-day window", () => {
    expect(cal._chipTime({ start: "2026-08-12T00:00", end: "2026-08-13T00:00" }, "2026-08-12")).toBe("All day");
  });
  it("labels a point in time (a booked reboot) by its time alone", () => {
    expect(cal._chipTime({ start: "2026-08-12T02:00", end: "2026-08-12T02:15", point: true }, "2026-08-12")).toBe("02:00");
  });
});

describe("items", () => {
  const res = {
    maintenance: [{ scheduleId: "s1", name: "Nightly patching", enabled: true, kind: "recurring", adhoc: false, start: "2026-08-12T22:00", end: "2026-08-13T02:00" }],
    reboot: [
      { id: "booking:b1", assetId: "a1", assetName: "FGT-01", start: "2026-08-14T02:00", end: "2026-08-14T02:15", booked: true, scheduleId: "b1", runId: null, status: "pending", by: "automation:Memory over 90%", toVersion: null, error: null },
      { id: "run:r1", assetId: "a2", assetName: "SRV-01", start: "2026-08-10T09:00", end: "2026-08-10T09:06", booked: false, scheduleId: null, runId: "r1", status: "failed", by: "dmoore", toVersion: null, error: "the device went down and did not come back" },
    ],
    firmware: [
      { id: "booking:f1", assetId: "a3", assetName: "SW-01", start: "2026-08-15T23:00", end: "2026-08-15T23:42", booked: true, scheduleId: "f1", runId: "fr1", status: "succeeded", by: "dmoore", toVersion: "7.6.7", error: null },
    ],
  };

  it("merges the three kinds by start and names reboots and upgrades by their device", () => {
    const items = cal._itemsOf(res, {});
    expect(items.map((i) => i.name)).toEqual(["Reboot · SRV-01", "Nightly patching", "Reboot · FGT-01", "Firmware 7.6.7 · SW-01"]);
  });

  it("draws a booking not yet run as a point, and a run across its span", () => {
    const items = cal._itemsOf(res, {});
    expect(items.find((i) => i.name === "Reboot · FGT-01")!.point).toBe(true);
    expect(items.find((i) => i.name === "Reboot · SRV-01")!.point).toBe(false);
    expect(items.find((i) => i.name === "Firmware 7.6.7 · SW-01")!.point).toBe(false);
  });

  it("colours by status, and says who booked it — naming an automation as one", () => {
    const items = cal._itemsOf(res, {});
    const booked = items.find((i) => i.name === "Reboot · FGT-01")!;
    expect(booked.cls).toContain("maint-cal-chip-reboot");
    expect(booked.cls).toContain("maint-cal-st-pending");
    expect(booked.tip).toContain("booked by automation “Memory over 90%”");
    const failed = items.find((i) => i.name === "Reboot · SRV-01")!;
    expect(failed.cls).toContain("maint-cal-st-bad");
    expect(failed.tip).toContain("did not come back");
    expect(items.find((i) => i.kind === "firmware")!.cls).toContain("maint-cal-st-ok");
  });

  it("status classes", () => {
    expect(cal._statusClass("succeeded")).toBe("ok");
    expect(["failed", "refused", "missed"].map(cal._statusClass)).toEqual(["bad", "bad", "bad"]);
    expect(cal._statusClass("unverified")).toBe("warn");
    expect(cal._statusClass("cancelled")).toBe("off");
    expect(cal._statusClass("pending")).toBe("pending");
    expect(cal._statusClass("rebooting")).toBe("live");
  });

  it("a hidden kind is left out", () => {
    expect(cal._itemsOf(res, { reboot: true }).some((i) => i.kind === "reboot")).toBe(false);
  });
});

describe("the calendar", () => {
  let calls: string[][] = [];
  let onItem: ReturnType<typeof vi.fn>;
  let onDay: ReturnType<typeof vi.fn>;
  let response: Record<string, unknown>;
  const doc = () => g.document as Document;
  const click = (el: Element) => el.dispatchEvent(new g.window.Event("click", { bubbles: true }));
  const maintOnly = (occurrences: unknown[]) => ({ maintenance: occurrences, reboot: [], firmware: [], truncated: false });

  async function mount(withDay = true): Promise<void> {
    doc().body.innerHTML = '<div id="host"></div>';
    await cal.mount(doc().getElementById("host")!, { onItem, onDay: withDay ? onDay : null });
  }

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 7, 12, 9, 0, 0)); // Wed 2026-08-12 09:00
    g.localStorage.clear();
    calls = [];
    onItem = vi.fn();
    onDay = vi.fn();
    response = maintOnly([
      { scheduleId: "s1", name: "Nightly patching", enabled: true, kind: "recurring", adhoc: false, start: "2026-08-12T22:00", end: "2026-08-13T02:00" },
      { scheduleId: "s2", name: "Ad-hoc — SW1", enabled: false, kind: "oneshot", adhoc: true, start: "2026-08-12T10:00", end: "2026-08-12T12:00" },
    ]);
    g.api = { calendar: { get: (from: string, to: string) => { calls.push([from, to]); return Promise.resolve(response); } } };
  });

  it("asks for whole weeks around the visible month and paints a timed window ONCE, on the day it starts", async () => {
    await mount();
    // August 2026 starts on a Saturday, so the grid opens on Sun 2026-07-26.
    expect(calls[0]).toEqual(["2026-07-26", "2026-09-05"]);
    expect(doc().getElementById("maint-cal-title")!.textContent).toBe("Aug 2026");
    const dayEl = (key: string) => doc().querySelector(`.maint-cal-day[data-day="${key}"]`)!;
    expect(dayEl("2026-08-12").querySelectorAll(".maint-cal-chip")).toHaveLength(2);
    expect(dayEl("2026-08-13").querySelectorAll(".maint-cal-chip")).toHaveLength(0);
    expect(dayEl("2026-08-12").querySelector(".maint-cal-chip:not(.maint-cal-chip-adhoc) .maint-cal-chip-time")!.textContent).toBe("22:00 →");
    const adhoc = dayEl("2026-08-12").querySelector(".maint-cal-chip-adhoc")!;
    expect(adhoc.className).toContain("maint-cal-chip-off");
    expect(dayEl("2026-08-12").className).toContain("maint-cal-day-today");
    expect(dayEl("2026-07-26").className).toContain("maint-cal-day-out");
    expect(doc().querySelectorAll(".maint-cal-span")).toHaveLength(0);
  });

  it("draws a window a day or longer as ONE bar per week row, continuing across rows", async () => {
    response = maintOnly([
      { scheduleId: "s3", name: "Ad-hoc — PULASKI-CORE-SW1", enabled: true, kind: "oneshot", adhoc: true, start: "2026-08-13T13:11", end: "2026-08-24T09:00" },
    ]);
    await mount();
    const bars = Array.from(doc().querySelectorAll(".maint-cal-span")) as HTMLElement[];
    expect(bars).toHaveLength(3);
    expect(bars[0].style.gridColumn.replace(/\s/g, "")).toBe("5/span3");
    expect(bars[0].className).toContain("maint-cal-span-to");
    expect(bars[0].className).not.toContain("maint-cal-span-from");
    expect(bars[0].textContent).toContain("13:11");
    expect(bars[1].style.gridColumn.replace(/\s/g, "")).toBe("1/span7");
    expect(bars[1].className).toContain("maint-cal-span-from");
    expect(bars[2].style.gridColumn.replace(/\s/g, "")).toBe("1/span2");
    expect(bars[2].textContent).toContain("→ 09:00");
    expect(doc().querySelectorAll(".maint-cal-chip")).toHaveLength(0);
    expect(bars[0].getAttribute("data-schedule-id")).toBe("s3");
  });

  it("folds a week with more than three bars behind '+N more windows'", async () => {
    response = maintOnly(Array.from({ length: 5 }, (_, i) => ({
      scheduleId: "m" + i, name: "Freeze " + i, enabled: true, kind: "oneshot", adhoc: false, start: "2026-08-10T00:00", end: "2026-08-15T00:00",
    })));
    await mount();
    expect(doc().querySelectorAll(".maint-cal-span")).toHaveLength(3);
    const more = doc().querySelector(".maint-cal-more-week")!;
    expect(more.textContent).toBe("+2 more windows");
    click(more);
    await vi.waitFor(() => expect(doc().querySelectorAll(".maint-cal-span")).toHaveLength(5));
  });

  it("the List view shows the same items as readable rows, with running windows first", async () => {
    response = {
      ...maintOnly([
        { scheduleId: "s1", name: "Nightly patching", enabled: true, kind: "recurring", adhoc: false, start: "2026-08-12T22:00", end: "2026-08-13T02:00" },
        { scheduleId: "s3", name: "Ad-hoc — PULASKI-CORE-SW1", enabled: true, kind: "oneshot", adhoc: true, start: "2026-07-30T13:11", end: "2026-08-24T09:00" },
      ]),
      reboot: [{ id: "booking:b1", assetId: "a1", assetName: "FGT-01", start: "2026-08-12T02:00", end: "2026-08-12T02:15", booked: true, scheduleId: "b1", runId: null, status: "pending", by: "dmoore", toVersion: null, error: null }],
    };
    await mount();
    click(doc().querySelector('.maint-cal-view [data-view="list"]')!);
    await vi.waitFor(() => expect(doc().querySelectorAll(".maint-cal-row").length).toBe(3));
    const groups = Array.from(doc().querySelectorAll(".maint-cal-group-title")).map((h) => h.textContent);
    expect(groups[0]).toContain("Already running when the month opens");
    expect(groups[1]).toContain("Aug 12");
    const rows = Array.from(doc().querySelectorAll(".maint-cal-row")) as HTMLElement[];
    expect(rows[0].textContent).toContain("Ad-hoc — PULASKI-CORE-SW1");
    expect(rows[0].textContent).toContain("24d 19h");
    // The reboot at 02:00 reads as its time, with its state and booker.
    expect(rows[1].querySelector(".maint-cal-row-when")!.textContent).toBe("02:00");
    expect(rows[1].textContent).toContain("Reboot · FGT-01");
    expect(rows[1].querySelector(".maint-cal-row-meta")!.textContent).toBe("scheduled · dmoore");
    expect(rows[2].querySelector(".maint-cal-row-when")!.textContent).toBe("22:00 – 02:00");
    expect((doc().querySelector(".maint-cal-dow") as HTMLElement).style.display).toBe("none");
    click(doc().querySelector('.maint-cal-view [data-view="month"]')!);
    await vi.waitFor(() => expect(doc().querySelectorAll(".maint-cal-day").length).toBeGreaterThan(0));
  });

  it("the Week view fetches one week, draws timed items as blocks at their hours and long ones in the all-day band", async () => {
    response = {
      ...maintOnly([
        { scheduleId: "s1", name: "Nightly patching", enabled: true, kind: "recurring", adhoc: false, start: "2026-08-12T22:00", end: "2026-08-13T02:00" },
        { scheduleId: "s2", name: "Ad-hoc — SW1", enabled: false, kind: "oneshot", adhoc: true, start: "2026-08-12T10:00", end: "2026-08-12T12:00" },
        { scheduleId: "s3", name: "Freeze", enabled: true, kind: "oneshot", adhoc: false, start: "2026-08-10T00:00", end: "2026-08-13T00:00" },
      ]),
      firmware: [{ id: "run:fr2", assetId: "a3", assetName: "SW-01", start: "2026-08-11T14:00", end: "2026-08-11T14:45", booked: false, scheduleId: null, runId: "fr2", status: "succeeded", by: "dmoore", toVersion: "7.6.7", error: null }],
    };
    await mount();
    click(doc().querySelector('.maint-cal-view [data-view="week"]')!);
    await vi.waitFor(() => expect(doc().querySelectorAll(".maint-cal-time-col").length).toBe(7));
    expect(calls[calls.length - 1]).toEqual(["2026-08-09", "2026-08-15"]);
    expect(doc().getElementById("maint-cal-title")!.textContent).toBe("Aug 9 – 15, 2026");
    expect(doc().getElementById("maint-cal-prev")!.getAttribute("aria-label")).toBe("Previous week");
    const col = (key: string) => doc().querySelector(`.maint-cal-time-col[data-day="${key}"]`)! as HTMLElement;
    const wed = Array.from(col("2026-08-12").querySelectorAll(".maint-cal-block")) as HTMLElement[];
    expect(wed).toHaveLength(2);
    expect(wed[0].textContent).toContain("10:00–12:00");
    expect(wed[0].style.top).toBe(`${10 * 28}px`);
    expect(wed[0].style.height).toBe(`${2 * 28 - 2}px`);
    expect(wed[1].textContent).toContain("22:00–00:00");
    expect(wed[1].className).toContain("maint-cal-block-runs");
    const thu = Array.from(col("2026-08-13").querySelectorAll(".maint-cal-block")) as HTMLElement[];
    expect(thu).toHaveLength(1);
    expect(thu[0].className).toContain("maint-cal-block-cont");
    // The firmware run is a block on Tuesday across its 45 minutes.
    const tue = col("2026-08-11").querySelector(".maint-cal-block.maint-cal-chip-firmware") as HTMLElement;
    expect(tue.textContent).toContain("Firmware 7.6.7 · SW-01");
    expect(tue.style.top).toBe(`${14 * 28}px`);
    const band = doc().querySelector(".maint-cal-time-band .maint-cal-span")! as HTMLElement;
    expect(band.style.gridColumn.replace(/\s/g, "")).toBe("2/span3");
    expect(col("2026-08-12").querySelector(".maint-cal-nowline")).not.toBeNull();
    click(doc().getElementById("maint-cal-next")!);
    await vi.waitFor(() => expect(doc().getElementById("maint-cal-title")!.textContent).toBe("Aug 16 – 22, 2026"));
    expect(calls[calls.length - 1]).toEqual(["2026-08-16", "2026-08-22"]);
    click(doc().querySelector('.maint-cal-view [data-view="month"]')!);
    await vi.waitFor(() => expect(doc().querySelectorAll(".maint-cal-day").length).toBeGreaterThan(0));
  });

  it("the Day view shows one column, steps by a day, and a click on it hands the day to the host", async () => {
    await mount();
    click(doc().querySelector('.maint-cal-view [data-view="day"]')!);
    await vi.waitFor(() => expect(doc().querySelectorAll(".maint-cal-time-col").length).toBe(1));
    expect(calls[calls.length - 1]).toEqual(["2026-08-12", "2026-08-12"]);
    expect(doc().getElementById("maint-cal-title")!.textContent).toBe("Wed Aug 12 2026");
    click(doc().getElementById("maint-cal-next")!);
    await vi.waitFor(() => expect(doc().getElementById("maint-cal-title")!.textContent).toBe("Thu Aug 13 2026"));
    click(doc().querySelector(".maint-cal-time-col")!);
    expect(onDay).toHaveBeenCalledWith("2026-08-13", undefined);
    click(doc().getElementById("maint-cal-today")!);
    await vi.waitFor(() => expect(doc().getElementById("maint-cal-title")!.textContent).toBe("Wed Aug 12 2026"));
    click(doc().querySelector('.maint-cal-view [data-view="month"]')!);
    await vi.waitFor(() => expect(doc().getElementById("maint-cal-title")!.textContent).toBe("Aug 2026"));
  });

  it("month nav moves the window and refetches", async () => {
    await mount();
    click(doc().getElementById("maint-cal-next")!);
    await vi.waitFor(() => expect(calls).toHaveLength(2));
    expect(doc().getElementById("maint-cal-title")!.textContent).toBe("Sep 2026");
  });

  it("a click on an empty day goes to the host's onDay; without one, empty days do nothing", async () => {
    await mount();
    click(doc().querySelector('.maint-cal-day[data-day="2026-08-20"]')!);
    expect(onDay).toHaveBeenCalledWith("2026-08-20");
    await mount(false);
    const day = doc().querySelector('.maint-cal-day[data-day="2026-08-20"]')!;
    expect(day.className).toContain("maint-cal-day-ro");
    expect(day.getAttribute("title")).toBeNull();
    click(day);
    expect(onDay).toHaveBeenCalledTimes(1);
  });

  it("a click on an item hands the item — not the day — to the host", async () => {
    response = { ...maintOnly([]), reboot: [{ id: "booking:b1", assetId: "a1", assetName: "FGT-01", start: "2026-08-14T02:00", end: "2026-08-14T02:15", booked: true, scheduleId: "b1", runId: null, status: "pending", by: "dmoore", toVersion: null, error: null }] };
    await mount();
    const chip = doc().querySelector('.maint-cal-day[data-day="2026-08-14"] .maint-cal-chip')!;
    expect(chip.textContent).toBe("02:00 Reboot · FGT-01");
    expect(chip.getAttribute("data-asset-id")).toBe("a1");
    click(chip);
    expect(onDay).not.toHaveBeenCalled();
    expect(onItem).toHaveBeenCalledTimes(1);
    expect(onItem.mock.calls[0][0]).toMatchObject({ kind: "reboot", raw: { scheduleId: "b1", assetId: "a1", status: "pending" } });
  });

  it("offers a filter only for the kinds the caller may read, and remembers what is hidden", async () => {
    response = { maintenance: null, reboot: [{ id: "booking:b1", assetId: "a1", assetName: "FGT-01", start: "2026-08-14T02:00", end: "2026-08-14T02:15", booked: true, scheduleId: "b1", runId: null, status: "pending", by: "dmoore", toVersion: null, error: null }], firmware: [], truncated: false };
    await mount();
    const boxes = Array.from(doc().querySelectorAll("#maint-cal-kinds input")) as HTMLInputElement[];
    expect(boxes.map((b) => b.getAttribute("data-kind"))).toEqual(["reboot", "firmware"]);
    expect(doc().querySelectorAll(".maint-cal-chip-reboot")).toHaveLength(1);
    boxes[0].checked = false;
    boxes[0].dispatchEvent(new g.window.Event("change", { bubbles: true }));
    await vi.waitFor(() => expect(doc().querySelectorAll(".maint-cal-chip-reboot")).toHaveLength(0));
    expect(JSON.parse(g.localStorage.getItem("polaris.opsCalHidden"))).toEqual(["reboot"]);
  });

  it("says when the server cut the list short", async () => {
    response = { ...maintOnly([]), truncated: true };
    await mount();
    expect(doc().getElementById("maint-cal-note")!.textContent).toMatch(/some are omitted/);
  });
});
