/**
 * tests/unit/fcReadByChips.test.ts — the Fibre Channel tab's read-source chips
 * (business rule 159): each source of the tab's rows worded like the CPU /
 * memory stream badge — method, cadence, tier — and, on a host, which switch
 * or integration it is.
 */

import { describe, it, expect } from "vitest";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { assetsFileSource } from "./_assetsSource.js";

function load() {
  const src = assetsFileSource("assets-network.js");
  const start = src.indexOf("function _fcReadByChipsHTML(");
  const end = src.indexOf("function _renderAssetFc(");
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  const labels = readFileSync(resolve(__dirname, "../../public/js/polling-methods.js"), "utf8");
  const lStart = labels.indexOf("var _POLLING_LABELS");
  const lEnd = labels.indexOf("};", lStart) + 2;
  const mon = assetsFileSource("assets-monitoring.js");
  const tStart = mon.indexOf("var _TIER_LABELS");
  const tEnd = mon.indexOf("};", tStart) + 2;
  const fStart = mon.indexOf("function _formatPollingInterval(");
  // Line-ending agnostic: a Windows checkout has CRLF on disk.
  const fTail = mon.slice(fStart).match(/\r?\n\}\r?\n/);
  const fEnd = fStart + (fTail?.index ?? -1) + (fTail?.[0].length ?? 0);
  const ctx: Record<string, unknown> = {
    escapeHtml: (s: unknown) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;"),
  };
  vm.createContext(ctx);
  vm.runInContext(
    labels.slice(lStart, lEnd) + "\n" + mon.slice(tStart, tEnd) + "\n" + mon.slice(fStart, fEnd) + "\n" +
      src.slice(start, end) + "\nthis._fcReadByChipsHTML = _fcReadByChipsHTML;",
    ctx,
  );
  return ctx._fcReadByChipsHTML as (r: unknown) => string;
}

const text = (html: string) => [...html.matchAll(/>([^<]*)<\/span>/g)].map((m) => m[1]);

describe("_fcReadByChipsHTML", () => {
  const chips = load();

  it("a switch's own tab: method, cadence and tier, no name", () => {
    expect(text(chips([{ source: "switch", method: "snmp", intervalSec: 600, tier: "default", monitored: true, via: null }])))
      .toEqual(["SNMP · every 10m · Source default"]);
  });

  it("a host: each switch by name, then the HBAs' source with its integration", () => {
    expect(text(chips([
      { source: "switch", method: "snmp", intervalSec: 600, tier: "integration", monitored: true, via: { kind: "asset", id: "a", name: "mds-a" } },
      { source: "switch", method: "snmp", intervalSec: null, tier: "default", monitored: false, via: { kind: "asset", id: "b", name: "mds-b" } },
      { source: "vcenter", method: "vcenter", intervalSec: 14400, tier: null, monitored: true, via: { kind: "integration", id: "vc", name: "vCenter Prod" } },
      { source: "agent", method: "agent", intervalSec: 300, tier: null, monitored: true, via: null },
    ]))).toEqual([
      "mds-a · SNMP · every 10m · Integration",
      "mds-b · not monitored",
      "HBAs · vCenter · every 4h · vCenter Prod",
      "HBAs · Polaris Agent · every 5m",
    ]);
  });

  it("draws nothing without sources", () => {
    expect(chips(undefined)).toBe("");
    expect(chips([])).toBe("");
  });
});
