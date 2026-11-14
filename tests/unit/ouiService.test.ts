/**
 * tests/unit/ouiService.test.ts — CQ-T010 own suite for
 * src/services/ouiService.ts.
 *
 * The service keeps module-level caches (the IEEE map and the overrides map),
 * so every test re-imports it after `vi.resetModules()` — and the Prisma stub
 * with it, since the reset re-evaluates that module too. `fetch` is stubbed;
 * nothing touches the network.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../../src/db.js", () => import("./_dbStub.js"));
vi.mock("../../src/utils/logger.js", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

type Oui = typeof import("../../src/services/ouiService.js");
type Fn = ReturnType<typeof vi.fn>;

let oui: Oui;
let settingFind: Fn;
let settingUpsert: Fn;
let settings: Record<string, unknown>;
let fetchMock: Fn;

beforeEach(async () => {
  vi.resetModules();
  const db = await import("../../src/db.js");
  const stub = await import("./_dbStub.js");
  stub.resetDbStub();
  settingFind = stub.stubbed(db.prisma.setting.findUnique);
  settingUpsert = stub.stubbed(db.prisma.setting.upsert);
  settings = {};
  settingFind.mockImplementation(async (args: { where: { key: string } }) =>
    args.where.key in settings ? { key: args.where.key, value: settings[args.where.key] } : null);
  settingUpsert.mockImplementation(async (args: { where: { key: string }; update: { value: unknown } }) => {
    settings[args.where.key] = args.update.value;
    return {};
  });
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  oui = await import("../../src/services/ouiService.js");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const IEEE = { entries: 2, refreshedAt: "2026-11-01T00:00:00.000Z", data: { "2C549A": "Example Corp", AABBCC: "Acme Networks" } };

describe("lookupOui", () => {
  it("resolves the vendor for colon, dash, dotted, bare and lower-case MACs", async () => {
    settings.oui_database = IEEE;
    for (const mac of ["2C:54:9A:00:11:22", "2c-54-9a-00-11-22", "2c54.9a00.1122", "2C549A001122", " 2c 54 9a 00 11 22 "]) {
      expect(await oui.lookupOui(mac)).toBe("Example Corp");
    }
  });

  it("returns null for an unknown prefix, a short or empty MAC, or an empty database", async () => {
    settings.oui_database = IEEE;
    expect(await oui.lookupOui("00:00:01:00:00:00")).toBeNull();
    expect(await oui.lookupOui("2C:54")).toBeNull();
    expect(await oui.lookupOui("")).toBeNull();
  });

  it("returns null with no database row at all", async () => {
    expect(await oui.lookupOui("2C:54:9A:00:11:22")).toBeNull();
  });

  it("an override outranks the IEEE entry", async () => {
    settings.oui_database = IEEE;
    settings.oui_overrides = { "2C549A": { manufacturer: "Override Co", device: "Widget" } };
    expect(await oui.lookupOui("2c:54:9a:01:02:03")).toBe("Override Co");
  });

  it("loads the IEEE map from the database once per process", async () => {
    settings.oui_database = IEEE;
    await oui.lookupOui("2C:54:9A:00:11:22");
    await oui.lookupOui("AA:BB:CC:00:11:22");
    const dbReads = settingFind.mock.calls.filter((c) => c[0].where.key === "oui_database");
    expect(dbReads).toHaveLength(1);
  });
});

describe("lookupOuiOverride", () => {
  it("reads only the overrides — no IEEE fallback", async () => {
    settings.oui_database = IEEE;
    expect(await oui.lookupOuiOverride("2C:54:9A:00:00:00")).toBeNull();
    expect(settingFind.mock.calls.some((c) => c[0].where.key === "oui_database")).toBe(false);
  });

  it("accepts legacy bare-string overrides and drops malformed entries", async () => {
    settings.oui_overrides = { "112233": "Legacy Vendor", "445566": { manufacturer: "New", device: "Cam" }, "778899": { device: "no maker" }, AABBCC: 7 };
    expect(await oui.lookupOuiOverride("11-22-33-44-55-66")).toEqual({ manufacturer: "Legacy Vendor" });
    expect(await oui.lookupOuiOverride("445566000000")).toEqual({ manufacturer: "New", device: "Cam" });
    expect(await oui.lookupOuiOverride("778899000000")).toBeNull();
    expect(await oui.lookupOuiOverride("AABBCC000000")).toBeNull();
    expect(await oui.lookupOuiOverride("x")).toBeNull();
  });
});

describe("lookupOuiDetailed", () => {
  it("reports the IEEE hit, the override and which one is effective", async () => {
    settings.oui_database = IEEE;
    settings.oui_overrides = { AABBCC: { manufacturer: "Mine", device: "Sensor" } };
    expect(await oui.lookupOuiDetailed("2c:54:9a")).toEqual({
      prefix: "2C:54:9A", normalized: "2C549A", ieee: "Example Corp", override: null, effective: "Example Corp", source: "ieee",
    });
    expect(await oui.lookupOuiDetailed("AA-BB-CC-DD-EE-FF")).toEqual({
      prefix: "AA:BB:CC", normalized: "AABBCC", ieee: "Acme Networks", override: { manufacturer: "Mine", device: "Sensor" }, effective: "Mine", source: "override",
    });
  });

  it("reports nothing found for a valid prefix in neither source", async () => {
    expect(await oui.lookupOuiDetailed("00:11:22")).toEqual({
      prefix: "00:11:22", normalized: "001122", ieee: null, override: null, effective: null, source: null,
    });
  });

  it("zero-pads empty input into prefix 00:00:00 (current behaviour; the route never passes an empty param)", async () => {
    expect((await oui.lookupOuiDetailed("")).normalized).toBe("000000");
  });

  // BUG: the docstring says "Returns null `prefix` for malformed input", and
  // GET /server-settings/oui/lookup/:prefix turns a null `normalized` into a
  // 400. Non-hex input "zz:zz:zz" normalizes to "ZZZZZZ" and comes back as
  // prefix "ZZ:ZZ:ZZ" (a 200 with an impossible OUI); it should be
  // { prefix: null, normalized: null, … }.
  it.fails("returns a null prefix for non-hex input", async () => {
    expect(await oui.lookupOuiDetailed("zz:zz:zz")).toMatchObject({ prefix: null, normalized: null });
  });

  // BUG: the route's 400 message says "supply at least 3 bytes", but input
  // shorter than 3 bytes is zero-padded into a DIFFERENT prefix: "AB" reads as
  // AB:00:00 and reports that OUI's vendor. It should be { prefix: null,
  // normalized: null } so the route answers 400.
  it.fails("returns a null prefix for fewer than 3 bytes", async () => {
    expect(await oui.lookupOuiDetailed("AB")).toMatchObject({ prefix: null, normalized: null });
  });
});

describe("OUI overrides — set / get / delete", () => {
  it("stores an override under the normalized prefix, persists it and returns the display form", async () => {
    const out = await oui.setOuiOverride("aa-bb-cc", "Acme", "Camera");
    expect(out).toEqual({ prefix: "AA:BB:CC", manufacturer: "Acme", device: "Camera" });
    expect(settingUpsert).toHaveBeenCalledWith({
      where: { key: "oui_overrides" },
      update: { value: { AABBCC: { manufacturer: "Acme", device: "Camera" } } },
      create: { key: "oui_overrides", value: { AABBCC: { manufacturer: "Acme", device: "Camera" } } },
    });
    expect(await oui.lookupOui("AA:BB:CC:01:02:03")).toBe("Acme");
  });

  it("omits an empty device", async () => {
    expect(await oui.setOuiOverride("AABBCC", "Acme", "")).toEqual({ prefix: "AA:BB:CC", manufacturer: "Acme" });
    expect(settings.oui_overrides).toEqual({ AABBCC: { manufacturer: "Acme" } });
  });

  it("keeps existing overrides when adding one", async () => {
    settings.oui_overrides = { "112233": "Legacy" };
    await oui.setOuiOverride("44:55:66", "New");
    expect(settings.oui_overrides).toEqual({ "112233": { manufacturer: "Legacy" }, "445566": { manufacturer: "New" } });
  });

  it("lists overrides sorted by prefix, device only when set", async () => {
    settings.oui_overrides = { CCDDEE: { manufacturer: "C", device: "Dev" }, "001122": "Zero" };
    expect(await oui.getOuiOverrides()).toEqual([
      { prefix: "00:11:22", manufacturer: "Zero" },
      { prefix: "CC:DD:EE", manufacturer: "C", device: "Dev" },
    ]);
  });

  it("deletes an override and persists the remainder", async () => {
    settings.oui_overrides = { AABBCC: "A", "112233": "B" };
    await oui.deleteOuiOverride("aa:bb:cc");
    expect(settings.oui_overrides).toEqual({ "112233": { manufacturer: "B" } });
    expect(await oui.lookupOuiOverride("AABBCC000000")).toBeNull();
  });

  // BUG: setOuiOverride throws AppError(400, "Invalid MAC prefix") only when
  // the normalizer returns null — but it pads the input with ":00:00:00" first
  // and never checks for hex, so the throw is unreachable: "GG:HH:II" is
  // stored as override "GGHHII". (The POST route validates first, so today
  // only a direct caller reaches this.) It should reject with httpStatus 400.
  it.fails("rejects a non-hex prefix with a 400", async () => {
    await expect(oui.setOuiOverride("GG:HH:II", "Bogus")).rejects.toMatchObject({ httpStatus: 400 });
  });
});

describe("refreshOuiDatabase / getOuiStatus", () => {
  const csv = [
    "Registry,Assignment,Organization Name,Organization Address",
    'MA-L,2C549A,"Example, Inc.","1 Road, Town"',
    'MA-L,aabbcc,"Quote ""Q"" Corp",Somewhere\r',
    "MA-L,ZZZZZZ,Bad Prefix,Nowhere",
    "MA-L,123456,,No vendor",
    "short,row",
    "",
  ].join("\n");

  it("downloads, parses (quoted commas, escaped quotes, CRLF), persists and serves the new map", async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, statusText: "OK", text: async () => csv });
    const out = await oui.refreshOuiDatabase();
    expect(out.entries).toBe(2);
    expect(typeof out.sizeKb).toBe("number");
    expect(fetchMock.mock.calls[0][0]).toBe("https://standards-oui.ieee.org/oui/oui.csv");
    const saved = settings.oui_database as { entries: number; data: Record<string, string>; refreshedAt: string };
    expect(saved.entries).toBe(2);
    expect(saved.data).toEqual({ "2C549A": "Example, Inc.", AABBCC: 'Quote "Q" Corp' });
    expect(Date.parse(saved.refreshedAt)).not.toBeNaN();
    // The in-memory map is the new one — no DB reload needed.
    settingFind.mockClear();
    expect(await oui.lookupOui("AA:BB:CC:00:00:00")).toBe('Quote "Q" Corp');
    expect(settingFind.mock.calls.some((c) => c[0].where.key === "oui_database")).toBe(false);
  });

  it("fails with a 502 AppError on a non-OK response and persists nothing", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 503, statusText: "Service Unavailable", text: async () => "" });
    await expect(oui.refreshOuiDatabase()).rejects.toMatchObject({ httpStatus: 502, message: "HTTP 503: Service Unavailable" });
    expect(settingUpsert).not.toHaveBeenCalled();
  });

  it("aborts the download after 30 seconds", async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementation((_url: string, init: { signal: AbortSignal }) =>
      new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(new Error("aborted")))));
    const p = oui.refreshOuiDatabase();
    const assertion = expect(p).rejects.toThrow("aborted");
    await vi.advanceTimersByTimeAsync(30_000);
    await assertion;
    expect(settingUpsert).not.toHaveBeenCalled();
  });

  it("reports status from the stored row without loading the map", async () => {
    expect(await oui.getOuiStatus()).toEqual({ loaded: false, entries: 0, refreshedAt: null });
    settings.oui_database = IEEE;
    expect(await oui.getOuiStatus()).toEqual({ loaded: true, entries: 2, refreshedAt: "2026-11-01T00:00:00.000Z" });
    settings.oui_database = { data: {} };
    expect(await oui.getOuiStatus()).toEqual({ loaded: true, entries: 0, refreshedAt: null });
  });
});
