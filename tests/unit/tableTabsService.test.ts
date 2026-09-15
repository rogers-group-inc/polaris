/**
 * tests/unit/tableTabsService.test.ts
 *
 * `sanitizeTabs` — the validator behind per-user list-page tabs. Per-tab state
 * validation is delegated to savedFilterService.sanitizeFilterState (covered in
 * its own suite); what's tested here is the envelope: caps, uniqueness, name
 * hygiene, the preset back-reference, the base-filter triple, the per-tab
 * favorites list, the per-tab column order, and the activeId repair rule.
 */

import { describe, it, expect } from "vitest";
import {
  sanitizeTabs,
  MAX_TABS,
  MAX_TAB_NAME_LEN,
  MAX_TAB_FAVORITES,
  MAX_TAB_COLUMNS,
} from "../../src/services/tableTabsService.js";

const STATE = { sfFilters: { assetType: ["firewall"] }, sortKey: "hostname", sortDir: "asc" };

function tab(over: Record<string, unknown> = {}) {
  return { id: "t1", name: "Firewalls", state: STATE, ...over };
}

describe("sanitizeTabs", () => {
  it("round-trips a tab with its state and preset back-reference", () => {
    const out = sanitizeTabs({
      tabs: [tab({ savedFilterId: "f1", savedFilterName: "Edge firewalls" })],
      activeId: "t1",
    });
    expect(out).toEqual({
      version: 1,
      activeId: "t1",
      tabs: [{
        id: "t1",
        name: "Firewalls",
        state: STATE,
        savedFilterId: "f1",
        savedFilterName: "Edge firewalls",
        defaultFilterId: null,
        defaultFilterName: null,
        defaultState: null,
        favoriteIds: null,
        columnOrder: null,
      }],
    });
  });

  it("defaults a missing state to the empty filter set and nulls the back-reference", () => {
    const out = sanitizeTabs({ tabs: [{ id: "t1", name: "Blank" }], activeId: "t1" });
    expect(out.tabs[0]!.state).toEqual({ sfFilters: {}, sortKey: null, sortDir: null });
    expect(out.tabs[0]!.savedFilterId).toBeNull();
    expect(out.tabs[0]!.savedFilterName).toBeNull();
  });

  it("round-trips a tab's base filter", () => {
    const out = sanitizeTabs({
      tabs: [tab({ defaultFilterId: "f1", defaultFilterName: "Edge firewalls", defaultState: STATE })],
      activeId: "t1",
    });
    expect(out.tabs[0]!.defaultFilterId).toBe("f1");
    expect(out.tabs[0]!.defaultFilterName).toBe("Edge firewalls");
    expect(out.tabs[0]!.defaultState).toEqual(STATE);
  });

  it("drops a base filter's id + name when there is no state to reset to", () => {
    // The snapshot is the only thing Reset can apply, so a leftover label would
    // advertise a Reset button that could do nothing.
    const out = sanitizeTabs({ tabs: [tab({ defaultFilterId: "f1", defaultFilterName: "Gone" })] });
    expect(out.tabs[0]!.defaultState).toBeNull();
    expect(out.tabs[0]!.defaultFilterId).toBeNull();
    expect(out.tabs[0]!.defaultFilterName).toBeNull();
  });

  it("holds a base filter's state to the same shape rules as the tab's own", () => {
    expect(() => sanitizeTabs({ tabs: [tab({ defaultState: { sfFilters: { hostname: { op: "rm -rf" } } } })] }))
      .toThrowError(/not a recognized filter shape/);
  });

  it("keeps a base filter whose preset id is gone — the snapshot still resets", () => {
    // defaultFilterId is a label, never resolved server-side (same rule as
    // savedFilterId): a deleted preset must not cost a tab its way back.
    const out = sanitizeTabs({ tabs: [tab({ defaultFilterId: "deleted", defaultState: STATE })] });
    expect(out.tabs[0]!.defaultState).toEqual(STATE);
    expect(out.tabs[0]!.defaultFilterId).toBe("deleted");
  });

  it("round-trips a tab's own favorites, deduped and in order", () => {
    const out = sanitizeTabs({ tabs: [tab({ favoriteIds: ["a2", "a1", "a2"] })] });
    expect(out.tabs[0]!.favoriteIds).toEqual(["a2", "a1"]);
  });

  it("keeps an ABSENT favorites list null and an empty one empty", () => {
    // The two differ: null lets the client seed the tab from the legacy
    // per-user localStorage set, [] says the operator has none here.
    expect(sanitizeTabs({ tabs: [tab()] }).tabs[0]!.favoriteIds).toBeNull();
    expect(sanitizeTabs({ tabs: [tab({ favoriteIds: null })] }).tabs[0]!.favoriteIds).toBeNull();
    expect(sanitizeTabs({ tabs: [tab({ favoriteIds: [] })] }).tabs[0]!.favoriteIds).toEqual([]);
  });

  it("rejects a favorites list that is over the cap or not a list of ids", () => {
    const many = Array.from({ length: MAX_TAB_FAVORITES + 1 }, (_, i) => `a${i}`);
    expect(() => sanitizeTabs({ tabs: [tab({ favoriteIds: many })] })).toThrowError(/favorite cap/);
    expect(() => sanitizeTabs({ tabs: [tab({ favoriteIds: "a1" })] })).toThrowError(/must be an array/);
    expect(() => sanitizeTabs({ tabs: [tab({ favoriteIds: [1] })] })).toThrowError(/must be a string/);
    expect(() => sanitizeTabs({ tabs: [tab({ favoriteIds: [""] })] })).toThrowError(/is required/);
  });

  it("round-trips a tab's own column order, deduped and in order", () => {
    const out = sanitizeTabs({ tabs: [tab({ columnOrder: ["ip", "hostname", "ip"] })] });
    expect(out.tabs[0]!.columnOrder).toEqual(["ip", "hostname"]);
  });

  it("keeps an ABSENT column order null and an empty one empty", () => {
    // Same distinction favoriteIds draws: null lets the client seed the tab
    // from this browser's stored table layout, [] is a deliberate empty set.
    expect(sanitizeTabs({ tabs: [tab()] }).tabs[0]!.columnOrder).toBeNull();
    expect(sanitizeTabs({ tabs: [tab({ columnOrder: null })] }).tabs[0]!.columnOrder).toBeNull();
    expect(sanitizeTabs({ tabs: [tab({ columnOrder: [] })] }).tabs[0]!.columnOrder).toEqual([]);
  });

  it("keeps a column id the table no longer has — the client splices orders itself", () => {
    // setupColumnLayout.normalizeOrder drops strangers and re-inserts newcomers
    // at apply time, so storing a stale id costs nothing, while rejecting one
    // would break a tab every time a column is renamed or retired.
    const out = sanitizeTabs({ tabs: [tab({ columnOrder: ["retiredColumn", "hostname"] })] });
    expect(out.tabs[0]!.columnOrder).toEqual(["retiredColumn", "hostname"]);
  });

  it("rejects a column order that is over the cap or not a list of ids", () => {
    const many = Array.from({ length: MAX_TAB_COLUMNS + 1 }, (_, i) => `c${i}`);
    expect(() => sanitizeTabs({ tabs: [tab({ columnOrder: many })] })).toThrowError(/column cap/);
    expect(() => sanitizeTabs({ tabs: [tab({ columnOrder: "ip" })] })).toThrowError(/must be an array/);
    expect(() => sanitizeTabs({ tabs: [tab({ columnOrder: [1] })] })).toThrowError(/must be a string/);
    expect(() => sanitizeTabs({ tabs: [tab({ columnOrder: [""] })] })).toThrowError(/is required/);
  });

  it("trims names and rejects blank / control-character ones", () => {
    expect(sanitizeTabs({ tabs: [tab({ name: "  Edge  " })] }).tabs[0]!.name).toBe("Edge");
    expect(() => sanitizeTabs({ tabs: [tab({ name: "   " })] })).toThrowError(/name is required/);
    expect(() => sanitizeTabs({ tabs: [tab({ name: "a" + String.fromCharCode(7) + "b" })] }))
      .toThrowError(/control characters/);
    expect(() => sanitizeTabs({ tabs: [tab({ name: "x".repeat(MAX_TAB_NAME_LEN + 1) })] }))
      .toThrowError(/exceeds/);
  });

  it("repairs a stale activeId instead of losing the layout", () => {
    // A client that closed a tab in another window shouldn't 400 the whole PUT.
    const out = sanitizeTabs({ tabs: [tab(), tab({ id: "t2", name: "Switches" })], activeId: "gone" });
    expect(out.activeId).toBe("t1");
  });

  it("normalizes an empty tab set to an empty activeId", () => {
    expect(sanitizeTabs({ tabs: [], activeId: "t1" })).toEqual({ version: 1, tabs: [], activeId: "" });
  });

  it("rejects duplicate ids, over-long sets, and non-object payloads", () => {
    expect(() => sanitizeTabs({ tabs: [tab(), tab()] })).toThrowError(/unique/);
    const many = Array.from({ length: MAX_TABS + 1 }, (_, i) => tab({ id: `t${i}` }));
    expect(() => sanitizeTabs({ tabs: many })).toThrowError(/too many tabs/);
    expect(() => sanitizeTabs({ tabs: "nope" })).toThrowError(/must be an array/);
    expect(() => sanitizeTabs([])).toThrowError(/must be an object/);
    expect(() => sanitizeTabs({ tabs: [null] })).toThrowError(/must be an object/);
  });

  it("rejects a tab state the table could not have produced", () => {
    // Delegated to sanitizeFilterState — the tab envelope must not be a way
    // around it.
    expect(() => sanitizeTabs({ tabs: [tab({ state: { sfFilters: { hostname: { op: "rm -rf" } } } })] }))
      .toThrowError(/not a recognized filter shape/);
  });
});
