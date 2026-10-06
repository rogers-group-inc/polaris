/**
 * tests/unit/quietTimeSettingsDom.test.ts — the Automations page's Settings
 * modal (public/js/automations-settings.js) and the global quiet-time wizard
 * it opens (public/js/quiet-time-wizard.js), business rule 92.
 *
 * Both are plain browser scripts, so this loads them into a happy-dom Window
 * with the app-shell globals stubbed the way automationsWizardDom.test.ts
 * does, and the REAL schema catalogue, then drives: Settings → Global Quiet
 * Times lists what the API returns; "+ New quiet time" replaces the modal with
 * the wizard; the wizard walks its five steps and posts a body the server's
 * own schemas accept; Cancel hands control back (onDone) so the Settings
 * modal returns. The regression this nets is the one the alert-groups editor
 * shipped with: a public/ module calling an app.js helper with a signature it
 * does not have, which nothing but a browser — or this — would catch.
 */

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Window } from "happy-dom";
import { buildSchemaCatalog, scopeSchema } from "../../src/services/notificationTypes.js";
import { quietTimeConfigSchema } from "../../src/utils/quietTime.js";
import { installAppOverlay } from "../fixtures/appOverlay.js";

const g = globalThis as Record<string, unknown>;
let doc: Window["document"];
let toasts: { msg: string; kind: string }[];
const posted: Record<string, unknown>[] = [];
const put: { id: string; body: Record<string, unknown> }[] = [];
let schedules: Record<string, unknown>[] = [];
let modalCloses = 0;

const NIGHTLY = { version: 1, kind: "recurring", freq: "daily", hours: [{ startTime: "22:00", endTime: "06:00" }] };

