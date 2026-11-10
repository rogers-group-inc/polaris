/**
 * tests/unit/addAssetMenu.test.ts — the "+ Add Asset(s)" menu's item builder
 * (`_addAssetMenuItems` in public/js/assets.js).
 *
 * The button used to be one action gated by one attribute. It now fronts two
 * things governed by DIFFERENT function keys — a hand-typed asset form
 * (`assets`) and a network Discovery (`networkScan`) — and an active sweep of
 * operator-supplied ranges is exactly the capability an admin may want to
 * withhold from someone who may still edit inventory. So the interesting
 * property is that each row is gated by the key its OWN routes check, and that
 * neither key implies the other in either direction.
 *
 * Also pinned:
 *  - a row the role can never reach is OMITTED, not rendered disabled. The
 *    row-context-menu template's disabled-with-a-reason rule is for a verb that
 *    can't apply *right now*; a missing grant is not transient, and a
 *    permanently greyed row only advertises something the operator cannot be
 *    given.
 *  - with no grants at all the builder returns NOTHING, which is what lets the
 *    click handler refuse to pop an empty menu. `hideAdminOnlyElements` only
 *    ever hides, so a cached-then-refreshed role can leave the button visible
 *    when the fresh matrix says otherwise — the empty list is the backstop.
 *  - the Discovery rows require the module to be loaded. assets.js reads
 *    `window.PolarisAssetDiscovery` lazily, and a page that omits the script
 *    tag must degrade to the plain asset form rather than offering a row whose
 *    onSelect would throw.
 *
 * assets.js is an ~18k-line browser script with no module boundary, so the
 * builder is sliced out by name and eval'd — the approach of
 * tests/unit/assetRowMenu.test.ts.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { assetsSource } from "./_assetsSource.js";

vi.mock("../../src/db.js", () => ({ prisma: {} }));

interface MenuItem {
  label?: string;
  separator?: boolean;
  disabled?: boolean;
  title?: string;
  onSelect?: () => void;
}

const g = globalThis as Record<string, any>;
const assetsLines = assetsSource().split(/\r?\n/);

/** Slice a top-level `function NAME(...) {` … `}` block out of assets.js. */
function fnSrc(name: string): string {
  const start = assetsLines.findIndex((l) => l.startsWith(`function ${name}(`));
  if (start < 0) throw new Error(`assets.js: function ${name} not found`);
  const end = assetsLines.findIndex((l, i) => i > start && l === "}");
  if (end < 0) throw new Error(`assets.js: no end of function ${name}`);
  return assetsLines.slice(start, end + 1).join("\n");
}

let addAssetMenuItems: () => MenuItem[];

const labels = (items: MenuItem[]) => items.filter((i) => !i.separator).map((i) => i.label);

/**
 * Re-eval the builder against a permission matrix.
 * `scan` is the level held on `networkScan` — the real thing under test, since
 * read and write buy different rows.
 */
function withPerms(opts: { assets?: boolean; scan?: "none" | "read" | "write"; moduleLoaded?: boolean }) {
  const scan = opts.scan ?? "none";
  const RANK: Record<string, number> = { none: 0, read: 1, write: 2, fullwrite: 3 };
  g.canManageAssets = () => opts.assets === true;
  g.permAtLeast = (key: string, level: string) =>
    key === "networkScan" ? RANK[scan] >= RANK[level] : false;
  g.window = g;
  g.PolarisAssetDiscovery = opts.moduleLoaded === false ? undefined : { open() {}, openList() {} };
  (0, eval)(fnSrc("_addAssetMenuItems"));
  addAssetMenuItems = g._addAssetMenuItems;
}

beforeEach(() => {
  g.openCreateModal = () => {};
  withPerms({ assets: true, scan: "write" });
  expect(typeof addAssetMenuItems, "assets.js no longer declares _addAssetMenuItems").toBe("function");
});

describe("_addAssetMenuItems — the two keys are independent", () => {
  it("offers everything to a caller holding both", () => {
    withPerms({ assets: true, scan: "write" });
    expect(labels(addAssetMenuItems())).toEqual([
      "Single asset",
      "New discovery",
      "Saved discoveries",
    ]);
  });

  it("offers only the asset form when networkScan is withheld", () => {
    withPerms({ assets: true, scan: "none" });
    expect(labels(addAssetMenuItems())).toEqual(["Single asset"]);
  });

  it("offers only Discovery when assets:write is withheld", () => {
    // Not a hypothetical: adoption is chained on assets:write, so a role may
    // legitimately be allowed to scan and not to create.
    withPerms({ assets: false, scan: "write" });
    expect(labels(addAssetMenuItems())).toEqual(["New discovery", "Saved discoveries"]);
  });

  it("gives a read-level scanner the list but not the builder", () => {
    withPerms({ assets: false, scan: "read" });
    expect(labels(addAssetMenuItems())).toEqual(["Saved discoveries"]);
  });

  it("returns nothing at all with no grants, so the menu is never popped empty", () => {
    withPerms({ assets: false, scan: "none" });
    expect(addAssetMenuItems()).toEqual([]);
  });
});

describe("_addAssetMenuItems — shape", () => {
  it("never renders an unreachable row as disabled", () => {
    withPerms({ assets: true, scan: "none" });
    const items = addAssetMenuItems();
    expect(items.some((i) => i.disabled)).toBe(false);
    expect(items.map((i) => i.label)).not.toContain("New discovery");
  });

  it("degrades to the asset form when the discovery module is not loaded", () => {
    withPerms({ assets: true, scan: "write", moduleLoaded: false });
    expect(labels(addAssetMenuItems())).toEqual(["Single asset"]);
  });

  it("gives every row an onSelect and a title", () => {
    withPerms({ assets: true, scan: "write" });
    for (const item of addAssetMenuItems()) {
      expect(typeof item.onSelect, `${item.label} has no onSelect`).toBe("function");
      expect(item.title, `${item.label} has no title`).toBeTruthy();
    }
  });
});
