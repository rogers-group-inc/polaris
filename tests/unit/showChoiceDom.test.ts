/**
 * tests/unit/showChoiceDom.test.ts
 *
 * `showChoice` — the three-or-more-answer sibling of `showConfirm` in
 * public/js/app.js, first used by the asset form's duplicate-address dialog
 * (business rule 40(i)).
 *
 * What this pins, and why each matters:
 *
 *   1. It renders EVERY choice as a button in order and resolves the clicked
 *      choice's id. The dialog's whole reason to exist is a third answer that
 *      is not "no"; a chooser that lost or reordered choices would silently
 *      route an operator to the wrong path.
 *   2. Cancel resolves `null`, not `false` and not "" — the caller reads null
 *      as "write nothing", and a falsy-but-not-null value would be read as a
 *      choice by a sloppy `if (picked)`.
 *   3. Focus lands on the FIRST choice, and Enter does NOT auto-confirm the way
 *      showConfirm's does. With three answers there is no default an operator
 *      can be assumed to have read; a stray or held Enter must pick nothing by
 *      itself. (A deliberate Enter on the focused button still activates it,
 *      through the button's own click — that is the browser's behaviour, not
 *      this dialog's, and is not simulated here.)
 *   4. Choices without an id are dropped, and a `kind` maps to the button
 *      class the kit expects (`btn-primary` / `btn-secondary` / `btn-danger`).
 *
 * Harness: the function is lifted verbatim out of app.js by name (the same
 * technique the other DOM tests use for their subject), with the two focus
 * helpers it calls stubbed — the trap is exercised for its Escape callback
 * only, since the trap itself is app.js's own tested concern.
 *
 * @vitest-environment happy-dom
 */

import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// Normalized to LF: the working copy is CRLF on Windows checkouts, and the
// `\n}\n` end-of-function marker below would otherwise never match.
const appSrc = readFileSync(resolve(__dirname, "../../public/js/app.js"), "utf8").replace(/\r\n/g, "\n");

/** Slice one top-level `function <name>(` … `\n}` out of app.js. */
function fnSrc(name: string): string {
  const start = appSrc.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`function ${name} not found in app.js`);
  const end = appSrc.indexOf("\n}\n", start);
  return appSrc.slice(start, end + 3);
}

type EscapeCb = (() => void) | null;
let lastEscape: EscapeCb = null;

const g = globalThis as any;

beforeEach(() => {
  document.body.innerHTML = "";
  lastEscape = null;
  // `_trapFocus(dialog, onEscape)` returns a teardown. We keep the escape
  // callback so a test can fire it as the trap would on Escape/backdrop.
  g._trapFocus = (_dialog: Element, onEscape: () => void) => {
    lastEscape = onEscape;
    return () => {};
  };
  g._focusFirstIn = () => {};
  // rAF is what reveals the dialog; run it synchronously so the overlay is
  // `open` and focused by the time the test looks.
  g.requestAnimationFrame = (cb: () => void) => { cb(); return 0; };
  // eslint-disable-next-line no-new-func
  new Function(fnSrc("showChoice") + "\nglobalThis.showChoice = showChoice;")();
});

function buttons(): HTMLButtonElement[] {
  return Array.from(document.querySelectorAll<HTMLButtonElement>(".modal-footer button"));
}

describe("showChoice — rendering", () => {
  it("renders Cancel plus every choice, in order, with the kit's button classes", async () => {
    const p = g.showChoice("pick one", {
      title: "Address already in use",
      choices: [
        { id: "review", label: "Save & submit for conflict review", kind: "primary" },
        { id: "merge", label: "Save & review merge", kind: "secondary" },
        { id: "nuke", label: "Delete it", kind: "danger" },
      ],
    });
    const btns = buttons();
    expect(btns.map((b) => b.getAttribute("data-choice"))).toEqual(["cancel", "review", "merge", "nuke"]);
    expect(btns[0].textContent).toBe("Cancel");
    expect(btns[1].className).toContain("btn-primary");
    expect(btns[2].className).toContain("btn-secondary");
    expect(btns[3].className).toContain("btn-danger");
    expect(document.querySelector(".modal-header h3")!.textContent).toBe("Address already in use");
    expect(document.querySelector(".modal-body p")!.textContent).toBe("pick one");
    btns[1].click();
    await expect(p).resolves.toBe("review");
  });

  it("uses textContent for the message, so a hostname cannot inject markup", async () => {
    const p = g.showChoice('<img src=x onerror="1"> sw-01', { choices: [{ id: "a", label: "A" }] });
    expect(document.querySelector(".modal-body img")).toBeNull();
    expect(document.querySelector(".modal-body p")!.textContent).toContain("<img");
    buttons()[1].click();
    await p;
  });

  it("drops choices with no id and honours a custom cancel label", async () => {
    const p = g.showChoice("q", {
      cancelLabel: "Keep editing",
      choices: [{ label: "ghost" }, { id: "ok", label: "Fine" }],
    });
    const btns = buttons();
    expect(btns.map((b) => b.getAttribute("data-choice"))).toEqual(["cancel", "ok"]);
    expect(btns[0].textContent).toBe("Keep editing");
    btns[1].click();
    await expect(p).resolves.toBe("ok");
  });
});

