/**
 * tests/unit/deviceTypesCardDom.test.ts — the Device Types card on
 * Server Settings → Identification (the `_dt*` / `deviceTypes*` half of
 * public/js/server-settings.js).
 *
 * Loaded by eval into a happy-dom Window with the app-shell globals stubbed —
 * the tagFilterDom idiom. It covers the client-side decisions no server test
 * can see, each of which fails silently rather than loudly if it drifts:
 *
 *   - A PROTECTED ROW'S SAVE CARRIES NO IDENTITY FIELDS. The form renders
 *     label / name / description disabled on a built-in, and the payload must
 *     omit them rather than echoing the unchanged values back — the server
 *     refuses an identity edit on a protected row, so echoing them turns
 *     "save my rule change" into a 403 the operator can do nothing about.
 *   - PREVIEW SENDS THE DRAFT, NOT THE STORED ROW. The whole point is seeing
 *     what the unsaved edit would do; posting the stored rules would report
 *     confidently on the wrong thing.
 *   - A BLANK CONDITION ROW IS NOT A CONDITION. "+ Condition" renders an empty
 *     row; an operator who adds one and thinks better of it must not save a
 *     condition with an empty value. `_dtPruneTree` drops it client-side,
 *     mirroring the server's own fold, so the previewed draft and the stored
 *     row cannot differ.
 *   - AN EMPTIED TREE POSTS NULL, NEVER THE EMPTY GROUP. `and([])` is true by
 *     identity, so shipping the collected tree would ask the server to claim
 *     every device for this type.
 *   - THE CONDITIONS ARE THE SHARED BUILDER. Since 2026-09 the editor renders
 *     PolarisConditionBuilder — the same nested AND/OR widget as the
 *     automations device filter — off the server-published vocabulary, so the
 *     test asserts the builder's own markup (.scg-group / .scr-row) rather
 *     than a private clause row, and that a nested group round-trips.
 *   - NO CONTEXTS TICKED IS REFUSED WHEN RULES EXIST. Rules that run nowhere
 *     are the one configuration that looks saved and does nothing.
 *   - DELETE IS WITHHELD ON PROTECTED ROWS, and the card says which types the
 *     rules cannot reach at all.
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

let created: Record<string, unknown>[] = [];
let updated: { id: string; body: Record<string, unknown> }[] = [];
let previewBodies: unknown[] = [];
let toasts: { msg: string; kind: string }[] = [];

// `contains` leads, so the shared builder defaults a new row to it — an
// `equals` default would silently match nothing against a vendor OS string.
const MATCH_OPS = [
  "contains", "notContains", "equals", "notEquals", "startsWith",
  "notStartsWith", "endsWith", "notEndsWith", "regex", "notRegex",
];

const MATCH_SCHEMA = {
  fields: ["any", "os", "osVersion", "hostname", "manufacturer", "model", "chassis"],
  ops: MATCH_OPS,
  contexts: ["directory", "scan"],
  // The builder catalog, as GET /asset-types/match-schema publishes it — the
  // same shape scopeConditionMeta hands the automations device filter.
  condition: {
    groupOps: ["and", "or", "none", "notAll"],
    groupOpLabels: {
      and: "All child conditions must be satisfied (AND)",
      or: "At least one child condition must be satisfied (OR)",
      none: "All child conditions must NOT be satisfied",
      notAll: "At least one child condition must NOT be satisfied",
    },
    operatorLabels: {
      equals: "is equal to", notEquals: "is not equal to",
      contains: "contains", notContains: "does not contain",
      startsWith: "starts with", notStartsWith: "does not start with",
      endsWith: "ends with", notEndsWith: "does not end with",
      regex: "matches regex", notRegex: "does not match regex",
    },
    fields: ["any", "os", "osVersion", "hostname", "manufacturer", "model", "chassis"]
      .map((f) => ({ field: f, label: f, ops: MATCH_OPS })),
    maxDepth: 5,
    maxRules: 64,
  },
  authoritativeSources: [
    {
      source: "FortiManager / FortiGate discovery",
      assigns: ["firewall", "switch", "access_point"],
      reason: "The controller's own CMDB states the device's role.",
    },
    { source: "Operator edit", assigns: [], reason: "A type set by hand is never overwritten." },
  ],
};

const TYPES = [
  {
    id: "t-server", name: "server", label: "Server", description: null,
    isBuiltIn: true, isProtected: true, usageCount: 42,
    matchPriority: 20, matchContexts: ["directory"],
    // Deliberately the PRE-2026-09 flat shape: the API folds it forward on
    // read, but a payload from a cached page or an older build still arrives
    // like this and must open in the builder with its rule intact rather than
    // reading as "Assigned only".
    matchRules: { clauses: [{ field: "os", op: "contains", value: "server" }] },
  },
  {
    id: "t-other", name: "other", label: "Other", description: null,
    isBuiltIn: true, isProtected: true, usageCount: 7,
    matchPriority: 100, matchContexts: [], matchRules: null,
  },
  {
    id: "t-pdu", name: "pdu", label: "Rack PDU", description: "Metered rack PDUs.",
    isBuiltIn: false, isProtected: false, usageCount: 0,
    matchPriority: 40, matchContexts: ["scan"],
    matchRules: { op: "or", children: [{ field: "any", operator: "contains", value: "eaton" }] },
  },
];

/** Render the card into the page and wire it, the way the tab renderer does. */
function mountCard(): void {
  doc.body.innerHTML = '<div id="host"></div>';
  const host = doc.getElementById("host")!;
  host.innerHTML = (g.deviceTypesCardHTML as () => string)();
  (g.wireDeviceTypeHandlers as () => void)();
}

