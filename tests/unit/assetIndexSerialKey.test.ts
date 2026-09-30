/**
 * tests/unit/assetIndexSerialKey.test.ts
 *
 * `AssetIndex` is how every discovery loop asks "do I already have this
 * device?". A lookup that misses does not fail loudly — it CREATES A SECOND
 * ASSET, and the duplicate only surfaces days later as two monitored records
 * polling one device.
 *
 * The serial index used to be the one identity key stored verbatim while MAC
 * and hostname were normalized, so a gate reporting a differently-cased or
 * padded serial missed. The FortiSwitch/FortiAP/firewall loops look up serial
 * FIRST, and their next rung is MAC — null on a FortiSwitch until the 2026-08
 * baseMac capture — so the miss fell straight through to hostname.
 *
 * These pin the property that matters: every key is compared after the same
 * normalization it was stored under, and `add`/`remove`/`find` agree.
 */

import { describe, it, expect } from "vitest";
import { AssetIndex } from "../../src/services/discovery/discoveryEngine.js";

const SERIAL = "S108FFTV21018409";

function asset(over: Record<string, unknown> = {}) {
  return {
    id: "asset-1",
    hostname: "PRINTER-BOX-SWITCH",
    serialNumber: SERIAL,
    macAddress: null,
    ipAddress: null,
    macAddresses: [],
    ...over,
  };
}

describe("AssetIndex serial key normalization", () => {
  it("finds a stored serial when the device reports it lower-cased", () => {
    const idx = new AssetIndex([asset()]);
    expect(idx.findBySerial(SERIAL.toLowerCase())?.id).toBe("asset-1");
  });

  it("finds a stored serial when the device pads it with whitespace", () => {
    const idx = new AssetIndex([asset()]);
    expect(idx.findBySerial(`  ${SERIAL}  `)?.id).toBe("asset-1");
  });

  it("finds a lower-cased STORED serial from an upper-cased report", () => {
    // The mirror case: normalization has to happen on the way in too, not
    // only on the way out, or an install whose gates once wrote lower-case
    // serials stays unmatchable.
    const idx = new AssetIndex([asset({ serialNumber: SERIAL.toLowerCase() })]);
    expect(idx.findBySerial(SERIAL)?.id).toBe("asset-1");
  });

  it("still does not match a genuinely different serial", () => {
    const idx = new AssetIndex([asset()]);
    expect(idx.findBySerial("S108FFTV21018410")).toBeUndefined();
  });

  it("remove() drops the normalized key, so a deleted asset is not resurrected", () => {
    // remove() keys its own delete; if it computed the key differently from
    // add(), the entry would survive and later lookups would hand out an
    // asset row that no longer exists.
    const a = asset({ serialNumber: ` ${SERIAL.toLowerCase()} ` });
    const idx = new AssetIndex([a]);
    expect(idx.findBySerial(SERIAL)?.id).toBe("asset-1");
    idx.remove(a);
    expect(idx.findBySerial(SERIAL)).toBeUndefined();
  });

  it("matches the key the rule 83 duplicate-serial sweep groups on", () => {
    // Both sides must agree about what one serial is, or the sweep reports a
    // duplicate the lookup cannot see (and vice versa).
    const idx = new AssetIndex([asset({ serialNumber: ` ${SERIAL} ` })]);
    expect(idx.findBySerial(SERIAL.toLowerCase())?.id).toBe("asset-1");
  });
});