describe("showChoice — resolving", () => {
  it("resolves the clicked choice's id as a string", async () => {
    const p = g.showChoice("q", { choices: [{ id: 1, label: "one" }, { id: "two", label: "two" }] });
    buttons()[2].click();
    await expect(p).resolves.toBe("two");
  });

  it("Cancel resolves null — not false, not an empty string", async () => {
    const p = g.showChoice("q", { choices: [{ id: "a", label: "A" }] });
    buttons()[0].click();
    const v = await p;
    expect(v).toBeNull();
  });

  it("Escape (the focus trap's callback) resolves null", async () => {
    const p = g.showChoice("q", { choices: [{ id: "a", label: "A" }] });
    expect(lastEscape).toBeTypeOf("function");
    lastEscape!();
    await expect(p).resolves.toBeNull();
  });

  it("settles once: a second answer after the first is ignored", async () => {
    const p = g.showChoice("q", { choices: [{ id: "a", label: "A" }, { id: "b", label: "B" }] });
    const btns = buttons();
    btns[1].click();
    btns[2].click();
    btns[0].click();
    await expect(p).resolves.toBe("a");
  });

  it("removes its overlay from the document after resolving", async () => {
    const p = g.showChoice("q", { choices: [{ id: "a", label: "A" }] });
    expect(document.querySelector(".modal-overlay")).not.toBeNull();
    buttons()[1].click();
    await p;
    // The transitionend path never fires in happy-dom; the 400 ms fallback does.
    await new Promise((r) => setTimeout(r, 450));
    expect(document.querySelector(".modal-overlay")).toBeNull();
  });
});

describe("showChoice — keyboard: no default answer", () => {
  it("focuses the FIRST choice on open, not Cancel and not the last", () => {
    g.showChoice("q", { choices: [{ id: "a", label: "A" }, { id: "b", label: "B" }] });
    expect(document.activeElement).toBe(buttons()[1]);
  });

  it("a plain Enter on the dialog picks nothing by itself", async () => {
    // showConfirm confirms on Enter; this deliberately does not. The promise
    // must still be pending after the key — we prove that by racing it.
    const p = g.showChoice("q", { choices: [{ id: "a", label: "A" }, { id: "b", label: "B" }] });
    const dialog = document.querySelector(".modal")!;
    dialog.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    const outcome = await Promise.race([p, new Promise((r) => setTimeout(() => r("pending"), 20))]);
    expect(outcome).toBe("pending");
    buttons()[0].click();
    await p;
  });

  it("a held (auto-repeating) Enter is swallowed with preventDefault", async () => {
    const p = g.showChoice("q", { choices: [{ id: "a", label: "A" }] });
    const dialog = document.querySelector(".modal")!;
    const ev = new KeyboardEvent("keydown", { key: "Enter", repeat: true, bubbles: true, cancelable: true });
    dialog.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
    buttons()[0].click();
    await p;
  });

  it("a non-repeating Enter is NOT prevented — the focused button's own activation may proceed", async () => {
    const p = g.showChoice("q", { choices: [{ id: "a", label: "A" }] });
    const dialog = document.querySelector(".modal")!;
    const ev = new KeyboardEvent("keydown", { key: "Enter", repeat: false, bubbles: true, cancelable: true });
    dialog.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(false);
    buttons()[0].click();
    await p;
  });
});
