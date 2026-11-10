/**
 * tests/unit/showPrompt.test.ts — the text-input dialog (`showPrompt` in
 * public/js/app.js) that replaced `window.prompt`.
 *
 * The contract that matters is **null vs ""**: cancelling resolves `null`,
 * submitting a blank optional field resolves `""`. Every caller branches on
 * exactly that to decide whether to act at all — `quarantineAssetRow` pushes a
 * MAC block to every FortiGate that has seen a device, so collapsing the two
 * would turn "I changed my mind" into "quarantine it, no reason given". That is
 * also why window.prompt's semantics were copied rather than improved on.
 *
 * app.js is a classic browser script; showPrompt is assigned onto `window`, so
 * an eval into happy-dom reaches it.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Window } from "happy-dom";
import { appSource } from "./_appSource.js";

vi.mock("../../src/db.js", () => ({ prisma: {} }));

const g = globalThis as Record<string, unknown>;
// The page order: the shared theme engine (theme-core.js) runs before app.js.
const APP_SRC =
  readFileSync(resolve(__dirname, "../../public/js/theme-core.js"), "utf8") + "\n" +
  appSource();

interface PromptOpts {
  title?: string; label?: string; placeholder?: string; value?: string;
  okLabel?: string; danger?: boolean; required?: boolean; multiline?: boolean;
  maxLength?: number; help?: string; requiredMessage?: string;
}

let win: InstanceType<typeof Window>;
let doc: Window["document"];
let showPrompt: (message: string, opts?: PromptOpts) => Promise<string | null>;

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
  try { (0, eval)(APP_SRC); } catch { /* app.js boot wiring touches page-specific DOM */ }
  showPrompt = (win as unknown as { showPrompt: typeof showPrompt }).showPrompt;
  expect(typeof showPrompt, "app.js no longer exports showPrompt").toBe("function");
});

const dialog = () => doc.querySelector(".modal-overlay .modal");
const input = () => doc.querySelector("#prompt-input") as unknown as
  { value: string; placeholder: string; maxLength: number; classList: { contains: (c: string) => boolean }; dispatchEvent: (e: unknown) => void; tagName: string };
const click = (sel: string) => (doc.querySelector(sel) as unknown as { click: () => void }).click();
/** Let the promise callbacks run without waiting on the close transition. */
const tick = () => new Promise((r) => setTimeout(r, 0));

