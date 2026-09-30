/**
 * tests/unit/modalKeyboardNav.test.ts — the keyboard on the two dialog shapes
 * an operator meets most: the shared confirm (`showConfirm`) and a stepped
 * wizard footer (`wireModalStepKeys`), both in public/js/app.js.
 *
 * What is worth pinning here is the ARBITRATION, not that a key does something:
 *
 *  - Enter confirms the confirm dialog, EXCEPT on a Tabbed-to Cancel (that key
 *    belongs to the button the operator chose) and EXCEPT when it is an auto
 *    repeat — these dialogs open from row menus that are themselves activated
 *    with Enter, so the tail of that keypress must not clear an alert nobody
 *    has read.
 *  - On a wizard, Enter means NEXT while a Next button is on screen and only
 *    submits once it isn't. Enter that saved a half-filled six-step form would
 *    create automations whose later steps were never validated.
 *  - Arrows walk the steps, but not out of a text field or a select, where they
 *    are the caret and the option list.
 *
 * app.js is a classic browser script; eval into happy-dom reaches its globals.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Window } from "happy-dom";

vi.mock("../../src/db.js", () => ({ prisma: {} }));

const g = globalThis as Record<string, any>;
const APP_SRC = readFileSync(resolve(__dirname, "../../public/js/app.js"), "utf8");

let win: InstanceType<typeof Window>;
let doc: Window["document"];

beforeEach(() => {
  win = new Window();
  doc = win.document;
  g.window = win;
  g.document = doc;
  g.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
  g.fetch = () => Promise.reject(new Error("no network in this test"));
  g.showToast = () => {};
  g.api = {};
  g.escapeHtml = (s: unknown) => String(s ?? "");
  g.requestAnimationFrame = (cb: () => void) => { cb(); return 0; };
  doc.body.innerHTML = "";
  try { (0, eval)(APP_SRC); } catch (_e) { /* app.js boot wiring touches page-specific DOM */ }
});

/**
 * Dispatch a keydown from `el` — bubbling AND cancelable, as a real keypress
 * is. Cancelable matters: `preventDefault()` on a synthetic event that isn't
 * leaves `defaultPrevented` false, and the "a field handler already acted"
 * guard would test nothing.
 */
const key = (el: unknown, k: string, init: Record<string, unknown> = {}) =>
  (el as { dispatchEvent: (e: unknown) => void })
    .dispatchEvent(new win.KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...init }));
const q = (sel: string) => doc.querySelector(sel) as unknown as HTMLElement;
/** Let the promise callbacks run without waiting on the close transition. */
const tick = () => new Promise((r) => setTimeout(r, 0));

describe("showConfirm — Enter confirms, Escape cancels", () => {
  it("opens with the Confirm button focused, so the default action is visible", () => {
    g.showConfirm("Clear this alert?");
    expect((doc.activeElement as unknown as HTMLElement).getAttribute("data-confirm")).toBe("ok");
  });

  it("resolves TRUE on Enter", async () => {
    const p = g.showConfirm("Clear this alert?");
    key(q('[data-confirm="ok"]'), "Enter");
    await expect(p).resolves.toBe(true);
  });

  it("resolves FALSE on Escape", async () => {
    const p = g.showConfirm("Clear this alert?");
    key(doc, "Escape");
    await expect(p).resolves.toBe(false);
  });

  it("leaves Enter to a Tabbed-to Cancel button", async () => {
    let settled = false;
    const p = g.showConfirm("Clear this alert?").then((v: boolean) => { settled = true; return v; });
    key(q('[data-confirm="cancel"]'), "Enter");
    await tick();
    expect(settled, "Enter on Cancel is that button's own activation, not a confirm").toBe(false);
    (q('[data-confirm="cancel"]') as unknown as { click: () => void }).click();
    await expect(p).resolves.toBe(false);
  });

  it("swallows an auto-repeating Enter — the row menu's own keypress, still held", async () => {
    let settled = false;
    const p = g.showConfirm("Clear this alert?").then((v: boolean) => { settled = true; return v; });
    key(q('[data-confirm="ok"]'), "Enter", { repeat: true });
    await tick();
    expect(settled, "a held Enter must not confirm a destructive act").toBe(false);
    // A deliberate press still works.
    key(q('[data-confirm="ok"]'), "Enter");
    await expect(p).resolves.toBe(true);
  });

  it("resolves once, whichever way it is dismissed", async () => {
    const seen: unknown[] = [];
    g.showConfirm("Clear this alert?").then((v: unknown) => seen.push(v));
    key(q('[data-confirm="ok"]'), "Enter");
    (q('[data-confirm="ok"]') as unknown as { click: () => void }).click();
    key(doc, "Escape");
    await tick();
    expect(seen).toEqual([true]);
  });
});

