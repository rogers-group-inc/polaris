/**
 * tests/unit/addressBookDom.test.ts — DOM smoke for the address book
 * (public/js/automations-address-book.js).
 *
 * The module is a plain browser script, so this loads it via eval into a
 * happy-dom Window with the app-shell globals stubbed — the same idiom as
 * assetsFiltersDom.test.ts. It covers the wiring no server test can see:
 *
 *   - the tab table, and the Edit/Delete affordances appearing ONLY on rows the
 *     ownership dimension lets this caller touch (the client mirror of
 *     assertOwnership — if this drifts, operators get buttons that 403);
 *   - the STACKED-OVERLAY contract, which is the whole reason this module
 *     doesn't call openModal: the picker/editor must build their own overlay at
 *     a z-index above the base modal, or opening one from the automation wizard
 *     destroys the wizard's form DOM;
 *   - the picker returning the field it was opened from alongside the chosen
 *     entries, so the caller knows whether they land in To, Cc or Bcc.
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Window } from "happy-dom";
import { installAppOverlay } from "../fixtures/appOverlay.js";

vi.mock("../../src/db.js", () => ({ prisma: {} }));

const g = globalThis as Record<string, unknown>;
let doc: Window["document"];
let win: InstanceType<typeof Window>;

let contacts: Record<string, unknown>[];
let searchEntries: Record<string, unknown>[];
let deleted: string[];
let created: Record<string, unknown>[];
let updated: Record<string, unknown>[];
let toasts: string[];
let adopted: string[] = [];
/** Every `origin` the tab asked the server for, in order. */
let listOrigins: string[] = [];
let directoryVisible = false;
/**
 * What the list endpoint reports as feeding this address book — one entry per
 * BACKEND, each labelled for its own tab. `directorySyncAvailable` is derived
 * from it exactly as the route derives it, so the two can't disagree here in a
 * way they couldn't in production.
 */
let directorySources: { kind: string; label: string; sync: boolean; search: boolean }[] = [];
/** How many searches the tab issued, and whether each asked for the live GAL. */
let searchCalls: { q: string; directory: boolean }[] = [];
let previewed: Record<string, unknown>[];
let confirmAnswer = true;
let level = "fullwrite";
/** Region nesting depth the stubbed filter-schema reports. 1 = flat. */
let schemaMaxLevel = 1;

const PAGE_HTML = '<div id="contacts-list"></div>';

/** Let the module's awaited fetch + render settle. */
function flush(times = 3) {
  let p = Promise.resolve();
  for (let i = 0; i < times; i++) p = p.then(() => new Promise((r) => setTimeout(r, 0)));
  return p;
}

/**
 * Wait out the tab search box's 250ms debounce, then let the fetch settle.
 * A microtask flush can't: the timer is real, and a debounce still pending when
 * the test ends repaints the NEXT test's freshly-rebuilt pane from the old
 * module instance's search term.
 */
async function settleDebounce() {
  await new Promise((r) => setTimeout(r, 320));
  await flush();
}

function click(el: unknown) {
  (el as { dispatchEvent: (e: unknown) => void }).dispatchEvent(new win.Event("click", { bubbles: true }));
}

/** The topmost standalone overlay this module appended (never #modal-overlay). */
function overlays() {
  return Array.from(doc.body.querySelectorAll(".modal-overlay"));
}

