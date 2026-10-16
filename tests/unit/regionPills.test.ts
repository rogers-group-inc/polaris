/**
 * tests/unit/regionPills.test.ts — the shared region-pill module.
 *
 * public/js/region-pills.js is a browser IIFE with no module export, so it is
 * evaluated in a Node vm context with a stub window and pulled off
 * window.PolarisRegionPills — the brandLogoResolver.test.ts approach.
 *
 * What's pinned here is the contract both consumers (the Users page pickers
 * and the Device Map's "My regions" strip) rely on: a region outside the
 * catalogue still renders as a pill, an unreadable catalogue is a fallback
 * rather than a failure, and a region NAME is escaped before it reaches HTML.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import vm from "node:vm";

interface Region { name: string; color?: string }

type Pills = {
  load: () => Promise<Record<string, string>>;
  isLoaded: () => boolean;
  catalog: () => Record<string, string>;
  names: () => string[];
  colorFor: (n: string) => string;
  rgbTriplet: (hex: string) => string;
  pill: (n: string, title?: string) => string;
  html: (names: string[], titleFor?: (n: string) => string) => string;
};

const CODE = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), "../../public/js/region-pills.js"),
  "utf8",
);

/** Fresh module instance per test, with a stub `api.mapRegions.list`. */
function load(list: (() => Promise<Region[]>) | null): Pills {
  const sandbox: Record<string, any> = { window: {} };
  sandbox.window.escapeHtml = (s: string) =>
    String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  if (list) sandbox.window.api = { mapRegions: { list } };
  vm.createContext(sandbox);
  vm.runInContext(CODE, sandbox);
  return sandbox.window.PolarisRegionPills as Pills;
}

const CATALOG: Region[] = [
  { name: "Southeast", color: "#4fc3f7" },
  { name: "Midwest", color: "#ef5350" },
  { name: "Uncolored", color: "" },
];

describe("catalogue load", () => {
  it("indexes name -> color and reports the names sorted", async () => {
    const p = load(async () => CATALOG);
    expect(p.isLoaded()).toBe(false);
    await p.load();
    expect(p.isLoaded()).toBe(true);
    expect(p.names()).toEqual(["Midwest", "Southeast", "Uncolored"]);
    expect(p.colorFor("Southeast")).toBe("#4fc3f7");
  });

  it("falls back to the neutral hue when the catalogue is unreadable", async () => {
    // GET /map/regions is gated mapRegions:read — a deviceMap-only viewer gets
    // a 403 here, which must degrade to gray pills rather than throw.
    const p = load(async () => {
      throw new Error("403 Forbidden");
    });
    await expect(p.load()).resolves.toEqual({});
    expect(p.isLoaded()).toBe(false);
    expect(p.colorFor("Southeast")).toBe("#9e9e9e");
    expect(p.html(["Southeast"])).toContain("--hue:#9e9e9e");
  });

  it("is a no-op when the page never loaded api.js", async () => {
    const p = load(null);
    await expect(p.load()).resolves.toEqual({});
  });
});

describe("colorFor", () => {
  it("neutral-hues a region that is not in the catalogue, or whose color is unset/malformed", async () => {
    const p = load(async () => [...CATALOG, { name: "Bad", color: "blue" }]);
    await p.load();
    expect(p.colorFor("Hand-typed")).toBe("#9e9e9e"); // never in the catalogue
    expect(p.colorFor("Uncolored")).toBe("#9e9e9e");  // in it, no color stored
    expect(p.colorFor("Bad")).toBe("#9e9e9e");        // in it, not #rrggbb
  });
});

describe("rgbTriplet", () => {
  it("splits #rrggbb into the rgba() triplet", () => {
    const p = load(null);
    expect(p.rgbTriplet("#4fc3f7")).toBe("79, 195, 247");
    expect(p.rgbTriplet("#000000")).toBe("0, 0, 0");
  });

  it("returns the neutral triplet for anything that is not #rrggbb", () => {
    const p = load(null);
    expect(p.rgbTriplet("")).toBe("158, 158, 158");
    expect(p.rgbTriplet("#abc")).toBe("158, 158, 158");
  });
});

describe("pill markup", () => {
  it("hands the region's colour to .hue-pill as --hue, and never paints it as the label", async () => {
    const p = load(async () => CATALOG);
    await p.load();
    const html = p.pill("Southeast");
    // Fill, label and border come from styles.css .hue-pill, which clamps the
    // label's lightness per theme — the raw hex as text vanished on its own
    // tint for a pale hue (a yellow on the daylight themes).
    expect(html).toContain('class="badge hue-pill"');
    expect(html).toContain('style="--hue:#4fc3f7"');
    expect(html).not.toMatch(/[";]color:/);
    expect(html).toContain(">Southeast<");
  });

  it("escapes the region name and the title — both are operator-typed", () => {
    const p = load(null);
    const html = p.pill('<img src=x onerror="alert(1)">', 'from "your account"');
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
    expect(html).toContain("title=\"from &quot;your account&quot;\"");
  });

  it("omits the title attribute entirely when no tooltip is supplied", () => {
    expect(load(null).pill("Southeast")).not.toContain("title=");
  });
});

describe("html(names)", () => {
  it("renders one badge per region and threads the per-name tooltip", async () => {
    const p = load(async () => CATALOG);
    await p.load();
    const html = p.html(["Southeast", "Midwest"], (n) => "source of " + n);
    expect(html.match(/class="badge hue-pill"/g)).toHaveLength(2);
    expect(html).toContain("source of Southeast");
    expect(html).toContain("source of Midwest");
  });

  it("renders nothing for an empty or absent list — the caller says what that means", () => {
    const p = load(null);
    expect(p.html([])).toBe("");
    expect(p.html(undefined as unknown as string[])).toBe("");
  });
});
