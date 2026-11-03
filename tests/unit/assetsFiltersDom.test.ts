/**
 * tests/unit/assetsFiltersDom.test.ts — DOM smoke for the Assets page's saved
 * filter presets menu (public/js/assets-filters.js).
 *
 * The module is a plain browser script (no exports), so this loads it via eval
 * into a happy-dom Window with the app-shell globals stubbed and a minimal
 * Assets table header — the same idiom as automationsWizardDom.test.ts. It
 * covers the wiring that no server test can see: the menu grouping presets
 * into mine/shared, the delete affordance appearing only where permitted,
 * loading a preset pushing its state into TableSF, the ★ that pins a preset as
 * the active view tab's base filter, and the save modal posting the live table
 * state with the chosen visibility.
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Window } from "happy-dom";

vi.mock("../../src/db.js", () => ({ prisma: {} }));

const g = globalThis as Record<string, unknown>;
let doc: Window["document"];
let win: InstanceType<typeof Window>;

let listResponse: { filters: Record<string, unknown>[] };
let created: Record<string, unknown>[];
let deleted: string[];
let toasts: string[];
let applied: unknown[];
let refreshes: number;
let confirmAnswer = true;
let canWrite = true;
// The view-tabs module (assets-tabs.js) when it's present on the page.
let newTabbed: unknown[];
let noted: unknown[];
let activeTabName = "";
// The active view tab's base filter, as assets-tabs.js would report it.
let based: unknown[];
let unbased: number;
let resets: number;
let activeBase: { id: string; name: string; state: unknown } | null = null;

const STATE_A = { sfFilters: { assetType: ["firewall"] }, sortKey: "hostname", sortDir: "asc" };

const TABLE_HTML =
  '<div class="page-header-actions">' +
    '<button id="btn-saved-filters">Filters</button>' +
    '<div class="btn-dropdown-menu sfl-menu" id="saved-filters-menu"></div>' +
  "</div>" +
  '<div id="assets-table-wrapper"><table><thead><tr>' +
    '<th data-sf-key="hostname"><div class="sf-header"><span class="sf-label">Hostname</span></div></th>' +
    '<th data-sf-key="assetType"><div class="sf-header"><span class="sf-label">Type</span></div></th>' +
  "</tr></thead><tbody id=\"assets-tbody\"></tbody></table></div>";

function fire(sel: string, type = "click") {
  const el = doc.querySelector(sel) as unknown as { dispatchEvent: (e: unknown) => void } | null;
  if (!el) throw new Error(`no element for ${sel}`);
  el.dispatchEvent(new win.Event(type, { bubbles: true }));
}

/** Let the module's awaited fetch + render settle. */
function flush() {
  return new Promise((r) => setTimeout(r, 0));
}

beforeAll(() => {
  win = new Window();
  doc = win.document;
  g.window = win;
  g.document = doc;

  g.escapeHtml = (s: unknown) =>
    String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  g.showToast = (msg: string) => { toasts.push(msg); };
  g.showConfirm = async () => confirmAnswer;
  g.permAtLeast = (_key: string, level: string) => (level === "read" ? true : canWrite);
  g.closeModal = () => { doc.querySelectorAll(".modal").forEach((m) => m.remove()); };
  g.openModal = (title: string, body: string, footer: string) => {
    const overlay = doc.createElement("div");
    overlay.className = "modal";
    overlay.innerHTML = '<div class="modal-body">' + body + '</div><div class="modal-footer">' + footer + "</div>";
    doc.body.appendChild(overlay);
  };
  g.api = {
    savedFilters: {
      list:   async () => listResponse,
      create: async (body: Record<string, unknown>) => { created.push(body); return body; },
      delete: async (id: string) => { deleted.push(id); },
    },
  };
  // assets.js's contributions.
  g._assetsSF = {
    getPrefs: () => ({ sfFilters: { hostname: "nsh" }, sortKey: "hostname", sortDir: "desc" }),
    applyState: (s: unknown) => { applied.push(s); },
    clearFilters: () => { applied.push("cleared"); },
  };
  g.assetsApplyFilterState = () => { refreshes += 1; };

  // assets-tabs.js publishes itself on `window` — the filters module treats its
  // presence as "this page has view tabs" and grows the open-in-new-tab action.
  (win as unknown as Record<string, unknown>).PolarisAssetTabs = {
    openInNewTab: (p: unknown) => { newTabbed.push(p); return true; },
    noteFilterLoaded: (p: unknown) => { noted.push(p); },
    activeTabName: () => activeTabName,
    // Base-filter half of the contract — the menu only offers the ★ when the
    // strip publishes these, so a cached pre-base assets-tabs.js still works.
    activeDefault: () => activeBase,
    setDefaultFilter: (p: unknown) => { based.push(p); return true; },
    clearDefaultFilter: () => { unbased += 1; return true; },
    resetToDefault: () => { resets += 1; return true; },
    refreshDefaultsFromPresets: () => {},
  };

  doc.body.innerHTML = TABLE_HTML;
  const src = readFileSync(resolve(__dirname, "../../public/js/assets-filters.js"), "utf8");
  (0, eval)(src);
  // The module wires itself on DOMContentLoaded.
  doc.dispatchEvent(new win.Event("DOMContentLoaded", { bubbles: true }));
});

