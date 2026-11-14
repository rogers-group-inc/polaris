/**
 * tests/unit/discoveryAssetOmit.test.ts — pins DISCOVERY_ASSET_OMIT
 * (src/services/discovery/discoveryEngine.ts), the Asset columns that
 * syncDhcpSubnets' per-gate preload leaves out (efficiency audit, "whole-fleet
 * preload").
 *
 * The preloaded rows are `any`, so a phase that starts reading one of these
 * columns off a row would get `undefined` silently: no type error, no failing
 * query. This scan is the guard. It fails when a property access to an omitted
 * column (`.virtualization`, `row["virtualization"]`) appears in the code of
 * syncDhcpSubnets or of a phase module under discovery/dhcp/. The phases that
 * read one through their OWN query are allowed by name, below.
 */

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DISCOVERY_ASSET_OMIT } from "../../src/services/discovery/discoveryEngine.js";

const ROOT = join(__dirname, "../../src/services/discovery");

/** Comments out: a doc comment naming `Asset.monitoredInterfaces` is not a read. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
}

/** syncDhcpSubnets' body, up to the next top-level function. */
function syncDhcpSubnetsBody(): string {
  const src = readFileSync(join(ROOT, "discoveryEngine.ts"), "utf8").replace(/\r\n/g, "\n");
  const start = src.indexOf("export async function syncDhcpSubnets(");
  expect(start).toBeGreaterThan(0);
  const rest = src.slice(start + 1);
  const next = rest.search(/\n(export )?(async )?function /);
  return next > 0 ? rest.slice(0, next) : rest;
}

/** Phase modules that read an omitted column through a query of their own. */
const OWN_QUERY: Record<string, string[]> = {
  "finalizeReconciles.ts": ["managementAccess"],   // Phase 13.6: findMany select managementAccess
  "dhcpMacAssociation.ts": ["quarantineTargets"],  // auto-quarantine verify: findUnique select quarantineTargets
};

describe("DISCOVERY_ASSET_OMIT", () => {
  const cols = Object.keys(DISCOVERY_ASSET_OMIT);

  it("leaves out the VM blob and the per-asset selection arrays", () => {
    expect(cols).toEqual(expect.arrayContaining(["virtualization", "monitoredInterfaces", "monitoredProcesses"]));
    // Read by Phase 7 / Phase 3 / the prune: must stay in the row.
    for (const kept of ["associatedUsers", "fortinetTopology", "ipOverride", "ipBlankPinned", "primaryAddressIp", "hostnameOverride", "tags", "notes"]) {
      expect(cols).not.toContain(kept);
    }
  });

  const sources: Array<[string, string]> = [["syncDhcpSubnets", syncDhcpSubnetsBody()]];
  for (const f of readdirSync(join(ROOT, "dhcp")).filter((n) => n.endsWith(".ts"))) {
    sources.push([f, readFileSync(join(ROOT, "dhcp", f), "utf8")]);
  }

  it.each(sources)("%s reads no omitted column off a preloaded row", (name, raw) => {
    const code = stripComments(raw.replace(/\r\n/g, "\n"));
    const allowed = new Set(OWN_QUERY[name] ?? []);
    const hits = cols.filter((c) => !allowed.has(c) && new RegExp(`\\.${c}\\b|\\[["']${c}["']\\]`).test(code));
    expect(hits).toEqual([]);
  });
});
