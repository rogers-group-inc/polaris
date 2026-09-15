/**
 * tests/unit/manufacturerProfileReadinessUi.test.ts — the profile page shows
 * provenance, not the operator's pin (Phase 2 of uniform SNMP).
 *
 * The MIB cell used to render whichever MIB the operator picked, or a static
 * symbol → module table (`SEED_SYMBOL_MIB`) for seeded symbols, so a row that
 * saved cleanly and resolved nothing looked exactly like one that worked.
 * Pinned here:
 *
 *   - a resolved row names the module and layer the server actually
 *     resolved it from;
 *   - an unresolved row says "unresolved" and what to upload — the missing
 *     import's module when the pinned MIB is the problem, "the vendor's MIB"
 *     when nothing loaded defines the symbol;
 *   - the collapsed header carries READY / N UNRESOLVED from the summary;
 *   - the upload form's inline result names the modules a new upload needs;
 *   - `SEED_SYMBOL_MIB` is gone.
 *
 * server-settings.js is a plain browser script whose only load-time side effect
 * is a DOMContentLoaded listener (never dispatched here), so it evals into a
 * happy-dom Window and its `function`/`var` declarations land on that global.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Window } from "happy-dom";

interface Sandbox {
  _mfgMibCellHTML: (readiness: unknown, mibId: string | null, mibStdKey: string | null) => string;
  _mfgReadinessPillHTML: (p: unknown) => string;
  _mibUploadResultHTML: (created: unknown) => string;
  _mibsData: unknown[];
  SEED_SYMBOL_MIB?: unknown;
}

let sb: Sandbox;

beforeAll(() => {
  const win = new Window({ url: "https://polaris.test/server-settings.html" });
  Object.assign(win as unknown as Record<string, unknown>, {
    formatBytes: (n: number) => String(n),
    escapeHtml: (x: unknown) => String(x ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] as string)),
    showToast: () => {},
    permAtLeast: () => true,
    api: {},
  });
  const code = readFileSync(resolve(__dirname, "../../public/js/server-settings.js"), "utf8");
  (win as unknown as { eval: (s: string) => void }).eval(code);
  sb = win as unknown as Sandbox;
  sb._mibsData = [{ id: "mib-1", moduleName: "FORTINET-FORTISWITCH-MIB" }];
});

const resolved = (symbol: string, fromModuleName: string, fromScope: string) =>
  ({ symbol, resolved: true, oid: "1.3.6.1.4.1.12356.106.4.1.2", fromScope, fromModuleName, hint: null });

describe("_mfgMibCellHTML", () => {
  it("names the module and layer a resolved symbol came from", () => {
    const html = sb._mfgMibCellHTML({ a: resolved("fsSysCpuUsage", "FORTINET-FORTISWITCH-MIB", "vendor"), b: null }, "mib-1", null);
    expect(html).toContain("FORTINET-FORTISWITCH-MIB");
    expect(html).toContain("vendor MIB");
    expect(html).not.toContain("unresolved");
  });

  it("labels a shipped standard as such", () => {
    const html = sb._mfgMibCellHTML({ a: resolved("ifHCInOctets", "IF-MIB", "standard"), b: null }, null, "std:if-ext");
    expect(html).toContain("IF-MIB");
    expect(html).toContain("shipped standard");
  });

  it("says what to upload when the pinned MIB is missing an import", () => {
    const html = sb._mfgMibCellHTML({
      a: {
        symbol: "fsSysCpuUsage", resolved: false, oid: null, fromScope: null, fromModuleName: null,
        hint: { kind: "imports", mibModuleName: "FORTINET-FORTISWITCH-MIB", roots: [{ symbol: "fortinet", module: "FORTINET-CORE-MIB" }] },
      },
      b: null,
    }, "mib-1", null);
    expect(html).toContain("unresolved");
    expect(html).toContain("FORTINET-FORTISWITCH-MIB is missing FORTINET-CORE-MIB");
  });

  it("says no module defines the symbol when nothing loaded mentions it", () => {
    const html = sb._mfgMibCellHTML({
      a: { symbol: "fsSysCpuUsage", resolved: false, oid: null, fromScope: null, fromModuleName: null, hint: { kind: "no-module" } },
      b: null,
    }, null, null);
    expect(html).toContain("unresolved");
    expect(html).toContain("no uploaded MIB defines fsSysCpuUsage");
  });

  it("flags a double_scalar row when only its second symbol fails", () => {
    const html = sb._mfgMibCellHTML({
      a: resolved("fsSysMemUsage", "FORTINET-FORTISWITCH-MIB", "vendor"),
      b: { symbol: "fsSysMemCapacity", resolved: false, oid: null, fromScope: null, fromModuleName: null, hint: { kind: "no-module" } },
    }, "mib-1", null);
    expect(html).toContain("unresolved");
    expect(html).toContain("fsSysMemCapacity");
  });

  it("falls back to the operator's pin for an unconfigured row", () => {
    expect(sb._mfgMibCellHTML(null, "mib-1", null)).toContain("FORTINET-FORTISWITCH-MIB");
    expect(sb._mfgMibCellHTML(null, null, "std:lldp")).toContain("LLDP-MIB");
    expect(sb._mfgMibCellHTML(null, null, null)).toContain("seed");
  });
});

describe("_mfgReadinessPillHTML", () => {
  it("is READY when everything resolves, counts otherwise, silent for an empty profile", () => {
    expect(sb._mfgReadinessPillHTML({ ready: true, partial: false, unresolvedCount: 0, unresolvedSymbols: [] })).toContain("READY");
    const bad = sb._mfgReadinessPillHTML({ ready: false, partial: true, unresolvedCount: 3, unresolvedSymbols: ["a", "b", "c"] });
    expect(bad).toContain("3 UNRESOLVED");
    expect(bad).toContain('title="a, b, c"');
    expect(sb._mfgReadinessPillHTML({ ready: false, partial: false, unresolvedCount: 0, unresolvedSymbols: [] })).toBe("");
  });
});

describe("_mibUploadResultHTML", () => {
  it("names the modules a new upload still needs", () => {
    const html = sb._mibUploadResultHTML({
      moduleName: "FORTINET-FORTIGATE-MIB", symbolCount: 412, unresolvedCount: 412,
      unresolvedRoots: [{ symbol: "fortinet", module: "FORTINET-CORE-MIB" }, { symbol: "FnBoolState", module: "FORTINET-CORE-MIB" }],
    });
    expect(html).toContain("412 of 412 symbols unresolved");
    expect(html).toContain("needs <b>FORTINET-CORE-MIB</b>");
    expect(html.match(/FORTINET-CORE-MIB/g)?.length).toBe(1); // deduplicated
  });

  it("says all resolve when they do, and renders nothing for a pre-readiness response", () => {
    expect(sb._mibUploadResultHTML({ moduleName: "IF-MIB", symbolCount: 91, unresolvedCount: 0, unresolvedRoots: [] })).toContain("all resolve");
    expect(sb._mibUploadResultHTML({ moduleName: "IF-MIB" })).toBe("");
  });
});

describe("the seed table is gone", () => {
  it("no longer carries a static symbol → module map", () => {
    expect(sb.SEED_SYMBOL_MIB).toBeUndefined();
  });
});
