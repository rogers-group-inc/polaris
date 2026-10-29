import { describe, it, expect } from "vitest";
import { snmpTicksToSeconds, formatUptime, formatUptimeLong, deviceUptime } from "../../src/utils/uptime.js";

// Pure helpers — no DB, no network.

describe("deviceUptime", () => {
  const at = new Date("2026-10-28T12:00:00Z");
  const now = at.getTime() + 3600_000;

  it("carries the last reading forward to now, as the System tab does", () => {
    expect(deviceUptime({ lastUptimeSec: 86400, lastMonitorAt: at, monitorStatus: "up" }, now)).toEqual({
      uptimeSec: 90000, uptime: "1d 1h", upSince: new Date("2026-10-27T12:00:00Z"),
    });
  });

  it("does not climb while the device is down", () => {
    expect(deviceUptime({ lastUptimeSec: 600, lastMonitorAt: at, monitorStatus: "down" }, now)?.uptimeSec).toBe(600);
  });

  it("prefers the reboot Polaris detected for upSince", () => {
    const rebooted = new Date("2026-10-28T11:55:00Z");
    expect(deviceUptime({ lastUptimeSec: 300, lastMonitorAt: at, lastRebootAt: rebooted }, now)?.upSince).toBe(rebooted);
  });

  it("is null when no probe reported uptime", () => {
    expect(deviceUptime({ lastUptimeSec: null, lastMonitorAt: at }, now)).toBeNull();
    expect(deviceUptime({ lastUptimeSec: 60, lastMonitorAt: null }, now)).toBeNull();
  });
});

describe("snmpTicksToSeconds", () => {
  it("converts centiseconds to whole seconds", () => {
    expect(snmpTicksToSeconds(100)).toBe(1);
    expect(snmpTicksToSeconds(12345)).toBe(123);
    expect(snmpTicksToSeconds(0)).toBe(0);
  });

  it("accepts numeric strings", () => {
    expect(snmpTicksToSeconds("4200")).toBe(42);
  });

  it("returns null for invalid / negative input", () => {
    expect(snmpTicksToSeconds(null)).toBeNull();
    expect(snmpTicksToSeconds(undefined)).toBeNull();
    expect(snmpTicksToSeconds(-5)).toBeNull();
    expect(snmpTicksToSeconds("abc")).toBeNull();
    expect(snmpTicksToSeconds(NaN)).toBeNull();
  });
});

describe("formatUptime", () => {
  it("renders days + hours", () => {
    expect(formatUptime(42 * 86400 + 6 * 3600)).toBe("42d 6h");
  });

  it("drops a zero hours component", () => {
    expect(formatUptime(3 * 86400)).toBe("3d");
  });

  it("renders hours + minutes when under a day", () => {
    expect(formatUptime(6 * 3600 + 12 * 60)).toBe("6h 12m");
    expect(formatUptime(2 * 3600)).toBe("2h");
  });

  it("renders minutes when under an hour", () => {
    expect(formatUptime(12 * 60)).toBe("12m");
    expect(formatUptime(60)).toBe("1m");
  });

  it("renders <1m for sub-minute", () => {
    expect(formatUptime(0)).toBe("<1m");
    expect(formatUptime(59)).toBe("<1m");
  });

  it("returns em-dash for null / invalid", () => {
    expect(formatUptime(null)).toBe("—");
    expect(formatUptime(undefined)).toBe("—");
    expect(formatUptime(-1)).toBe("—");
    expect(formatUptime(NaN)).toBe("—");
  });
});

describe("formatUptimeLong", () => {
  it("renders every unit down to seconds", () => {
    expect(formatUptimeLong(1567275)).toBe("18d 3h 21m 15s");
    expect(formatUptimeLong(9464)).toBe("2h 37m 44s");
    expect(formatUptimeLong(417)).toBe("6m 57s");
  });

  it("keeps intermediate zero units but drops leading ones", () => {
    expect(formatUptimeLong(86401)).toBe("1d 0h 0m 1s");
    expect(formatUptimeLong(3600)).toBe("1h 0m 0s");
    expect(formatUptimeLong(60)).toBe("1m 0s");
  });

  it("keeps sub-minute readings, unlike formatUptime", () => {
    expect(formatUptimeLong(47)).toBe("47s");
    expect(formatUptimeLong(0)).toBe("0s");
  });

  it("returns em-dash for null / invalid", () => {
    expect(formatUptimeLong(null)).toBe("—");
    expect(formatUptimeLong(undefined)).toBe("—");
    expect(formatUptimeLong(-1)).toBe("—");
    expect(formatUptimeLong(NaN)).toBe("—");
  });
});
