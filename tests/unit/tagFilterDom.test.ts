/**
 * tests/unit/tagFilterDom.test.ts — the tag registry's auto-assign device filter
 * (the `_tagFilter*` half of public/js/server-settings.js).
 *
 * Both tag modals now render the SHARED condition builder instead of the flat
 * one-rule-per-row builder they shipped with. The module is a plain browser
 * script, so this loads it by eval into a happy-dom Window with the app-shell
 * globals stubbed — the addressBookDom idiom. It covers the three client-side
 * decisions no server test can see, each of which fails silently if it drifts:
 *
 *   - THE EMPTY TREE IS NULLED ON THE WIRE. `and([])` is true for every asset,
 *     and unlike a contact a tag has no All-devices control — so the toggle
 *     being off (or on with nothing built) must post `assetCondition: null`,
 *     never the empty tree, or a half-built form tags the whole fleet.
 *   - AN UNRENDERABLE LEGACY FILTER IS OMITTED, NOT NULLED. A tag whose flat
 *     `criteria` couldn't be folded shows the toggle ON with an empty builder
 *     and a warning; saving must send NO filter key so the server leaves both
 *     columns alone. Posting null there — the obvious reading of "empty
 *     builder" — deletes a live filter the operator was only warned about.
 *   - A MAP REGIONS TAG GETS NO BUILDER AT ALL. Those names are managed by the
 *     region reconcile through RegionTagAssignment; a second managed-sync
 *     engine on the same string would undo the first every cycle. No toggle
 *     rendered ⇒ the collect returns {} ⇒ the save can't touch the filter.
 *
 * The tree round-trip itself belongs to conditionBuilderDom.test.ts; this asserts
 * the wrapper's contract with the server.
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Window } from "happy-dom";
import { fixSelects } from "../fixtures/happyDomSelects.js";
import { serverSettingsSource } from "./_serverSettingsSource.js";

vi.mock("../../src/db.js", () => ({ prisma: {} }));

const g = globalThis as Record<string, unknown>;
let doc: Window["document"];
let win: InstanceType<typeof Window>;
let previewBodies: Record<string, unknown>[] = [];

/** The vocabulary GET /server-settings/tags/filter-schema serves, trimmed. */
const SCHEMA = {
  scopeCondition: {
    groupOps: ["and", "or", "none", "notAll"],
    groupOpLabels: { and: "All", or: "Any", none: "None", notAll: "Not all" },
    operatorLabels: { equals: "is", contains: "contains", matches: "matches" },
    fields: [
      { field: "manufacturer", label: "Manufacturer", ops: ["equals", "contains"], optionsFrom: "manufacturers" },
      { field: "location", label: "Location", ops: ["equals", "contains", "matches"], optionsFrom: null },
    ],
    maxDepth: 5,
  },
  options: { manufacturers: ["Cisco", "Fortinet"] },
  regionCategory: "Map Regions",
};

type TagFilterBody = { assetCondition?: unknown };

/** Render the section into the page the way both modals do, then wire it. */
function mountSection(tag: unknown): { builder: Record<string, unknown> } {
  const CB = (win as unknown as { PolarisConditionBuilder: { create: (o: unknown) => Record<string, unknown> } })
    .PolarisConditionBuilder;
  const builder = CB.create({
    meta: SCHEMA.scopeCondition,
    valueOptions: (g._tagValueOptions as (s: unknown) => unknown)(SCHEMA),
    onChange: () => {},
  });
  const host = doc.getElementById("host")!;
  host.innerHTML = (g._tagFilterSectionHTML as (t: unknown, b: unknown, s: unknown) => string)(tag, builder, SCHEMA);
  fixSelects(host as unknown as { querySelectorAll: (s: string) => Iterable<unknown> });
  (g._wireTagFilterBuilder as (id: unknown, b: unknown) => void)(
    (tag as { id?: string } | null)?.id ?? null,
    builder,
  );
  return { builder };
}

const collect = (builder: unknown, stuck?: string[]): TagFilterBody =>
  (g._collectTagFilter as (b: unknown, s?: string[]) => TagFilterBody)(builder, stuck);

const validate = (builder: unknown, stuck?: string[]): string | null =>
  (g._validateTagFilter as (b: unknown, s?: string[]) => string | null)(builder, stuck);

