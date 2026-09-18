/**
 * tests/unit/reservationDescriptionBudget.test.ts
 *
 * The FortiGate-side description budget for a pushed reservation. FortiOS holds
 * 255 characters in a `system.dhcp/server/<id>/reserved-address` description,
 * and Polaris spends some of that on "Polaris/<user>: " and " [<hostname>]" so
 * the entry names its origin — so the room left for operator notes is a
 * computed budget, not a constant.
 *
 * Two things are pinned here: the budget arithmetic matches what the composer
 * actually emits (the reason `reservationNotesBudget` derives the overhead
 * instead of restating the format), and an over-length save is REFUSED rather
 * than truncated — a truncated description loses its trailing `[hostname]`, and
 * `subnetRefreshService.extractHostnameFromDescription` then recovers the tail
 * of the operator's notes as the hostname.
 */

import { describe, it, expect } from "vitest";
import {
  RESERVED_ADDRESS_DESCRIPTION_MAX,
  reservationNotesBudget,
  assertReservationDescriptionFits,
} from "../../src/services/reservationPushService.js";
import { AppError } from "../../src/utils/errors.js";

describe("RESERVED_ADDRESS_DESCRIPTION_MAX", () => {
  it("is the FortiOS reserved-address description cap", () => {
    expect(RESERVED_ADDRESS_DESCRIPTION_MAX).toBe(255);
  });
});

describe("reservationNotesBudget", () => {
  it("subtracts the origin prefix and the bracketed hostname", () => {
    // "Polaris/dmoore: " (16) + " [web-server-01]" (16) = 32
    expect(reservationNotesBudget({ hostname: "web-server-01", createdBy: "dmoore", ip: "10.0.1.10" }))
      .toBe(255 - 32);
  });

  it("subtracts only the short prefix when there is no signed-in user", () => {
    // "Polaris: " (9) + " [sw-01]" (8)
    expect(reservationNotesBudget({ hostname: "sw-01", createdBy: null, ip: "10.0.1.10" }))
      .toBe(255 - 17);
  });

  it("charges nothing for the hostname when there isn't one", () => {
    expect(reservationNotesBudget({ hostname: null, createdBy: "dmoore", ip: "10.0.1.10" }))
      .toBe(255 - "Polaris/dmoore: ".length);
  });

  it("never goes below zero", () => {
    expect(reservationNotesBudget({ hostname: "h".repeat(400), createdBy: "dmoore", ip: "10.0.1.10" }))
      .toBe(0);
  });

  it("is exact — notes of exactly the budget fit, one more does not", () => {
    const params = { hostname: "web-server-01", createdBy: "dmoore", ip: "10.0.1.10" };
    const budget = reservationNotesBudget(params);
    expect(() => assertReservationDescriptionFits({ ...params, notes: "n".repeat(budget) })).not.toThrow();
    expect(() => assertReservationDescriptionFits({ ...params, notes: "n".repeat(budget + 1) })).toThrow();
  });
});

describe("assertReservationDescriptionFits", () => {
  const params = { hostname: "web-server-01", createdBy: "dmoore", ip: "10.0.1.10" };

  it("accepts an empty note", () => {
    expect(() => assertReservationDescriptionFits({ ...params, notes: null })).not.toThrow();
    expect(() => assertReservationDescriptionFits({ ...params, notes: "" })).not.toThrow();
  });

  it("accepts a typical note", () => {
    expect(() => assertReservationDescriptionFits({ ...params, notes: "Spare port for the Q4 rack build" }))
      .not.toThrow();
  });

  it("refuses with 400 and says how much to cut", () => {
    const budget = reservationNotesBudget(params);
    let err: unknown;
    try {
      assertReservationDescriptionFits({ ...params, notes: "n".repeat(budget + 12) });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).httpStatus).toBe(400);
    expect((err as AppError).message).toContain(String(budget));
    expect((err as AppError).message).toContain("Shorten the notes by 12");
  });

  it("measures the TRIMMED note — trailing whitespace is not what puts it over", () => {
    const budget = reservationNotesBudget(params);
    expect(() => assertReservationDescriptionFits({ ...params, notes: "n".repeat(budget) + "    " }))
      .not.toThrow();
  });

  it("spends the hostname's characters out of the same 255", () => {
    // Same note, longer hostname → the note that fit no longer does.
    const notes = "n".repeat(reservationNotesBudget(params));
    expect(() => assertReservationDescriptionFits({ ...params, notes })).not.toThrow();
    expect(() =>
      assertReservationDescriptionFits({ ...params, hostname: params.hostname + "-secondary", notes }),
    ).toThrow(/too long for the FortiGate/i);
  });

  it("is generous with the old 64-char shape — a note the previous cap truncated now fits", () => {
    expect(() => assertReservationDescriptionFits({ ...params, notes: "n".repeat(100) })).not.toThrow();
  });
});
