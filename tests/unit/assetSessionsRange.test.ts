/**
 * tests/unit/assetSessionsRange.test.ts — the Active Sessions chart's own
 * time-range selection (asset details → System tab, FortiGate firewalls).
 *
 * The chart used to ride the CPU & Memory chart's window with no selector of
 * its own. It now keeps its own range (pref key "assetSessions") through
 * `_currentSessionsRange` / `_loadSessionsChartFor`, reusing the CPU & Memory
 * telemetry payload only when the two selections match. Two behaviors are
 * load-bearing enough to pin:
 *   - the loader reuses a prefetched payload instead of double-fetching the
 *     same telemetry-history window on every panel open, and
 *   - an EMPTY window on an already-visible section must not hide the section
 *     (hiding takes the range buttons with it, stranding whoever picked the
 *     empty window).
 *
 * assets.js is an ~18k-line browser script with no module boundary, so the
 * functions are sliced out by name and eval'd — the assetsPageControlsDom idiom.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { assetsSource } from "./_assetsSource.js";

vi.mock("../../src/db.js", () => ({ prisma: {} }));

const g = globalThis as Record<string, any>;
const src = assetsSource();
const lines = src.split(/\r?\n/);

/** Slice a top-level `[async ]function NAME(...) {` … `}` block out of assets.js. */
function fnSrc(name: string): string {
  const start = lines.findIndex(
    (l) => l.startsWith(`function ${name}(`) || l.startsWith(`async function ${name}(`),
  );
  if (start < 0) throw new Error(`assets.js: function ${name} not found`);
  const end = lines.findIndex((l, i) => i > start && l === "}");
  if (end < 0) throw new Error(`assets.js: no end of function ${name}`);
  return lines.slice(start, end + 1).join("\n");
}

interface FakeEl {
  dataset: Record<string, string>;
  textContent: string;
  style: { display: string };
}
function makeEl(): FakeEl {
  return { dataset: {}, textContent: "", style: { display: "" } };
}

let els: Record<string, FakeEl>;
let telemetryCalls: Array<{ assetId: string; opts: unknown }>;
let renderCalls: Array<{ tel: unknown }>;
let prefReads: Array<{ key: string; fallback: string }>;

beforeEach(() => {
  els = {};
  telemetryCalls = [];
  renderCalls = [];
  prefReads = [];

  g.document = { getElementById: (id: string) => els[id] ?? null };
  g._getChartRangePref = (key: string, fallback: string) => {
    prefReads.push({ key, fallback });
    return fallback;
  };
  g.api = {
    assets: {
      telemetryHistory: async (assetId: string, opts: unknown) => {
        telemetryCalls.push({ assetId, opts });
        return { samples: [], fetched: true };
      },
    },
  };
  g._renderSessionsChart = (_container: FakeEl, tel: unknown) => {
    renderCalls.push({ tel });
  };

  (0, eval)(fnSrc("_currentSessionsRange"));
  (0, eval)(fnSrc("_loadSessionsChartFor"));
  expect(typeof g._currentSessionsRange, "assets.js no longer declares _currentSessionsRange").toBe("function");
  expect(typeof g._loadSessionsChartFor, "assets.js no longer declares _loadSessionsChartFor").toBe("function");
});

describe("_currentSessionsRange", () => {
  it("falls back to the assetSessions pref before the chart's first load", () => {
    expect(g._currentSessionsRange()).toBe("1h");
    expect(prefReads).toEqual([{ key: "assetSessions", fallback: "1h" }]);
  });

  it("reads a stamped range string off the sessions container", () => {
    els["asset-system-sessions-chart"] = makeEl();
    els["asset-system-sessions-chart"]!.dataset.range = "7d";
    expect(g._currentSessionsRange()).toBe("7d");
    expect(prefReads).toEqual([]);
  });

  it("returns a {from, to} object for a stamped custom window", () => {
    const el = makeEl();
    el.dataset.from = "2026-08-19T00:00:00.000Z";
    el.dataset.to = "2026-08-20T00:00:00.000Z";
    els["asset-system-sessions-chart"] = el;
    expect(g._currentSessionsRange()).toEqual({
      from: "2026-08-19T00:00:00.000Z",
      to: "2026-08-20T00:00:00.000Z",
    });
  });
});

describe("_loadSessionsChartFor", () => {
  it("reuses a prefetched payload without a second telemetry fetch", async () => {
    els["asset-system-sessions-chart"] = makeEl();
    const tel = { samples: [{ sessionCount: 5 }] };
    await g._loadSessionsChartFor("a1", "1h", { id: "a1" }, { tel });

    expect(telemetryCalls).toEqual([]);
    expect(renderCalls).toEqual([{ tel }]);
    expect(els["asset-system-sessions-chart"]!.dataset.range).toBe("1h");
  });

  it("fetches its own window when no payload is supplied", async () => {
    els["asset-system-sessions-chart"] = makeEl();
    await g._loadSessionsChartFor("a1", "30d", { id: "a1" });

    expect(telemetryCalls).toEqual([{ assetId: "a1", opts: { range: "30d" } }]);
    expect(renderCalls).toHaveLength(1);
  });

  it("stamps a custom window as from/to and clears any prior range", async () => {
    const el = makeEl();
    el.dataset.range = "1h";
    els["asset-system-sessions-chart"] = el;
    const win = { from: "2026-08-19T00:00:00.000Z", to: "2026-08-20T00:00:00.000Z" };
    await g._loadSessionsChartFor("a1", win, { id: "a1" });

    expect(el.dataset.from).toBe(win.from);
    expect(el.dataset.to).toBe(win.to);
    expect(el.dataset.range).toBeUndefined();
    expect(telemetryCalls).toEqual([{ assetId: "a1", opts: win }]);
  });

  it("surfaces a fetch error in the container (non-silent)", async () => {
    els["asset-system-sessions-chart"] = makeEl();
    g.api.assets.telemetryHistory = async () => { throw new Error("boom"); };
    await g._loadSessionsChartFor("a1", "24h", { id: "a1" });

    expect(els["asset-system-sessions-chart"]!.textContent).toContain("boom");
  });
});

describe("_renderSessionsChart — empty window", () => {
  beforeEach(() => {
    (0, eval)(fnSrc("_renderSessionsChart"));
    expect(typeof g._renderSessionsChart).toBe("function");
  });

  it("keeps a visible section on screen and shows an empty state", () => {
    const section = makeEl();
    section.style.display = ""; // already revealed by an earlier window with data
    els["asset-system-sessions-section"] = section;
    const container = makeEl();

    g._renderSessionsChart(container, { samples: [] }, { id: "a1" });

    expect(section.style.display).not.toBe("none");
    expect(container.textContent).toBe("No session samples in this range.");
  });

  it("leaves a never-revealed section hidden", () => {
    const section = makeEl();
    section.style.display = "none";
    els["asset-system-sessions-section"] = section;
    const container = makeEl();

    g._renderSessionsChart(container, { samples: [] }, { id: "a1" });

    expect(section.style.display).toBe("none");
    expect(container.textContent).toBe("");
  });
});

describe("assets.js source — sessions chart wiring", () => {
  it("gives the sessions section its own screenshot chart key", () => {
    expect(src).toContain('data-shot-section="sessions" data-shot-label="Active Sessions" data-shot-chart="assetSessions"');
  });

  it("dispatches assetSessions in the screenshot selection getter", () => {
    expect(src).toContain('if (chartKey === "assetSessions") return _currentSessionsRange();');
  });
});
