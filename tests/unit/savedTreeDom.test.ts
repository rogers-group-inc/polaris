/**
 * tests/unit/savedTreeDom.test.ts — public/js/saved-tree.js, the folder tree
 * the Filters ▾ and Dashboards ▾ menus share (business rule 140):
 *   - sections by ownership (mine / shared / ownerless), or one heading on
 *     the wallboard; folders before items, both by name
 *   - folders open and close in place and remember it per browser
 *   - an item whose folder the caller can't see sits at the top level
 *   - drag and drop files an item into a folder and a folder to the top
 *     level, and never drops a folder into its own subtree
 *   - the Save modals' Folder picker indents nested folders
 *   - the read-only (wallboard) tree has no drag handles and no ⋯
 */

import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Window } from "happy-dom";

const SRC = readFileSync(resolve(__dirname, "../../public/js/saved-tree.js"), "utf8");
const g = globalThis as Record<string, unknown>;

type Row = Record<string, unknown>;
interface Tree {
  setData: (items: Row[], folders: Row[]) => void;
  html: () => string;
  wire: (el: unknown) => void;
  pickerHtml: (selected: string | null) => string;
}

let win: InstanceType<typeof Window>;
let doc: Window["document"];
let store: Record<string, string>;
let calls: string[];
let menu: Element;
let tree: Tree;

const mine = (o: Row): Row => ({ visibility: "private", ownerKind: "user", ownerName: "me", isOwner: true, canManage: true, canTake: true, ...o });
const theirs = (o: Row): Row => ({ visibility: "public", ownerKind: "user", ownerName: "dana", isOwner: false, canManage: false, canTake: false, ...o });

const FOLDERS: Row[] = [
  mine({ id: "fw", name: "Firewalls", parentId: null }),
  mine({ id: "hq", name: "HQ", parentId: "fw" }),
  theirs({ id: "noc", name: "NOC", parentId: null, ownerKind: "role", ownerName: "NOC Operators" }),
];
const ITEMS: Row[] = [
  mine({ id: "i1", name: "Down firewalls", folderId: "fw" }),
  mine({ id: "i2", name: "HQ gates", folderId: "hq" }),
  mine({ id: "i3", name: "Loose", folderId: null }),
  theirs({ id: "i4", name: "Shared one", folderId: "noc" }),
  // Its folder was not sent to this caller — the server nulls folderId.
  theirs({ id: "i5", name: "Orphaned shared", folderId: null }),
  { id: "i6", name: "Left behind", folderId: null, visibility: "public", ownerKind: "none", ownerName: "rlee", isOwner: false, canManage: true, canTake: true },
];

function boot(opts: Record<string, unknown> = {}) {
  win = new Window();
  doc = win.document;
  g.window = win;
  g.document = doc;
  g.escapeHtml = (s: unknown) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
  g.showToast = () => {};
  store = store || {};
  g.localStorage = {
    getItem: (k: string) => (k in store ? store[k] : null),
    setItem: (k: string, v: string) => { store[k] = v; },
  };
  (0, eval)(SRC);
  doc.body.innerHTML = '<div class="sfl-menu" id="m"></div>';
  menu = doc.getElementById("m") as unknown as Element;
  const render = () => { (menu as unknown as { innerHTML: string }).innerHTML = tree.html(); };
  tree = (win as unknown as { PolarisSavedTree: { create: (o: unknown) => Tree } }).PolarisSavedTree.create({
    storageKey: "t",
    labels: { mine: "My filters", shared: "Shared filters", ownerless: "Ownerless", one: "filter", many: "filters" },
    itemRowHtml: (it: Row, attrs: string) => '<div class="sfl-row"' + attrs + '><button data-load="' + it.id + '">' + it.name + "</button></div>",
    canPublish: () => true,
    ops: {
      moveItem: async (id: string, f: string | null) => { calls.push(`item ${id}→${f}`); },
      moveFolder: async (id: string, p: string | null) => { calls.push(`folder ${id}→${p}`); },
    },
    refresh: async () => { render(); },
    rerender: render,
    ...opts,
  });
  tree.setData(ITEMS, FOLDERS);
  tree.wire(menu);
  render();
}