beforeAll(() => {
  win = new Window();
  doc = win.document;
  g.window = win;
  g.document = doc;
  g.requestAnimationFrame = (fn: () => void) => setTimeout(fn, 0);

  g.escapeHtml = (s: unknown) =>
    String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  g.showToast = (msg: string) => { toasts.push(msg); };
  g.showConfirm = async () => confirmAnswer;
  // Mirrors the server ladder: read < write < fullwrite.
  g.permAtLeast = (_key: string, want: string) => {
    const rank: Record<string, number> = { none: 0, read: 1, write: 2, fullwrite: 3 };
    return rank[level] >= rank[want];
  };
  g._trapFocus = () => () => {};
  g._focusFirstIn = () => {};
  // buildOverlay lives in app.js now (it is shared with the automations code
  // editor, which opens on pages that never load the address book). Load the
  // REAL one rather than stubbing it: these tests assert on overlay structure
  // and the z-index rungs, which a stub would trivially satisfy.
  installAppOverlay();
  g.currentUsername = "alice";
  (win as unknown as Record<string, unknown>).currentUsername = "alice";

  g.api = {
    contacts: {
      // Contact filtering + paging is the SERVER's job (GET /contacts?q=), so
      // the stub has to do it: the tab no longer filters what it is handed.
      // `total` is the unpaged match count, which is what the truncation hint
      // reads — returning contacts.length would make the hint untestable.
      list: async (params?: { q?: string; limit?: number }) => {
        const term = String(params?.q ?? "").toLowerCase();
        const matched = term
          ? contacts.filter((c) =>
              String(c.email ?? "").toLowerCase().includes(term) ||
              String(c.name ?? "").toLowerCase().includes(term))
          : contacts;
        const origin = params?.origin ?? "all";
        // The server's own origin vocabulary: "all", "manual", "directory" —
        // and one BACKEND ("entra" / "ad"), which is what a directory tab asks
        // for. Mirrored here so a tab that asks for the wrong slice fails.
        const scoped = origin === "manual"
          ? matched.filter((c) => (c.origin ?? "manual") === "manual")
          : origin === "directory"
            ? matched.filter((c) => (c.origin ?? "manual") !== "manual")
            : origin === "all"
              ? matched
              : matched.filter((c) => c.origin === origin);
        listOrigins.push(origin);
        const limit = params?.limit ?? 50;
        return {
          contacts: scoped.slice(0, limit), total: scoped.length, limit, offset: 0,
          directoryVisible,
          directorySyncAvailable: directorySources.some((s) => s.sync),
          directorySources: directoryVisible ? directorySources : [],
        };
      },
      get: async (id: string) => ({ contact: contacts.find((c) => c.id === id) ?? null }),
      adopt: async (id: string) => { adopted.push(id); return { contact: contacts.find((c) => c.id === id) }; },
      // Filters on the query the way searchAddressBook does (email or name
      // contains), so a test can tell the users/directory half of the tab's
      // results from the contacts half.
      search: async (q: string, directory?: boolean) => ({
        entries: (searchCalls.push({ q: String(q ?? ""), directory: !!directory }), searchEntries).filter((e) => {
          const term = String(q ?? "").toLowerCase();
          if (!term) return true;
          return String(e.email ?? "").toLowerCase().includes(term) ||
            String(e.name ?? "").toLowerCase().includes(term);
        }),
      }),
      preview: async (body: Record<string, unknown>) => { previewed.push(body); return { matchCount: 0, sample: [] }; },
      // The device-filter builder's vocabulary. Deliberately includes one field
      // automations doesn't have (location) so a drift there shows up here.
      filterSchema: async () => ({
        scopeCondition: {
          groupOps: ["and", "or", "none", "notAll"],
          groupOpLabels: { and: "AND", or: "OR", none: "NONE", notAll: "NOT ALL" },
          operatorLabels: { equals: "is equal to", contains: "contains", matches: "matches (wildcard *)" },
          fields: [
            { field: "hostname", label: "Hostname", ops: ["equals", "contains", "matches"], optionsFrom: null },
            { field: "location", label: "Location", ops: ["equals", "contains", "matches"], optionsFrom: null },
          ],
          maxDepth: 5,
          maxRules: 100,
        },
        options: {
          regions: ["Ashfield", "Memphis"],
          // Nested: Memphis contains Ashfield, so the Tags pane has one row
          // at each level and the Level column has something to tell apart.
          regionLevels: { maxLevel: schemaMaxLevel, byName: { ashfield: 1, memphis: 2 } },
          // The tag registry, Map Regions rows already dropped server-side —
          // those are the region catalogue above under their `region:` names.
          tagCatalog: [
            { name: "Facilities", category: "Teams" },
            { name: "Datacenter", category: "Sites" },
          ],
        },
      }),
      create: async (body: Record<string, unknown>) => { created.push(body); return { contact: { id: "new", ...body } }; },
      update: async (_id: string, body: Record<string, unknown>) => { updated.push(body); return { contact: { id: _id, ...body } }; },
      delete: async (id: string) => { deleted.push(id); },
    },
    assetTypes: { list: async () => ({ assetTypes: [] }) },
    assets: { list: async () => ({ assets: [] }) },
  };

  doc.body.innerHTML = PAGE_HTML;
  // The shared condition builder must be on window before the editor assembles
  // its body — a missing tag doesn't error, the dialog just fails to open.
  (0, eval)(readFileSync(resolve(__dirname, "../../public/js/condition-builder.js"), "utf8"));
  const src = readFileSync(resolve(__dirname, "../../public/js/automations-address-book.js"), "utf8");
  (0, eval)(src);
});

/**
 * Re-evaluate the module, dropping its memoized filter-schema.
 *
 * `_filterSchema` is a module-level cache and the module is eval'd once in
 * beforeAll, so a test that needs a DIFFERENT stubbed schema (a nested region
 * catalogue rather than a flat one) has no other way to get one.
 */
function reloadAddressBook(): void {
  (0, eval)(readFileSync(resolve(__dirname, "../../public/js/automations-address-book.js"), "utf8"));
}

beforeEach(() => {
  deleted = [];
  created = [];
  updated = [];
  adopted = [];
  listOrigins = [];
  searchCalls = [];
  directoryVisible = false;
  directorySources = [];
  toasts = [];
  previewed = [];
  confirmAnswer = true;
  level = "fullwrite";
  schemaMaxLevel = 1;
  // Fresh module per test, so one test's stubbed schema can't leak into the
  // next through the module-level _filterSchema memo.
  reloadAddressBook();
  contacts = [
    { id: "c1", email: "mine@example.com", name: "Mine", description: "d1", assetCondition: null, assetConditionEffective: null, assetFilterUnconvertible: [], assetIds: [], createdBy: "alice" },
    {
      id: "c2", email: "theirs@example.com", name: "Theirs", description: "d2",
      assetCondition: { op: "and", children: [{ field: "hostname", operator: "contains", value: "prod" }] },
      assetConditionEffective: { op: "and", children: [{ field: "hostname", operator: "contains", value: "prod" }] },
      assetFilterUnconvertible: [], assetIds: ["a1", "a2"], createdBy: "bob",
    },
  ];
  searchEntries = [
    { source: "user", id: "u1", email: "jane@example.com", name: "Jane Doe", description: "Polaris user account", kind: "person" },
    { source: "contact", id: "c1", email: "mine@example.com", name: "Mine", description: "d1", kind: "person", owned: true },
  ];
  overlays().forEach((o) => o.remove());
  doc.body.innerHTML = PAGE_HTML;
});

