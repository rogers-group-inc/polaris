/**
 * tests/unit/snmpEntityIdentity.test.ts
 *
 * Business rule 154 — the pure half (utils/snmpEntityIdentity.ts). Pinned:
 *
 *   - sysName becomes a hostname unless it is an agent placeholder;
 *   - model / serial / manufacturer come from the chassis row and from no
 *     other class, so a supervisor's serial never stands in for the box;
 *   - several chassis rows (a stack) state model and manufacturer only when
 *     they agree, and never a serial;
 *   - firmware is the chassis softwareRev, else the one value the modules
 *     agree on, never a disagreement and never a digit-less string;
 *   - a placeholder serial is refused (rule 84).
 */

import { describe, it, expect } from "vitest";
import {
  hostnameFromSysName,
  identityFromEntityRows,
  snmpSelfIdentity,
  hasSelfIdentity,
  type EntityIdentityRow,
} from "../../src/utils/snmpEntityIdentity.js";

function row(p: Partial<EntityIdentityRow> & { entIndex: number; entClass: string }): EntityIdentityRow {
  return { serialNum: null, mfgName: null, modelName: null, softwareRev: null, ...p };
}

// The shape a Cisco MDS 9148S answers: a chassis row with model and serial,
// a supervisor carrying the NX-OS version, blank chassis softwareRev.
const MDS: EntityIdentityRow[] = [
  row({ entIndex: 1, entClass: "chassis", modelName: "DS-C9148S-K9", serialNum: "JAF1234ABCD", mfgName: "Cisco Systems, Inc." }),
  row({ entIndex: 22, entClass: "module", modelName: "DS-C9148S-K9-SUP", serialNum: "JAE23060WX2", softwareRev: "8.4(2c)" }),
];

describe("hostnameFromSysName", () => {
  it("keeps a configured name, FQDN or short", () => {
    expect(hostnameFromSysName("metro-9148s-1")).toBe("metro-9148s-1");
    expect(hostnameFromSysName("  core-sw1.example.com ")).toBe("core-sw1.example.com");
  });

  it("refuses unconfigured-agent placeholders and empty answers", () => {
    for (const v of ["", "   ", null, undefined, "localhost", "LOCALHOST.localdomain", "(none)", "unknown", "not set"]) {
      expect(hostnameFromSysName(v as string | null | undefined)).toBeUndefined();
    }
  });
});

describe("identityFromEntityRows", () => {
  it("reads model, serial and manufacturer from the chassis and firmware from the agreeing module", () => {
    expect(identityFromEntityRows(MDS)).toEqual({
      model: "DS-C9148S-K9",
      serialNumber: "JAF1234ABCD",
      manufacturer: "Cisco Systems, Inc.",
      osVersion: "8.4(2c)",
    });
  });

  it("states nothing when there is no chassis row — a module never stands in for the box", () => {
    expect(identityFromEntityRows(MDS.filter((r) => r.entClass !== "chassis"))).toEqual({});
  });

  it("prefers the chassis softwareRev over the modules'", () => {
    const rows = [
      row({ entIndex: 1, entClass: "chassis", modelName: "WS-C3850-48P", softwareRev: "16.12.4" }),
      row({ entIndex: 2, entClass: "module", softwareRev: "1.0" }),
    ];
    expect(identityFromEntityRows(rows).osVersion).toBe("16.12.4");
  });

  it("states no firmware when modules disagree or the value carries no digit", () => {
    const disagree = [
      row({ entIndex: 1, entClass: "chassis", modelName: "N7K-C7010" }),
      row({ entIndex: 2, entClass: "module", softwareRev: "8.2(2)" }),
      row({ entIndex: 3, entClass: "module", softwareRev: "1.4.7" }),
    ];
    expect(identityFromEntityRows(disagree).osVersion).toBeUndefined();
    const digitless = [row({ entIndex: 1, entClass: "chassis", softwareRev: "N/A-build" })];
    expect(identityFromEntityRows(digitless).osVersion).toBeUndefined();
  });

  it("on a stack, states the agreed model but never a serial", () => {
    const stack = [
      row({ entIndex: 1000, entClass: "chassis", modelName: "C9300-48P", serialNum: "FOC111" }),
      row({ entIndex: 2000, entClass: "chassis", modelName: "C9300-48P", serialNum: "FOC222" }),
    ];
    expect(identityFromEntityRows(stack)).toEqual({ model: "C9300-48P" });
    const mixed = [
      row({ entIndex: 1000, entClass: "chassis", modelName: "C9300-48P" }),
      row({ entIndex: 2000, entClass: "chassis", modelName: "C9300-24T" }),
    ];
    expect(identityFromEntityRows(mixed).model).toBeUndefined();
  });

  it("refuses a placeholder serial (rule 84)", () => {
    const rows = [row({ entIndex: 1, entClass: "chassis", modelName: "X", serialNum: "To Be Filled By O.E.M." })];
    expect(identityFromEntityRows(rows).serialNumber).toBeUndefined();
  });
});

describe("snmpSelfIdentity / hasSelfIdentity", () => {
  it("joins the sysName and the entity halves", () => {
    const id = snmpSelfIdentity("metro-9148s-1", MDS);
    expect(id.hostname).toBe("metro-9148s-1");
    expect(id.model).toBe("DS-C9148S-K9");
    expect(hasSelfIdentity(id)).toBe(true);
  });

  it("reports nothing stated when neither half said anything", () => {
    expect(hasSelfIdentity(snmpSelfIdentity("localhost", undefined))).toBe(false);
    expect(hasSelfIdentity(undefined)).toBe(false);
  });
});
