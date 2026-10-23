/**
 * tests/unit/tempUnit.test.ts — display-unit conversion for hardware sensors
 * (public/js/temp-unit.js, off window.PolarisTempUnit).
 *
 * The load-bearing behavior is what must NOT convert: a fan's RPM, a rail's
 * volts, and a reading whose unit the device never reported have to flow through
 * untouched, because this runs over the whole mixed sensor table. Also pinned:
 * Celsius stays Celsius when the install hasn't opted in, the label follows the
 * value (a converted number rendered "°C" is worse than not converting), and a
 * missing/garbage localStorage payload degrades to Celsius rather than throwing
 * inside a sync renderer.
 */

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import vm from "node:vm";

let TU: {
  unit: () => string;
  isFahrenheit: () => boolean;
  setFromBranding: (b: unknown) => string;
  setUnit: (u: unknown) => string;
  isCelsiusUnit: (u: unknown) => boolean;
  convertCelsius: (v: unknown) => unknown;
  convertReading: (v: unknown, storedUnit: unknown) => unknown;
  displayUnit: (storedUnit: unknown) => unknown;
  celsiusLabel: () => string;
};

/** Reload the module with a given localStorage stand-in. */
function load(store?: Record<string, string>): typeof TU {
  const here = dirname(fileURLToPath(import.meta.url));
  const code = readFileSync(resolve(here, "../../public/js/temp-unit.js"), "utf8");
  const sandbox: Record<string, any> = {
    window: {},
    localStorage: store
      ? { getItem: (k: string) => (k in store ? store[k] : null) }
      : undefined,
  };
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);
  return sandbox.window.PolarisTempUnit;
}

beforeAll(() => { TU = load(); });
beforeEach(() => { TU.setUnit("c"); });

describe("unit resolution", () => {
  it("reads the install preference out of the cached branding payload", () => {
    const f = load({ "polaris-branding": JSON.stringify({ appName: "x", temperatureUnit: "f" }) });
    expect(f.unit()).toBe("f");
    expect(f.isFahrenheit()).toBe(true);
  });

  it("defaults to Celsius with no cache, no localStorage, or an unparseable payload", () => {
    expect(load().unit()).toBe("c");
    expect(load({}).unit()).toBe("c");
    expect(load({ "polaris-branding": "{not json" }).unit()).toBe("c");
    expect(load({ "polaris-branding": JSON.stringify({ appName: "x" }) }).unit()).toBe("c");
  });

  it("adopts the unit from a fresh branding fetch, and normalizes junk to Celsius", () => {
    expect(TU.setFromBranding({ temperatureUnit: "f" })).toBe("f");
    expect(TU.setFromBranding({ temperatureUnit: "F" })).toBe("f");
    expect(TU.setFromBranding({ temperatureUnit: "kelvin" })).toBe("c");
    expect(TU.setFromBranding(null)).toBe("c");
    expect(TU.setFromBranding({})).toBe("c");
  });
});

describe("convertReading", () => {
  it("converts Celsius readings only when the install asked for Fahrenheit", () => {
    expect(TU.convertReading(40, "°C")).toBe(40);
    TU.setUnit("f");
    expect(TU.convertReading(40, "°C")).toBe(104);
    expect(TU.convertReading(0, "°C")).toBe(32);
    expect(TU.convertReading(-40, "°C")).toBe(-40);
  });

  it("leaves every non-Celsius reading alone", () => {
    TU.setUnit("f");
    // A mixed fgHwSensorTable row set: fan RPM, a voltage rail, a unitless PSU
    // presence value, and a sensor the device reported no unit for.
    expect(TU.convertReading(8400, "RPM")).toBe(8400);
    expect(TU.convertReading(3.3, "V")).toBe(3.3);
    expect(TU.convertReading(1, null)).toBe(1);
    expect(TU.convertReading(1, undefined)).toBe(1);
    expect(TU.convertReading(1, "")).toBe(1);
  });

  it("passes non-numeric values straight through so a 'no reading' stays missing", () => {
    TU.setUnit("f");
    expect(TU.convertReading(null, "°C")).toBeNull();
    expect(TU.convertReading(undefined, "°C")).toBeUndefined();
    expect(TU.convertReading(NaN, "°C")).toBeNaN();
    expect(TU.convertReading(Infinity, "°C")).toBe(Infinity);
  });
});

