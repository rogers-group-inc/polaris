/**
 * tests/unit/interfacePickerDescriptions.test.ts — the automation builder's
 * interface picker offers each pinned interface's DESCRIPTION beside its name,
 * because the engine's `ifNamePattern` matches either (interfacePatternMatch).
 *
 * Without it the one word that selects a circuit on every gate ("ATT EPLS", a
 * VLAN's name on one FortiGate and port25's description on another) was never
 * on offer, and the picker listed only "port25" for the second gate.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const db = {
  assets: [] as { id: string; monitoredInterfaces: string[] }[],
  interfaces: [] as { assetId: string; ifName: string; alias: string | null; poeStatus: string | null }[],
};

vi.mock("../../src/db.js", () => ({
  prisma: {
    asset: {
      findMany: async ({ where }: any) => db.assets.filter((a) => where.id.in.includes(a.id)),
    },
    assetInterface: {
      findMany: async ({ where }: any) =>
        db.interfaces.filter((r) =>
          where.assetId.in.includes(r.assetId)
          && (where.alias === undefined || r.alias !== null)
          && (where.poeStatus === undefined || r.poeStatus !== null)),
    },
  },
}));
vi.mock("../../src/services/notificationEngine.js", () => ({
  loadScopeAssetIds: async () => db.assets.map((a) => a.id),
}));

import { listDimensionValues } from "../../src/services/notificationDimensionService.js";

beforeEach(() => {
  db.assets = [
    { id: "a1", monitoredInterfaces: ["ATT EPLS"] },
    { id: "a2", monitoredInterfaces: ["port25"] },
  ];
  db.interfaces = [
    { assetId: "a1", ifName: "ATT EPLS", alias: null, poeStatus: null },
    { assetId: "a2", ifName: "port25", alias: "ATT EPLS", poeStatus: null },
    // Described but NOT pinned: a rule can never fire about it, so not offered.
    { assetId: "a2", ifName: "port26", alias: "Spare circuit", poeStatus: null },
    // A description that only repeats the name adds nothing.
    { assetId: "a1", ifName: "wan1", alias: "wan1", poeStatus: null },
  ];
});

describe("ifNamePattern picker", () => {
  it("offers a pinned interface's description, counted per device", async () => {
    const res = await listDimensionValues("ifOperStatus", "ifNamePattern", { allAssets: true });
    const byValue = Object.fromEntries(res.values.map((v) => [v.value, v.assetCount]));
    // Both gates carry "ATT EPLS" — one by name, one by description.
    expect(byValue["ATT EPLS"]).toBe(2);
    expect(byValue["port25"]).toBe(1);
    expect(byValue["Spare circuit"]).toBeUndefined();
    expect(byValue["wan1"]).toBeUndefined();
  });

  it("offers descriptions on the PoE-fault source too", async () => {
    db.interfaces = [{ assetId: "a2", ifName: "port7", alias: "Lobby AP", poeStatus: "fault" }];
    const res = await listDimensionValues("poeStatus", "ifNamePattern", { allAssets: true }, { stateOperator: "==", stateValue: "fault" });
    expect(res.values.map((v) => v.value).sort()).toEqual(["Lobby AP", "port7"]);
  });
});