beforeAll(() => {
  const win = new Window();
  doc = win.document;
  g.window = win;
  g.document = doc;
  toasts = [];
  g.escapeHtml = (s: unknown) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  g.showToast = (msg: string, kind: string) => { toasts.push({ msg, kind }); };
  g.showConfirm = async () => true;
  g.permAtLeast = () => true;
  g.wireModalStepKeys = () => {};
  g.closeModal = () => { modalCloses++; const o = doc.getElementById("modal-overlay"); if (o) o.remove(); };
  // ONE shared overlay, reused — the contract the wizard's "replace and
  // reopen" dance depends on.
  g.openModal = (title: string, body: string, footer: string) => {
    let overlay = doc.getElementById("modal-overlay");
    if (!overlay) {
      overlay = doc.createElement("div");
      overlay.id = "modal-overlay";
      overlay.innerHTML = '<div class="modal"><div class="modal-header"><h3></h3></div><div class="modal-body"></div><div class="modal-footer"></div></div>';
      doc.body.appendChild(overlay);
    }
    overlay.querySelector(".modal-header h3")!.textContent = title;
    overlay.querySelector(".modal-body")!.innerHTML = body;
    overlay.querySelector(".modal-footer")!.innerHTML = footer;
  };
  // The canonical tab-strip pair, as app.js defines them.
  g.tabbedBodyHTML = (prefix: string, tabs: { key: string; label: string; html: string }[]) =>
    '<div class="page-tabs" id="' + prefix + '-tabs">' +
    tabs.map((t, i) => '<button type="button" class="page-tab' + (i === 0 ? " active" : "") + '" data-tab="' + t.key + '">' + t.label + "</button>").join("") +
    "</div>" +
    tabs.map((t, i) => '<div class="page-tab-panel' + (i === 0 ? " active" : "") + '" id="' + prefix + "-tab-" + t.key + '">' + t.html + "</div>").join("");
  g.wireModalTabs = () => {};
  g.api = {
    quietTimes: {
      list: async () => ({ schedules }),
      summaries: async () => ({ summaries: [
        { id: "s1", sourceKind: "global", sourceName: "Nights", coveredFrom: "2026-10-02T22:00:00Z", coveredTo: "2026-10-03T06:00:00Z", notificationIds: ["n1", "n2"], listedCount: 1, recurringCount: 0, recipients: [{ address: "a@x.com", status: "sent" }], status: "sent", createdAt: "2026-10-03T06:00:00Z", sentAt: "2026-10-03T06:00:05Z" },
      ] }),
      summary: async (id: string) => ({
        summary: { id, sourceKind: "global", sourceName: "Nights", coveredFrom: "2026-10-02T22:00:00Z", coveredTo: "2026-10-03T06:00:00Z", notificationIds: ["n1", "n2"], listedCount: 1, recurringCount: 0, details: { outstanding: [], recurring: [] }, recipients: [{ address: "a@x.com", status: "sent", attempts: 1 }, { address: "b@x.com", userId: "u2", status: "failed", attempts: 10, error: "smtp down" }], status: "partial-failed" },
        covered: [
          { id: "n1", assetId: "a1", assetHostname: "sw-1", severity: "serious", message: "port12 is down", dimension: "port12", triggeredAt: "2026-10-03T02:00:00Z", cleared: false, acknowledged: false, ruleName: "Port down", listed: true },
          { id: "n2", assetId: "a2", assetHostname: "ap-7", severity: "warning", message: "AP flapping", dimension: null, triggeredAt: "2026-10-03T03:00:00Z", cleared: true, clearedAt: "2026-10-03T03:30:00Z", acknowledged: false, ruleName: "AP flap", listed: false },
        ],
        listed: {
          outstanding: [{ notificationId: "n1", severity: "serious", assetId: "a1", assetHostname: "sw-1", ruleName: "Port down", message: "port12 is down", dimension: "port12", triggeredAt: "2026-10-03T02:00:00Z" }],
          recurring: [{ assetId: "a2", assetHostname: "ap-7", ruleName: "AP flap", dimension: null, severity: "warning", count: 3, times: ["2026-10-03T01:00:00Z", "2026-10-03T02:00:00Z", "2026-10-03T03:00:00Z"], stillActive: false }],
          recurrenceThreshold: 2,
        },
      }),
      create: async (body: Record<string, unknown>) => { posted.push(body); return { id: "new" }; },
      update: async (id: string, body: Record<string, unknown>) => { put.push({ id, body }); return { id }; },
      delete: async () => {},
    },
    automations: {
      schema: async () => buildSchemaCatalog(),
      scopeOptions: async () => ({ manufacturers: [], models: [], subnets: [] }),
      preview: async () => ({ totalEvaluated: 2, matches: [{ hostname: "sw-1" }] }),
    },
    assets: { tags: async () => ({ tags: ["prod"] }) },
    assetTypes: { list: async () => ({ types: [{ name: "switch", label: "Switch" }] }) },
    deliveryChannels: { list: async () => ({ channels: [{ id: "c1", name: "NOC mail", type: "smtp", enabled: true }] }) },
  };
  g._ruleSchema = null;
  for (const f of ["condition-builder.js", "scope-vocabulary.js", "recurrence-editor.js", "quiet-time-editor.js", "quiet-time-wizard.js", "automations-settings.js"]) {
    (0, eval)(readFileSync(resolve(__dirname, "../../public/js/" + f), "utf8"));
  }
});

beforeEach(() => {
  toasts.length = 0;
  posted.length = 0;
  put.length = 0;
  modalCloses = 0;
  schedules = [];
  const o = doc.getElementById("modal-overlay");
  if (o) o.remove();
});

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));
const click = (sel: string) => (doc.querySelector(sel) as unknown as { click: () => void }).click();
/** Pick one radio of a group. happy-dom does not uncheck the siblings the way
 *  a browser does, so the group is cleared by hand first. */
function pickRadio(sel: string): void {
  const input = doc.querySelector(sel) as unknown as { checked: boolean; name: string; dispatchEvent: (e: unknown) => void };
  doc.querySelectorAll('input[type="radio"][name="' + input.name + '"]').forEach((r) => { (r as unknown as { checked: boolean }).checked = false; });
  input.checked = true;
  input.dispatchEvent(new (g.window as Window).Event("change", { bubbles: true }));
}
const settings = () => (g.window as unknown as { PolarisAutomationSettings: { open: () => void } }).PolarisAutomationSettings;
const wizard = () => (g.window as unknown as { PolarisQuietTimeWizard: { open: (r: unknown, o?: unknown) => Promise<void> } }).PolarisQuietTimeWizard;

