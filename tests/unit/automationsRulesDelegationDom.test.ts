/**
 * tests/unit/automationsRulesDelegationDom.test.ts — the Automations list's two
 * per-row controls (the name's row menu and the Enabled switch) are delegated
 * from the static #rules-tbody and bound once (CQ-F042).
 *
 * The list repaints on every page, sort and filter change; it used to re-bind a
 * listener per row per paint. Pinned:
 *   • a row painted AFTER the listener was bound still opens its menu / saves
 *     its switch — the point of delegation;
 *   • repainting, and wiring again, never makes one click act twice;
 *   • the handler still gets the control itself (the menu anchors on the name
 *     button, not on a child the click landed on).
 *
 * The three functions live inside automations.js's page IIFE, so they are
 * sliced out by their two-space-indented headers and evaluated inside a
 * wrapper that supplies the closure variables they read.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Window } from "happy-dom";

const lines = readFileSync(resolve(__dirname, "../../public/js/automations.js"), "utf8").split(/\r?\n/);

function innerFn(header: string): string {
  const start = lines.findIndex((l) => l.startsWith(header));
  if (start < 0) throw new Error(`automations.js: ${header} not found`);
  const end = lines.findIndex((l, i) => i > start && l === "  }");
  return lines.slice(start, end + 1).join("\n");
}

const SRC = [
  innerFn("  function _wireRulesTable("),
  innerFn("  async function onRuleToggle("),
  innerFn("  function onRuleMenu("),
].join("\n");

type Win = Window & Record<string, any>;

function boot(canEdit: boolean) {
  const win = new Window() as Win;
  win.document.body.innerHTML = '<table><tbody id="rules-tbody"></tbody></table>';
  const menus: Array<{ anchor: Element; labels: string[] }> = [];
  const updates: Array<[string, boolean]> = [];
  win.__env = {
    _rules: [{ id: "r1", name: "CPU high", enabled: true }, { id: "r2", name: "Disk", enabled: false }],
    canEditRules: canEdit,
    showRowMenu: (anchor: Element, items: Array<{ label?: string }>) => {
      menus.push({ anchor, labels: items.filter((i) => i.label).map((i) => i.label!) });
    },
    showToast: () => {},
    showConfirm: async () => true,
    downDetectionRemovalWarning: async () => "",
    api: { automations: { update: async (id: string, input: { enabled: boolean }) => { updates.push([id, input.enabled]); } } },
    _ruleToInput: (r: { id: string }, patch: { enabled: boolean }) => Object.assign({ id: r.id }, patch),
    loadRules: () => {},
    openWizardFor: () => {},
    portabilityMenuItems: () => [{ label: "Export" }],
    cloneName: (n: string) => n + " (copy)",
    confirmDeleteRule: () => {},
  };
  win.eval(
    "(function (env) {" +
      "var _rules = env._rules, canEditRules = env.canEditRules, showRowMenu = env.showRowMenu," +
      " showToast = env.showToast, showConfirm = env.showConfirm," +
      " downDetectionRemovalWarning = env.downDetectionRemovalWarning, api = env.api," +
      " _ruleToInput = env._ruleToInput, loadRules = env.loadRules, openWizardFor = env.openWizardFor," +
      " portabilityMenuItems = env.portabilityMenuItems, cloneName = env.cloneName," +
      " confirmDeleteRule = env.confirmDeleteRule;\n" +
      SRC +
      "\nwindow._wireRulesTable = _wireRulesTable;" +
    "})(window.__env);",
  );
  const tbody = win.document.getElementById("rules-tbody") as unknown as HTMLElement;
  const paint = () => {
    tbody.innerHTML = win.__env._rules.map((r: { id: string; name: string; enabled: boolean }) =>
      `<tr data-row-menu-row><td><button type="button" class="row-menu-trigger rule-menu" data-id="${r.id}"><span>${r.name}</span></button></td>` +
      `<td><label class="toggle-switch"><input type="checkbox" class="rule-enabled-toggle" data-id="${r.id}"${r.enabled ? " checked" : ""}>` +
      '<span class="toggle-slider"></span></label></td></tr>').join("");
    win._wireRulesTable(tbody);
  };
  return { win, tbody, paint, menus, updates };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
}

describe("Automations list — delegated row controls", () => {
  it("no longer re-binds per row inside renderRules", () => {
    const render = innerFn("  function renderRules(");
    expect(render).not.toMatch(/querySelectorAll\("\.rule-(enabled-toggle|menu)"\)\.forEach/);
    expect(render).toContain("_wireRulesTable(tbody)");
  });

  it("opens the menu of a row painted after binding, anchored on the name button, once per click across repaints", () => {
    const { win, tbody, paint, menus } = boot(true);
    paint();
    paint();
    paint();
    const name = tbody.querySelector('.rule-menu[data-id="r2"] span')!;
    name.dispatchEvent(new win.MouseEvent("click", { bubbles: true }) as unknown as Event);
    expect(menus).toHaveLength(1);
    expect(menus[0].anchor).toBe(tbody.querySelector('.rule-menu[data-id="r2"]'));
    expect(menus[0].labels).toEqual(["Edit", "Clone", "Export", "Delete"]);
    expect(tbody.dataset.rulesWired).toBe("1");
  });

  it("gives a read-only role the View menu", () => {
    const { win, tbody, paint, menus } = boot(false);
    paint();
    (tbody.querySelector(".rule-menu") as HTMLElement).dispatchEvent(new win.MouseEvent("click", { bubbles: true }) as unknown as Event);
    expect(menus.map((m) => m.labels)).toEqual([["View", "Export"]]);
  });

  it("saves a switch flipped on a repainted row exactly once", async () => {
    const { win, tbody, paint, updates } = boot(true);
    paint();
    paint();
    const cb = tbody.querySelector('.rule-enabled-toggle[data-id="r2"]') as HTMLInputElement;
    cb.checked = true;
    cb.dispatchEvent(new win.Event("change", { bubbles: true }) as unknown as Event);
    await settle();
    expect(updates).toEqual([["r2", true]]);
  });

  it("ignores clicks and changes that are not on a row control", async () => {
    const { win, tbody, paint, menus, updates } = boot(true);
    paint();
    const cell = tbody.querySelector("td:last-child") as HTMLElement;
    cell.dispatchEvent(new win.MouseEvent("click", { bubbles: true }) as unknown as Event);
    await settle();
    expect(menus).toEqual([]);
    expect(updates).toEqual([]);
  });
});
