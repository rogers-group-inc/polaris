// @vitest-environment happy-dom
/**
 * tests/unit/renderPageControlsTopNav.test.ts — renderPageControls' `topNav`
 * option (public/js/app.js).
 *
 * With `topNav: false` the `<id>-top` row carries only the right cluster —
 * action buttons + the "Show N" selector — and no page navigation, so it can
 * share a line with the Assets view tabs (.table-head-row). The bottom row keeps
 * the full page navigation. Without the option both rows are unchanged.
 *
 * app.js is a browser script with no module boundary, so the function is sliced
 * out by name and eval'd — the idiom in assetsPageControlsDom.test.ts.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const g = globalThis as Record<string, any>;
const lines = readFileSync(resolve(__dirname, "../../public/js/app.js"), "utf8").split(/\r?\n/);

function fnSrc(name: string): string {
  const start = lines.findIndex((l) => l.startsWith(`function ${name}(`));
  if (start < 0) throw new Error(`app.js: function ${name} not found`);
  const end = lines.findIndex((l, i) => i > start && l === "}");
  return lines.slice(start, end + 1).join("\n");
}

let pages: number[];
let sizes: number[];

beforeEach(() => {
  document.body.innerHTML = '<div id="pg-top"></div><div id="pg"></div>';
  pages = [];
  sizes = [];
  g.sizeStickyTableWrappers = () => {};
  (0, eval)(fnSrc("renderPageControls"));
});

function render(opts: Record<string, unknown>) {
  g.renderPageControls("pg", 120, 25, 2, (p: number) => pages.push(p), (n: number) => sizes.push(n), {
    actionButtons: [{ label: "Refresh", onClick: () => {} }],
    ...opts,
  });
}

describe("renderPageControls — topNav: false", () => {
  it("drops page navigation from the top row but keeps its buttons and Show N", () => {
    render({ topNav: false });
    const top = document.getElementById("pg-top")!;
    expect(top.querySelector(".pg-prev")).toBeNull();
    expect(top.querySelector(".pg-btn")).toBeNull();
    expect(top.textContent).not.toContain("items");
    expect([...top.querySelectorAll("button")].map((b) => b.textContent)).toEqual(["Refresh"]);
    const sel = top.querySelector("select") as HTMLSelectElement;
    expect(sel).not.toBeNull();
    sel.value = "50";
    sel.dispatchEvent(new Event("change"));
    expect(sizes).toEqual([50]);
  });

  it("keeps full page navigation in the bottom row, without a second Show N or the action buttons", () => {
    render({ topNav: false });
    const bottom = document.getElementById("pg")!;
    expect(bottom.querySelector(".pg-prev")).not.toBeNull();
    expect(bottom.querySelector("select")).toBeNull();
    // Refresh lives in the top (tab) row only — not repeated at the foot.
    expect(bottom.querySelector(".pg-right")!.children).toHaveLength(0);
    (bottom.querySelector(".pg-next") as HTMLButtonElement).click();
    expect(pages).toEqual([3]);
  });
});

describe("renderPageControls — default", () => {
  it("renders page navigation and the action buttons in both rows", () => {
    render({});
    expect(document.getElementById("pg-top")!.querySelector(".pg-prev")).not.toBeNull();
    expect(document.getElementById("pg")!.querySelector(".pg-prev")).not.toBeNull();
    expect(document.getElementById("pg")!.querySelector(".pg-right button")!.textContent).toBe("Refresh");
  });
});
