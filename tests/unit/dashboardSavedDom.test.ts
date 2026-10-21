/**
 * tests/unit/dashboardSavedDom.test.ts — DOM smoke for the "Dashboards ▾" menu
 * (public/js/dashboard-saved.js).
 *
 * The module is a plain browser script (no exports), so this loads it via eval
 * into a happy-dom Window with the app-shell globals stubbed — the
 * assetsFiltersDom.test.ts idiom. What no server test can see is that ONE file
 * renders two different menus off one list, and that the wallboard half never
 * offers a way to write:
 *
 *   signed in  — "Save this dashboard…" + My/Shared sections, load = new TAB
 *                (a copy), delete only where permitted.
 *   wallboard  — "My layout (this browser)" + Published section, load = VIEW
 *                (pinned in localStorage), and NO save/delete anywhere.
 *
 * window.PolarisDashboard (dashboard.js's seam) is stubbed, so what's asserted
 * is the contract between the two files, not the canvas itself.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Window } from "happy-dom";

vi.mock("../../src/db.js", () => ({ prisma: {} }));

const SRC = readFileSync(resolve(__dirname, "../../public/js/dashboard-saved.js"), "utf8");
const PORTABILITY_SRC = readFileSync(resolve(__dirname, "../../public/js/dashboard-portability.js"), "utf8");
const g = globalThis as Record<string, unknown>;

const HEADER_HTML =
  '<div class="page-header-actions">' +
    '<button id="btn-saved-dashboards">Dashboards</button>' +
    '<div class="btn-dropdown-menu sfl-menu" id="saved-dashboards-menu"></div>' +
  "</div>";

const LAYOUT = { columns: [{ id: "c1", width: 6, widgets: [{ id: "w1", type: "statusSummary", height: 1, config: {} }] }] };

const ROWS = [
  { id: "d1", name: "My NOC", visibility: "private", ownerName: "me", isOwner: true, widgetCount: 3, layout: LAYOUT, updatedAt: "2026-09-01T00:00:00.000Z" },
  { id: "d2", name: "Shared NOC", visibility: "public", ownerName: "dana", isOwner: false, widgetCount: 7, layout: LAYOUT, updatedAt: "2026-09-02T00:00:00.000Z" },
];

interface Harness {
  win: InstanceType<typeof Window>;
  doc: Window["document"];
  menu: () => Element;
  open: () => Promise<void>;
  created: Record<string, unknown>[];
  deleted: string[];
  toasts: string[];
  viewed: unknown[];
  tabbed: unknown[];
  cleared: number;
  store: Record<string, string>;
}

/**
 * Fresh Window + globals + eval per case. The module keys its whole behavior
 * off window.POLARIS_DASH_LOCAL at call time, so the two surfaces are two
 * boots rather than a flag flipped mid-test.
 */
