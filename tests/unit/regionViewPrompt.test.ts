/**
 * tests/unit/regionViewPrompt.test.ts — which regions the description-save
 * prompt asks about (public/js/region-view-prompt.js, business rule 150):
 * only NEW room / rack / junction-box chains that no Rack / Wall view stands
 * for and the operator did not skip; never area, building or floor.
 */
// @vitest-environment happy-dom
import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseLocationCodes } from "../../src/utils/locationCodes.js";

type Codes = Record<string, string | null>;
type P = {
  _parseCodes: (s: string) => Codes;
  _askableChains: (c: Codes) => Array<{ level: string; codes: Codes }>;
  _newRegions: (before: string | Codes, after: string | Codes, views: Array<{ region: Codes | null }>, skipped: Record<string, boolean>) => Array<{ level: string; codes: Codes }>;
  _chainKey: (c: Codes) => string;
};
let P: P;

beforeAll(() => {
  new Function(readFileSync(resolve(__dirname, "../../public/js/region-view-prompt.js"), "utf8"))();
  P = (window as unknown as { PolarisRegionViewPrompt: P }).PolarisRegionViewPrompt;
});

describe("region-view prompt", () => {
  it("parses exactly like the server", () => {
    for (const s of ["b:Plant r:MDF ra:R2 jb:7", "Core switch a:Mine f:2 r:North Closet", "cobra:x r:IDF", "", "RA:r3 JB:9"]) {
      expect(P._parseCodes(s)).toEqual(parseLocationCodes(s));
    }
  });

  it("asks about the room chain only (rule 156: racks and junction boxes live in their room's view)", () => {
    const chains = P._askableChains(P._parseCodes("a:Mine b:Plant f:2 r:MDF ra:R2 jb:7"));
    expect(chains.map((c) => c.level)).toEqual(["room"]);
    expect(chains[0].codes).toMatchObject({ area: "Mine", building: "Plant", floor: "2", room: "MDF", rack: null });
    expect(P._askableChains(P._parseCodes("a:Mine b:Plant f:2"))).toEqual([]);
  });

  it("skips regions the old description had, ones a view stands for, and ones the operator skipped", () => {
    const after = "b:Plant r:MDF ra:R2 jb:7";
    // The room was already named: a new rack or box in it asks nothing.
    expect(P._newRegions("b:Plant r:MDF", after, [], {})).toEqual([]);
    expect(P._newRegions("", after, [], {}).map((r) => r.level)).toEqual(["room"]);
    const view = { region: { area: null, building: "Plant", floor: null, room: "mdf", rack: null, junctionBox: null } };
    expect(P._newRegions("", after, [view], {})).toEqual([]);
    const skipKey = P._chainKey({ building: "Plant", room: "MDF" });
    expect(P._newRegions("", after, [], { [skipKey]: true })).toEqual([]);
  });

  it("compares chains resolved through the region tree, so a short code is the region it names", () => {
    // `r:MDF` saved, resolved by the server to its full chain; the old description named it in full.
    const full = { area: null, building: "Plant", floor: "1", room: "MDF", rack: null, junctionBox: null };
    expect(P._newRegions("b:Plant f:1 r:MDF", full, [], {})).toEqual([]);
    // A view standing for that room (stored short, returned resolved) covers it too.
    expect(P._newRegions("", full, [{ region: full }], {})).toEqual([]);
  });
});
