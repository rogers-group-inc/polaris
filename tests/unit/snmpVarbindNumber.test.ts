/**
 * tests/unit/snmpVarbindNumber.test.ts — `snmpVbToNumber`
 * (src/services/monitoringService.ts).
 *
 * This decoder sits under every SNMP reading Polaris takes — CPU, memory,
 * interface counters, hardware sensors, PoE budgets, storage bytes — so what it
 * does with an ABSENT value is a fleet-wide semantic, not a detail.
 *
 * What's pinned, and why each is a decision rather than an implementation
 * detail:
 *
 *  - **An unanswered OID is null, never 0.** `snmpGetScalar` resolves `null`
 *    for an error varbind (noSuchObject / noSuchInstance / endOfMibView), and
 *    `Number(null)` is a perfectly finite 0 — so a scalar the device doesn't
 *    publish used to decode as a confident zero. A FortiSwitch model whose
 *    fsSysCpuUsage / fsSysMemUsage don't sit at ...12356.106.4.1.{2,3}.0 drew a
 *    flat 0.0% CPU & Memory graph forever, and because 0 isn't null the
 *    HOST-RESOURCES-MIB fallback in `collectTelemetrySnmp` never ran to correct
 *    it (prod 2026-08-31, FortiSwitchRugged-112D-POE). Same invariant as
 *    business rule 24's alarm bit: absence must never map to 0.
 *  - **Empty is absent.** An empty OCTET STRING arrives as a zero-length
 *    Buffer and `Number("")` is also 0 — same wrong answer by a second route.
 *  - **A missing table row was ALREADY null** (`map.get(miss)` → `undefined` →
 *    `NaN`), which is why only the error-varbind path was wrong. Pinned so the
 *    fix can't be "simplified" into changing it.
 *  - **Buffers ≤ 8 bytes are big-endian integers; longer ones are decimal
 *    strings.** That split is how an agent publishing a wide counter as text
 *    decodes, so it survives the null guard.
 *  - **0 is still 0.** A device that genuinely reports zero must be believed —
 *    the fix distinguishes "said zero" from "said nothing", it doesn't discard
 *    zeros.
 */
import { describe, it, expect } from "vitest";
import { snmpVbToNumber } from "../../src/services/monitoring/snmpCore.js";

describe("snmpVbToNumber — absence vs zero", () => {
  it("decodes an error varbind (null) as null, not 0", () => {
    // The FSR-112D-POE regression: snmpGetScalar resolves null on
    // noSuchInstance, and Number(null) === 0 turned that into 0.0% CPU.
    expect(snmpVbToNumber(null)).toBeNull();
  });

  it("decodes a missing table row (undefined) as null", () => {
    expect(snmpVbToNumber(undefined)).toBeNull();
    expect(snmpVbToNumber(new Map<string, unknown>().get("nope"))).toBeNull();
  });

  it("decodes an empty OCTET STRING as null, not 0", () => {
    expect(snmpVbToNumber(Buffer.alloc(0))).toBeNull();
    expect(snmpVbToNumber("")).toBeNull();
    expect(snmpVbToNumber("   ")).toBeNull();
  });

  it("believes a genuine zero", () => {
    expect(snmpVbToNumber(0)).toBe(0);
    expect(snmpVbToNumber("0")).toBe(0);
    expect(snmpVbToNumber(Buffer.from([0x00]))).toBe(0);
  });
});

describe("snmpVbToNumber — value decoding", () => {
  it("passes finite numbers through and rejects non-finite ones", () => {
    expect(snmpVbToNumber(42)).toBe(42);
    expect(snmpVbToNumber(3.5)).toBe(3.5);
    expect(snmpVbToNumber(-7)).toBe(-7);
    expect(snmpVbToNumber(NaN)).toBeNull();
    expect(snmpVbToNumber(Infinity)).toBeNull();
  });

  it("widens a Counter64 bigint", () => {
    expect(snmpVbToNumber(12345678901234n)).toBe(12345678901234);
  });

  it("reads a Buffer of 8 bytes or fewer as a big-endian integer", () => {
    expect(snmpVbToNumber(Buffer.from([0x01, 0x00]))).toBe(256);
    expect(snmpVbToNumber(Buffer.from([0xff, 0xff, 0xff, 0xff]))).toBe(4294967295);
  });

  it("reads a Buffer longer than 8 bytes as a decimal string", () => {
    // An agent that publishes a wide counter as text rather than Counter64.
    expect(snmpVbToNumber(Buffer.from("12345678901234", "utf8"))).toBe(12345678901234);
  });

  it("rejects a non-numeric string", () => {
    expect(snmpVbToNumber("up")).toBeNull();
    expect(snmpVbToNumber(Buffer.from("not a number", "utf8"))).toBeNull();
  });
});
