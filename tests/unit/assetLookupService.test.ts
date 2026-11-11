/**
 * tests/unit/assetLookupService.test.ts — the lookups and imports moved out of
 * routes/assets/lookups.ts (CQ-B062 slice 2): forward lookup runs the
 * route's retarget guard before writing, the PDF import runs it per matched
 * row and refuses a status that enters quarantine, the OUI sweep writes one
 * statement per vendor, and the CSV import only back-dates. The HTTP contract
 * of the CSV import is tests/integration/assetsImportBackdate.test.ts.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const m = vi.hoisted(() => ({
  findUnique: vi.fn(), findFirst: vi.fn(), findMany: vi.fn(), update: vi.fn(), updateMany: vi.fn(), create: vi.fn(), transaction: vi.fn(),
  logEvent: vi.fn(), resolver: { lookup: vi.fn(), reverse: vi.fn() }, lookupOui: vi.fn(), lookupOuiOverride: vi.fn(),
}));
vi.mock("../../src/db.js", () => ({
  prisma: { asset: { findUnique: m.findUnique, findFirst: m.findFirst, findMany: m.findMany, update: m.update, updateMany: m.updateMany, create: m.create }, $transaction: m.transaction },
}));
vi.mock("../../src/services/eventLogService.js", () => ({ logEvent: m.logEvent, logEventsBatch: vi.fn(), buildFirmwareChangedEvent: () => null }));
vi.mock("../../src/services/dnsService.js", () => ({ getConfiguredResolver: async () => m.resolver }));
vi.mock("../../src/services/ouiService.js", () => ({ lookupOui: m.lookupOui, lookupOuiOverride: m.lookupOuiOverride }));

import { assetForwardLookup, importPdfAssets, bulkOuiLookup, importFirstSeenDates } from "../../src/services/assetLookupService.js";

beforeEach(() => {
  for (const f of Object.values(m)) if (typeof f === "function") f.mockReset();
  m.resolver.lookup.mockReset(); m.resolver.reverse.mockReset();
});

describe("assetForwardLookup", () => {
  it("refuses an asset that already has an address", async () => {
    m.findUnique.mockResolvedValue({ id: "a", ipAddress: "10.0.0.1", hostname: "h", dnsName: null });
    await expect(assetForwardLookup("a", "op", vi.fn())).rejects.toMatchObject({ httpStatus: 400 });
  });
  it("runs the retarget guard before writing, and does not write when it refuses", async () => {
    m.findUnique.mockResolvedValue({ id: "a", ipAddress: null, hostname: "fg1", dnsName: null, discoveredByIntegration: { type: "fortigate" } });
    m.resolver.lookup.mockResolvedValue([{ address: "10.0.0.9" }]);
    const guard = vi.fn(() => { throw Object.assign(new Error("needs integrations"), { httpStatus: 403 }); });
    await expect(assetForwardLookup("a", "op", guard)).rejects.toMatchObject({ httpStatus: 403 });
    expect(guard).toHaveBeenCalledWith(expect.objectContaining({ id: "a" }), "10.0.0.9");
    expect(m.update).not.toHaveBeenCalled();
  });
});

describe("importPdfAssets", () => {
  it("runs the retarget guard per matched row and refuses a row that enters quarantine", async () => {
    m.findFirst.mockResolvedValue({ id: "a", hostname: "h", ipAddress: "10.0.0.1", status: "active", os: null, discoveredByIntegration: null });
    const guard = vi.fn();
    await expect(importPdfAssets([{ serialNumber: "S1", ipAddress: "10.0.0.2", status: "quarantined" }], false, "op", guard)).rejects.toMatchObject({ httpStatus: 400 });
    expect(guard).toHaveBeenCalledWith(expect.objectContaining({ id: "a" }), "10.0.0.2");
    expect(m.update).not.toHaveBeenCalled();
  });
  it("a dry run previews creates and updates without writing", async () => {
    m.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: "b", hostname: "old", ipAddress: null, status: "active", os: null });
    const r = await importPdfAssets([{ serialNumber: "NEW" }, { serialNumber: "S2", hostname: "new" }], true, "op", vi.fn());
    expect(r).toMatchObject({ created: 0, updated: 0, dryRun: true });
    expect(r.preview.map((p: { action: string }) => p.action)).toEqual(["create", "update"]);
    expect(m.create).not.toHaveBeenCalled();
    expect(m.update).not.toHaveBeenCalled();
  });
});

describe("bulkOuiLookup", () => {
  it("writes one statement per vendor, not per asset", async () => {
    m.findMany.mockResolvedValue([
      { id: "1", macAddress: "00:11:22:00:00:01" }, { id: "2", macAddress: "00:11:22:00:00:02" }, { id: "3", macAddress: "AA:BB:CC:00:00:03" },
    ]);
    m.lookupOui.mockImplementation(async (mac: string) => (mac.startsWith("00:11:22") ? "Acme" : null));
    m.lookupOuiOverride.mockResolvedValue(null);
    const r = await bulkOuiLookup("op");
    expect(r).toMatchObject({ total: 3, resolved: 2, failed: 1 });
    expect(m.updateMany).toHaveBeenCalledTimes(1);
    expect(m.updateMany).toHaveBeenCalledWith({ where: { id: { in: ["1", "2"] } }, data: { manufacturer: "Acme" } });
  });
});

describe("importFirstSeenDates", () => {
  it("only back-dates (never moves first-seen later) and counts unknown serials", async () => {
    m.findMany.mockResolvedValue([{ id: "a", serialNumber: "S1", hostname: "h", createdAt: new Date("2026-06-01") }]);
    m.transaction.mockResolvedValue([]);
    const r = await importFirstSeenDates([
      { serialNumber: "S1", date: "2026-01-01" }, { serialNumber: "S1", date: "2026-09-01" }, { serialNumber: "NOPE", date: "2026-01-01" },
    ], false, "op");
    expect(r.notFound).toBe(1);
    expect(r.preview.map((p: { willUpdate: boolean }) => p.willUpdate)).toEqual([true, false]);
    expect(r.updated).toBe(1);
  });
});
