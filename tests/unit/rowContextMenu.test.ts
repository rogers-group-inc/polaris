/**
 * tests/unit/rowContextMenu.test.ts — the shared row context menu
 * (`showRowMenu` / `closeRowMenu` in public/js/app.js).
 *
 * The list pages moved their per-row verbs out of an Actions column and behind
 * the row's name, so this one helper is now the ONLY way to reach Edit, Clone,
 * Delete on Automations and Open, Edit, Delete on IPAM's Blocks and Networks.
 * A regression here doesn't degrade a page, it removes every per-row action
 * from three tables at once — hence the coverage.
 *
 * app.js is a classic browser script, so it's eval'd into a happy-dom Window.
 * Positioning is NOT asserted: happy-dom reports zero-size rects for everything,
 * so getBoundingClientRect-driven placement can only be checked in a real
 * browser. What's pinned here is behaviour that doesn't depend on layout —
 * which items render, which are reachable, and every path that closes the menu.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Window } from "happy-dom";

vi.mock("../../src/db.js", () => ({ prisma: {} }));

const g = globalThis as Record<string, unknown>;
const APP_SRC = readFileSync(resolve(__dirname, "../../public/js/app.js"), "utf8");

interface MenuItem {
  label?: string;
  onSelect?: () => void;
  danger?: boolean;
  disabled?: boolean;
  title?: string;
  separator?: boolean;
  heading?: string;
  icon?: string;
}

let win: InstanceType<typeof Window>;
let doc: Window["document"];
let showRowMenu: (anchor: unknown, items: MenuItem[], opts?: unknown) => void;
let closeRowMenu: (opts?: unknown) => void;
let anchor: HTMLElement;

/** Fresh document + a fresh eval of app.js, so menu state can't leak between tests. */
beforeEach(() => {
  win = new Window();
  doc = win.document;
  g.window = win;
  g.document = doc;
  g.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
  g.fetch = () => Promise.reject(new Error("no network in this test"));
  g.showToast = () => {};
  g.api = {};
  g.escapeHtml = (s: unknown) => String(s ?? "");

  doc.body.innerHTML = '<table><tbody><tr><td><button id="anchor">Row name</button></td></tr></tbody></table>';
  try { (0, eval)(APP_SRC); } catch (_e) { /* app.js boot wiring touches page-specific DOM */ }

  showRowMenu = (win as unknown as { showRowMenu: typeof showRowMenu }).showRowMenu;
  closeRowMenu = (win as unknown as { closeRowMenu: typeof closeRowMenu }).closeRowMenu;
  anchor = doc.querySelector("#anchor") as unknown as HTMLElement;
  expect(typeof showRowMenu, "app.js no longer exports showRowMenu").toBe("function");
});

function menu() { return doc.querySelector(".row-context-menu"); }
function itemLabels() {
  return Array.from(doc.querySelectorAll(".row-context-menu button")).map((b) => b.textContent);
}

