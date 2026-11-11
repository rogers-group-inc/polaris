/**
 * @vitest-environment happy-dom
 *
 * tests/unit/legendToggleBeside.test.ts
 *
 * legend-toggle.js `beside` (the Device Map topology, operator request
 * 2026-11-10): the legend button never hides — it sits just before the
 * legend, a click opens the legend to its right and a second click closes it,
 * and the × still closes it. Without `beside` the original collapse-into-the-
 * button behaviour is unchanged.
 */

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

beforeAll(() => {
  const src = readFileSync(resolve(__dirname, "../../public/js/legend-toggle.js"), "utf8");
  new Function(src)();
});

function mount(): { host: HTMLElement; legend: HTMLElement; close: HTMLButtonElement } {
  document.body.innerHTML =
    '<div id="host"><div id="legend"><header><span>Legend</span><button id="x" type="button">×</button></header><div>rows</div></div></div>';
  return {
    host: document.getElementById("host")!,
    legend: document.getElementById("legend")!,
    close: document.getElementById("x") as HTMLButtonElement,
  };
}

describe("PolarisLegendToggle beside", () => {
  let api: any;
  let els: ReturnType<typeof mount>;
  beforeEach(() => {
    els = mount();
    api = (window as any).PolarisLegendToggle.attach(els.legend, { closeButton: els.close, beside: true, expanded: false });
  });

  it("puts the button before the legend, outside it", () => {
    expect(api.button.parentNode).toBe(els.host);
    expect(api.button.nextSibling).toBe(els.legend);
    expect(els.legend.classList.contains("legend-beside")).toBe(true);
    expect(els.legend.classList.contains("legend-collapsed")).toBe(true);
  });

  it("the button toggles the legend open and closed", () => {
    api.button.click();
    expect(api.isExpanded()).toBe(true);
    expect(api.button.getAttribute("aria-expanded")).toBe("true");
    expect(api.button.classList.contains("is-open")).toBe(true);
    expect(api.button.title).toBe("Hide legend");
    api.button.click();
    expect(api.isExpanded()).toBe(false);
    expect(api.button.title).toBe("Show legend");
  });

  it("the × still closes it", () => {
    api.button.click();
    els.close.click();
    expect(api.isExpanded()).toBe(false);
  });
});

describe("PolarisLegendToggle default (unchanged)", () => {
  it("keeps the button inside the legend, and the button only opens", () => {
    const els = mount();
    const api = (window as any).PolarisLegendToggle.attach(els.legend, { closeButton: els.close, expanded: false });
    expect(api.button.parentNode).toBe(els.legend);
    api.button.click();
    api.button.click();
    expect(api.isExpanded()).toBe(true);
  });
});
