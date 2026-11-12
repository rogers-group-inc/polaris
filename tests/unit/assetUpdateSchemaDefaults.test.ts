/**
 * tests/unit/assetUpdateSchemaDefaults.test.ts — an asset update carries only
 * what the caller sent.
 *
 * UpdateAssetSchema is CreateAssetSchema.partial(). Zod 4 applies a .default()
 * even inside .partial()/.optional(), so create's `assetType: "other"` and
 * `status: "active"` defaults leaked into every PUT and silently reset both
 * fields (found 2026-11-12 on the 3 → 4 move, by the integration suite only).
 */

import { describe, it, expect, vi } from "vitest";

vi.mock("../../src/db.js", () => ({ prisma: {} }));

import { CreateAssetSchema, UpdateAssetSchema } from "../../src/services/assetWriteService.js";

describe("UpdateAssetSchema", () => {
  it("does not inherit create's defaults", () => {
    const parsed = UpdateAssetSchema.parse({ notes: "x" });
    expect(parsed).not.toHaveProperty("assetType");
    expect(parsed).not.toHaveProperty("status");
  });

  it("still passes both through when sent", () => {
    expect(UpdateAssetSchema.parse({ assetType: "switch", status: "maintenance" }))
      .toMatchObject({ assetType: "switch", status: "maintenance" });
  });

  it("create keeps its defaults", () => {
    expect(CreateAssetSchema.parse({ hostname: "h" })).toMatchObject({ assetType: "other", status: "active" });
  });
});
