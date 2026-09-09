/**
 * tests/unit/interfaceStateReadings.test.ts
 *
 * The interface STATE resolver's reading-selection rule: a sample row whose
 * column is null carries no reading for that field, so the engine reads the
 * newest row that DOES carry it rather than the newest row full stop.
 *
 * Regression: a FortiSwitch whose PoE walk timed out for one tick (or whose
 * `poeAbsentCache` had been poisoned by that timeout for 30 minutes) wrote
 * `poeStatus: null` on ports sitting in `fault`. Reading the newest row alone
 * made that indistinguishable from a port with no PSE, so the dimension
 * vanished, `clearVanishedStates` retired the live alert, and the next readable
 * tick raised a new one — a duplicate alert email per collection gap, on a port
 * whose state never changed.
 */

import { describe, it, expect } from "vitest";
import {
  interfaceSampleCarries,
  interfaceStateSeries,
  type InterfaceStateRow,
} from "../../src/services/notificationEngine.js";

/** Newest-first, the order the resolver groups rows in. */
const row = (o: Partial<InterfaceStateRow> = {}): InterfaceStateRow => ({
  operStatus: null, adminStatus: null, poeStatus: null, ipAddress: null, ...o,
});

describe("interfaceSampleCarries", () => {
  it("poeStatus: any non-null value is a reading, including 'disabled'", () => {
    expect(interfaceSampleCarries("poeStatus", row({ poeStatus: "fault" }))).toBe(true);
    // "disabled" IS a reading — it is filtered later as an operator choice, not
    // here as missing data. Conflating the two would clear a fault alert on the
    // tick a port was disabled instead of recording why it stopped.
    expect(interfaceSampleCarries("poeStatus", row({ poeStatus: "disabled" }))).toBe(true);
    expect(interfaceSampleCarries("poeStatus", row({ poeStatus: null }))).toBe(false);
  });

  it("poeStatus ignores the other columns", () => {
    // The IF-MIB walk succeeding tells you nothing about whether the separate
    // PoE walk did.
    expect(interfaceSampleCarries("poeStatus", row({ operStatus: "up", adminStatus: "up" }))).toBe(false);
  });

  it("ifOperStatus needs adminStatus too, because the admin-up gate reads it", () => {
    expect(interfaceSampleCarries("ifOperStatus", row({ operStatus: "down", adminStatus: "up" }))).toBe(true);
    expect(interfaceSampleCarries("ifOperStatus", row({ operStatus: "down" }))).toBe(false);
    expect(interfaceSampleCarries("ifOperStatus", row({ adminStatus: "up" }))).toBe(false);
  });

  it("ifAdminStatus needs only adminStatus", () => {
    expect(interfaceSampleCarries("ifAdminStatus", row({ adminStatus: "down" }))).toBe(true);
    expect(interfaceSampleCarries("ifAdminStatus", row({ operStatus: "up" }))).toBe(false);
  });

  it("ifIpAddress: a null address is no reading, never 'unaddressed'", () => {
    // The device says unaddressed with 0.0.0.0. Null is a port that reported no
    // L3 address at all — every access port on a switch — and mapping it to a
    // value would make all of them satisfy `!= 0.0.0.0`.
    expect(interfaceSampleCarries("ifIpAddress", row({ ipAddress: "10.4.1.1" }))).toBe(true);
    expect(interfaceSampleCarries("ifIpAddress", row({ ipAddress: "0.0.0.0" }))).toBe(true);
    expect(interfaceSampleCarries("ifIpAddress", row({ ipAddress: null }))).toBe(false);
    expect(interfaceSampleCarries("ifIpAddress", row({ operStatus: "up", adminStatus: "up" }))).toBe(false);
  });
});

describe("interfaceStateSeries", () => {
  it("reads through an unreadable newest tick to the last real reading", () => {
    const g = [row(), row(), row({ poeStatus: "fault" }), row({ poeStatus: "fault" })];
    const picked = interfaceStateSeries("poeStatus", g);
    expect(picked?.row.poeStatus).toBe("fault");
  });

  it("still prefers the newest reading when the newest tick IS readable", () => {
    // Recovery must not be masked by an older row.
    const g = [row({ poeStatus: "delivering" }), row({ poeStatus: "fault" })];
    expect(interfaceStateSeries("poeStatus", g)?.row.poeStatus).toBe("delivering");
  });

  it("returns null when no row in the window carries the field", () => {
    // A port with no PSE, or one that genuinely stopped reporting: no reading,
    // dimension vanishes, alert clears. That is the behaviour the null gate was
    // written for and it is unchanged.
    expect(interfaceStateSeries("poeStatus", [row({ operStatus: "up" }), row()])).toBeNull();
    expect(interfaceStateSeries("poeStatus", [])).toBeNull();
  });

  it("omits unreadable ticks from the series so a poll-counted hold survives a gap", () => {
    // forPolls counts consecutive qualifying READINGS (business rule 19). A
    // collection gap measured nothing, so it must neither count toward the hold
    // nor break the run.
    const g = [
      row({ poeStatus: "fault" }),
      row(),                        // gap
      row({ poeStatus: "fault" }),
      row({ poeStatus: "fault" }),
    ];
    expect(interfaceStateSeries("poeStatus", g)?.series).toEqual(["fault", "fault", "fault"]);
  });

  it("caps the series", () => {
    const g = Array.from({ length: 10 }, () => row({ adminStatus: "up" }));
    expect(interfaceStateSeries("ifAdminStatus", g, 4)?.series).toHaveLength(4);
  });

  it("projects the field's own column, not another", () => {
    const g = [row({ operStatus: "down", adminStatus: "up", poeStatus: "fault", ipAddress: "10.4.1.1" })];
    expect(interfaceStateSeries("ifOperStatus", g)?.series).toEqual(["down"]);
    expect(interfaceStateSeries("ifAdminStatus", g)?.series).toEqual(["up"]);
    expect(interfaceStateSeries("poeStatus", g)?.series).toEqual(["fault"]);
    expect(interfaceStateSeries("ifIpAddress", g)?.series).toEqual(["10.4.1.1"]);
  });

  it("ifIpAddress reads through a tick that collected no address", () => {
    // Same gap rule as PoE: an address-less tick is a gap, not a port that
    // lost its address — the run a poll-counted hold counts must skip it.
    const g = [row({ operStatus: "up" }), row({ ipAddress: "0.0.0.0" }), row({ ipAddress: "0.0.0.0" })];
    const picked = interfaceStateSeries("ifIpAddress", g);
    expect(picked?.row.ipAddress).toBe("0.0.0.0");
    expect(picked?.series).toEqual(["0.0.0.0", "0.0.0.0"]);
  });

  it("an admin-down port still produces a readable ifOperStatus row", () => {
    // The admin-up gate lives in the resolver, downstream of this — it is a
    // deliberate config exclusion (the alert clears), not missing data.
    const picked = interfaceStateSeries("ifOperStatus", [row({ operStatus: "down", adminStatus: "down" })]);
    expect(picked?.row.adminStatus).toBe("down");
  });
});
