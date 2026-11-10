// @vitest-environment happy-dom
/**
 * tests/unit/eventLogPagination.test.ts — the two event logs page through the
 * shared list pager (CQ-F019).
 *
 * events.js `renderPagination` and assets.js `_renderAssetEventsPagination`
 * were hand-rolled copies of app.js `renderPageControls` (same window
 * algorithm, `...` on one and `…` on the other, their own button classes).
 * Both now call renderPageControls with `itemLabel: "events"`. This pins the
 * label option, the asset tab's click wiring through the real pager, and that
 * neither copy grows back.
 *
 * app.js / assets.js are browser scripts with no module boundary, so the
 * functions are sliced out by name and eval'd (renderPageControlsTopNav idiom).
 */

import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { appSource } from "./_appSource.js";

const g = globalThis as Record<string, any>;
const read = (f: string) => readFileSync(resolve(__dirname, "../../public/js", f), "utf8");
const APP = appSource().split(/\r?\n/);
const ASSETS = read("assets.js").split(/\r?\n/);
const EVENTS = read("events.js");

function fnSrc(lines: string[], name: string): string {
  const start = lines.findIndex((l) => l.startsWith(`function ${name}(`));
  if (start < 0) throw new Error(`function ${name} not found`);
  const end = lines.findIndex((l, i) => i > start && l === "}");
  return lines.slice(start, end + 1).join("\n");
}

beforeEach(() => {
  g.sizeStickyTableWrappers = () => {};
  (0, eval)(fnSrc(APP, "renderPageControls"));
});

describe("renderPageControls itemLabel", () => {
  it("counts 'items' by default and the caller's noun when given", () => {
    document.body.innerHTML = '<div id="pg"></div>';
    g.renderPageControls("pg", 40, 15, 1, () => {});
    expect(document.getElementById("pg")!.textContent).toContain("40 items");
    g.renderPageControls("pg", 40, 15, 1, () => {}, null, { itemLabel: "events" });
    expect(document.getElementById("pg")!.textContent).toContain("40 events");
  });
});

describe("asset Events tab pager", () => {
  let loads: number;
  beforeEach(() => {
    document.body.innerHTML = '<div id="asset-view-events-pagination"></div>';
    loads = 0;
    g._assetEventsTotal = 200;
    g._assetEventsPageSize = 15;
    g._assetEventsOffset = 0;
    g._loadAssetEventsTabFor = () => { loads++; };
    (0, eval)(fnSrc(ASSETS, "_renderAssetEventsPagination"));
  });

  it("renders the shared pager markup with one ellipsis character", () => {
    g._renderAssetEventsPagination();
    const el = document.getElementById("asset-view-events-pagination")!;
    expect(el.querySelector(".pg-prev")).not.toBeNull();
    expect(el.querySelector(".pg-btn[disabled]")!.textContent).toBe("1");
    expect(el.textContent).toContain("200 events");
    expect(el.textContent).toContain("...");
    expect(el.textContent).not.toContain("…");
  });

  it("moves the offset and reloads on a page button, Next and Prev", () => {
    g._renderAssetEventsPagination();
    const el = () => document.getElementById("asset-view-events-pagination")!;
    (el().querySelector('.pg-btn[data-page="3"]') as HTMLButtonElement).click();
    expect(g._assetEventsOffset).toBe(30);
    expect(loads).toBe(1);
    g._renderAssetEventsPagination();
    (el().querySelector(".pg-next") as HTMLButtonElement).click();
    expect(g._assetEventsOffset).toBe(45);
    g._renderAssetEventsPagination();
    (el().querySelector(".pg-prev") as HTMLButtonElement).click();
    expect(g._assetEventsOffset).toBe(30);
    expect(loads).toBe(3);
  });
});

describe("no hand-rolled event-log pager", () => {
  it("events.js renderPagination delegates to renderPageControls", () => {
    const body = EVENTS.slice(EVENTS.indexOf("function renderPagination("));
    const fn = body.slice(0, body.indexOf("\n  }") + 4);
    expect(fn).toContain('renderPageControls("pagination"');
    expect(fn).toContain('itemLabel: "events"');
    expect(EVENTS).not.toMatch(/class="[^"]*\bpage-(btn|prev|next)\b/);
  });

  it("assets.js has no ae-page-* buttons left", () => {
    expect(ASSETS.join("\n")).not.toMatch(/\bae-page-(btn|prev|next)\b/);
  });
});