/**
 * Open the editor. `openModal` is stubbed to actually mount body + footer, so
 * the wiring the real function performs afterwards can find its elements.
 */
function openEditor(id: string | null): void {
  (g.openDeviceTypeModal as (i: string | null) => void)(id);
  fixSelects(doc.body as unknown as { querySelectorAll: (s: string) => Iterable<unknown> });
}

type TreeLeaf = { field: string; operator: string; value: string };
type TreeBody = { op: string; children: (TreeLeaf | TreeBody)[] };

/** Every leaf in a posted tree, in walk order. */
function leavesOf(tree: TreeBody | null): TreeLeaf[] {
  const out: TreeLeaf[] = [];
  const walk = (g: TreeBody): void => {
    for (const c of g.children || []) {
      if (Array.isArray((c as TreeBody).children)) walk(c as TreeBody);
      else out.push(c as TreeLeaf);
    }
  };
  if (tree) walk(tree);
  return out;
}

const byId = <T,>(id: string): T => doc.getElementById(id) as unknown as T;
const click = (el: unknown) => (el as { dispatchEvent: (e: unknown) => void })
  .dispatchEvent(new win.Event("click", { bubbles: true }));

beforeAll(() => {
  win = new Window();
  doc = win.document;
  g.window = win;
  g.document = doc;
  g.requestAnimationFrame = (fn: () => void) => setTimeout(fn, 0);
  g.escapeHtml = (s: unknown) =>
    String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  g.showToast = (msg: string, kind: string) => { toasts.push({ msg, kind }); };
  g.showConfirm = async () => true;
  g.isAdmin = () => true;
  g.closeModal = () => {};
  g.formatBytes = (b: unknown) => String(b);
  g.PolarisPrefs = { get: () => null, set: () => {} };
  // The shared config-modal form parts live in app.js, which this harness does
  // not load; the editor's body assembly calls them.
  g.sectionHeading = (t: string) => "<p>" + t + "</p>";
  g.formDivider = () => "<hr>";
  g.infoBox = (html: string) => '<div class="info-box">' + html + "</div>";

  // A real-enough openModal: the editor wires its controls immediately after
  // calling it, so the body has to be in the document by the time it returns.
  g.openModal = (title: string, body: string, footer: string) => {
    doc.body.innerHTML =
      '<div id="modal-overlay"><div class="modal">' +
      '<div class="modal-header"><h3>' + title + "</h3></div>" +
      '<div class="modal-body">' + body + "</div>" +
      '<div class="modal-footer">' + footer + "</div>" +
      "</div></div>";
  };

  g.api = {
    serverSettings: {},
    assetTypes: {
      list: async () => ({ types: TYPES }),
      matchSchema: async () => MATCH_SCHEMA,
      create: async (body: Record<string, unknown>) => { created.push(body); return { id: "new" }; },
      update: async (id: string, body: Record<string, unknown>) => { updated.push({ id, body }); return { id }; },
      delete: async () => undefined,
      matchPreview: async (body: unknown) => {
        previewBodies.push(body);
        return { examined: 10, matched: 0, byType: [], sample: [], truncated: false };
      },
      matchApply: async () => ({ updated: 0, byType: [] }),
    },
  };
  // The tab reload the save path calls — inert here.
  g.loadIdentificationTab = async () => {};

  const cb = readFileSync(resolve(__dirname, "../../public/js/condition-builder.js"), "utf8");
  const ss = serverSettingsSource();
  (0, eval)(cb);
  (0, eval)(ss);
});

