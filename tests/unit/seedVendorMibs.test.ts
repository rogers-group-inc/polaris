/**
 * tests/unit/seedVendorMibs.test.ts — the manufacturer MIBs Polaris ships are
 * seeded as DELETABLE MIB Database entries, not baked into the product.
 *
 * Polaris ships two kinds of MIB and the difference is an operator-facing
 * promise, not an implementation detail:
 *
 *   - `services/stdMibs/` — generic IETF/IEEE modules, read off disk by
 *     `oidRegistry.loadStandardLayer`, present in every install, removable by
 *     nobody. They change when the product is updated.
 *   - `services/vendorMibs/` — a manufacturer's own public MIB, seeded into
 *     `MibFile` so it appears in the MIB Database like any upload and the
 *     operator can delete it.
 *
 * The failure this file exists to prevent is a vendor module landing in
 * `stdMibs/` instead: `loadStandardLayer` globs that directory, so it would
 * silently become undeletable, and the only sign would be an operator unable
 * to remove a vendor file they never asked for.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const h = vi.hoisted(() => ({
  created: [] as Array<Record<string, any>>,
  throwOn: null as string | null,
  /** Markers already stamped in this database — an existing install has the profile one. */
  markers: new Set<string>(),
  stamped: [] as string[],
}));

vi.mock("../../src/services/mibService.js", () => ({
  createMib: vi.fn(async (input: any) => {
    if (h.throwOn && input.filename === h.throwOn) {
      const err: any = new Error("duplicate"); err.httpStatus = 409; throw err;
    }
    h.created.push(input);
    return { id: `mib-${h.created.length}` };
  }),
}));

vi.mock("../../src/jobs/_runOnce.js", () => ({
  hasRunMarker: vi.fn(async (key: string) => h.markers.has(key)),
  stampRunMarker: vi.fn(async (key: string) => { h.stamped.push(key); h.markers.add(key); }),
}));

const { seedVendorMibs, VENDOR_MIBS, unclaimedVendorMibFiles } =
  await import("../../src/jobs/seedVendorMibs.js");

const SRC = join(__dirname, "..", "..", "src", "services");
const VENDOR_DIR = join(SRC, "vendorMibs");
const STD_DIR = join(SRC, "stdMibs");

beforeEach(() => {
  h.created = [];
  h.throwOn = null;
  h.markers = new Set();
  h.stamped = [];
});

describe("fresh installs only", () => {
  it("seeds when no previous release has run against this database", async () => {
    const res = await seedVendorMibs();
    expect(res.skipped).toBe(false);
    expect(res.seeded).toBe(VENDOR_MIBS.length);
  });

  it("leaves an UPGRADE's MIB Database alone", async () => {
    // `seedManufacturerProfilesSeededAt` can only exist if an earlier release
    // already ran here, so its presence means upgrade, not fresh install. An
    // existing install's MIB Database is curated by its operator; adding a
    // vendor's modules for devices they may not own is editing their data.
    // Measured on the owner's production fleet: 2,416 monitored assets, ZERO
    // of them Cisco.
    h.markers.add("seedManufacturerProfilesSeededAt");
    const res = await seedVendorMibs();
    expect(res.skipped).toBe(true);
    expect(res.seeded).toBe(0);
    expect(h.created).toEqual([]);
  });

  it("stamps its own marker when it skips, so it does not re-decide every boot", async () => {
    h.markers.add("seedManufacturerProfilesSeededAt");
    await seedVendorMibs();
    expect(h.stamped).toContain("seedVendorMibsSeededAt");
  });

  it("runs before the profile seed, which is what makes the fresh-install check work", async () => {
    // If the order in app.ts flipped, the profile seed would stamp its marker
    // first and this job would read it as "existing install" on a FRESH one —
    // seeding nothing, forever, with no error.
    const appTs = readFileSync(join(__dirname, "..", "..", "src", "app.ts"), "utf8");
    expect(appTs.indexOf("seedVendorMibs.js"))
      .toBeLessThan(appTs.indexOf("seedManufacturerProfiles.js"));
  });
});

