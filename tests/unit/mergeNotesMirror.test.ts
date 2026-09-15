/**
 * tests/unit/mergeNotesMirror.test.ts
 *
 * The merge modal previews the combined notes before the operator confirms, and
 * the service writes them. There is no build step, so the logic exists twice:
 * `combineAssetNotes` in src/services/assetMergeService.ts and
 * `_mergeCombineNotes` in public/js/asset-merge-modal.js.
 *
 * A preview that disagrees with what gets written is worse than no preview —
 * the operator confirms one thing and the survivor ends up holding another, on
 * an irreversible action. So this test evaluates the browser file in a Node vm
 * (the pattern from appmapFilter.test.ts / topologyColumns.test.ts) and asserts
 * the two implementations return IDENTICAL output across the shape decisions:
 * labeled combine, the three "write nothing" refusals, the unlabeled
 * pass-through, and the identical-hostname disambiguation.
 *
 * If this fails, one side was changed without the other. Fix the mirror, don't
 * relax the assertion.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import vm from "node:vm";

import { combineAssetNotes } from "../../src/services/assetMergeService.js";

type Side = { notes?: string | null; hostname?: string | null; id?: string | null };
type Combine = (a: Side, b: Side) => string | undefined;

let jsCombine: Combine;

beforeAll(() => {
  const here = dirname(fileURLToPath(import.meta.url));
  const file = resolve(here, "../../public/js/asset-merge-modal.js");
  const src = readFileSync(file, "utf8");

  // The file is a plain browser script full of DOM-dependent functions; only
  // the pure helper is wanted, so it is evaluated with enough of a global to
  // let the top-level `var`/`function` declarations land, and nothing is
  // called except the helper itself.
  const sandbox: Record<string, unknown> = {
    window: {},
    document: { getElementById: () => null, querySelector: () => null },
    console,
  };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: "asset-merge-modal.js" });

  const fn = sandbox._mergeCombineNotes;
  if (typeof fn !== "function") {
    throw new Error("_mergeCombineNotes not found in public/js/asset-merge-modal.js");
  }
  jsCombine = fn as Combine;
});

const CASES: Array<{ name: string; a: Side; b: Side }> = [
  {
    name: "labeled combine, survivor first",
    a: { notes: "Replaced NIC 2026-04-11.", hostname: "wks042", id: "aaaaaaaa-1111" },
    b: { notes: "Intune-enrolled, owner J. Diaz.", hostname: "WKS042.corp.local", id: "bbbbbbbb-2222" },
  },
  {
    name: "neither side has notes",
    a: { notes: null, hostname: "a", id: "1" },
    b: { notes: "   ", hostname: "b", id: "2" },
  },
  {
    name: "only the survivor has notes",
    a: { notes: "kept", hostname: "a", id: "1" },
    b: { notes: "", hostname: "b", id: "2" },
  },
  {
    name: "only the absorbed row has notes — unlabeled pass-through",
    a: { notes: "  ", hostname: "a", id: "1" },
    b: { notes: "carried over", hostname: "b", id: "2" },
  },
  {
    name: "identical text on both sides",
    a: { notes: "same", hostname: "a", id: "1" },
    b: { notes: "same", hostname: "b", id: "2" },
  },
  {
    name: "survivor already contains the absorbed text",
    a: { notes: "[a]\nsame\n\n[b]\ncarried", hostname: "a", id: "1" },
    b: { notes: "carried", hostname: "b", id: "2" },
  },
  {
    name: "identical hostnames disambiguate with a short id",
    a: { notes: "first", hostname: "dup-host", id: "aaaaaaaa-1111" },
    b: { notes: "second", hostname: "dup-host", id: "bbbbbbbb-2222" },
  },
  {
    name: "a side with no hostname",
    a: { notes: "x", hostname: null, id: "a" },
    b: { notes: "y", hostname: "named", id: "b" },
  },
  {
    name: "whitespace is trimmed on both sides before combining",
    a: { notes: "  padded  ", hostname: "a", id: "1" },
    b: { notes: "\n other \n", hostname: "b", id: "2" },
  },
];

describe("combineAssetNotes — service and merge-modal preview agree", () => {
  for (const c of CASES) {
    it(c.name, () => {
      expect(jsCombine(c.a, c.b)).toEqual(combineAssetNotes(c.a, c.b));
    });
  }
});
