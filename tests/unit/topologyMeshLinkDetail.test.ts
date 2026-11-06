/**
 * tests/unit/topologyMeshLinkDetail.test.ts — the radio detail a Device Map
 * mesh backhaul link is coloured and labelled from: the leaf AP's station row
 * on its root (signal / noise) plus the root's radio (channel / width / band).
 */

import { describe, it, expect, vi } from "vitest";

vi.mock("../../src/db.js", () => ({ prisma: {} }));

import { meshLinkDetail } from "../../src/services/topologyGraphService.js";

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
