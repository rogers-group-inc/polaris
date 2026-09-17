/**
 * tests/unit/widgetRegistration.test.ts
 *
 * Every dashboard widget module registers itself, and the set of modules on
 * disk matches the set public/index.html actually loads.
 *
 * The regression this exists for: statusSummary.js built its tile catalogue at
 * module scope from `WC.neutral` without ever declaring `WC` (the shared
 * palette moved to window.POLARIS_WIDGET_STATUS_COLORS in "refactor(frontend):
 * shared status palettes in api.js", which added `var WC = …` to
 * sitesWithIssues.js and not to this one). The module threw "WC is not
 * defined" before reaching PolarisWidgets.register(), so the Status summary
 * widget silently vanished from the registry — absent from the widget library,
 * and dropped from any saved layout that named it, because dashboard.js skips
 * a widget whose type no longer resolves. Nothing failed: one page-level
 * exception in a file the dashboard loads with 22 others.
 *
 * So this is a LOAD-TIME guard, not a rendering one — each module is evaluated
 * and only asked whether it registered. The per-widget behaviour tests
 * (widgetActiveAlerts, widgetAssetTypes, …) cover what they draw.
 */

import { describe, it, expect, beforeAll, vi } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { Window } from "happy-dom";

const here = dirname(fileURLToPath(import.meta.url));
const WIDGET_DIR = resolve(here, "../../public/js/widgets");
const INDEX_HTML = resolve(here, "../../public/index.html");

/**
 * Modules that are NOT widgets: the registry itself and the shared top-N bar
 * helper the ranked widgets build on. Everything else in the folder is
 * expected to call register() exactly once.
 */
const NOT_WIDGETS = new Set(["index.js", "_topnBar.js"]);

const moduleFiles = readdirSync(WIDGET_DIR)
  .filter((f) => f.endsWith(".js") && !NOT_WIDGETS.has(f))
  .sort();

interface WidgetModule {
  type: string;
  label?: string;
  defaultSize?: { width: number; height: number };
  defaultConfig?: Record<string, unknown>;
}
interface Registry {
  getAll: () => WidgetModule[];
  getByType: (t: string) => WidgetModule | undefined;
}

let registry: Registry;
const loadErrors: Array<{ file: string; message: string }> = [];

beforeAll(() => {
  const win = new Window();
  const g = globalThis as Record<string, unknown>;
  g.window = win;
  g.document = win.document;

  // The app-shell globals the widget modules read at load time. These come
  // from public/js/api.js and app.js in the browser; the widgets take them as
  // bare globals, which is exactly how the WC bug hid — an undeclared name
  // looks like one more of these until it throws.
  g.escapeHtml = (s: unknown) => String(s ?? "");
  g.timeAgo = () => "5m ago";
  g.monitorStatusLabel = (s: unknown) => String(s ?? "unknown");
  g.api = new Proxy({}, { get: () => new Proxy(() => Promise.resolve({}), { get: () => () => Promise.resolve({}) }) });

  const colors = { ok: "#0a0", warning: "#fa0", down: "#f00", neutral: "#888", critical: "#f00" };
  for (const key of ["POLARIS_WIDGET_STATUS_COLORS", "POLARIS_HEALTH_COLORS", "POLARIS_SEVERITY_COLORS"]) {
    g[key] = { ...colors, maintenance: "#a0f", passive: "#888", unknown: "#888" };
    (win as unknown as Record<string, unknown>)[key] = g[key];
  }
  g.POLARIS_MONITOR_STATUS_LABELS = {
    up: "Up", warning: "Missed", recovering: "Recovering",
    down: "Down", unknown: "Pending", passive: "Passive",
  };
  (win as unknown as Record<string, unknown>).POLARIS_MONITOR_STATUS_LABELS = g.POLARIS_MONITOR_STATUS_LABELS;
  // Leaflet, for the two map widgets.
  g.L = new Proxy(() => ({}), { get: () => () => ({ addTo: () => ({}), on: () => ({}) }) });

  (0, eval)(readFileSync(resolve(WIDGET_DIR, "index.js"), "utf8"));
  registry = (win as unknown as { PolarisWidgets: Registry }).PolarisWidgets;
  g.PolarisWidgets = registry;
  (0, eval)(readFileSync(resolve(WIDGET_DIR, "_topnBar.js"), "utf8"));

  // Each module is evaluated on its own so one failure names its own file
  // rather than aborting the rest — the browser behaves the same way.
  for (const file of moduleFiles) {
    try {
      (0, eval)(readFileSync(resolve(WIDGET_DIR, file), "utf8"));
    } catch (e) {
      loadErrors.push({ file, message: e instanceof Error ? e.message : String(e) });
    }
  }
});

describe("dashboard widget registration", () => {
  it("finds the widget modules on disk", () => {
    // Guards the guard: an empty glob would make every assertion below vacuous.
    expect(moduleFiles.length).toBeGreaterThan(20);
  });

  it("every widget module evaluates without throwing", () => {
    expect(loadErrors).toEqual([]);
  });

  it("every widget module registers a type", () => {
    const registered = new Set(registry.getAll().map((m) => m.type));
    const unregistered = moduleFiles.filter((f) => !registered.has(f.replace(/\.js$/, "")));
    expect(unregistered).toEqual([]);
  });

  it("registers statusSummary — the one that threw on an undeclared WC", () => {
    const mod = registry.getByType("statusSummary");
    expect(mod).toBeDefined();
    expect(mod?.defaultConfig).toBeDefined();
  });

  it("registers exactly one module per file, with no duplicate types", () => {
    const types = registry.getAll().map((m) => m.type);
    expect(types.length).toBe(new Set(types).size);
    expect(types.length).toBe(moduleFiles.length);
  });
});

describe("public/index.html loads every widget module", () => {
  const html = readFileSync(INDEX_HTML, "utf8");
  const loaded = new Set(
    [...html.matchAll(/js\/widgets\/([A-Za-z_]+\.js)/g)].map((m) => m[1]),
  );

  it("has a script tag for each module on disk", () => {
    // A module the page never loads is a widget the dashboard cannot offer,
    // however correct the file is.
    expect(moduleFiles.filter((f) => !loaded.has(f))).toEqual([]);
  });

  it("loads no widget script that is not on disk", () => {
    const onDisk = new Set(readdirSync(WIDGET_DIR));
    expect([...loaded].filter((f) => !onDisk.has(f))).toEqual([]);
  });
});
