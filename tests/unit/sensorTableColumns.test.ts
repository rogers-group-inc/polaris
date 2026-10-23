/**
 * tests/unit/sensorTableColumns.test.ts — business rule 132: a Hardware Sensors
 * TABLE row on a manufacturer profile is declarative.
 *
 * Until 2026-10 a `table` row's symbol was ignored: the SNMP collector walked
 * FortiGate's fgHwSensorTable from three OID literals for any Fortinet device,
 * and for any other vendor's table row too. Now the row's symbol is the VALUE
 * column and `sensorColumns` names the siblings. What is pinned:
 *
 *   1. PARITY: the generic join, fed FortiGate's columns and the Fortinet
 *      mapping, produces exactly the rows the hardcoded walk did — with ONE
 *      declared difference: a blank value is null, not 0 (`Number("")` is 0,
 *      which charted an unanswered sensor as a confident zero).
 *   2. The general shape: no name column, a fixed class, a tenths scale, an
 *      enum alarm.
 *   3. The write path refuses authoring mistakes and clears columns off a row
 *      that is not (or no longer) a table; the read path never throws.
 */

import { describe, it, expect } from "vitest";
import {
  sensorTableRows,
  classifyHardwareSensor,
  normalizeFgAlarmStatus,
  type SensorColumns,
} from "../../src/utils/hardwareSensors.js";
import { FORTIGATE_SENSOR_COLUMNS } from "../../src/services/vendorTelemetryProfiles.js";
import { readSensorColumns, sensorColumnsForWrite } from "../../src/services/manufacturerProfileService.js";

/** The hardcoded walk as it stood before rule 132, over already-stringified columns. */
function legacyFortinetRows(names: Map<string, string>, values: Map<string, string>, alarms: Map<string, string>) {
  const out: Array<Record<string, unknown>> = [];
  for (const [idx, nameRaw] of names.entries()) {
    const name = nameRaw.trim();
    if (!name) continue;
    const { sensorClass, unit } = classifyHardwareSensor(name);
    const n = Number((values.get(idx) ?? "").trim());
    const a = alarms.get(idx);
    out.push({
      sensorName:  name,
      sensorClass,
      value:       Number.isFinite(n) ? Math.round(n * 1000) / 1000 : null,
      unit,
      alarmStatus: normalizeFgAlarmStatus(a == null ? null : Number(a)),
    });
  }
  return out;
}

const NO_COLUMNS: SensorColumns = { nameSymbol: null, alarmSymbol: null, alarmMap: null, sensorClass: null, transform: null };

describe("FortiGate parity (rule 132)", () => {
  // A branch FortiGate's table: DisplayString decimals, a fan, a PSU row, an
  // alarm, a blank slot, and a sensor with no alarm reading.
  const names = new Map([
    ["1", "CPU ON-DIE Temperature"], ["2", "FAN 1"], ["3", "VCC 12V"], ["4", "PSU1 Status"],
    ["5", "   "], ["6", "DTS CPU0"], ["7", "LM75 Temp"],
  ]);
  const values = new Map([
    ["1", "44.5"], ["2", "4200"], ["3", "12.1234"], ["4", "1"], ["5", "9"], ["6", "61"], ["7", "38"],
  ]);
  const alarms = new Map([["1", "0"], ["2", "1"], ["3", "0"], ["4", "0"], ["5", "0"], ["6", "0"]]);

  it("produces exactly the rows the hardcoded walk did", () => {
    const now = sensorTableRows({ values, names, alarms, columns: FORTIGATE_SENSOR_COLUMNS });
    expect(now).toEqual(legacyFortinetRows(names, values, alarms));
    // And the facts that matter, spelled out rather than only compared.
    expect(now.find((r) => r.sensorName === "FAN 1")).toMatchObject({ sensorClass: "fan", unit: "RPM", value: 4200, alarmStatus: "alarm" });
    expect(now.find((r) => r.sensorName === "VCC 12V")).toMatchObject({ sensorClass: "voltage", value: 12.123 });
    expect(now.find((r) => r.sensorName === "LM75 Temp")?.alarmStatus).toBeNull();
    expect(now.some((r) => r.sensorName === "")).toBe(false);
  });

  it("the one declared delta: a blank value is null, where the hardcoded walk said 0", () => {
    const names1 = new Map([["9", "Inlet Temp"]]);
    const values1 = new Map([["9", ""]]);
    const alarms1 = new Map([["9", "0"]]);
    expect(legacyFortinetRows(names1, values1, alarms1)[0].value).toBe(0);
    expect(sensorTableRows({ values: values1, names: names1, alarms: alarms1, columns: FORTIGATE_SENSOR_COLUMNS })[0])
      .toMatchObject({ sensorName: "Inlet Temp", value: null, alarmStatus: "ok" });
  });
});

