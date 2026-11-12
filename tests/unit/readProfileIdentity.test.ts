/**
 * tests/unit/readProfileIdentity.test.ts — the probe path's read of a
 * profile's `model` / `serial` rows (business rule 171,
 * `readProfileIdentity` in services/monitoring/snmpCollectors.ts).
 *
 * Pinned: ONE OID PER GET (on SNMPv1 a missing varbind fails the whole PDU,
 * and a profile row can name an object this model lacks), the `.0` instance
 * first and the bare oid only when that came back empty, no session at all
 * when the profile has nothing to read, and never a throw.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

const h = vi.hoisted(() => ({
  gets: [] as string[][],
  answers: new Map<string, string>(),
  sessions: 0,
  profile: null as null | Record<string, unknown>,
  failSession: false,
}));

vi.mock("../../src/services/monitoring/snmpCore.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/services/monitoring/snmpCore.js")>();
  return {
    ...actual,
    withSnmpSession: vi.fn(async (_host: string, _cfg: unknown, fn: (s: unknown) => Promise<unknown>) => {
      h.sessions++;
      if (h.failSession) throw new Error("timeout");
      return fn({});
    }),
    snmpMultiGet: vi.fn(async (_s: unknown, oids: string[]) => {
      h.gets.push(oids);
      const m = new Map<string, unknown>();
      for (const o of oids) if (h.answers.has(o)) m.set(o, h.answers.get(o));
      return m;
    }),
    snmpVbToString: (v: unknown) => (v == null ? "" : String(v)),
  };
});
vi.mock("../../src/services/oidRegistry.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/services/oidRegistry.js")>();
  return {
    ...actual,
    ensureRegistryLoaded: vi.fn(async () => {}),
    resolveOidSync: vi.fn((name: string) => ({ upsBasicIdentModel: "1.1.1", upsAdvIdentSerialNumber: "1.1.3" } as Record<string, string>)[name] ?? null),
  };
});
vi.mock("../../src/services/profileResolver.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/services/profileResolver.js")>();
  return { ...actual, pickDbProfile: vi.fn(() => h.profile) };
});

const { readProfileIdentity } = await import("../../src/services/monitoring/snmpCollectors.js");

const SUBJECT = { manufacturer: "APC", os: null, model: null, assetType: "power" };
const UPS_PROFILE = {
  vendor: "APC", profileManufacturer: "APC",
  model:  { symbol: "upsBasicIdentModel", parse: (raw: string) => raw.trim() || null, rowParse: { pattern: "^(.+)$", template: null } },
  serial: { symbol: "upsAdvIdentSerialNumber" },
};

beforeEach(() => {
  h.gets.length = 0;
  h.answers.clear();
  h.sessions = 0;
  h.profile = null;
  h.failSession = false;
});

describe("readProfileIdentity", () => {
  it("reads model and serial at their .0 instances, one OID per GET", async () => {
    h.profile = UPS_PROFILE;
    h.answers.set("1.1.1.0", "Smart-UPS 3000");
    h.answers.set("1.1.3.0", "AS1234567890");
    expect(await readProfileIdentity("10.0.0.5", {}, SUBJECT)).toEqual({ model: "Smart-UPS 3000", serial: "AS1234567890" });
    expect(h.gets).toEqual([["1.1.1.0"], ["1.1.3.0"]]);
  });

  it("falls back to the bare oid only when the instance came back empty", async () => {
    h.profile = UPS_PROFILE;
    h.answers.set("1.1.3", "AS1234567890");
    const r = await readProfileIdentity("10.0.0.5", {}, SUBJECT);
    expect(r).toEqual({ model: null, serial: "AS1234567890" });
    expect(h.gets).toEqual([["1.1.1.0"], ["1.1.1"], ["1.1.3.0"], ["1.1.3"]]);
  });

  it("opens no session when the profile names neither row", async () => {
    h.profile = { vendor: "APC", cpu: { symbol: "x", mode: "scalar" } };
    expect(await readProfileIdentity("10.0.0.5", {}, SUBJECT)).toEqual({ model: null, serial: null });
    expect(h.sessions).toBe(0);
  });

  it("never throws: a session failure reads as nothing", async () => {
    h.profile = UPS_PROFILE;
    h.failSession = true;
    expect(await readProfileIdentity("10.0.0.5", {}, SUBJECT)).toEqual({ model: null, serial: null });
  });
});