describe("showPrompt — the null vs empty-string contract", () => {
  it("resolves the typed value on OK", async () => {
    const p = showPrompt("msg");
    input().value = "malware alert";
    click('[data-prompt="ok"]');
    await expect(p).resolves.toBe("malware alert");
  });

  it("resolves an EMPTY STRING when an optional field is submitted blank", async () => {
    // Not null: the operator did choose to proceed, just without a reason.
    const p = showPrompt("msg");
    click('[data-prompt="ok"]');
    await expect(p).resolves.toBe("");
  });

  it("resolves NULL on Cancel", async () => {
    const p = showPrompt("msg");
    input().value = "typed then cancelled";
    click('[data-prompt="cancel"]');
    await expect(p).resolves.toBeNull();
  });

  it("resolves NULL on Escape, never an empty string", async () => {
    const p = showPrompt("msg");
    doc.dispatchEvent(new win.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await expect(p).resolves.toBeNull();
  });

  it("trims surrounding whitespace, so a space-only entry is blank not a reason", async () => {
    const p = showPrompt("msg");
    input().value = "   ";
    click('[data-prompt="ok"]');
    await expect(p).resolves.toBe("");
  });
});

describe("showPrompt — required fields", () => {
  it("does not resolve on a blank required field, and flags it", async () => {
    let settled = false;
    const p = showPrompt("msg", { required: true }).then((v) => { settled = true; return v; });
    click('[data-prompt="ok"]');
    await tick();
    expect(settled, "a blank required field is a correction, not a submit").toBe(false);
    expect(input().classList.contains("input-error")).toBe(true);
    // Still cancellable, and still resolves null when it is.
    click('[data-prompt="cancel"]');
    await expect(p).resolves.toBeNull();
  });

  it("SAYS why a blank required field didn't submit", async () => {
    // A red border alone reads as a button that did nothing, which is how
    // "I clicked Acknowledge and nothing happened" starts.
    const p = showPrompt("msg", { required: true, requiredMessage: "A note is required." });
    click('[data-prompt="ok"]');
    const err = doc.querySelector(".prompt-error") as unknown as { textContent: string; style: { display: string } };
    expect(err.textContent).toBe("A note is required.");
    expect(err.style.display).toBe("");
    // …and it goes away as soon as they type.
    input().value = "bad optic";
    input().dispatchEvent(new win.Event("input", { bubbles: true }));
    expect(err.style.display).toBe("none");
    click('[data-prompt="ok"]');
    await expect(p).resolves.toBe("bad optic");
  });

  it("falls back to a generic reason when the caller supplies none", async () => {
    showPrompt("msg", { required: true });
    click('[data-prompt="ok"]');
    const err = doc.querySelector(".prompt-error") as unknown as { textContent: string };
    expect(err.textContent.length).toBeGreaterThan(0);
    click('[data-prompt="cancel"]');
  });

  it("shows no reason before a blank submit", () => {
    showPrompt("msg", { required: true });
    const err = doc.querySelector(".prompt-error") as unknown as { style: { display: string } };
    expect(err.style.display).toBe("none");
    click('[data-prompt="cancel"]');
  });

  it("clears the error flag on the next keystroke", async () => {
    const p = showPrompt("msg", { required: true });
    click('[data-prompt="ok"]');
    expect(input().classList.contains("input-error")).toBe(true);
    input().value = "x";
    input().dispatchEvent(new win.Event("input", { bubbles: true }));
    expect(input().classList.contains("input-error")).toBe(false);
    click('[data-prompt="ok"]');
    await expect(p).resolves.toBe("x");
  });
});

describe("showPrompt — keyboard", () => {
  it("Enter submits a single-line field", async () => {
    const p = showPrompt("msg");
    input().value = "via enter";
    input().dispatchEvent(new win.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await expect(p).resolves.toBe("via enter");
  });

  it("Enter does NOT submit a multiline field — it types a newline", async () => {
    let settled = false;
    const p = showPrompt("msg", { multiline: true }).then((v) => { settled = true; return v; });
    input().value = "line one";
    input().dispatchEvent(new win.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await tick();
    expect(settled).toBe(false);
    click('[data-prompt="ok"]');
    await expect(p).resolves.toBe("line one");
  });
});

describe("showPrompt — rendering", () => {
  it("renders a textarea when multiline, an input otherwise", () => {
    showPrompt("msg", { multiline: true });
    expect(input().tagName).toBe("TEXTAREA");
    doc.body.innerHTML = "";
    showPrompt("msg");
    expect(input().tagName).toBe("INPUT");
  });

  it("applies title, label, placeholder, help, value and maxLength", () => {
    showPrompt("the message", {
      title: "Quarantine asset", label: "Reason (optional)", placeholder: "e.g. SIEM",
      help: "Recorded on the audit Event.", value: "seed", maxLength: 500,
    });
    expect(doc.querySelector(".modal-header h3")!.textContent).toBe("Quarantine asset");
    expect(doc.querySelector(".prompt-message")!.textContent).toBe("the message");
    expect(doc.querySelector(".prompt-label")!.textContent).toBe("Reason (optional)");
    expect(doc.querySelector(".prompt-help")!.textContent).toBe("Recorded on the audit Event.");
    expect(input().placeholder).toBe("e.g. SIEM");
    expect(input().value).toBe("seed");
    expect(input().maxLength).toBe(500);
  });

  it("treats caller copy as TEXT, not markup", () => {
    // Callers interpolate discovery-sourced strings (hostnames) into these.
    showPrompt('<img src=x onerror="boom">', { title: "<b>t</b>", label: "<i>l</i>" });
    expect(doc.querySelector(".prompt-message")!.querySelector("img")).toBeNull();
    expect(doc.querySelector(".modal-header h3")!.querySelector("b")).toBeNull();
    expect(doc.querySelector(".prompt-label")!.querySelector("i")).toBeNull();
  });

  it("styles the confirm button by danger", () => {
    showPrompt("msg", { danger: true, okLabel: "Quarantine" });
    const ok = doc.querySelector('[data-prompt="ok"]')!;
    expect(ok.classList.contains("btn-danger")).toBe(true);
    expect(ok.textContent).toBe("Quarantine");
    doc.body.innerHTML = "";
    showPrompt("msg");
    expect(doc.querySelector('[data-prompt="ok"]')!.classList.contains("btn-primary")).toBe(true);
  });

  it("hides the message, label and help rows when not supplied", () => {
    showPrompt("");
    const styleOf = (sel: string) => (doc.querySelector(sel) as unknown as { style: { display: string } }).style.display;
    expect(styleOf(".prompt-message")).toBe("none");
    expect(styleOf(".prompt-label")).toBe("none");
    expect(styleOf(".prompt-help")).toBe("none");
  });

  it("builds its OWN overlay rather than reusing the shared #modal-overlay", () => {
    // openModal overwrites one shared overlay's innerHTML, so reusing it would
    // destroy the form DOM of whatever modal is already open underneath.
    showPrompt("msg");
    const overlay = doc.querySelector(".modal-overlay") as unknown as { id: string; style: { zIndex: string } };
    expect(overlay.id).not.toBe("modal-overlay");
    expect(overlay.style.zIndex).toBe("1300");
    expect(dialog()!.getAttribute("aria-modal")).toBe("true");
  });

  it("removes the overlay once resolved", async () => {
    const p = showPrompt("msg");
    click('[data-prompt="ok"]');
    await p;
    await new Promise((r) => setTimeout(r, 450)); // past the removal fallback
    expect(doc.querySelector(".modal-overlay")).toBeNull();
  });
});