describe("showRowMenu — rendering", () => {
  it("renders one button per action, in order", () => {
    showRowMenu(anchor, [
      { label: "Open", onSelect: () => {} },
      { label: "Edit", onSelect: () => {} },
      { label: "Delete", onSelect: () => {} },
    ]);
    expect(menu()).toBeTruthy();
    expect(itemLabels()).toEqual(["Open", "Edit", "Delete"]);
  });

  it("renders separators and headings without turning them into actions", () => {
    showRowMenu(anchor, [
      { heading: "Manage" },
      { label: "Edit", onSelect: () => {} },
      { separator: true },
      { label: "Delete", onSelect: () => {}, danger: true },
    ]);
    expect(itemLabels()).toEqual(["Edit", "Delete"]);
    expect(doc.querySelectorAll(".row-context-menu .dropdown-divider").length).toBe(1);
    expect(doc.querySelector(".row-context-menu .dropdown-heading")!.textContent).toBe("Manage");
  });

  it("marks a danger item so Delete reads as destructive", () => {
    showRowMenu(anchor, [{ label: "Delete", onSelect: () => {}, danger: true }]);
    expect(doc.querySelector(".row-context-menu button")!.classList.contains("danger")).toBe(true);
  });

  it("carries an item's title through as the button tooltip", () => {
    showRowMenu(anchor, [{ label: "Clone", onSelect: () => {}, title: "Create a disabled copy" }]);
    expect(doc.querySelector(".row-context-menu button")!.getAttribute("title")).toBe("Create a disabled copy");
  });

  it("is a menu for assistive tech, and marks the anchor expanded", () => {
    showRowMenu(anchor, [{ label: "Open", onSelect: () => {} }], { label: "Actions for Row name" });
    expect(menu()!.getAttribute("role")).toBe("menu");
    expect(menu()!.getAttribute("aria-label")).toBe("Actions for Row name");
    expect(doc.querySelector(".row-context-menu button")!.getAttribute("role")).toBe("menuitem");
    expect(anchor.getAttribute("aria-expanded")).toBe("true");
  });

  it("renders nothing for an empty or missing item list", () => {
    showRowMenu(anchor, []);
    expect(menu()).toBeFalsy();
    showRowMenu(null, [{ label: "Open", onSelect: () => {} }]);
    expect(menu()).toBeFalsy();
  });

  it("renders an icon beside the label without swallowing the label", () => {
    // The account menu (theme / push / logout) is the icon-bearing caller;
    // the label has to stay real text so the row is still findable by name.
    showRowMenu(anchor, [{ label: "Logout", icon: "<svg><path/></svg>", onSelect: () => {}, danger: true }]);
    const b = doc.querySelector(".row-context-menu button")!;
    expect(b.classList.contains("has-icon")).toBe(true);
    expect(b.classList.contains("danger")).toBe(true);
    expect(b.querySelector("svg")).toBeTruthy();
    expect(b.textContent).toBe("Logout");
  });

  it("mounts on <body>, not in the row — table wrappers clip overflow", () => {
    showRowMenu(anchor, [{ label: "Open", onSelect: () => {} }]);
    expect(menu()!.parentElement!.tagName).toBe("BODY");
  });
});

describe("showRowMenu — activation", () => {
  it("runs the item's handler and closes first, so a modal isn't covered", () => {
    const order: string[] = [];
    showRowMenu(anchor, [{
      label: "Edit",
      onSelect: () => { order.push(menu() ? "menu-still-open" : "menu-closed"); },
    }]);
    (doc.querySelector(".row-context-menu button") as unknown as { click: () => void }).click();
    expect(order).toEqual(["menu-closed"]);
    expect(menu()).toBeFalsy();
  });

  it("a disabled item is inert and not focusable", () => {
    let ran = false;
    showRowMenu(anchor, [{ label: "Delete", onSelect: () => { ran = true; }, disabled: true }]);
    const b = doc.querySelector(".row-context-menu button") as unknown as { click: () => void; disabled: boolean };
    expect(b.disabled).toBe(true);
    b.click();
    expect(ran).toBe(false);
  });

  it("a throwing handler doesn't leave the menu on screen", () => {
    showRowMenu(anchor, [{ label: "Edit", onSelect: () => { throw new Error("boom"); } }]);
    (doc.querySelector(".row-context-menu button") as unknown as { click: () => void }).click();
    expect(menu()).toBeFalsy();
  });
});

