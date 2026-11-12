/**
 * tests/unit/retiredStreamMib.test.ts — the retired per-stream MIB pins
 * (business rule 170) are accepted by every write schema and never stored.
 */

import { describe, it, expect } from "vitest";
import { z } from "zod";
import { retiredStreamMibField, RETIRED_STREAM_MIB_FIELDS } from "../../src/utils/retiredStreamMib.js";
import { UpdateAssetSchema } from "../../src/services/assetWriteService.js";

describe("retiredStreamMibField", () => {
  const S = z.object({ keep: z.string().optional(), cpuMemoryMibId: retiredStreamMibField() });

  it.each([["an uploaded MIB id", "6f4c…"], ["a std key", "std:system"], ["null", null], ["a number", 7]])(
    "accepts %s and parses it to undefined", (_l, v) => {
      const out = S.parse({ keep: "x", cpuMemoryMibId: v });
      expect(out.cpuMemoryMibId).toBeUndefined();
      expect(JSON.parse(JSON.stringify(out))).toEqual({ keep: "x" });
    },
  );

  it("is fine absent", () => {
    expect(S.parse({}).cpuMemoryMibId).toBeUndefined();
  });

  it("names all six stream columns", () => {
    expect([...RETIRED_STREAM_MIB_FIELDS]).toEqual([
      "responseTimeMibId", "cpuMemoryMibId", "temperatureMibId", "interfacesMibId", "lldpMibId", "processesMibId",
    ]);
  });
});

describe("the asset write schema", () => {
  it("drops every stream MIB pin a client sends", () => {
    const body = Object.fromEntries(RETIRED_STREAM_MIB_FIELDS.slice(0, 5).map((f) => [f, "std:system"]));
    const out = UpdateAssetSchema.parse({ ...body, notes: "n" }) as Record<string, unknown>;
    for (const f of RETIRED_STREAM_MIB_FIELDS) expect(out[f], f).toBeUndefined();
    expect(out.notes).toBe("n");
  });
});
