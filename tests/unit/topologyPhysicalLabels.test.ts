/**
 * tests/unit/topologyPhysicalLabels.test.ts — the Device Map never names an
 * aggregate on an edge label. A FortiLink trunk, an LACP bundle and the
 * FortiGate's `fortilink` interface are virtual; the cable lands on a member
 * port, so each label half is rewritten to that port or to "unknown".
 */

import { describe, it, expect, vi } from "vitest";

vi.mock("../../src/db.js", () => ({ prisma: {} }));

import { isLogicalInterfaceName, physicalLabelHalf } from "../../src/services/topologyGraphService.js";

const aggregates = new Set(["fortilink", "_FlInK1_MLAG0_", "8EF5920000001-0"]);
const isAgg = (n: string) => aggregates.has(n) || isLogicalInterfaceName(n);

describe("physicalLabelHalf", () => {
  it("leaves a physical port untouched", () => {
    expect(physicalLabelHalf("port17", isAgg, undefined, "port18")).toBe("port17");
  });

  it("swaps a single-member aggregate for its member", () => {
    expect(physicalLabelHalf("8EF5920000001-0", isAgg, ["port52"], null)).toBe("port52");
  });

  it("picks the LLDP-seen leg of a FortiLink split across an MCLAG pair", () => {
    // The FortiGate's fortilink has one member per core switch; the edge to
    // CORE1 is the leg LLDP saw CORE1 on.
    expect(physicalLabelHalf("fortilink", isAgg, ["port17", "port18"], "port17")).toBe("port17");
  });

  it("uses LLDP for a trunk whose membership was never scraped", () => {
    expect(physicalLabelHalf("_FlInK1_MLAG0_", isAgg, undefined, "port52")).toBe("port52");
  });

  it("degrades to unknown rather than printing the aggregate", () => {
    expect(physicalLabelHalf("_FlInK1_MLAG0_", isAgg, undefined, null)).toBe("unknown");
    expect(physicalLabelHalf("fortilink", isAgg, ["port17", "port18"], undefined)).toBe("unknown");
  });

  it("never takes an aggregate from LLDP either", () => {
    expect(physicalLabelHalf("_FlInK1_MLAG0_", isAgg, undefined, "fortilink")).toBe("unknown");
  });

  it("keeps unknown as unknown", () => {
    expect(physicalLabelHalf("unknown", isAgg, undefined, "port1")).toBe("unknown");
    expect(physicalLabelHalf("", isAgg, undefined, null)).toBe("unknown");
  });
});

describe("isLogicalInterfaceName", () => {
  it("recognises FortiOS logical interfaces by name", () => {
    expect(isLogicalInterfaceName("fortilink")).toBe(true);
    expect(isLogicalInterfaceName("_FlInK1_ICL0_")).toBe(true);
    expect(isLogicalInterfaceName("_FlInK1_MLAG0_")).toBe(true);
    expect(isLogicalInterfaceName("port52")).toBe(false);
    expect(isLogicalInterfaceName("fortilink2-port")).toBe(false);
  });
});
