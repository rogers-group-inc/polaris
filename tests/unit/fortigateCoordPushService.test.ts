/**
 * tests/unit/fortigateCoordPushService.test.ts — geocoded coordinate
 * write-back. FortiManager writes BOTH the per-device metavars and the CMDB GUI
 * coords (partial success is ok); a standalone FortiGate writes only CMDB via
 * FortiOS REST with `.toFixed(6)` strings; failures are returned, never thrown.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({ metavars: vi.fn(), cmdb: vi.fn(), fg: vi.fn() }));

vi.mock("../../src/services/fortimanagerService.js", () => ({
  setFmgDeviceMetavarCoords: h.metavars,
  setFmgDeviceCmdbGuiCoords: h.cmdb,
}));
vi.mock("../../src/services/fortigateService.js", () => ({ fgRequest: h.fg }));

import { pushCoordsToFortigate } from "../../src/services/fortigateCoordPushService.js";

const FMG = { id: "int-fmg", type: "fortimanager", config: { host: "fmg.example", adom: "root" } };
const FGT = { id: "int-fgt", type: "fortigate", config: { host: "fgt.example", apiToken: "tok", vdom: "" } };

beforeEach(() => {
  for (const f of Object.values(h)) {
    f.mockReset();
    f.mockResolvedValue(undefined);
  }
});

describe("pushCoordsToFortigate — FortiManager", () => {
  it("writes metavars then CMDB and reports both targets", async () => {
    expect(await pushCoordsToFortigate(FMG, "FGT-BR01", 35.123456789, -86.5)).toEqual({ ok: true, targets: ["fmg_metavars", "fmg_cmdb"] });
    expect(h.metavars).toHaveBeenCalledWith(FMG.config, "FGT-BR01", 35.123456789, -86.5, "Latitude", "Longitude", "int-fmg");
    expect(h.cmdb).toHaveBeenCalledWith(FMG.config, "FGT-BR01", 35.123456789, -86.5, "int-fmg");
    expect(h.fg).not.toHaveBeenCalled();
  });

  it("uses the operator's metavar names, trimmed, and the defaults for blank ones", async () => {
    await pushCoordsToFortigate(FMG, "d", 1, 2, "  SiteLat ", "   ");
    expect(h.metavars.mock.calls[0].slice(4, 6)).toEqual(["SiteLat", "Longitude"]);
  });

  it("is still ok when only one target landed", async () => {
    h.metavars.mockRejectedValue(new Error("-10: object does not exist"));
    expect(await pushCoordsToFortigate(FMG, "d", 1, 2)).toEqual({ ok: true, targets: ["fmg_cmdb"] });
    h.metavars.mockResolvedValue(undefined);
    h.cmdb.mockRejectedValue(new Error("no permission"));
    expect(await pushCoordsToFortigate(FMG, "d", 1, 2)).toEqual({ ok: true, targets: ["fmg_metavars"] });
  });

  it("fails with both reasons when neither target landed", async () => {
    h.metavars.mockRejectedValue(new Error("mv broke"));
    h.cmdb.mockRejectedValue(new Error("cmdb broke"));
    expect(await pushCoordsToFortigate(FMG, "d", 1, 2)).toEqual({ ok: false, targets: [], error: "metavars: mv broke; cmdb: cmdb broke" });
  });

  it("says what failed even when an error has no message", async () => {
    h.metavars.mockRejectedValue({});
    h.cmdb.mockRejectedValue(null);
    expect(await pushCoordsToFortigate(FMG, "d", 1, 2)).toEqual({ ok: false, targets: [], error: "metavars: metavar write failed; cmdb: CMDB write failed" });
  });
});

describe("pushCoordsToFortigate — standalone FortiGate", () => {
  it("PUTs the CMDB GUI coords as six-decimal strings, in the root vdom when none is set", async () => {
    expect(await pushCoordsToFortigate(FGT, "ignored", 35.1, -86.123456789)).toEqual({ ok: true, targets: ["fortigate_cmdb"] });
    expect(h.fg).toHaveBeenCalledWith(
      { ...FGT.config, vdom: "root" },
      "PUT",
      "/api/v2/cmdb/system/global",
      { query: { vdom: "root" }, body: { "gui-device-latitude": "35.100000", "gui-device-longitude": "-86.123457" } },
    );
    expect(h.metavars).not.toHaveBeenCalled();
    expect(h.cmdb).not.toHaveBeenCalled();
  });

  it("keeps a configured vdom", async () => {
    await pushCoordsToFortigate({ ...FGT, config: { ...FGT.config, vdom: "branch" } }, "d", 0, 0);
    expect(h.fg.mock.calls[0][0].vdom).toBe("branch");
    expect(h.fg.mock.calls[0][3].query).toEqual({ vdom: "branch" });
  });

  it("refuses without calling out when host or token is missing", async () => {
    for (const config of [{ apiToken: "t" }, { host: "h" }, null]) {
      const r = await pushCoordsToFortigate({ ...FGT, config }, "d", 1, 2);
      expect(r).toEqual({ ok: false, targets: [], error: "Standalone FortiGate integration missing host or apiToken" });
    }
    expect(h.fg).not.toHaveBeenCalled();
  });

  it("returns the REST failure instead of throwing", async () => {
    h.fg.mockRejectedValue(new Error("HTTP 403"));
    expect(await pushCoordsToFortigate(FGT, "d", 1, 2)).toEqual({ ok: false, targets: [], error: "HTTP 403" });
  });
});

describe("pushCoordsToFortigate — other integration types", () => {
  it("is not supported, and calls nothing", async () => {
    expect(await pushCoordsToFortigate({ id: "x", type: "vcenter", config: {} }, "d", 1, 2)).toEqual({
      ok: false, targets: [], error: 'Coord write-back is not supported for integration type "vcenter"',
    });
    for (const f of Object.values(h)) expect(f).not.toHaveBeenCalled();
  });
});
