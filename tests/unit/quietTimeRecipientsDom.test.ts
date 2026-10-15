/**
 * tests/unit/quietTimeRecipientsDom.test.ts — the Recipient exceptions button
 * and stacked modal of the shared quiet-time editor (business rule 120,
 * public/js/quiet-time-editor.js).
 *
 * The list lives on the editor's host, not in its DOM, so what is pinned here
 * is the round trip: a stored list renders on the button, survives a collect
 * untouched (the wizard-collector-strips trap — a field with no editor is
 * deleted on save), and the modal's Save writes exactly what its rows say,
 * in the shape `quietTimeConfigSchema` accepts. The REAL `buildOverlay` is
 * sliced out of app.js so the modal's structure is not a stub's.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Window } from "happy-dom";
import { quietTimeConfigSchema } from "../../src/utils/quietTime.js";
import { fixSelects } from "../fixtures/happyDomSelects.js";
import { installAppOverlay } from "../fixtures/appOverlay.js";

type AnyFn = (...a: any[]) => any;
interface QTE { html: AnyFn; wire: AnyFn; collect: AnyFn; summary: AnyFn; describeRecipients: AnyFn }

const g = globalThis as Record<string, unknown>;
let doc: Window["document"];
let qte: QTE;

beforeAll(() => {
  const win = new Window();
  g.window = win;
  g.document = win.document;
  doc = win.document;
  g.escapeHtml = (s: unknown) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  g._trapFocus = () => () => {};
  g._focusFirstIn = () => {};
  g.requestAnimationFrame = (fn: () => void) => setTimeout(fn, 0);
  installAppOverlay();
  (0, eval)(readFileSync(resolve(__dirname, "../../public/js/recurrence-editor.js"), "utf8"));
  (0, eval)(readFileSync(resolve(__dirname, "../../public/js/quiet-time-editor.js"), "utf8"));
  qte = (win as unknown as { PolarisQuietTimeEditor: QTE }).PolarisQuietTimeEditor;
});

const META = {
  severities: ["notice", "informational", "warning", "serious", "critical"],
  channels: [{ id: "c1", name: "NOC mail", type: "smtp", enabled: true }],
  serverClock: { timeZone: "America/Chicago", offsetMinutes: -300 },
};
const WIN = [{ version: 1, kind: "recurring", freq: "daily", hours: [{ startTime: "22:00", endTime: "06:00" }] }];
const CRIT_ALL = { alerts: true, alertReminders: true, escalations: true, escalationReminders: true };

function mount(cfg: unknown, meta: Record<string, unknown> = META): Element {
  const host = doc.createElement("div");
  host.innerHTML = qte.html("q", cfg, meta);
  doc.body.appendChild(host);
  fixSelects(host);
  const root = host.querySelector(".qte")!;
  qte.wire(root, cfg, null);
  return root;
}

function click(el: Element | null): void { (el as unknown as { click: () => void }).click(); }
function topModal(): Element { const all = doc.querySelectorAll(".modal-overlay"); return all[all.length - 1]!; }

describe("quiet-time editor — recipient exceptions (rule 120)", () => {
  it("names the stored exceptions on the button and keeps them through a collect", () => {
    const recipients = [{ address: "noc@example.com", held: {} }, { address: "lead@example.com", held: { critical: CRIT_ALL } }];
    const root = mount({ windows: WIN, recipients });
    expect(root.querySelector(".qte-recipients-btn")!.textContent).toBe("Recipient exceptions (2)…");
    expect(root.querySelector(".qte-recipients-summary")!.textContent)
      .toBe("noc@example.com (hears everything live) · lead@example.com (holds critical: everything)");
    const got = qte.collect(root);
    expect(got.config.recipients).toEqual(recipients);
    expect(quietTimeConfigSchema.safeParse(got.config).success).toBe(true);
  });

  it("writes no recipients key when there are none", () => {
    const root = mount({ windows: WIN });
    expect(root.querySelector(".qte-recipients-btn")!.textContent).toBe("Recipient exceptions…");
    expect("recipients" in qte.collect(root).config).toBe(false);
  });

  it("renders on the global wizard's host too, which hides the policy's own tree", () => {
    const root = mount({ windows: WIN, recipients: [{ address: "a@example.com", held: {} }] }, { ...META, showSeverities: false, held: {} });
    expect(root.querySelector(".qte-recipients-btn")).not.toBeNull();
    expect(qte.collect(root, { held: null, severities: null }).config.recipients).toEqual([{ address: "a@example.com", held: {} }]);
  });

  it("the modal adds a row that starts all unticked and saves it as hears-everything", () => {
    const root = mount({ windows: WIN });
    click(root.querySelector(".qte-recipients-btn"));
    const modal = topModal();
    expect(modal.querySelector("h3")!.textContent).toBe("Recipient exceptions");
    expect((modal as HTMLElement).style.zIndex).toBe("1300");
    click(modal.querySelector(".qte-rx-add"));
    const row = modal.querySelector(".qte-rx-row")!;
    expect(row.querySelectorAll(".qte-sev:checked").length).toBe(0);
    (row.querySelector(".qte-rx-address") as HTMLInputElement).value = "  OnCall@Example.com ";
    click(modal.querySelector(".qte-rx-save"));
    expect(qte.collect(root).config.recipients).toEqual([{ address: "oncall@example.com", held: {} }]);
    expect(root.querySelector(".qte-recipients-btn")!.textContent).toBe("Recipient exceptions (1)…");
  });

  it("a ticked severity in the modal is saved as that address's held map", () => {
    const root = mount({ windows: WIN, recipients: [{ address: "lead@example.com", held: {} }] });
    click(root.querySelector(".qte-recipients-btn"));
    const modal = topModal();
    const sev = modal.querySelector('.qte-sevrow[data-sev="critical"] .qte-sev') as HTMLInputElement;
    sev.checked = true;
    sev.dispatchEvent(new (g.window as any).Event("change", { bubbles: true }));
    click(modal.querySelector(".qte-rx-save"));
    expect(qte.collect(root).config.recipients).toEqual([{ address: "lead@example.com", held: { critical: CRIT_ALL } }]);
  });

  it("refuses a bad address and a duplicate, and Cancel leaves the list alone", () => {
    const root = mount({ windows: WIN, recipients: [{ address: "a@example.com", held: {} }] });
    click(root.querySelector(".qte-recipients-btn"));
    let modal = topModal();
    click(modal.querySelector(".qte-rx-add"));
    const inputs = modal.querySelectorAll(".qte-rx-address");
    (inputs[1] as HTMLInputElement).value = "not-an-address";
    click(modal.querySelector(".qte-rx-save"));
    expect(modal.querySelector(".qte-rx-problem")!.textContent).toMatch(/not an email address/);
    (inputs[1] as HTMLInputElement).value = "A@example.com";
    click(modal.querySelector(".qte-rx-save"));
    expect(modal.querySelector(".qte-rx-problem")!.textContent).toMatch(/listed twice/);
    click(modal.querySelector(".qte-rx-cancel"));
    expect(qte.collect(root).config.recipients).toEqual([{ address: "a@example.com", held: {} }]);

    // Remove, then save: the list empties and the key goes away.
    click(root.querySelector(".qte-recipients-btn"));
    modal = topModal();
    click(modal.querySelector(".qte-rx-remove"));
    click(modal.querySelector(".qte-rx-save"));
    expect("recipients" in qte.collect(root).config).toBe(false);
  });

  it("an automation's scope limits the severities each row offers", () => {
    const root = mount({ windows: WIN }, { ...META, scope: { critical: CRIT_ALL } });
    click(root.querySelector(".qte-recipients-btn"));
    const modal = topModal();
    click(modal.querySelector(".qte-rx-add"));
    const sevs = Array.from(modal.querySelectorAll(".qte-rx-row .qte-sevrow")).map((r) => r.getAttribute("data-sev"));
    expect(sevs).toEqual(["critical"]);
    click(modal.querySelector(".qte-rx-cancel"));
  });

  it("the one-line summary counts the exceptions", () => {
    expect(qte.summary({ windows: WIN, recipients: [{ address: "a@example.com", held: {} }] }))
      .toBe("Daily 22:00–06:00 · holds everything for every severity · summary when it ends · 1 recipient exception");
  });
});
