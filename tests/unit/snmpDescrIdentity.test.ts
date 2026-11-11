/**
 * tests/unit/snmpDescrIdentity.test.ts — `parseVendorSysDescr`
 * (src/utils/snmpDescrIdentity.ts).
 *
 * The system group has no model object, so `snmpIdentity` refused to invent
 * one from sysDescr. This file is the exception it allows: a vendor that
 * publishes a FIXED delimited layout can be parsed rather than guessed at.
 *
 * What's pinned, and why each is a decision rather than an implementation
 * detail:
 *
 *  - **The parser anchors on the vendor token, it does not count fields from
 *    the left.** AXIS field 1 is an operator-settable device name — empty out
 *    of the box, populated the moment someone names the camera — so a
 *    positional read is wrong on exactly the devices that have been touched.
 *  - **A field is claimed only when it is shaped like what it should be.** The
 *    firmware slot must look like a version. A vendor reordering its own
 *    format across a generation yields LESS detail, never wrong detail.
 *  - **A pre-filter match with an unreadable layout yields nothing** — not the
 *    manufacturer alone, which would claim the vendor off a string we just
 *    failed to parse.
 *  - **Unknown vendors yield undefined.** Most devices are unknown vendors,
 *    and the caller must be left with exactly the identity it already had.
 */

import { describe, it, expect } from "vitest";
import {
  parseVendorSysDescr,
  sameDescrObserved,
  descrReadDue,
  DESCR_READ_INTERVAL_SEC,
} from "../../src/utils/snmpDescrIdentity.js";

/**
 * The real reading off a prod camera, verbatim — leading empty name field and
 * all. Every AXIS expectation below is anchored to this string rather than to
 * a tidied-up version of it.
 */
const AXIS_M2036 =
  "; AXIS M2036-LE; Bullet Camera; 10.12.114; Oct 03 2022 14:20; 7EC.1; 1";

describe("parseVendorSysDescr — AXIS", () => {
  it("reads manufacturer, model, product type and firmware off a real camera", () => {
    expect(parseVendorSysDescr(AXIS_M2036)).toEqual({
      manufacturer: "Axis Communications",
      model: "M2036-LE",
      productType: "Bullet Camera",
      osVersion: "10.12.114",
    });
  });

  it("reads the same fields once the camera has been given a name", () => {
    // The name lands in field 1, shifting every other field right. This is the
    // case a left-counting parser gets wrong.
    const named = parseVendorSysDescr(
      "front-door-cam; AXIS M2036-LE; Bullet Camera; 10.12.114; Oct 03 2022 14:20; 7EC.1; 1",
    );
    expect(named?.model).toBe("M2036-LE");
    expect(named?.osVersion).toBe("10.12.114");
    expect(named?.productType).toBe("Bullet Camera");
  });

  it("reads an older four-part firmware and a dome model", () => {
    const dome = parseVendorSysDescr(
      "AXIS P3364-LVE; Network Fixed Dome Camera; 5.55.4.1; Nov 27 2014 11:00; 18C; 0;",
    );
    expect(dome?.model).toBe("P3364-LVE");
    expect(dome?.osVersion).toBe("5.55.4.1");
    expect(dome?.productType).toBe("Network Fixed Dome Camera");
  });

  it("takes the firmware from the next field when the type field is absent", () => {
    const terse = parseVendorSysDescr("; AXIS M2036-LE; 10.12.114; Oct 03 2022 14:20");
    expect(terse?.model).toBe("M2036-LE");
    expect(terse?.osVersion).toBe("10.12.114");
    // And does not store the version as what the device is.
    expect(terse?.productType).toBeUndefined();
  });

  it("still names the model when nothing after it is readable", () => {
    const partial = parseVendorSysDescr("; AXIS M2036-LE; ; ;");
    expect(partial?.model).toBe("M2036-LE");
    expect(partial?.osVersion).toBeUndefined();
  });

  it("does not claim a firmware from a slot that is not version-shaped", () => {
    const odd = parseVendorSysDescr("; AXIS M2036-LE; Bullet Camera; RELEASE_BUILD_7; x; y");
    expect(odd?.model).toBe("M2036-LE");
    expect(odd?.osVersion).toBeUndefined();
    expect(odd?.productType).toBe("Bullet Camera");
  });

  it("is case-insensitive about the vendor token", () => {
    expect(parseVendorSysDescr("; Axis M2036-LE; Bullet Camera; 10.12.114")?.model)
      .toBe("M2036-LE");
  });

  it("yields nothing when the vendor word appears with no model after it", () => {
    // The pre-filter must not be enough on its own to claim the vendor.
    expect(parseVendorSysDescr("Some device; AXIS; ; ;")).toBeUndefined();
  });

  it("yields nothing for prose that merely mentions the vendor", () => {
    expect(
      parseVendorSysDescr("Linux nvr 5.4.0; recording from AXIS cameras; 1.0"),
    ).toBeUndefined();
  });

  it("bounds a malformed model rather than storing a paragraph", () => {
    const long = parseVendorSysDescr("; AXIS " + "M".repeat(500) + "; Bullet Camera; 10.1");
    expect(long?.model?.length).toBe(64);
  });
});

