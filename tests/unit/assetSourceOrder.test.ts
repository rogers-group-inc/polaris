/**
 * tests/unit/assetSourceOrder.test.ts — the presentation order and per-
 * integration collapse shared by the asset Sources tab and the Assets table's
 * Sources column (business rule 197).
 */

import { describe, it, expect } from "vitest";
import { orderAndCollapseSources } from "../../src/utils/assetSourceOrder.js";

const src = (sourceKind: string, integrationId: string | null, lastSeen: string | null, tag = "") =>
  ({ sourceKind, integrationId, lastSeen: lastSeen ? new Date(lastSeen) : null, tag });

describe("orderAndCollapseSources", () => {
  it("orders identity sources first, enrichment under them, unknown kinds in between, manual last", () => {
    const out = orderAndCollapseSources([
      src("manual", null, "2026-01-01"),
      src("snmp-sysdescr", null, "2026-01-01"),
      src("vcenter-vm", "vc", "2026-01-01"),
      src("fortigate-firewall", "fmg", "2026-01-01"),
      src("entra", "ent", "2026-01-01"),
    ]);
    expect(out.map((s) => s.sourceKind)).toEqual(["entra", "fortigate-firewall", "snmp-sysdescr", "vcenter-vm", "manual"]);
  });

  it("keeps only the newest row per kind + integration, but one per integration", () => {
    const out = orderAndCollapseSources([
      src("fortigate-endpoint", "gate-a", "2026-01-01", "old-mac"),
      src("fortigate-endpoint", "gate-a", "2026-03-01", "new-mac"),
      src("fortigate-endpoint", "gate-b", "2026-02-01", "other-gate"),
    ]);
    expect(out.map((s) => s.tag)).toEqual(["new-mac", "other-gate"]);
  });

  it("treats a null integration as its own key and a null lastSeen as oldest", () => {
    const out = orderAndCollapseSources([
      src("ad", null, null, "never"),
      src("ad", null, "2026-01-01", "seen"),
    ]);
    expect(out.map((s) => s.tag)).toEqual(["seen"]);
  });

  it("does not mutate its input", () => {
    const input = [src("manual", null, null), src("entra", "e", null)];
    orderAndCollapseSources(input);
    expect(input.map((s) => s.sourceKind)).toEqual(["manual", "entra"]);
  });
});
