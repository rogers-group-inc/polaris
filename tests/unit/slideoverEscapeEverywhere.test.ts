/**
 * tests/unit/slideoverEscapeEverywhere.test.ts — CQ-F025 source guard.
 *
 * Every slide-over closes on Escape when it is the topmost layer, through
 * app.js's wireSlideoverEscape. Four panels (Installed Agents, Compare
 * Assets, the Events page's Alerts panel, the Users page's role panel)
 * shipped without it while every other panel had it, and nothing noticed. A
 * file that builds or hosts a `slideover-overlay` must now wire Escape — via
 * wireSlideoverEscape, or (for app.js's own shell panels) an explicit Escape
 * branch.
 */

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

const JS = resolve(__dirname, "../../public/js");

function jsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) { if (e.name !== "vendor") out.push(...jsFiles(join(dir, e.name))); continue; }
    if (e.name.endsWith(".js")) out.push(join(dir, e.name));
  }
  return out;
}

/**
 * Files that name `slideover-overlay` without building a panel. panel-lock.js
 * only intercepts backdrop clicks on overlays other files own (the panel
 * lock); its own comment leaves Escape to each panel.
 */
const NOT_A_PANEL = new Set(["panel-lock.js"]);

describe("every slide-over closes on Escape (CQ-F025)", () => {
  // A panel built through app.js's buildSlideover names neither the class nor
  // wireSlideoverEscape — the factory wires Escape for it (CQ-F025).
  const files = jsFiles(JS).filter((f) => /slideover-overlay|buildSlideover\(/.test(readFileSync(f, "utf8")));

  it("finds the slide-over files", () => {
    expect(files.length).toBeGreaterThan(8);
  });

  for (const f of files) {
    const name = f.slice(JS.length + 1).replace(/\\/g, "/");
    if (NOT_A_PANEL.has(name)) continue;
    it(`${name} wires Escape`, () => {
      const src = readFileSync(f, "utf8");
      expect(/wireSlideoverEscape\(|buildSlideover\(/.test(src) || /["']Escape["']/.test(src), `${name} builds a slide-over with no Escape`).toBe(true);
    });
  }
});