beforeAll(() => {
  win = new Window();
  doc = win.document;
  g.window = win;
  g.document = doc;
  g.requestAnimationFrame = (fn: () => void) => setTimeout(fn, 0);
  g.escapeHtml = (s: unknown) =>
    String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  g.showToast = () => {};
  g.showConfirm = async () => true;
  g.isAdmin = () => true;
  g.openModal = () => {};
  g.closeModal = () => {};
  // Two app-shell globals server-settings.js reads at EVAL time (a top-level
  // `var formatBytesShort = formatBytes`), so they must exist before the eval,
  // not just before a call.
  g.formatBytes = (b: unknown) => String(b);
  g.PolarisPrefs = { get: () => null, set: () => {} };
  g.api = {
    serverSettings: {
      tagFilterSchema: async () => SCHEMA,
      previewTagCriteria: async (body: Record<string, unknown>) => {
        previewBodies.push(body);
        return { matchCount: 3, diff: { add: 3, remove: 0 } };
      },
    },
    assetTypes: { list: async () => [] },
  };

  // The builder module first — server-settings.js reads it during body assembly,
  // which is the load-order invariant the page's <script> tags encode.
  const cb = readFileSync(resolve(__dirname, "../../public/js/condition-builder.js"), "utf8");
  const ss = serverSettingsSource();
  // Indirect eval so both land on globalThis; DOMContentLoaded is never fired,
  // so the page's own boot handler stays inert and only the functions are taken.
  (0, eval)(cb);
  (0, eval)(ss);
});

beforeEach(() => {
  previewBodies = [];
  doc.body.innerHTML = '<div id="host"></div>';
});

describe("tag auto-assign filter — the empty tree", () => {
  it("posts an explicit null when the toggle is off, never the empty tree", () => {
    const { builder } = mountSection(null);
    const toggle = doc.getElementById("f-tag-auto-toggle") as unknown as { checked: boolean };
    expect(toggle.checked).toBe(false); // a NEW tag starts manual
    expect(collect(builder)).toEqual({ assetCondition: null });
  });

  it("posts null when the toggle is ON but nothing has been built", () => {
    const { builder } = mountSection(null);
    const toggle = doc.getElementById("f-tag-auto-toggle") as unknown as {
      checked: boolean;
      dispatchEvent: (e: unknown) => void;
    };
    toggle.checked = true;
    toggle.dispatchEvent(new win.Event("change", { bubbles: true }));
    // The reveal seeds a starter row, so clear it to reach the empty state.
    doc.querySelectorAll("#f-tag-cond-root .scr-row").forEach((r) => r.remove());
    expect(collect(builder)).toEqual({ assetCondition: null });
  });

  it("refuses to save an empty tree with the toggle on", () => {
    const { builder } = mountSection(null);
    const toggle = doc.getElementById("f-tag-auto-toggle") as unknown as {
      checked: boolean;
      dispatchEvent: (e: unknown) => void;
    };
    toggle.checked = true;
    toggle.dispatchEvent(new win.Event("change", { bubbles: true }));
    doc.querySelectorAll("#f-tag-cond-root .scr-row").forEach((r) => r.remove());
    expect(validate(builder)).toMatch(/Add a condition/);
  });
});

describe("tag auto-assign filter — a stored tree", () => {
  const TAG = {
    id: "t1",
    category: "General",
    assetCondition: {
      op: "and",
      children: [{ field: "manufacturer", operator: "equals", value: "Cisco" }],
    },
  };

  it("opens with the toggle on and round-trips the stored tree", () => {
    const { builder } = mountSection(TAG);
    const toggle = doc.getElementById("f-tag-auto-toggle") as unknown as { checked: boolean };
    expect(toggle.checked).toBe(true);
    expect(collect(builder)).toEqual({ assetCondition: TAG.assetCondition });
    expect(validate(builder)).toBeNull();
  });

  it("opens a LEGACY tag from the server's fold-forward", () => {
    // assetCondition is null on an un-migrated row; assetConditionEffective is
    // what the editor must render, or the next save clears a live filter.
    const { builder } = mountSection({
      id: "t2",
      category: "General",
      assetCondition: null,
      assetConditionEffective: {
        op: "and",
        children: [{ field: "location", operator: "contains", value: "Ashfield" }],
      },
    });
    expect(collect(builder)).toEqual({
      assetCondition: { op: "and", children: [{ field: "location", operator: "contains", value: "Ashfield" }] },
    });
  });

  it("previews the tree it collected", async () => {
    mountSection(TAG);
    await new Promise((r) => setTimeout(r, 420));
    expect(previewBodies).toHaveLength(1);
    expect(previewBodies[0]).toEqual({ assetCondition: TAG.assetCondition, tagId: "t1" });
  });
});

