/**
 * tests/unit/dashboardPortability.test.ts — the .dashboard.json format
 * (public/js/dashboard-portability.js): what an exported tab carries, and what
 * an import refuses, counts and repairs before it reaches loadAsNewTab.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const SRC = readFileSync(resolve(__dirname, "../../public/js/dashboard-portability.js"), "utf8");

interface Parsed {
  name: string;
  layout: { columns: { width: unknown; widgets: { type: string; height: unknown; config: Record<string, unknown> }[] }[] };
  skipped: number;
  problems: string[];
}
interface Portability {
  FORMAT_VERSION: number;
  buildExport: (snap: unknown, opts?: { now?: Date }) => Record<string, unknown>;
  exportText: (snap: unknown) => string;
  filenameForExport: (name: string) => string;
  nameFromFilename: (name: string) => string;
  parseImportFile: (text: string, filename: string, isKnown?: (t: string) => boolean) => Parsed;
}

let P: Portability;

beforeAll(() => {
  const win: Record<string, unknown> = {};
  new Function("window", SRC)(win);
  P = win.PolarisDashboardPortability as Portability;
});

const SNAP = {
  name: "NOC overview",
  layout: {
    columns: [
      { id: "col-1", width: 6, widgets: [{ id: "w-1", type: "statusSummary", height: 1, config: { regions: ["East"] } }] },
      { id: "col-2", width: 6, widgets: [{ id: "w-2", type: "topCpu", height: 2, config: { rowLimit: 10 } }] },
    ],
  },
};

describe("export", () => {
  it("carries name, widths, types, heights and configs — and no instance ids", () => {
    const out = P.buildExport(SNAP, { now: new Date("2026-10-13T00:00:00Z") });
    expect(Object.keys(out)).toEqual(["polarisDashboard", "name", "exportedAt", "columns"]);
    expect(out.polarisDashboard).toBe(P.FORMAT_VERSION);
    expect(out.name).toBe("NOC overview");
    expect(out.exportedAt).toBe("2026-10-13T00:00:00.000Z");
    expect(out.columns).toEqual([
      { width: 6, widgets: [{ type: "statusSummary", height: 1, config: { regions: ["East"] } }] },
      { width: 6, widgets: [{ type: "topCpu", height: 2, config: { rowLimit: 10 } }] },
    ]);
    expect(JSON.stringify(out)).not.toMatch(/col-1|w-1/);
  });

  it("round-trips through parseImportFile", () => {
    const parsed = P.parseImportFile(P.exportText(SNAP), "whatever.dashboard.json", () => true);
    expect(parsed.name).toBe("NOC overview");
    expect(parsed.skipped).toBe(0);
    expect(parsed.problems).toEqual([]);
    expect(parsed.layout.columns[1].widgets[0]).toEqual({ type: "topCpu", height: 2, config: { rowLimit: 10 } });
  });

  it("names the file after the tab, minus path-ish characters", () => {
    expect(P.filenameForExport("NOC overview")).toBe("NOC overview.dashboard.json");
    expect(P.filenameForExport("a/b:c")).toBe("a-b-c.dashboard.json");
    expect(P.filenameForExport("   ")).toBe("dashboard.dashboard.json");
  });
});

describe("import", () => {
  const file = (o: unknown) => JSON.stringify(o);

  it("counts and drops widget types this install doesn't register", () => {
    const parsed = P.parseImportFile(
      file({ name: "X", columns: [{ width: 6, widgets: [{ type: "statusSummary" }, { type: "fromTheFuture" }, "junk"] }] }),
      "x.json",
      (t) => t === "statusSummary",
    );
    expect(parsed.layout.columns[0].widgets.map((w) => w.type)).toEqual(["statusSummary"]);
    expect(parsed.skipped).toBe(2);
  });

  it("falls back to the filename for a blank name, and caps it at the tab-name length", () => {
    expect(P.parseImportFile(file({ columns: [] }), "C:\\x\\Core switches.dashboard.json").name).toBe("Core switches");
    expect(P.parseImportFile(file({ name: "n".repeat(100), columns: [] }), "x.json").name).toHaveLength(60);
    expect(P.parseImportFile(file({ columns: [] }), ".json").name).toBe("Imported dashboard");
  });

  it("reports a different format version instead of refusing", () => {
    const parsed = P.parseImportFile(file({ polarisDashboard: 2, name: "X", columns: [] }), "x.json");
    expect(parsed.problems).toHaveLength(1);
    expect(parsed.problems[0]).toContain("version 2");
  });

  it("refuses what isn't a dashboard", () => {
    expect(() => P.parseImportFile("", "x.json")).toThrow(/empty/);
    expect(() => P.parseImportFile("{nope", "x.json")).toThrow(/Invalid JSON/);
    expect(() => P.parseImportFile("[]", "x.json")).toThrow(/JSON object/);
    expect(() => P.parseImportFile(file({ name: "X" }), "x.json")).toThrow(/no columns/);
    expect(() => P.parseImportFile(file({ columns: [{ widgets: {} }] }), "x.json")).toThrow(/not a list/);
    expect(() => P.parseImportFile(file({ columns: Array(25).fill({ widgets: [] }) }), "x.json")).toThrow(/at most 24/);
    expect(() => P.parseImportFile(file({ columns: [{ widgets: Array(201).fill({ type: "t" }) }] }), "x.json")).toThrow(/at most 200/);
  });

  it("refuses prototype-polluting keys anywhere, including inside a widget config", () => {
    const text = '{"columns":[{"widgets":[{"type":"t","config":{"__proto__":{"admin":true}}}]}]}';
    expect(() => P.parseImportFile(text, "x.json")).toThrow(/__proto__/);
  });

  it("replaces a non-object config with an empty one", () => {
    const parsed = P.parseImportFile(file({ columns: [{ widgets: [{ type: "t", config: [1, 2] }] }] }), "x.json");
    expect(parsed.layout.columns[0].widgets[0].config).toEqual({});
  });
});
