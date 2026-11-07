import { describe, it, expect } from "vitest";
import {
  attributeSfpSensors,
  sfpSensorName,
  sfpRoleFromSensorName,
  splitOpticsSamples,
  type EntitySensorLayoutRow,
} from "../../src/utils/sfpOptics.js";

// One cage's five rows as FortiSwitchOS publishes them (type, units display).
function cage(start: number): EntitySensorLayoutRow[] {
  return [
    { index: start,     typeCode: 8, unitsDisplay: "C" },
    { index: start + 1, typeCode: 4, unitsDisplay: "volts" },
    { index: start + 2, typeCode: 1, unitsDisplay: "dBm" },
    { index: start + 3, typeCode: 1, unitsDisplay: "dBm" },
    { index: start + 4, typeCode: 5, unitsDisplay: "mAmps" },
  ];
}
function ports(n: number): string[] {
  const out = ["internal", "mgmt"];
  for (let i = 1; i <= n; i++) out.push(`port${i}`);
  return out;
}

// FSR-112F-POE, 2026-11-06: two chassis temps, two power-input truthvalues,
// then four seated cages at 8..27 — CLI-confirmed as port9..port12.
const FSR112F: EntitySensorLayoutRow[] = [
  { index: 4, typeCode: 8,  unitsDisplay: "Celsius" },
  { index: 5, typeCode: 8,  unitsDisplay: "Celsius" },
  { index: 6, typeCode: 12, unitsDisplay: "OK (1) / Not OK (2)" },
  { index: 7, typeCode: 12, unitsDisplay: "OK (1) / Not OK (2)" },
  ...cage(8), ...cage(13), ...cage(18), ...cage(23),
];

// FSW-148F: chassis temp + fan percent, then four cages (2 and 4 empty, which
// still publish their five rows).
const FSW148F: EntitySensorLayoutRow[] = [
  { index: 3, typeCode: 8, unitsDisplay: "Celsius" },
  { index: 4, typeCode: 1, unitsDisplay: "Percent (%%)" },
  ...cage(5), ...cage(10), ...cage(15), ...cage(20),
];

describe("attributeSfpSensors", () => {
  it("maps the FSR-112F's four groups to port9..port12, in Tx-then-Rx order", () => {
    const m = attributeSfpSensors(FSR112F, ports(12));
    expect(m.get(8)).toEqual({ ifName: "port9", role: "temperature" });
    expect(m.get(15)).toEqual({ ifName: "port10", role: "txPower" });
    expect(m.get(16)).toEqual({ ifName: "port10", role: "rxPower" });
    expect(m.get(17)).toEqual({ ifName: "port10", role: "bias" });
    expect(m.get(27)).toEqual({ ifName: "port12", role: "bias" });
    // The chassis and power-input rows are untouched.
    for (const i of [4, 5, 6, 7]) expect(m.has(i)).toBe(false);
    expect(m.size).toBe(20);
  });

  it("keeps an empty cage's group in its position (148F: cages 2 and 4 empty)", () => {
    const m = attributeSfpSensors(FSW148F, ports(52));
    expect(m.get(5)?.ifName).toBe("port49");
    expect(m.get(10)?.ifName).toBe("port50");
    expect(m.get(16)).toEqual({ ifName: "port51", role: "voltage" });
    expect(m.get(24)?.ifName).toBe("port52");
    expect(m.has(3) || m.has(4)).toBe(false);
  });

  it("maps nothing when there are fewer portN interfaces than groups", () => {
    expect(attributeSfpSensors(FSR112F, ports(3)).size).toBe(0);
  });

  it("maps nothing when the groups are not one unbroken run", () => {
    const gapped = [...cage(5), { index: 10, typeCode: 8, unitsDisplay: "Celsius" }, ...cage(11)];
    expect(attributeSfpSensors(gapped, ports(52)).size).toBe(0);
  });

  it("maps nothing when a dBm row sits outside every group", () => {
    const stray = [...cage(5), { index: 10, typeCode: 1, unitsDisplay: "dBm" }];
    expect(attributeSfpSensors(stray, ports(52)).size).toBe(0);
  });

  it("maps nothing for a table with a different per-module layout", () => {
    const four = cage(5).slice(0, 4);   // no bias row
    expect(attributeSfpSensors(four, ports(52)).size).toBe(0);
  });

  it("classifies by units display even when every row claims celsius", () => {
    const stamped = cage(5).map((r) => ({ ...r, typeCode: 8 }));
    expect(attributeSfpSensors(stamped, ports(52)).get(7)?.role).toBe("txPower");
  });

  it("reads the row order from the index, not the walk order", () => {
    const shuffled = [...FSR112F].reverse();
    expect(attributeSfpSensors(shuffled, ports(12)).get(13)?.ifName).toBe("port10");
  });

  it("returns nothing for a device with no transceiver rows", () => {
    expect(attributeSfpSensors(FSR112F.slice(0, 4), ports(12)).size).toBe(0);
  });
});

describe("sfpSensorName / sfpRoleFromSensorName", () => {
  it("round-trips every role", () => {
    for (const role of ["temperature", "voltage", "txPower", "rxPower", "bias"] as const) {
      expect(sfpRoleFromSensorName(sfpSensorName("port10", role), "port10")).toBe(role);
    }
  });
  it("refuses a name for another port or an unknown label", () => {
    expect(sfpRoleFromSensorName("port10 Rx power", "port1")).toBeNull();
    expect(sfpRoleFromSensorName("port10 Something", "port10")).toBeNull();
  });
});

describe("splitOpticsSamples", () => {
  const samples = [
    { sensorName: "TEMP1", ifName: null, value: 30 },
    { sensorName: "port10 Rx power", ifName: "port10", value: -13.716 },
    { sensorName: "port10 Tx power", ifName: "port10", value: -6.43 },
    { sensorName: "port10 Bias current", ifName: "port10", value: 0.017042 },
    { sensorName: "port12 Rx power", ifName: "port12", value: -9.546 },
  ];
  it("moves attributed readings onto their interface", () => {
    const { sensors, optics } = splitOpticsSamples(samples, new Set(["port10", "port12"]));
    expect(sensors.map((s) => s.sensorName)).toEqual(["TEMP1"]);
    expect(optics.get("port10")).toEqual({ temperatureC: null, voltage: null, txDbm: -6.43, rxDbm: -13.716, biasA: 0.017042 });
    expect(optics.get("port12")?.rxDbm).toBe(-9.546);
  });
  it("keeps a reading as a sensor when its port is not in the interface inventory", () => {
    const { sensors, optics } = splitOpticsSamples(samples, new Set(["port10"]));
    expect(sensors.map((s) => s.sensorName)).toEqual(["TEMP1", "port12 Rx power"]);
    expect(optics.has("port12")).toBe(false);
  });
});
