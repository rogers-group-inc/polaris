/**
 * tests/unit/unprofiledManufacturers.test.ts — business rule 172: the
 * Manufacturer Profiles card lists manufacturers of SNMP-answering devices
 * that have no profile, and never creates one on its own.
 *
 * Asked 2026-11-12 for a profile created automatically per manufacturer; not
 * done, because an empty profile named after a manufacturer silently takes
 * its devices from another profile's "Also applies when" (rule 131) and
 * discovery learns hundreds of vendors never polled over SNMP. Pinned here:
 * the pure merge (`mergeUnprofiledManufacturers`) and the card's list and
 * empty-row text (`_mfgUnprofiledHTML`, `_mfgStandardReadingHTML`).
 *
 * @vitest-environment happy-dom
 */

import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { mergeUnprofiledManufacturers } from "../../src/services/manufacturerProfileService.js";

describe("mergeUnprofiledManufacturers", () => {
  const profiles = [
    { id: "hp", manufacturer: "HP", matchPattern: "aruba|procurve" },
    { id: "apc", manufacturer: "APC", matchPattern: null },
    { id: "bad", manufacturer: "Zed", matchPattern: "(" },
  ];

  it("drops a manufacturer that has a profile, case-insensitively", () => {
    const out = mergeUnprofiledManufacturers([{ manufacturer: "apc", count: 9 }, { manufacturer: "Eaton", count: 4 }], profiles);
    expect(out.map((m) => m.manufacturer)).toEqual(["Eaton"]);
  });

  it("names the profile whose Also applies when already covers the name", () => {
    const out = mergeUnprofiledManufacturers([{ manufacturer: "Aruba", count: 12 }], profiles);
    expect(out).toEqual([{ manufacturer: "Aruba", assetCount: 12, coveredBy: { id: "hp", manufacturer: "HP" } }]);
  });

  it("merges spellings of one name, skips blanks, and sorts by device count then name", () => {
    const out = mergeUnprofiledManufacturers([
      { manufacturer: "Eaton", count: 2 }, { manufacturer: "eaton", count: 3 },
      { manufacturer: null, count: 50 }, { manufacturer: "Vertiv", count: 5 }, { manufacturer: "Liebert", count: 5 },
    ], profiles);
    expect(out.map((m) => [m.manufacturer, m.assetCount])).toEqual([["Eaton", 5], ["Liebert", 5], ["Vertiv", 5]]);
  });

  it("ignores a pattern that does not compile", () => {
    const out = mergeUnprofiledManufacturers([{ manufacturer: "(Thing)", count: 1 }], profiles);
    expect(out[0].coveredBy).toBeNull();
  });
});

describe("the card", () => {
  const g = globalThis as Record<string, any>;
  let canWrite = true;

  beforeAll(() => {
    const lines = readFileSync(resolve(__dirname, "../../public/js/server-settings-profiles.js"), "utf8").split(/\r?\n/);
    const block = (head: string) => {
      const start = lines.findIndex((l) => l.startsWith(head));
      if (start < 0) throw new Error(`${head} not found`);
      const end = lines.findIndex((l, i) => i > start && (l === "}" || l === "};"));
      return lines.slice(start, end + 1).join("\n");
    };
    g.escapeHtml = (s: unknown) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
    g.permAtLeast = () => canWrite;
    const src = [block("function _mfgUnprofiledHTML("), block("var _MFG_STANDARD_READING = {"), block("function _mfgStandardReadingHTML(")].join("\n");
    new Function("g", src + "\ng._mfgUnprofiledHTML = _mfgUnprofiledHTML; g._mfgStandardReadingHTML = _mfgStandardReadingHTML;")(g);
  });

  it("draws nothing when every SNMP manufacturer has a profile", () => {
    expect(g._mfgUnprofiledHTML([])).toBe("");
  });

  it("lists each manufacturer with its count, the covering profile and a Create button", () => {
    canWrite = true;
    document.body.innerHTML = g._mfgUnprofiledHTML([
      { manufacturer: "Eaton", assetCount: 4, coveredBy: null },
      { manufacturer: "Aruba", assetCount: 12, coveredBy: { id: "hp", manufacturer: "HP" } },
    ]);
    const rows = document.querySelectorAll("tbody tr");
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toContain("Eaton");
    expect(rows[1].textContent).toContain("HP");
    const buttons = document.querySelectorAll(".mfg-unprofiled-create");
    expect([...buttons].map((b) => b.getAttribute("data-manufacturer"))).toEqual(["Eaton", "Aruba"]);
    expect(buttons[1].getAttribute("title")).toContain("leave the HP profile");
  });

  it("offers no Create button to a read-only role", () => {
    canWrite = false;
    document.body.innerHTML = g._mfgUnprofiledHTML([{ manufacturer: "Eaton", assetCount: 4, coveredBy: null }]);
    expect(document.querySelector(".mfg-unprofiled-create")).toBeNull();
  });

  it("an empty row names the standard reading instead of '(built-in seed)'", () => {
    expect(g._mfgStandardReadingHTML("cpu")).toContain("Standard: HOST-RESOURCES-MIB hrProcessorLoad");
    expect(g._mfgStandardReadingHTML("serial")).toContain("entPhysicalSerialNum");
    expect(g._mfgStandardReadingHTML("unknown-key")).toContain("(built-in seed)");
  });
});
