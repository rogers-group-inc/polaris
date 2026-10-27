/**
 * tests/unit/mobileOrientation.test.ts
 *
 * The phone app has no orientation of its own: every screen, the topology
 * included, turns with the phone (locks and prompts removed 2026-10-27 by
 * request). Pinned here so neither comes back:
 *
 *  - mobile/app.js never calls screen.orientation.lock();
 *  - mobile.css has no orientation media query, so nothing is hidden or
 *    covered by a "turn your phone" prompt either way up;
 *  - the topology screen renders no rotate prompt; and
 *  - turned sideways, the side safe-area insets a side notch needs are paid.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (...p: string[]) => readFileSync(join(process.cwd(), ...p), "utf-8");
const MOBILE_APP_JS = read("public", "js", "mobile", "app.js");
const MOBILE_TOPOLOGY_JS = read("public", "js", "mobile", "topology-tab.js");
const MOBILE_CSS = read("public", "css", "mobile.css");

describe("mobile orientation", () => {
  it("never locks the screen", () => {
    expect(MOBILE_APP_JS).not.toMatch(/orientation\.lock\s*\(/);
    expect(MOBILE_APP_JS).not.toContain("data-orient");
  });

  it("has no orientation media query, so nothing is hidden either way up", () => {
    expect(MOBILE_CSS).not.toMatch(/@media[^{]*orientation\s*:/);
    expect(MOBILE_CSS).not.toContain("data-orient");
  });

  it("the topology asks nobody to turn the phone", () => {
    expect(MOBILE_TOPOLOGY_JS).not.toContain("topo-rotate");
    expect(MOBILE_TOPOLOGY_JS).not.toMatch(/sideways to view/i);
  });

  it("pays the side safe-area insets a sideways notch needs", () => {
    const app = /\n\.app \{[^}]*\}/.exec(MOBILE_CSS)?.[0] ?? "";
    expect(app).toContain("env(safe-area-inset-left");
    expect(app).toContain("env(safe-area-inset-right");
    const sheet = /\n\.sheet \{[^}]*\}/.exec(MOBILE_CSS)?.[0] ?? "";
    expect(sheet).toContain("env(safe-area-inset-left");
  });
});