const headings = () => Array.from(menu.querySelectorAll(".dropdown-heading")).map((h) => h.textContent);
const loads = () => Array.from(menu.querySelectorAll("[data-load]")).map((b) => b.getAttribute("data-load"));
const click = (sel: string) => (menu.querySelector(sel) as unknown as { click: () => void }).click();

function dragTo(source: string, target: string) {
  const fire = (el: Element, type: string) => el.dispatchEvent(new win.Event(type, { bubbles: true, cancelable: true }) as unknown as Event);
  const src = menu.querySelector(source)!;
  const dst = menu.querySelector(target)!;
  fire(src, "dragstart");
  fire(dst, "dragover");
  fire(dst, "drop");
}

beforeEach(() => {
  store = {};
  calls = [];
  boot();
});

describe("saved tree — rendering", () => {
  it("sections by ownership, with ownerless last", () => {
    expect(headings()).toEqual(["My filters", "Shared filters", "Ownerless"]);
  });

  it("starts with folders closed, and puts an item whose folder is hidden at the top level", () => {
    expect(loads()).toEqual(["i3", "i5", "i6"]);
  });

  it("opens a folder in place, remembers it, and indents its children", () => {
    click('[data-sft-toggle="fw"]');
    expect(loads()).toEqual(["i1", "i3", "i5", "i6"]);
    click('[data-sft-toggle="hq"]');
    expect(loads()).toEqual(["i2", "i1", "i3", "i5", "i6"]);
    const hqRow = menu.querySelector('[data-sft-folder="hq"]') as unknown as { getAttribute: (n: string) => string };
    expect(hqRow.getAttribute("style")).toContain("padding-left:20px");
    expect(JSON.parse(store.t).sort()).toEqual(["fw", "hq"]);
    // A fresh menu (a reload) comes back open.
    boot();
    expect(loads()).toEqual(["i2", "i1", "i3", "i5", "i6"]);
  });

  it("counts every item under a folder and names a role owner", () => {
    const fw = menu.querySelector('[data-sft-folder="fw"] .sft-count')!;
    expect(fw.textContent).toBe("2");
    const noc = menu.querySelector('[data-sft-folder="noc"] .sfl-owner')!;
    expect(noc.textContent).toBe("Role · NOC Operators");
  });

  it("offers ⋯ and drag only on what the caller manages", () => {
    expect(menu.querySelector('[data-sft-more="fw"]')).toBeTruthy();
    expect(menu.querySelector('[data-sft-folder="fw"]')!.getAttribute("draggable")).toBe("true");
    expect(menu.querySelector('[data-sft-more="noc"]')).toBeNull();
    expect(menu.querySelector('[data-sft-folder="noc"]')!.getAttribute("draggable")).toBeNull();
  });
});

describe("saved tree — drag and drop", () => {
  it("files an item into a folder", async () => {
    dragTo('[data-sft-item="i3"]', '[data-sft-folder="fw"]');
    await new Promise((r) => setTimeout(r, 0));
    expect(calls).toEqual(["item i3→fw"]);
  });

  it("moves a folder to the top level by dropping it on a section heading", async () => {
    click('[data-sft-toggle="fw"]');
    dragTo('[data-sft-folder="hq"]', "[data-sft-root]");
    await new Promise((r) => setTimeout(r, 0));
    expect(calls).toEqual(["folder hq→null"]);
  });

  it("never drops a folder into its own subtree", async () => {
    click('[data-sft-toggle="fw"]');
    dragTo('[data-sft-folder="fw"]', '[data-sft-folder="hq"]');
    await new Promise((r) => setTimeout(r, 0));
    expect(calls).toEqual([]);
  });
});

describe("saved tree — picker and the wallboard", () => {
  it("indents nested folders in the Save modal's picker and names others' owners", () => {
    const html = tree.pickerHtml("hq");
    expect(html).toContain('<option value="">Top level</option>');
    expect(html).toMatch(/<option value="hq" selected> {4}HQ<\/option>/);
    expect(html).toContain("NOC (Role · NOC Operators)");
  });

  it("is read-only when not interactive: one heading, no drag, no ⋯", () => {
    boot({ interactive: false, single: "Published dashboards" });
    expect(headings()).toEqual(["Published dashboards"]);
    expect(menu.querySelector("[draggable]")).toBeNull();
    expect(menu.querySelector("[data-sft-more]")).toBeNull();
  });
});