describe("renderTab", () => {
  /** Rows in the People pane (the Regions pane has its own table). */
  function peopleRows() {
    return Array.from(doc.querySelectorAll("#ab-tab-results tbody tr"));
  }

  it("renders the contacts with a device summary, and the searchable people beside them", async () => {
    // Picker parity: the tab lists contacts AND the Polaris accounts /
    // directory hits the wizard's picker offers, not contacts alone.
    await (window as unknown as { PolarisAddressBook: { renderTab: () => Promise<void> } }).PolarisAddressBook.renderTab();
    await flush();
    // 2 contacts + Jane; the search's own copy of mine@example.com is deduped
    // away in favour of the manageable contact row.
    expect(peopleRows()).toHaveLength(3);
    const text = (doc.getElementById("contacts-list") as unknown as { textContent: string }).textContent;
    expect(text).toContain("mine@example.com");
    expect(text).toContain("jane@example.com");
    expect(text.match(/mine@example\.com/g)).toHaveLength(1);
    // The filter + pins are summarized rather than dumped.
    expect(text).toContain("1 condition + 2 pinned devices");
    // Source badges, so "Polaris user" and "Contact" are told apart.
    expect(text).toContain("Polaris user");
    expect(text).toContain("Contact");
  });

  it("browses the region and tag catalogues in one pane", async () => {
    await (window as unknown as { PolarisAddressBook: { renderTab: () => Promise<void> } }).PolarisAddressBook.renderTab();
    await flush();
    const tags = doc.getElementById("ab-tab-tags") as unknown as { textContent: string };
    // Every row names the PEOPLE it reaches, not the label they carry.
    expect(tags.textContent).toContain("Ashfield Users");
    expect(tags.textContent).toContain("Memphis Users");
    expect(tags.textContent).toContain("Facilities Users");
    expect(tags.textContent).toContain("Datacenter Users");
    // Told apart by source, since the two match differently at fire time.
    expect(tags.textContent).toContain("Region");
    expect(tags.textContent).toContain("Tag");
    // Read-only: regions are drawn on the Device Map and tags live in the
    // registry — neither is edited here.
    expect(doc.querySelectorAll("#ab-tab-tags [data-ab-edit]")).toHaveLength(0);
  });

  it("shows each region's nesting level in the Tags pane", async () => {
    await (window as unknown as { PolarisAddressBook: { renderTab: () => Promise<void> } }).PolarisAddressBook.renderTab();
    await flush();
    const head = doc.querySelector("#ab-tab-tags thead") as unknown as { textContent: string };
    expect(head.textContent).toContain("Level");
    // Level sits in its own column, second — and the container reads HIGHER
    // than the region it contains, which is the whole point of showing it.
    const levelOf = (name: string) => {
      const rows = Array.from(doc.querySelectorAll("#ab-tab-tags tbody tr")) as unknown as {
        textContent: string;
        querySelectorAll: (sel: string) => unknown[];
      }[];
      const row = rows.find((r) => r.textContent.includes(name));
      const cells = Array.from(row!.querySelectorAll("td")) as unknown as { textContent: string }[];
      return cells[1].textContent.trim();
    };
    expect(levelOf("Ashfield")).toBe("L1");
    expect(levelOf("Memphis")).toBe("L2");
    // A registry tag has no place in the nesting — an em dash, never "L1".
    expect(levelOf("Facilities")).toBe("—");
  });

  it("leaves the level blank when the catalogue could not be levelled", async () => {
    // The server answers an empty byName when the derivation fails. An em dash,
    // never "L1" — that would be a claim about how the map is drawn.
    const contactsApi = (g.api as { contacts: { filterSchema: () => Promise<{ options: Record<string, unknown> }> } }).contacts;
    const orig = contactsApi.filterSchema;
    contactsApi.filterSchema = async () => {
      const payload = await orig();
      payload.options.regionLevels = { maxLevel: 1, byName: {} };
      return payload;
    };
    try {
      await (window as unknown as { PolarisAddressBook: { renderTab: () => Promise<void> } }).PolarisAddressBook.renderTab();
      await flush();
      const regions = doc.getElementById("ab-tab-tags") as unknown as { textContent: string };
      expect(regions.textContent).toContain("Ashfield");
      expect(regions.textContent).not.toContain("L1");
    } finally {
      contactsApi.filterSchema = orig;
    }
  });

  it("narrows the people list from the search box", async () => {
    await (window as unknown as { PolarisAddressBook: { renderTab: () => Promise<void> } }).PolarisAddressBook.renderTab();
    await flush();
    const box = doc.getElementById("ab-tab-search") as unknown as
      { value: string; dispatchEvent: (e: unknown) => void };
    // The server filters its own half; the stored contacts are filtered here,
    // because they're rendered from GET /contacts rather than out of the search.
    box.value = "theirs";
    box.dispatchEvent(new win.Event("input", { bubbles: true }));
    await settleDebounce();
    const emails = peopleRows().map((r) => (r as unknown as { textContent: string }).textContent);
    expect(emails.some((t) => t.includes("theirs@example.com"))).toBe(true);
    expect(emails.some((t) => t.includes("mine@example.com"))).toBe(false);
  });

  it("shows an empty state rather than a bare table", async () => {
    contacts = [];
    searchEntries = [];
    await (window as unknown as { PolarisAddressBook: { renderTab: () => Promise<void> } }).PolarisAddressBook.renderTab();
    await flush();
    expect((doc.getElementById("contacts-list") as unknown as { textContent: string }).textContent)
      .toMatch(/no contacts yet/i);
  });

  it("says the address book is empty even when Polaris accounts fill the table", async () => {
    // A populated table of user accounts must not read as "contacts are set up".
    contacts = [];
    await (window as unknown as { PolarisAddressBook: { renderTab: () => Promise<void> } }).PolarisAddressBook.renderTab();
    await flush();
    const text = (doc.getElementById("contacts-list") as unknown as { textContent: string }).textContent;
    expect(peopleRows().length).toBeGreaterThan(0);
    expect(text).toMatch(/no contacts yet/i);
  });

  it("at fullwrite offers Edit/Delete on EVERY row", async () => {
    level = "fullwrite";
    await (window as unknown as { PolarisAddressBook: { renderTab: () => Promise<void> } }).PolarisAddressBook.renderTab();
    await flush();
    expect(doc.querySelectorAll("[data-ab-edit]")).toHaveLength(2);
    expect(doc.querySelectorAll("[data-ab-del]")).toHaveLength(2);
  });

  it("at write offers them ONLY on rows the caller created", async () => {
    // The client mirror of assertOwnership — a button here that 403s there is
    // the failure this guards.
    level = "write";
    await (window as unknown as { PolarisAddressBook: { renderTab: () => Promise<void> } }).PolarisAddressBook.renderTab();
    await flush();
    const edits = Array.from(doc.querySelectorAll("[data-ab-edit]"));
    expect(edits).toHaveLength(1);
    expect((edits[0] as unknown as { getAttribute: (a: string) => string }).getAttribute("data-ab-edit")).toBe("c1");
  });

  it("at read offers neither", async () => {
    level = "read";
    await (window as unknown as { PolarisAddressBook: { renderTab: () => Promise<void> } }).PolarisAddressBook.renderTab();
    await flush();
    expect(doc.querySelectorAll("[data-ab-edit]")).toHaveLength(0);
    expect(doc.querySelectorAll("[data-ab-del]")).toHaveLength(0);
  });

  it("deletes behind a confirm, and not when it is declined", async () => {
    const AB = (window as unknown as { PolarisAddressBook: { renderTab: () => Promise<void> } }).PolarisAddressBook;
    await AB.renderTab();
    await flush();

    confirmAnswer = false;
    click(doc.querySelector('[data-ab-del="c1"]'));
    await flush();
    expect(deleted).toEqual([]);

    confirmAnswer = true;
    click(doc.querySelector('[data-ab-del="c1"]'));
    await flush();
    expect(deleted).toEqual(["c1"]);
  });
});