describe("the Settings modal", () => {
  it("opens with the Global Quiet Times tab, an empty state and a New button", async () => {
    settings().open();
    await tick();
    expect(doc.querySelector("#aqs-tabs .page-tab")!.textContent).toBe("Global Quiet Times");
    expect(doc.querySelector("#aqs-quiet")!.textContent).toContain("No global quiet times yet");
    expect(doc.querySelector("#aqs-new")).toBeTruthy();
    expect(doc.querySelector("#aqs-quiet")!.textContent).toContain("Recent summaries");
    expect(toasts).toEqual([]);
  });

  it("lists a schedule with its devices, alerts, window, summary and status", async () => {
    schedules = [{
      id: "g1", name: "Nights", enabled: true, scope: { allAssets: true },
      quiet: { windows: [NIGHTLY], severities: ["notice", "warning", "serious"], alertKinds: null, summaryAt: "07:30", recurrenceThreshold: 2 },
      inWindow: true, windowEnd: "2026-10-03T06:00", nextWindow: null, configValid: true, lastSummary: null,
    }];
    settings().open();
    await tick();
    const row = doc.querySelector("#aqs-quiet tbody tr")!;
    expect(row.textContent).toContain("Nights");
    expect(row.textContent).toContain("All devices");
    expect(row.textContent).toContain("everything for notice, warning, serious · any alert");
    expect(row.textContent).toContain("Daily 22:00–06:00");
    expect(row.textContent).toContain("at 07:30");
    expect(row.textContent).toContain("Quiet now until Oct 3 06:00");
    expect(row.querySelector("[data-qt-edit]")).toBeTruthy();
  });

  it("a summary's Covered, Listed and Recipients counts open the lists behind them over the modal", async () => {
    // The real stacked-overlay builder, so the assertions about structure hold.
    g._trapFocus = () => () => {};
    g._focusFirstIn = () => {};
    g.requestAnimationFrame = (fn: () => void) => setTimeout(fn, 0);
    installAppOverlay();
    settings().open();
    await tick();
    const btn = (kind: string) => doc.querySelector(`[data-qt-detail="${kind}"][data-qt-id="s1"]`)! as unknown as { click: () => void };
    const overlay = () => Array.from(doc.querySelectorAll(".modal-overlay")).pop()! as HTMLElement;

    btn("covered").click();
    await tick(20);
    expect(overlay().style.zIndex).toBe("1300");
    expect(overlay().querySelector(".modal-header h3")!.textContent).toBe("Alerts covered");
    const coveredRows = Array.from(overlay().querySelectorAll("tbody tr"));
    expect(coveredRows).toHaveLength(2);
    // Severity order, the listed one marked, the device linked to its page, the recovered one saying so.
    expect(coveredRows[0]!.textContent).toContain("sw-1");
    expect(coveredRows[0]!.querySelector(".badge-active")!.textContent).toBe("LISTED");
    expect(coveredRows[0]!.querySelector("a")!.getAttribute("href")).toBe("/assets/a1");
    expect(coveredRows[0]!.textContent).toContain("Still active");
    expect(coveredRows[1]!.textContent).toContain("Recovered");
    (overlay().querySelector("#qt-detail-close") as unknown as { click: () => void }).click();
    await tick(450);
    expect(doc.querySelectorAll(".modal-overlay")).toHaveLength(0);

    btn("listed").click();
    await tick(20);
    expect(overlay().querySelector(".modal-header h3")!.textContent).toBe("What the email listed");
    expect(overlay().textContent).toContain("Still outstanding (1)");
    expect(overlay().textContent).toContain("Recurring (1)");
    expect(overlay().textContent).toContain("fired more than 2 times");
    expect(overlay().querySelectorAll("tbody tr")).toHaveLength(2);
    (overlay().querySelector("#qt-detail-close") as unknown as { click: () => void }).click();
    await tick(450);

    btn("recipients").click();
    await tick(20);
    expect(overlay().querySelector(".modal-header h3")!.textContent).toBe("Recipients");
    const recipRows = Array.from(overlay().querySelectorAll("tbody tr"));
    expect(recipRows).toHaveLength(2);
    expect(recipRows[1]!.textContent).toContain("b@x.com");
    expect(recipRows[1]!.textContent).toContain("failed");
    expect(recipRows[1]!.textContent).toContain("smtp down");
    // The Settings modal underneath is untouched.
    expect(doc.querySelector("#aqs-quiet")!.textContent).toContain("Recent summaries");
    (overlay().querySelector("#qt-detail-close") as unknown as { click: () => void }).click();
    await tick(450);
  });

  it("the enable toggle PUTs the whole record", async () => {
    schedules = [{ id: "g1", name: "Nights", enabled: true, scope: { allAssets: true }, quiet: { windows: [NIGHTLY] }, inWindow: false, nextWindow: null }];
    settings().open();
    await tick();
    const box = doc.querySelector("[data-qt-toggle]") as unknown as { checked: boolean; dispatchEvent: (e: unknown) => void };
    box.checked = false;
    box.dispatchEvent(new (g.window as Window).Event("change", { bubbles: true }));
    await tick();
    expect(put).toHaveLength(1);
    expect(put[0]!.body).toEqual({ name: "Nights", enabled: false, scope: { allAssets: true }, quiet: { windows: [NIGHTLY] } });
  });

  it("+ New quiet time replaces the modal with the wizard, and Cancel brings Settings back", async () => {
    settings().open();
    await tick();
    click("#aqs-new");
    await tick(40);
    expect(doc.querySelector(".modal-header h3")!.textContent).toBe("New global quiet time");
    expect(doc.querySelector("#qtw-stepper")).toBeTruthy();
    click("#qtw-cancel");
    await tick(40);
    expect(doc.querySelector(".modal-header h3")!.textContent).toBe("Automation settings");
  });
});

