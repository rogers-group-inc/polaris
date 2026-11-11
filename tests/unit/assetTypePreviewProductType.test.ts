/**
 * tests/unit/assetTypePreviewProductType.test.ts
 *
 * The registry's retroactive preview / apply (`assetTypeService.previewMatchRules`)
 * must test a rule against the same facts the monitor path's typing does —
 * including `productType`, the device's own word for what it is ("Rack PDU"
 * from an APC card, business rule 161; "Bullet Camera" from AXIS). Before
 * 2026-11-11 the stored asset's facts left it out, so a rule on it previewed
 * and applied as no-match while the monitor path matched it.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../src/db.js", () => import("./_dbStub.js"));
import { prisma } from "../../src/db.js";
import { resetDbStub } from "./_dbStub.js";
import { previewMatchRules } from "../../src/services/assetTypeService.js";

beforeEach(() => resetDbStub());

describe("previewMatchRules — productType is a fact", () => {
  it("claims an 'other' asset by the productType its device reported", async () => {
    vi.mocked(prisma.assetTypeDef.findMany).mockResolvedValue([
      {
        name: "Power",
        matchRules: { op: "or", children: [{ field: "productType", operator: "contains", value: "PDU" }] },
        matchContexts: ["directory", "scan"],
        matchPriority: 100,
      },
    ] as never);
    vi.mocked(prisma.asset.findMany).mockResolvedValue([
      { id: "pdu", hostname: "apc8F29C4", os: null, osVersion: "1.5.1.1", manufacturer: "APC", model: "AP8870", productType: "Rack PDU" },
      { id: "cam", hostname: "cam1", os: null, osVersion: null, manufacturer: "Axis", model: "M2036-LE", productType: "Bullet Camera" },
    ] as never);

    const res = await previewMatchRules();
    expect(res.matched).toBe(1);
    expect(res.sample.map((r) => r.id)).toEqual(["pdu"]);
    expect(res.byType).toEqual([{ type: "Power", count: 1 }]);
    // And the read asks for the column.
    const args = vi.mocked(prisma.asset.findMany).mock.calls[0][0] as { select: Record<string, boolean> };
    expect(args.select.productType).toBe(true);
  });
});
