/**
 * tests/unit/assetWritePrune.test.ts — dropping the keys of a discovery asset
 * write that would set what the row already holds, and the keys it must never
 * drop (pins, unknown keys, a changed ipSource).
 */

import { describe, it, expect } from "vitest";
import { pruneUnchangedAssetFields } from "../../src/utils/assetWritePrune.js";

const row = (over: Record<string, unknown> = {}) => ({
  id: "a1", hostname: "pc-1", ipAddress: "10.0.0.5", ipSource: "FGT-A", macAddress: "AA:BB:CC:00:00:01",
  osVersion: "11", lastSeen: new Date("2026-11-13T10:00:00Z"), associatedUsers: [{ user: "jo", domain: "CORP" }],
  ipOverride: null, ipBlankPinned: false, primaryAddressIp: null, hostnameOverride: null, status: "active",
  ...over,
});

describe("pruneUnchangedAssetFields", () => {
  it("drops every unchanged key, keeps a changed one and the new lastSeen", () => {
    const data: Record<string, unknown> = {
      hostname: "pc-1", macAddress: "AA:BB:CC:00:00:01", osVersion: "12", status: "active",
      lastSeen: new Date("2026-11-13T11:00:00Z"),
    };
    const r = pruneUnchangedAssetFields(row(), data);
    expect(data).toEqual({ osVersion: "12", lastSeen: new Date("2026-11-13T11:00:00Z") });
    expect(r.pruned.sort()).toEqual(["hostname", "macAddress", "status"]);
    expect(r.ipHistoryRefresh).toBeNull();
  });

  it("an unchanged IP is dropped with its source, and handed back for the IP-history refresh", () => {
    const data: Record<string, unknown> = { ipAddress: "10.0.0.5", ipSource: "FGT-A" };
    const r = pruneUnchangedAssetFields(row(), data);
    expect(data).toEqual({});
    expect(r.ipHistoryRefresh).toEqual({ ip: "10.0.0.5", source: "FGT-A" });
  });

  it("keeps the IP when only its source changed — and the source with it", () => {
    const data: Record<string, unknown> = { ipAddress: "10.0.0.5", ipSource: "FGT-B" };
    pruneUnchangedAssetFields(row(), data);
    expect(data).toEqual({ ipAddress: "10.0.0.5", ipSource: "FGT-B" });
  });

  it("never drops the IP on a pinned asset (the equal value is what releases a pin)", () => {
    for (const pin of [{ ipOverride: "10.0.0.5" }, { ipBlankPinned: true }, { primaryAddressIp: "10.0.0.5" }]) {
      const data: Record<string, unknown> = { ipAddress: "10.0.0.5", ipSource: "FGT-A" };
      const r = pruneUnchangedAssetFields(row(pin), data);
      expect(data, JSON.stringify(pin)).toEqual({ ipAddress: "10.0.0.5", ipSource: "FGT-A" });
      expect(r.ipHistoryRefresh).toBeNull();
    }
  });

  it("never drops the hostname on an asset with a hostname override", () => {
    const data: Record<string, unknown> = { hostname: "pc-1" };
    pruneUnchangedAssetFields(row({ hostnameOverride: "pc-1" }), data);
    expect(data).toEqual({ hostname: "pc-1" });
  });

  it("a row read WITHOUT the pin columns keeps its IP and hostname (unknown counts as pinned)", () => {
    const narrow = { id: "a1", hostname: "pc-1", ipAddress: "10.0.0.5", ipSource: "FGT-A", os: "Windows" };
    const data: Record<string, unknown> = { hostname: "pc-1", ipAddress: "10.0.0.5", ipSource: "FGT-A", os: "Windows" };
    const r = pruneUnchangedAssetFields(narrow, data);
    expect(data).toEqual({ hostname: "pc-1", ipAddress: "10.0.0.5", ipSource: "FGT-A" });
    expect(r.ipHistoryRefresh).toBeNull();
  });

  it("keeps a key the row does not carry, and Prisma operation objects", () => {
    const data: Record<string, unknown> = { brandNewField: "x", loginCount: { increment: 1 } };
    pruneUnchangedAssetFields({ ...row(), loginCount: 1 }, data);
    expect(data).toEqual({ brandNewField: "x", loginCount: { increment: 1 } });
  });

  it("compares JSON by content (key order) and dates by instant", () => {
    const data: Record<string, unknown> = {
      associatedUsers: [{ domain: "CORP", user: "jo" }],
      lastSeen: "2026-11-13T10:00:00.000Z",
    };
    pruneUnchangedAssetFields(row(), data);
    expect(data).toEqual({});
    const changed: Record<string, unknown> = { associatedUsers: [{ user: "jo" }] };
    pruneUnchangedAssetFields(row(), changed);
    expect(changed).toEqual({ associatedUsers: [{ user: "jo" }] });
  });

  it("null vs a value is a change; null vs null is not", () => {
    const a: Record<string, unknown> = { hostname: null };
    pruneUnchangedAssetFields(row(), a);
    expect(a).toEqual({ hostname: null });
    const b: Record<string, unknown> = { primaryAddressIp: null };
    pruneUnchangedAssetFields(row(), b);
    expect(b).toEqual({});
  });
});
