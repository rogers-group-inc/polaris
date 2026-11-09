/**
 * tests/unit/globalSearchRecent.test.ts — what the global search box shows
 * when it is focused empty (`_showSearchShortcutHints` / `openSearchResult`
 * in public/js/app.js).
 *
 * Pinned: picking a result clears the results it came from, so the next
 * focus opens on the shortcuts — not on the previous search's hits (the bug
 * this replaced). Above the shortcuts sit this tab's last five picked
 * searches, newest first, a repeat moved up rather than listed twice, kept in
 * sessionStorage per user; clicking one re-runs it.
 */

import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Window, type HTMLInputElement, type HTMLElement } from "happy-dom";

vi.mock("../../src/db.js", () => ({ prisma: {} }));

const g = globalThis as Record<string, unknown>;
// The page order: the shared theme engine (theme-core.js) runs before app.js.
const APP_SRC =
  readFileSync(resolve(__dirname, "../../public/js/theme-core.js"), "utf8") + "\n" +
  readFileSync(resolve(__dirname, "../../public/js/app.js"), "utf8");

function storage(store: Record<string, string>) {
  return {
    getItem: (k: string) => (k in store ? store[k] : null),
    setItem: (k: string, v: string) => { store[k] = v; },
    removeItem: (k: string) => { delete store[k]; },
  };
}

function mount(username: string, session: Record<string, string> = {}) {
  const win = new Window();
  const doc = win.document;
  g.window = win;
  g.document = doc;
  Object.defineProperty(globalThis, "navigator", { value: win.navigator, configurable: true, writable: true });
  g.localStorage = storage({});
  g.sessionStorage = storage(session);
  g.fetch = () => Promise.reject(new Error("no network in this test"));
  g.showToast = () => {};
  // One asset hit for any query. Its type resolves to no target, so opening
  // it exercises openSearchResult's bookkeeping without navigating.
  const query = vi.fn(async (q: string) => ({
    query: q, blocks: [], subnets: [], reservations: [], ips: [], sites: [], ipsec: [],
    assets: [{ type: "nowhere", id: "A1", title: "CORE-SW-1" }],
  }));
  g.api = { search: { query } };
  g.escapeHtml = (s: unknown) => String(s ?? "");
  doc.body.innerHTML = '<div class="page-header"><h2>Assets</h2><div class="page-header-actions"></div></div>';
  try { (0, eval)(APP_SRC); } catch { /* app.js boot wiring touches page-specific DOM */ }
  g.currentUsername = username;
  (g.renderGlobalSearch as () => void)();
  const input = doc.getElementById("global-search-input") as HTMLInputElement;
  const dropdown = doc.getElementById("global-search-dropdown") as HTMLElement;
  return { win, doc, session, query, input, dropdown };
}

/** Type `q`, let the search land, and pick its first hit. */
async function searchAndPick(m: ReturnType<typeof mount>, q: string) {
  m.input.value = q;
  await (g._performSearch as (q: string) => Promise<void>)(q);
  (m.dropdown.querySelector(".gs-item") as HTMLElement).click();
}

function focus(m: ReturnType<typeof mount>) {
  m.input.blur();
  m.input.dispatchEvent(new (g.window as any).Event("focus"));
}

const recent = (m: ReturnType<typeof mount>) =>
  Array.from(m.dropdown.querySelectorAll(".gs-recent")).map((el) => el.textContent);

describe("global search — focused empty", () => {
  it("after picking a result, the next focus shows the shortcuts, not the old results", async () => {
    const m = mount("alice");
    await searchAndPick(m, "core");
    expect(m.input.value).toBe("");
    focus(m);
    expect(m.dropdown.style.display).toBe("block");
    expect(m.dropdown.querySelector(".gs-item")).toBeNull();
    expect(m.dropdown.querySelector(".gs-hint-group")).not.toBeNull();
  });

  it("text still in the box brings its results back on focus", async () => {
    const m = mount("alice");
    m.input.value = "core";
    await (g._performSearch as (q: string) => Promise<void>)("core");
    (g._hideSearchDropdown as () => void)();
    focus(m);
    expect(m.dropdown.querySelector(".gs-item")).not.toBeNull();
  });

  it("lists the last five picked searches above the shortcuts, newest first, a repeat moved up", async () => {
    const m = mount("alice");
    for (const q of ["one", "two", "three", "four", "five", "six", "Three"]) await searchAndPick(m, q);
    focus(m);
    expect(recent(m)).toEqual(["Three", "six", "five", "four", "two"]);
    const groups = Array.from(m.dropdown.querySelectorAll(".gs-group")).map((el) => el.className);
    expect(groups[0]).toContain("gs-recent-group");
    expect(groups[1]).toContain("gs-hint-group");
  });

  it("shows no recent group before anything was picked — a typed-and-abandoned query is not recorded", async () => {
    const m = mount("alice");
    m.input.value = "abandoned";
    await (g._performSearch as (q: string) => Promise<void>)("abandoned");
    m.input.value = "";
    focus(m);
    expect(m.dropdown.querySelector(".gs-recent-group")).toBeNull();
  });

  it("is kept per user in this tab's sessionStorage", async () => {
    const m = mount("alice");
    await searchAndPick(m, "a:printer");
    expect(JSON.parse(m.session["polaris-search-recent-alice"])).toEqual(["a:printer"]);
    const other = mount("bob", m.session);
    focus(other);
    expect(recent(other)).toEqual([]);
  });

  it("clicking a recent search fills the box and runs it", async () => {
    const m = mount("alice", { "polaris-search-recent-alice": JSON.stringify(["tag:plant"]) });
    focus(m);
    (m.dropdown.querySelector(".gs-recent") as HTMLElement).click();
    expect(m.input.value).toBe("tag:plant");
    expect(m.query).toHaveBeenLastCalledWith("tag:plant", expect.any(Object));
  });
});
