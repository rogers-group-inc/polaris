/**
 * tests/unit/reservationNotesBudgetDom.test.ts — the browser half of the
 * FortiGate reservation-notes budget: the shared module
 * (public/js/reservation-notes.js) and the IP panel's counter that renders it.
 *
 * The counter is advisory — reservationPushService refuses an over-length save
 * regardless — but it is the only thing that tells an operator BEFORE they type
 * 300 characters into a field that will take 223 of them. Two things are pinned:
 * the budget shrinks as the hostname is typed (both are inside the same 255),
 * and the module's arithmetic matches the server's, which is asserted directly
 * against `reservationNotesBudget` so the two cannot drift apart silently.
 *
 * ip-panel.js is a browser script with no module boundary, so the functions
 * under test are sliced out by name and eval'd — the approach of
 * tests/unit/assetVipRowsDom.test.ts.
 *
 * @vitest-environment happy-dom
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { reservationNotesBudget } from "../../src/services/reservationPushService.js";

vi.mock("../../src/db.js", () => ({ prisma: {} }));

const g = globalThis as Record<string, any>;
const panelLines = readFileSync(resolve(__dirname, "../../public/js/ip-panel.js"), "utf8").split(/\r?\n/);

/** Slice a top-level `function NAME(...) {` … `}` block out of ip-panel.js. */
function fnSrc(name: string): string {
  const start = panelLines.findIndex((l) => l.startsWith(`function ${name}(`));
  if (start < 0) throw new Error(`ip-panel.js: function ${name} not found`);
  const end = panelLines.findIndex((l, i) => i > start && l === "}");
  if (end < 0) throw new Error(`ip-panel.js: no end of function ${name}`);
  return panelLines.slice(start, end + 1).join("\n");
}

let notesFieldMarkup: (opts: Record<string, unknown>) => string;
let wireNotesBudget: (pushEligible: boolean, createdBy: string | null) => void;

beforeEach(() => {
  // The shared module is a self-contained IIFE that installs
  // window.PolarisReservationNotes — load it the way the page does.
  const shared = readFileSync(resolve(__dirname, "../../public/js/reservation-notes.js"), "utf8");
  // eslint-disable-next-line no-eval
  (0, eval)(shared);
  g.escapeHtml = (s: string) => String(s ?? "");
  // eslint-disable-next-line no-eval
  notesFieldMarkup = (0, eval)(`(${fnSrc("_notesFieldMarkup")})`);
  // eslint-disable-next-line no-eval
  wireNotesBudget = (0, eval)(`(${fnSrc("_wireNotesBudget")})`);
  document.body.innerHTML = "";
});

/** Render the hostname field + the notes field, then wire the counter. */
function mount(opts: { pushEligible: boolean; hostname?: string; notes?: string; createdBy?: string | null }) {
  document.body.innerHTML =
    '<input id="f-hostname" value="' + (opts.hostname ?? "") + '">' +
    notesFieldMarkup({ pushEligible: opts.pushEligible, value: opts.notes ?? "" });
  wireNotesBudget(opts.pushEligible, opts.createdBy === undefined ? "dmoore" : opts.createdBy);
  return {
    notes: document.getElementById("f-notes") as HTMLTextAreaElement,
    hint: document.getElementById("f-notes-budget"),
    hostname: document.getElementById("f-hostname") as HTMLInputElement,
  };
}

describe("PolarisReservationNotes", () => {
  it("agrees with the server's budget, prefix for prefix", () => {
    const cases = [
      { hostname: "web-server-01", createdBy: "dmoore" },
      { hostname: "sw-01", createdBy: null },
      { hostname: "", createdBy: "a-very-long-service-account-name" },
      { hostname: "h".repeat(400), createdBy: "dmoore" },
    ];
    for (const c of cases) {
      expect(g.window.PolarisReservationNotes.budgetFor(c.hostname, c.createdBy)).toBe(
        reservationNotesBudget({ hostname: c.hostname, createdBy: c.createdBy, ip: "10.0.1.10" }),
      );
    }
  });

  it("caps at the device's 255", () => {
    expect(g.window.PolarisReservationNotes.MAX).toBe(255);
  });
});

describe("IP panel notes counter", () => {
  it("is absent on a network Polaris does not push to", () => {
    const el = mount({ pushEligible: false });
    expect(el.hint).toBeNull();
    expect(el.notes).not.toBeNull();
  });

  it("counts down from the budget as notes are typed", () => {
    const el = mount({ pushEligible: true, hostname: "web-server-01" });
    const budget = g.window.PolarisReservationNotes.budgetFor("web-server-01", "dmoore");
    expect(el.hint!.textContent).toContain(budget + " of " + budget + " characters left");

    el.notes.value = "rack 4 spare";
    el.notes.dispatchEvent(new Event("input"));
    expect(el.hint!.textContent).toContain(budget - 12 + " of " + budget + " characters left");
  });

  it("shrinks the budget as the hostname grows — they share the 255", () => {
    const el = mount({ pushEligible: true, hostname: "sw-01" });
    const before = g.window.PolarisReservationNotes.budgetFor("sw-01", "dmoore");
    el.hostname.value = "sw-01-building-c-idf-3";
    el.hostname.dispatchEvent(new Event("input"));
    const after = g.window.PolarisReservationNotes.budgetFor("sw-01-building-c-idf-3", "dmoore");
    expect(after).toBeLessThan(before);
    expect(el.hint!.textContent).toContain("of " + after + " characters left");
  });

  it("flags the over-length state the server would refuse", () => {
    const el = mount({ pushEligible: true, hostname: "web-server-01" });
    const budget = g.window.PolarisReservationNotes.budgetFor("web-server-01", "dmoore");
    el.notes.value = "n".repeat(budget + 7);
    el.notes.dispatchEvent(new Event("input"));
    expect(el.hint!.textContent).toContain("Too long for the FortiGate by 7 characters");
    expect(el.hint!.className).toContain("hint-error");
    expect(el.notes.className).toContain("input-error");
  });

  it("clears the flag when the note comes back under", () => {
    const el = mount({ pushEligible: true, hostname: "web-server-01" });
    const budget = g.window.PolarisReservationNotes.budgetFor("web-server-01", "dmoore");
    el.notes.value = "n".repeat(budget + 7);
    el.notes.dispatchEvent(new Event("input"));
    el.notes.value = "n".repeat(budget);
    el.notes.dispatchEvent(new Event("input"));
    expect(el.hint!.className).not.toContain("hint-error");
    expect(el.notes.className).not.toContain("input-error");
  });

  it("renders the stored note on an edit without re-counting it wrong", () => {
    const el = mount({ pushEligible: true, hostname: "web-server-01", notes: "existing note" });
    const budget = g.window.PolarisReservationNotes.budgetFor("web-server-01", "dmoore");
    expect(el.hint!.textContent).toContain(budget - "existing note".length + " of " + budget);
  });
});
