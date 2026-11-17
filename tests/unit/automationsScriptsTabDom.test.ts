/**
 * tests/unit/automationsScriptsTabDom.test.ts — the Automations → Scripts tab's
 * row menu and import (public/js/automations.js): a script card answers a
 * right click (the row-menu replay) with Edit / Test run / Export / Delete, a
 * plain click on the card body opens nothing, a reader gets Export alone;
 * Export downloads `<name>.script.json` without id, hash or enabled flag; the
 * New script dialog's Import from file fills the form and saves nothing; the
 * Edit dialog's Replace from file keeps the name, takes the body (and, from a
 * .script.json, the settings) and saves nothing either.
 * showRowMenu / rowMenuGesture are stubbed — their replay is pinned in
 * rowContextMenu.test.ts.
 */

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Window } from "happy-dom";

const g = globalThis as Record<string, any>;
let win: InstanceType<typeof Window>;
let menuCalls: Array<{ anchor: any; items: any[] }> = [];
let gesture: { x: number; y: number } | null = null;
let canWrite = true;
let blobs: string[] = [];
let downloads: string[] = [];
let modal = { title: "", body: "" };
const toasts: string[] = [];
const created: unknown[] = [];
const updated: unknown[] = [];

const SCRIPTS = [
  { id: "s1", name: "cert-mail", description: "d", interpreter: "python3", runTarget: "server", timeoutSec: 30, enabled: true, sha256: "abcdef0123456789", body: "print('hi')\n" },
  { id: "s2", name: "agent-only", interpreter: "bash", runTarget: "agent", timeoutSec: 60, enabled: true, sha256: "00", body: "true" },
];

beforeAll(() => {
  win = new Window();
  win.document.body.innerHTML = '<button id="btn-refresh"></button><div id="scripts-list"></div>';
  g.window = win;
  g.document = win.document;
  g.escapeHtml = (s: unknown) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
  g.showToast = (m: string, k: string) => { toasts.push(k + ": " + m); };
  g.showConfirm = async () => true;
  g.permAtLeast = (key: string) => key === "automationScripts" && canWrite;
  g.showRowMenu = (anchor: unknown, items: any[]) => { menuCalls.push({ anchor, items }); };
  g.rowMenuGesture = () => gesture;
  g.openModal = (title: string, body: string, footer: string) => {
    modal = { title, body };
    win.document.body.insertAdjacentHTML("beforeend", '<div id="m">' + body + footer + "</div>");
  };
  g.closeModal = () => {};
  g.FileReader = (win as any).FileReader; // a browser global Node lacks
  g._ruleSchema = {};   // declared by automations-wizard.js on the real page
  g._awScripts = null;
  g.Blob = class { constructor(parts: string[]) { blobs.push(parts.join("")); } };
  g.URL = { createObjectURL: () => "blob:x", revokeObjectURL: () => {} };
  (win.HTMLAnchorElement.prototype as any).click = function () { downloads.push(this.download); };
  g.api = {
    automations: { schema: async () => ({}) },
    automationScripts: { list: async () => ({ scripts: SCRIPTS }), create: async (b: unknown) => { created.push(b); }, update: async (_id: string, b: unknown) => { updated.push(b); } },
  };
  // Keep the rules tab from wiring at load (it needs the rules table).
  const realPerm = g.permAtLeast;
  g.permAtLeast = () => false;
  new Function(readFileSync(resolve(__dirname, "../../public/js/automation-script-portability.js"), "utf8"))();
  (0, eval)(readFileSync(resolve(__dirname, "../../public/js/automations.js"), "utf8"));
  g.permAtLeast = realPerm;
});

beforeEach(async () => {
  menuCalls = [];
  gesture = null;
  canWrite = true;
  blobs = [];
  downloads = [];
  await g.loadScriptsTab();
});

const card = (id: string) => g.document.querySelector(`[data-script-id="${id}"]`);
const click = (el: any) => el.dispatchEvent(new win.MouseEvent("click", { bubbles: true, cancelable: true }));
const labels = (items: any[]) => items.filter((i) => !i.separator).map((i) => i.label);

describe("Scripts tab row menu", () => {
  it("a right click on the card opens Edit / Test run / Export / Delete", () => {
    gesture = { x: 10, y: 20 };
    click(card("s1").querySelector("p") || card("s1"));
    expect(menuCalls).toHaveLength(1);
    expect(menuCalls[0]!.anchor).toBe(card("s1"));
    expect(labels(menuCalls[0]!.items)).toEqual(["Edit", "Test run", "Export", "Delete"]);
    expect(menuCalls[0]!.items[0].primary).toBe(true);
    expect(menuCalls[0]!.items.find((i: any) => i.label === "Delete").danger).toBe(true);
  });

  it("a plain click on the card body or its buttons opens no menu; the name is the trigger", () => {
    click(card("s1"));
    expect(menuCalls).toHaveLength(0);
    click(card("s1").querySelector(".script-menu"));
    expect(menuCalls).toHaveLength(1);
  });

  it("greys Test run on an agent-only script, and offers a reader Export alone", () => {
    gesture = { x: 1, y: 1 };
    click(card("s2"));
    const t = menuCalls[0]!.items.find((i: any) => i.label === "Test run");
    expect(t.disabled).toBe(true);
    expect(t.title).toMatch(/agent-only/);
    canWrite = false;
    click(card("s1"));
    expect(labels(menuCalls[1]!.items)).toEqual(["Export"]);
  });

  it("Export downloads <name>.script.json with no id, hash or enabled flag", () => {
    gesture = { x: 1, y: 1 };
    click(card("s1"));
    menuCalls[0]!.items.find((i: any) => i.label === "Export").onSelect();
    expect(downloads).toEqual(["cert-mail.script.json"]);
    const doc = JSON.parse(blobs[0]!);
    expect(doc).toMatchObject({ polarisScript: 1, name: "cert-mail", interpreter: "python3", runTarget: "server", timeoutSec: 30, body: "print('hi')\n" });
    expect(doc).not.toHaveProperty("id");
    expect(doc).not.toHaveProperty("sha256");
    expect(doc).not.toHaveProperty("enabled");
  });
});

