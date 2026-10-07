/**
 * tests/unit/containerAssetTypeLockstep.test.ts
 *
 * The `container` built-in (Unraid containers / TrueNAS SCALE Apps) needs the
 * same lockstep every built-in does — see arcAssetTypeLockstep.test.ts for
 * why a half-landed type is a silent no-op — plus the browser's three lists,
 * the auto-monitor class mapping (and both raw-SQL sweeps' IN filters, which
 * once silently left kubernetes_cluster out), and the agent-install refusal.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { BUILT_IN_ASSET_TYPES } from "../../src/utils/assetTypes.js";

const root = resolve(__dirname, "../..");
const read = (p: string) => readFileSync(resolve(root, p), "utf8");

describe("container asset-type lockstep", () => {
  it("is in BUILT_IN_ASSET_TYPES and the seed list", () => {
    expect(BUILT_IN_ASSET_TYPES as readonly string[]).toContain("container");
    expect(read("src/services/assetTypeService.ts")).toContain('name: "container"');
  });

  it("has an adopting migration", () => {
    const sql = read("prisma/migrations/20261007000000_container_asset_type/migration.sql");
    expect(sql).toContain("'container'");
    expect(sql).toMatch(/ON CONFLICT \("name"\) DO UPDATE/);
  });

  it("is in the browser's built-in, label and colour lists", () => {
    const js = read("public/js/widgets/index.js");
    expect(js).toMatch(/"container",\s+\/\/ Unraid/);
    expect(js).toContain('container: "Container"');
    expect(js).toMatch(/container: "#[0-9a-f]{6}"/);
  });

  it("is covered by both raw-SQL sweeps' asset-type filters", () => {
    const svc = read("src/services/monitorOverrideService.ts");
    const filters = svc.match(/AND a\."assetType" IN \([^)]*\)/g) ?? [];
    expect(filters.length).toBe(2);
    for (const f of filters) {
      expect(f).toContain("'container'");
      expect(f).toContain("'kubernetes_cluster'");
    }
  });
});
