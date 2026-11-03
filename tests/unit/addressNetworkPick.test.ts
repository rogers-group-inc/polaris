/**
 * tests/unit/addressNetworkPick.test.ts — which IPAM network an address sits
 * in for the asset panel (services/subnetService.ts → pickAddressNetwork):
 * narrowest containing network, the row's own gate where a range repeats
 * behind several gates, never another site's network by guesswork.
 */

import { describe, it, expect } from "vitest";
import { pickAddressNetwork } from "../../src/services/subnetService.js";

const net = (subnetId: string, cidr: string, masklen: number, gate: string | null, vlan: number | null = null) =>
  ({ subnetId, cidr, name: subnetId, vlan, gate, masklen });

describe("pickAddressNetwork", () => {
  it("takes the narrowest containing network", () => {
    const pick = pickAddressNetwork([net("wide", "10.0.0.0/16", 16, "A"), net("site", "10.0.5.0/24", 24, "A", 5)], null, null);
    expect(pick).toMatchObject({ subnetId: "site", vlan: 5 });
  });

  it("settles a repeated range by the row's gate, then the asset's gate", () => {
    const both = [net("a", "192.168.1.0/24", 24, "GW-A", 10), net("b", "192.168.1.0/24", 24, "GW-B", 20)];
    expect(pickAddressNetwork(both, "GW-B", "GW-A")).toMatchObject({ subnetId: "b" });
    expect(pickAddressNetwork(both, null, "GW-A")).toMatchObject({ subnetId: "a" });
    expect(pickAddressNetwork(both, "GW-C", null)).toBeNull();
  });

  it("has no answer with no containing network", () => {
    expect(pickAddressNetwork([], "GW-A", null)).toBeNull();
  });
});
