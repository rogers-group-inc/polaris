import { describe, it, expect } from "vitest";
import { sfpSensorName, type SfpOpticRole } from "../../src/utils/sfpOptics.js";
import { assetsSource } from "./_assetsSource.js";

// The browser addresses a transceiver reading's history by the stored sensor
// name the collector wrote (business rule 143). public/js/assets.js carries its
// own copy of the role labels; a drift between the two opens an EMPTY chart
// rather than failing anywhere, so it is pinned here.
describe("SFP role labels: public/js/assets.js ↔ src/utils/sfpOptics.ts", () => {
  const src = assetsSource().replace(/\r\n/g, "\n");
  const block = /var SFP_ROLE_LABELS = \{\n([\s\S]*?)\n\};/.exec(src);

  it("the browser's label table exists", () => {
    expect(block).not.toBeNull();
  });

  it("names every reading exactly as the collector stores it", () => {
    const labels: Record<string, string> = {};
    for (const m of block![1].matchAll(/^\s*(\w+):\s*"([^"]+)",?$/gm)) labels[m[1]] = m[2];
    const roles: SfpOpticRole[] = ["temperature", "voltage", "txPower", "rxPower", "bias"];
    expect(Object.keys(labels).sort()).toEqual([...roles].sort());
    for (const role of roles) {
      expect(`port10 ${labels[role]}`).toBe(sfpSensorName("port10", role));
    }
  });
});