describe("parseVendorSysDescr — everything else", () => {
  it("returns undefined for vendors whose layout is not in the table", () => {
    for (const descr of [
      "Cisco IOS Software, C2960 Software, Version 15.0(2)SE11",
      "FortiSwitch-148F v7.2.5,build0123,220401",
      "Hardware: Intel64 Family 6 - Software: Windows Version 6.3",
      // APC's anchor with nothing version-shaped inside it — no opinion.
      "APC Web/SNMP Management Card (MB:unknown PF:unknown)",
      // An APC string that is not the NMC format.
      "APC Embedded PowerNet SNMP Agent (SW v2.2, HW vB2, Mod: AP9605)",
    ]) {
      expect(parseVendorSysDescr(descr), descr).toBeUndefined();
    }
  });

  it("returns undefined for undelimited, empty and missing input", () => {
    expect(parseVendorSysDescr("AXIS M2036-LE Bullet Camera 10.12.114")).toBeUndefined();
    expect(parseVendorSysDescr("")).toBeUndefined();
    expect(parseVendorSysDescr(undefined)).toBeUndefined();
  });

  it("never throws on hostile input", () => {
    for (const descr of [";;;;;;;;", ";".repeat(5000), "\u0000; AXIS ;", "; AXIS \n\n ;"]) {
      expect(() => parseVendorSysDescr(descr)).not.toThrow();
    }
  });
});

describe("sameDescrObserved — the monitor path's no-I/O gate", () => {
  const reading = {
    manufacturer: "Axis Communications",
    model: "M2036-LE",
    osVersion: "10.12.114",
    productType: "Bullet Camera",
    // The raw reading is part of the comparison: a vendor that changes its
    // build date or hardware id has changed what it says, and the Sources tab
    // shows that string, so it has to be re-recorded.
    sysDescr: "; AXIS M2036-LE; Bullet Camera; 10.12.114; Oct 03 2022 14:20; 7EC.1; 1",
  };

  it("is true when the device said exactly what we last recorded", () => {
    // The steady state for every camera on every pass: one indexed read, no
    // write, no projection, no event.
    expect(sameDescrObserved({ ...reading }, reading)).toBe(true);
  });

  it("is false on a firmware upgrade, a swap, and a vendor correction", () => {
    expect(sameDescrObserved({ ...reading, osVersion: "10.12.100" }, reading)).toBe(false);
    expect(sameDescrObserved({ ...reading, model: "P3364-LVE" }, reading)).toBe(false);
    expect(sameDescrObserved({ ...reading, manufacturer: "ServerTech" }, reading)).toBe(false);
  });

  it("is false with nothing recorded yet, so the first reading always lands", () => {
    expect(sameDescrObserved(null, reading)).toBe(false);
    expect(sameDescrObserved(undefined, reading)).toBe(false);
  });

  it("does not treat absent, null, empty and whitespace as changes", () => {
    // Field-wise, not JSON-wise: a row written before productType existed
    // must not re-write on every pass just for carrying fewer keys.
    const terse = { manufacturer: "Axis Communications", model: "M2036-LE" };
    expect(sameDescrObserved(terse, { ...terse, osVersion: null, os: null, productType: "" }))
      .toBe(true);
    expect(sameDescrObserved({ ...terse, model: "   " }, { ...terse, model: null }))
      .toBe(true);
  });

  it("ignores key order and keys outside the compared set", () => {
    const reordered: Record<string, unknown> = {};
    for (const k of Object.keys(reading).reverse()) reordered[k] = (reading as any)[k];
    reordered.readAt = "2026-09-04T12:00:00Z";
    expect(sameDescrObserved(reordered, reading)).toBe(true);
  });

  it("is false when only the raw descr changed", () => {
    // Same model and firmware, new build date — the parsed fields agree, so a
    // comparison over them alone would never re-record the string the Sources
    // tab displays.
    const rebuilt = { ...reading, sysDescr: reading.sysDescr.replace("Oct 03 2022", "Nov 14 2022") };
    expect(sameDescrObserved(rebuilt, reading)).toBe(false);
  });

  it("compares only strings, so a malformed stored blob reads as changed", () => {
    expect(sameDescrObserved({ model: 42 } as any, { model: "42" })).toBe(false);
  });
});

