/**
 * tests/unit/panelBundleCollisions.test.ts — a slide-over's scripts, loaded
 * onto a page that doesn't carry them, must not redeclare that page's globals.
 *
 * PolarisPanels (public/js/app.js) lazy-loads the asset, network and block
 * slide-overs onto any page. Those are classic scripts sharing one global
 * scope, so a top-level `function x` / `var x` in a late file silently
 * REPLACES the page's own `x`, and a `let` / `const` / `class` of the same
 * name makes the late file throw and never define its opener. Before the
 * rename that ships with this test, opening an asset from the Integrations
 * page swapped integrations.js's openCreateModal / openEditModal /
 * confirmDelete for assets.js's — the Add Integration button then opened the
 * Add Asset form — and did the same to users.js on the Users page and to
 * server-settings.js's MIB walk renderer. Nothing errors; the page just starts
 * doing the wrong thing, which is why this is a static check and not a DOM one.
 *
 * The bundle lists are read out of app.js itself, so a dependency added to a
 * panel is checked the moment it is added. Only column-0 declarations count:
 * the page scripts are flat files whose top level is unindented, and anything
 * indented is inside a function or an IIFE.
 */

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const PUBLIC = resolve(__dirname, "../../public");
const appSrc = readFileSync(resolve(PUBLIC, "js/app.js"), "utf8");

/** `_PANEL_SCRIPT_BUNDLES` as written in app.js: kind → ordered script list. */
function readBundles(): Record<string, string[]> {
  const start = appSrc.indexOf("var _PANEL_SCRIPT_BUNDLES = {");
  expect(start).toBeGreaterThan(-1);
  const end = appSrc.indexOf("\n};", start);
  const body = appSrc.slice(start, end);
  const out: Record<string, string[]> = {};
  for (const m of body.matchAll(/^\s{2}(\w+):\s*\[([\s\S]*?)\]/gm)) {
    out[m[1]] = [...m[2].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
  }
  return out;
}

/** `_PANEL_OPENERS`: kind → global the bundle must define. */
function readOpeners(): Record<string, string> {
  const line = appSrc.split(/\r?\n/).find((l) => l.startsWith("var _PANEL_OPENERS = "))!;
  return Object.fromEntries([...line.matchAll(/(\w+):\s*"(\w+)"/g)].map((m) => [m[1], m[2]]));
}

type Decl = "function" | "var" | "let" | "const" | "class";
const declCache = new Map<string, Map<string, Decl>>();
function topLevelDecls(src: string): Map<string, Decl> {
  if (declCache.has(src)) return declCache.get(src)!;
  const out = new Map<string, Decl>();
  const file = resolve(PUBLIC, src.replace(/^\//, ""));
  // Vendored libraries are UMD bundles that publish one namespaced global.
  if (!src.includes("/vendor/") && existsSync(file)) {
    for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
      let m = /^(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)\s*\(/.exec(line);
      if (m) { out.set(m[1], "function"); continue; }
      m = /^(var|let|const|class)\s+([A-Za-z_$][\w$]*)/.exec(line);
      if (m) out.set(m[2], m[1] as Decl);
    }
  }
  declCache.set(src, out);
  return out;
}

/** Every page that loads app.js, with its static script list. */
function pages(): { page: string; statics: string[] }[] {
  return readdirSync(PUBLIC)
    .filter((f) => f.endsWith(".html"))
    .map((page) => {
      const html = readFileSync(resolve(PUBLIC, page), "utf8");
      return { page, html, statics: [...html.matchAll(/<script[^>]*\bsrc="([^"]+)"/g)].map((m) => m[1]) };
    })
    .filter((p) => p.statics.includes("/js/app.js"))
    .map(({ page, statics }) => ({ page, statics }));
}

const BUNDLES = readBundles();
const OPENERS = readOpeners();

describe("panel bundles", () => {
  it("are read out of app.js with the three panels and their openers", () => {
    expect(Object.keys(BUNDLES).sort()).toEqual(["asset", "block", "network"]);
    expect(OPENERS).toEqual({ asset: "openViewModal", network: "openIpPanel", block: "openBlockPanel" });
    // Each opener is declared by a file in its own bundle.
    for (const [kind, opener] of Object.entries(OPENERS)) {
      expect(BUNDLES[kind].some((s) => topLevelDecls(s).get(opener) === "function")).toBe(true);
    }
  });

  it("list files that exist", () => {
    for (const list of Object.values(BUNDLES)) {
      for (const src of list) expect(existsSync(resolve(PUBLIC, src.replace(/^\//, "")))).toBe(true);
    }
  });

  it("never redeclare a global of the page they are loaded onto, nor one another's", () => {
    const problems: string[] = [];
    for (const { page, statics } of pages()) {
      const pageNames = new Map<string, string>();
      for (const s of statics) for (const [n] of topLevelDecls(s)) pageNames.set(n, s);
      // Every file any panel would add to THIS page. All three can land in one
      // session (asset panel, then a network from an interface, then a block),
      // so they are checked together, not per bundle.
      const late = new Set<string>();
      for (const [kind, list] of Object.entries(BUNDLES)) {
        if (statics.some((s) => topLevelDecls(s).get(OPENERS[kind]) === "function")) continue;
        for (const s of list) if (!statics.includes(s)) late.add(s);
      }
      const lateNames = new Map<string, string>();
      for (const s of late) {
        for (const [n] of topLevelDecls(s)) {
          if (pageNames.has(n)) problems.push(`${page}: ${s} redeclares ${n} from ${pageNames.get(n)}`);
          if (lateNames.has(n) && lateNames.get(n) !== s) problems.push(`${page}: ${s} and ${lateNames.get(n)} both declare ${n}`);
          lateNames.set(n, s);
        }
      }
    }
    expect(problems).toEqual([]);
  });
});