describe("stacked overlay contract", () => {
  it("the picker builds its OWN overlay above the base modal layer", async () => {
    // openModal reuses one shared #modal-overlay and overwrites its body, so a
    // picker opened from the wizard must never go through it.
    (window as unknown as { PolarisAddressBook: { openPicker: (o: unknown) => Promise<unknown> } })
      .PolarisAddressBook.openPicker({ field: "cc" });
    await flush();

    const o = overlays();
    expect(o).toHaveLength(1);
    expect((o[0] as unknown as { id: string }).id).not.toBe("modal-overlay");
    expect(Number((o[0] as unknown as { style: { zIndex: string } }).style.zIndex)).toBeGreaterThanOrEqual(1300);
  });

  it("the editor stacks ABOVE the picker so both stay usable", async () => {
    const AB = (window as unknown as {
      PolarisAddressBook: { openPicker: (o: unknown) => Promise<unknown> };
    }).PolarisAddressBook;
    AB.openPicker({ field: "to" });
    await flush();
    click(doc.querySelector('[data-ab="new"]'));
    await flush();

    const z = overlays().map((o) => Number((o as unknown as { style: { zIndex: string } }).style.zIndex));
    expect(z).toHaveLength(2);
    expect(Math.max(...z)).toBeGreaterThan(Math.min(...z));
  });

  it("highlights the field it was opened from without hiding the others", async () => {
    (window as unknown as { PolarisAddressBook: { openPicker: (o: unknown) => Promise<unknown> } })
      .PolarisAddressBook.openPicker({ field: "bcc" });
    await flush();
    const bcc = doc.querySelector('[data-ab="add-bcc"]') as unknown as { className: string };
    const to = doc.querySelector('[data-ab="add-to"]') as unknown as { className: string };
    expect(bcc.className).toContain("btn-primary");
    expect(to.className).toContain("btn-secondary");
  });
});