/** The shared modal as a wizard renders it: a stepper footer + step panels. */
function mountWizard(opts: { step?: number; last?: number; editing?: boolean } = {}) {
  const step = opts.step ?? 1;
  const last = opts.last ?? 3;
  const showSave = opts.editing || step === last;
  doc.body.innerHTML =
    '<div id="modal-overlay" class="modal-overlay open"><div class="modal">' +
      '<div class="modal-body">' +
        [1, 2, 3].map((n) =>
          '<div class="step-panel' + (n === step ? " visible" : "") + '" id="w-step-' + n + '">' +
            '<input id="w-field-' + n + '"><textarea id="w-note-' + n + '"></textarea>' +
            '<select id="w-pick-' + n + '"><option>a</option></select>' +
          "</div>").join("") +
      "</div>" +
      '<div class="modal-footer">' +
        '<button id="w-cancel">Cancel</button>' +
        '<button id="w-back" style="display:' + (step > 1 ? "" : "none") + '">Back</button>' +
        '<button id="w-next" style="display:' + (step < last ? "" : "none") + '">Next</button>' +
        '<button id="w-save" style="display:' + (showSave ? "" : "none") + '">Save</button>' +
      "</div>" +
    "</div></div>";
  const clicked: string[] = [];
  ["w-back", "w-next", "w-save", "w-cancel"].forEach((id) => {
    doc.getElementById(id)!.addEventListener("click", () => clicked.push(id));
  });
  g.wireModalStepKeys({ back: "w-back", next: "w-next", submit: "w-save" });
  return { clicked, panel: () => q(".step-panel.visible").id };
}

describe("wireModalStepKeys — arrows walk the steps", () => {
  it("→ clicks Next, ← clicks Back", () => {
    const w = mountWizard({ step: 2 });
    key(q("#w-step-2"), "ArrowRight");
    key(q("#w-step-2"), "ArrowLeft");
    expect(w.clicked).toEqual(["w-next", "w-back"]);
  });

  it("does nothing when that direction's button is off screen", () => {
    const first = mountWizard({ step: 1 });
    key(q("#w-step-1"), "ArrowLeft");
    expect(first.clicked, "step 1 hides Back").toEqual([]);
    const last = mountWizard({ step: 3 });
    key(q("#w-step-3"), "ArrowRight");
    expect(last.clicked, "the last step hides Next").toEqual([]);
  });

  it("leaves the arrows to the caret in a text field and to a select's options", () => {
    const w = mountWizard({ step: 2 });
    key(q("#w-field-2"), "ArrowRight");
    key(q("#w-note-2"), "ArrowLeft");
    key(q("#w-pick-2"), "ArrowRight");
    expect(w.clicked).toEqual([]);
  });

  it("ignores a disabled Next", () => {
    const w = mountWizard({ step: 2 });
    (q("#w-next") as unknown as { disabled: boolean }).disabled = true;
    key(q("#w-step-2"), "ArrowRight");
    expect(w.clicked).toEqual([]);
  });
});

