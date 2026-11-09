/**
 * tests/unit/topologyMeshLinkDetail.test.ts — the radio detail a Device Map
 * mesh backhaul link is coloured and labelled from: the leaf AP's station row
 * on its root (signal / noise) plus the root's radio (channel / width / band).
 */

import { describe, it, expect, vi } from "vitest";

vi.mock("../../src/db.js", () => ({ prisma: {} }));

import { latestOpticsByPort, meshLinkDetail } from "../../src/services/topologyGraphService.js";
import { sfpSensorName, type SfpOpticRole } from "../../src/utils/sfpOptics.js";

describe("meshLinkDetail", () => {
  it("joins the station's signal to the root radio's channel and width", () => {
    expect(meshLinkDetail(
      { signalStrength: -84, noise: -95, band: "5GHz" },
      { channel: 149, bandwidthMhz: 80, band: "5GHz" },
    )).toEqual({ signalDbm: -84, noiseDbm: -95, band: "5GHz", channel: 149, channelWidthMhz: 80 });
  });

  it("keeps the radio half when the controller reported no signal (SNMP only)", () => {
    expect(meshLinkDetail(
      { signalStrength: null, noise: null, band: null },
      { channel: 36, bandwidthMhz: 40, band: "5GHz" },
    )).toEqual({ signalDbm: null, noiseDbm: null, band: "5GHz", channel: 36, channelWidthMhz: 40 });
  });

  it("keeps the signal half when the root's radio row is missing", () => {
    expect(meshLinkDetail({ signalStrength: -60, noise: -92, band: "6GHz" }, undefined))
      .toEqual({ signalDbm: -60, noiseDbm: -92, band: "6GHz", channel: null, channelWidthMhz: null });
  });
});

describe("latestOpticsByPort", () => {
  const T0 = new Date("2026-11-06T12:00:00Z");
  const T1 = new Date("2026-11-06T12:05:00Z");
  // Stored names come from the collector's own sfpSensorName, so the test
  // cannot drift from what rule 143 writes.
  const row = (assetId: string, ifName: string, role: SfpOpticRole, value: number, timestamp = T1) =>
    ({ assetId, ifName, sensorName: sfpSensorName(ifName, role), value, timestamp });

  it("folds a port's newest readings into its optics, keyed asset|port", () => {
    const out = latestOpticsByPort([
      row("sw1", "port49", "rxPower", -9.5, T0),
      row("sw1", "port49", "rxPower", -3.2, T1),
      row("sw1", "port49", "txPower", -2.1),
      row("sw1", "port49", "temperature", 41),
    ], new Set(["sw1|port49"]));
    expect(out.get("sw1|port49")).toMatchObject({ rxDbm: -3.2, txDbm: -2.1, temperatureC: 41 });
  });

  it("keeps two switches' same-named ports apart", () => {
    const out = latestOpticsByPort([row("sw1", "port49", "rxPower", -3), row("sw2", "port49", "rxPower", -25)],
      new Set(["sw1|port49", "sw2|port49"]));
    expect(out.get("sw1|port49")!.rxDbm).toBe(-3);
    expect(out.get("sw2|port49")!.rxDbm).toBe(-25);
  });

  it("drops a reading whose port the switch is not known to have", () => {
    const out = latestOpticsByPort([row("sw1", "port52", "rxPower", -3)], new Set(["sw1|port49"]));
    expect(out.size).toBe(0);
  });
});