beforeEach(() => {
  created = [];
  updated = [];
  previewBodies = [];
  toasts = [];
  g._assetTypes = TYPES;
  g._assetTypeMatchSchema = MATCH_SCHEMA;
  doc.body.innerHTML = '<div id="host"></div>';
});

describe("the card", () => {
  it("marks built-ins and withholds delete on protected rows", () => {
    mountCard();
    expect(doc.body.innerHTML).toContain("built-in");
    // Only the one custom row may be deleted.
    const deletes = [...doc.querySelectorAll(".device-type-delete")]
      .map((b) => (b as unknown as Element).getAttribute("data-id"));
    expect(deletes).toEqual(["t-pdu"]);
    // ...but every row is editable, because matching is editable on built-ins.
    const edits = [...doc.querySelectorAll(".device-type-edit")]
      .map((b) => (b as unknown as Element).getAttribute("data-id"));
    expect(edits).toEqual(expect.arrayContaining(["t-server", "t-other", "t-pdu"]));
  });

  it("reads a type with no rules, or no contexts, as assigned-only", () => {
    const summary = (t: unknown) => (g._dtMatchSummary as (x: unknown) => string)(t);
    expect(summary(TYPES[1])).toContain("Assigned only");
    expect(summary({ matchRules: { op: "or", children: [{ field: "os", operator: "contains", value: "x" }] }, matchContexts: [] }))
      .toContain("Assigned only");
    expect(summary(TYPES[0])).toContain("Directory");
  });

  it("summarizes a tree, legacy shape included, and names the root operator only when it combines something", () => {
    const summary = (t: unknown) => (g._dtMatchSummary as (x: unknown) => string)(t);
    // The legacy flat row (TYPES[0]) must summarize as its rule, not as
    // "Assigned only" — reading .children off it would do exactly that.
    expect(summary(TYPES[0])).toContain("contains");
    // One condition: no operator prose, which on the very common one-leaf OR
    // would be actively misleading.
    expect(summary(TYPES[2])).not.toContain("any of");
    expect(summary({
      matchContexts: ["scan"],
      matchRules: {
        op: "and",
        children: [
          { field: "os", operator: "contains", value: "windows" },
          { op: "or", children: [{ field: "hostname", operator: "notStartsWith", value: "ws-" }] },
        ],
      },
    })).toMatch(/all of:.*\+1 more/);
  });

  it("renders the authoritative sources the rules cannot reach", () => {
    mountCard();
    const html = doc.body.innerHTML;
    expect(html).toContain("How a device gets its type");
    expect(html).toContain("FortiManager / FortiGate discovery");
    expect(html).toContain("Operator edit");
  });
});

