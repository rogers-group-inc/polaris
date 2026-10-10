/**
 * tests/unit/primaryAddressPin.test.ts
 *
 * Business rule 102's pure halves: the db.ts guard decision for the
 * operator-pinned primary address (applyPrimaryAddressPin), and the discovery
 * sighting merge for the per-MAC address list (collapseSightings /
 * prunableSourcesFor).
 */

import { describe, it, expect } from "vitest";
import { applyPrimaryAddressPin, PIN_FOLLOW_STALE_MS } from "../../src/utils/assetInvariants.js";
import { collapseSightings, prunableSourcesFor, type AddressSighting } from "../../src/services/assetAddressService.js";

const NOW = Date.parse("2026-10-10T21:00:00Z");
const MAC = "AA:BB:CC:00:00:01";
const pin = { mac: MAC, ip: "10.0.0.5" };
const fresh = new Date(NOW - 60_000);
const stale = new Date(NOW - PIN_FOLLOW_STALE_MS - 60_000);

describe("applyPrimaryAddressPin", () => {
  it("rewrites a discovered address back to the pinned one and marks the source", () => {
    const data: Record<string, unknown> = { ipAddress: "10.0.0.9", ipSource: "GATE-1" };
    const out = applyPrimaryAddressPin(data, pin, [{ ip: "10.0.0.5", lastSeen: fresh }], NOW);
    expect(out).toEqual({ action: "reasserted", ip: "10.0.0.5" });
    expect(data.ipAddress).toBe("10.0.0.5");
    expect(data.ipSource).toBe("pinned");
  });

  it("handles the Prisma nested { set } shape", () => {
    const data: Record<string, unknown> = { ipAddress: { set: "10.0.0.9" }, ipSource: { set: "x" } };
    applyPrimaryAddressPin(data, pin, [], NOW);
    expect(data.ipAddress).toEqual({ set: "10.0.0.5" });
    expect(data.ipSource).toEqual({ set: "pinned" });
  });

  it("keeps the pin when the card has gone quiet entirely — the asset should show down", () => {
    const data: Record<string, unknown> = { ipAddress: "10.0.0.9" };
    const out = applyPrimaryAddressPin(data, pin, [{ ip: "10.0.0.5", lastSeen: stale }], NOW);
    expect(out.action).toBe("reasserted");
    expect(data.ipAddress).toBe("10.0.0.5");
    expect("primaryAddressIp" in data).toBe(false);
  });

  it("follows a renumbered card: pinned IP stale, exactly one recent address on the card", () => {
    const data: Record<string, unknown> = { ipAddress: "10.0.0.9" };
    const out = applyPrimaryAddressPin(data, pin, [
      { ip: "10.0.0.5", lastSeen: stale },
      { ip: "10.0.0.77", lastSeen: fresh },
    ], NOW);
    expect(out).toEqual({ action: "followed", fromIp: "10.0.0.5", ip: "10.0.0.77" });
    expect(data.ipAddress).toBe("10.0.0.77");
    expect(data.primaryAddressIp).toBe("10.0.0.77");
  });

  it("does not follow when the card has several recent addresses — it can't know which", () => {
    const data: Record<string, unknown> = { ipAddress: "10.0.0.9" };
    const out = applyPrimaryAddressPin(data, pin, [
      { ip: "10.0.0.5", lastSeen: stale },
      { ip: "10.0.0.77", lastSeen: fresh },
      { ip: "10.0.0.78", lastSeen: fresh },
    ], NOW);
    expect(out.action).toBe("reasserted");
    expect(data.ipAddress).toBe("10.0.0.5");
  });

  it("does not follow while the pinned IP is itself still recent (a secondary address appeared)", () => {
    const data: Record<string, unknown> = { ipAddress: "10.0.0.9" };
    const out = applyPrimaryAddressPin(data, pin, [
      { ip: "10.0.0.5", lastSeen: fresh },
      { ip: "10.0.0.77", lastSeen: fresh },
    ], NOW);
    expect(out.action).toBe("reasserted");
  });

  it("follows when the pinned IP's row is gone and the card has one recent address", () => {
    const data: Record<string, unknown> = { ipAddress: "10.0.0.9" };
    const out = applyPrimaryAddressPin(data, pin, [{ ip: "10.0.0.77", lastSeen: fresh }], NOW);
    expect(out.action).toBe("followed");
  });

  it("is a no-op without a pin, without a staged address, or on the pin routes' own writes", () => {
    expect(applyPrimaryAddressPin({ ipAddress: "1.2.3.4" }, { mac: null, ip: null }, [], NOW).action).toBe("none");
    expect(applyPrimaryAddressPin({ hostname: "x" }, pin, [], NOW).action).toBe("none");
    const own: Record<string, unknown> = { ipAddress: "10.0.0.6", primaryAddressIp: "10.0.0.6" };
    expect(applyPrimaryAddressPin(own, pin, [], NOW).action).toBe("none");
    expect(own.ipAddress).toBe("10.0.0.6");
    const clear: Record<string, unknown> = { ipAddress: "10.0.0.6", primaryAddressMac: null };
    expect(applyPrimaryAddressPin(clear, pin, [], NOW).action).toBe("none");
  });
});

describe("collapseSightings", () => {
  const base: AddressSighting = {
    assetId: "a1", mac: MAC, ip: "10.0.0.5", source: "arp", device: "GW", seenAt: new Date(NOW - 5000),
  };

  it("keeps one row per (asset, ip): the strongest source names it, the freshest time stands", () => {
    const out = collapseSightings([
      { ...base, source: "arp", seenAt: new Date(NOW) },
      { ...base, source: "dhcp-reservation", seenAt: new Date(NOW - 10_000), medium: "wired" },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]!.source).toBe("dhcp-reservation");
    expect(out[0]!.seenAt.getTime()).toBe(NOW);
    expect(out[0]!.medium).toBe("wired");
  });

  it("keeps a card's several addresses as several rows", () => {
    const out = collapseSightings([
      { ...base, ip: "10.0.0.5", source: "dhcp-reservation" },
      { ...base, ip: "10.0.0.6", source: "arp" },
      { ...base, ip: "10.0.0.7", source: "arp" },
    ]);
    expect(out.map((r) => r.ip).sort()).toEqual(["10.0.0.5", "10.0.0.6", "10.0.0.7"]);
  });

  it("a known medium beats unknown whichever sighting carries it", () => {
    const out = collapseSightings([
      { ...base, source: "device-inventory", medium: "unknown" },
      { ...base, source: "arp", medium: "wireless" },
    ]);
    expect(out[0]!.source).toBe("device-inventory");
    expect(out[0]!.medium).toBe("wireless");
  });

  it("drops a sighting missing its asset, MAC, IP or gate", () => {
    expect(collapseSightings([{ ...base, device: "" }, { ...base, ip: "" }])).toHaveLength(0);
  });
});

describe("prunableSourcesFor", () => {
  const scope = { dhcpDevices: ["GW-1"], inventoryDevices: ["GW-1", "GW-2"], arpDevices: ["GW-2"] };
  it("covers only the kinds whose read of that gate succeeded", () => {
    expect(prunableSourcesFor("GW-1", scope)).toEqual(["dhcp-lease", "dhcp-reservation", "device-inventory"]);
    expect(prunableSourcesFor("GW-2", scope)).toEqual(["device-inventory", "arp"]);
    expect(prunableSourcesFor("GW-3", scope)).toEqual([]);
  });
});