describe("descrReadDue — what makes the probe carry the extra varbind", () => {
  const now = new Date("2026-09-04T12:00:00Z");
  const agoSec = (n: number) => new Date(now.getTime() - n * 1000);

  it("is due when never read, so existing assets pick identity up once", () => {
    expect(descrReadDue(null, now)).toBe(true);
    expect(descrReadDue(undefined, now)).toBe(true);
  });

  it("is not due inside the interval, and due at it", () => {
    expect(descrReadDue(agoSec(DESCR_READ_INTERVAL_SEC - 1), now)).toBe(false);
    expect(descrReadDue(agoSec(DESCR_READ_INTERVAL_SEC), now)).toBe(true);
  });

  it("carries the varbind on one probe in ten at a 60s cadence", () => {
    // The whole cost argument, simulated the way it actually runs: each probe
    // that carries the read stamps the anchor, so the following nine at 60s
    // spacing skip it. Ten probes, one extra varbind.
    let stamp: Date | null = null;
    let carried = 0;
    for (let i = 0; i < 10; i++) {
      const at = new Date(now.getTime() + i * 60_000);
      if (descrReadDue(stamp, at)) { carried++; stamp = at; }
    }
    expect(carried).toBe(1);
  });

  it("carries it again once the interval has passed", () => {
    let stamp: Date | null = null;
    let carried = 0;
    // An hour of 60s probes: the read lands every ten minutes, six times.
    for (let i = 0; i < 60; i++) {
      const at = new Date(now.getTime() + i * 60_000);
      if (descrReadDue(stamp, at)) { carried++; stamp = at; }
    }
    expect(carried).toBe(6);
  });

  it("reads a future stamp as due rather than parking the asset", () => {
    // Clock skew or a restored backup must not freeze identity until the
    // wall clock catches up.
    expect(descrReadDue(new Date(now.getTime() + 86_400_000), now)).toBe(true);
  });

  it("treats an invalid stamp as due", () => {
    expect(descrReadDue(new Date(NaN), now)).toBe(true);
  });
});

