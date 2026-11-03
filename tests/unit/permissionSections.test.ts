/**
 * tests/unit/permissionSections.test.ts — the role editor's function table is
 * grouped by page, in sidebar order.
 *
 * Each function key names the page it is managed on (`section`), and the
 * catalogue is ordered by FUNCTION_SECTIONS, which follows NAV_ITEMS in
 * public/js/app.js. The role editor draws a header whenever the section
 * changes, so a key filed out of its group would split a page into two
 * headers, and a sidebar reorder that nobody carried into the sections would
 * leave the table reading in a different order from the app.
 */

import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { FUNCTION_KEYS, FUNCTION_SECTIONS } from "../../src/api/middleware/permissions.js";

vi.mock("../../src/db.js", () => ({ prisma: {} }));

const sectionIds = FUNCTION_SECTIONS.map((s) => s.id as string);

describe("function-key sections", () => {
  it("every key names a known section", () => {
    for (const f of FUNCTION_KEYS) {
      expect(sectionIds, `${f.key} has an unknown section`).toContain(f.section);
    }
  });

  it("keys are grouped contiguously, in section order", () => {
    const runs: string[] = [];
    for (const f of FUNCTION_KEYS) {
      if (runs[runs.length - 1] !== f.section) runs.push(f.section);
    }
    expect(new Set(runs).size, `a section is split: ${runs.join(" > ")}`).toBe(runs.length);
    const order = runs.map((id) => sectionIds.indexOf(id));
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it("every section holds at least one key", () => {
    const used = new Set(FUNCTION_KEYS.map((f) => f.section as string));
    for (const id of sectionIds) expect(used, `${id} is an empty section`).toContain(id);
  });

  it("alsoOn names other known sections only", () => {
    for (const f of FUNCTION_KEYS) {
      for (const id of f.alsoOn ?? []) {
        expect(sectionIds, `${f.key} alsoOn ${id}`).toContain(id);
        expect(id, `${f.key} lists its own section in alsoOn`).not.toBe(f.section);
      }
    }
  });

  it("the page sections follow the sidebar's order", () => {
    const app = readFileSync(resolve(__dirname, "../../public/js/app.js"), "utf8");
    const navBlock = app.slice(app.indexOf("const NAV_ITEMS = ["), app.indexOf("];", app.indexOf("const NAV_ITEMS = [")));
    const navLabels = Array.from(navBlock.matchAll(/label:\s*"([^"]+)"/g)).map((m) => m[1]);
    expect(navLabels.length).toBeGreaterThan(5);
    // The sidebar says "IP Management"; every other label matches verbatim.
    const sectionLabels = FUNCTION_SECTIONS.map((s) => s.label as string);
    const pageSections = sectionLabels.filter((l) => navLabels.includes(l));
    expect(pageSections).toEqual(navLabels.filter((l) => sectionLabels.includes(l)));
    // Every sidebar page that a key is managed on has a section.
    expect(navLabels.filter((l) => !sectionLabels.includes(l))).toEqual([]);
  });
});
