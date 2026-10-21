/**
 * tests/unit/dashboardGearPopoverDom.test.ts — where the widget gear popover
 * (public/js/dashboard.js → openGearPopover) lands, and when it closes.
 *
 * It used to be position:absolute at page coordinates. Opened from a widget
 * near the bottom of the page it hung past the viewport, which made the
 * document scrollable, and a wheel over it slid the page card up under the
 * pinned tab row. It is now fixed and clamped to the viewport: it opens upward
 * when there is no room below the gear, and a scroll that moves the gear
 * closes it (a fixed popover would otherwise be left floating where the gear
 * used to be).
 *
 * happy-dom has no layout, so the gear's rect, the popover's height and the
 * viewport are stubbed.
 */

import { describe, it, expect, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Window } from "happy-dom";

vi.mock("../../src/db.js", () => ({ prisma: {} }));

const SRC = readFileSync(resolve(__dirname, "../../public/js/dashboard.js"), "utf8");
const g = globalThis as Record<string, unknown>;

const VW = 1600;
const VH = 900;

const PAGE_HTML =
  '<div id="dashboard-tabs" class="dashboard-tabs" hidden></div>' +
  '<button id="dashboard-customize">Customize Page</button>' +
  '<button id="dashboard-done" hidden>Done Editing</button>' +
  '<div id="dashboard-empty-state" class="dashboard-empty"></div>' +
  '<div class="folder-card-scroll"><div id="dashboard-canvas" class="dashboard-canvas" hidden></div></div>';

function layout() {
  return {
    version: 3,
    activeId: "d1",
    dashboards: [{ id: "d1", name: "One", columns: [{ id: "c1", width: 6, widgets: [{ id: "w1", type: "downNodes", height: 1, config: {} }] }] }],
  };
}

async function boot(gearTop: number, popHeight: number) {
  const win = new Window();
  const doc = win.document;
  g.window = win;
  g.document = doc;
  (win as unknown as Record<string, unknown>).POLARIS_DASH_LOCAL = undefined;
  g.escapeHtml = (s: unknown) => String(s ?? "");
  g.showToast = () => {};
  g.showConfirm = async () => true;
  g.openModal = () => {};
  g.closeModal = () => {};
  g.isAdmin = () => false;
  g.currentUsername = "tester";
  g.userReady = Promise.resolve();
  g.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
  g.api = { me: { dashboard: { get: async () => layout(), put: async (l: unknown) => l } } };
  g.PolarisWidgets = {
    uuid: () => "u",
    getByType: (type: string) => ({
      type, label: "Down Interfaces", title: type, fetchData: async () => null, renderInstance: () => {},
      renderConfig: (el: { innerHTML: string }) => { el.innerHTML = '<div class="inner-scroll">fields</div>'; },
    }),
    getAllowed: () => [],
    widgetTitle: () => "Down Interfaces",
  };
  g.WidgetLibrary = { open: () => {}, close: () => {}, isOpen: () => false };
  g.CSS = { escape: (s: string) => String(s) };

  Object.defineProperty(doc.documentElement, "clientWidth", { configurable: true, get: () => VW });
  Object.defineProperty(doc.documentElement, "clientHeight", { configurable: true, get: () => VH });
  const proto = win.HTMLElement.prototype as unknown as object;
  Object.defineProperty(proto, "offsetHeight", {
    configurable: true,
    get(this: { classList: { contains: (c: string) => boolean } }) {
      return this.classList.contains("widget-config-popover") ? popHeight : 0;
    },
  });

  doc.body.innerHTML = PAGE_HTML;
  (0, eval)(SRC);
  doc.dispatchEvent(new win.Event("DOMContentLoaded", { bubbles: true }));
  await new Promise((r) => setTimeout(r, 0));
  (doc.getElementById("dashboard-customize") as unknown as { click: () => void }).click();
  await new Promise((r) => setTimeout(r, 0));

  const gear = doc.querySelector('[data-action="gear"]') as unknown as HTMLElement;
  gear.getBoundingClientRect = () =>
    ({ top: gearTop, bottom: gearTop + 24, left: 1000, right: 1024, width: 24, height: 24, x: 1000, y: gearTop }) as DOMRect;
  gear.click();
  const pop = doc.querySelector(".widget-config-popover") as unknown as HTMLElement | null;
  return { win, doc, gear, pop };
}

afterEach(async () => {
  // Drain dashboard.js's 800ms save debounce while this case's stubs stand.
  await new Promise((r) => setTimeout(r, 850));
});

describe("widget gear popover placement", () => {
  it("opens down from the gear when there is room below", async () => {
    const { pop } = await boot(100, 400);
    expect(pop).not.toBeNull();
    expect(pop!.style.top).toBe("100px");
    // Left of the gear: 1000 - 260 - 6.
    expect(pop!.style.left).toBe("734px");
  });

  it("opens UP from the gear near the bottom of the page, never past the viewport", async () => {
    const { pop } = await boot(700, 560);
    // Bottom edge on the gear's bottom (724): 724 - 560.
    expect(pop!.style.top).toBe("164px");
  });

  it("pins to the viewport top when taller than the room above the gear (it scrolls inside)", async () => {
    const { pop } = await boot(300, 860);
    // 300 + 860 overflows; 324 - 860 is above the viewport; clamp to 8.
    expect(pop!.style.top).toBe("8px");
  });
});

describe("widget gear popover closing on scroll", () => {
  it("closes when the page card holding the gear scrolls", async () => {
    const { win, doc } = await boot(100, 400);
    doc.querySelector(".folder-card-scroll")!.dispatchEvent(new win.Event("scroll"));
    expect(doc.querySelector(".widget-config-popover")).toBeNull();
  });

  it("stays open for a scroll inside itself", async () => {
    const { win, doc } = await boot(100, 400);
    doc.querySelector(".widget-config-popover .inner-scroll")!.dispatchEvent(new win.Event("scroll"));
    expect(doc.querySelector(".widget-config-popover")).not.toBeNull();
  });

  it("stays open for a widget body's own auto-scroll (it does not hold the gear)", async () => {
    const { win, doc } = await boot(100, 400);
    doc.querySelector(".dashboard-widget-body")!.dispatchEvent(new win.Event("scroll"));
    expect(doc.querySelector(".widget-config-popover")).not.toBeNull();
  });
});
