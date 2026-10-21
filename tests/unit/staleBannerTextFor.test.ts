/**
 * tests/unit/staleBannerTextFor.test.ts — _staleBannerTextFor (public/js/assets.js),
 * the lookup that carries a section's amber "Last successful update X ago"
 * banner into its chart / table screenshots.
 *
 * A screenshot rasterizes only the chart's svg or the table element, so the
 * banner above it never reached the image: a capture of a day-stale Interfaces
 * table looked live once pasted elsewhere. The capture paths now ask this
 * helper for the banner that belongs to the captured element and draw its text
 * in the image header.
 *
 * What's pinned: a banner before the table in its section is found; a banner
 * inside a chart container (CPU & Memory emits it above the svg) is found; an
 * EMPTY slot (fresh section) ends the search rather than borrowing the previous
 * section's banner; nothing outside the asset tab panel is consulted; and the
 * Response Time chart's id-only slot is matched too.
 *
 * Sliced out of assets.js and eval'd, as in assetSystemChartStaleBanner.test.ts.
 *
 * @vitest-environment happy-dom
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const g = globalThis as Record<string, any>;
const lines = readFileSync(resolve(__dirname, "../../public/js/assets.js"), "utf8").split(/\r?\n/);
const start = lines.findIndex((l) => l.startsWith("function _staleBannerTextFor("));
const end = lines.findIndex((l, i) => i > start && l === "}");
(0, eval)(lines.slice(start, end + 1).join("\n") + "\nglobalThis._staleBannerTextFor = _staleBannerTextFor;");

const BANNER = '<div class="asset-stale-banner-slot"><div>⚠ Last successful update 1d ago</div></div>';
const EMPTY = '<div class="asset-stale-banner-slot"></div>';

describe("_staleBannerTextFor", () => {
  it("finds the banner above a table in its section", () => {
    document.body.innerHTML =
      '<div id="asset-view-tab-system" class="active"><div id="iface">' + BANNER +
      '<p class="hint">x</p><div class="table-wrapper"><table id="t"></table></div></div></div>';
    expect(g._staleBannerTextFor(document.getElementById("t"))).toBe("⚠ Last successful update 1d ago");
  });

  it("finds a banner the chart container emits above its svg", () => {
    document.body.innerHTML =
      '<div id="asset-view-tab-system"><div id="chart">' + BANNER + "<svg></svg></div></div>";
    expect(g._staleBannerTextFor(document.getElementById("chart"))).toContain("1d ago");
  });

  it("an empty slot (fresh section) does not borrow the previous section's banner", () => {
    document.body.innerHTML =
      '<div id="asset-view-tab-system">' +
        '<div id="a">' + BANNER + '<table id="ta"></table></div>' +
        '<div id="b">' + EMPTY + '<table id="tb"></table></div>' +
      "</div>";
    expect(g._staleBannerTextFor(document.getElementById("tb"))).toBe("");
    expect(g._staleBannerTextFor(document.getElementById("ta"))).toContain("1d ago");
  });

  it("never looks outside the asset tab panel", () => {
    document.body.innerHTML = BANNER + '<div id="asset-view-tab-events"><table id="t"></table></div>';
    expect(g._staleBannerTextFor(document.getElementById("t"))).toBe("");
  });

  it("matches the Response Time chart's id-only slot", () => {
    document.body.innerHTML =
      '<div id="asset-view-tab-monitoring"><div id="asset-monitor-stale"><div>⚠ No successful update in the last 24h</div></div>' +
      '<div id="rt"><svg></svg></div></div>';
    expect(g._staleBannerTextFor(document.getElementById("rt"))).toContain("No successful update");
  });
});