describe("device filter — the shared condition tree", () => {
  type AB = { openEditor: (c: unknown) => Promise<unknown> };
  const ab = () => (window as unknown as { PolarisAddressBook: AB }).PolarisAddressBook;

  /**
   * Open the editor and let its schema fetch + body assembly settle. The
   * module's promise resolves only when the dialog CLOSES, so it is deliberately
   * not awaited — awaiting it here would hang every test.
   */
  let editorDone: Promise<unknown> | null = null;
  async function openEditor(contact: unknown) {
    editorDone = ab().openEditor(contact);
    void editorDone;
    await flush(5);
  }
  const allCb = () => doc.getElementById("ab-all-devices") as unknown as
    { checked: boolean; dispatchEvent: (e: unknown) => void };
  /** Tick or untick All devices, the way the operator does. */
  function setAllDevices(on: boolean) {
    const cb = allCb();
    cb.checked = on;
    cb.dispatchEvent(new win.Event("change", { bubbles: true }));
  }
  function save() { click(doc.querySelector('[data-ab="save"]')); }

  it("is the automations Devices control: All devices, checked by default", async () => {
    await openEditor(null);
    // Same two-state shape as the wizard's "All assets" — not a third radio.
    expect(doc.querySelectorAll('input[name="ab-own"]')).toHaveLength(0);
    expect(allCb().checked).toBe(true);
    expect((doc.getElementById("ab-filter-wrap") as unknown as { style: { display: string } }).style.display)
      .toBe("none");
  });

  it("unchecking reveals the builder with a starter row", async () => {
    await openEditor(null);
    expect(doc.querySelectorAll("#ab-cond-root .scr-row")).toHaveLength(0);
    setAllDevices(false);
    expect((doc.getElementById("ab-filter-wrap") as unknown as { style: { display: string } }).style.display)
      .not.toBe("none");
    expect(doc.querySelectorAll("#ab-cond-root .scr-row").length).toBeGreaterThan(0);
  });

  it("unchecked with an empty filter means pins-only, not all devices", async () => {
    // The one place contacts differ from automations, where an empty tree with
    // All-assets unchecked is a validation error: a contact is useful as a bare
    // address, so this saves as "no filter" rather than refusing.
    await openEditor(null);
    (doc.getElementById("ab-email") as unknown as { value: string }).value = "bare@example.com";
    setAllDevices(false);
    // Drop the seeded starter row entirely — a row left BLANK is refused with
    // "give every condition a value" (the wizard's behaviour), so the pins-only
    // state is reached by removing it, not by emptying it.
    click(doc.querySelector("#ab-cond-root .scr-remove"));
    save();
    await flush();
    expect(created).toHaveLength(1);
    expect(created[0]!.assetAllDevices).toBeUndefined();
    expect(created[0]!.assetCondition).toBeUndefined();
    expect(created[0]!.assetCriteria).toBeUndefined();
  });

  it("renders the tree with the WIDER vocabulary this surface carries", async () => {
    await openEditor(null);
    setAllDevices(false);
    const fields = Array.from(doc.querySelectorAll("#ab-cond-root .scr-field option"))
      .map((o) => (o as unknown as { value: string }).value);
    // "location" exists here and deliberately not in the automations scope.
    expect(fields).toContain("location");
    expect(fields).toContain("hostname");
  });

  it("opens a stored condition into the builder", async () => {
    await openEditor({
      id: "c9",
      email: "ashf@example.com",
      assetCondition: { op: "and", children: [{ field: "location", operator: "contains", value: "Ashfield" }] },
      assetConditionEffective: { op: "and", children: [{ field: "location", operator: "contains", value: "Ashfield" }] },
      assetFilterUnconvertible: [],
      assetIds: [],
    });
    // A stored filter opens with All devices UNCHECKED and the tree shown.
    expect(allCb().checked).toBe(false);
    const vals = Array.from(doc.querySelectorAll("#ab-cond-root .scr-value"))
      .map((i) => (i as unknown as { value: string }).value);
    expect(vals).toContain("Ashfield");
  });

  it("saves the tree as assetCondition, never as flat criteria", async () => {
    await openEditor(null);
    (doc.getElementById("ab-email") as unknown as { value: string }).value = "new@example.com";
    setAllDevices(false);
    (doc.querySelector("#ab-cond-root .scr-value") as unknown as { value: string }).value = "Ashfield";
    (doc.querySelector("#ab-cond-root .scr-field") as unknown as { value: string }).value = "location";
    save();
    await flush();
    expect(created).toHaveLength(1);
    expect(created[0]!.assetCriteria).toBeUndefined();
    expect(created[0]!.assetCondition).toMatchObject({ op: "and" });
  });

  it("sends the explicit all-devices flag rather than an empty tree", async () => {
    await openEditor(null);
    (doc.getElementById("ab-email") as unknown as { value: string }).value = "noc@example.com";
    setAllDevices(true);
    save();
    await flush();
    expect(created[0]!.assetAllDevices).toBe(true);
    expect(created[0]!.assetCondition).toBeUndefined();
  });

  it("carries a legacy filter it cannot render through the save untouched", async () => {
    // The one filter shape the builder can't show. Saving must not replace it
    // with the empty tree the builder collects — that would silently widen who
    // the contact is responsible for.
    const legacy = { version: 1, match: "all", rules: [{ field: "integration", op: "exact", values: ["int-1"] }] };
    await openEditor({
      id: "c8", email: "byint@example.com", assetCondition: null, assetConditionEffective: null,
      assetCriteria: legacy, assetFilterUnconvertible: ["integration"], assetIds: [],
    });
    // The operator is told, and All devices stays UNCHECKED — ticking it would
    // silently widen the contact from its legacy filter to the whole fleet.
    expect(allCb().checked).toBe(false);
    expect((doc.querySelector("#ab-filter-wrap") as unknown as { textContent: string }).textContent)
      .toMatch(/can’t show/i);
    save();
    await flush();
    expect(updated).toHaveLength(1);
    expect(updated[0]!.assetCriteria).toEqual(legacy);
    expect(updated[0]!.assetCondition).toBeUndefined();
  });

  it("previews from the filter body, and calls nothing for an address-only contact", async () => {
    await openEditor(null);
    // Drain any debounced preview an earlier test scheduled before counting —
    // the timer outlives its test.
    await new Promise((r) => setTimeout(r, 500));
    previewed.length = 0;

    setAllDevices(false);
    click(doc.querySelector("#ab-cond-root .scr-remove"));
    await new Promise((r) => setTimeout(r, 500));
    expect(previewed).toHaveLength(0); // nothing to ask the server about
    expect((doc.getElementById("ab-preview") as unknown as { textContent: string }).textContent)
      .toMatch(/address-only/i);

    setAllDevices(true);
    // The preview is debounced ~400ms — the wait is the point of the assertion.
    await new Promise((r) => setTimeout(r, 500));
    expect(previewed.some((b) => b.assetAllDevices === true)).toBe(true);
  });
});

