/**
 * tests/unit/widgetPollVisible.test.ts
 *
 * PolarisWidgets.pollVisible in public/js/widgets/index.js — every dashboard
 * widget's refresh loop (CQ-F040). Same harness as widgetSort.test.ts: the
 * browser IIFE eval'd into a happy-dom window.
 *
 * What is load-bearing:
 *   • a hidden tab polls NOTHING — 31 widgets on 30 s / 60 s timers used to
 *     keep asking whether or not anyone was looking;
 *   • coming back refreshes at once only when a tick was actually skipped, so
 *     a quick tab switch does not fire a whole dashboard together;
 *   • unmount (ctx.onUnmount) releases BOTH the timer and the visibility
 *     listener — a widget re-rendered by an edit must not leave a listener
 *     behind that keeps firing its old fn;
 *   • no widget file polls with a bare setInterval (the source guard), so a new
 *     widget cannot quietly reintroduce the hidden-tab load.
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { Window } from "happy-dom";

type Stop = () => void;
type PollVisible = (ctx: { onUnmount: (fn: () => void) => void } | null, fn: () => void, ms: number) => Stop;

const here = dirname(fileURLToPath(import.meta.url));
const widgetsDir = resolve(here, "../../public/js/widgets");
const g = globalThis as Record<string, unknown>;
let win: Window;
let doc: Window["document"];
let pollVisible: PollVisible;
let hidden = false;

function setHidden(v: boolean) {
  hidden = v;
  doc.dispatchEvent(new win.Event("visibilitychange"));
}

beforeAll(() => {
  win = new Window();
  doc = win.document;
  Object.defineProperty(doc, "hidden", { configurable: true, get: () => hidden });
  g.window = win;
  g.document = doc;
  (0, eval)(readFileSync(resolve(widgetsDir, "index.js"), "utf8"));
  pollVisible = (win as unknown as { PolarisWidgets: { pollVisible: PollVisible } }).PolarisWidgets.pollVisible;
});

beforeEach(() => {
  hidden = false;
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

function mount() {
  const cleanups: Array<() => void> = [];
  return { ctx: { onUnmount: (fn: () => void) => cleanups.push(fn) }, unmount: () => cleanups.forEach((f) => f()) };
}

describe("PolarisWidgets.pollVisible", () => {
  it("calls fn on every tick while the tab is visible", () => {
    const fn = vi.fn();
    const { ctx, unmount } = mount();
    pollVisible(ctx, fn, 30_000);
    vi.advanceTimersByTime(90_000);
    expect(fn).toHaveBeenCalledTimes(3);
    unmount();
  });

  it("skips every tick while the tab is hidden", () => {
    const fn = vi.fn();
    const { ctx, unmount } = mount();
    pollVisible(ctx, fn, 30_000);
    setHidden(true);
    vi.advanceTimersByTime(300_000);
    expect(fn).not.toHaveBeenCalled();
    unmount();
  });

  it("refreshes once on return when a tick was skipped", () => {
    const fn = vi.fn();
    const { ctx, unmount } = mount();
    pollVisible(ctx, fn, 30_000);
    setHidden(true);
    vi.advanceTimersByTime(65_000); // two ticks skipped
    setHidden(false);
    expect(fn).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(25_000); // the next scheduled tick (t = 90 s)
    expect(fn).toHaveBeenCalledTimes(2);
    unmount();
  });

  it("does not refresh on a quick tab switch that skipped no tick", () => {
    const fn = vi.fn();
    const { ctx, unmount } = mount();
    pollVisible(ctx, fn, 30_000);
    setHidden(true);
    vi.advanceTimersByTime(5_000);
    setHidden(false);
    expect(fn).not.toHaveBeenCalled();
    unmount();
  });

  it("unmount releases the timer and the visibility listener", () => {
    const fn = vi.fn();
    const { ctx, unmount } = mount();
    pollVisible(ctx, fn, 30_000);
    setHidden(true);
    vi.advanceTimersByTime(40_000); // one tick skipped: a return WOULD refresh
    unmount();
    setHidden(false);
    vi.advanceTimersByTime(120_000);
    expect(fn).not.toHaveBeenCalled();
  });

  it("works without a ctx; the returned stop releases it", () => {
    const fn = vi.fn();
    const stop = pollVisible(null, fn, 10_000);
    vi.advanceTimersByTime(10_000);
    expect(fn).toHaveBeenCalledTimes(1);
    stop();
    stop(); // idempotent
    vi.advanceTimersByTime(60_000);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe("widget refresh loops go through pollVisible (CQ-F040 source guard)", () => {
  // deviceMap's view ROTATION is a display timer, not a data read, and is the
  // only setInterval a widget file may hold outside index.js.
  const ALLOWED = /rotateTimer = setInterval\(/;

  it("no widget file polls with a bare setInterval", () => {
    const offenders: string[] = [];
    for (const f of readdirSync(widgetsDir).filter((n) => n.endsWith(".js") && n !== "index.js")) {
      readFileSync(resolve(widgetsDir, f), "utf8").split("\n").forEach((line, i) => {
        if (/\bsetInterval\(/.test(line) && !ALLOWED.test(line)) offenders.push(`${f}:${i + 1}`);
      });
    }
    expect(offenders).toEqual([]);
  });
});