async function pick(name: string, content: string) {
  const input = g.document.getElementById("script-import-file");
  const file = new win.File([content], name, { type: "text/plain" });
  Object.defineProperty(input, "files", { value: [file], configurable: true });
  toasts.length = 0;
  input.dispatchEvent(new win.Event("change"));
  for (let i = 0; i < 40 && !toasts.some((t) => /Loaded/.test(t)); i++) await new Promise((r) => setTimeout(r, 25));
  expect(toasts.filter((t) => t.startsWith("error"))).toEqual([]);
}
const val = (id: string) => g.document.getElementById(id).value;
const form = () => [val("script-name"), val("script-desc"), val("script-interp"), val("script-target"), val("script-timeout"), val("script-body")];

describe("Edit script — Replace from file", () => {
  // happy-dom reads `<option selected>` on a non-first option as the option
  // AFTER it (python3 comes back "sh"), so pin the selects to what a real
  // browser shows before asserting what an import leaves alone.
  const openEdit = () => {
    g.document.getElementById("m")?.remove();
    g.openScriptModal(SCRIPTS[0]);
    g.document.getElementById("script-interp").value = SCRIPTS[0]!.interpreter;
    g.document.getElementById("script-target").value = SCRIPTS[0]!.runTarget;
  };

  it("is offered while editing, worded as a replace", () => {
    openEdit();
    expect(g.document.getElementById("script-import").textContent).toBe("Replace from file");
    expect(modal.body).toContain("the name stays");
  });

  it("a plain file replaces the body and its interpreter, and keeps the name and settings", async () => {
    openEdit();
    await pick("renewed.ps1", "Write-Host new");
    expect(form()).toEqual(["cert-mail", "d", "powershell", "server", "30", "Write-Host new"]);
    expect(updated).toHaveLength(0);
  });

  it("a plain file whose interpreter is only a guess keeps the script's interpreter", async () => {
    openEdit();
    await pick("renewed.txt", "echo new");
    expect(val("script-interp")).toBe("python3");
    expect(val("script-body")).toBe("echo new");
    expect(g.document.getElementById("script-import-notes").hidden).toBe(true);
  });

  it("an export replaces every setting but the name, and says so when the names differ", async () => {
    openEdit();
    await pick("other.script.json", JSON.stringify({ polarisScript: 1, name: "other", description: "new desc", interpreter: "bash", runTarget: "either", timeoutSec: 45, body: "echo v2" }));
    expect(form()).toEqual(["cert-mail", "new desc", "bash", "either", "45", "echo v2"]);
    const notes = g.document.getElementById("script-import-notes");
    expect(notes.hidden).toBe(false);
    expect(notes.textContent).toContain('keeps its name "cert-mail"');
    expect(updated).toHaveLength(0);
  });

  it("Save changes sends the replaced body under the kept name", async () => {
    openEdit();
    await pick("renewed.py", "print('v2')\n");
    g.document.getElementById("script-save").click();
    for (let i = 0; i < 20 && !updated.length; i++) await new Promise((r) => setTimeout(r, 10));
    expect(updated[0]).toMatchObject({ name: "cert-mail", interpreter: "python3", body: "print('v2')\n", timeoutSec: 30 });
    updated.length = 0;
  });
});

describe("New script — Import from file", () => {
  it("is offered on a new script, worded as an import", () => {
    g.document.getElementById("m")?.remove();
    g.openScriptModal(null);
    expect(g.document.getElementById("script-import").textContent).toBe("Import from file");
  });

  it("fills the form from a picked file and saves nothing", async () => {
    toasts.length = 0;
    const input = g.document.getElementById("script-import-file");
    const file = new win.File([JSON.stringify({ polarisScript: 1, name: "imported", description: "x", interpreter: "powershell", runTarget: "either", timeoutSec: 45, body: "Write-Host hi" })], "imported.script.json", { type: "application/json" });
    Object.defineProperty(input, "files", { value: [file], configurable: true });
    input.dispatchEvent(new win.Event("change"));
    for (let i = 0; i < 40 && !toasts.some((t) => /Loaded|read/.test(t)); i++) await new Promise((r) => setTimeout(r, 25));
    expect(toasts.filter((t) => t.startsWith("error"))).toEqual([]);
    const v = (id: string) => g.document.getElementById(id).value;
    expect([v("script-name"), v("script-interp"), v("script-target"), v("script-timeout"), v("script-body")])
      .toEqual(["imported", "powershell", "either", "45", "Write-Host hi"]);
    expect(created).toHaveLength(0);
  });
});
