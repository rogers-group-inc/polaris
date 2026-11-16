/**
 * tests/unit/apRadioService.test.ts
 *
 * Own suite for src/services/apRadioService.ts — a FortiAP's radio + broadcast
 * SSID inventory (AssetApRadio / AssetApVap), written by two sources
 * ("fortios" controller rows, "snmp" FORTINET-FORTIAP-MIB) and read back as a
 * radio -> SSID tree.
 *
 * Contract (change-impact entry + the service header):
 *   - merge PER COLUMN: a null never erases a stored value; only changed
 *     columns are written;
 *   - radio identity is delete-replace, and a removed radio takes its VAPs;
 *   - `vaps: undefined` keeps a radio's SSIDs, `vaps: []` wipes them;
 *   - VAP identity is the BSSID first, then the name; the controller's name
 *     wins a disagreement unless another VAP on the radio holds it;
 *   - one transaction per AP.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../../src/db.js", () => import("./_dbStub.js"));

import { prisma } from "../../src/db.js";
import { resetDbStub, stubbed } from "./_dbStub.js";
import { persistApRadioInventory, getApRadioInventory } from "../../src/services/apRadioService.js";
import type { ApRadioSample, ApVapSample } from "../../src/utils/fortiapMonitorRow.js";

const NOW = new Date("2026-11-14T12:00:00Z");
const EARLIER = new Date("2026-11-13T12:00:00Z");

function radio(over: Partial<ApRadioSample> = {}): ApRadioSample {
  return {
    radioIndex: 0, radioType: null, band: null, mode: null, channel: null, bandwidthMhz: null,
    txPowerPct: null, txPowerOper: null, txPowerConfig: null, txPowerMax: null, txPowerMode: null,
    baseBssid: null, clientCount: null, countryCode: null, ...over,
  };
}

function vap(over: Partial<ApVapSample> = {}): ApVapSample {
  return { vapName: "corp", ssid: null, bssid: null, vlanId: null, clientCount: null, ...over };
}

function storedRadio(over: Record<string, unknown> = {}) {
  return {
    id: "r0", assetId: "ap1", radioIndex: 0, radioType: null, band: null, mode: null, channel: null,
    bandwidthMhz: null, txPowerPct: null, txPowerOper: null, txPowerConfig: null, txPowerMax: null,
    txPowerMode: null, baseBssid: null, clientCount: null, countryCode: null, source: "fortios",
    firstSeen: EARLIER, lastSeen: EARLIER, ...over,
  };
}

function storedVap(over: Record<string, unknown> = {}) {
  return {
    id: "v0", assetId: "ap1", radioIndex: 0, vapName: "corp", ssid: null, bssid: null, vlanId: null,
    clientCount: null, source: "fortios", firstSeen: EARLIER, lastSeen: EARLIER, ...over,
  };
}

function given(radios: unknown[], vaps: unknown[]): void {
  stubbed(prisma.assetApRadio.findMany).mockResolvedValue(radios);
  stubbed(prisma.assetApVap.findMany).mockResolvedValue(vaps);
}

const calls = {
  radioCreates: () => stubbed(prisma.assetApRadio.create).mock.calls.map((c) => c[0].data),
  radioUpdates: () => stubbed(prisma.assetApRadio.update).mock.calls.map((c) => c[0]),
  vapCreates: () => stubbed(prisma.assetApVap.create).mock.calls.map((c) => c[0].data),
  vapUpdates: () => stubbed(prisma.assetApVap.update).mock.calls.map((c) => c[0]),
  radioDeletes: () => stubbed(prisma.assetApRadio.deleteMany).mock.calls.map((c) => c[0].where.id.in),
  vapDeletes: () => stubbed(prisma.assetApVap.deleteMany).mock.calls.map((c) => c[0].where.id.in),
};

beforeEach(() => {
  resetDbStub();
  given([], []);
});

// ─── persistApRadioInventory ───────────────────────────────────────────────

describe("persistApRadioInventory — radios", () => {
  it("creates a new radio with its non-null columns, the source and firstSeen = lastSeen = now", async () => {
    const out = await persistApRadioInventory("ap1", [radio({ radioIndex: 1, band: "5GHz", channel: 36, txPowerPct: 50 })], "fortios", NOW);

    expect(out).toEqual({ radios: 1, vaps: 0, removedRadios: 0 });
    expect(calls.radioCreates()).toEqual([{
      assetId: "ap1", radioIndex: 1, band: "5GHz", channel: 36, txPowerPct: 50,
      source: "fortios", firstSeen: NOW, lastSeen: NOW,
    }]);
  });

  it("reads both tables scoped to the asset", async () => {
    await persistApRadioInventory("ap1", [], "snmp", NOW);
    expect(prisma.assetApRadio.findMany).toHaveBeenCalledWith({ where: { assetId: "ap1" } });
    expect(prisma.assetApVap.findMany).toHaveBeenCalledWith({ where: { assetId: "ap1" } });
  });

  it("a steady-state scrape updates only source + lastSeen", async () => {
    given([storedRadio({ band: "2.4GHz", channel: 6 })], []);

    await persistApRadioInventory("ap1", [radio({ band: "2.4GHz", channel: 6 })], "fortios", NOW);

    expect(calls.radioUpdates()).toEqual([{ where: { id: "r0" }, data: { source: "fortios", lastSeen: NOW } }]);
    expect(calls.radioCreates()).toEqual([]);
  });

  it("a null from the other source never erases a stored column; a changed value is written", async () => {
    given([storedRadio({ txPowerPct: 80, txPowerMax: 20, channel: 6 })], []);

    await persistApRadioInventory("ap1", [radio({ txPowerPct: null, txPowerMax: null, channel: 11, txPowerConfig: 17 })], "snmp", NOW);

    expect(calls.radioUpdates()[0].data).toEqual({ channel: 11, txPowerConfig: 17, source: "snmp", lastSeen: NOW });
  });

  it("writes a zero (a falsy but real value)", async () => {
    given([storedRadio({ clientCount: 4 })], []);
    await persistApRadioInventory("ap1", [radio({ clientCount: 0 })], "fortios", NOW);
    expect(calls.radioUpdates()[0].data).toMatchObject({ clientCount: 0 });
  });

  it("deletes a radio absent from the scrape, and its VAPs with it", async () => {
    given(
      [storedRadio({ id: "r0", radioIndex: 0 }), storedRadio({ id: "r1", radioIndex: 1 })],
      [storedVap({ id: "v0", radioIndex: 0 }), storedVap({ id: "v1", radioIndex: 1, vapName: "guest" })],
    );

    const out = await persistApRadioInventory("ap1", [radio({ radioIndex: 0 })], "fortios", NOW);

    expect(out.removedRadios).toBe(1);
    expect(calls.radioDeletes()).toEqual([["r1"]]);
    // Radio 0 sent no VAP list, so its SSID is kept; radio 1's goes with it.
    expect(calls.vapDeletes()).toEqual([["v1"]]);
  });

  it("an empty scrape deletes every radio and every VAP", async () => {
    given([storedRadio()], [storedVap()]);
    const out = await persistApRadioInventory("ap1", [], "snmp", NOW);
    expect(out).toEqual({ radios: 0, vaps: 0, removedRadios: 1 });
    expect(calls.radioDeletes()).toEqual([["r0"]]);
    expect(calls.vapDeletes()).toEqual([["v0"]]);
  });

  it("issues every write in ONE transaction", async () => {
    given([storedRadio({ id: "r1", radioIndex: 1 })], []);
    await persistApRadioInventory("ap1", [radio({ radioIndex: 0, vaps: [vap()] })], "fortios", NOW);
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    // radio create + vap create + radio deleteMany
    expect(stubbed(prisma.$transaction).mock.calls[0][0]).toHaveLength(3);
  });

  it("opens no transaction when there is nothing to write", async () => {
    await persistApRadioInventory("ap1", [], "fortios", NOW);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("defaults `now` to the current time", async () => {
    const before = Date.now();
    await persistApRadioInventory("ap1", [radio()], "fortios");
    const data = calls.radioCreates()[0];
    expect((data.lastSeen as Date).getTime()).toBeGreaterThanOrEqual(before);
    expect(data.firstSeen).toBe(data.lastSeen);
  });
});

describe("persistApRadioInventory — VAPs: undefined vs empty", () => {
  it("keeps a radio's stored SSIDs when its sample carries no vaps field", async () => {
    given([storedRadio()], [storedVap({ id: "v0" }), storedVap({ id: "v1", vapName: "guest" })]);
    const out = await persistApRadioInventory("ap1", [radio()], "snmp", NOW);
    expect(out.vaps).toBe(0);
    expect(calls.vapDeletes()).toEqual([]);
    expect(calls.vapUpdates()).toEqual([]);
  });

  it("wipes a radio's SSIDs when its sample says vaps: []", async () => {
    given([storedRadio()], [storedVap({ id: "v0" })]);
    await persistApRadioInventory("ap1", [radio({ vaps: [] })], "fortios", NOW);
    expect(calls.vapDeletes()).toEqual([["v0"]]);
  });

  it("deletes a stored VAP the radio no longer lists", async () => {
    given([storedRadio()], [storedVap({ id: "v0", vapName: "corp" }), storedVap({ id: "v1", vapName: "old" })]);
    await persistApRadioInventory("ap1", [radio({ vaps: [vap({ vapName: "corp" })] })], "fortios", NOW);
    expect(calls.vapDeletes()).toEqual([["v1"]]);
  });
});

describe("persistApRadioInventory — VAP identity", () => {
  it("creates a new VAP with its merged columns", async () => {
    const out = await persistApRadioInventory("ap1", [radio({ radioIndex: 1, vaps: [vap({ vapName: "corp-5g", ssid: "CORP", bssid: "aa:bb:cc:00:00:01", vlanId: 10 })] })], "fortios", NOW);
    expect(out.vaps).toBe(1);
    expect(calls.vapCreates()).toEqual([{
      assetId: "ap1", radioIndex: 1, vapName: "corp-5g", ssid: "CORP", bssid: "aa:bb:cc:00:00:01", vlanId: 10,
      source: "fortios", firstSeen: NOW, lastSeen: NOW,
    }]);
  });

  it("matches the controller's row from an SNMP scrape by BSSID (case-blind) and keeps the controller's name", async () => {
    given([storedRadio()], [storedVap({ id: "v0", vapName: "corp-2g", ssid: "CORP", bssid: "AA:BB:CC:00:00:01" })]);

    await persistApRadioInventory("ap1", [radio({ vaps: [vap({ vapName: "CORP", ssid: "CORP", bssid: "aa:bb:cc:00:00:01", clientCount: 5 })] })], "snmp", NOW);

    expect(calls.vapCreates()).toEqual([]);
    expect(calls.vapDeletes()).toEqual([]);
    const upd = calls.vapUpdates();
    expect(upd).toHaveLength(1);
    expect(upd[0].where).toEqual({ id: "v0" });
    expect(upd[0].data).not.toHaveProperty("vapName");
    expect(upd[0].data).toMatchObject({ clientCount: 5, source: "snmp", lastSeen: NOW });
  });

  it("renames an SNMP-named row to the controller's VAP name when FortiOS reports the same BSSID", async () => {
    given([storedRadio()], [storedVap({ id: "v0", vapName: "CORP", bssid: "AA:BB:CC:00:00:01", source: "snmp" })]);

    await persistApRadioInventory("ap1", [radio({ vaps: [vap({ vapName: "corp-2g", bssid: "AA:BB:CC:00:00:01" })] })], "fortios", NOW);

    expect(calls.vapUpdates()).toEqual([{ where: { id: "v0" }, data: { vapName: "corp-2g", source: "fortios", lastSeen: NOW } }]);
    // The row was booked under its stored name, so it is not deleted as stale.
    expect(calls.vapDeletes()).toEqual([]);
  });

  it("refuses the rename when another VAP on the radio already holds the name", async () => {
    given([storedRadio()], [
      storedVap({ id: "v0", vapName: "CORP", bssid: "AA:BB:CC:00:00:01" }),
      storedVap({ id: "v1", vapName: "corp-2g", bssid: "AA:BB:CC:00:00:09" }),
    ]);

    await persistApRadioInventory("ap1", [radio({
      vaps: [vap({ vapName: "corp-2g", bssid: "AA:BB:CC:00:00:01" })],
    })], "fortios", NOW);

    const v0 = calls.vapUpdates().find((u) => u.where.id === "v0")!;
    expect(v0.data).not.toHaveProperty("vapName");
  });

  it("allows a name another radio holds (the unique key is per radio)", async () => {
    given([storedRadio({ id: "r0", radioIndex: 0 }), storedRadio({ id: "r1", radioIndex: 1 })], [
      storedVap({ id: "v0", radioIndex: 0, vapName: "CORP", bssid: "AA:00:00:00:00:01" }),
      storedVap({ id: "v1", radioIndex: 1, vapName: "corp", bssid: "AA:00:00:00:00:02" }),
    ]);

    await persistApRadioInventory("ap1", [
      radio({ radioIndex: 0, vaps: [vap({ vapName: "corp", bssid: "AA:00:00:00:00:01" })] }),
      radio({ radioIndex: 1 }),
    ], "fortios", NOW);

    expect(calls.vapUpdates().find((u) => u.where.id === "v0")!.data).toMatchObject({ vapName: "corp" });
  });

  it("does not match a BSSID across radios", async () => {
    given([storedRadio({ id: "r0", radioIndex: 0 }), storedRadio({ id: "r1", radioIndex: 1 })], [
      storedVap({ id: "v0", radioIndex: 0, vapName: "corp", bssid: "AA:00:00:00:00:01" }),
    ]);

    await persistApRadioInventory("ap1", [
      radio({ radioIndex: 0, vaps: [] }),
      radio({ radioIndex: 1, vaps: [vap({ vapName: "corp", bssid: "AA:00:00:00:00:01" })] }),
    ], "fortios", NOW);

    expect(calls.vapCreates()).toHaveLength(1);
    expect(calls.vapCreates()[0]).toMatchObject({ radioIndex: 1 });
    expect(calls.vapDeletes()).toEqual([["v0"]]);
  });

  it("falls back to the name when the incoming VAP has no BSSID, and updates only changed columns", async () => {
    given([storedRadio()], [storedVap({ id: "v0", vapName: "corp", ssid: "CORP", vlanId: 10 })]);

    await persistApRadioInventory("ap1", [radio({ vaps: [vap({ vapName: "corp", ssid: "CORP", vlanId: 20 })] })], "fortios", NOW);

    expect(calls.vapUpdates()).toEqual([{ where: { id: "v0" }, data: { vlanId: 20, source: "fortios", lastSeen: NOW } }]);
  });

  it("follows a radio whose VAP's BSSID changed by name, adopting the new BSSID", async () => {
    given([storedRadio()], [storedVap({ id: "v0", vapName: "corp", bssid: "AA:00:00:00:00:01" })]);
    await persistApRadioInventory("ap1", [radio({ vaps: [vap({ vapName: "corp", bssid: "AA:00:00:00:00:77" })] })], "fortios", NOW);
    expect(calls.vapUpdates()[0].data).toMatchObject({ bssid: "AA:00:00:00:00:77" });
    expect(calls.vapCreates()).toEqual([]);
  });

  // Was a bug until 2026-11-14: the name fallback ignores that a stored row was already claimed by
  // BSSID earlier in the same scrape. Stored: one VAP "corp-2g" on BSSID B1.
  // FortiOS now reports two VAPs on the radio: "guest" on B1 and "corp-2g" on
  // B2 (an operator renamed/added a VAP, shifting the slot). The first matches
  // the stored row by BSSID and renames it to "guest"; the second misses on
  // B2, falls back to the STALE name index, hits the same stored row and
  // overwrites its bssid with B2. Result: one row ("guest" on B2), the
  // reported "corp-2g" VAP is lost, and `vaps` says 2. Right: the stored row
  // becomes "guest" on B1 and "corp-2g" on B2 is created.
  it("does not let a second incoming VAP re-claim a row the BSSID already matched", async () => {
    given([storedRadio()], [storedVap({ id: "v0", vapName: "corp-2g", bssid: "B1:00:00:00:00:01" })]);

    await persistApRadioInventory("ap1", [radio({
      vaps: [
        vap({ vapName: "guest", bssid: "B1:00:00:00:00:01" }),
        vap({ vapName: "corp-2g", bssid: "B2:00:00:00:00:02" }),
      ],
    })], "fortios", NOW);

    expect(calls.vapCreates()).toHaveLength(1);
    expect(calls.vapCreates()[0]).toMatchObject({ vapName: "corp-2g", bssid: "B2:00:00:00:00:02" });
    for (const u of calls.vapUpdates()) expect(u.data.bssid).not.toBe("B2:00:00:00:00:02");
  });

  it("counts every reported VAP across radios", async () => {
    const out = await persistApRadioInventory("ap1", [
      radio({ radioIndex: 0, vaps: [vap({ vapName: "a" }), vap({ vapName: "b" })] }),
      radio({ radioIndex: 1, vaps: [vap({ vapName: "a" })] }),
      radio({ radioIndex: 2 }),
    ], "fortios", NOW);
    expect(out).toEqual({ radios: 3, vaps: 3, removedRadios: 0 });
    expect(calls.vapCreates()).toHaveLength(3);
  });
});

// ─── getApRadioInventory ───────────────────────────────────────────────────

describe("getApRadioInventory", () => {
  it("answers [] for an asset with no radios, without shaping VAPs", async () => {
    given([], [storedVap()]);
    expect(await getApRadioInventory("ap1")).toEqual([]);
  });

  it("orders radios by index and VAPs by radio, SSID, then name", async () => {
    await getApRadioInventory("ap1");
    expect(prisma.assetApRadio.findMany).toHaveBeenCalledWith({ where: { assetId: "ap1" }, orderBy: { radioIndex: "asc" } });
    expect(prisma.assetApVap.findMany).toHaveBeenCalledWith({
      where: { assetId: "ap1" },
      orderBy: [{ radioIndex: "asc" }, { ssid: "asc" }, { vapName: "asc" }],
    });
  });

  it("nests each VAP under its radio, drops ids / asset ids / firstSeen, and gives a VAP-less radio []", async () => {
    given(
      [storedRadio({ id: "r0", radioIndex: 0, band: "2.4GHz", channel: 6 }), storedRadio({ id: "r1", radioIndex: 1 })],
      [
        storedVap({ id: "v0", radioIndex: 0, vapName: "corp", ssid: "CORP", bssid: "AA", vlanId: 10, clientCount: 3 }),
        storedVap({ id: "v9", radioIndex: 7, vapName: "orphan" }),
      ],
    );

    const out = await getApRadioInventory("ap1");

    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({
      radioIndex: 0, radioType: null, band: "2.4GHz", mode: null, channel: 6, bandwidthMhz: null,
      txPowerPct: null, txPowerOper: null, txPowerConfig: null, txPowerMax: null, txPowerMode: null,
      baseBssid: null, clientCount: null, countryCode: null, source: "fortios", lastSeen: EARLIER,
      vaps: [{ vapName: "corp", ssid: "CORP", bssid: "AA", vlanId: 10, clientCount: 3, source: "fortios", lastSeen: EARLIER }],
    });
    expect(out[1].vaps).toEqual([]);
    // A VAP whose radio row is gone is not shown anywhere.
    expect(JSON.stringify(out)).not.toContain("orphan");
  });
});
