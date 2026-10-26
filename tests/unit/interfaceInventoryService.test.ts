/**
 * tests/unit/interfaceInventoryService.test.ts
 *
 * Pure-function coverage for the current-state interface inventory. The
 * DB-bound half (delete-replace, firstSeen preservation) is exercised in
 * tests/integration/interfaceInventory.test.ts.
 */

import { describe, it, expect } from "vitest";
import {
  dedupeAndCapInterfaces,
  INTERFACE_ROW_CAP,
  nativeVlanSignature,
} from "../../src/services/interfaceInventoryService.js";

// The edge trigger for the business rule 133 tag reconcile: a scrape fires it
// only when a port's native VLAN actually changed.
describe("nativeVlanSignature", () => {
  it("is order-independent", () => {
    expect(nativeVlanSignature([{ ifName: "port2", nativeVlan: 30 }, { ifName: "port1", nativeVlan: 10 }]))
      .toBe(nativeVlanSignature([{ ifName: "port1", nativeVlan: 10 }, { ifName: "port2", nativeVlan: 30 }]));
  });
  it("ignores ports with no native VLAN, so a router's scrape never differs", () => {
    expect(nativeVlanSignature([{ ifName: "wan1", nativeVlan: null }, { ifName: "lo" }])).toBe("");
    expect(nativeVlanSignature([{ ifName: "port1", nativeVlan: 10 }, { ifName: "port9", nativeVlan: null }]))
      .toBe(nativeVlanSignature([{ ifName: "port1", nativeVlan: 10 }]));
  });
  it("differs when a port moves VLAN or a VLAN port appears or goes", () => {
    const base = nativeVlanSignature([{ ifName: "port1", nativeVlan: 10 }]);
    expect(nativeVlanSignature([{ ifName: "port1", nativeVlan: 20 }])).not.toBe(base);
    expect(nativeVlanSignature([{ ifName: "port1", nativeVlan: 10 }, { ifName: "port2", nativeVlan: 10 }])).not.toBe(base);
    expect(nativeVlanSignature([])).not.toBe(base);
  });
});

const if_ = (ifName: string) => ({ ifName });

describe("dedupeAndCapInterfaces", () => {
  it("passes a normal interface list through untouched", () => {
    const rows = [if_("port1"), if_("port2"), if_("wan1")];
    const out = dedupeAndCapInterfaces(rows);
    expect(out.rows.map((r) => r.ifName)).toEqual(["port1", "port2", "wan1"]);
    expect(out.duplicates).toBe(0);
    expect(out.dropped).toBe(0);
  });

  it("returns empty for an empty list", () => {
    expect(dedupeAndCapInterfaces([])).toEqual({ rows: [], duplicates: 0, dropped: 0 });
  });

  // (assetId, ifName) is UNIQUE — a duplicate would abort the whole
  // delete-replace transaction and lose an otherwise-good scrape.
  it("keeps the FIRST occurrence of a duplicate ifName and counts it", () => {
    const out = dedupeAndCapInterfaces([
      { ifName: "port1", operStatus: "up" },
      { ifName: "port2", operStatus: "up" },
      { ifName: "port1", operStatus: "down" },
    ] as Array<{ ifName: string; operStatus: string }>);
    expect(out.rows.map((r) => r.ifName)).toEqual(["port1", "port2"]);
    expect(out.rows[0].operStatus).toBe("up");
    expect(out.duplicates).toBe(1);
  });

  it("skips rows with a missing or empty ifName without counting them as duplicates", () => {
    const out = dedupeAndCapInterfaces([
      if_("port1"),
      { ifName: "" },
      // A collector returning a malformed row shouldn't abort the scrape.
      undefined as unknown as { ifName: string },
    ]);
    expect(out.rows.map((r) => r.ifName)).toEqual(["port1"]);
    expect(out.duplicates).toBe(0);
  });

  it("caps at INTERFACE_ROW_CAP and reports how many were dropped", () => {
    const rows = Array.from({ length: INTERFACE_ROW_CAP + 25 }, (_, n) => if_(`port${n}`));
    const out = dedupeAndCapInterfaces(rows);
    expect(out.rows).toHaveLength(INTERFACE_ROW_CAP);
    expect(out.dropped).toBe(25);
    // Truncation keeps the head of the list, so it is deterministic across
    // scrapes rather than an arbitrary subset that churns the table.
    expect(out.rows[0].ifName).toBe("port0");
  });

  it("does not let duplicates consume cap headroom", () => {
    // 3 unique names repeated: the cap must count distinct rows kept, not rows
    // examined, or a chatty device could truncate itself out of the table.
    const rows = Array.from({ length: 60 }, (_, n) => if_(`port${n % 3}`));
    const out = dedupeAndCapInterfaces(rows);
    expect(out.rows).toHaveLength(3);
    expect(out.dropped).toBe(0);
    expect(out.duplicates).toBe(57);
  });
});