describe("tag auto-assign filter — a filter the builder can't render", () => {
  const STUCK = ["integration"];
  const TAG = {
    id: "t3",
    category: "General",
    assetCondition: null,
    assetConditionEffective: null,
    assetFilterUnconvertible: STUCK,
  };

  it("shows the toggle ON with a warning rather than advertising 'unfiltered'", () => {
    mountSection(TAG);
    const toggle = doc.getElementById("f-tag-auto-toggle") as unknown as { checked: boolean };
    expect(toggle.checked).toBe(true);
    expect(doc.getElementById("f-tag-filter-body")!.innerHTML).toContain("integration");
  });

  it("omits BOTH shape keys so the server leaves the filter alone", () => {
    const { builder } = mountSection(TAG);
    // Nothing built: this must NOT be {assetCondition: null}, which would clear
    // a filter the operator was only warned about.
    expect(collect(builder, STUCK)).toEqual({});
    expect(validate(builder, STUCK)).toBeNull();
  });

  it("still lets the operator REPLACE it by building a tree", () => {
    const { builder } = mountSection(TAG);
    (builder.seedIfEmpty as (el: unknown) => void)(doc.getElementById("f-tag-cond-root"));
    const row = doc.querySelector("#f-tag-cond-root .scr-row")!;
    (row.querySelector(".scr-value") as unknown as { value: string }).value = "Fortinet";
    const body = collect(builder, STUCK);
    expect(body.assetCondition).toBeTruthy();
  });

  it("clears the legacy filter when the toggle is switched OFF", () => {
    const { builder } = mountSection(TAG);
    const toggle = doc.getElementById("f-tag-auto-toggle") as unknown as {
      checked: boolean;
      dispatchEvent: (e: unknown) => void;
    };
    toggle.checked = false;
    toggle.dispatchEvent(new win.Event("change", { bubbles: true }));
    expect(collect(builder, STUCK)).toEqual({ assetCondition: null });
  });
});

describe("tag auto-assign filter — the Map Regions category", () => {
  it("renders an explanation instead of a builder", () => {
    mountSection({ id: "t4", category: "Map Regions" });
    expect(doc.getElementById("f-tag-auto-toggle")).toBeFalsy();
    expect(doc.getElementById("f-tag-cond-root")).toBeFalsy();
    expect(doc.getElementById("host")!.textContent).toContain("Device Map");
  });

  it("collects nothing, so a save can never touch the filter", () => {
    const { builder } = mountSection({ id: "t4", category: "Map Regions" });
    expect(collect(builder)).toEqual({});
    expect(validate(builder)).toBeNull();
  });
});

describe("tag auto-assign filter — listener binding", () => {
  it("does not accumulate delegated listeners across repeated opens", () => {
    // openModal reuses ONE persistent #modal-overlay, so the builder must bind
    // to a container that dies with the form. Binding to the overlay left the
    // listeners attached after close and added a fresh set each open — by the
    // third Add Tag, one "+ Condition" click appended three rows.
    const TAG = {
      id: "t5",
      category: "General",
      assetCondition: { op: "and", children: [{ field: "manufacturer", operator: "equals", value: "Cisco" }] },
    };
    // Stand in for the persistent overlay: the same element across all opens.
    doc.body.innerHTML = '<div id="modal-overlay"><div id="host"></div></div>';
    for (let i = 0; i < 3; i++) {
      doc.getElementById("host")!.innerHTML = "";
      mountSection(TAG);
    }
    const root = doc.getElementById("f-tag-cond-root")!;
    const before = root.querySelectorAll(".scr-row").length;
    const addBtn = root.querySelector(".scg-add-rule") as unknown as { dispatchEvent: (e: unknown) => void };
    addBtn.dispatchEvent(new win.Event("click", { bubbles: true }));
    expect(root.querySelectorAll(".scr-row").length).toBe(before + 1);
  });
});

describe("tag auto-assign filter — load order", () => {
  it("every page hosting a condition-builder consumer loads the module", () => {
    // A missing or late <script> doesn't error visibly — the modal just fails to
    // open. See polaris-ui-canon → Nested condition tree.
    for (const page of ["server-settings", "assets", "automations"]) {
      const html = readFileSync(resolve(__dirname, `../../public/${page}.html`), "utf8");
      expect(html, `${page}.html must load condition-builder.js`).toContain("/js/condition-builder.js");
    }
    // appmap / index / map get the wizard from the prefetched asset bundle
    // (CQ-F041), which must carry the module ahead of it.
    const panels = readFileSync(resolve(__dirname, "../../public/js/app-panels.js"), "utf8");
    const at = panels.indexOf("asset: [");
    const asset = panels.slice(at, panels.indexOf("]", at));
    expect(asset.indexOf("/js/condition-builder.js")).toBeGreaterThan(-1);
    expect(asset.indexOf("/js/condition-builder.js")).toBeLessThan(asset.indexOf("/js/automations-wizard.js"));
    for (const page of ["appmap", "index", "map"]) {
      const html = readFileSync(resolve(__dirname, `../../public/${page}.html`), "utf8");
      expect(html, `${page}.html must prefetch the asset bundle`).toContain('data-prefetch-panels="asset"');
    }
  });

  it("loads condition-builder.js BEFORE server-settings.js", () => {
    const html = readFileSync(resolve(__dirname, "../../public/server-settings.html"), "utf8");
    expect(html.indexOf("/js/condition-builder.js")).toBeLessThan(html.indexOf("/js/server-settings.js"));
  });
});