describe("isCelsiusUnit", () => {
  it("accepts the stored spelling and bare C, case-insensitively", () => {
    expect(TU.isCelsiusUnit("°C")).toBe(true);
    expect(TU.isCelsiusUnit("c")).toBe(true);
    expect(TU.isCelsiusUnit(" °c ")).toBe(true);
  });

  it("rejects everything else, including Fahrenheit and non-strings", () => {
    expect(TU.isCelsiusUnit("°F")).toBe(false);
    expect(TU.isCelsiusUnit("RPM")).toBe(false);
    expect(TU.isCelsiusUnit("Celsius")).toBe(false);
    expect(TU.isCelsiusUnit(null)).toBe(false);
    expect(TU.isCelsiusUnit(40)).toBe(false);
  });
});

describe("labels", () => {
  it("swaps the label exactly when the value is converted", () => {
    expect(TU.displayUnit("°C")).toBe("°C");
    expect(TU.celsiusLabel()).toBe("°C");
    TU.setUnit("f");
    expect(TU.displayUnit("°C")).toBe("°F");
    expect(TU.celsiusLabel()).toBe("°F");
  });

  it("never rewrites a non-Celsius label", () => {
    TU.setUnit("f");
    expect(TU.displayUnit("RPM")).toBe("RPM");
    expect(TU.displayUnit("V")).toBe("V");
    expect(TU.displayUnit(null)).toBeNull();
  });
});

describe("convertCelsius", () => {
  it("converts values known to be Celsius (chart series, automation thresholds)", () => {
    expect(TU.convertCelsius(65)).toBe(65);
    TU.setUnit("f");
    expect(TU.convertCelsius(65)).toBe(149);
    expect(TU.convertCelsius(80)).toBe(176);
    expect(TU.convertCelsius(null)).toBeNull();
  });
});

// ── Either direction: manufacturer custom widgets declare °C OR °F ─────────
describe("toDisplay / displayUnitAny (custom widgets)", () => {
  const T = () => TU as typeof TU & {
    isTemperatureUnit: (u: unknown) => boolean;
    toDisplay: (v: unknown, u: unknown) => unknown;
    displayUnitAny: (u: unknown) => unknown;
  };

  it("shows a °F reading in °C on a Celsius install, and leaves it on a Fahrenheit one", () => {
    TU.setUnit("c");
    expect(T().toDisplay(212, "°F")).toBe(100);
    expect(T().displayUnitAny("F")).toBe("°C");
    TU.setUnit("f");
    expect(T().toDisplay(212, "°F")).toBe(212);
    expect(T().displayUnitAny("°F")).toBe("°F");
  });

  it("shows a °C reading in °F on a Fahrenheit install, and leaves it on a Celsius one", () => {
    TU.setUnit("f");
    expect(T().toDisplay(100, "°C")).toBe(212);
    expect(T().displayUnitAny("C")).toBe("°F");
    TU.setUnit("c");
    expect(T().toDisplay(100, "c")).toBe(100);
  });

  it("passes anything that is not a temperature through untouched", () => {
    TU.setUnit("f");
    expect(T().toDisplay(42, "%")).toBe(42);
    expect(T().toDisplay(42, undefined)).toBe(42);
    expect(T().displayUnitAny("V")).toBe("V");
    expect(T().isTemperatureUnit("°F")).toBe(true);
    expect(T().isTemperatureUnit("fps")).toBe(false);
  });
});