beforeEach(() => {
  created = [];
  deleted = [];
  toasts = [];
  applied = [];
  refreshes = 0;
  confirmAnswer = true;
  canWrite = true;
  newTabbed = [];
  noted = [];
  activeTabName = "";
  based = [];
  unbased = 0;
  resets = 0;
  activeBase = null;
  listResponse = {
    filters: [
      { id: "f1", scope: "assets", name: "My firewalls", visibility: "private", ownerName: "me", isOwner: true, state: STATE_A },
      { id: "f2", scope: "assets", name: "Shared APs", visibility: "public", ownerName: "dana", isOwner: false, state: { sfFilters: {} } },
    ],
  };
  doc.querySelectorAll(".modal").forEach((m) => m.remove());
  (doc.getElementById("saved-filters-menu") as unknown as { className: string }).className =
    "btn-dropdown-menu sfl-menu";
});

async function openMenu() {
  fire("#btn-saved-filters");
  await flush();
}

describe("saved filters menu", () => {
  it("groups presets into mine + shared and always offers save/clear", async () => {
    await openMenu();
    const menu = doc.getElementById("saved-filters-menu")!;
    expect(menu.classList.contains("open")).toBe(true);
    expect(menu.querySelector('[data-sfl-act="save"]')).toBeTruthy();
    expect(menu.querySelector('[data-sfl-act="clear"]')).toBeTruthy();
    const headings = Array.from(menu.querySelectorAll(".dropdown-heading")).map((h) => h.textContent);
    expect(headings).toEqual(["My filters", "Shared filters"]);
    expect(menu.querySelectorAll("[data-sfl-load]").length).toBe(2);
    // Someone else's preset shows who published it.
    expect(menu.querySelector('[data-sfl-load="f2"] .sfl-owner')!.textContent).toBe("dana");
    expect(menu.querySelector('[data-sfl-load="f2"] .sfl-badge')!.textContent).toBe("Public");
  });

  it("offers delete only where the server says the caller manages the row (rule 140)", async () => {
    // Fullwrite no longer deletes someone else's OWNED preset: the × follows
    // the server's canManage, not the caller's level.
    await openMenu();
    expect(doc.querySelector('[data-sfl-del="f1"]')).toBeTruthy();
    expect(doc.querySelector('[data-sfl-del="f2"]')).toBeFalsy();

    // An OWNERLESS preset is a fullwrite holder's to manage.
    (listResponse.filters[1] as Record<string, unknown>).canManage = true;
    (listResponse.filters[1] as Record<string, unknown>).ownerKind = "none";
    fire("#btn-saved-filters");             // close
    await openMenu();
    expect(doc.querySelector('[data-sfl-del="f2"]')).toBeTruthy();
  });

  it("shows an empty state when nothing is saved", async () => {
    listResponse = { filters: [] };
    await openMenu();
    expect(doc.querySelector("#saved-filters-menu .sfl-empty")!.textContent).toContain("No saved filters");
  });

  it("loading a preset pushes its state into the table, re-fetches, and tells the tab where it came from", async () => {
    await openMenu();
    fire('[data-sfl-load="f1"]');
    await flush();
    expect(applied).toEqual([STATE_A]);
    expect(refreshes).toBe(1);
    expect((noted[0] as { id: string }).id).toBe("f1");
    expect(newTabbed).toEqual([]);                        // current tab, not a new one
    expect(doc.getElementById("saved-filters-menu")!.classList.contains("open")).toBe(false);
  });

  it("the ⧉ action opens the preset in a NEW tab and leaves the current one alone", async () => {
    await openMenu();
    expect(doc.querySelectorAll("[data-sfl-newtab]").length).toBe(2);
    fire('[data-sfl-newtab="f2"]');
    await flush();
    expect((newTabbed[0] as { id: string }).id).toBe("f2");
    expect(applied).toEqual([]);                          // the active tab is untouched
    expect(refreshes).toBe(0);
  });

  it("Clear active filters clears the table without touching the server", async () => {
    await openMenu();
    fire('[data-sfl-act="clear"]');
    await flush();
    expect(applied).toEqual(["cleared"]);
    expect(refreshes).toBe(1);
    expect(created).toEqual([]);
  });

  it("deletes after a confirm, and not when the operator declines", async () => {
    await openMenu();
    confirmAnswer = false;
    fire('[data-sfl-del="f1"]');
    await flush();
    expect(deleted).toEqual([]);

    confirmAnswer = true;
    fire('[data-sfl-del="f1"]');
    await flush();
    expect(deleted).toEqual(["f1"]);
  });
});

