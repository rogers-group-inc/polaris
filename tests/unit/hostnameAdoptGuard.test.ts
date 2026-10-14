/**
 * tests/unit/hostnameAdoptGuard.test.ts
 *
 * Business rule 91(b) (re-scan F2): a DHCP client picks its own hostname, so a
 * lease or detected-device row that matched an asset by hostname alone must
 * not re-address a PROTECTED asset (monitored, or carrying a credential).
 * These pin the two pure halves: which assets are protected, and how
 * AssetIndex reports the rung a match rested on — including that a MAC
 * recorded from a refused match is NOT identity on the next lookup.
 */

import { describe, it, expect } from "vitest";
import { AssetIndex } from "../../src/services/discovery/discoveryEngine.js";
import { isHostnameAdoptProtected, ASSET_CREDENTIAL_COLUMNS } from "../../src/utils/hostnameAdoptGuard.js";
import { UNVERIFIED_HOSTNAME_MAC_SOURCE } from "../../src/utils/macAddresses.js";

describe("isHostnameAdoptProtected", () => {
  it("is false for an unmonitored asset with no credentials, and for nothing", () => {
    expect(isHostnameAdoptProtected({ monitored: false })).toBe(false);
    expect(isHostnameAdoptProtected({})).toBe(false);
    expect(isHostnameAdoptProtected(null)).toBe(false);
    expect(isHostnameAdoptProtected(undefined)).toBe(false);
  });

  it("is true for a monitored asset", () => {
    expect(isHostnameAdoptProtected({ monitored: true })).toBe(true);
  });

  it("is true for an unmonitored asset carrying ANY credential column", () => {
    for (const col of ASSET_CREDENTIAL_COLUMNS) {
      expect(isHostnameAdoptProtected({ monitored: false, [col]: "cred-1" })).toBe(true);
    }
  });

  it("covers all nine Asset credential reference columns", () => {
    expect(ASSET_CREDENTIAL_COLUMNS).toHaveLength(9);
  });
});

function asset(over: Record<string, unknown> = {}) {
  return {
    id: "asset-1", hostname: "SRV-DB01", serialNumber: null, ipAddress: "10.0.0.10",
    macAddress: "AA:AA:AA:AA:AA:01",
    macAddresses: [{ mac: "AA:AA:AA:AA:AA:01", source: "dhcp-lease", lastSeen: "2026-10-01T00:00:00.000Z" }],
    ...over,
  };
}

describe("AssetIndex.findByEntryWithRung", () => {
  it("reports the mac rung when the entry's MAC is known", () => {
    const idx = new AssetIndex([asset()]);
    const hit = idx.findByEntryWithRung("aa-aa-aa-aa-aa-01", "SRV-DB01", "10.0.0.99", { allowIpFallback: false });
    expect(hit?.asset.id).toBe("asset-1");
    expect(hit?.rung).toBe("mac");
  });

  it("reports the hostname rung when only the (case-folded) name matches", () => {
    const idx = new AssetIndex([asset()]);
    const hit = idx.findByEntryWithRung("EE:EE:EE:EE:EE:01", "srv-db01", "10.0.0.99", { allowIpFallback: false });
    expect(hit?.asset.id).toBe("asset-1");
    expect(hit?.rung).toBe("hostname");
  });

  it("reports the ip rung only when the IP fallback is allowed", () => {
    const idx = new AssetIndex([asset()]);
    expect(idx.findByEntryWithRung(undefined, "OTHER", "10.0.0.10")?.rung).toBe("ip");
    expect(idx.findByEntryWithRung(undefined, "OTHER", "10.0.0.10", { allowIpFallback: false })).toBeUndefined();
  });

  it("findByEntry still returns the bare asset", () => {
    const idx = new AssetIndex([asset()]);
    expect(idx.findByEntry("EE:EE:EE:EE:EE:01", "SRV-DB01")?.id).toBe("asset-1");
  });

  it("an unverified hostname-only MAC is not indexed: the next lookup is still hostname-rung", () => {
    const a = asset({
      macAddresses: [
        { mac: "AA:AA:AA:AA:AA:01", source: "dhcp-lease", lastSeen: "2026-10-01T00:00:00.000Z" },
        { mac: "EE:EE:EE:EE:EE:01", source: UNVERIFIED_HOSTNAME_MAC_SOURCE, lastSeen: "2026-10-14T00:00:00.000Z" },
      ],
    });
    const idx = new AssetIndex([a]);
    expect(idx.findByMac("EE:EE:EE:EE:EE:01")).toBeUndefined();
    expect(idx.findByEntryWithRung("EE:EE:EE:EE:EE:01", "SRV-DB01")?.rung).toBe("hostname");
    // ...and an attacker who also changes the name matches nothing.
    expect(idx.findByEntryWithRung("EE:EE:EE:EE:EE:01", "LAPTOP-X", undefined, { allowIpFallback: false })).toBeUndefined();
  });

  it("an unverified MAC that ended up primary (asset had no MAC) is not indexed either", () => {
    const a = asset({
      macAddress: "EE:EE:EE:EE:EE:01",
      macAddresses: [{ mac: "EE:EE:EE:EE:EE:01", source: UNVERIFIED_HOSTNAME_MAC_SOURCE, lastSeen: "2026-10-14T00:00:00.000Z" }],
    });
    const idx = new AssetIndex([a]);
    expect(idx.findByMac("EE:EE:EE:EE:EE:01")).toBeUndefined();
  });
});
