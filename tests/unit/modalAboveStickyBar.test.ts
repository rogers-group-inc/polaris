/**
 * tests/unit/modalAboveStickyBar.test.ts
 *
 * An open dialog must stack above the frozen page-top bar.
 *
 * `.page-top-sticky` sits at z-index 1050 so it stays above dashboard widgets
 * and their Leaflet panes (~1000). `.modal-overlay` sits at 1000. The bar is
 * transparent, so a tall dialog whose title row reached the bar's band looked
 * right while every click there landed on the bar: the X and the panel lock
 * did nothing on Dashboard, /dash, Integrations and Server Settings (found on
 * the FortiManager API Query dialog, 2026-11-04). A real-Chrome hit test
 * confirmed it; this pins the CSS that fixes it.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const CSS = readFileSync(join(process.cwd(), "public", "css", "styles.css"), "utf-8");

/** Offset of the rule whose selector is exactly `selector`, at a line start
 *  (a bare indexOf also matches it as the tail of a longer selector). */
function ruleAt(selector: string): number {
  const at = CSS.indexOf("\n" + selector + " {");
  expect(at, `rule ${selector}`).toBeGreaterThanOrEqual(0);
  return at;
}

/** z-index declared in the rule whose selector is exactly `selector`. */
function zIndexOf(selector: string): number {
  const at = ruleAt(selector);
  const body = CSS.slice(at, CSS.indexOf("}", at));
  const m = body.match(/z-index:\s*(\d+)/);
  expect(m, `z-index in ${selector}`).not.toBeNull();
  return Number(m![1]);
}

describe("open dialogs stack above the frozen page-top bar", () => {
  it("the bar normally outranks the modal overlay (the premise this rule exists for)", () => {
    expect(zIndexOf(".page-top-sticky")).toBeGreaterThan(zIndexOf(".modal-overlay"));
  });

  it("while any modal overlay is open, the bar drops below it", () => {
    expect(zIndexOf("body:has(.modal-overlay.open) .page-top-sticky")).toBeLessThan(zIndexOf(".modal-overlay"));
  });

  it("the demotion comes after the bar's own rule, so it wins the cascade", () => {
    expect(ruleAt("body:has(.modal-overlay.open) .page-top-sticky")).toBeGreaterThan(ruleAt(".page-top-sticky"));
  });
});