describe("sensorTableRows — the general shape", () => {
  it("names rows by index when there is no name column, and keeps every value row", () => {
    const rows = sensorTableRows({ values: new Map([["1", "21"], ["2", "x"]]), names: null, alarms: null, columns: NO_COLUMNS });
    expect(rows.map((r) => [r.sensorName, r.value, r.alarmStatus])).toEqual([["sensor-1", 21, null], ["sensor-2", null, null]]);
  });

  it("a fixed class wins over the row name, and carries its unit", () => {
    const rows = sensorTableRows({
      values: new Map([["1", "23"]]), names: new Map([["1", "Probe 1"]]), alarms: null,
      columns: { ...NO_COLUMNS, sensorClass: "temperature" },
    });
    expect(rows[0]).toMatchObject({ sensorName: "Probe 1", sensorClass: "temperature", unit: "°C" });
    expect(classifyHardwareSensor("Probe 1").sensorClass).toBe("other");
  });

  it("scales a DISPLAY-HINT d-1 column with tenths_to_units", () => {
    const rows = sensorTableRows({ values: new Map([["1", "315"]]), names: null, alarms: null, columns: { ...NO_COLUMNS, transform: "tenths_to_units" } });
    expect(rows[0].value).toBe(31.5);
  });

  it("maps an enum alarm column through the declared mode, and an unreadable one to no claim", () => {
    const columns: SensorColumns = {
      ...NO_COLUMNS, alarmSymbol: "upsStatus",
      alarmMap: { mode: "notEquals", values: ["2"], trueLabel: "Alarm", falseLabel: "OK", trueIsProblem: true },
    };
    const rows = sensorTableRows({
      values: new Map([["1", "1"], ["2", "1"], ["3", "1"]]), names: null,
      alarms: new Map([["1", "2"], ["2", "4"]]), columns,
    });
    expect(rows.map((r) => r.alarmStatus)).toEqual(["ok", "alarm", null]);
  });
});

describe("the write and read halves (rule 132)", () => {
  const fortinetRaw = { nameSymbol: "fgHwSensorEntName", alarmSymbol: "fgHwSensorEntAlarmStatus" };

  it("keeps columns on a temperature table row, defaulting the alarm map to nonzero", () => {
    const c = sensorColumnsForWrite("temperature", "table", fortinetRaw)!;
    expect(c).toMatchObject({ nameSymbol: "fgHwSensorEntName", alarmSymbol: "fgHwSensorEntAlarmStatus", sensorClass: null, transform: null });
    expect(c.alarmMap?.mode).toBe("nonzero");
    expect(c).toEqual(FORTIGATE_SENSOR_COLUMNS);
  });

  it("clears columns off a temperature row that is not a table, rather than refusing", () => {
    expect(sensorColumnsForWrite("temperature", "scalar", fortinetRaw)).toBeNull();
  });

  it("refuses columns on any other metric, a bad class or transform, and an unusable alarm map", () => {
    expect(() => sensorColumnsForWrite("cpu", "table", fortinetRaw)).toThrow(/temperature/);
    expect(() => sensorColumnsForWrite("temperature", "table", { sensorClass: "humidity" })).toThrow(/sensor class/);
    expect(() => sensorColumnsForWrite("temperature", "table", { transform: "bytes_to_mb" })).toThrow(/tenths_to_units/);
    expect(() => sensorColumnsForWrite("temperature", "table", { alarmSymbol: "x", alarmMap: { mode: "equals", values: [] } }))
      .toThrow(/alarmMap/);
    expect(() => sensorColumnsForWrite("temperature", "table", "nope")).toThrow(/object/);
  });

  it("an empty set is null, and an alarm map without an alarm column is dropped", () => {
    expect(sensorColumnsForWrite("temperature", "table", null)).toBeNull();
    expect(sensorColumnsForWrite("temperature", "table", { nameSymbol: "  " })).toBeNull();
    expect(sensorColumnsForWrite("temperature", "table", { nameSymbol: "n", alarmMap: { mode: "zero" } })?.alarmMap).toBeNull();
  });

  it("the read half never throws, whatever is stored", () => {
    for (const bad of [null, 7, "x", [], { sensorClass: "nope" }, { alarmSymbol: "a", alarmMap: "garbage" }]) {
      expect(() => readSensorColumns(bad)).not.toThrow();
    }
    expect(readSensorColumns({ alarmSymbol: "a", alarmMap: "garbage" })?.alarmMap?.mode).toBe("nonzero");
  });
});
