/**
 * tests/unit/mobileOrientation.test.ts
 *
 * The phone app is portrait and its topology screen is landscape (it draws the
 * desktop's left-to-right map). Three things are worth pinning:
 *
 *  - the LOCK is asked for only on a phone-class screen (short side ≤ 480 CSS
 *    px). A tablet or an unfolded foldable is unlocked instead, so its topology
 *    stays the way the device is held;
 *  - `html[data-orient]` follows the wanted orientation, since mobile.css keys
 *    the topology's rotate prompt on it — and a repeat request does not re-lock;
 *  - the 480 px bound is ONE number: mobile/app.js's PHONE_SHORT_SIDE and the
 *    topology prompt's media query in mobile.css; and
 *  - there is NO landscape lockout for the rest of the app: an iPhone cannot be
 *    locked, so one made the app unusable while turned.
 *
 * @vitest-environment happy-dom
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const MOBILE_APP_JS = readFileSync(join(process.cwd(), "public", "js", "mobile", "app.js"), "utf-8");
const MOBILE_CSS = readFileSync(join(process.cwd(), "public", "css", "mobile.css"), "utf-8");

/** Lifts a brace-balanced `function name(` block, verbatim. */
function extractFn(name: string): string {
  const start = MOBILE_APP_JS.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`${name} not found`);
  let depth = 0;
  let i = MOBILE_APP_JS.indexOf("{", start);
  for (; i < MOBILE_APP_JS.length; i++) {
    if (MOBILE_APP_JS[i] === "{") depth++;
    else if (MOBILE_APP_JS[i] === "}") { depth--; if (depth === 0) break; }
  }
  return MOBILE_APP_JS.slice(start, i + 1);
}

const PHONE_SHORT_SIDE = Number((/var PHONE_SHORT_SIDE = (\d+);/.exec(MOBILE_APP_JS) || [])[1]);

type Harness = {
  setWantedOrientation: (o: string) => void;
  applyOrientationLock: () => void;
};

function load(width: number, height: number) {
  const lock = vi.fn(() => Promise.resolve());
  const unlock = vi.fn();
  const screen = { width, height, orientation: { lock, unlock } };
  const body = [
    `var PHONE_SHORT_SIDE = ${PHONE_SHORT_SIDE};`,
    'var _wantOrient = "portrait";',
    extractFn("isPhoneScreen"),
    extractFn("applyOrientationLock"),
    extractFn("setWantedOrientation"),
    "return { setWantedOrientation: setWantedOrientation, applyOrientationLock: applyOrientationLock };",
  ].join("\n");
  // `screen` is shadowed so the code under test reads the fake, not happy-dom's.
  const h = new Function("window", "screen", "document", body)(
    { screen, innerWidth: width, innerHeight: height }, screen, document,
  ) as Harness;
  return { h, lock, unlock };
}

describe("mobile orientation lock", () => {
  beforeEach(() => document.documentElement.removeAttribute("data-orient"));

  it("bound is read from the source", () => {
    expect(PHONE_SHORT_SIDE).toBe(480);
  });

  it("a phone locks portrait, then landscape for the topology", () => {
    const { h, lock, unlock } = load(390, 844);
    h.applyOrientationLock();
    expect(lock).toHaveBeenLastCalledWith("portrait");
    h.setWantedOrientation("landscape");
    expect(lock).toHaveBeenLastCalledWith("landscape");
    expect(document.documentElement.getAttribute("data-orient")).toBe("landscape");
    expect(unlock).not.toHaveBeenCalled();
  });

  it("a phone held landscape is still a phone (short side decides)", () => {
    const { h, lock } = load(844, 390);
    h.setWantedOrientation("landscape");
    expect(lock).toHaveBeenLastCalledWith("landscape");
  });

  it("an unfolded foldable or a tablet is unlocked, never locked", () => {
    for (const [w, h0] of [[673, 841], [841, 701], [820, 1180]]) {
      const { h, lock, unlock } = load(w, h0);
      h.setWantedOrientation("landscape");
      expect(lock).not.toHaveBeenCalled();
      expect(unlock).toHaveBeenCalled();
      // The attribute still follows the route; mobile.css's prompts are
      // themselves scoped to phone widths, so it prompts nothing here.
      expect(document.documentElement.getAttribute("data-orient")).toBe("landscape");
    }
  });

  it("asking for the orientation already wanted does not re-lock", () => {
    const { h, lock } = load(390, 844);
    h.setWantedOrientation("portrait");
    expect(lock).not.toHaveBeenCalled();
    expect(document.documentElement.getAttribute("data-orient")).toBe("portrait");
  });

  it("a lock the platform refuses is swallowed", () => {
    const { h, lock } = load(390, 844);
    lock.mockImplementation(() => Promise.reject(new Error("NotSupportedError")));
    expect(() => h.setWantedOrientation("landscape")).not.toThrow();
  });
});

describe("mobile.css orientation", () => {
  it("the topology prompt uses the same phone bound as the lock", () => {
    expect(MOBILE_CSS).toContain(`@media (orientation: portrait) and (max-width: ${PHONE_SHORT_SIDE}px)`);
    expect(MOBILE_CSS).toMatch(/html\[data-orient="landscape"\] \.topo-rotate/);
  });

  // iOS can never be locked, so a landscape lockout there is the whole app
  // gone until the phone is turned back — removed 2026-10-26 by request.
  it("never hides the app when the phone is turned sideways", () => {
    expect(MOBILE_CSS).not.toMatch(/@media \(orientation: landscape\)/);
    expect(MOBILE_CSS).not.toContain("Rotate your device to portrait");
  });

  it("pays the side safe-area insets a sideways notch needs", () => {
    const app = /\n\.app \{[^}]*\}/.exec(MOBILE_CSS)?.[0] ?? "";
    expect(app).toContain("env(safe-area-inset-left");
    expect(app).toContain("env(safe-area-inset-right");
    const sheet = /\n\.sheet \{[^}]*\}/.exec(MOBILE_CSS)?.[0] ?? "";
    expect(sheet).toContain("env(safe-area-inset-left");
  });
});