describe("the editor", () => {
  it("locks identity on a built-in and sends no identity fields on save", async () => {
    openEditor("t-server");
    expect(byId<{ disabled: boolean }>("f-dt-label").disabled).toBe(true);
    expect(byId<{ disabled: boolean }>("f-dt-name").disabled).toBe(true);
    expect(byId<{ disabled: boolean }>("f-dt-description").disabled).toBe(true);

    click(byId("btn-dt-save"));
    await new Promise((r) => setTimeout(r, 0));

    expect(updated).toHaveLength(1);
    expect(updated[0]!.id).toBe("t-server");
    // The payload is matching ONLY — echoing the unchanged label back would be
    // read as an identity edit and refused.
    expect(Object.keys(updated[0]!.body).sort()).toEqual(["matchContexts", "matchPriority", "matchRules"]);
  });

  it("lets a custom type edit its identity alongside its rules", async () => {
    openEditor("t-pdu");
    expect(byId<{ disabled: boolean }>("f-dt-label").disabled).toBe(false);
    byId<{ value: string }>("f-dt-label").value = "Rack PDU (metered)";

    click(byId("btn-dt-save"));
    await new Promise((r) => setTimeout(r, 0));
    expect(updated[0]!.body.label).toBe("Rack PDU (metered)");
  });

  it("offers rename on an existing custom type, and sends it only when changed", async () => {
    // The service rewrites every Asset holding the old name in the same
    // transaction, so rename IS supported on a custom row — the field must not
    // be disabled, and an untouched name must not be sent as an edit.
    openEditor("t-pdu");
    expect(byId<{ disabled: boolean }>("f-dt-name").disabled).toBe(false);

    click(byId("btn-dt-save"));
    await new Promise((r) => setTimeout(r, 0));
    expect(updated[0]!.body).not.toHaveProperty("name");

    updated = [];
    openEditor("t-pdu");
    byId<{ value: string }>("f-dt-name").value = "rack_pdu";
    click(byId("btn-dt-save"));
    await new Promise((r) => setTimeout(r, 0));
    expect(updated[0]!.body.name).toBe("rack_pdu");
  });

  it("previews the DRAFT on screen, not the stored row", async () => {
    openEditor("t-pdu");
    // Change the condition, then preview without saving.
    (doc.querySelector(".scr-value") as unknown as { value: string }).value = "vertiv";
    byId<{ value: string }>("f-dt-priority").value = "7";

    click(byId("btn-dt-preview"));
    await new Promise((r) => setTimeout(r, 0));

    expect(previewBodies).toHaveLength(1);
    const draft = previewBodies[0] as { matchRules: TreeBody; matchPriority: number };
    expect(leavesOf(draft.matchRules)[0]!.value).toBe("vertiv");
    expect(draft.matchPriority).toBe(7);
  });

  it("edits the conditions in the shared builder, off the published vocabulary", async () => {
    openEditor("t-pdu");
    // The builder's own markup, not a private clause row: one root group, one
    // rule row, and both group- and rule-level controls present.
    expect(doc.querySelectorAll("#dt-cond-root > .scg-group")).toHaveLength(1);
    expect(doc.querySelectorAll(".scr-row")).toHaveLength(1);
    expect(doc.querySelector(".scg-add-rule")).toBeTruthy();
    expect(doc.querySelector(".scg-add-group")).toBeTruthy();
    // Field and operator dropdowns come from the server's catalog.
    const ops = [...doc.querySelectorAll(".scr-op option")]
      .map((o) => (o as unknown as Element).getAttribute("value"));
    expect(ops).toEqual(MATCH_OPS);
  });

  it("round-trips a nested group, so a tree an operator builds is what gets stored", async () => {
    openEditor("t-pdu");
    click(doc.querySelector(".scg-add-group"));
    fixSelects(doc.body as unknown as { querySelectorAll: (s: string) => Iterable<unknown> });
    // The new group renders with a starter row; give it a value so the prune
    // keeps it.
    const values = [...doc.querySelectorAll(".scr-value")] as unknown as { value: string }[];
    values[values.length - 1]!.value = "vertiv";

    click(byId("btn-dt-save"));
    await new Promise((r) => setTimeout(r, 0));

    const tree = updated[0]!.body.matchRules as TreeBody;
    expect(tree.op).toBe("or");
    expect(tree.children).toHaveLength(2);
    const nested = tree.children.find((c) => Array.isArray((c as TreeBody).children)) as TreeBody;
    expect(nested).toBeTruthy();
    expect(leavesOf(nested).map((l) => l.value)).toEqual(["vertiv"]);
  });

  it("drops a blank condition row instead of saving an empty value", async () => {
    openEditor("t-pdu");
    click(doc.querySelector(".scg-add-rule")); // renders an empty row
    expect(doc.querySelectorAll(".scr-row")).toHaveLength(2);

    click(byId("btn-dt-save"));
    await new Promise((r) => setTimeout(r, 0));
    // Pruned to the one real condition — the same fold the server applies, so
    // what was previewed is what gets stored.
    expect(leavesOf(updated[0]!.body.matchRules as TreeBody)).toHaveLength(1);
  });

  it("stores a leaf as field/op/value, with no negate flag", async () => {
    // Negation lives on the OPERATOR now (notContains, notStartsWith, …), not
    // on a per-row flag: a `none` group around a leaf would let an absent fact
    // satisfy the negation, which this layer refuses to do.
    openEditor("t-pdu");
    click(byId("btn-dt-save"));
    await new Promise((r) => setTimeout(r, 0));
    expect(leavesOf(updated[0]!.body.matchRules as TreeBody)[0])
      .toEqual({ field: "any", operator: "contains", value: "eaton" });
  });

  it("refuses rules that would run nowhere", async () => {
    openEditor("t-pdu");
    doc.querySelectorAll("#dt-context-list input[type=checkbox]").forEach((cb) => {
      (cb as unknown as { checked: boolean }).checked = false;
    });
    click(byId("btn-dt-save"));
    await new Promise((r) => setTimeout(r, 0));

    expect(updated).toHaveLength(0);
    expect(toasts.some((t) => /Applies to/.test(t.msg))).toBe(true);
  });

  it("clears the rules to null when the last condition is removed", async () => {
    openEditor("t-pdu");
    click(doc.querySelector(".scr-remove"));
    click(byId("btn-dt-save"));
    await new Promise((r) => setTimeout(r, 0));
    // Nothing left => null, the shape meaning "only ever assigned". NOT the
    // empty root group: and([]) is true by identity, so posting it would ask
    // the server to claim every device for this type.
    expect(updated[0]!.body.matchRules).toBeNull();
  });

  it("opens a legacy flat rule set in the builder with its condition intact", () => {
    // The fold-forward has to reach the EDITOR too. Rendering an empty builder
    // here, then saving, would silently delete a built-in's matching.
    openEditor("t-server");
    expect(doc.querySelectorAll(".scr-row")).toHaveLength(1);
    expect((doc.querySelector(".scr-value") as unknown as { value: string }).value).toBe("server");
  });

  it("derives the machine name from the label on a new type, until touched", async () => {
    openEditor(null);
    const label = byId<{ value: string; dispatchEvent: (e: unknown) => void }>("f-dt-label");
    label.value = "Badge Reader!";
    label.dispatchEvent(new win.Event("input", { bubbles: true }));
    expect(byId<{ value: string }>("f-dt-name").value).toBe("badge_reader");

    const name = byId<{ value: string; dispatchEvent: (e: unknown) => void }>("f-dt-name");
    name.value = "badge";
    name.dispatchEvent(new win.Event("input", { bubbles: true }));
    label.value = "Badge Reader v2";
    label.dispatchEvent(new win.Event("input", { bubbles: true }));
    expect(byId<{ value: string }>("f-dt-name").value).toBe("badge"); // left alone once typed in
  });
});