describe("the two directories stay separate", () => {
  it("no vendor module is also in stdMibs/, where nobody could delete it", () => {
    // `oidRegistry.loadStandardLayer` globs stdMibs/*.txt. A vendor file there
    // becomes part of the baked-in layer — the exact opposite of the intent.
    const stdFiles = new Set(readdirSync(STD_DIR).filter((f) => f.endsWith(".txt")));
    for (const def of VENDOR_MIBS) {
      expect(stdFiles.has(def.filename), `${def.filename} is bundled AND seeded`).toBe(false);
    }
  });

  it("stdMibs/ holds only generic modules — no enterprise-arc anchors", () => {
    // A vendor module is recognisable by anchoring under `enterprises`. The
    // generic set anchors on mib-2 / the IEEE 802.1 chain and nothing else.
    for (const f of readdirSync(STD_DIR).filter((x) => x.endsWith(".txt"))) {
      const text = readFileSync(join(STD_DIR, f), "utf8");
      expect(/::=\s*\{\s*enterprises\s+\d+\s*\}/.test(text), `${f} anchors under enterprises`).toBe(false);
    }
  });

  it("every shipped vendor file is claimed by a VENDOR_MIBS entry", () => {
    // An unclaimed file ships in the image and is never seeded — dead weight
    // that looks like a working MIB to anyone reading the directory.
    expect(unclaimedVendorMibFiles()).toEqual([]);
  });

  it("every VENDOR_MIBS entry has its file on disk", () => {
    for (const def of VENDOR_MIBS) {
      expect(existsSync(join(VENDOR_DIR, def.filename)), `missing ${def.filename}`).toBe(true);
    }
  });
});

describe("seeding", () => {
  it("creates every shipped module at its manufacturer's scope, as system:seed", () => {
    // Manufacturer scope is what makes the MIB resolve for that vendor's
    // assets, and what the profile's readiness check looks for.
    return seedVendorMibs().then((res) => {
      expect(res.skipped).toBe(false);
      expect(res.seeded).toBe(VENDOR_MIBS.length);
      for (const def of VENDOR_MIBS) {
        const row = h.created.find((c) => c.filename === def.filename);
        expect(row, `${def.filename} not seeded`).toBeTruthy();
        expect(row!.manufacturer).toBe(def.manufacturer);
        expect(row!.uploadedBy).toBe("system:seed");
        expect(row!.contents.length).toBeGreaterThan(1000);
        expect(row!.notes).toBeTruthy();
      }
    });
  });

  it("goes through createMib, so a seeded MIB is parsed and registered like an upload", async () => {
    // Deliberately not a direct prisma.create: one code path for both means a
    // seeded MIB cannot drift from an uploaded one in parsing, dup-checking or
    // registry refresh.
    const { createMib } = await import("../../src/services/mibService.js");
    await seedVendorMibs();
    expect(vi.mocked(createMib)).toHaveBeenCalledTimes(VENDOR_MIBS.length);
  });

  it("treats a module the operator already has as a reason to skip, not an error", async () => {
    // 409 from createMib = same module already at that scope. Their copy wins.
    h.throwOn = VENDOR_MIBS[0]!.filename;
    const res = await seedVendorMibs();
    expect(res.seeded).toBe(VENDOR_MIBS.length - 1);
  });

  it("scopes Cisco's SMI root to Cisco, so the leaf modules can anchor on it", async () => {
    // CISCO-PROCESS-MIB and CISCO-MEMORY-POOL-MIB resolve nothing without the
    // `cisco` / `ciscoMgmt` anchors CISCO-SMI defines.
    await seedVendorMibs();
    const smi = h.created.find((c) => c.filename === "CISCO-SMI.txt");
    expect(smi?.manufacturer).toBe("Cisco");
  });
});

describe("what the shipped modules actually contain", () => {
  it("each file is the module its name claims", () => {
    for (const def of VENDOR_MIBS) {
      const text = readFileSync(join(VENDOR_DIR, def.filename), "utf8");
      const declared = /^\s*([A-Za-z0-9-]+)\s+DEFINITIONS\s*::=\s*BEGIN/m.exec(text)?.[1];
      expect(declared, `${def.filename} declares "${declared}"`).toBe(def.filename.replace(/\.txt$/, ""));
    }
  });

  it("carries the symbols the seeded profiles name", () => {
    // If a profile names a symbol its own shipped MIB does not define, the
    // pair ships broken — which is exactly how the MikroTik CPU row got in.
    const cisco = readFileSync(join(VENDOR_DIR, "CISCO-PROCESS-MIB.txt"), "utf8")
      + readFileSync(join(VENDOR_DIR, "CISCO-MEMORY-POOL-MIB.txt"), "utf8");
    expect(cisco).toContain("cpmCPUTotal5secRev");
    expect(cisco).toContain("ciscoMemoryPoolUsed");
    expect(cisco).toContain("ciscoMemoryPoolFree");
  });

  it("ships a module only for a manufacturer whose profile is seeded", async () => {
    // The two lists are a pair: a MIB with no profile is a file the operator
    // never asked for, and a profile with no MIB reads UNRESOLVED. MIKROTIK-MIB
    // was removed on 2026-09-16 when its profile was, for exactly this reason.
    const { PROFILE_SEEDED_MANUFACTURERS } =
      await import("../../src/jobs/seedManufacturerProfiles.js");
    for (const def of VENDOR_MIBS) {
      expect(
        PROFILE_SEEDED_MANUFACTURERS.has(def.manufacturer),
        `${def.filename} ships for ${def.manufacturer}, which seeds no profile`,
      ).toBe(true);
    }
  });
});
