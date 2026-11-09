/**
 * tests/unit/assetEventsTabColumns.test.ts — the asset-details Events tab's
 * column layout (public/js/assets.js → _assetEventsTabHTML /
 * _renderAssetEventRow / _wireAssetEventsTab) against the real table-sf.js.
 *
 * Pinned:
 *  - the resizable columns (Action, Resource) carry a drag handle. The tab
 *    used to build the column layout BEFORE TableSF, whose header rebuild
 *    wiped every handle — no column on the tab could be resized;
 *  - Timestamp and Level are content-fit: sized to the date/time and level
 *    badge they hold, no handle;
 *  - the Message cell carries the whole message as its hover title.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Window } from "happy-dom";

const g = globalThis as Record<string, any>;
const assetsLines = readFileSync(resolve(__dirname, "../../public/js/assets.js"), "utf8").split(/\r?\n/);
const tableSfSrc = readFileSync(resolve(__dirname, "../../public/js/table-sf.js"), "utf8");

function fnSrc(name: string): string {
  const start = assetsLines.findIndex((l) => l.startsWith(`function ${name}(`) || l.startsWith(`async function ${name}(`));
  if (start < 0) throw new Error(`assets.js: function ${name} not found`);
  const end = assetsLines.findIndex((l, i) => i > start && l === "}");
  return assetsLines.slice(start, end + 1).join("\n");
}
function varSrc(name: string): string {
  const line = assetsLines.find((l) => l.startsWith(`var ${name} =`));
  if (!line) throw new Error(`assets.js: var ${name} not found`);
  return line;
}

const VARS = [
  "_assetEventsCurrentPage", "_assetEventsAssetId", "_assetEventsSF", "_assetEventsLayout",
  "_assetEventsPageSize", "_assetEventsOffset", "_assetEventsTotal", "_assetEventsLoaded",
];
const FNS = [
  "_assetEventsTabHTML", "_renderAssetEventRow", "_wireAssetEventsTab",
  "_saveAssetEventsPrefs", "_restoreAssetEventsPrefs",
];

let win: Window;
let doc: Window["document"];

beforeEach(() => {
  win = new Window();
  doc = win.document;
  g.window = win;
  g.document = doc;
  g.localStorage = (win as any).localStorage;
  g.MutationObserver = (win as any).MutationObserver;
  g.ResizeObserver = (win as any).ResizeObserver;
  g.requestAnimationFrame = (fn: () => void) => setTimeout(fn, 0);
  g.getComputedStyle = (el: Element) => (win as any).getComputedStyle(el);
  g.CSS = (win as any).CSS;
  g.currentUsername = "tester";
  g.escapeHtml = (s: unknown) =>
    String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  g.formatShortDateTime = () => "11/09/2026 09:15:42";
  g._screenshotTableEl = () => {};
  g._loadAssetEventsTabFor = () => {};
  g.showRowMenu = () => {};
  (0, eval)(tableSfSrc);
  for (const v of VARS) (0, eval)(varSrc(v));
  for (const f of FNS) (0, eval)(fnSrc(f));
  doc.body.innerHTML = g._assetEventsTabHTML("A1");
  g._wireAssetEventsTab("A1");
});

const th = (id: string) => doc.querySelector(`#asset-view-events-table th[data-col-id="${id}"]`)!;
const hasHandle = (id: string) => !!th(id).querySelector(".sf-resize-handle");

describe("asset Events tab columns", () => {
  it("leaves the resizable columns with a drag handle after TableSF builds the headers", () => {
    expect(th("action").querySelector(".sf-header")).toBeTruthy(); // TableSF ran
    expect(hasHandle("action")).toBe(true);
    expect(hasHandle("resourceType")).toBe(true);
  });

  it("fits Timestamp and Level to their content, with no handle", () => {
    expect(th("timestamp").getAttribute("data-col-fit")).toBe("content");
    expect(th("level").getAttribute("data-col-fit")).toBe("content");
    expect(hasHandle("timestamp")).toBe(false);
    expect(hasHandle("level")).toBe(false);
  });

  it("puts the whole message in the Message cell's hover title", () => {
    const msg = 'Interface "port1" went down <uplink> & stayed down for a very long time';
    doc.getElementById("asset-view-events-tbody")!.innerHTML =
      g._renderAssetEventRow({ timestamp: new Date().toISOString(), level: "warning", action: "x", message: msg }, 0);
    const cell = doc.querySelectorAll("#asset-view-events-tbody td")[4];
    expect(cell.getAttribute("title")).toBe(msg);
    expect(cell.textContent).toBe(msg);
  });

  it("gives an event with no message no empty title", () => {
    doc.getElementById("asset-view-events-tbody")!.innerHTML =
      g._renderAssetEventRow({ timestamp: new Date().toISOString(), level: "info", action: "x" }, 0);
    expect(doc.querySelectorAll("#asset-view-events-tbody td")[4].hasAttribute("title")).toBe(false);
  });
});
