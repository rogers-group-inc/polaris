/**
 * tests/unit/globalSearchShortcut.test.ts — the global search box's Ctrl+K
 * shortcut and the hint that advertises it (`renderGlobalSearch` in
 * public/js/app.js).
 *
 * The shortcut existed for months with nothing on screen saying so; the hint
 * is the only place an operator learns it. Pinned: the hint renders with the
 * platform's key name, the input announces the shortcut to a screen reader,
 * Ctrl+K lands in the box, and the stylesheet hides the hint whenever the box
 * is focused or holds text (the end it sits in belongs to the clear button and
 * the spinner then). Visibility itself is CSS-driven and only checkable in a
 * real browser, so the rule is asserted as text.
 */

import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Window } from "happy-dom";

vi.mock("../../src/db.js", () => ({ prisma: {} }));

const g = globalThis as Record<string, unknown>;
const APP_SRC = readFileSync(resolve(__dirname, "../../public/js/app.js"), "utf8");
const CSS = readFileSync(resolve(__dirname, "../../public/css/styles.css"), "utf8");

function mount(platform: string) {
  const win = new Window();
  const doc = win.document;
  Object.defineProperty(win.navigator, "platform", { value: platform, configurable: true });
  g.window = win;
  g.document = doc;
  // Node's own global navigator is a getter: define over it, don't assign.
  Object.defineProperty(globalThis, "navigator", { value: win.navigator, configurable: true, writable: true });
  g.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
  g.fetch = () => Promise.reject(new Error("no network in this test"));
  g.showToast = () => {};
  g.api = {};
  g.escapeHtml = (s: unknown) => String(s ?? "");
  doc.body.innerHTML = '<div class="page-header"><h2>Assets</h2><div class="page-header-actions"></div></div>';
  try { (0, eval)(APP_SRC); } catch (_e) { /* app.js boot wiring touches page-specific DOM */ }
  // Indirect eval puts app.js's top-level functions on Node's global.
  (g.renderGlobalSearch as () => void)();
  return { win, doc };
}

describe("global search — the Ctrl+K hint", () => {
  it("shows Ctrl K in the box and announces Control+K", () => {
    const { doc } = mount("Win32");
    expect(doc.querySelector(".global-search .global-search-kbd")!.textContent).toBe("Ctrl K");
    expect(doc.getElementById("global-search-input")!.getAttribute("aria-keyshortcuts")).toBe("Control+K");
  });

  it("names the Command key on a Mac", () => {
    const { doc } = mount("MacIntel");
    expect(doc.querySelector(".global-search-kbd")!.textContent).toBe("⌘ K");
    expect(doc.getElementById("global-search-input")!.getAttribute("aria-keyshortcuts")).toBe("Meta+K");
  });

  it("Ctrl+K puts the cursor in the box", () => {
    const { win, doc } = mount("Win32");
    const ev = new (win as unknown as { KeyboardEvent: typeof KeyboardEvent }).KeyboardEvent("keydown",
      { key: "k", ctrlKey: true, bubbles: true, cancelable: true });
    doc.body.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
    expect(doc.activeElement).toBe(doc.getElementById("global-search-input"));
  });

  it("the stylesheet hides the hint once the box is focused or holds text", () => {
    expect(CSS).toContain('.global-search input[type="search"]:focus ~ .global-search-kbd');
    expect(CSS).toContain('.global-search input[type="search"]:not(:placeholder-shown) ~ .global-search-kbd { display: none; }');
  });
});