describe("picker selection", () => {
  it("resolves the chosen entries with the field the operator dropped them into", async () => {
    const p = (window as unknown as { PolarisAddressBook: { openPicker: (o: unknown) => Promise<unknown> } })
      .PolarisAddressBook.openPicker({ field: "to" });
    await flush();

    const cb = doc.querySelector('[data-ab-pick="jane@example.com"]') as unknown as {
      checked: boolean; dispatchEvent: (e: unknown) => void;
    };
    cb.checked = true;
    cb.dispatchEvent(new win.Event("change", { bubbles: true }));

    // Opened from To, but the operator chose Cc — the result must follow the
    // button, not the origin.
    click(doc.querySelector('[data-ab="add-cc"]'));
    await flush();

    const res = (await p) as { field: string; entries: Array<{ email: string }> };
    expect(res.field).toBe("cc");
    expect(res.entries.map((e) => e.email)).toEqual(["jane@example.com"]);
  });

  it("refuses an empty selection with a toast instead of resolving nothing", async () => {
    (window as unknown as { PolarisAddressBook: { openPicker: (o: unknown) => Promise<unknown> } })
      .PolarisAddressBook.openPicker({ field: "to" });
    await flush();
    click(doc.querySelector('[data-ab="add-to"]'));
    await flush();
    expect(toasts.join(" ")).toMatch(/select at least one/i);
    expect(overlays()).toHaveLength(1); // still open
  });

  it("offers a Tags tab holding the dynamic entries and both catalogues", async () => {
    (window as unknown as { PolarisAddressBook: { openPicker: (o: unknown) => Promise<unknown> } })
      .PolarisAddressBook.openPicker({ field: "to" });
    await flush(5);

    // People is the landing pane; Tags is hidden but present, so switching
    // keeps the search term and the current selection.
    const pane = doc.querySelector('[data-ab-pane="tags"]') as unknown as
      { style: { display: string }; textContent: string };
    expect(pane).toBeTruthy();
    expect(pane.style.display).toBe("none");

    click(doc.querySelector('[data-ab-tab="tags"]'));
    expect(pane.style.display).toBe("");
    // Region users head the Tags list; responsible CONTACTS are people, so
    // they head the People list instead (asserted below).
    expect(pane.textContent).toContain("Region Users");
    expect(pane.textContent).not.toContain("Responsible Contacts");
    expect(pane.textContent).toContain("Ashfield Users");
    expect(pane.textContent).toContain("Memphis Users");
    expect(pane.textContent).toContain("Facilities Users");
  });

  it("offers NO level entries while the region catalogue is flat", async () => {
    // On a flat catalogue "L1 Region Users" is a synonym for the all-levels
    // entry, and offering it would invite a rule that quietly changes meaning
    // the day someone draws a containing polygon.
    (window as unknown as { PolarisAddressBook: { openPicker: (o: unknown) => Promise<unknown> } })
      .PolarisAddressBook.openPicker({ field: "to" });
    await flush(5);
    click(doc.querySelector('[data-ab-tab="tags"]'));
    const pane = doc.querySelector('[data-ab-pane="tags"]') as unknown as { textContent: string };
    expect(pane.textContent).toContain("Region Users");
    expect(pane.textContent).not.toContain("L1 Region Users");
    expect(pane.textContent).not.toContain("L2 Region Users");
  });

  it("offers one level entry per level once regions are nested", async () => {
    schemaMaxLevel = 2;
    reloadAddressBook();
    (window as unknown as { PolarisAddressBook: { openPicker: (o: unknown) => Promise<unknown> } })
      .PolarisAddressBook.openPicker({ field: "to" });
    await flush(5);
    click(doc.querySelector('[data-ab-tab="tags"]'));
    const pane = doc.querySelector('[data-ab-pane="tags"]') as unknown as { textContent: string };
    expect(pane.textContent).toContain("L1 Region Users");
    expect(pane.textContent).toContain("L2 Region Users");
    expect(pane.textContent).not.toContain("L3 Region Users");
    // The all-levels entry stays — it is what stored rules use.
    expect(pane.textContent).toContain("Asset’s Region Users");
  });

  it("returns a picked level entry with its own source and level", async () => {
    schemaMaxLevel = 2;
    reloadAddressBook();
    const picker = (window as unknown as {
      PolarisAddressBook: { openPicker: (o: unknown) => Promise<{ field: string; entries: Array<Record<string, unknown>> }> };
    }).PolarisAddressBook.openPicker({ field: "to" });
    await flush(5);
    click(doc.querySelector('[data-ab-tab="tags"]'));
    const box = doc.querySelector('[data-ab-pick="deviceRegionLevel|deviceRegionLevel:2"]') as unknown as
      { checked: boolean; dispatchEvent: (e: unknown) => void };
    expect(box).toBeTruthy();
    box.checked = true;
    box.dispatchEvent(new (win as unknown as { Event: new (t: string, o?: unknown) => unknown }).Event("change", { bubbles: true }));
    click(doc.querySelector('[data-ab="add-to"]'));
    const settled = await picker;
    expect(settled.entries.some((e) => e.source === "deviceRegionLevel" && e.level === 2)).toBe(true);
  });

  it("heads the PEOPLE list with the responsible-contacts entry", async () => {
    (window as unknown as { PolarisAddressBook: { openPicker: (o: unknown) => Promise<unknown> } })
      .PolarisAddressBook.openPicker({ field: "to" });
    await flush(5);
    const rows = Array.from(doc.querySelectorAll('[data-ab-pane="people"] tbody tr'));
    // First row, above the search results — it isn't a search hit, it's the
    // standing answer to "whoever owns the device".
    expect((rows[0] as unknown as { textContent: string }).textContent).toContain("Responsible Contacts");
    expect((rows[1] as unknown as { textContent: string }).textContent).toContain("jane@example.com");
  });

  it("keeps the responsible-contacts entry when a search matches nobody", async () => {
    (window as unknown as { PolarisAddressBook: { openPicker: (o: unknown) => Promise<unknown> } })
      .PolarisAddressBook.openPicker({ field: "to" });
    await flush(5);
    searchEntries = [];
    const box = doc.getElementById("ab-pick-search") as unknown as
      { value: string; dispatchEvent: (e: unknown) => void };
    box.value = "nobodyxyz";
    box.dispatchEvent(new win.Event("input", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 400));
    const pane = doc.querySelector('[data-ab-pane="people"]') as unknown as { textContent: string };
    expect(pane.textContent).toContain("Responsible Contacts");
    expect(pane.textContent).toMatch(/no people match/i);
  });

  it("returns a region and a dynamic entry with their own sources", async () => {
    const p = (window as unknown as { PolarisAddressBook: { openPicker: (o: unknown) => Promise<{ field: string; entries: { source: string; id: string }[] } | null> } })
      .PolarisAddressBook.openPicker({ field: "cc" });
    await flush(5);
    click(doc.querySelector('[data-ab-tab="tags"]'));

    const boxes = Array.from(doc.querySelectorAll('[data-ab-pane="tags"] [data-ab-pick]'));
    // deviceRegion, Ashfield, Memphis, Facilities, Datacenter — assetContacts
    // lives in People now.
    expect(boxes.length).toBe(5);
    const tick = (el: unknown) => {
      (el as { checked: boolean }).checked = true;
      (el as { dispatchEvent: (e: unknown) => void }).dispatchEvent(new win.Event("change", { bubbles: true }));
    };
    tick(boxes[0]);
    tick(boxes[1]);
    click(doc.querySelector('[data-ab="add-cc"]'));
    await flush();

    const res = await p;
    expect(res!.field).toBe("cc");
    expect(res!.entries.map((e) => e.source).sort()).toEqual(["deviceRegion", "region"]);
    expect(res!.entries.find((e) => e.source === "region")!.id).toBe("Ashfield");
  });

  it("returns a registry tag as a `tag` entry, apart from regions", async () => {
    // The two route differently at fire time — a region matches User.regionTags
    // only, a tag matches the flattened scope — so the picker must not blur
    // them into one source just because they share a pane.
    const p = (window as unknown as { PolarisAddressBook: { openPicker: (o: unknown) => Promise<{ entries: { source: string; id: string }[] } | null> } })
      .PolarisAddressBook.openPicker({ field: "to" });
    await flush(5);
    click(doc.querySelector('[data-ab-tab="tags"]'));

    const box = doc.querySelector('[data-ab-pick="tag|Facilities"]') as unknown as
      { checked: boolean; dispatchEvent: (e: unknown) => void };
    expect(box).toBeTruthy();
    box.checked = true;
    box.dispatchEvent(new win.Event("change", { bubbles: true }));
    click(doc.querySelector('[data-ab="add-to"]'));
    await flush();

    const res = await p;
    expect(res!.entries).toHaveLength(1);
    expect(res!.entries[0].source).toBe("tag");
    expect(res!.entries[0].id).toBe("Facilities");
  });

  it("keeps a People selection when the operator looks at Tags", async () => {
    const p = (window as unknown as { PolarisAddressBook: { openPicker: (o: unknown) => Promise<{ entries: { source: string }[] } | null> } })
      .PolarisAddressBook.openPicker({ field: "to" });
    await flush(5);

    const person = doc.querySelector('[data-ab-pane="people"] [data-ab-pick]') as unknown as
      { checked: boolean; dispatchEvent: (e: unknown) => void };
    person.checked = true;
    person.dispatchEvent(new win.Event("change", { bubbles: true }));

    click(doc.querySelector('[data-ab-tab="tags"]'));
    click(doc.querySelector('[data-ab-tab="people"]'));
    click(doc.querySelector('[data-ab="add-to"]'));
    await flush();

    const res = await p;
    expect(res!.entries).toHaveLength(1);
  });

  it("resolves null when dismissed", async () => {
    const p = (window as unknown as { PolarisAddressBook: { openPicker: (o: unknown) => Promise<unknown> } })
      .PolarisAddressBook.openPicker({ field: "to" });
    await flush();
    click(doc.querySelector(".modal-close"));
    await flush();
    expect(await p).toBeNull();
  });
});

