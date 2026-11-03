/**
 * tests/unit/reservationMacLink.test.ts — the IP panel links a live
 * reservation to an asset through its MAC, never its hostname
 * (services/subnetService.ts → linkReservationsByMac), business rule 102(b).
 */

import { describe, it, expect } from "vitest";
import { linkReservationsByMac } from "../../src/services/subnetService.js";

const MAC = "84:8B:CD:4C:45:40";
const owner = (mac: string, id: string, hostname: string | null = id) => ({ mac, asset: { id, hostname } });

describe("linkReservationsByMac", () => {
  it("links an active reservation to the one asset listing its MAC, in any spelling", () => {
    const link = linkReservationsByMac([owner(MAC, "a1", "laptop")]);
    expect(link.assetFor({ status: "active", macAddress: "84-8b-cd-4c-45-40" })).toBe("a1");
    expect(link.hostnames.get("a1")).toBe("laptop");
  });

  it("links nothing for a released row, no MAC, the all-zero MAC, or an unknown MAC", () => {
    const link = linkReservationsByMac([owner(MAC, "a1"), owner("00:00:00:00:00:00", "a2")]);
    expect(link.assetFor({ status: "released", macAddress: MAC })).toBeNull();
    expect(link.assetFor({ status: "active", macAddress: null })).toBeNull();
    expect(link.assetFor({ status: "active", macAddress: "00:00:00:00:00:00" })).toBeNull();
    expect(link.assetFor({ status: "active", macAddress: "84:8B:CD:4C:45:99" })).toBeNull();
  });

  it("links nothing for a MAC two assets list", () => {
    const link = linkReservationsByMac([owner(MAC, "a1"), owner(MAC, "a2")]);
    expect(link.assetFor({ status: "active", macAddress: MAC })).toBeNull();
  });
});