describe("wireModalStepKeys — Enter advances until the last step", () => {
  it("clicks Next, not the submit, while Next is showing", () => {
    const w = mountWizard({ step: 1 });
    key(q("#w-step-1"), "Enter");
    expect(w.clicked).toEqual(["w-next"]);
  });

  it("still prefers Next when editing puts Save on every step", () => {
    // Editing an automation shows Save from step 1, so "the primary button" is
    // ambiguous by look alone — Enter has to mean the walk, or an edit becomes
    // unwalkable from the keyboard.
    const w = mountWizard({ step: 2, editing: true });
    key(q("#w-step-2"), "Enter");
    expect(w.clicked).toEqual(["w-next"]);
  });

  it("submits on the last step, where Next is gone", () => {
    const w = mountWizard({ step: 3 });
    key(q("#w-step-3"), "Enter");
    expect(w.clicked).toEqual(["w-save"]);
  });

  it("advances from a text INPUT — Enter in a wizard field means next", () => {
    const w = mountWizard({ step: 1 });
    key(q("#w-field-1"), "Enter");
    expect(w.clicked).toEqual(["w-next"]);
  });

  it("leaves Enter in a TEXTAREA to the newline", () => {
    const w = mountWizard({ step: 1 });
    key(q("#w-note-1"), "Enter");
    expect(w.clicked).toEqual([]);
  });

  it("leaves Enter on a focused button to that button", () => {
    // Tab to Back, press Enter, go back — not forward.
    const w = mountWizard({ step: 2 });
    key(q("#w-back"), "Enter");
    expect(w.clicked, "the browser activates the focused button itself").toEqual([]);
  });

  it("stands aside for a field handler that already acted", () => {
    // Both wizard typeaheads preventDefault on Enter while a suggestion is
    // highlighted; that Enter picks the suggestion and nothing else.
    const w = mountWizard({ step: 1 });
    q("#w-field-1").addEventListener("keydown", (e: unknown) => {
      (e as { preventDefault: () => void }).preventDefault();
    });
    key(q("#w-field-1"), "Enter");
    expect(w.clicked).toEqual([]);
  });

  it("swallows an auto-repeating Enter", () => {
    const w = mountWizard({ step: 1 });
    key(q("#w-field-1"), "Enter", { repeat: true });
    expect(w.clicked).toEqual([]);
  });

  it("ignores Enter with a modifier held", () => {
    const w = mountWizard({ step: 1 });
    key(q("#w-step-1"), "Enter", { ctrlKey: true });
    key(q("#w-step-1"), "Enter", { metaKey: true });
    key(q("#w-step-1"), "Enter", { shiftKey: true });
    key(q("#w-step-1"), "Enter", { altKey: true });
    expect(w.clicked).toEqual([]);
  });
});

describe("wireModalStepKeys — scope", () => {
  it("ignores keys from a dialog stacked OVER the wizard", () => {
    // showConfirm, the address book and the code editor each build their own
    // overlay; their Enter is theirs.
    const w = mountWizard({ step: 1 });
    const stacked = doc.createElement("div");
    stacked.className = "modal-overlay open";
    stacked.innerHTML = '<div class="modal"><input id="stacked-field"></div>';
    doc.body.appendChild(stacked);
    key(q("#stacked-field"), "Enter");
    key(q("#stacked-field"), "ArrowRight");
    expect(w.clicked).toEqual([]);
  });

  it("stops listening once the modal closes, so the next dialog is unaffected", () => {
    const w = mountWizard({ step: 1 });
    g.closeModal();
    key(q("#w-step-1"), "Enter");
    key(q("#w-step-1"), "ArrowRight");
    expect(w.clicked).toEqual([]);
  });

  it("keeps only the newest wizard's keys when a modal is reopened", () => {
    const first = mountWizard({ step: 1 });
    const firstNext = q("#w-next");
    const second = mountWizard({ step: 1 });
    key(q("#w-step-1"), "Enter");
    expect(second.clicked).toEqual(["w-next"]);
    expect(firstNext.isConnected, "the first footer went with the re-render").toBe(false);
    expect(first.clicked).toEqual([]);
  });
});
