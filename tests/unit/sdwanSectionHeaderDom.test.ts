/**
 * tests/unit/sdwanSectionHeaderDom.test.ts — the SD-WAN tab's three section
 * headers state where their data came from and how old it is
 * (public/js/assets.js).
 *
 * Performance SLA already carried a provenance badge + an "updated N ago"
 * stamp; SD-WAN Members and SD-WAN Rules carried a bare <h4>. All three are
 * snapshots of what the gate last answered, and an undated one reads as
 * current — an empty members table saying "this gate has no WAN members" when
 * it means "not answered since yesterday".
 *
 * Pinned here: every section renders badge + stamp; the stamp goes amber past
 * ONE cadence (the `_freshnessStampHTML` threshold the snapshot tabs use, not
 * the stale banner's 3×); a never-scraped table says so rather than rendering
 * an empty slot; and a null cadence (an unmonitored gate, where nothing
 * refreshes SD-WAN) never ambers, because there is no figure to be late
 * against.
 *
 * assets.js has no module boundary, so the functions under test are sliced out
 * by name and eval'd — the harness of tests/unit/assetWirelessTreeDom.test.ts.
 *
 * @vitest-environment happy-dom
 */

import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const g = globalThis as Record<string, any>;

const assetsLines = readFileSync(resolve(__dirname, "../../public/js/assets.js"), "utf8").split(/\r?\n/);

/** Slice a top-level `function NAME(...) {` … `}` block out of assets.js. */
function fnSrc(name: string): string {
  const start = assetsLines.findIndex((l) => l.startsWith(`function ${name}(`));
  if (start < 0) throw new Error(`assets.js: function ${name} not found`);
  const end = assetsLines.findIndex((l, i) => i > start && l === "}");
  if (end < 0) throw new Error(`assets.js: no end of function ${name}`);
  return assetsLines.slice(start, end + 1).join("\n");
}

const FN_NAMES = [
  "_formatPollingInterval",
  "_freshnessStampHTML",
  "_sdwanSectionHeaderHTML",
];

const BADGE = '<span class="asset-stream-source-badge">REST API (Direct) · every 10m · Source default</span>';

/** An ISO timestamp `sec` seconds in the past. */
const ago = (sec: number) => new Date(Date.now() - sec * 1000).toISOString();

beforeEach(() => {
  g.escapeHtml = (s: any) =>
    String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  // The badge builder walks the whole polling-resolver chain; the header only
  // has to place what it returns.
  g._streamSourceBadgeHTML = () => BADGE;
  g.timeAgo = (t: any) => Math.round((Date.now() - new Date(t).getTime()) / 60000) + "m ago";

  // eslint-disable-next-line no-eval
  (0, eval)(FN_NAMES.map(fnSrc).join("\n\n"));
});

describe("_sdwanSectionHeaderHTML", () => {
  it("renders the heading, the stream badge and a freshness stamp", () => {
    const html = g._sdwanSectionHeaderHTML({ id: "a1" }, "SD-WAN Members", ago(300), 600, "never collected");
    expect(html).toContain("<h4");
    expect(html).toContain("SD-WAN Members");
    expect(html).toContain("asset-stream-source-badge");
    expect(html).toContain("updated 5m ago");
  });

  it("stays neutral inside one cadence and turns amber past it", () => {
    const fresh = g._sdwanSectionHeaderHTML({ id: "a1" }, "SD-WAN Rules", ago(300), 600, "never collected");
    expect(fresh).not.toContain("var(--color-warning)");

    const overdue = g._sdwanSectionHeaderHTML({ id: "a1" }, "SD-WAN Rules", ago(1200), 600, "never collected");
    expect(overdue).toContain("var(--color-warning)");
  });

  it("says never collected instead of leaving the stamp blank", () => {
    const html = g._sdwanSectionHeaderHTML({ id: "a1" }, "SD-WAN Rules", null, 600, "never collected");
    expect(html).toContain("never collected");
  });

  it("never ambers when no cadence refreshes the table", () => {
    // pollIntervalSec is null for an unmonitored gate — nothing writes SD-WAN,
    // so there is no interval for the data to be late against.
    const html = g._sdwanSectionHeaderHTML({ id: "a1" }, "SD-WAN Members", ago(86400), null, "never collected");
    expect(html).toContain("updated");
    expect(html).not.toContain("var(--color-warning)");
  });

  it("places extra header content (the health-check selector) before the badge", () => {
    const html = g._sdwanSectionHeaderHTML(
      { id: "a1" }, "Performance SLA", ago(60), 600, "never collected",
      '<select id="sdwan-perfsla-select"></select>',
    );
    expect(html.indexOf("sdwan-perfsla-select")).toBeGreaterThan(html.indexOf("<h4"));
    expect(html.indexOf("sdwan-perfsla-select")).toBeLessThan(html.indexOf("asset-stream-source-badge"));
  });
});