describe("base filter (★)", () => {
  it("offers the ★ on every preset and pins the one clicked as the tab's base", async () => {
    await openMenu();
    expect(doc.querySelectorAll("[data-sfl-default]").length).toBe(2);
    fire('[data-sfl-default="f1"]');
    await flush();
    expect((based[0] as { id: string }).id).toBe("f1");
    // Pinning applies the base itself (assets-tabs.js drives the table), so the
    // menu must not also push the state — that would fetch twice.
    expect(applied).toEqual([]);
    expect(toasts.some((t) => t.includes("My firewalls"))).toBe(true);
  });

  it("marks the current base and turns its ★ into an unpin", async () => {
    activeBase = { id: "f1", name: "My firewalls", state: STATE_A };
    await openMenu();
    const star = doc.querySelector('[data-sfl-default="f1"]')!;
    expect(star.classList.contains("active")).toBe(true);
    expect(star.getAttribute("aria-pressed")).toBe("true");
    expect(doc.querySelector('[data-sfl-default="f2"]')!.classList.contains("active")).toBe(false);
    expect(doc.querySelector(".sfl-row-base")).toBeTruthy();

    fire('[data-sfl-default="f1"]');
    await flush();
    expect(unbased).toBe(1);
    expect(based).toEqual([]);
  });

  it("grows Reset + Remove entries and renames Clear while a base is set", async () => {
    await openMenu();
    let menu = doc.getElementById("saved-filters-menu")!;
    expect(menu.querySelector('[data-sfl-act="reset"]')).toBeFalsy();
    expect(menu.querySelector('[data-sfl-act="unbase"]')).toBeFalsy();
    expect(menu.querySelector('[data-sfl-act="clear"]')!.textContent).toBe("Clear active filters");

    activeBase = { id: "f1", name: "My firewalls", state: STATE_A };
    fire("#btn-saved-filters");                            // close
    await openMenu();
    menu = doc.getElementById("saved-filters-menu")!;
    expect(menu.querySelector('[data-sfl-act="reset"]')!.textContent).toContain("My firewalls");
    expect(menu.querySelector('[data-sfl-act="clear"]')!.textContent).toBe("Clear all filters");

    fire('[data-sfl-act="reset"]');
    await flush();
    expect(resets).toBe(1);
    expect(applied).toEqual([]);                           // the tab module drives it

    fire("#btn-saved-filters");
    await openMenu();
    fire('[data-sfl-act="unbase"]');
    await flush();
    expect(unbased).toBe(1);
  });

  it("Clear all filters still clears the live view, base or not", async () => {
    activeBase = { id: "f1", name: "My firewalls", state: STATE_A };
    await openMenu();
    fire('[data-sfl-act="clear"]');
    await flush();
    expect(applied).toEqual(["cleared"]);
    expect(refreshes).toBe(1);
    expect(unbased).toBe(0);                               // clearing is not unpinning
  });
});

describe("save modal", () => {
  async function openSaveModal() {
    await openMenu();
    fire('[data-sfl-act="save"]');
    await flush();
  }

  it("previews the live table state and posts it with the chosen visibility", async () => {
    await openSaveModal();
    // The preview describes the CURRENT table, not a saved preset.
    expect(doc.querySelector(".sfl-preview")!.textContent).toBe("Hostname contains nsh · sorted by Hostname ↓");

    (doc.getElementById("sfl-name") as unknown as { value: string }).value = "Down gear";
    (doc.querySelector('input[name="sfl-vis"][value="public"]') as unknown as { checked: boolean }).checked = true;
    fire("#sfl-save");
    await flush();

    expect(created).toEqual([{
      scope: "assets",
      name: "Down gear",
      visibility: "public",
      state: { sfFilters: { hostname: "nsh" }, sortKey: "hostname", sortDir: "desc" },
    }]);
    expect(toasts.some((t) => t.includes("Down gear"))).toBe(true);
  });

  it("seeds the name from a named tab, but never from a default tab name", async () => {
    activeTabName = "Down switches";
    await openSaveModal();
    expect((doc.getElementById("sfl-name") as unknown as { value: string }).value).toBe("Down switches");

    doc.querySelectorAll(".modal").forEach((m) => m.remove());
    activeTabName = "Tab 2";
    await openSaveModal();
    expect((doc.getElementById("sfl-name") as unknown as { value: string }).value).toBe("");
  });

  it("refuses an empty name", async () => {
    await openSaveModal();
    fire("#sfl-save");
    await flush();
    expect(created).toEqual([]);
    expect(toasts).toContain("Name is required");
  });

  it("disables the Public option without asset write access", async () => {
    canWrite = false;
    await openSaveModal();
    const pub = doc.querySelector('input[name="sfl-vis"][value="public"]') as unknown as { disabled: boolean };
    expect(pub.disabled).toBe(true);
  });

  it("confirms before overwriting one of your own names", async () => {
    await openSaveModal();
    confirmAnswer = false;
    (doc.getElementById("sfl-name") as unknown as { value: string }).value = "my firewalls"; // case-insensitive clash
    fire("#sfl-save");
    await flush();
    expect(created).toEqual([]);
  });
});