function boot(opts: { wallboard?: boolean; canPublish?: boolean; canDeleteAny?: boolean; pinned?: string; rows?: unknown[]; portable?: boolean; editing?: boolean } = {}): Harness {
  const win = new Window();
  const doc = win.document;
  const created: Record<string, unknown>[] = [];
  const deleted: string[] = [];
  const toasts: string[] = [];
  const viewed: unknown[] = [];
  const tabbed: unknown[] = [];
  const store: Record<string, string> = {};
  let cleared = 0;
  let published: string | null = opts.pinned ?? null;

  g.window = win;
  g.document = doc;
  (win as unknown as Record<string, unknown>).POLARIS_DASH_LOCAL = opts.wallboard ? true : undefined;

  g.escapeHtml = (s: unknown) =>
    String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  g.showToast = (msg: string) => { toasts.push(msg); };
  g.showConfirm = async () => true;
  g.permAtLeast = (_key: string, level: string) => {
    if (level === "read") return true;
    if (level === "write") return opts.canPublish !== false;
    return !!opts.canDeleteAny;
  };
  g.closeModal = () => { doc.querySelectorAll(".modal").forEach((m) => m.remove()); };
  g.openModal = (_t: string, body: string, footer: string) => {
    const overlay = doc.createElement("div");
    overlay.className = "modal";
    overlay.innerHTML = '<div class="modal-body">' + body + '</div><div class="modal-footer">' + footer + "</div>";
    doc.body.appendChild(overlay);
  };
  g.api = {
    savedDashboards: {
      list:   async () => ({ dashboards: opts.rows ?? ROWS }),
      get:    async (id: string) => (opts.rows ?? ROWS).find((r) => (r as { id: string }).id === id),
      create: async (body: Record<string, unknown>) => { created.push(body); return body; },
      delete: async (id: string) => { deleted.push(id); },
    },
  };
  // dashboard.js's seam. Customizing by default: the menu only shows then
  // (or while a published dashboard is on screen).
  (win as unknown as Record<string, unknown>).PolarisDashboard = {
    isWallboard: () => !!opts.wallboard,
    isEditing: () => opts.editing !== false,
    snapshot: () => ({ name: "Dashboard 2", layout: LAYOUT }),
    widgetCount: () => 4,
    publishedId: () => published,
    loadAsNewTab: (row: unknown) => { tabbed.push(row); return true; },
    viewPublished: (row: unknown) => { viewed.push(row); published = (row as { id: string }).id; return true; },
    clearPublished: () => { cleared += 1; published = null; return true; },
  };
  // localStorage — the module reads the bare global, and happy-dom's own
  // Window.localStorage is getter-only, so stub the GLOBAL. An explicit store
  // also keeps the pin assertions independent of happy-dom's implementation.
  g.localStorage = {
    getItem: (k: string) => (k in store ? store[k] : null),
    setItem: (k: string, v: string) => { store[k] = String(v); },
    removeItem: (k: string) => { delete store[k]; },
  };
  if (opts.pinned) store["polaris-dash-published"] = opts.pinned;

  doc.body.innerHTML = HEADER_HTML;
  if (opts.portable) {
    (win as unknown as Record<string, unknown>).PolarisWidgets = { getByType: (t: string) => (t === "statusSummary" ? {} : null) };
    (0, eval)(PORTABILITY_SRC);
  }
  (0, eval)(SRC);
  doc.dispatchEvent(new win.Event("DOMContentLoaded", { bubbles: true }));

  const menu = () => doc.getElementById("saved-dashboards-menu")!;
  async function open() {
    const btn = doc.getElementById("btn-saved-dashboards")! as unknown as { dispatchEvent: (e: unknown) => void };
    btn.dispatchEvent(new win.Event("click", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 0));
  }
  function click(sel: string) {
    const el = menu().querySelector(sel) as unknown as { dispatchEvent: (e: unknown) => void } | null;
    if (!el) throw new Error(`no element for ${sel}`);
    el.dispatchEvent(new win.Event("click", { bubbles: true }));
  }
  return { win, doc, menu, open, created, deleted, toasts, viewed, tabbed, get cleared() { return cleared; }, store, click } as unknown as Harness;
}

type H = Harness & { click: (sel: string) => void };

beforeEach(() => {
  delete g.PolarisSavedDashboards;
});

