/**
 * tests/unit/stdMibLabelParity.test.ts — every standard-MIB label names its
 * MIB module, and the four copies of the list agree.
 *
 * The polling-method MIB box says "Automatic (SNMPv2-MIB)" while the SNMP Walk
 * list called the same subtree "System (RFC 1213)", so an operator could not
 * tell they were one MIB (2026-11-12). Each label now carries the module name
 * before the RFC. The list lives in three places — `STD_MIBS` on the server,
 * the SNMP Walk dropdown (`_SNMP_STANDARD_MIBS`, assets-snmp.js) and the
 * profile page's `STD_MIB_LABELS` (server-settings-profiles.js) — so this pins
 * them. (A fourth, the per-stream MIB picker's `_INTEGRATION_SNMP_MIBS`, went
 * with the picker: business rule 173.)
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { STD_MIBS } from "../../src/services/stdMibLibrary.js";

const read = (p: string) => readFileSync(new URL(`../../public/js/${p}`, import.meta.url), "utf-8");

/** id → label for every `{ id: "std:…", label: "…" }` or `"std:…": "…"` in a source. */
function labelsIn(src: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of src.matchAll(/id:\s*"(std:[a-z-]+)",\s*label:\s*"([^"]*)"/g)) out.set(m[1], m[2]);
  for (const m of src.matchAll(/^\s*"(std:[a-z-]+)":\s*"([^"]*)"/gm)) out.set(m[1], m[2]);
  return out;
}

const server = new Map(STD_MIBS.map((d) => [d.key, d]));

describe("standard MIB labels", () => {
  it("each server label names its module before the RFC or standard", () => {
    for (const d of STD_MIBS) {
      expect(d.label, d.key).toMatch(new RegExp(`\\(${d.moduleName}, (RFC \\d+|IEEE [\\w.]+)\\)$`));
    }
  });

  it.each([
    ["assets-snmp.js (SNMP Walk)"],
    ["server-settings-profiles.js (profile page)"],
  ])("%s matches the server's label for every standard key it lists", (name) => {
    const labels = labelsIn(read(name.split(" ")[0]));
    expect(labels.size).toBeGreaterThan(5);
    for (const [key, label] of labels) {
      const def = server.get(key);
      if (!def) continue; // a vendor convenience entry (std:fortinet-fg)
      expect(label, `${name} ${key}`).toBe(def.label);
    }
  });

  it("the SNMP Walk dropdown and the profile page list every server key", () => {
    for (const file of ["assets-snmp.js", "server-settings-profiles.js"]) {
      const labels = labelsIn(read(file));
      for (const d of STD_MIBS) expect(labels.has(d.key), `${file} ${d.key}`).toBe(true);
    }
  });
});
