/**
 * tests/unit/assetRemovalCoverage.test.ts — business rule 157: every code path
 * that removes an asset ROW calls assetRemovalService afterwards.
 *
 * The service is called explicitly (not from a Prisma hook — see its header
 * and narrative-157), so a new delete path that forgets it would bring back
 * exactly the leftovers the rule removed, silently. This scans `src/` and
 * fails on a file that deletes an asset without importing the service.
 */

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const SRC = join(__dirname, "..", "..", "src");

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) { if (name !== "generated") sourceFiles(p, out); }
    else if (p.endsWith(".ts")) out.push(p);
  }
  return out;
}

// `prisma.asset.delete(`, `tx.asset.deleteMany(` — any client, either verb.
const DELETES_AN_ASSET = /\b\w+\.asset\.(delete|deleteMany)\(/;
const CALLS_THE_SERVICE = /\b(afterAssetsDeleted|afterAssetMerged)\(/;

describe("every asset delete is followed by the reference clean-up", () => {
  const deleters = sourceFiles(SRC).filter((f) => DELETES_AN_ASSET.test(readFileSync(f, "utf8")));

  it("finds the delete paths it expects (so the scan itself is not silently empty)", () => {
    const names = deleters.map((f) => relative(SRC, f).replace(/\\/g, "/")).sort();
    expect(names).toEqual([
      "services/assetGhostMergeService.ts",
      "services/assetMergeService.ts",
      "services/assetWriteService.ts",
      "services/conflictResolutionService.ts",
    ]);
  });

  it("each of them calls assetRemovalService", () => {
    const missing = deleters
      .filter((f) => !CALLS_THE_SERVICE.test(readFileSync(f, "utf8")))
      .map((f) => relative(SRC, f).replace(/\\/g, "/"));
    expect(missing, `these delete an asset row without calling afterAssetsDeleted / afterAssetMerged: ${missing.join(", ")}`).toEqual([]);
  });

  it("calls it once per delete statement, so a second delete in the same file is not missed", () => {
    for (const f of deleters) {
      const text = readFileSync(f, "utf8");
      const deletes = (text.match(new RegExp(DELETES_AN_ASSET.source, "g")) ?? []).length;
      const calls = (text.match(/\bawait (afterAssetsDeleted|afterAssetMerged)\(/g) ?? []).length;
      expect(calls, `${relative(SRC, f)}: ${deletes} asset delete(s) but ${calls} clean-up call(s)`).toBeGreaterThanOrEqual(deletes);
    }
  });
});
