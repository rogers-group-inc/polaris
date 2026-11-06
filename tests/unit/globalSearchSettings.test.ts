/**
 * tests/unit/globalSearchSettings.test.ts — the global search box's gear
 * (`renderGlobalSearch` → `_showSearchSettings` in public/js/app.js).
 *
 * Pinned: the gear sits right of the Ctrl+K hint, the defaults are both
 * monitored and unmonitored with only Active + Maintenance ticked, a change is
 * remembered per USER (the key carries the username), every query sends the
 * filter, and Reset restores the defaults.
 */

import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Window } from "happy-dom";

vi.mock("../../src/db.js", () => ({ prisma: {} }));

const g = globalThis as Record<string, unknown>;
// The page order: the shared theme engine (theme-core.js) runs before app.js.
const APP_SRC =
  readFileSync(resolve(__dirname, "../../public/js/theme-core.js"), "utf8") + "\n" +
  readFileSync(resolve(__dirname, "../../public/js/app.js"), "utf8");
const CSS = readFileSync(resolve(__dirname, "../../public/css/styles.css"), "utf8");

function mount(username: string, store: Record<string, string> = {}) {
  const win = new Window();
  const doc = win.document;
  g.window = win;
  g.document = doc;
  Object.defineProperty(globalThis, "navigator", { value: win.navigator, configurable: true, writable: true });
  g.localStorage = {
    getItem: (k: string) => (k in store ? store[k] : null),
    setItem: (k: string, v: string) => { store[k] = v; },
    removeItem: (k: string) => { delete store[k]; },
  };
  g.fetch = () => Promise.reject(new Error("no network in this test"));
  g.showToast = () => {};
  const query = vi.fn(async (q: string) => ({ query: q, blocks: [], subnets: [], reservations: [], assets: [], ips: [], sites: [], ipsec: [] }));
  g.api = { search: { query } };
  g.escapeHtml = (s: unknown) => String(s ?? "");
  doc.body.innerHTML = '<div class="page-header"><h2>Assets</h2><div class="page-header-actions"></div></div>';
  try { (0, eval)(APP_SRC); } catch (_e) { /* app.js boot wiring touches page-specific DOM */ }
  g.currentUsername = username;
  (g.renderGlobalSearch as () => void)();
  return { win, doc, store, query };
}

function ticked(doc: Document, key: string): string[] {
  return Array.from(doc.querySelectorAll<HTMLInputElement>(`#global-search-settings input[data-pref="${key}"]`))
    .filter((cb) => cb.checked).map((cb) => cb.value);
}

describe("global search — the settings gear", () => {
  it("renders right of the Ctrl+K hint", () => {
    const { doc } = mount("alice");
    const kids = Array.from(doc.querySelector(".global-search")!.children).map((c) => c.className);
    expect(kids.indexOf("global-search-gear")).toBeGreaterThan(kids.indexOf("global-search-kbd"));
    expect(CSS).toMatch(/\.global-search-gear \{[^}]*right: 0\.35rem/);
    expect(CSS).toMatch(/\.global-search-kbd \{[^}]*right: 2\.25rem/);
  });

  it("opens with the defaults: both monitored sides, Active + Maintenance only", () => {
    const { doc } = mount("alice");
    (doc.getElementById("global-search-gear") as HTMLButtonElement).click();
    expect((doc.getElementById("global-search-settings") as HTMLElement).hidden).toBe(false);
    expect(ticked(doc, "monitored")).toEqual(["monitored", "unmonitored"]);
    expect(ticked(doc, "status")).toEqual(["active", "maintenance"]);
  });

  it("remembers a change per user and sends it with the query", async () => {
    const { doc, store, query } = mount("alice");
    (doc.getElementById("global-search-gear") as HTMLButtonElement).click();
    const unmon = doc.querySelector<HTMLInputElement>('#global-search-settings input[value="unmonitored"]')!;
    unmon.checked = false;
    unmon.dispatchEvent(new (g.window as any).Event("change"));
    expect(JSON.parse(store["polaris-prefs-search-alice"])).toEqual({ monitored: ["monitored"], status: ["active", "maintenance"] });
    expect(doc.getElementById("global-search-gear")!.classList.contains("is-custom")).toBe(true);

    await (g._performSearch as (q: string) => Promise<void>)("core");
    expect(query).toHaveBeenLastCalledWith("core", { monitored: ["monitored"], status: ["active", "maintenance"] });
  });

  it("another user on the same browser keeps their own settings", () => {
    const store = { "polaris-prefs-search-alice": JSON.stringify({ monitored: [], status: ["storage"] }) };
    const { doc } = mount("bob", store);
    (doc.getElementById("global-search-gear") as HTMLButtonElement).click();
    expect(ticked(doc, "monitored")).toEqual(["monitored", "unmonitored"]);
    expect(ticked(doc, "status")).toEqual(["active", "maintenance"]);
  });

  it("Reset restores the defaults", () => {
    const store = { "polaris-prefs-search-alice": JSON.stringify({ monitored: [], status: ["decommissioned"] }) };
    const { doc } = mount("alice", store);
    (doc.getElementById("global-search-gear") as HTMLButtonElement).click();
    (doc.getElementById("global-search-settings-reset") as HTMLButtonElement).click();
    expect(JSON.parse(store["polaris-prefs-search-alice"])).toEqual({ monitored: ["monitored", "unmonitored"], status: ["active", "maintenance"] });
    expect(doc.getElementById("global-search-gear")!.classList.contains("is-custom")).toBe(false);
  });
});
