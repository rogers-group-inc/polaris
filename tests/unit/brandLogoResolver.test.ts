/**
 * tests/unit/brandLogoResolver.test.ts — the browser-side brand-mark rules.
 *
 * public/js/brand-logo.js is a browser IIFE with no module export, so it is
 * evaluated in a Node vm context with a stub window/document and pulled off
 * window.PolarisBrandLogo — the tests/unit/appmapFilter.test.ts approach.
 *
 * What's pinned here is the promise the Customization tab makes: the shipped
 * Polaris art follows the theme FAMILY, an operator's logo replaces it PER
 * SURFACE, and the Application Name is text that appears only beside a custom
 * logo (the Polaris art already carries the wordmark).
 *
 * Family, not id, is the load-bearing part since the three-theme cutover:
 * morning and noon are both daylight and share one set of art, and the retired
 * `light`/`dark` ids name no theme at all.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import vm from "node:vm";

interface Branding {
  appName?: string;
  subtitle?: string;
  logoUrl?: string;
  customLogo?: boolean;
  logoAccent?: boolean;
  logoOnLogin?: boolean;
  logoOnSidebar?: boolean;
  logoVersion?: string | null;
}
interface Resolved { src: string; custom: boolean; showName: boolean; showSubtitle: boolean }

let BrandLogo: {
  ASSETS: Record<string, Record<string, string>>;
  resolve: (b: Branding | null, surface: string) => Resolved;
  isCustom: (b: Branding | null) => boolean;
  customOn: (b: Branding | null, surface: string) => boolean;
  preferredTheme: () => string;
  currentTheme: () => string;
};
let theme = "nightfall";
let prefersLight = false;

beforeAll(() => {
  const here = dirname(fileURLToPath(import.meta.url));
  const code = readFileSync(resolve(here, "../../public/js/brand-logo.js"), "utf8");
  const sandbox: Record<string, any> = {
    window: {},
    document: { documentElement: { getAttribute: () => theme, setAttribute: (_k: string, v: string) => { theme = v; } } },
    localStorage: { getItem: () => null },
  };
  sandbox.window.matchMedia = (q: string) => ({
    matches: q.includes("light") ? prefersLight : false,
    addEventListener() {},
  });
  sandbox.window.document = sandbox.document;
  sandbox.window.localStorage = sandbox.localStorage;
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);
  BrandLogo = sandbox.window.PolarisBrandLogo;
});

const custom = (over: Branding = {}): Branding => ({
  appName: "Acme Networks",
  subtitle: "Acme Corp",
  logoUrl: "/uploads/custom-logo.png",
  customLogo: true,
  ...over,
});

describe("theme-aware Polaris art", () => {
  it("serves the dark-theme wordmark on a dark background and the light one on light", () => {
    theme = "nightfall";
    expect(BrandLogo.resolve(null, "login").src).toBe(BrandLogo.ASSETS.login.dark);
    theme = "morning";
    expect(BrandLogo.resolve(null, "login").src).toBe(BrandLogo.ASSETS.login.light);
    theme = "nightfall";
  });

  it("picks by FAMILY, so both daylight themes take the light art", () => {
    theme = "morning";
    expect(BrandLogo.currentTheme()).toBe("light");
    theme = "noon";
    expect(BrandLogo.currentTheme()).toBe("light");
    expect(BrandLogo.resolve(null, "sidebar").src).toBe(BrandLogo.ASSETS.sidebar.light);
    theme = "nightfall";
  });

  it("treats a retired dark/light id as the dark family rather than as a theme", () => {
    // A browser carrying the pre-cutover value is handed the dark art, which
    // is what DEFAULT_THEME resolves to everywhere else.
    theme = "light";
    expect(BrandLogo.currentTheme()).toBe("dark");
    theme = "dark";
    expect(BrandLogo.currentTheme()).toBe("dark");
    theme = "nightfall";
  });

  it("uses horizontal art on the login card and vertical art in the sidebar", () => {
    expect(BrandLogo.resolve(null, "login").src).toContain("horiz");
    expect(BrandLogo.resolve(null, "sidebar").src).toContain("vert");
  });

  it("never captions the Polaris art with the app name — the art says it already", () => {
    const r = BrandLogo.resolve(custom({ customLogo: false, logoUrl: "/logo.png" }), "sidebar");
    expect(r.custom).toBe(false);
    expect(r.showName).toBe(false);
    // The operator's own subtitle line still rides along.
    expect(r.showSubtitle).toBe(true);
  });
});

describe("custom logo placement", () => {
  it("replaces the art on both surfaces by default", () => {
    expect(BrandLogo.resolve(custom(), "login").src).toBe("/uploads/custom-logo.png");
    expect(BrandLogo.resolve(custom(), "sidebar").src).toBe("/uploads/custom-logo.png");
  });

  it("falls back to the Polaris art on whichever surface is switched off", () => {
    const b = custom({ logoOnLogin: false });
    expect(BrandLogo.resolve(b, "login").src).toBe(BrandLogo.ASSETS.login.dark);
    expect(BrandLogo.resolve(b, "login").showName).toBe(false);
    expect(BrandLogo.resolve(b, "sidebar").src).toBe("/uploads/custom-logo.png");

    const b2 = custom({ logoOnSidebar: false });
    expect(BrandLogo.resolve(b2, "sidebar").src).toBe(BrandLogo.ASSETS.sidebar.dark);
    expect(BrandLogo.resolve(b2, "login").src).toBe("/uploads/custom-logo.png");
  });

  it("shows the app name beside a custom logo only when one was typed", () => {
    expect(BrandLogo.resolve(custom(), "login").showName).toBe(true);
    expect(BrandLogo.resolve(custom({ appName: "" }), "login").showName).toBe(false);
    expect(BrandLogo.resolve(custom({ appName: "   " }), "login").showName).toBe(false);
  });

  it("points at the server-composited render when the accent is on, per theme", () => {
    theme = "nightfall";
    expect(BrandLogo.resolve(custom({ logoAccent: true }), "login").src)
      .toBe("/api/v1/server-settings/branding/logo-accent.png?theme=dark");
    // The symbol art is theme-paired too, so a theme flip has to change the
    // URL — that is also what makes the <img> re-fetch.
    theme = "morning";
    expect(BrandLogo.resolve(custom({ logoAccent: true }), "login").src)
      .toBe("/api/v1/server-settings/branding/logo-accent.png?theme=light");
    theme = "nightfall";
  });

  it("carries the logo's version in its URL, so the image can be cached for good", () => {
    // The upload is written to a fixed filename: without a version the URL
    // never changes, so it had to be served no-cache, and every page change
    // painted the sidebar with no logo while the browser asked again.
    theme = "nightfall";
    expect(BrandLogo.resolve(custom({ logoVersion: "abc123" }), "sidebar").src)
      .toBe("/uploads/custom-logo.png?v=abc123");
    expect(BrandLogo.resolve(custom({ logoVersion: "abc123", logoAccent: true }), "sidebar").src)
      .toBe("/api/v1/server-settings/branding/logo-accent.png?theme=dark&v=abc123");
    // A payload cached before the field existed: the old, unversioned URL.
    expect(BrandLogo.resolve(custom(), "sidebar").src).toBe("/uploads/custom-logo.png");
    // The shipped art is static and never versioned.
    expect(BrandLogo.resolve({ logoVersion: "abc123" }, "sidebar").src).toBe(BrandLogo.ASSETS.sidebar.dark);
  });

  it("treats a payload cached before these fields existed as 'show my logo'", () => {
    const legacy = { appName: "Acme", subtitle: "", logoUrl: "/uploads/custom-logo.png" };
    expect(BrandLogo.isCustom(legacy)).toBe(true);
    expect(BrandLogo.customOn(legacy, "login")).toBe(true);
    expect(BrandLogo.customOn(legacy, "sidebar")).toBe(true);
  });

  it("does not treat the shipped default as a custom logo", () => {
    expect(BrandLogo.isCustom({ logoUrl: "/logo.png" })).toBe(false);
    expect(BrandLogo.isCustom(null)).toBe(false);
  });
});

describe("preferredTheme", () => {
  it("follows the OS when it asks for light, and stays dark otherwise", () => {
    prefersLight = true;
    expect(BrandLogo.preferredTheme()).toBe("light");
    prefersLight = false;
    expect(BrandLogo.preferredTheme()).toBe("dark");
  });
});