/** A contact row the directory sync owns: createdBy null, origin the backend. */
const SYNCED = {
  id: "c9", email: "synced@example.com", name: "Synced Person", description: null,
  jobTitle: "Foreman", department: "Quarry Ops", phone: "555-1000",
  origin: "entra", kind: "person",
  assetCondition: null, assetConditionEffective: null, assetFilterUnconvertible: [],
  assetIds: [], createdBy: null,
};

describe("directory-synced rows", () => {
  /** A row the sync owns: createdBy is null and origin names the backend. */
  function peopleRows() {
    return Array.from(doc.querySelectorAll("#ab-tab-results tbody tr"));
  }
  const render = () =>
    (window as unknown as { PolarisAddressBook: { renderTab: () => Promise<void> } }).PolarisAddressBook.renderTab();

  it("offers Adopt instead of Edit/Delete — a delete would be undone next run", async () => {
    contacts.push(SYNCED as never);
    await render();
    await flush();
    expect(doc.querySelectorAll('[data-ab-adopt="c9"]')).toHaveLength(1);
    expect(doc.querySelectorAll('[data-ab-del="c9"]')).toHaveLength(0);
    expect(doc.querySelectorAll('[data-ab-edit="c9"]')).toHaveLength(0);
    // A row the operator added keeps both verbs.
    expect(doc.querySelectorAll('[data-ab-del="c1"]')).toHaveLength(1);
  });

  it("withholds Adopt below fullwrite — taking a row from the sync is an admin act", async () => {
    level = "write";
    contacts.push(SYNCED as never);
    await render();
    await flush();
    expect(doc.querySelectorAll('[data-ab-adopt="c9"]')).toHaveLength(0);
  });

  it("adopts on confirm, and says nothing happened when declined", async () => {
    contacts.push(SYNCED as never);
    await render();
    await flush();

    confirmAnswer = false;
    click(doc.querySelector('[data-ab-adopt="c9"]'));
    await flush();
    expect(adopted).toEqual([]);

    confirmAnswer = true;
    click(doc.querySelector('[data-ab-adopt="c9"]'));
    await flush();
    expect(adopted).toEqual(["c9"]);
  });

  it("badges the row as its directory and shows what the directory knows", async () => {
    // origin stores the backend name so it drops into the existing badge
    // vocabulary; job title and department are how two people with the same
    // name are told apart in a picker.
    contacts.push(SYNCED as never);
    await render();
    await flush();
    const text = (doc.getElementById("contacts-list") as unknown as { textContent: string }).textContent;
    expect(text).toContain("Entra");
    expect(text).toContain("Foreman — Quarry Ops");
    expect(text).toContain("Directory sync");
  });
});

