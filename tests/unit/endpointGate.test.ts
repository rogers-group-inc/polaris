/**
 * Business rule 101(b): an endpoint's gate is the gate whose IPAM network
 * holds its primary address — overlapping RFC1918 space is settled by the
 * caller's candidates, never guessed.
 */
import { describe, it, expect } from "vitest";
import { gateServingAddress } from "../../src/utils/endpointGate.js";

const net = (cidr: string, fortigateDevice: string | null, status = "available") => ({ cidr, fortigateDevice, status });

describe("gateServingAddress", () => {
  it("names the gate whose network holds the primary address, over the pathway's gate", () => {
    const subnets = [net("10.1.0.0/24", "FGT-A"), net("10.2.0.0/24", "FGT-B")];
    expect(gateServingAddress("10.1.0.20", subnets, ["FGT-B"])).toBe("FGT-A");
  });

  it("takes the narrowest gate-owned network", () => {
    const subnets = [net("10.0.0.0/16", "FGT-CORE"), net("10.0.5.0/24", "FGT-SITE")];
    expect(gateServingAddress("10.0.5.9", subnets)).toBe("FGT-SITE");
    expect(gateServingAddress("10.0.6.9", subnets)).toBe("FGT-CORE");
  });

  it("ignores deprecated networks and networks no gate owns", () => {
    const subnets = [net("10.1.0.0/24", "FGT-OLD", "deprecated"), net("10.1.0.0/25", null), net("10.1.0.0/16", "FGT-NEW")];
    expect(gateServingAddress("10.1.0.20", subnets)).toBe("FGT-NEW");
  });

  it("settles an overlap from the candidates in order, and refuses to guess otherwise", () => {
    const subnets = [net("192.168.1.0/24", "FGT-A"), net("192.168.1.0/24", "FGT-B")];
    expect(gateServingAddress("192.168.1.5", subnets, [undefined, "FGT-B"])).toBe("FGT-B");
    expect(gateServingAddress("192.168.1.5", subnets, ["FGT-A", "FGT-B"])).toBe("FGT-A");
    expect(gateServingAddress("192.168.1.5", subnets, ["FGT-C"])).toBeNull();
  });

  it("has no opinion without an address or a containing network", () => {
    const subnets = [net("10.1.0.0/24", "FGT-A")];
    expect(gateServingAddress(null, subnets)).toBeNull();
    expect(gateServingAddress("172.16.0.1", subnets, ["FGT-A"])).toBeNull();
  });
});