describe("Dashboards menu — signed in", () => {
  it("offers save and groups rows into mine + shared", async () => {
    const h = boot() as H;
    await h.open();
    expect(h.menu().classList.contains("open")).toBe(true);
    expect(h.menu().querySelector('[data-sd-act="save"]')).toBeTruthy();
    const headings = Array.from(h.menu().querySelectorAll(".dropdown-heading")).map((e) => e.textContent);
    expect(headings).toEqual(["My dashboards", "Shared dashboards"]);
    // Someone else's row names its publisher and carries the Public badge.
    const shared = h.menu().querySelector('[data-sd-load="d2"]')!;
    expect(shared.querySelector(".sfl-owner")!.textContent).toBe("dana");
    expect(shared.querySelector(".sfl-badge")).toBeTruthy();
  });

  it("loads a row as a new TAB — a copy, never a live view", async () => {
    const h = boot() as H;
    await h.open();
    h.click('[data-sd-load="d2"]');
    expect(h.tabbed).toHaveLength(1);
    expect((h.tabbed[0] as { id: string }).id).toBe("d2");
    expect(h.viewed).toHaveLength(0);
  });

  it("shows the delete × on your own row and on someone else's only with fullwrite", async () => {
    const own = boot() as H;
    await own.open();
    expect(own.menu().querySelector('[data-sd-del="d1"]')).toBeTruthy();
    expect(own.menu().querySelector('[data-sd-del="d2"]')).toBeNull();

    const admin = boot({ canDeleteAny: true }) as H;
    await admin.open();
    expect(admin.menu().querySelector('[data-sd-del="d2"]')).toBeTruthy();
  });

  it("posts the canvas snapshot with the chosen visibility", async () => {
    const h = boot() as H;
    await h.open();
    h.click('[data-sd-act="save"]');
    const name = h.doc.getElementById("sd-name")! as unknown as { value: string };
    // "Dashboard 2" is an untouched default name, so it is NOT seeded.
    expect(name.value).toBe("");
    name.value = "NOC overview";
    (h.doc.querySelector('input[name="sd-vis"][value="public"]') as unknown as { checked: boolean }).checked = true;
    (h.doc.getElementById("sd-save")! as unknown as { dispatchEvent: (e: unknown) => void })
      .dispatchEvent(new h.win.Event("click", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 0));
    expect(h.created).toHaveLength(1);
    expect(h.created[0]).toMatchObject({ name: "NOC overview", visibility: "public" });
    expect((h.created[0].layout as typeof LAYOUT).columns).toHaveLength(1);
  });

  it("disables the Public radio without write access, and says why", async () => {
    const h = boot({ canPublish: false }) as H;
    await h.open();
    h.click('[data-sd-act="save"]');
    const pub = h.doc.querySelector('input[name="sd-vis"][value="public"]')!;
    expect(pub.hasAttribute("disabled")).toBe(true);
    expect(h.doc.querySelector(".modal")!.textContent).toContain("Requires saved-dashboard write access");
  });

  it("shows only while customizing or viewing a published dashboard", async () => {
    const view = boot({ editing: false }) as H;
    const btn = view.doc.getElementById("btn-saved-dashboards")!;
    expect(btn.hasAttribute("hidden")).toBe(true);
    // A stale click while hidden opens nothing.
    await view.open();
    expect(view.menu().classList.contains("open")).toBe(false);

    // Customize Page: dashboard.js announces the mode change.
    const seam = (view.win as unknown as { PolarisDashboard: { isEditing: () => boolean } }).PolarisDashboard;
    seam.isEditing = () => true;
    view.doc.dispatchEvent(new view.win.CustomEvent("polaris:dashboard-mode"));
    expect(btn.hasAttribute("hidden")).toBe(false);

    // Viewing a published dashboard: no Customize there, so the menu is the
    // only way back to the viewer's own layout.
    const pinned = boot({ editing: false, pinned: "d2" }) as H;
    expect(pinned.doc.getElementById("btn-saved-dashboards")!.hasAttribute("hidden")).toBe(false);
  });

  it("hides the whole menu for a role with no access at all", () => {
    const win = new Window();
    g.window = win;
    g.document = win.document;
    (win as unknown as Record<string, unknown>).POLARIS_DASH_LOCAL = undefined;
    g.permAtLeast = () => false;
    g.api = { savedDashboards: { list: async () => ({ dashboards: [] }) } };
    win.document.body.innerHTML = HEADER_HTML;
    (0, eval)(SRC);
    win.document.dispatchEvent(new win.Event("DOMContentLoaded", { bubbles: true }));
    const wrap = win.document.querySelector(".btn-dropdown-wrap");
    // No wrapper in this fixture, so the button itself is what gets hidden.
    expect(wrap ? wrap.hasAttribute("hidden") : win.document.getElementById("btn-saved-dashboards")!.hasAttribute("hidden")).toBe(true);
  });

  // The 2026-10-16 bug: the gate read the CACHED user at DOMContentLoaded
  // (empty on a first login, stale after a role edit), hid the wrapper and
  // returned before binding the click — and the CSS left the hidden wrapper on
  // screen, so a role holding read got a button that did nothing.
  it("re-checks when the authoritative user lands, and the button then opens the menu", async () => {
    const win = new Window();
    g.window = win;
    g.document = win.document;
    (win as unknown as Record<string, unknown>).POLARIS_DASH_LOCAL = undefined;
    let canRead = false;            // cold cache: no permissions yet
    g.permAtLeast = () => canRead;
    g.escapeHtml = (s: unknown) => String(s ?? "");
    let listed = 0;
    g.api = { savedDashboards: { list: async () => { listed++; return { dashboards: [] }; } } };
    win.document.body.innerHTML =
      '<div class="btn-dropdown-wrap">' + HEADER_HTML + "</div>";
    (0, eval)(SRC);
    win.document.dispatchEvent(new win.Event("DOMContentLoaded", { bubbles: true }));
    const wrap = win.document.querySelector(".btn-dropdown-wrap")!;
    const btn = win.document.getElementById("btn-saved-dashboards")! as unknown as HTMLElement;
    const menu = win.document.getElementById("saved-dashboards-menu")!;
    expect(wrap.hasAttribute("hidden")).toBe(true);

    // /auth/me resolves: the role does hold savedDashboards:read.
    canRead = true;
    win.document.dispatchEvent(new win.CustomEvent("polaris:user-loaded"));
    expect(wrap.hasAttribute("hidden")).toBe(false);

    btn.click();
    await new Promise((r) => setTimeout(r, 0));
    expect(menu.classList.contains("open")).toBe(true);
    expect(listed).toBeGreaterThan(0);
  });

  it("a hidden dropdown wrapper is actually hidden — inline-block must not beat [hidden]", () => {
    const css = readFileSync(resolve(__dirname, "../../public/css/styles.css"), "utf8");
    expect(css).toMatch(/\.btn-dropdown-wrap\[hidden\]\s*\{\s*display:\s*none/);
  });
});

describe("app.js announces the authoritative user", () => {
  it("dispatches polaris:user-loaded after fetchCurrentUser", () => {
    const app = readFileSync(resolve(__dirname, "../../public/js/app.js"), "utf8");
    const fetchAt = app.indexOf("await fetchCurrentUser();");
    const evtAt = app.indexOf('new CustomEvent("polaris:user-loaded")');
    expect(fetchAt).toBeGreaterThan(-1);
    expect(evtAt).toBeGreaterThan(fetchAt);
  });
});

describe("Dashboards menu — Dash wallboard", () => {
  it("offers My layout + published rows, and no way to save or delete", async () => {
    const h = boot({ wallboard: true }) as H;
    await h.open();
    expect(h.menu().querySelector('[data-sd-act="save"]')).toBeNull();
    expect(h.menu().querySelector("[data-sd-del]")).toBeNull();
    expect(h.menu().querySelector('[data-sd-act="local"]')).toBeTruthy();
    const headings = Array.from(h.menu().querySelectorAll(".dropdown-heading")).map((e) => e.textContent);
    expect(headings).toEqual(["Published dashboards"]);
  });

  it("VIEWS a published dashboard and pins the choice for the next boot", async () => {
    const h = boot({ wallboard: true }) as H;
    await h.open();
    h.click('[data-sd-load="d2"]');
    expect(h.viewed).toHaveLength(1);
    expect(h.tabbed).toHaveLength(0);
    expect(h.store["polaris-dash-published"]).toBe("d2");
    // The header button names what is on screen — a wallboard is read from
    // across a room, and the menu is shut.
    expect(h.doc.getElementById("btn-saved-dashboards")!.textContent).toContain("Shared NOC");
  });

  it("goes back to the browser's own layout and drops the pin", async () => {
    const h = boot({ wallboard: true, pinned: "d2" }) as H;
    await h.open();
    h.click('[data-sd-act="local"]');
    expect(h.cleared).toBe(1);
    expect(h.store["polaris-dash-published"]).toBeUndefined();
  });

  it("restorePinned re-shows the pinned dashboard at boot", async () => {
    const h = boot({ wallboard: true, pinned: "d1" }) as H;
    const api = (h.win as unknown as Record<string, unknown>).PolarisSavedDashboards as { restorePinned: () => Promise<boolean> }
      ?? (g.PolarisSavedDashboards as { restorePinned: () => Promise<boolean> });
    expect(await api.restorePinned()).toBe(true);
    expect((h.viewed[0] as { id: string }).id).toBe("d1");
  });

  it("restorePinned drops a pin whose dashboard has gone", async () => {
    const h = boot({ wallboard: true, pinned: "gone", rows: [] }) as H;
    const api = (h.win as unknown as Record<string, unknown>).PolarisSavedDashboards as { restorePinned: () => Promise<boolean> };
    expect(await api.restorePinned()).toBe(false);
    expect(h.viewed).toHaveLength(0);
  });
});

describe("Dashboards menu — export / import a tab as a file", () => {
  it("offers Export and Import only where dashboard-portability.js is loaded, and never on the wallboard", async () => {
    const without = boot() as H;
    await without.open();
    expect(without.menu().querySelector('[data-sd-act="export"]')).toBeNull();

    const h = boot({ portable: true }) as H;
    await h.open();
    expect(h.menu().querySelector('[data-sd-act="export"]')).toBeTruthy();
    expect(h.menu().querySelector('[data-sd-act="import"]')).toBeTruthy();

    const wall = boot({ wallboard: true, portable: true }) as H;
    await wall.open();
    expect(wall.menu().querySelector('[data-sd-act="export"]')).toBeNull();
    expect(wall.menu().querySelector('[data-sd-act="import"]')).toBeNull();
  });

  it("downloads the tab on screen as <name>.dashboard.json", async () => {
    const h = boot({ portable: true }) as H;
    const blobs: Blob[] = [];
    const create = vi.spyOn(URL, "createObjectURL").mockImplementation((b) => { blobs.push(b as Blob); return "blob:x"; });
    const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    let downloaded = "";
    const proto = (h.win as unknown as { HTMLAnchorElement: { prototype: { click: () => void } } }).HTMLAnchorElement.prototype;
    const click = vi.spyOn(proto, "click").mockImplementation(function (this: { download: string }) { downloaded = this.download; });
    try {
      await h.open();
      h.click('[data-sd-act="export"]');
      expect(downloaded).toBe("Dashboard 2.dashboard.json");
      const body = JSON.parse(await blobs[0].text());
      expect(body.polarisDashboard).toBe(1);
      expect(body.columns[0].widgets[0]).toEqual({ type: "statusSummary", height: 1, config: {} });
      expect(body.columns[0].id).toBeUndefined();
    } finally {
      create.mockRestore(); revoke.mockRestore(); click.mockRestore();
    }
  });

  async function importText(h: H, text: string, name = "Core.dashboard.json") {
    await h.open();
    const proto = (h.win as unknown as { HTMLInputElement: { prototype: { click: () => void } } }).HTMLInputElement.prototype;
    const click = vi.spyOn(proto, "click").mockImplementation(() => {});
    try { h.click('[data-sd-act="import"]'); } finally { click.mockRestore(); }
    const input = h.doc.querySelector('input[type="file"]')!;
    Object.defineProperty(input, "files", { value: [{ name, size: text.length, text: async () => text }] });
    input.dispatchEvent(new h.win.Event("change"));
    await new Promise((r) => setTimeout(r, 0));
  }

  it("imports a file as a new TAB, dropping and reporting widgets this install lacks", async () => {
    const h = boot({ portable: true }) as H;
    await importText(h, JSON.stringify({
      polarisDashboard: 1,
      name: "Core",
      columns: [{ width: 6, widgets: [{ type: "statusSummary", height: 1, config: {} }, { type: "fromTheFuture" }] }],
    }));
    expect(h.tabbed).toHaveLength(1);
    const row = h.tabbed[0] as { name: string; layout: typeof LAYOUT };
    expect(row.name).toBe("Core");
    expect(row.layout.columns[0].widgets.map((w) => w.type)).toEqual(["statusSummary"]);
    expect(h.toasts.at(-1)).toContain("1 unknown widget skipped");
  });

  it("refuses a file with nothing this install can show, without adding a tab", async () => {
    const h = boot({ portable: true }) as H;
    await importText(h, JSON.stringify({ name: "X", columns: [{ widgets: [{ type: "fromTheFuture" }] }] }));
    expect(h.tabbed).toHaveLength(0);
    expect(h.toasts.at(-1)).toContain("None of that file's widgets");
  });

  it("refuses a file that isn't a dashboard", async () => {
    const h = boot({ portable: true }) as H;
    await importText(h, '{"trigger":{}}');
    expect(h.tabbed).toHaveLength(0);
    expect(h.toasts.at(-1)).toContain("no columns");
  });
});