describe("showRowMenu — dismissal", () => {
  it("closes on Escape", () => {
    showRowMenu(anchor, [{ label: "Open", onSelect: () => {} }]);
    doc.dispatchEvent(new win.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(menu()).toBeFalsy();
    expect(anchor.getAttribute("aria-expanded")).toBe("false");
  });

  it("closes on a pointerdown outside itself", () => {
    showRowMenu(anchor, [{ label: "Open", onSelect: () => {} }]);
    doc.body.dispatchEvent(new win.Event("pointerdown", { bubbles: true }));
    expect(menu()).toBeFalsy();
  });

  it("stays open on a pointerdown inside itself", () => {
    showRowMenu(anchor, [{ label: "Open", onSelect: () => {} }]);
    doc.querySelector(".row-context-menu")!.dispatchEvent(new win.Event("pointerdown", { bubbles: true }));
    expect(menu()).toBeTruthy();
  });

  it("closes on scroll — it is fixed and cannot follow its anchor", () => {
    showRowMenu(anchor, [{ label: "Open", onSelect: () => {} }]);
    win.dispatchEvent(new win.Event("scroll"));
    expect(menu()).toBeFalsy();
  });

  it("closes when a container HOLDING the anchor scrolls", () => {
    const wrap = doc.createElement("div");
    doc.body.appendChild(wrap);
    wrap.appendChild(anchor);
    showRowMenu(anchor, [{ label: "Open", onSelect: () => {} }]);
    wrap.dispatchEvent(new win.Event("scroll", { bubbles: true }));
    expect(menu()).toBeFalsy();
  });

  it("survives a scroll in a container that does NOT hold the anchor", () => {
    // The dashboard's NOC auto-scroll creeps every overflowing widget body a
    // pixel every 80 ms. Closing on those made the page-header account menu
    // flash open and vanish; the anchor never moved, so the menu is still
    // correctly placed.
    const elsewhere = doc.createElement("div");
    doc.body.appendChild(elsewhere);
    showRowMenu(anchor, [{ label: "Logout", onSelect: () => {} }]);
    elsewhere.dispatchEvent(new win.Event("scroll", { bubbles: true }));
    expect(menu()).toBeTruthy();
  });

  it("closes on resize", () => {
    showRowMenu(anchor, [{ label: "Open", onSelect: () => {} }]);
    win.dispatchEvent(new win.Event("resize"));
    expect(menu()).toBeFalsy();
  });

  it("a second click on the same anchor toggles it shut instead of stacking", () => {
    showRowMenu(anchor, [{ label: "Open", onSelect: () => {} }]);
    showRowMenu(anchor, [{ label: "Open", onSelect: () => {} }]);
    expect(doc.querySelectorAll(".row-context-menu").length).toBe(0);
  });

  it("stays open on a pointerdown inside the anchor's own children", () => {
    // The account badge's trigger wraps an avatar, a name and a caret. Closing
    // here would let the click that follows re-open it, so a second click on
    // the badge could never dismiss the menu.
    anchor.innerHTML = '<span id="anchor-kid">david.moore</span>';
    showRowMenu(anchor, [{ label: "Logout", onSelect: () => {} }]);
    doc.querySelector("#anchor-kid")!.dispatchEvent(new win.Event("pointerdown", { bubbles: true }));
    expect(menu()).toBeTruthy();
  });

  it("opening from a different anchor replaces the open menu", () => {
    const other = doc.createElement("button");
    doc.body.appendChild(other);
    showRowMenu(anchor, [{ label: "Open", onSelect: () => {} }]);
    showRowMenu(other, [{ label: "Edit", onSelect: () => {} }]);
    expect(doc.querySelectorAll(".row-context-menu").length).toBe(1);
    expect(itemLabels()).toEqual(["Edit"]);
    // The anchor that lost the menu must not be left claiming it's expanded.
    expect(anchor.getAttribute("aria-expanded")).toBe("false");
  });

  it("closeRowMenu is safe when nothing is open", () => {
    expect(() => closeRowMenu()).not.toThrow();
  });

  it("removes its listeners on close — a later scroll can't throw", () => {
    showRowMenu(anchor, [{ label: "Open", onSelect: () => {} }]);
    closeRowMenu();
    expect(() => win.dispatchEvent(new win.Event("scroll"))).not.toThrow();
    expect(menu()).toBeFalsy();
  });
});

describe("showRowMenu — the open-menu stamp", () => {
  /**
   * `data-rowmenu-open` on the anchor is what tells a container not to move
   * while a fixed menu is pinned to one of its children. The dashboard's NOC
   * auto-scroll reads it (dashboard.js → startAutoScroll): a single 1px creep
   * tick scrolls the widget body, which contains the anchor, which closes the
   * menu — so a row menu on a scrolling widget vanished before the operator
   * could pick anything. Hover can't cover it: the menu is body-mounted, so
   * reaching for it is a mouseleave from the widget.
   *
   * Both halves matter. A stamp left behind on a closed menu freezes that
   * widget for as long as the row survives its next re-render.
   */
  it("stamps the anchor while the menu is open", () => {
    expect(anchor.hasAttribute("data-rowmenu-open")).toBe(false);
    showRowMenu(anchor, [{ label: "Acknowledge alert…", onSelect: () => {} }]);
    expect(anchor.hasAttribute("data-rowmenu-open")).toBe(true);
  });

  it("clears the stamp on every close path", () => {
    const paths: Array<[string, () => void]> = [
      ["closeRowMenu", () => closeRowMenu()],
      ["Escape", () => {
        const ev = new win.Event("keydown", { bubbles: true }) as unknown as { key: string };
        ev.key = "Escape";
        doc.dispatchEvent(ev as never);
      }],
      ["selecting an item", () => (doc.querySelector(".row-context-menu button") as unknown as HTMLElement).click()],
      ["a scroll that moved the anchor", () => doc.body.dispatchEvent(new win.Event("scroll", { bubbles: true }))],
    ];
    for (const [name, close] of paths) {
      showRowMenu(anchor, [{ label: "Open device", onSelect: () => {} }]);
      expect(anchor.hasAttribute("data-rowmenu-open"), name).toBe(true);
      close();
      expect(menu(), name).toBeFalsy();
      expect(anchor.hasAttribute("data-rowmenu-open"), name).toBe(false);
    }
  });

  it("moves the stamp when another row claims the menu", () => {
    const other = doc.createElement("button") as unknown as HTMLElement;
    doc.body.appendChild(other as never);
    showRowMenu(anchor, [{ label: "Open", onSelect: () => {} }]);
    showRowMenu(other, [{ label: "Open", onSelect: () => {} }]);
    expect(anchor.hasAttribute("data-rowmenu-open")).toBe(false);
    expect(other.hasAttribute("data-rowmenu-open")).toBe(true);
  });
});

describe("showRowMenu — stacking layer", () => {
  /**
   * The menu is body-mounted and fixed, so its z-index is compared against the
   * other BODY-level layers rather than against the surface the row is on. At
   * the stylesheet's 900 that is right for a list page and wrong inside an
   * overlay: the asset details General tab's upstream rows shipped with their
   * menu opening BEHIND the slide-over that owns them (2026-09).
   *
   * happy-dom has no stylesheet here, so these set the layer inline — which is
   * exactly what the helper reads (computed z-index up the ancestor chain).
   */
  function anchorInside(zIndexes: string[]) {
    let host = doc.body as unknown as HTMLElement;
    for (const z of zIndexes) {
      const el = doc.createElement("div") as unknown as HTMLElement;
      el.style.position = "fixed";
      el.style.zIndex = z;
      host.appendChild(el as never);
      host = el;
    }
    const btn = doc.createElement("button") as unknown as HTMLElement;
    btn.id = "nested-anchor";
    host.appendChild(btn as never);
    return btn;
  }

  it("lifts the menu one above a slide-over overlay", () => {
    // .slideover-overlay is 1050 and the .slideover inside it 1000.
    const btn = anchorInside(["1050", "1000"]);
    showRowMenu(btn, [{ label: "Open asset", onSelect: () => {} }]);
    expect((menu() as unknown as HTMLElement).style.zIndex).toBe("1051");
  });

  it("clears the deepest layer, not the nearest ancestor", () => {
    // A control inside the slide-over's own nested panel: the ANCESTOR with the
    // greatest z-index is what the menu has to beat.
    const btn = anchorInside(["1050", "1200", "5"]);
    showRowMenu(btn, [{ label: "Open asset", onSelect: () => {} }]);
    expect((menu() as unknown as HTMLElement).style.zIndex).toBe("1201");
  });

  it("leaves a plain list-page menu on the stylesheet's base", () => {
    // Nothing above 900 in play — no inline z-index, so the menu keeps 900 and
    // stays UNDER the modal overlay a verb typically opens.
    showRowMenu(anchor, [{ label: "Open", onSelect: () => {} }]);
    expect((menu() as unknown as HTMLElement).style.zIndex).toBe("");
  });

  it("never demotes: an ancestor below the base is ignored", () => {
    const btn = anchorInside(["10"]);
    showRowMenu(btn, [{ label: "Open", onSelect: () => {} }]);
    expect((menu() as unknown as HTMLElement).style.zIndex).toBe("");
  });
});