describe("the global quiet-time wizard", () => {
  it("walks five steps and posts a body the server schemas accept — everything but critical by default", async () => {
    let done = 0;
    await wizard().open(null, { onDone: () => { done++; } });
    await tick();
    expect(Array.from(doc.querySelectorAll("#qtw-stepper .stepper-step")).map((e) => e.textContent!.replace(/^\d/, ""))).toEqual(["Name", "Devices", "Alerts", "Schedule", "Review"]);

    // 1 Name — refused empty, then filled.
    click("#qtw-next");
    expect(toasts.pop()!.msg).toMatch(/name/i);
    (doc.querySelector("#qtw-name") as HTMLInputElement).value = "Nights";
    click("#qtw-next");
    await tick();
    expect(doc.querySelector("#qtw-step-2.visible")).toBeTruthy();

    // 2 Devices — all devices.
    click("#qtw-next");
    await tick();
    expect(doc.querySelector("#qtw-step-3.visible")).toBeTruthy();

    // 3 Alerts — the per-severity tree; the default leaves critical unticked
    // and every kind ticked under the rest; kinds of alert are "any".
    const sevs = Array.from(doc.querySelectorAll("#qtw-step-3 .qte-sev")) as unknown as { value: string; checked: boolean }[];
    expect(sevs.filter((s) => s.checked).map((s) => s.value)).toEqual(["notice", "informational", "warning", "serious"]);
    expect(doc.querySelectorAll('#qtw-step-3 .qte-sevrow[data-sev="warning"] .qte-kind:checked')).toHaveLength(4);
    expect(doc.querySelector("#qtw-kinds-list")).toBeTruthy();
    expect(doc.querySelector("#qtw-kinds-list")!.textContent).toContain("CPU");
    click("#qtw-next");
    await tick();
    expect(doc.querySelector("#qtw-step-4.visible")).toBeTruthy();

    // 4 Schedule — the shared editor, with the severity question hidden
    // because step 3 asked it; set a summary time and a threshold.
    expect(doc.querySelector("#qtw-editor .qte")).toBeTruthy();
    expect(doc.querySelector("#qtw-editor .qte-sev")).toBeNull();
    pickRadio('#qtw-editor .qte-sendat[value="time"]');
    (doc.querySelector("#qtw-editor .qte-summary-time") as HTMLInputElement).value = "07:30";
    (doc.querySelector("#qtw-editor .qte-threshold") as HTMLInputElement).value = "2";
    click("#qtw-next");
    await tick();
    expect(toasts).toEqual([]);
    expect(doc.querySelector("#qtw-step-5.visible")).toBeTruthy();
    expect(doc.querySelector("#qtw-step-5")!.textContent).toContain("Daily 22:00–06:00");
    expect(doc.querySelector("#qtw-step-5")!.textContent).toContain("at 07:30");

    // 5 Save.
    click("#qtw-save");
    await tick(40);
    expect(toasts.map((t) => t.kind)).toEqual(["success"]);
    expect(posted).toHaveLength(1);
    const body = posted[0]! as { name: string; enabled: boolean; scope: unknown; quiet: unknown };
    expect(body.name).toBe("Nights");
    expect(() => scopeSchema.parse(body.scope)).not.toThrow();
    const quiet = quietTimeConfigSchema.parse(body.quiet);
    expect(quiet.severities).toEqual(["notice", "informational", "warning", "serious"]);
    expect(quiet.alertKinds).toBeNull();
    expect(quiet.summaryAt).toBe("07:30");
    expect(quiet.recurrenceThreshold).toBe(2);
    expect(quiet.holds).toBeUndefined();
    expect(Object.keys(quiet.held!)).toEqual(["notice", "informational", "warning", "serious"]);
    expect(quiet.held!.warning).toEqual({ alerts: true, alertReminders: true, escalations: true, escalationReminders: true });
    expect(done).toBe(1);
  });

  it("refuses a summary time inside the quiet period before the server has to", async () => {
    await wizard().open(null, {});
    await tick();
    (doc.querySelector("#qtw-name") as HTMLInputElement).value = "Nights";
    click("#qtw-next"); await tick();
    click("#qtw-next"); await tick();
    click("#qtw-next"); await tick();
    pickRadio('#qtw-editor .qte-sendat[value="time"]');
    (doc.querySelector("#qtw-editor .qte-summary-time") as HTMLInputElement).value = "23:00";
    click("#qtw-next");
    await tick();
    expect(toasts.pop()!.msg).toMatch(/inside the quiet period on every day it occurs/);
    expect(doc.querySelector("#qtw-step-4.visible")).toBeTruthy();
  });

  it("opens a stored schedule fully populated and saves it back through PUT", async () => {
    const stored = {
      id: "g1", name: "Weekends", enabled: false, scope: { allAssets: true },
      quiet: { windows: [{ version: 1, kind: "recurring", freq: "weekly", daysOfWeek: [0, 6] }], holds: "followUps", severities: ["warning"], alertKinds: ["cpuPct"] },
    };
    await wizard().open(stored, {});
    await tick();
    expect((doc.querySelector("#qtw-name") as HTMLInputElement).value).toBe("Weekends");
    expect((doc.querySelector("#qtw-enabled") as unknown as { checked: boolean }).checked).toBe(false);
    // Every step is visited on an edit: save straight from step 1.
    click("#qtw-save");
    await tick(40);
    expect(put).toHaveLength(1);
    const q = quietTimeConfigSchema.parse(put[0]!.body.quiet);
    expect(q.holds).toBe("followUps");
    expect(q.severities).toEqual(["warning"]);
    expect(q.alertKinds).toEqual(["cpuPct"]);
    expect(q.windows).toEqual(stored.quiet.windows);
  });
});