describe("parseVendorSysDescr — APC Network Management Card (business rule 161)", () => {
  /** A real prod reading off an AP8870 rack PDU (NMC3, rPDU2g), verbatim. */
  const APC_AP8870 =
    "APC Web/SNMP Management Card (MB:v4.2.9 PF:v1.5.1.1 PN:apc_hw21_aos_1.5.1.1.bin " +
    "AF1:v1.2.0.4 AN1:apc_hw21_rpdu2g_1.2.0.4.bin MN:AP8870 HR:03 SN: ZA2406030655 MD:02/10/2024)";
  /** Its sysObjectID: PowerNet-MIB masterSwitchrPDU2. */
  const RPDU2 = "1.3.6.1.4.1.318.1.3.4.6";
  /**
   * The UPS shape — an AP9631 in a Smart-UPS's SmartSlot. MN / SN are the
   * CARD's, which is the whole reason the sysObjectID gate exists.
   */
  const APC_UPS_CARD =
    "APC Web/SNMP Management Card (MB:v4.1.0 PF:v6.8.2 PN:apc_hw05_aos_682.bin " +
    "AF1:v6.8.2 AN1:apc_hw05_sumx_682.bin MN:AP9631 HR:05 SN: ZA1234567890 MD:03/01/2019) " +
    "(Embedded PowerNet SNMP Agent SW v2.2 compatible)";
  const SMART_UPS = "1.3.6.1.4.1.318.1.3.27";

  it("reads model, serial, firmware and type off a rack PDU", () => {
    expect(parseVendorSysDescr(APC_AP8870, RPDU2)).toEqual({
      manufacturer: "APC",
      model: "AP8870",
      serialNumber: "ZA2406030655",
      // PF, the AOS — not AF1 "1.2.0.4": beside a FortiGate's "APC AOS" OS
      // fingerprint the application version would read as an AOS version.
      osVersion: "1.5.1.1",
      productType: "Rack PDU",
    });
  });

  it("accepts every masterSwitch product and a leading dot", () => {
    expect(parseVendorSysDescr(APC_AP8870, "1.3.6.1.4.1.318.1.3.4.5")?.model).toBe("AP8870");
    expect(parseVendorSysDescr(APC_AP8870, ".1.3.6.1.4.1.318.1.3.4.9")?.model).toBe("AP8870");
  });

  it("claims only the firmware off a UPS's add-on card", () => {
    // Writing MN here would call a Smart-UPS an "AP9631" and give every UPS
    // the card's serial.
    expect(parseVendorSysDescr(APC_UPS_CARD, SMART_UPS)).toEqual({
      manufacturer: "APC",
      osVersion: "6.8.2",
    });
  });

  it("claims only the firmware when the sysObjectID is unknown", () => {
    // Every caller that could not read sysObjectID gets the safe half.
    expect(parseVendorSysDescr(APC_AP8870)).toEqual({ manufacturer: "APC", osVersion: "1.5.1.1" });
    expect(parseVendorSysDescr(APC_AP8870, null)?.model).toBeUndefined();
    expect(parseVendorSysDescr(APC_AP8870, "")?.serialNumber).toBeUndefined();
  });

  it("does not mistake a neighbouring arc for the PDU branch", () => {
    // 318.1.3.40 is not 318.1.3.4.
    expect(parseVendorSysDescr(APC_AP8870, "1.3.6.1.4.1.318.1.3.40.1")?.model).toBeUndefined();
    expect(parseVendorSysDescr(APC_AP8870, "1.3.6.1.4.1.3180.1.3.4.6")?.model).toBeUndefined();
  });

  it("reads the platform version alone, and the application when no platform is stated", () => {
    expect(parseVendorSysDescr("APC Web/SNMP Management Card (MB:v4.1.0 PF:v6.4.6)")?.osVersion)
      .toBe("6.4.6");
    expect(parseVendorSysDescr("APC Web/SNMP Management Card (MB:v4.1.0 AF1:v1.2.0.4)")?.osVersion)
      .toBe("1.2.0.4");
  });

  it("never reads the next key as a blank serial's value", () => {
    const d = parseVendorSysDescr(
      "APC Web/SNMP Management Card (PF:v1.5.1.1 MN:AP8870 HR:03 SN: MD:02/10/2024)", RPDU2,
    );
    expect(d?.model).toBe("AP8870");
    expect(d?.serialNumber).toBeUndefined();
  });

  it("refuses a model or serial that is not shaped like one", () => {
    const d = parseVendorSysDescr(
      "APC Web/SNMP Management Card (PF:v1.5.1.1 MN:?? SN: ab)", RPDU2,
    );
    expect(d?.osVersion).toBe("1.5.1.1");
    expect(d?.model).toBeUndefined();
    expect(d?.serialNumber).toBeUndefined();
  });

  it("is not fooled by the vendor name elsewhere in the text", () => {
    expect(parseVendorSysDescr("Linux host monitoring APC Web/SNMP Management Card (AF1:v1.0)", RPDU2))
      .toBeUndefined();
  });

  it("never throws on hostile input", () => {
    for (const descr of [
      "APC Web/SNMP Management Card (",
      "APC Web/SNMP Management Card ()",
      "APC Web/SNMP Management Card (" + "SN: ".repeat(2000) + ")",
    ]) {
      expect(() => parseVendorSysDescr(descr, RPDU2)).not.toThrow();
    }
  });

  it("re-records when the serial or the sysObjectID changes", () => {
    const base = { manufacturer: "APC", model: "AP8870", serialNumber: "ZA1", sysObjectId: RPDU2 };
    expect(sameDescrObserved(base, { ...base })).toBe(true);
    expect(sameDescrObserved(base, { ...base, serialNumber: "ZA2" })).toBe(false);
    expect(sameDescrObserved(base, { ...base, sysObjectId: SMART_UPS })).toBe(false);
  });
});

describe("parseVendorSysDescr — the second confirmed AXIS layout", () => {
  /**
   * A real prod reading off an M2025-LE, verbatim. Kept beside the M2036-LE
   * because the two differ in FIELD COUNT — this one repeats the firmware in
   * an 8th field and carries a plain-numeric hardware id (727 vs 7EC.1) — so
   * together they are the evidence that the layout is anchored, not counted.
   */
  const AXIS_M2025 =
    "; AXIS M2025-LE; Network Camera; 8.40.3; Sep 06 2019 17:30; 727; 1; 8.40.3";

  it("reads it exactly, ignoring the trailing repeat and the hardware id", () => {
    expect(parseVendorSysDescr(AXIS_M2025)).toEqual({
      manufacturer: "Axis Communications",
      model: "M2025-LE",
      productType: "Network Camera",
      osVersion: "8.40.3",
    });
  });

  it("reads it the same way once the camera has been named", () => {
    const named = parseVendorSysDescr(
      "gatehouse-cam; AXIS M2025-LE; Network Camera; 8.40.3; Sep 06 2019 17:30; 727; 1; 8.40.3",
    );
    expect(named?.model).toBe("M2025-LE");
    expect(named?.osVersion).toBe("8.40.3");
    expect(named?.productType).toBe("Network Camera");
  });
});

