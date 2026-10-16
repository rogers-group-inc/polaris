/**
 * tests/unit/helpButton.test.ts — the page-header Help button
 * (`_renderHelpButton` / `_currentWikiPage` in public/js/app.js).
 *
 * Help left the account menu on 2026-10-16 for a button of its own, left of
 * the user badge, that opens the wiki page for the page (and, on a tabbed
 * page, the tab) it was clicked on. Pinned here: the page → wiki-page table
 * names pages that exist under docs/wiki/, the tab override, the fallback to
 * the wiki's Home, and noopener on the new tab.
 *
 * @vitest-environment happy-dom
 */

import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const APP_JS = readFileSync(join(process.cwd(), "public", "js", "app.js"), "utf-8");
const g = globalThis as Record<string, any>;

function slice(startMarker: string, endMarker: string): string {
  const a = APP_JS.indexOf(startMarker);
  const b = APP_JS.indexOf(endMarker, a);
  if (a < 0 || b < 0) throw new Error("app.js: cannot find " + startMarker);
  return APP_JS.slice(a, b);
}

let opened: { url: string; target: string; features: string }[];

beforeEach(() => {
  opened = [];
  g.ICONS = { help: "<svg></svg>" };
  g.window.open = (url: string, target: string, features: string) => { opened.push({ url, target, features }); return null; };
  (0, eval)(slice('var WIKI_URL = "', "function openUserMenu("));
  document.body.innerHTML =
    '<div class="page-header"><h2>T</h2><div class="page-header-actions"><button class="user-badge">u</button></div></div>';
});

function at(path: string) {
  history.replaceState(null, "", path);
}
function click() {
  const header = document.querySelector(".page-header-actions")!;
  g._renderHelpButton(header, header.querySelector(".user-badge"));
  (document.querySelector(".page-help-btn") as HTMLButtonElement).click();
  return opened[opened.length - 1];
}

describe("Help button", () => {
  it("renders left of the account badge, as an icon button", () => {
    at("/assets.html");
    const header = document.querySelector(".page-header-actions")!;
    g._renderHelpButton(header, header.querySelector(".user-badge"));
    const kids = [...header.children].map((c) => c.className);
    expect(kids[0]).toContain("page-help-btn");
    expect(kids[1]).toContain("user-badge");
    expect(header.querySelector(".page-help-btn")!.className).toContain("btn-icon-only");
  });

  it("opens the wiki page for the page it is on, in a new tab with noopener", () => {
    at("/assets.html");
    expect(click()).toEqual({ url: g.WIKI_URL + "/Assets", target: "_blank", features: "noopener" });
    at("/server-settings.html");
    expect(click().url).toBe(g.WIKI_URL + "/Server-Settings");
    at("/");
    expect(click().url).toBe(g.WIKI_URL + "/Dashboard");
  });

  it("takes the open tab's page on a tabbed page", () => {
    at("/automations.html");
    document.body.insertAdjacentHTML("beforeend",
      '<div class="table-head-row"><button class="page-tab active" data-tab="delivery">Delivery</button></div>');
    expect(click().url).toBe(g.WIKI_URL + "/Delivery-Channels");
  });

  it("falls back to the wiki's Home for a page it does not know", () => {
    at("/nowhere.html");
    expect(click().url).toBe(g.WIKI_URL);
  });

  it("only names wiki pages that exist", () => {
    const names = new Set<string>([
      ...Object.values(g.WIKI_PAGE_FOR as Record<string, string>),
      ...Object.values(g.WIKI_PAGE_FOR_TAB as Record<string, Record<string, string>>).flatMap((t) => Object.values(t)),
    ]);
    for (const n of names) {
      expect(existsSync(join(process.cwd(), "docs", "wiki", n + ".md")), n).toBe(true);
    }
  });
});
