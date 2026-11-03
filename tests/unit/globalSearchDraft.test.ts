/**
 * tests/unit/globalSearchDraft.test.ts — an unfinished global search survives
 * clicking away and a page load in the same tab (`saveSearchDraft` /
 * `_restoreSearchDraft` in public/js/app.js), and Ctrl+A in the box is left
 * to the browser so a restored query can be selected and overwritten.
 *
 * "Page load" is a second mount sharing the first one's sessionStorage, which
 * is what a navigation in the same tab amounts to.
 */

import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Window } from "happy-dom";

vi.mock("../../src/db.js", () => ({ prisma: {} }));

const g = globalThis as Record<string, unknown>;
const APP_SRC = readFileSync(resolve(__dirname, "../../public/js/app.js"), "utf8");

function storage(store: Record<string, string>) {
  return {
    getItem: (k: string) => (k in store ? store[k] : null),
    setItem: (k: string, v: string) => { store[k] = v; },
    removeItem: (k: string) => { delete store[k]; },
  };
}

function mount(username: string | null, session: Record<string, string> = {}) {
  const win = new Window();
  const doc = win.document;
  g.window = win;
  g.document = doc;
  Object.defineProperty(globalThis, "navigator", { value: win.navigator, configurable: true, writable: true });
  g.localStorage = storage({});
  g.sessionStorage = storage(session);
  g.fetch = () => Promise.reject(new Error("no network in this test"));
  g.showToast = () => {};
  const query = vi.fn(async (q: string) => ({
    query: q, blocks: [], subnets: [], reservations: [], ips: [], sites: [], ipsec: [],
    assets: [{ type: "nowhere", id: "A1", title: "CORE-SW-1" }],
  }));
  g.api = { search: { query } };
  g.escapeHtml = (s: unknown) => String(s ?? "");
  doc.body.innerHTML = '<div class="page-header"><h2>Assets</h2><div class="page-header-actions"></div></div>';
  try { (0, eval)(APP_SRC); } catch (_e) { /* app.js boot wiring touches page-specific DOM */ }
  g.currentUsername = username;
  (g.renderGlobalSearch as () => void)();
  const input = doc.getElementById("global-search-input") as HTMLInputElement;
  const dropdown = doc.getElementById("global-search-dropdown") as HTMLElement;
  return { win, doc, session, query, input, dropdown };
}

function type(m: ReturnType<typeof mount>, text: string) {
  m.input.value = text;
  m.input.dispatchEvent(new (g.window as any).Event("input"));
}

function focus(m: ReturnType<typeof mount>) {
  m.input.dispatchEvent(new (g.window as any).Event("focus"));
}

describe("global search — the unfinished query", () => {
  it("is kept across a page load in the same tab", () => {
    const first = mount("alice");
    type(first, "core-sw");
    expect(first.session["polaris-search-draft-alice"]).toBe("core-sw");
    const next = mount("alice", first.session);
    expect(next.input.value).toBe("core-sw");
  });

  it("is searched again when the restored box is focused", () => {
    const first = mount("alice");
    type(first, "core-sw");
    const next = mount("alice", first.session);
    focus(next);
    expect(next.query).toHaveBeenCalledWith("core-sw", expect.any(Object));
  });

  it("is dropped once a result is opened", async () => {
    const m = mount("alice");
    type(m, "core");
    await (g._performSearch as (q: string) => Promise<void>)("core");
    (m.dropdown.querySelector(".gs-item") as HTMLElement).click();
    expect(m.session["polaris-search-draft-alice"]).toBeUndefined();
    expect(mount("alice", m.session).input.value).toBe("");
  });

  it("is dropped when the box is emptied", () => {
    const m = mount("alice");
    type(m, "core");
    type(m, "");
    expect(m.session["polaris-search-draft-alice"]).toBeUndefined();
  });

  it("belongs to the user who typed it", () => {
    const m = mount("alice");
    type(m, "core");
    expect(mount("bob", m.session).input.value).toBe("");
  });

  it("waits for the signed-in user when the box mounts before it is known", async () => {
    const session = { "polaris-search-draft-alice": "printer" };
    const m = mount(null, session);
    expect(m.input.value).toBe("");
    g.currentUsername = "alice";
    (g._userReadyResolve as () => void)();
    await Promise.resolve();
    expect(m.input.value).toBe("printer");
  });

  it("a bare scope prefix on focus leaves the shortcuts up instead of searching", () => {
    const m = mount("alice", { "polaris-search-draft-alice": "block:" });
    focus(m);
    expect(m.query).not.toHaveBeenCalled();
  });
});

describe("global search — Ctrl+A in the box", () => {
  it("is left to the browser, even with a table selection on the page", () => {
    const m = mount("alice");
    type(m, "core-sw");
    // A table with a selected row: the row-select Ctrl+A would claim the key
    // if it did not stand aside for a field.
    m.doc.body.insertAdjacentHTML("beforeend",
      '<table><tbody><tr><td><input type="checkbox" class="row-select" checked></td></tr></tbody></table>');
    m.input.focus();
    const Kev = (m.win as unknown as { KeyboardEvent: typeof KeyboardEvent }).KeyboardEvent;
    const ev = new Kev("keydown", { key: "a", ctrlKey: true, bubbles: true, cancelable: true });
    m.input.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(false);
  });
});