/**
 * The source tabs over the People table. Each tab is its own QUERY, not a
 * client-side slice of one merged list — the contacts half is paginated, so
 * filtering 50 mixed rows down to the synced ones would show a fraction of
 * them and call it the directory.
 */
describe("the source tabs", () => {
  const render = () =>
    (window as unknown as { PolarisAddressBook: { renderTab: () => Promise<void> } }).PolarisAddressBook.renderTab();

  function tabLabels() {
    return Array.from(doc.querySelectorAll("#ab-tab-sources [data-ab-source]"))
      .map((b) => (b as unknown as { textContent: string }).textContent.trim());
  }
  function tab(key: string) {
    return doc.querySelector('#ab-tab-sources [data-ab-source="' + key + '"]');
  }
  function rowText() {
    return (doc.getElementById("ab-tab-results") as unknown as { textContent: string }).textContent;
  }

  it("always offers All / Polaris users / Manual, and no directory tab without one", async () => {
    await render();
    await flush();
    expect(tabLabels()).toEqual(["All", "Polaris users", "Manual"]);
  });

  it("names a directory tab after the integration that feeds it", async () => {
    // "the directory" is not what an operator calls it — the tab carries the
    // integration's own name, and only once the server says the caller may see
    // its rows at all.
    directoryVisible = true;
    directorySources = [{ kind: "entra", label: "Corp Entra", sync: true, search: true }];
    await render();
    await flush();
    expect(tabLabels()).toEqual(["All", "Polaris users", "Corp Entra directory", "Manual"]);
  });

  it("withholds the directory tab from a caller who may not see synced rows", async () => {
    // The visibility gate is business rule 35: a tab naming a directory whose
    // rows are then withheld reads as a broken page.
    directoryVisible = false;
    directorySources = [{ kind: "entra", label: "Corp Entra", sync: true, search: true }];
    await render();
    await flush();
    expect(tabLabels()).not.toContain("Corp Entra directory");
  });

  it("asks the SERVER for one backend's rows on a directory tab", async () => {
    directoryVisible = true;
    directorySources = [{ kind: "entra", label: "Entra ID", sync: true, search: true }];
    contacts.push(SYNCED as never);
    await render();
    await flush();

    click(tab("entra"));
    await flush();
    expect(listOrigins.at(-1)).toBe("entra");
    // Only that directory's rows: the Polaris account in searchEntries is not
    // an Entra hit and must not ride along under the directory's name.
    expect(rowText()).toContain("Synced Person");
    expect(rowText()).not.toContain("Jane Doe");

    click(tab("manual"));
    await flush();
    expect(listOrigins.at(-1)).toBe("manual");
    expect(rowText()).not.toContain("Synced Person");
  });

  it("skips the halves a tab cannot need", async () => {
    // Polaris users asks the contacts endpoint nothing (no account is a
    // contact row) and never fans the query out to the GAL; Manual asks the
    // search endpoint nothing.
    await render();
    await flush();
    listOrigins = [];
    searchCalls = [];

    click(tab("user"));
    await flush();
    expect(listOrigins).toEqual([]);
    expect(searchCalls.map((c) => c.directory)).toEqual([false]);
    expect(rowText()).toContain("Jane Doe");
    expect(rowText()).not.toContain("Theirs");

    searchCalls = [];
    click(tab("manual"));
    await flush();
    expect(listOrigins).toEqual(["manual"]);
    expect(searchCalls).toEqual([]);
  });

  it("falls back to All when the active directory tab goes away", async () => {
    // The integration was disabled (or the caller lost the gate) between
    // loads: the rows on screen belong to a tab that no longer exists.
    directoryVisible = true;
    directorySources = [{ kind: "entra", label: "Entra ID", sync: true, search: true }];
    await render();
    await flush();
    click(tab("entra"));
    await flush();

    directorySources = [];
    await render();
    await flush();
    expect(tabLabels()).toEqual(["All", "Polaris users", "Manual"]);
    expect((tab("all") as unknown as { className: string }).className).toContain("active");
    expect(listOrigins.at(-1)).toBe("all");
  });
});

/**
 * Push is opt-in PER BROWSER, so a Polaris account that looks like a perfectly
 * good recipient can be unreachable. The column that says so is the same one
 * the wizard's push picker renders — and it is a different question from the
 * device FILTER beside it, which is why that one no longer says "Devices".
 */
describe("the Push devices column", () => {
  const render = () =>
    (window as unknown as { PolarisAddressBook: { renderTab: () => Promise<void> } }).PolarisAddressBook.renderTab();

  it("counts a user's enrolled browsers and calls out zero", async () => {
    searchEntries = [
      { source: "user", id: "u1", email: "jane@example.com", name: "Jane Doe", description: "Polaris user account", kind: "person", pushDevices: 2 },
      { source: "user", id: "u2", email: "sam@example.com", name: "Sam Roe", description: "Polaris user account", kind: "person", pushDevices: 0 },
    ];
    await render();
    await flush();
    const rows = Array.from(doc.querySelectorAll("#ab-tab-results tbody tr"))
      .map((r) => (r as unknown as { textContent: string }).textContent);
    expect(rows.find((t) => t.includes("Jane Doe"))).toContain("2 devices");
    expect(rows.find((t) => t.includes("Sam Roe"))).toContain("none");
    // A contact is an ADDRESS: it has no account, so no number of enrolled
    // browsers exists for it to have and "0" would be a claim about a person.
    expect(rows.find((t) => t.includes("Theirs"))).toContain("no Polaris account");
  });

  it("keeps the device FILTER under its own heading", async () => {
    await render();
    await flush();
    const heads = Array.from(doc.querySelectorAll("#ab-tab-results thead th"))
      .map((h) => (h as unknown as { textContent: string }).textContent.trim());
    expect(heads).toContain("Responsible for");
    expect(heads).toContain("Push devices");
    expect(heads).not.toContain("Devices");
  });
});
