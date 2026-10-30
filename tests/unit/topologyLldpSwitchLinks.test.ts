/**
 * tests/unit/topologyLldpSwitchLinks.test.ts — the Device Map's switch↔switch
 * links evidenced by LLDP alone. Interface-name inference only catches FortiOS
 * peer aggregates named after the peer, so two FortiSwitches joined by a plain
 * fiber ISL showed no line between them though both reported the other over
 * LLDP; `lldpOnlySwitchLinks` supplies that link.
 */

import { describe, it, expect, vi } from "vitest";

vi.mock("../../src/db.js", () => ({ prisma: {} }));

import { lldpOnlySwitchLinks } from "../../src/services/topologyGraphService.js";

const NOW = new Date("2026-10-29T12:00:00Z");
const CUTOFF = new Date(NOW.getTime() - 60 * 60 * 1000);
const SWITCHES = new Set(["sw1", "sw2", "sw3"]);

const row = (over: Record<string, unknown>) => ({
  assetId: "sw1",
  matchedAssetId: "sw2",
  localIfName: "port49",
  portId: "port50",
  portIdSubtype: "interfaceName",
  lastSeen: NOW,
  ...over,
});

describe("lldpOnlySwitchLinks", () => {
  it("draws one link for two switches that see each other over LLDP", () => {
    const links = lldpOnlySwitchLinks(
      [row({}), row({ assetId: "sw2", matchedAssetId: "sw1", localIfName: "port50", portId: "port49" })],
      SWITCHES, new Set(), CUTOFF,
    );
    expect(links).toEqual([{ source: "sw1", target: "sw2", sourceIfName: "port49", targetIfName: "port50" }]);
  });

  it("uses the advertised port-id for the far side when only one switch reports", () => {
    const links = lldpOnlySwitchLinks([row({})], SWITCHES, new Set(), CUTOFF);
    expect(links).toEqual([{ source: "sw1", target: "sw2", sourceIfName: "port49", targetIfName: "port50" }]);
  });

  it("prefers the peer's own local port over the advertised port-id", () => {
    const links = lldpOnlySwitchLinks(
      [row({ portId: "Gi1/0/50" }), row({ assetId: "sw2", matchedAssetId: "sw1", localIfName: "port50" })],
      SWITCHES, new Set(), CUTOFF,
    );
    expect(links[0].targetIfName).toBe("port50");
  });

  it("ignores MAC-form port-ids and synthetic port-<ifIndex> names", () => {
    const links = lldpOnlySwitchLinks(
      [row({ localIfName: "port-12", portId: "aa:bb:cc:dd:ee:ff", portIdSubtype: "macAddress" })],
      SWITCHES, new Set(), CUTOFF,
    );
    expect(links).toEqual([{ source: "sw1", target: "sw2", sourceIfName: null, targetIfName: null }]);
  });

  it("skips a pair another edge class already drew", () => {
    const links = lldpOnlySwitchLinks([row({})], SWITCHES, new Set(["sw1|sw2"]), CUTOFF);
    expect(links).toEqual([]);
  });

  it("skips rows older than the cutoff (a cable that moved)", () => {
    const links = lldpOnlySwitchLinks(
      [row({ lastSeen: new Date(CUTOFF.getTime() - 1) })],
      SWITCHES, new Set(), CUTOFF,
    );
    expect(links).toEqual([]);
  });

  it("only links two in-site switches — not an AP, the gate, an unmatched or a self row", () => {
    const links = lldpOnlySwitchLinks(
      [
        row({ matchedAssetId: "ap1" }),
        row({ assetId: "fg", matchedAssetId: "sw1" }),
        row({ matchedAssetId: null }),
        row({ matchedAssetId: "sw1" }),
      ],
      SWITCHES, new Set(), CUTOFF,
    );
    expect(links).toEqual([]);
  });
});
