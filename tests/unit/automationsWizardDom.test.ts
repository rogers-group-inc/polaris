/**
 * tests/unit/automationsWizardDom.test.ts — DOM render smoke for the 5-step
 * automation wizard (public/js/automations-wizard.js).
 *
 * The wizard is a plain browser script (no module exports), so this test
 * loads it via eval into a happy-dom Window with the app-shell globals
 * stubbed (openModal/escapeHtml/permAtLeast/api/…) and the REAL schema
 * catalog from buildSchemaCatalog — then drives openAutomationWizard through
 * the first two steps. This is the regression net for the class of bug where
 * a helper is referenced during the modal-body assembly before its `var`
 * assignment has run (the wizard silently fails to open — nothing renders,
 * no toast — exactly what shipped when the condition builder's scMeta was
 * initialized after the body build).
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Window } from "happy-dom";
import { installAppOverlay } from "../fixtures/appOverlay.js";
import { buildSchemaCatalog, ruleInputSchema } from "../../src/services/notificationTypes.js";
import { dimensionPickerMeta } from "../../src/services/notificationDimensionService.js";
import { fixSelects } from "../fixtures/happyDomSelects.js";

vi.mock("../../src/db.js", () => ({ prisma: {} }));

const g = globalThis as Record<string, unknown>;
let doc: Window["document"];
let toastErrors: string[];
const savedPayloads: Record<string, unknown>[] = [];
/** Export writes through downloadJson; captured rather than downloaded. */
const downloads: { obj: unknown; filename: string }[] = [];
/** What POST /automations/preview answers — mutable so a test can hand the
 *  Devices step a carve-out picture without re-standing the whole harness. */
const DEFAULT_PREVIEW: Record<string, unknown> = { supported: true, totalEvaluated: 3, meetsCount: 0, matches: [] };
let previewResponse: Record<string, unknown> = DEFAULT_PREVIEW;

beforeAll(() => {
  const win = new Window();
  doc = win.document;
  g.window = win;
  g.document = doc;
  toastErrors = [];
  g.escapeHtml = (s: unknown) =>
    String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  g.showToast = (msg: string, kind: string) => { if (kind === "error") toastErrors.push(msg); };
  g.showConfirm = async () => false;
  g.permAtLeast = () => true;
  g.closeModal = () => {};
  // Mirror production: openModal creates ONE #modal-overlay and REUSES it,
  // replacing .modal-body / .modal-footer on every call. A stub that appends a
  // fresh overlay instead leaves two #aw-name / #aw-save in the document after a
  // reopen (which is what the import flow does), and getElementById returns the
  // FIRST — so the test would silently read the stale wizard and disagree with
  // the browser.
  g.openModal = (title: string, body: string, footer: string) => {
    let overlay = doc.getElementById("modal-overlay");
    if (!overlay) {
      overlay = doc.createElement("div");
      overlay.id = "modal-overlay";
      overlay.innerHTML =
        '<div class="modal"><div class="modal-header"><h3></h3></div>' +
        '<div class="modal-body"></div><div class="modal-footer"></div></div>';
      doc.body.appendChild(overlay);
    }
    overlay.querySelector(".modal-header h3").textContent = title;
    overlay.querySelector(".modal-body").innerHTML = body;
    overlay.querySelector(".modal-footer").innerHTML = footer;
  };
  g.api = {
    automations: {
      update: async (_id: string, payload: unknown) => { savedPayloads.push(payload as Record<string, unknown>); return { rule: {} }; },
      create: async (payload: unknown) => { savedPayloads.push(payload as Record<string, unknown>); return { rule: {} }; },
      // Exactly what GET /automations/schema answers — dimensionPickers is
      // merged in at the route, not by buildSchemaCatalog, and without it every
      // dimension control falls back to a plain text box.
      schema: async () => ({ ...buildSchemaCatalog(), dimensionPickers: dimensionPickerMeta() }),
      // pushDevices is what the push branch's warning line and the address-book
      // picker's device column read; "op" has one browser enrolled, "quiet" none.
      recipientUsers: async () => ({ users: [
        { id: "u1", username: "op", displayName: "Op", email: "op@x.com", pushDevices: 1 },
        { id: "u2", username: "quiet", displayName: "Quiet", email: "quiet@x.com", pushDevices: 0 },
      ] }),
      scopeOptions: async () => ({
        manufacturers: ["Fortinet Inc."],
        models: ["FGT-60F"],
        subnets: [{ id: "s1", name: "Mgmt", cidr: "10.20.0.0/24" }],
      }),
      preview: async () => previewResponse,
      // The cadence the poll-counted hold + window fields convert through.
      // 120s with a spread, so a caption that quietly assumed 60 is visible.
      pollCadence: async () => ({ stream: "cpuMemory", mode: 120, min: 60, max: 300, timeoutMs: 5000, assetCount: 7 }),
      dimensionValues: async (body: { dimension: string }) => ({
        values: body.dimension === "sensorClass"
          ? [{ value: "temperature", assetCount: 2 }, { value: "fan", assetCount: 2 }]
          : [
              { value: "CPU ON-DIE Temperature", assetCount: 2 },
              { value: "CPU Fan", assetCount: 2 },
              { value: "DTS CPU0", assetCount: 1 },
            ],
        noun: body.dimension === "sensorClass" ? "hardware sensor classes" : "hardware sensors",
        narrowLabel: "",
        scopedAssets: 2,
        sampledAssets: 2,
        assetsWithData: 2,
        windowHours: 3,
      }),
    },
    // The recipient typeahead calls this on every keystroke once the caller
    // holds contacts:read (permAtLeast is stubbed true), 250ms after the local
    // matches are already on screen.
    contacts: { search: async () => ({ entries: [] }) },
    assets: { tags: async () => ({ tags: ["region:Atlanta", "prod"] }) },
    assetTypes: { list: async () => ({ types: [{ name: "server", label: "Server" }, { name: "switch", label: "Switch" }] }) },
    deliveryChannels: { list: async () => ({ channels: [
      { id: "c1", name: "NOC email", type: "smtp", enabled: true },
      { id: "c2", name: "Browser push", type: "web_push", enabled: true },
    ] }) },
    automationScripts: { list: async () => ({ scripts: [{ id: "sc1", name: "restart-svc", interpreter: "bash", runTarget: "either", timeoutSec: 60 }] }) },
  };
  // Module-scope caches normally owned by automations.js (loaded first on the page).
  g._ruleSchema = null;
  g._ruleTagList = null;
  g._ruleAssetTypes = null;
  g._ruleChannels = null;
  g._ruleRecipientUsers = null;
  g._looksLikeDeviceId = () => false;

  // Export writes through api.js's downloadJson; capture instead of downloading.
  // The wizard calls window.downloadJson, so it has to be on the happy-dom
  // window — setting it on globalThis alone leaves the call undefined.
  const captureDownload = (obj: unknown, filename: string) => { downloads.push({ obj, filename }); };
  g.downloadJson = captureDownload;
  (win as unknown as Record<string, unknown>).downloadJson = captureDownload;
  // openCodeModal stacks a dialog via app.js's buildOverlay. Load the REAL one
  // (sliced out of app.js) so the code editor is exercised against the overlay
  // it actually gets in a browser.
  g._trapFocus = () => () => {};
  g._focusFirstIn = () => {};
  // buildOverlay ends with requestAnimationFrame, which Node does not define —
  // without this it throws AFTER appending the dialog but BEFORE the click
  // handlers are attached, so the dialog renders and every button is inert.
  g.requestAnimationFrame = (fn: () => void) => setTimeout(fn, 0);
  installAppOverlay();

  // The devices-step tree builder lives in its own script, loaded BEFORE the
  // wizard on every page that carries it — the wizard reads
  // window.PolarisConditionBuilder while assembling the modal body, so a
  // missing module here reproduces the "wizard silently fails to open" bug.
  const cbSrc = readFileSync(resolve(__dirname, "../../public/js/condition-builder.js"), "utf8");
  (0, eval)(cbSrc);
  // The address book, loaded before the wizard on every page that carries it.
  // It owns the dynamic-recipient catalogue ("Asset's Region Users" and
  // friends) that the wizard's recipient typeahead offers, so a missing module
  // here reproduces a typeahead that silently knows about nobody.
  const abSrc = readFileSync(resolve(__dirname, "../../public/js/automations-address-book.js"), "utf8");
  (0, eval)(abSrc);
  // The shared recurrence editor, also loaded before the wizard on every page
  // that carries it. Quiet time's day/hour rows are built from it WHILE the
  // Actions step is assembled, so without it that step throws mid-render and
  // every step-5 assertion here fails on a null panel — which is exactly what
  // a page that forgot the script tag would do.
  const recSrc = readFileSync(resolve(__dirname, "../../public/js/recurrence-editor.js"), "utf8");
  (0, eval)(recSrc);
  const src = readFileSync(resolve(__dirname, "../../public/js/automations-wizard.js"), "utf8");
  (0, eval)(src);
  // Export / import / view-code. Loaded on every page that loads the wizard.
  const portSrc = readFileSync(resolve(__dirname, "../../public/js/automations-portability.js"), "utf8");
  (0, eval)(portSrc);
});

describe("automation wizard DOM render", () => {
  it("openAutomationWizard(null) renders the modal, stepper, and step 1", async () => {
    await (g.openAutomationWizard as (r: unknown) => Promise<void>)(null);
    expect(toastErrors).toEqual([]);
    expect(doc.querySelector(".modal")).toBeTruthy();
    expect(doc.querySelectorAll("#aw-stepper .stepper-step").length).toBe(6);
    expect(doc.querySelector("#aw-step-1.visible")).toBeTruthy();
    // Severity + Enabled were removed from the name step (severity moved to the
    // trigger step; enabled is managed from the list toggle).
    expect(doc.querySelector("#aw-severity")).toBeFalsy();
    expect(doc.querySelector("#aw-enabled")).toBeFalsy();
  });

  it("Next reaches step 2; All assets is checked by default and hides the builder", async () => {
    (doc.querySelector("#aw-name") as unknown as { value: string }).value = "smoke";
    (doc.querySelector("#aw-next") as unknown as { click: () => void }).click();
    await new Promise((r) => setTimeout(r, 20));
    expect(doc.querySelector("#aw-step-2.visible")).toBeTruthy();
    const allCb = doc.querySelector("#aw-all-assets") as unknown as { checked: boolean; dispatchEvent: (e: unknown) => void };
    expect(allCb).toBeTruthy();
    expect(allCb.checked).toBe(true);
    expect((doc.querySelector("#aw-cond-wrap") as unknown as { style: { display: string } }).style.display).toBe("none");
  });

  it("unchecking All assets reveals the builder with a starter row; add-rule/add-group work", async () => {
    const win = g.window as InstanceType<typeof Window>;
    const allCb = doc.querySelector("#aw-all-assets") as unknown as { checked: boolean; dispatchEvent: (e: unknown) => void };
    allCb.checked = false;
    allCb.dispatchEvent(new win.Event("change", { bubbles: true }));
    expect((doc.querySelector("#aw-cond-wrap") as unknown as { style: { display: string } }).style.display).toBe("block");
    expect(doc.querySelector("#aw-cond-root .scg-group")).toBeTruthy();
    expect(doc.querySelectorAll("#aw-cond-root .scr-row").length).toBe(1); // seeded starter row
    // Rows carry a draggable grip for the tree drag-and-drop.
    expect(doc.querySelector("#aw-cond-root .scr-row .aw-grip[draggable='true']")).toBeTruthy();

    (doc.querySelector("#aw-cond-root .scg-add-rule") as unknown as { click: () => void }).click();
    expect(doc.querySelectorAll("#aw-cond-root .scr-row").length).toBe(2);
    (doc.querySelector("#aw-cond-root .scg-add-group") as unknown as { click: () => void }).click();
    expect(doc.querySelectorAll("#aw-cond-root .scg-group").length).toBe(2);
    // Sub-groups get a grip too (root group does not).
    expect(doc.querySelectorAll("#aw-cond-root .scg-group .aw-grip").length).toBeGreaterThan(0);
    expect(toastErrors).toEqual([]);
  });

  it("value combobox opens existing values on click and filters as you type", async () => {
    const row = doc.querySelector("#aw-cond-root .scr-row")!;
    const fieldSel = row.querySelector(".scr-field") as unknown as { value: string; dispatchEvent: (e: unknown) => void };
    const win = g.window as InstanceType<typeof Window>;
    // Switch the row's field to Model, then click into the value input.
    fieldSel.value = "model";
    fieldSel.dispatchEvent(new win.Event("change", { bubbles: true }));
    const input = row.querySelector(".scr-value") as unknown as { value: string; click: () => void; dispatchEvent: (e: unknown) => void };
    input.click();
    let items = row.querySelectorAll(".aw-suggest.open .aw-suggest-item");
    expect(items.length).toBe(1); // the stubbed inventory has one model
    expect(items[0]!.textContent).toBe("FGT-60F");
    // Typing filters — a non-matching query shows the empty hint instead.
    input.value = "zzz";
    input.dispatchEvent(new win.Event("input", { bubbles: true }));
    expect(row.querySelectorAll(".aw-suggest.open .aw-suggest-item").length).toBe(0);
    expect(row.querySelector(".aw-suggest.open .aw-suggest-empty")).toBeTruthy();
    // A matching query brings the value back; clicking it fills the input.
    input.value = "fgt";
    input.dispatchEvent(new win.Event("input", { bubbles: true }));
    items = row.querySelectorAll(".aw-suggest.open .aw-suggest-item");
    expect(items.length).toBe(1);
    items[0]!.dispatchEvent(new win.MouseEvent("mousedown", { bubbles: true }));
    expect(input.value).toBe("FGT-60F");
    expect(row.querySelector(".aw-suggest.open")).toBeFalsy(); // closed after pick
    expect(toastErrors).toEqual([]);
  });

  it("step 3 renders the trigger condition tree with a starter leaf", async () => {
    const win = g.window as InstanceType<typeof Window>;
    // Re-check All assets so step 2 validates (the builder has unfinished rows).
    const allCb = doc.querySelector("#aw-all-assets") as unknown as { checked: boolean; dispatchEvent: (e: unknown) => void };
    allCb.checked = true;
    allCb.dispatchEvent(new win.Event("change", { bubbles: true }));
    (doc.querySelector("#aw-next") as unknown as { click: () => void }).click();
    await new Promise((r) => setTimeout(r, 20));
    expect(toastErrors).toEqual([]);
    expect(doc.querySelector("#aw-step-3.visible")).toBeTruthy();
    // Severity leads the trigger step (single mode default): standalone
    // dropdown shown, multi-severity checkbox present + off, bands hidden.
    expect(doc.querySelector("#aw-trigger-severity.sev-select")).toBeTruthy();
    expect(doc.querySelectorAll("#aw-trigger-severity option.sev-critical").length).toBe(1);
    const multiCb = doc.querySelector("#aw-multi-sev") as unknown as { checked: boolean; disabled: boolean; dispatchEvent: (e: unknown) => void };
    expect(multiCb).toBeTruthy();
    expect(multiCb.checked).toBe(false);
    expect((doc.querySelector("#aw-bands-host") as unknown as { style: { display: string } }).style.display).toBe("none");
    // Category select (device/host/event/change) + the tree with one leaf row.
    const cat = doc.querySelector("#aw-trigger-type") as unknown as { value: string };
    expect(cat.value).toBe("device");
    // The message template moved to the Actions step (mandatory in-app card).
    expect(doc.querySelector("#aw-step-3 #aw-msg")).toBeFalsy();
    expect(doc.querySelector("#aw-trig-root .scg-group")).toBeTruthy();
    expect(doc.querySelectorAll("#aw-trig-root .scr-row").length).toBe(1);
    expect(doc.querySelector("#aw-trig-root .tgl-what")).toBeTruthy();
    expect(doc.querySelector("#aw-trig-root .tgl-threshold")).toBeTruthy();
    expect(doc.querySelector("#aw-trig-root .scr-row .aw-grip[draggable='true']")).toBeTruthy();

    // Enable multi-severity → single dropdown hides; the base severity select +
    // a "+ Severity" button are injected INTO the condition group header/buttons.
    multiCb.checked = true;
    multiCb.dispatchEvent(new win.Event("change", { bubbles: true }));
    expect((doc.querySelector("#aw-single-sev-wrap") as unknown as { style: { display: string } }).style.display).toBe("none");
    expect(doc.querySelector("#aw-trig-root .scg-group .scg-sev")).toBeTruthy();   // base severity in the group header
    const addSev = doc.querySelector("#aw-trig-root .scg-group .scg-add-sev");
    expect(addSev).toBeTruthy();                                                   // + Severity next to +Condition/+Group
    expect((doc.querySelector("#aw-band-notify") as unknown as { style: { display: string } }).style.display).toBe("none");

    // Clicking + Severity adds a tier GROUP block: severity header + a condition
    // row (locked metric, editable operator/value) + its own + Severity.
    (addSev as unknown as { click: () => void }).click();
    const band = doc.querySelector("#aw-bands .aw-band")!;
    expect(band).toBeTruthy();
    expect(band.querySelector(".band-severity")).toBeTruthy();
    expect(band.querySelector(".band-add-sev")).toBeTruthy();                      // per-tier + Severity
    expect((band.querySelector(".band-cond .tgl-what") as unknown as { disabled: boolean }).disabled).toBe(true); // metric locked
    (band.querySelector(".band-cond .tgl-threshold") as unknown as { value: string }).value = "95"; // editable value
    (band.querySelector(".band-severity") as unknown as { value: string }).value = "critical";
    expect((doc.querySelector("#aw-band-notify") as unknown as { style: { display: string } }).style.display).toBe("block");
    expect((doc.querySelector("#aw-bn-increase") as unknown as { checked: boolean }).checked).toBe(true);
    expect((doc.querySelector("#aw-bn-decrease") as unknown as { checked: boolean }).checked).toBe(false);

    // ONE hold for the whole trigger (2026-08-28): no tier carries an editable
    // one. It lives INSIDE the base severity block (2026-08-31) — between the
    // tiers it read as the first tier's — and every added tier shows it again as
    // a disabled mirror, so the ladder states it in each tier rather than once,
    // ambiguously, between two of them.
    expect(band.querySelector(".band-duration")).toBeNull();
    expect(doc.querySelector("#aw-trig-root .scg-group > .aw-dur #tf-duration-min")).toBeTruthy();
    const mirror = band.querySelector(".aw-band-dur .aw-band-dur-input") as unknown as { disabled: boolean };
    expect(mirror).toBeTruthy();
    expect(mirror.disabled).toBe(true);
    // The loss-only sustain field stays hidden on a CPU automation even though it
    // now folds with the base severity group: it is marked `.aw-collapse-part`,
    // and expanding that group sets `display: ""` on every part — which is how a
    // CPU automation once rendered a second "Sustained for" captioned about
    // packet loss. `data-hold-off` is what keeps a switched-off part off.
    expect((doc.querySelector(".aw-ratio-sustain") as unknown as { style: { display: string } }).style.display).toBe("none");
    expect(doc.querySelectorAll("#aw-step-3 .aw-poll-input").length).toBe(2); // the hold + the hidden ratio sustain

    // A stated hold reaches every tier's mirror, value and all. Nothing about
    // what is SAVED changes — the mirror is disabled and carries no
    // `.aw-poll-input`, so neither collection nor the cadence repaint sees it.
    const durInput = doc.querySelector("#tf-duration-min") as unknown as { value: string; dispatchEvent: (e: unknown) => void };
    durInput.value = "3";
    durInput.dispatchEvent(new win.Event("input", { bubbles: true }));
    const mirrorWrap = band.querySelector(".aw-band-dur") as unknown as { style: { display: string } };
    expect(mirrorWrap.style.display).toBe("");
    expect((band.querySelector(".aw-band-dur-input") as unknown as { value: string }).value).toBe("3");
    expect(doc.querySelectorAll("#aw-step-3 .aw-poll-input").length).toBe(2);

    // Folding the base severity takes the hold down with it — and must NOT take
    // the mirrors: the tiers below still wait it out whether or not the block
    // stating it is open.
    const chev = doc.querySelector('#aw-trig-root .scg-group [data-collapse="t3:base"]') as unknown as { click: () => void };
    expect(chev).toBeTruthy();
    const durWrap = doc.querySelector("#aw-trig-root .scg-group > .aw-dur") as unknown as { style: { display: string } };
    chev.click();
    expect(durWrap.style.display).toBe("none");
    expect(mirrorWrap.style.display).toBe("");
    chev.click();
    expect(durWrap.style.display).toBe("");
    // Unfolding re-offers the parts it hid — but not one the trigger switched
    // off, which is what `data-hold-off` on the loss-only sustain field pins.
    expect((doc.querySelector(".aw-ratio-sustain") as unknown as { style: { display: string } }).style.display).toBe("none");
  });

  it("step 4 shows the default-checked 'trigger no longer true' checkbox; step 6 lists affected devices", async () => {
    // Fill the leaf threshold so step 3 validates.
    (doc.querySelector("#aw-trig-root .tgl-threshold") as unknown as { value: string }).value = "90";
    (doc.querySelector("#aw-next") as unknown as { click: () => void }).click();
    await new Promise((r) => setTimeout(r, 20));
    expect(toastErrors).toEqual([]);
    expect(doc.querySelector("#aw-step-4.visible")).toBeTruthy();
    const autoCb = doc.querySelector("#aw-reset-auto") as unknown as { checked: boolean };
    expect(autoCb).toBeTruthy();
    expect(autoCb.checked).toBe(true);
    // Single-condition trigger → hysteresis extras available under the checkbox.
    expect(doc.querySelector("#aw-hyst-enable")).toBeTruthy();

    (doc.querySelector("#aw-next") as unknown as { click: () => void }).click();
    await new Promise((r) => setTimeout(r, 20));
    expect(doc.querySelector("#aw-step-5.visible")).toBeTruthy();
    expect(doc.querySelector("#aw-summary")).toBeFalsy(); // summary moved to step 6

    // The mandatory in-app card leads the Actions step: not an .aw-action row
    // (so it can't be collected/removed) and carries the moved message
    // template. It covers the ALERT only — every delivery row, the escalation
    // sweep and acknowledge/clear key on Notification.id, so it genuinely
    // can't be removed. The audit Event moved OUT to a removable
    // "Create an Event" action in the list below.
    const inapp = doc.querySelector("#aw-step-5 #aw-inapp-card")!;
    expect(inapp).toBeTruthy();
    expect(inapp.classList.contains("aw-action")).toBe(false);
    expect(inapp.querySelector("#aw-msg")).toBeTruthy();
    expect(inapp.textContent).toContain("in-app alert (always happens)");
    expect(inapp.textContent).not.toContain("event + in-app alert");
    expect(inapp.querySelector(".aw-action-remove")).toBeFalsy();

    // ...and the Event IS a removable action row, present by default.
    const eventRow = Array.from(doc.querySelectorAll("#aw-step-5 .aw-action")).find(
      (r) => (r.querySelector(".aw-action-type") as HTMLSelectElement | null)?.value === "event",
    );
    expect(eventRow).toBeTruthy();
    expect(eventRow!.querySelector(".aw-action-remove")).toBeTruthy();
    expect(eventRow!.textContent).toContain("notification.triggered");
    // An audit Event is instantaneous — no chain to chase, and the server
    // schema gives it no escalation key.
    expect(eventRow!.querySelector(":scope > .aw-esc-sec")).toBeFalsy();

    // Escalation is PER SEVERITY: the base actions section hosts the rule-level
    // chain, each band section its own. NOT the in-app card (it isn't about the
    // alert record) and NOT an action row ("if this alert stays unhandled" is a
    // fact about the alert at this severity, not about one email). The old bottom
    // escalation box is gone entirely.
    expect(doc.querySelector("#aw-esc-enable")).toBeFalsy();
    expect(doc.querySelector("#aw-esc-add")).toBeFalsy();
    expect(doc.querySelector("#aw-esc-tiers")).toBeFalsy();
    expect(doc.querySelector("#aw-inapp-card .aw-esc-sec")).toBeFalsy();
    expect(doc.querySelector("#aw-step-5 .aw-action > .aw-esc-sec")).toBeFalsy();
    const cardEsc = doc.querySelector("#aw-actions")!.closest(".form-group")!.querySelector(".aw-esc-sec")!;
    expect(cardEsc).toBeTruthy();
    expect(cardEsc.querySelector(".aesc-add")!.textContent).toContain("Escalate if unhandled");
    expect((cardEsc.querySelector(".aesc-config") as unknown as { style: { display: string } }).style.display).toBe("none");
    (cardEsc.querySelector(".aesc-add") as unknown as { click: () => void }).click();
    const tier = cardEsc.querySelector(".aesc-tiers .aw-tier")!;
    expect(tier.querySelector(".tier-after")).toBeTruthy(); // minutes-before field
    expect(tier.querySelector(".tier-actions .aw-action")).toBeTruthy(); // seeded notify action
    expect(tier.querySelector(".na-chan")).toBeTruthy(); // channel checklist → recipients render from it
    // Recipient sources on an EMAIL channel are all pills in the To field —
    // device-region and asset-contacts became recipients you can see rather than
    // checkboxes beside the field (the checkbox survives only on Web Push, which
    // has no token field to hold a pill). Legacy scope-region renders only on
    // actions that already carry it.
    expect(tier.querySelector(".na-device-region")).toBeFalsy();
    expect(tier.querySelector(".na-asset-contacts")).toBeFalsy();
    expect(tier.querySelector(".na-scope-region")).toBeFalsy();
    expect(tier.querySelector('.na-recip-box[data-field="to"]')).toBeTruthy();
    // No chains inside chains: the tier-hosted action row has no footer.
    expect(tier.querySelector(".tier-actions .aw-action .aw-esc-sec")).toBeFalsy();
    expect((cardEsc.querySelector(".aesc-config") as unknown as { style: { display: string } }).style.display).toBe("block");
    (tier.querySelector(".tier-remove") as unknown as { click: () => void }).click();
    expect(cardEsc.querySelector(".aesc-tiers .aw-tier")).toBeFalsy();
    expect((cardEsc.querySelector(".aesc-config") as unknown as { style: { display: string } }).style.display).toBe("none");
    // Band editor is NOT on step 5 (it moved to step 3, with the trigger).
    expect(doc.querySelector("#aw-step-5 #aw-bands-section")).toBeFalsy();

    // Per-severity actions are OPT-IN, mirroring the trigger step's
    // multi-severity checkbox: off by default, so one action list runs at every
    // severity and the per-tier sections stay out of the way.
    const win5 = g.window as InstanceType<typeof Window>;
    const perSevCb = doc.querySelector("#aw-band-actions-multi") as unknown as { checked: boolean; dispatchEvent: (e: unknown) => void };
    expect(perSevCb).toBeTruthy();
    expect(perSevCb.checked).toBe(false);
    expect((doc.querySelector("#aw-step-5 .aw-band-actions") as unknown as { style: { display: string } }).style.display).toBe("none");
    perSevCb.checked = true;
    perSevCb.dispatchEvent(new win5.Event("change", { bubbles: true }));
    expect((doc.querySelector("#aw-step-5 .aw-band-actions") as unknown as { style: { display: string } }).style.display).toBe("");

    // Multi-severity carries into Actions: a per-severity section per band, and
    // the SECTION owns the escalation chain — its action rows carry none.
    const bandSec = doc.querySelector("#aw-step-5 .aw-band-actions")!;
    expect(bandSec).toBeTruthy();
    expect(bandSec.textContent).toContain("critical");
    expect(bandSec.textContent).toContain("base actions"); // empty-band fallback note
    expect(bandSec.querySelector(".aw-esc-sec .aesc-add")).toBeTruthy(); // the BAND's chain
    (bandSec.querySelector(".ba-add") as unknown as { click: () => void }).click();
    const bandAction = bandSec.querySelector(".ba-actions .aw-action")!;
    expect(bandAction).toBeTruthy();
    expect(bandAction.querySelector(":scope > .aw-esc-sec")).toBeFalsy(); // not per action
    // Same for a top-level row: the base SECTION carries the chain.
    (doc.querySelector("#aw-add-action") as unknown as { click: () => void }).click();
    const baseRows = doc.querySelectorAll("#aw-actions .aw-action");
    const baseAction = baseRows[baseRows.length - 1]!;
    expect(baseAction.querySelector(":scope > .aw-esc-sec")).toBeFalsy();
    // Remove both again so step-5 validation (notify needs a recipient) passes.
    (bandAction.querySelector(".aw-action-remove") as unknown as { click: () => void }).click();
    (baseAction.querySelector(".aw-action-remove") as unknown as { click: () => void }).click();

    // "When this resets" — the list that makes a recovery expressible at all.
    // It starts mirroring the trigger's notify actions, so telling the same
    // people it came back costs nothing.
    const resetCard = doc.querySelector("#aw-step-5 #aw-reset-card")!;
    expect(resetCard).toBeTruthy();
    expect((doc.querySelector("#aw-reset-actions-on") as unknown as { checked: boolean }).checked).toBe(true);
    (doc.querySelector("#aw-add-action") as unknown as { click: () => void }).click();
    const newNotify = Array.from(doc.querySelectorAll("#aw-actions .aw-action")).pop()!;
    // A channel is a CHECKBOX now — an action may deliver through several.
    const chanBox = newNotify.querySelector('.na-chan[value="c1"]') as unknown as { checked: boolean; dispatchEvent: (e: unknown) => void };
    chanBox.checked = true;
    chanBox.dispatchEvent(new win5.Event("change", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 10));
    expect(doc.querySelector("#aw-reset-actions .aw-action")).toBeTruthy();
    expect(doc.querySelector("#aw-reset-mirror-note")!.textContent).toContain("Following your notify actions");
    // Clean up so step-5 validation (a notify needs a recipient) still passes.
    (newNotify.querySelector(".aw-action-remove") as unknown as { click: () => void }).click();
    await new Promise((r) => setTimeout(r, 10));

    (doc.querySelector("#aw-next") as unknown as { click: () => void }).click();
    await new Promise((r) => setTimeout(r, 30));
    expect(doc.querySelector("#aw-step-6.visible")).toBeTruthy();
    expect(doc.querySelector("#aw-summary")).toBeTruthy();
    expect(doc.querySelector("#aw-summary")!.textContent).toContain("critical"); // band (added on step 3) in summary
    const affected = doc.querySelector("#aw-affected")!;
    expect(affected.textContent).toContain("3"); // stubbed preview totalEvaluated
    expect(toastErrors).toEqual([]);
  });

  it("step 6 lists the devices this automation WILL cover, never the carved-out ones", async () => {
    // The prod shape this exists for: an all-assets draft over a fleet whose
    // per-type automations already cover nearly all of it. Listing the
    // carved-out rows filled the window with devices the draft can never fire
    // about; the covered handful — the answer to "who does this alert on" —
    // was nowhere on screen.
    previewResponse = {
      supported: true,
      totalEvaluated: 4,
      totalAssets: 4,
      meetsCount: 0,
      coveredEvaluated: 1,
      coveredAssets: 1,
      specificity: { rank: 0, label: "All assets" },
      carveOut: { carvedOut: { count: 3, byRule: [{ ruleId: "ap", ruleName: "FortiAP Asset down", count: 3 }] } },
      matches: [
        { assetId: "k1", hostname: "kept-switch", dimension: "", value: null, meets: false },
        { assetId: "c1", hostname: "carved-ap-1", dimension: "", value: null, meets: false, excludedBy: { ruleId: "ap", ruleName: "FortiAP Asset down" } },
        { assetId: "c2", hostname: "carved-ap-2", dimension: "", value: null, meets: false, excludedBy: { ruleId: "ap", ruleName: "FortiAP Asset down" } },
        { assetId: "c3", hostname: "carved-ap-3", dimension: "", value: null, meets: false, excludedBy: { ruleId: "ap", ruleName: "FortiAP Asset down" } },
      ],
    };
    // Re-enter step 6 so renderAffectedDevices runs against the new answer.
    (doc.querySelector("#aw-back") as unknown as { click: () => void }).click();
    (doc.querySelector("#aw-next") as unknown as { click: () => void }).click();
    await new Promise((r) => setTimeout(r, 30));

    const affected = doc.querySelector("#aw-affected")!;
    const rows = Array.from(affected.querySelectorAll("tbody tr")).map((tr) => tr.textContent);
    expect(rows).toEqual(["kept-switch"]);
    // The carved-out devices are COUNTED (that part the operator liked) and
    // named by rule, but never listed row by row.
    expect(affected.textContent).toContain("4 device(s) match the filter");
    expect(affected.textContent).toContain("3 matched device(s) are already covered");
    expect(affected.textContent).toContain("will alert on the remaining 1 device(s)");
    expect(affected.textContent).not.toContain("carved-ap-1");
    expect(rows.join(" ")).not.toContain("covered by"); // the per-row annotation is gone with the rows

    previewResponse = DEFAULT_PREVIEW;
  });

  it("step 6 offers one send-to-me test per delivery, with no way to reach real recipients", async () => {
    const block = doc.querySelector("#aw-test-delivery")!;
    expect(block).toBeTruthy();

    // There is no recipient mode to mis-aim: the radios and the real-recipient
    // warning are GONE, so every button on this step delivers to the operator
    // who pressed it.
    expect(doc.querySelector('input[name="aw-test-to"]')).toBeNull();
    expect(doc.querySelector("#aw-test-real-warn")).toBeNull();
    expect(block.textContent).toContain("to you only");

    // The draft carries the default audit-Event action, so the Event test is
    // offered; api_call/script actions never are (the server refuses to run
    // them from a button, so a button would be a lie).
    const labels = Array.from(doc.querySelectorAll(".awtd-btn")).map((b) => b.textContent);
    expect(labels).toContain("Write a Test Event");
    expect(labels.join(" ")).not.toMatch(/script|API/i);
  });

  it("edit-mode round-trip: per-action escalation, band actions, device-region and the moved template survive save", async () => {
    // Fresh document — the previous wizard's modal would duplicate every id.
    doc.body.innerHTML = "";
    savedPayloads.length = 0;
    const chain = { stopOn: "clear", tiers: [{ afterMin: 20, actions: [{ type: "api_call", method: "POST", url: "https://pager.example.com/x", timeoutSec: 15 }] }] };
    const rule = {
      id: "r-edit",
      name: "Hot CPU",
      description: null,
      enabled: true,
      severity: "warning",
      trigger: { type: "asset_metric", metric: "cpuPct", aggregation: "avg", windowSec: 300, operator: ">", threshold: 90 },
      scope: { allAssets: true },
      reset: { mode: "auto", clearThreshold: 75 },
      cooldownSec: null,
      messageTemplate: "{asset} cpu {value}",
      actions: [{ type: "notify", channelId: "c1", recipientDeviceRegion: true, escalation: chain }],
      escalation: { stopOn: "acknowledge", tiers: [{ afterMin: 15, actions: [{ type: "notify", channelId: "c1", addresses: ["noc@example.com"] }] }] },
      severityBands: [{ threshold: 95, severity: "critical", actions: [{ type: "api_call", method: "POST", url: "https://x.example.com/crit", timeoutSec: 15 }] }],
      bandNotify: { onIncrease: true, onDecrease: false, onResolved: true, resolvedMode: "reuse" },
    };
    await (g.openAutomationWizard as (r: unknown) => Promise<void>)(rule);
    expect(toastErrors).toEqual([]);
    // Save straight from step 1 (edit mode): steps 4-6 were never rendered, so
    // the payload comes from the hydrated draft — the exact data-loss surface
    // this test pins.
    (doc.querySelector("#aw-save") as unknown as { click: () => void }).click();
    await new Promise((r) => setTimeout(r, 30));
    expect(toastErrors).toEqual([]);
    expect(savedPayloads).toHaveLength(1);
    const p = savedPayloads[0]! as Record<string, any>;
    expect(p.messageTemplate).toBe("{asset} cpu {value}");
    expect(p.actions).toHaveLength(1);
    expect(p.actions[0].recipientDeviceRegion).toBe(true);
    // Escalation is per SEVERITY now, so a stored per-ACTION chain is hoisted and
    // MERGED into the rule-level one rather than dropped: both ladders existed for
    // the base severity, and each tier carries its own actions, so one ladder in
    // time order delivers exactly what two did.
    expect(p.actions[0].escalation).toBeUndefined();
    expect(p.escalation.stopOn).toBe("acknowledge"); // the LEVEL's answer wins
    expect(p.escalation.tiers.map((t: { afterMin: number }) => t.afterMin)).toEqual([15, 20]);
    expect(p.escalation.tiers[1].actions[0]).toMatchObject({ type: "api_call", url: "https://pager.example.com/x" });
    expect(p.severityBands).toHaveLength(1);
    expect(p.severityBands[0].actions).toEqual(rule.severityBands[0].actions);
    // bandNotify does NOT round-trip verbatim any more: the band-level resolved
    // policy is retired on load (recovery is announced once, by the reset
    // actions), and what it announced is adopted into them.
    expect(p.bandNotify).toEqual({ onIncrease: true, onDecrease: false, onResolved: false });
    expect(p.resetActions).toHaveLength(1);
    // And the payload passes the real server-side schema.
    expect(() => ruleInputSchema.parse(p)).not.toThrow();
  });

  it("repeat control: hydrates from a stored rule and round-trips through save", async () => {
    doc.body.innerHTML = "";
    savedPayloads.length = 0;
    await (g.openAutomationWizard as (r: unknown) => Promise<void>)({
      id: "r-rep",
      name: "Repeating alert",
      description: null,
      enabled: true,
      severity: "warning",
      trigger: { type: "asset_metric", metric: "cpuPct", aggregation: "avg", windowSec: 300, operator: ">", threshold: 90 },
      scope: { allAssets: true },
      reset: { mode: "auto" },
      cooldownSec: null,
      messageTemplate: null,
      actions: [{ type: "notify", channelId: "c1", addresses: ["noc@example.com"] }],
      repeat: { everyMin: 20, stopOn: "clear", stopAfterHours: 8 },
    });
    expect(toastErrors).toEqual([]);

    // Step 5 renders the control checked, with the stored values.
    // Edit mode unlocks every step, so jump via the stepper.
    (doc.querySelectorAll("#aw-stepper .stepper-step")[4] as unknown as { click: () => void }).click();
    await new Promise((r) => setTimeout(r, 10));
    const on = doc.querySelector("#aw-repeat-on") as unknown as { checked: boolean } | null;
    const every = doc.querySelector("#aw-repeat-every") as unknown as { value: string } | null;
    const stopOn = doc.querySelector("#aw-repeat-stopon") as unknown as { value: string } | null;
    const after = doc.querySelector("#aw-repeat-stopafter") as unknown as { value: string } | null;
    expect(on?.checked).toBe(true);
    expect(every?.value).toBe("20");
    expect(stopOn?.value).toBe("clear");
    expect(after?.value).toBe("8");

    (doc.querySelector("#aw-save") as unknown as { click: () => void }).click();
    await new Promise((r) => setTimeout(r, 30));
    expect(toastErrors).toEqual([]);
    const payload = savedPayloads[0]! as Record<string, any>;
    expect(payload.repeat).toEqual({ everyMin: 20, stopOn: "clear", stopAfterHours: 8 });
    expect(() => ruleInputSchema.parse(payload)).not.toThrow();
  });

  it("repeat control: omits stopAfterHours when blank, which is the unbounded default", async () => {
    doc.body.innerHTML = "";
    savedPayloads.length = 0;
    await (g.openAutomationWizard as (r: unknown) => Promise<void>)({
      id: "r-rep2",
      name: "Unbounded",
      description: null,
      enabled: true,
      severity: "warning",
      trigger: { type: "asset_metric", metric: "cpuPct", aggregation: "avg", windowSec: 300, operator: ">", threshold: 90 },
      scope: { allAssets: true },
      reset: { mode: "auto" },
      cooldownSec: null,
      messageTemplate: null,
      actions: [{ type: "notify", channelId: "c1", addresses: ["noc@example.com"] }],
      repeat: { everyMin: 15, stopOn: "acknowledge" },
    });
    // Edit mode unlocks every step, so jump via the stepper.
    (doc.querySelectorAll("#aw-stepper .stepper-step")[4] as unknown as { click: () => void }).click();
    await new Promise((r) => setTimeout(r, 10));
    const after = doc.querySelector("#aw-repeat-stopafter") as unknown as { value: string } | null;
    expect(after?.value).toBe("");

    (doc.querySelector("#aw-save") as unknown as { click: () => void }).click();
    await new Promise((r) => setTimeout(r, 30));
    const payload = savedPayloads[0]! as Record<string, any>;
    expect(payload.repeat).toEqual({ everyMin: 15, stopOn: "acknowledge" });
    expect(payload.repeat).not.toHaveProperty("stopAfterHours");
  });

  it("repeat control: an automation that does not repeat saves repeat: null", async () => {
    doc.body.innerHTML = "";
    savedPayloads.length = 0;
    await (g.openAutomationWizard as (r: unknown) => Promise<void>)({
      id: "r-norep",
      name: "No reminders",
      description: null,
      enabled: true,
      severity: "warning",
      trigger: { type: "asset_metric", metric: "cpuPct", aggregation: "avg", windowSec: 300, operator: ">", threshold: 90 },
      scope: { allAssets: true },
      reset: { mode: "auto" },
      cooldownSec: null,
      messageTemplate: null,
      actions: [{ type: "notify", channelId: "c1", addresses: ["noc@example.com"] }],
    });
    // Edit mode unlocks every step, so jump via the stepper.
    (doc.querySelectorAll("#aw-stepper .stepper-step")[4] as unknown as { click: () => void }).click();
    await new Promise((r) => setTimeout(r, 10));
    const on = doc.querySelector("#aw-repeat-on") as unknown as { checked: boolean } | null;
    expect(on?.checked).toBe(false);
    // The fields stay hidden until it is turned on.
    const fields = doc.querySelector("#aw-repeat-fields") as unknown as { hidden: boolean } | null;
    expect(fields?.hidden).toBe(true);

    (doc.querySelector("#aw-save") as unknown as { click: () => void }).click();
    await new Promise((r) => setTimeout(r, 30));
    expect((savedPayloads[0] as Record<string, any>).repeat).toBeNull();
  });

  it("action rows fold to their summary, closed by default — and a row you ADD opens", async () => {
    doc.body.innerHTML = "";
    savedPayloads.length = 0;
    const w = g.window as InstanceType<typeof Window>;
    await (g.openAutomationWizard as (r: unknown) => Promise<void>)({
      id: "r-fold5",
      name: "Folded actions",
      description: null,
      enabled: true,
      severity: "warning",
      trigger: { type: "asset_metric", metric: "cpuPct", aggregation: "avg", windowSec: 300, operator: ">=", threshold: 80, forDurationSec: 300 },
      scope: { allAssets: true },
      reset: { mode: "auto" },
      cooldownSec: null,
      actions: [
        { type: "event" },
        { type: "notify", channelId: "c1", addresses: ["noc@example.invalid"] },
      ],
      severityBands: [{ threshold: 95, severity: "critical", actions: [{ type: "notify", channelId: "c1", addresses: ["oncall@example.invalid"] }] }],
      bandNotify: { onIncrease: true, onDecrease: false, onResolved: false },
    });
    (doc.querySelector('.stepper-step[data-step="5"]') as unknown as { click: () => void }).click();

    const rows = Array.from(doc.querySelectorAll("#aw-step-5 .aw-action"));
    expect(rows.length).toBeGreaterThan(1);
    // Every stored row lands folded: a per-severity ladder is several action
    // lists deep, each with a channel picker, recipients, an email body and an
    // escalation footer.
    rows.forEach((r) => {
      expect(r.querySelector(":scope > .aw-collapse")).toBeFalsy();      // it's in the header
      expect(r.querySelector(":scope > div > .aw-collapse")).toBeTruthy();
      const fields = r.querySelector(":scope > .aw-action-fields") as unknown as { style: { display: string } };
      expect(fields.style.display).toBe("none");
    });
    // The summary is what a folded row shows, so it has to say something.
    const notifyRow = rows.find((r) =>
      (r.querySelector(".aw-action-type") as HTMLSelectElement | null)?.value === "notify")!;
    expect((notifyRow.querySelector(".aw-action-summary") as unknown as { textContent: string }).textContent!.length)
      .toBeGreaterThan(0);

    // The chevron opens it.
    (notifyRow.querySelector(":scope > div > .aw-collapse") as unknown as { dispatchEvent: (e: unknown) => void })
      .dispatchEvent(new w.Event("click", { bubbles: true }));
    expect((notifyRow.querySelector(":scope > .aw-action-fields") as unknown as { style: { display: string } }).style.display)
      .not.toBe("none");

    // A row the operator ADDS opens — you don't create an action to read its summary.
    const before = doc.querySelectorAll("#aw-step-5 #aw-actions .aw-action").length;
    (doc.querySelector("#aw-add-action") as unknown as { click: () => void }).click();
    const added = Array.from(doc.querySelectorAll("#aw-step-5 #aw-actions .aw-action"));
    expect(added.length).toBe(before + 1);
    const fresh = added[added.length - 1]!;
    expect((fresh.querySelector(":scope > .aw-action-fields") as unknown as { style: { display: string } }).style.display)
      .not.toBe("none");
    // Drop it again: an empty notify has no recipients, so saving with it would
    // (correctly) fail validation — and toastErrors is module-scoped in this
    // suite, so a deliberate error here leaks into every later test.
    (fresh.querySelector(".aw-action-remove") as unknown as { click: () => void }).click();

    // Folding is presentation only — the payload is unchanged.
    (doc.querySelector("#aw-save") as unknown as { click: () => void }).click();
    await new Promise((r) => setTimeout(r, 30));
    expect(toastErrors).toEqual([]);
    const p = savedPayloads[0]! as Record<string, any>;
    expect(p.actions.map((a: { type: string }) => a.type)).toContain("notify");
    expect(() => ruleInputSchema.parse(p)).not.toThrow();
  });

  it("retires the band 'Resolved' notify and moves what it announced into the reset actions", async () => {
    // Recovery is announced ONCE, by the reset actions. The band-level resolved
    // policy was a second mechanism for the same event and the engine ran both
    // (fireResolved, then fireReset from recover()), so a banded automation with
    // reset actions told people twice. Removing the control must not make a
    // stored rule that relied on it go silent — hence the adoption.
    doc.body.innerHTML = "";
    savedPayloads.length = 0;
    await (g.openAutomationWizard as (r: unknown) => Promise<void>)({
      id: "r-res",
      name: "Banded",
      description: null,
      enabled: true,
      severity: "warning",
      trigger: { type: "asset_metric", metric: "cpuPct", aggregation: "avg", windowSec: 300, operator: ">=", threshold: 80, forDurationSec: 300 },
      scope: { allAssets: true },
      reset: { mode: "auto" },
      cooldownSec: null,
      actions: [{ type: "notify", channelId: "c1", addresses: ["noc@example.invalid"] }],
      severityBands: [{ threshold: 95, severity: "critical", actions: [] }],
      // The retired policy: announce recovery by reusing the alert's actions,
      // with no reset actions of its own.
      bandNotify: { onIncrease: true, onDecrease: false, onResolved: true, resolvedMode: "reuse" },
      resetActions: null,
    });
    // The control is gone from the notify policy...
    (doc.querySelector('.stepper-step[data-step="3"]') as unknown as { click: () => void }).click();
    expect(doc.querySelector("#aw-bn-resolved")).toBeFalsy();
    expect(doc.querySelector("#aw-bn-resolved-mode")).toBeFalsy();
    // ...and the two that remain are untouched. Nothing replaces it: this list is
    // what to notify on as the severity MOVES, and pointing at another step from
    // here would be a note explaining a control that is no longer there.
    expect(doc.querySelector("#aw-bn-increase")).toBeTruthy();
    expect(doc.querySelector("#aw-bn-decrease")).toBeTruthy();
    expect((doc.querySelector("#aw-band-notify") as unknown as { textContent: string }).textContent)
      .not.toMatch(/resolved|when this resets/i);

    (doc.querySelector("#aw-save") as unknown as { click: () => void }).click();
    await new Promise((r) => setTimeout(r, 30));
    expect(toastErrors).toEqual([]);
    const p = savedPayloads[0]! as Record<string, any>;
    // Written FALSE, not omitted: the server defaults it true, so omitting it
    // would keep the duplicate.
    expect(p.bandNotify.onResolved).toBe(false);
    expect(p.bandNotify.resolvedActions).toBeUndefined();
    // What "reuse the alert's actions" announced now rides the reset actions.
    expect(p.resetActions).toHaveLength(1);
    expect(p.resetActions[0]).toMatchObject({ type: "notify", channelId: "c1" });
    // An escalation would be meaningless on a recovery (and the server rejects it).
    expect(p.resetActions[0].escalation).toBeUndefined();
    expect(() => ruleInputSchema.parse(p)).not.toThrow();
  });

  it("leaves reset actions the operator already wrote alone", async () => {
    doc.body.innerHTML = "";
    savedPayloads.length = 0;
    await (g.openAutomationWizard as (r: unknown) => Promise<void>)({
      id: "r-res2",
      name: "Banded2",
      description: null,
      enabled: true,
      severity: "warning",
      trigger: { type: "asset_metric", metric: "cpuPct", aggregation: "avg", windowSec: 300, operator: ">=", threshold: 80, forDurationSec: 300 },
      scope: { allAssets: true },
      reset: { mode: "auto" },
      cooldownSec: null,
      actions: [{ type: "notify", channelId: "c1", addresses: ["noc@example.invalid"] }],
      severityBands: [{ threshold: 95, severity: "critical", actions: [] }],
      bandNotify: { onIncrease: true, onDecrease: false, onResolved: true, resolvedMode: "dedicated", resolvedActions: [{ type: "event" }] },
      // The operator has already said what recovery does — adoption must not
      // overwrite it.
      resetActions: [{ type: "notify", channelId: "c1", addresses: ["ops@example.invalid"] }],
    });
    (doc.querySelector("#aw-save") as unknown as { click: () => void }).click();
    await new Promise((r) => setTimeout(r, 30));
    expect(toastErrors).toEqual([]);
    const p = savedPayloads[0]! as Record<string, any>;
    expect(p.resetActions).toHaveLength(1);
    expect(p.resetActions[0].addresses).toEqual(["ops@example.invalid"]);
    expect(p.bandNotify.onResolved).toBe(false);
  });

  it("a new automation seeds an audit Event on BOTH halves, and emptying the reset list unticks it", async () => {
    // The fire actions have carried a default "Create an Event" row since the
    // Event became an action; the reset list now does too, so a recovery is
    // recorded the way the firing is. And a ticked "When this resets" over an
    // empty list is a lie — collectStep5 saves an empty list as null, so the box
    // would come back unticked on the next open anyway.
    doc.body.innerHTML = "";
    savedPayloads.length = 0;
    toastErrors = [];
    await (g.openAutomationWizard as (r: unknown) => Promise<void>)(null);
    (doc.querySelector("#aw-name") as unknown as { value: string }).value = "reset-default";
    const next = () => (doc.querySelector("#aw-next") as unknown as { click: () => void }).click();
    next(); await new Promise((r) => setTimeout(r, 20));   // → devices
    next(); await new Promise((r) => setTimeout(r, 20));   // → trigger
    (doc.querySelector("#aw-trig-root .tgl-threshold") as unknown as { value: string }).value = "90";
    next(); await new Promise((r) => setTimeout(r, 20));   // → reset
    next(); await new Promise((r) => setTimeout(r, 20));   // → actions
    expect(doc.querySelector("#aw-step-5.visible")).toBeTruthy();
    expect(toastErrors).toEqual([]);

    const typeOf = (row: Element) => (row.querySelector(".aw-action-type") as HTMLSelectElement | null)?.value;
    // Fires: the default Event row.
    expect(Array.from(doc.querySelectorAll("#aw-actions > .aw-action")).map(typeOf)).toEqual(["event"]);
    // Resets: the same default, and the toggle on to match.
    expect((doc.querySelector("#aw-reset-actions-on") as unknown as { checked: boolean }).checked).toBe(true);
    const resetRows = Array.from(doc.querySelectorAll("#aw-reset-actions > .aw-action"));
    expect(resetRows.map(typeOf)).toEqual(["event"]);
    // It was never mirrorable, so the note must not read as "edited".
    expect(doc.querySelector("#aw-reset-mirror-note")!.textContent).toContain("Add a Notify above");

    // Removing the last row unticks the toggle and folds the list away.
    (resetRows[0]!.querySelector(".aw-action-remove") as unknown as { click: () => void }).click();
    await new Promise((r) => setTimeout(r, 10));
    expect(doc.querySelector("#aw-reset-actions > .aw-action")).toBeFalsy();
    expect((doc.querySelector("#aw-reset-actions-on") as unknown as { checked: boolean }).checked).toBe(false);
    expect((doc.querySelector("#aw-reset-wrap") as unknown as { style: { display: string } }).style.display).toBe("none");

    (doc.querySelector("#aw-save") as unknown as { click: () => void }).click();
    await new Promise((r) => setTimeout(r, 30));
    expect(toastErrors).toEqual([]);
    const p = savedPayloads[0]! as Record<string, any>;
    expect(p.resetActions).toBeNull();
    expect(p.actions).toHaveLength(1);
    expect(p.actions[0]).toMatchObject({ type: "event" });
    expect(() => ruleInputSchema.parse(p)).not.toThrow();
  });

  it("words a tier's condition identically on the trigger and actions steps", async () => {
    // The two severity surfaces used to phrase the same tier differently: step 3
    // said "is at or above 95 for 1 min" while step 5 said "(value is at or above
    // 95)" and dropped the hold entirely, so the same tier read as two different
    // conditions depending on which step you were on. One shared builder now
    // produces both, and this pins that they agree — including the per-tier hold
    // override, which step 5 did not show at all.
    doc.body.innerHTML = "";
    const w = g.window as InstanceType<typeof Window>;
    await (g.openAutomationWizard as (r: unknown) => Promise<void>)({
      id: "r-phrase",
      name: "Phrase",
      description: null,
      enabled: true,
      severity: "warning",
      trigger: { type: "asset_metric", metric: "cpuPct", aggregation: "avg", windowSec: 300, operator: ">=", threshold: 70, forDurationSec: 300 },
      scope: { allAssets: true },
      reset: { mode: "auto" },
      cooldownSec: null,
      actions: [{ type: "notify", channelId: "c1", addresses: ["noc@example.invalid"] }],
      severityBands: [
        { threshold: 85, severity: "serious", actions: [] },
        // Its OWN hold, shorter than the base — the case step 5 was silent about.
        { threshold: 95, severity: "critical", forDurationSec: 60, actions: [{ type: "event" }] },
      ],
      bandNotify: { onIncrease: true, onDecrease: false, onResolved: true, resolvedMode: "reuse" },
    });

    // Step 3: fold each tier so it states its own condition.
    (doc.querySelector('.stepper-step[data-step="3"]') as unknown as { click: () => void }).click();
    const phraseFor = (el: Element): string => {
      (el.querySelector("[data-collapse]") as unknown as { dispatchEvent: (e: unknown) => void })
        .dispatchEvent(new w.Event("click", { bubbles: true }));
      const txt = (el.querySelector(".aw-collapse-summary") as unknown as { textContent: string }).textContent.trim();
      (el.querySelector("[data-collapse]") as unknown as { dispatchEvent: (e: unknown) => void })
        .dispatchEvent(new w.Event("click", { bubbles: true }));
      return txt;
    };
    const trigBase = phraseFor(doc.querySelector("#aw-trig-root > .scg-group")!);
    const trigTiers = Array.from(doc.querySelectorAll("#aw-step-3 .aw-band")).map(phraseFor);
    // The base states the 5 minutes its own duration field holds. No tier shows
    // a hold: an AGGREGATED trigger's period is its measurement WINDOW, not a
    // hold (rule 19: tiers share the sampling), and since 2026-08-28 a tier
    // cannot carry one of its own either — `critical` arrived with 60s and the
    // step-3 round trip drops it, which is exactly why step 5 has to agree.
    // What matters for this test is that both steps say the SAME three things.
    // "5 minutes", not "5 min": both steps read the hold through the shared
    // holdPhrase/humanDuration pair now, which is what keeps them identical.
    expect(trigBase).toBe("is at or above 70 for 5 minutes");
    expect(trigTiers).toEqual(["is at or above 85", "is at or above 95"]);

    // Step 5: the same phrases, from the draft rather than the DOM controls, and
    // visible without folding (there are no controls there to read them off).
    (doc.querySelector('.stepper-step[data-step="5"]') as unknown as { click: () => void }).click();
    const multi = doc.querySelector("#aw-band-actions-multi") as unknown as
      { checked: boolean; dispatchEvent: (e: unknown) => void };
    if (!multi.checked) {
      multi.checked = true;
      multi.dispatchEvent(new w.Event("change", { bubbles: true }));
    }
    const actionPhrases = Array.from(doc.querySelectorAll("#aw-step-5 [data-collapse-key]"))
      .map((sec) => {
        const el = sec.querySelector(".aw-tier-cond") as unknown as { textContent: string } | null;
        return el ? el.textContent.trim() : "";
      });
    expect(actionPhrases).toEqual([trigBase, trigTiers[0], trigTiers[1]]);

    // The old wording is gone from the actions step: no parenthesised "value"
    // restatement competing with the shared phrase.
    expect((doc.querySelector("#aw-step-5") as unknown as { textContent: string }).textContent)
      .not.toMatch(/\(value is at or above/);
  });

  it("severity blocks fold, and the fold survives a re-render", async () => {
    doc.body.innerHTML = "";
    savedPayloads.length = 0;
    const w = g.window as InstanceType<typeof Window>;
    await (g.openAutomationWizard as (r: unknown) => Promise<void>)({
      id: "r-fold",
      name: "Fold",
      description: null,
      enabled: true,
      severity: "warning",
      trigger: { type: "asset_metric", metric: "cpuPct", aggregation: "avg", windowSec: 300, operator: ">=", threshold: 80, forDurationSec: 300 },
      scope: { allAssets: true },
      reset: { mode: "auto" },
      cooldownSec: null,
      actions: [{ type: "notify", channelId: "c1", addresses: ["noc@example.com"] }],
      severityBands: [
        { threshold: 90, severity: "serious", actions: [] },
        { threshold: 95, severity: "critical", actions: [{ type: "event" }] },
      ],
      bandNotify: { onIncrease: true, onDecrease: false, onResolved: true, resolvedMode: "reuse" },
    });

    // ── Step 3: each tier folds ──
    (doc.querySelector('.stepper-step[data-step="3"]') as unknown as { click: () => void }).click();
    // The BASE block folds too — it was the one severity block without a
    // chevron, which made it read as a different kind of thing.
    const base = doc.querySelector("#aw-trig-root > .scg-group")!;
    expect(base.getAttribute("data-collapse-key")).toBe("t3:base");
    expect(base.querySelector(":scope > div > .aw-collapse")).toBeTruthy();
    const baseParts = Array.from(base.querySelectorAll(":scope > .aw-collapse-part"));
    expect(baseParts.length).toBeGreaterThan(0);
    (base.querySelector("[data-collapse]") as unknown as { dispatchEvent: (e: unknown) => void })
      .dispatchEvent(new w.Event("click", { bubbles: true }));
    // Its parts hide in place rather than being moved into a wrapper — moving
    // .scg-children would break tgCollectGroup.
    baseParts.forEach((p) => {
      expect((p as unknown as { style: { display: string } }).style.display).toBe("none");
    });
    expect((base.querySelector(".aw-collapse-summary") as unknown as { textContent: string }).textContent)
      .toContain("80");
    (base.querySelector("[data-collapse]") as unknown as { dispatchEvent: (e: unknown) => void })
      .dispatchEvent(new w.Event("click", { bubbles: true }));

    const tiers = Array.from(doc.querySelectorAll("#aw-step-3 .aw-band"));
    expect(tiers.length).toBe(2);
    // Keyed by SEVERITY, not index — removing a tier must not slide another
    // tier's fold state onto it.
    expect(tiers.map((t) => t.getAttribute("data-collapse-key"))).toEqual(["t3:serious", "t3:critical"]);

    const tier = tiers[1]!;
    const body = tier.querySelector(".aw-collapse-body") as unknown as { style: { display: string } };
    const summary = tier.querySelector(".aw-collapse-summary") as unknown as
      { style: { display: string }; textContent: string };
    expect(body.style.display).not.toBe("none");
    // The summary describes the tier from its own controls, so a folded block
    // still says what it does.
    expect(summary.textContent).toContain("95");

    (tier.querySelector("[data-collapse]") as unknown as { dispatchEvent: (e: unknown) => void })
      .dispatchEvent(new w.Event("click", { bubbles: true }));
    expect(body.style.display).toBe("none");
    expect(summary.style.display).not.toBe("none");
    // The base tier is untouched by folding a band.
    expect((tiers[0]!.querySelector(".aw-collapse-body") as unknown as { style: { display: string } }).style.display)
      .not.toBe("none");

    // ── Step 5: per-severity action sections fold, and step 3's fold survived
    // the panel renders in between (the state is keyed, not held on the node) ──
    (doc.querySelector('.stepper-step[data-step="5"]') as unknown as { click: () => void }).click();
    const multi = doc.querySelector("#aw-band-actions-multi") as unknown as
      { checked: boolean; dispatchEvent: (e: unknown) => void };
    if (!multi.checked) {
      multi.checked = true;
      multi.dispatchEvent(new w.Event("change", { bubbles: true }));
    }
    const sections = Array.from(doc.querySelectorAll("#aw-step-5 [data-collapse-key]"));
    expect(sections.map((x) => x.getAttribute("data-collapse-key")))
      .toEqual(["t5:base", "t5:serious", "t5:critical"]);
    // Folded on arrival: with a ladder this step is three action lists, and each
    // header's summary says enough to choose between them. (Step 3's tiers stay
    // open — their content is the condition being edited.)
    sections.forEach((sec) => {
      expect(sec.getAttribute("data-collapse-default")).toBe("closed");
      expect((sec.querySelector(".aw-collapse-body") as unknown as { style: { display: string } }).style.display)
        .toBe("none");
    });
    // A band with no actions of its own says so while folded — that's the state
    // that falls back to the base actions.
    const serious = sections[1]!;
    expect((serious.querySelector(".aw-collapse-summary") as unknown as { textContent: string }).textContent)
      .toMatch(/no actions of its own/i);

    (doc.querySelector('.stepper-step[data-step="3"]') as unknown as { click: () => void }).click();
    const criticalAgain = Array.from(doc.querySelectorAll("#aw-step-3 .aw-band"))
      .find((t) => t.getAttribute("data-collapse-key") === "t3:critical")!;
    expect((criticalAgain.querySelector(".aw-collapse-body") as unknown as { style: { display: string } }).style.display)
      .toBe("none");

    // Folding changes nothing about what saves.
    (doc.querySelector("#aw-save") as unknown as { click: () => void }).click();
    await new Promise((r) => setTimeout(r, 30));
    expect(toastErrors).toEqual([]);
    const p = savedPayloads[0]! as Record<string, any>;
    expect(p.severityBands).toHaveLength(2);
    expect(p.severityBands.map((b: { severity: string }) => b.severity)).toEqual(["serious", "critical"]);
    expect(() => ruleInputSchema.parse(p)).not.toThrow();
  });

  it("requiring a note to acknowledge rides the in-app alert card, and survives a save", async () => {
    // The flag belongs to the ALERT record, so it lives on the mandatory in-app
    // card beside the message template — not on a Notify row, where it would
    // read as being about one email while it governs every acknowledge path.
    doc.body.innerHTML = "";
    savedPayloads.length = 0;
    await (g.openAutomationWizard as (r: unknown) => Promise<void>)({
      id: "r-acknote",
      name: "Loss",
      description: null,
      enabled: true,
      severity: "warning",
      trigger: { type: "asset_metric", metric: "cpuPct", aggregation: "avg", windowSec: 300, operator: ">", threshold: 90 },
      scope: { allAssets: true },
      reset: { mode: "auto" },
      cooldownSec: null,
      actions: [{ type: "event" }],
    });
    (doc.querySelector('.stepper-step[data-step="5"]') as unknown as { click: () => void }).click();

    const box = doc.querySelector("#aw-inapp-card #aw-require-ack-note") as unknown as
      { checked: boolean };
    expect(box).toBeTruthy();
    // Off for every automation that predates the feature.
    expect(box.checked).toBe(false);
    box.checked = true;

    (doc.querySelector("#aw-save") as unknown as { click: () => void }).click();
    await new Promise((r) => setTimeout(r, 30));
    expect(toastErrors).toEqual([]);
    const p = savedPayloads[0]! as Record<string, any>;
    expect(p.requireAckNote).toBe(true);
    expect(() => ruleInputSchema.parse(p)).not.toThrow();
  });

  it("carries a stored requireAckNote through a save from step 1 (never visiting the Actions step)", async () => {
    // The wizard saves from the hydrated draft, so a field only collected on
    // step 5 is exactly the kind that silently reverts to its default when an
    // operator edits the name and saves.
    doc.body.innerHTML = "";
    savedPayloads.length = 0;
    await (g.openAutomationWizard as (r: unknown) => Promise<void>)({
      id: "r-acknote2",
      name: "Loss",
      description: null,
      enabled: true,
      severity: "warning",
      trigger: { type: "asset_metric", metric: "cpuPct", aggregation: "avg", windowSec: 300, operator: ">", threshold: 90 },
      scope: { allAssets: true },
      reset: { mode: "auto" },
      cooldownSec: null,
      requireAckNote: true,
      actions: [{ type: "event" }],
    });
    (doc.querySelector("#aw-save") as unknown as { click: () => void }).click();
    await new Promise((r) => setTimeout(r, 30));
    expect(toastErrors).toEqual([]);
    expect((savedPayloads[0]! as Record<string, any>).requireAckNote).toBe(true);
  });

  it("email customization is a checkbox: unchecked stores NO templates", async () => {
    doc.body.innerHTML = "";
    savedPayloads.length = 0;
    await (g.openAutomationWizard as (r: unknown) => Promise<void>)({
      id: "r-mail",
      name: "Mail",
      description: null,
      enabled: true,
      severity: "warning",
      trigger: { type: "asset_metric", metric: "cpuPct", aggregation: "avg", windowSec: 300, operator: ">", threshold: 90 },
      scope: { allAssets: true },
      reset: { mode: "auto" },
      cooldownSec: null,
      actions: [{ type: "notify", channelId: "c1", addresses: ["noc@example.com"] }],
    });
    (doc.querySelector('.stepper-step[data-step="5"]') as unknown as { click: () => void }).click();

    const comp = doc.querySelector("#aw-step-5 .na-comp")!;
    const enable = comp.querySelector(".na-comp-enable") as unknown as
      { checked: boolean; dispatchEvent: (e: unknown) => void };
    // A stored action carrying no templates opens UNCHECKED — it follows the
    // shared default rather than owning a frozen copy of it.
    expect(enable.checked).toBe(false);
    expect((comp.querySelector(".na-comp-body") as unknown as { style: { display: string } }).style.display)
      .toBe("none");
    // The old disclosure is gone.
    expect(doc.querySelector("#aw-step-5 details.na-comp")).toBeFalsy();
    // ...but the fields ARE prefilled from the default, so ticking shows real text.
    expect(((comp.querySelector(".na-subject") as unknown as { value: string }).value || "").length)
      .toBeGreaterThan(0);

    (doc.querySelector("#aw-save") as unknown as { click: () => void }).click();
    await new Promise((r) => setTimeout(r, 30));
    expect(toastErrors).toEqual([]);
    const p = savedPayloads[0]! as Record<string, any>;
    const comp0 = p.actions[0].emailComposition;
    // No templates collected while unchecked (cc/bcc would still ride here).
    expect(comp0?.subjectTemplate).toBeUndefined();
    expect(comp0?.bodyTextTemplate).toBeUndefined();
    expect(comp0?.bodyHtmlTemplate).toBeUndefined();
    expect(() => ruleInputSchema.parse(p)).not.toThrow();
  });

  it("checked, it stores BOTH bodies; the Plain/HTML control is a view switch", async () => {
    doc.body.innerHTML = "";
    savedPayloads.length = 0;
    await (g.openAutomationWizard as (r: unknown) => Promise<void>)({
      id: "r-mail2",
      name: "Mail2",
      description: null,
      enabled: true,
      severity: "warning",
      trigger: { type: "asset_metric", metric: "cpuPct", aggregation: "avg", windowSec: 300, operator: ">", threshold: 90 },
      scope: { allAssets: true },
      reset: { mode: "auto" },
      cooldownSec: null,
      // Carries its own subject → the box opens checked.
      actions: [{
        type: "notify",
        channelId: "c1",
        addresses: ["noc@example.com"],
        emailComposition: { subjectTemplate: "MINE {asset}" },
      }],
    });
    (doc.querySelector('.stepper-step[data-step="5"]') as unknown as { click: () => void }).click();

    const comp = doc.querySelector("#aw-step-5 .na-comp")!;
    expect((comp.querySelector(".na-comp-enable") as unknown as { checked: boolean }).checked).toBe(true);
    expect((comp.querySelector(".na-comp-body") as unknown as { style: { display: string } }).style.display)
      .not.toBe("none");
    // The "Send an HTML body" checkbox is gone — it never controlled whether
    // HTML was sent (a blank template already fell back to the default HTML).
    expect(comp.querySelector(".na-html-enable")).toBeFalsy();

    const text = comp.querySelector('[data-body-mode="text"]') as unknown as
      { style: { display: string }; value: string };
    const html = comp.querySelector('[data-body-mode="html"]') as unknown as
      { style: { display: string }; value: string };
    expect(text.style.display).not.toBe("none");
    expect(html.style.display).toBe("none");
    // Variables are visible in both modes rather than hidden behind a second
    // disclosure — the palette sits above the editor.
    expect(comp.querySelectorAll(".tpl-token").length).toBeGreaterThan(0);

    const w = g.window as InstanceType<typeof Window>;
    const modes = Array.from(comp.querySelectorAll(".na-mode"));
    (modes[1] as unknown as { dispatchEvent: (e: unknown) => void })
      .dispatchEvent(new w.Event("click", { bubbles: true }));
    expect(text.style.display).toBe("none");
    expect(html.style.display).not.toBe("none");
    // A view switch touches no value.
    text.value = "PLAIN {asset}";
    html.value = "<p>HTML {asset}</p>";

    (doc.querySelector("#aw-save") as unknown as { click: () => void }).click();
    await new Promise((r) => setTimeout(r, 30));
    expect(toastErrors).toEqual([]);
    const c = (savedPayloads[0]! as Record<string, any>).actions[0].emailComposition;
    // BOTH bodies stored: the toggle chose which one was on screen, not which
    // one gets sent.
    expect(c.bodyTextTemplate).toBe("PLAIN {asset}");
    expect(c.bodyHtmlTemplate).toBe("<p>HTML {asset}</p>");
    expect(() => ruleInputSchema.parse(savedPayloads[0])).not.toThrow();
  });

  it("the trigger's single hold saves and per-tier holds are dropped; unticking per-severity actions strips them", async () => {
    doc.body.innerHTML = "";
    savedPayloads.length = 0;
    const win = g.window as InstanceType<typeof Window>;
    const rule = {
      id: "r-sustain",
      // cpuPct, not packet loss: the hold is the thing under test, and a
      // windowed-ratio metric measures over a window instead (business rule 29).
      name: "High CPU",
      description: null,
      enabled: true,
      severity: "warning",
      trigger: { type: "asset_metric", metric: "cpuPct", aggregation: "latest", windowSec: 0, operator: ">", threshold: 5, forDurationSec: 1800 },
      scope: { allAssets: true },
      reset: { mode: "auto" },
      cooldownSec: null,
      messageTemplate: null,
      actions: [{ type: "notify", channelId: "c1", recipientDeviceRegion: true }],
      escalation: null,
      severityBands: [
        { threshold: 15, severity: "serious", forDurationSec: 900, actions: [{ type: "api_call", method: "POST", url: "https://x.example.com/s", timeoutSec: 15 }] },
        { threshold: 25, severity: "critical", forDurationSec: 0, actions: [] },
      ],
      bandNotify: { onIncrease: true, onDecrease: false, onResolved: true, resolvedMode: "reuse" },
    };
    await (g.openAutomationWizard as (r: unknown) => Promise<void>)(rule);
    for (let i = 0; i < 4; i++) {
      (doc.querySelector("#aw-next") as unknown as { click: () => void }).click();
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(toastErrors).toEqual([]);
    expect(doc.querySelector("#aw-step-5.visible")).toBeTruthy();
    // No tier has a hold field to keep: there is one, on the trigger, counted in
    // POLLS — 1800s at the stubbed 120s cadence reads as 15 polls.
    expect(doc.querySelector("#aw-bands .band-duration")).toBeNull();
    expect((doc.querySelector("#tf-duration-min") as unknown as { value: string }).value).toBe("15");
    // The stored rule carries per-band actions, so the toggle opens ON.
    const perSevCb = doc.querySelector("#aw-band-actions-multi") as unknown as { checked: boolean; dispatchEvent: (e: unknown) => void };
    expect(perSevCb.checked).toBe(true);
    perSevCb.checked = false;
    perSevCb.dispatchEvent(new win.Event("change", { bubbles: true }));

    (doc.querySelector("#aw-save") as unknown as { click: () => void }).click();
    await new Promise((r) => setTimeout(r, 30));
    expect(toastErrors).toEqual([]);
    const p = savedPayloads[0]! as Record<string, any>;
    expect(p.trigger.forDurationSec).toBe(1800);
    // The tiers' own holds are gone rather than flattened to a number the
    // builder never showed: each band inherits the trigger's (resolveTierLadder).
    expect(p.severityBands.map((b: any) => b.forDurationSec)).toEqual([undefined, undefined]);
    // Toggle off ⇒ bands save bare and the server runs the base actions at
    // every severity.
    expect(p.severityBands[0].actions).toEqual([]);
    expect(p.severity).toBe("warning");
    expect(p.severityBands.map((b: any) => b.severity)).toEqual(["serious", "critical"]);
    expect(() => ruleInputSchema.parse(p)).not.toThrow();
  });

  it("changing the base condition's sampling re-mirrors onto every existing severity tier", async () => {
    // Tiers SHARE the base's metric / aggregation / dimension filters (business
    // rule 19) — collectBands takes only their operator + threshold. A tier left
    // displaying the sampling it was created with told the operator the change
    // hadn't applied, and deleting + re-adding every tier was the only way to
    // make the display agree with what would actually be saved.
    doc.body.innerHTML = "";
    savedPayloads.length = 0;
    const win = g.window as InstanceType<typeof Window>;
    await (g.openAutomationWizard as (r: unknown) => Promise<void>)({
      id: "r-resample",
      name: "Packet loss",
      description: null,
      enabled: true,
      severity: "warning",
      trigger: { type: "asset_metric", metric: "probeLossPct", aggregation: "latest", windowSec: 0, operator: ">", threshold: 5, forDurationSec: 300 },
      scope: { allAssets: true },
      reset: { mode: "auto" },
      cooldownSec: null,
      messageTemplate: null,
      actions: [{ type: "notify", channelId: "c1", recipientDeviceRegion: true }],
      escalation: null,
      severityBands: [
        { threshold: 15, severity: "serious", forDurationSec: 300, actions: [] },
        { threshold: 25, severity: "critical", operator: ">=", forDurationSec: 60, actions: [] },
      ],
      bandNotify: { onIncrease: true, onDecrease: false, onResolved: true, resolvedMode: "reuse" },
    });
    for (let i = 0; i < 2; i++) {
      (doc.querySelector("#aw-next") as unknown as { click: () => void }).click();
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(doc.querySelector("#aw-step-3.visible")).toBeTruthy();
    const bandAggs = () =>
      Array.from(doc.querySelectorAll("#aw-bands .band-cond .tgl-agg")).map((el) => (el as unknown as { value: string }).value);
    expect(bandAggs()).toEqual(["latest", "latest"]);

    // Base latest → median: every tier follows, and each keeps its own value +
    // its own operator override (only the SAMPLING is shared).
    const agg = doc.querySelector("#aw-trig-root .tgl-agg") as unknown as { value: string; dispatchEvent: (e: unknown) => void };
    agg.value = "median";
    agg.dispatchEvent(new win.Event("change", { bubbles: true }));
    expect(bandAggs()).toEqual(["median", "median"]);
    expect(Array.from(doc.querySelectorAll("#aw-bands .band-cond .tgl-threshold")).map((el) => (el as unknown as { value: string }).value))
      .toEqual(["15", "25"]);
    expect(Array.from(doc.querySelectorAll("#aw-bands .band-cond .tgl-op")).map((el) => (el as unknown as { value: string }).value))
      .toEqual([">", ">="]);
    // Still locked after the re-render — a tier's sampling isn't editable.
    expect((doc.querySelector("#aw-bands .band-cond .tgl-agg") as unknown as { disabled: boolean }).disabled).toBe(true);
    expect((doc.querySelector("#aw-bands .band-cond .tgl-what") as unknown as { disabled: boolean }).disabled).toBe(true);

    // The metric follows too (the same lie, one control over).
    const what = doc.querySelector("#aw-trig-root .tgl-what") as unknown as { value: string; dispatchEvent: (e: unknown) => void };
    what.value = "m:cpuPct";
    what.dispatchEvent(new win.Event("change", { bubbles: true }));
    expect(Array.from(doc.querySelectorAll("#aw-bands .band-cond .tgl-what")).map((el) => (el as unknown as { value: string }).value))
      .toEqual(["m:cpuPct", "m:cpuPct"]);
    // Re-rendering a row from a metric swap resets the base's own aggregation to
    // `latest`; the tiers mirror that too rather than keeping a stale median.
    expect(bandAggs()).toEqual(["latest", "latest"]);
    expect(toastErrors).toEqual([]);
  });

  it("sensor-name filter is a picker: offers the fleet's own sensor names, filters as you type, and flags one nothing reports", async () => {
    // A sensor name ("CPU ON-DIE Temperature") is not guessable, and the
    // dimension is a substring PATTERN the server can't reject — so a typo used
    // to save cleanly and then never match a reading. The control has to both
    // offer what the scoped devices report and say whether what's typed hits.
    doc.body.innerHTML = "";
    savedPayloads.length = 0;
    const win = g.window as InstanceType<typeof Window>;
    await (g.openAutomationWizard as (r: unknown) => Promise<void>)({
      id: "r-sensor",
      name: "Hot sensor",
      description: null,
      enabled: true,
      severity: "warning",
      trigger: {
        type: "asset_metric", metric: "hwSensorValue", aggregation: "latest", windowSec: 0,
        operator: ">=", threshold: 70, dimensionFilter: { sensorClass: "temperature" },
      },
      scope: { allAssets: true },
      reset: { mode: "auto" },
      cooldownSec: null,
      messageTemplate: null,
      actions: [{ type: "notify", channelId: "c1", recipientDeviceRegion: true }],
      escalation: null,
      severityBands: null,
      bandNotify: null,
    });
    for (let i = 0; i < 2; i++) {
      (doc.querySelector("#aw-next") as unknown as { click: () => void }).click();
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(doc.querySelector("#aw-step-3.visible")).toBeTruthy();
    await new Promise((r) => setTimeout(r, 30)); // dimension-values fetch settles

    // Sensor CLASS is a closed enum → a select of what's reported, device counts
    // included. Sensor NAME is the pattern → a combobox, not a bare text box.
    const cls = doc.querySelector('#aw-trig-root select.tgl-dim[data-dim="sensorClass"]') as unknown as { value: string; textContent: string };
    expect(cls.value).toBe("temperature");
    expect(cls.textContent).toContain("temperature (2)");
    const combo = doc.querySelector("#aw-trig-root .aw-combo-dim")!;
    const input = combo.querySelector('input.tgl-dim[data-dim="sensorNamePattern"]') as unknown as
      { value: string; click: () => void; dispatchEvent: (e: unknown) => void };
    expect(input).toBeTruthy();
    const cue = () => (combo.nextElementSibling as unknown as { textContent: string }).textContent;
    const items = () => Array.from(combo.querySelectorAll(".aw-suggest.open .aw-suggest-item"));

    // Click opens the full list of sensors the selected devices actually report.
    input.click();
    expect(items().map((i) => i.textContent!.trim())).toEqual([
      "CPU ON-DIE Temperature (2)", "CPU Fan (2)", "DTS CPU0 (1)",
    ]);

    // Typing filters by SUBSTRING (mid-string "fan" — a datalist's prefix match
    // showed nothing) and the cue says how much it selects.
    input.value = "fan";
    input.dispatchEvent(new win.Event("input", { bubbles: true }));
    expect(items().map((i) => i.textContent!.trim())).toEqual(["CPU Fan (2)"]);
    expect(cue()).toBe("✓ matches 1 of 3 reported hardware sensors");

    // A plausible-but-wrong name is called out rather than silently accepted.
    input.value = "CPU ON DIE";
    input.dispatchEvent(new win.Event("input", { bubbles: true }));
    expect(items()).toHaveLength(0);
    expect(combo.querySelector(".aw-suggest.open .aw-suggest-empty")!.textContent).toContain("None of the 3 reported hardware sensors");
    expect(cue()).toContain("never fire");

    // Picking a suggestion fills the input exactly and confirms the pick.
    input.value = "on-die";
    input.dispatchEvent(new win.Event("input", { bubbles: true }));
    items()[0]!.dispatchEvent(new win.MouseEvent("mousedown", { bubbles: true }));
    expect(input.value).toBe("CPU ON-DIE Temperature");
    expect(combo.querySelector(".aw-suggest.open")).toBeFalsy(); // closed after pick
    expect(cue()).toBe("✓ exact match");
    expect(toastErrors).toEqual([]);

    // Keyboard: ArrowDown highlights, Enter picks, Escape closes without
    // touching the value (and must not bubble out and close the modal).
    input.value = "cpu";
    input.dispatchEvent(new win.Event("input", { bubbles: true }));
    input.dispatchEvent(new win.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    input.dispatchEvent(new win.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    expect(combo.querySelector(".aw-suggest-item.active")!.getAttribute("data-val")).toBe("CPU Fan");
    input.dispatchEvent(new win.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(input.value).toBe("CPU Fan");
    expect(combo.querySelector(".aw-suggest.open")).toBeFalsy();
    input.click();
    input.dispatchEvent(new win.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(combo.querySelector(".aw-suggest.open")).toBeFalsy();
    expect(input.value).toBe("CPU Fan");
    expect(doc.querySelector(".modal")).toBeTruthy();

    // Back to the exact sensor for the save assertion below.
    input.value = "CPU ON-DIE Temperature";
    input.dispatchEvent(new win.Event("input", { bubbles: true }));
    input.dispatchEvent(new win.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));

    // …and the picked value is what saves.
    (doc.querySelector("#aw-save") as unknown as { click: () => void }).click();
    await new Promise((r) => setTimeout(r, 30));
    const p = savedPayloads[0]! as Record<string, any>;
    expect(p.trigger.dimensionFilter).toEqual({ sensorClass: "temperature", sensorNamePattern: "CPU ON-DIE Temperature" });
    expect(() => ruleInputSchema.parse(p)).not.toThrow();
  });

  it("the condition row has no window box: 'Sustained for' IS the aggregation window, mandatory and starred", async () => {
    // Two time inputs meaning almost the same thing ("avg over 300 sec" +
    // "sustained for N minutes") is what this collapses. The duration field is
    // the trigger's one time knob: the measurement window for avg/median/min/max
    // (so no sustain on top), the sustain clock for `latest`.
    doc.body.innerHTML = "";
    savedPayloads.length = 0;
    const win = g.window as InstanceType<typeof Window>;
    await (g.openAutomationWizard as (r: unknown) => Promise<void>)({
      id: "r-window",
      name: "Hot CPU",
      description: null,
      enabled: true,
      severity: "warning",
      trigger: { type: "asset_metric", metric: "cpuPct", aggregation: "avg", windowSec: 300, operator: ">", threshold: 90 },
      scope: { allAssets: true },
      reset: { mode: "auto" },
      cooldownSec: null,
      messageTemplate: null,
      actions: [{ type: "notify", channelId: "c1", recipientDeviceRegion: true }],
      escalation: null,
      severityBands: null,
      bandNotify: null,
    });
    for (let i = 0; i < 2; i++) {
      (doc.querySelector("#aw-next") as unknown as { click: () => void }).click();
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(doc.querySelector("#aw-step-3.visible")).toBeTruthy();

    // The per-condition window control is gone; the aggregation select remains.
    expect(doc.querySelector("#aw-trig-root .tgl-window")).toBeFalsy();
    expect(doc.querySelector("#aw-trig-root .tgl-agg")).toBeTruthy();
    // median joined the vocabulary.
    const agg = doc.querySelector("#aw-trig-root .tgl-agg") as unknown as { value: string; textContent: string; dispatchEvent: (e: unknown) => void };
    expect(agg.value).toBe("avg");
    expect(agg.textContent).toContain("median");

    // A stored aggregation window renders as the duration in POLLS (300s at the
    // stubbed 120s cadence ≈ 3 readings) and the field is marked required.
    const dur = doc.querySelector("#tf-duration-min") as unknown as { value: string; placeholder: string; dispatchEvent: (e: unknown) => void };
    expect(dur.value).toBe("3");
    const star = () => (doc.querySelector(".aw-dur .aw-dur-req") as unknown as { style: { display: string } }).style.display;
    expect(star()).not.toBe("none");

    // Switch to median + 5 readings: the window follows the duration (5 × the
    // stubbed 120s cadence = 600s) and no sustain clock is stacked on top of it.
    agg.value = "median";
    agg.dispatchEvent(new win.Event("change", { bubbles: true }));
    dur.value = "5";
    dur.dispatchEvent(new win.Event("input", { bubbles: true }));
    expect(star()).not.toBe("none");
    (doc.querySelector("#aw-save") as unknown as { click: () => void }).click();
    await new Promise((r) => setTimeout(r, 30));
    expect(toastErrors).toEqual([]);
    expect(savedPayloads).toHaveLength(1);
    const saved = savedPayloads[0]! as Record<string, any>;
    expect(saved.trigger.aggregation).toBe("median");
    expect(saved.trigger.windowSec).toBe(600);
    expect(saved.trigger.forDurationSec).toBe(0);
    expect(() => ruleInputSchema.parse(saved)).not.toThrow();

    // Back on `latest` the same field is the optional sustain again — no
    // asterisk, and the polls land on forDurationSec instead of the window.
    agg.value = "latest";
    agg.dispatchEvent(new win.Event("change", { bubbles: true }));
    expect(star()).toBe("none");
    expect(dur.placeholder).toContain("0 = fire as soon as");
  });

  it("a `latest` condition's minutes stay the sustain clock, not a window", async () => {
    doc.body.innerHTML = "";
    savedPayloads.length = 0;
    await (g.openAutomationWizard as (r: unknown) => Promise<void>)({
      id: "r-sustain-only",
      // Again cpuPct: `latest` keeps its sustain clock, but packet loss is always
      // a window and is covered by its own tests below.
      name: "High CPU",
      description: null,
      enabled: true,
      severity: "warning",
      trigger: { type: "asset_metric", metric: "cpuPct", aggregation: "latest", windowSec: 0, operator: ">", threshold: 5, forDurationSec: 600 },
      scope: { allAssets: true },
      reset: { mode: "auto" },
      cooldownSec: null,
      messageTemplate: null,
      actions: [{ type: "notify", channelId: "c1", recipientDeviceRegion: true }],
      escalation: null,
      severityBands: null,
      bandNotify: null,
    });
    for (let i = 0; i < 2; i++) {
      (doc.querySelector("#aw-next") as unknown as { click: () => void }).click();
      await new Promise((r) => setTimeout(r, 20));
    }
    // 600s at the stubbed 120s cadence = 5 readings.
    expect((doc.querySelector("#tf-duration-min") as unknown as { value: string }).value).toBe("5");
    expect((doc.querySelector(".aw-dur .aw-dur-req") as unknown as { style: { display: string } }).style.display).toBe("none");
    (doc.querySelector("#aw-save") as unknown as { click: () => void }).click();
    await new Promise((r) => setTimeout(r, 30));
    expect(toastErrors).toEqual([]);
    const saved = savedPayloads[0]! as Record<string, any>;
    expect(saved.trigger.windowSec).toBe(0);
    expect(saved.trigger.forDurationSec).toBe(600);
  });

  it("counts the hold in polls, says which cadence it converted at, and stores that many polls' worth of seconds", async () => {
    // The whole point of counting readings: the field is the number of polls,
    // the caption is the wall clock, and what gets stored is still seconds.
    doc.body.innerHTML = "";
    savedPayloads.length = 0;
    toastErrors.length = 0;
    const win = g.window as InstanceType<typeof Window>;
    await (g.openAutomationWizard as (r: unknown) => Promise<void>)({
      id: "r-polls",
      name: "High memory",
      description: null,
      enabled: true,
      severity: "warning",
      trigger: { type: "asset_metric", metric: "memPct", aggregation: "latest", windowSec: 0, operator: ">=", threshold: 88, forDurationSec: 600 },
      scope: { allAssets: true },
      reset: { mode: "auto" },
      cooldownSec: null,
      messageTemplate: null,
      actions: [{ type: "notify", channelId: "c1", recipientDeviceRegion: true }],
      escalation: null,
      severityBands: null,
      bandNotify: null,
    });
    for (let i = 0; i < 2; i++) {
      (doc.querySelector("#aw-next") as unknown as { click: () => void }).click();
      await new Promise((r) => setTimeout(r, 20));
    }
    const label = doc.querySelector(".aw-dur label") as unknown as { textContent: string };
    expect(label.textContent).toContain("polls");
    expect(label.textContent).not.toContain("minutes");
    const dur = doc.querySelector("#tf-duration-min") as unknown as
      { value: string; dispatchEvent: (e: unknown) => void };
    expect(dur.value).toBe("5");
    // The caption names the wall clock, the cadence it used, WHICH cadence it is,
    // and the spread behind it — none of which the count can say by itself.
    const note = () => (doc.querySelector(".aw-dur .aw-poll-note") as unknown as { textContent: string }).textContent;
    expect(note()).toContain("10m");
    expect(note()).toContain("120s");
    expect(note()).toContain("CPU/memory");
    expect(note()).toContain("60s to 300s");

    // Typing a different count re-reads immediately and saves as seconds.
    dur.value = "3";
    dur.dispatchEvent(new win.Event("input", { bubbles: true }));
    expect(note()).toContain("6m");
    (doc.querySelector("#aw-save") as unknown as { click: () => void }).click();
    await new Promise((r) => setTimeout(r, 30));
    expect(toastErrors).toEqual([]);
    const saved = savedPayloads[0]! as Record<string, any>;
    // BOTH spellings: the count is what the engine counts, the seconds are its
    // wall-clock mirror (3 × the stubbed 120s cadence) and what sizes the
    // sample window the engine fetches to see three readings.
    expect(saved.trigger.forPolls).toBe(3);
    expect(saved.trigger.forDurationSec).toBe(360);
    expect(() => ruleInputSchema.parse(saved)).not.toThrow();
  });

  it("shows a STORED count verbatim, whatever the fleet's cadence has since become", async () => {
    // The count is what the rule states, so a rule authored at a 60s cadence
    // still reads "3 polls" on a fleet now polling every 120s — re-dividing its
    // seconds would show 2 and quietly halve the hold on the next save.
    doc.body.innerHTML = "";
    savedPayloads.length = 0;
    toastErrors.length = 0;
    await (g.openAutomationWizard as (r: unknown) => Promise<void>)({
      id: "r-stored-polls",
      name: "High memory",
      description: null,
      enabled: true,
      severity: "warning",
      trigger: { type: "asset_metric", metric: "memPct", aggregation: "latest", windowSec: 0, operator: ">=", threshold: 88, forDurationSec: 180, forPolls: 3 },
      scope: { allAssets: true },
      reset: { mode: "auto", sustainSec: 120, sustainPolls: 2 },
      cooldownSec: null,
      messageTemplate: null,
      actions: [{ type: "notify", channelId: "c1", recipientDeviceRegion: true }],
      escalation: null,
      severityBands: null,
      bandNotify: null,
    });
    for (let i = 0; i < 2; i++) {
      (doc.querySelector("#aw-next") as unknown as { click: () => void }).click();
      await new Promise((r) => setTimeout(r, 20));
    }
    // 180s ÷ the stubbed 120s cadence would round to 2; the stored count says 3.
    expect((doc.querySelector("#tf-duration-min") as unknown as { value: string }).value).toBe("3");
    (doc.querySelector("#aw-next") as unknown as { click: () => void }).click();
    await new Promise((r) => setTimeout(r, 20));
    expect((doc.querySelector("#aw-sustain-min") as unknown as { value: string }).value).toBe("2");
  });

  it("counts the auto-reset hold in polls too — recovery is judged on readings as well", async () => {
    doc.body.innerHTML = "";
    savedPayloads.length = 0;
    toastErrors.length = 0;
    const win = g.window as InstanceType<typeof Window>;
    await (g.openAutomationWizard as (r: unknown) => Promise<void>)({
      id: "r-reset-polls",
      name: "High memory",
      description: null,
      enabled: true,
      severity: "warning",
      trigger: { type: "asset_metric", metric: "memPct", aggregation: "latest", windowSec: 0, operator: ">=", threshold: 88, forDurationSec: 0 },
      scope: { allAssets: true },
      reset: { mode: "auto", sustainSec: 360 },
      cooldownSec: null,
      messageTemplate: null,
      actions: [{ type: "notify", channelId: "c1", recipientDeviceRegion: true }],
      escalation: null,
      severityBands: null,
      bandNotify: null,
    });
    for (let i = 0; i < 3; i++) {
      (doc.querySelector("#aw-next") as unknown as { click: () => void }).click();
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(doc.querySelector("#aw-step-4.visible")).toBeTruthy();
    const sm = doc.querySelector("#aw-sustain-min") as unknown as
      { value: string; dispatchEvent: (e: unknown) => void };
    // 360s at the stubbed 120s cadence = 3 readings back under the line.
    expect(sm.value).toBe("3");
    sm.value = "6";
    sm.dispatchEvent(new win.Event("input", { bubbles: true }));
    (doc.querySelector("#aw-save") as unknown as { click: () => void }).click();
    await new Promise((r) => setTimeout(r, 30));
    expect(toastErrors).toEqual([]);
    const saved = savedPayloads[0]! as Record<string, any>;
    expect(saved.reset.sustainPolls).toBe(6);
    expect(saved.reset.sustainSec).toBe(720);
    expect(() => ruleInputSchema.parse(saved)).not.toThrow();
  });

  it("an aggregation with the period left at 0 is refused, not measured over a default lookback", async () => {
    doc.body.innerHTML = "";
    savedPayloads.length = 0;
    const win = g.window as InstanceType<typeof Window>;
    await (g.openAutomationWizard as (r: unknown) => Promise<void>)({
      id: "r-no-window",
      name: "Hot CPU",
      description: null,
      enabled: true,
      severity: "warning",
      trigger: { type: "asset_metric", metric: "cpuPct", aggregation: "avg", windowSec: 300, operator: ">", threshold: 90 },
      scope: { allAssets: true },
      reset: { mode: "auto" },
      cooldownSec: null,
      messageTemplate: null,
      actions: [{ type: "notify", channelId: "c1", recipientDeviceRegion: true }],
      escalation: null,
      severityBands: null,
      bandNotify: null,
    });
    for (let i = 0; i < 2; i++) {
      (doc.querySelector("#aw-next") as unknown as { click: () => void }).click();
      await new Promise((r) => setTimeout(r, 20));
    }
    const dur = doc.querySelector("#tf-duration-min") as unknown as { value: string; dispatchEvent: (e: unknown) => void };
    dur.value = "0";
    dur.dispatchEvent(new win.Event("input", { bubbles: true }));
    toastErrors.length = 0;
    (doc.querySelector("#aw-save") as unknown as { click: () => void }).click();
    await new Promise((r) => setTimeout(r, 30));
    expect(savedPayloads).toHaveLength(0);
    expect(toastErrors.join(" ")).toContain("Measured over (polls)");
  });

  it("the formula block under the sentence moves the minutes when the aggregation changes", async () => {
    doc.body.innerHTML = "";
    const win = g.window as InstanceType<typeof Window>;
    await (g.openAutomationWizard as (r: unknown) => Promise<void>)({
      id: "r-formula",
      name: "CPU hot",
      description: null,
      enabled: true,
      severity: "warning",
      // A plain numeric metric, deliberately NOT a windowed ratio: a ratio row
      // hides its aggregation control and always renders `loss(probes, …)`, so
      // the latest↔aggregated axis this test exercises doesn't exist there.
      // (It used probeLossPct before pinTreeSelects existed, and only passed
      // because happy-dom misreported the stored metric select as a non-ratio
      // neighbor — see the ENVIRONMENT NOTE below.)
      trigger: { type: "asset_metric", metric: "cpuPct", aggregation: "latest", windowSec: 0, operator: ">", threshold: 5, forDurationSec: 600 },
      scope: { allAssets: true },
      reset: { mode: "auto" },
      cooldownSec: null,
      messageTemplate: null,
      actions: [{ type: "notify", channelId: "c1", recipientDeviceRegion: true }],
      escalation: null,
      severityBands: null,
      bandNotify: null,
    });
    for (let i = 0; i < 2; i++) {
      (doc.querySelector("#aw-next") as unknown as { click: () => void }).click();
      await new Promise((r) => setTimeout(r, 20));
    }
    const box = doc.querySelector("#aw-trigger-formula") as unknown as { style: { display: string }; textContent: string };
    // `latest`: the period is the hold, outside the term, and there's no window
    // argument at all — nothing for the sampling floor to qualify. It prints as
    // "5p" rather than "10m" because the wizard counts holds in READINGS: the
    // stored 600s reads as 5 polls at the stubbed 120s cadence, and saving from
    // here stores that count (which is what the engine then counts).
    expect(box.style.display).not.toBe("none");
    expect(box.textContent).toContain("latest(");
    expect(box.textContent).toContain("held 5p");
    expect(box.textContent).not.toContain("floor");
    // The formula and the sentence are twins of one draft, so they must name the
    // same severity — asserted against each other rather than against a literal.
    const sentence = (doc.querySelector("#aw-trigger-sentence") as unknown as { textContent: string }).textContent;
    const sev = (box.textContent.split("⇒ ")[1] || "").trim();
    expect(sev).toBeTruthy();
    expect(sentence).toContain(sev);

    // Switching to an aggregation moves the same minutes INSIDE the term, and
    // 10 minutes is under the engine's 15-minute floor, so the note appears.
    const agg = doc.querySelector(".scr-row .tgl-agg") as unknown as { value: string; dispatchEvent: (e: unknown) => void };
    agg.value = "median";
    agg.dispatchEvent(new win.Event("change", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 20));
    expect(box.textContent).toContain("median(");
    expect(box.textContent).toContain("10m)");
    expect(box.textContent).not.toContain("held");
    expect(box.textContent).toContain("floor");

    // An event trigger computes no value — the block hides rather than showing
    // an empty formula.
    const type = doc.querySelector("#aw-trigger-type") as unknown as { value: string; dispatchEvent: (e: unknown) => void };
    type.value = "event";
    type.dispatchEvent(new win.Event("change", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 20));
    expect((doc.querySelector("#aw-trigger-formula") as unknown as { style: { display: string } }).style.display).toBe("none");
  });
  // -- Packet loss: History + a separate optional sustain (rule 29) -----------
  // probeLossPct is a ratio over its window, so the wizard's base time field IS
  // the measurement period ("History"). Before that rename, `latest` + 60
  // minutes stored a 60-minute HOLD while the engine measured over its 15-minute
  // floor -- the automation said one thing and did another. 2026-08-20 added the
  // second axis back as its own field: an optional "Sustained for" hold
  // (#tf-sustain-min → forDurationSec) on top of the History window, with
  // severity tiers keeping their own hold boxes like any other numeric metric.
  //
  // ENVIRONMENT NOTE: happy-dom mis-parses `<option selected>` -- a select whose
  // selected option isn't the first reports the option AFTER it -- so a stored
  // metric doesn't survive into `select.value` the way it does in a browser
  // (which is why renderBandCond assigns select values instead of trusting the
  // markup). These tests therefore PICK the metric the way an operator would,
  // with a change event, and assert from there.
  async function pickMetric(metric: string) {
    const win = g.window as InstanceType<typeof Window>;
    const sel = doc.querySelector("#aw-trig-root .tgl-what") as unknown as { value: string; dispatchEvent: (e: unknown) => void };
    sel.value = "m:" + metric;
    sel.dispatchEvent(new win.Event("change", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 20));
    // The change handler re-renders the row from the model, which re-introduces
    // the happy-dom parse bug on the freshly-written markup — so re-pin the new
    // select (no event this time; the row is already built for this metric).
    const after = doc.querySelector("#aw-trig-root .tgl-what") as unknown as { value: string };
    after.value = "m:" + metric;
    const agg = doc.querySelector("#aw-trig-root .tgl-agg") as unknown as { value: string } | null;
    if (agg) agg.value = "latest";
    // Switching metric deliberately clears the threshold (a value for one metric
    // rarely means anything for another), so re-enter it — and let THAT event be
    // what re-runs the panel-level syncs, now that the metric select is pinned.
    const thr = doc.querySelector("#aw-trig-root .tgl-threshold") as unknown as { value: string; dispatchEvent: (e: unknown) => void };
    thr.value = "10";
    thr.dispatchEvent(new win.Event("change", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 20));
  }

  const LOSS_BASE = {
    description: null,
    enabled: true,
    severity: "warning",
    trigger: { type: "asset_metric", metric: "cpuPct", aggregation: "latest", windowSec: 0, operator: ">", threshold: 10, forDurationSec: 0 },
    scope: { allAssets: true },
    cooldownSec: null,
    messageTemplate: null,
    actions: [{ type: "notify", channelId: "c1", recipientDeviceRegion: true }],
    escalation: null,
  };

  it("relabels the time field as History for packet loss and stamps it as the window", async () => {
    doc.body.innerHTML = "";
    savedPayloads.length = 0;
    toastErrors.length = 0;
    await (g.openAutomationWizard as (r: unknown) => Promise<void>)({
      ...LOSS_BASE, id: "r-loss-history", name: "High packet loss",
      reset: { mode: "auto" }, severityBands: null, bandNotify: null,
    });
    for (let i = 0; i < 2; i++) {
      (doc.querySelector("#aw-next") as unknown as { click: () => void }).click();
      await new Promise((r) => setTimeout(r, 20));
    }
    await pickMetric("probeLossPct");

    // The field renames itself and becomes mandatory...
    const label = doc.querySelector(".aw-dur label") as unknown as { textContent: string };
    expect(label.textContent).toContain("History");
    expect(label.textContent).not.toContain("Sustained");
    expect((doc.querySelector(".aw-dur .aw-dur-req") as unknown as { style: { display: string } }).style.display).toBe("");
    // ...defaults rather than leaving a window the engine has to invent (the
    // 15-minute default, counted at the stubbed 120s cadence ≈ 8 readings)...
    expect((doc.querySelector("#tf-duration-min") as unknown as { value: string }).value).toBe("8");
    // ...and the aggregation control is hidden, since a ratio has nothing to aggregate.
    expect((doc.querySelector('#aw-trig-root .tgl-agg[data-ratio="1"]') as unknown as { style: { display: string } }).style.display).toBe("none");
    // The ratio-only sustain field surfaces beside it (hidden for other metrics).
    expect((doc.querySelector(".aw-ratio-sustain") as unknown as { style: { display: string } }).style.display).toBe("");

    // An operator-typed 30 POLLS saves as the WINDOW (30 × the stubbed 120s
    // cadence = 3600s); the untouched sustain stays 0.
    (doc.querySelector("#tf-duration-min") as unknown as { value: string }).value = "30";
    (doc.querySelector("#aw-save") as unknown as { click: () => void }).click();
    await new Promise((r) => setTimeout(r, 30));
    expect(toastErrors).toEqual([]);
    const saved = savedPayloads[0]! as Record<string, any>;
    expect(saved.trigger.metric).toBe("probeLossPct");
    expect(saved.trigger.windowSec).toBe(3600);
    expect(saved.trigger.forDurationSec).toBe(0);
  });

  it("collects the ratio sustain field as the hold on top of the History window", async () => {
    doc.body.innerHTML = "";
    savedPayloads.length = 0;
    toastErrors.length = 0;
    await (g.openAutomationWizard as (r: unknown) => Promise<void>)({
      ...LOSS_BASE, id: "r-loss-sustain", name: "High packet loss",
      reset: { mode: "auto" }, severityBands: null, bandNotify: null,
    });
    for (let i = 0; i < 2; i++) {
      (doc.querySelector("#aw-next") as unknown as { click: () => void }).click();
      await new Promise((r) => setTimeout(r, 20));
    }
    // The sustain field starts hidden for a non-ratio metric...
    expect((doc.querySelector(".aw-ratio-sustain") as unknown as { style: { display: string } }).style.display).toBe("none");
    await pickMetric("probeLossPct");
    // ...and appears with the History relabel.
    expect((doc.querySelector(".aw-ratio-sustain") as unknown as { style: { display: string } }).style.display).toBe("");

    // Counted in readings: 30 polls of History and 5 of hold, at the stubbed
    // 120s cadence → 3600s over 600s.
    (doc.querySelector("#tf-duration-min") as unknown as { value: string }).value = "30";
    (doc.querySelector("#tf-sustain-min") as unknown as { value: string }).value = "5";
    (doc.querySelector("#aw-save") as unknown as { click: () => void }).click();
    await new Promise((r) => setTimeout(r, 30));
    expect(toastErrors).toEqual([]);
    const saved = savedPayloads[0]! as Record<string, any>;
    expect(saved.trigger.windowSec).toBe(3600);
    expect(saved.trigger.forDurationSec).toBe(600);
  });

  it("a legacy loss rule's stored period reads back as History alone, never doubled into sustain", async () => {
    // Pre-History loss rules stored their minutes on forDurationSec (windowSec
    // 0). triggerDurationSec reads those back as the History the operator
    // meant; the sustain field must NOT show the same period again, or one save
    // would turn "measured over 10 minutes" into "measured over 10, then held 10".
    doc.body.innerHTML = "";
    savedPayloads.length = 0;
    toastErrors.length = 0;
    await (g.openAutomationWizard as (r: unknown) => Promise<void>)({
      ...LOSS_BASE, id: "r-loss-legacy",
      name: "High packet loss",
      trigger: { type: "asset_metric", metric: "probeLossPct", aggregation: "latest", windowSec: 0, operator: ">", threshold: 5, forDurationSec: 600 },
      reset: { mode: "auto" }, severityBands: null, bandNotify: null,
    });
    for (let i = 0; i < 2; i++) {
      (doc.querySelector("#aw-next") as unknown as { click: () => void }).click();
      await new Promise((r) => setTimeout(r, 20));
    }
    // The stored rule renders from the model, so the fields prefill without a
    // metric re-pick (data-ratio rides the row markup).
    // 600s at the stubbed 120s cadence = 5 readings of History, and no hold.
    expect((doc.querySelector("#tf-duration-min") as unknown as { value: string }).value).toBe("5");
    expect((doc.querySelector("#tf-sustain-min") as unknown as { value: string }).value).toBe("0");
  });

  it("refuses a History shorter than the engine's minimum window", async () => {
    doc.body.innerHTML = "";
    savedPayloads.length = 0;
    toastErrors.length = 0;
    await (g.openAutomationWizard as (r: unknown) => Promise<void>)({
      ...LOSS_BASE, id: "r-loss-short", name: "High packet loss",
      reset: { mode: "auto" }, severityBands: null, bandNotify: null,
    });
    for (let i = 0; i < 2; i++) {
      (doc.querySelector("#aw-next") as unknown as { click: () => void }).click();
      await new Promise((r) => setTimeout(r, 20));
    }
    await pickMetric("probeLossPct");
    (doc.querySelector("#tf-duration-min") as unknown as { value: string }).value = "2";
    (doc.querySelector("#aw-save") as unknown as { click: () => void }).click();
    await new Promise((r) => setTimeout(r, 30));
    // Refused rather than quietly measured over the engine's floor.
    expect(savedPayloads.length).toBe(0);
    expect(toastErrors.join(" ")).toContain("History");
  });

  it("packet-loss severity tiers carry no hold of their own — the trigger's History and sustain are shared", async () => {
    // "10% for 30 min = warning, 25% for 5 min = critical" is one automation:
    // tiers share the base's History window (the sampling) but each holds its
    // own sustain. The hold boxes were hidden while a ratio trigger had no
    // sustain axis at all; with the dedicated sustain field they behave like
    // every other numeric metric's.
    doc.body.innerHTML = "";
    savedPayloads.length = 0;
    toastErrors.length = 0;
    await (g.openAutomationWizard as (r: unknown) => Promise<void>)({
      ...LOSS_BASE, id: "r-loss-bands", name: "High packet loss",
      reset: { mode: "auto", clearThreshold: 5 },
      severityBands: [
        { threshold: 20, severity: "serious", actions: [] },
        { threshold: 30, severity: "critical", actions: [] },
      ],
      bandNotify: { onIncrease: true, onDecrease: false, onResolved: true, resolvedMode: "reuse" },
    });
    for (let i = 0; i < 2; i++) {
      (doc.querySelector("#aw-next") as unknown as { click: () => void }).click();
      await new Promise((r) => setTimeout(r, 20));
    }
    // No tier carries a duration field at all — before or after the switch to a
    // windowed-ratio metric.
    expect(doc.querySelectorAll("#aw-bands .band-duration").length).toBe(0);
    await pickMetric("probeLossPct");
    expect(doc.querySelectorAll("#aw-bands .band-duration").length).toBe(0);
    // Tiers share the History window AND the sustain: 10 polls of History at the
    // stubbed 120s cadence is the 1200s window every tier is measured over.
    // (8 would round-trip to the default 900s it already stands for — the field
    // keeps the exact stored seconds while the count still represents them.)
    (doc.querySelector("#tf-duration-min") as unknown as { value: string }).value = "10";
    (doc.querySelector("#aw-save") as unknown as { click: () => void }).click();
    await new Promise((r) => setTimeout(r, 30));
    expect(toastErrors).toEqual([]);
    const saved = savedPayloads[0]! as Record<string, any>;
    expect(saved.severityBands.map((b: any) => [b.threshold, b.severity])).toEqual([[20, "serious"], [30, "critical"]]);
    expect(saved.trigger.windowSec).toBe(1200);
    expect(saved.severityBands.map((b: any) => b.forDurationSec)).toEqual([undefined, undefined]);
  });
});

// ── Trigger filter rows (device identifiers / component names), 2026-08 ─────
// "+ Condition" offers Hostname / IP / MAC / Manufacturer / Model (device
// identifiers) and Interface name / IPsec tunnel / Storage mount (component
// names) as FILTER ROWS: "<what> matches <value>". The stored trigger never
// carries them — tgFilterCompile folds each into its group's condition leaves
// as dimensionFilter at save, and tgFilterLift re-derives the rows on edit.
// These drive the DOM end of that round trip; the pure halves are pinned in
// automationTriggerFilters.test.ts.
describe("trigger filter rows", () => {
  const BASE = {
    description: null,
    enabled: true,
    severity: "warning",
    trigger: { type: "asset_metric", metric: "cpuPct", aggregation: "latest", windowSec: 0, operator: ">", threshold: 10, forDurationSec: 0 },
    scope: { allAssets: true },
    cooldownSec: null,
    messageTemplate: null,
    actions: [{ type: "notify", channelId: "c1", recipientDeviceRegion: true }],
    escalation: null,
    reset: { mode: "auto" },
    severityBands: null,
    bandNotify: null,
  };

  async function openAtStep3(id: string) {
    doc.body.innerHTML = "";
    savedPayloads.length = 0;
    toastErrors.length = 0;
    await (g.openAutomationWizard as (r: unknown) => Promise<void>)({ ...BASE, id, name: "filter rows" });
    for (let i = 0; i < 2; i++) {
      (doc.querySelector("#aw-next") as unknown as { click: () => void }).click();
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(doc.querySelector("#aw-step-3.visible")).toBeTruthy();
  }

  /** Re-pin a row's what select after the change re-render (the same happy-dom
   *  `<option selected>` dance as pickMetric above). */
  async function pickWhat(row: Element, what: string) {
    const win = g.window as InstanceType<typeof Window>;
    const sel = row.querySelector(".tgl-what") as unknown as { value: string; dispatchEvent: (e: unknown) => void };
    sel.value = what;
    sel.dispatchEvent(new win.Event("change", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 20));
    const rows = Array.from(doc.querySelectorAll("#aw-trig-root .scr-row"));
    const after = rows[rows.length - 1]!.querySelector(".tgl-what") as unknown as { value: string };
    after.value = what;
  }

  async function addRow(): Promise<Element> {
    (doc.querySelector("#aw-trig-root .scg-add-rule") as unknown as { click: () => void }).click();
    await new Promise((r) => setTimeout(r, 20));
    const rows = doc.querySelectorAll("#aw-trig-root .scr-row");
    return rows[rows.length - 1] as unknown as Element;
  }

  function lastRow(): Element {
    const rows = doc.querySelectorAll("#aw-trig-root .scr-row");
    return rows[rows.length - 1] as unknown as Element;
  }

  it("offers identifier + component-name groups in the condition select, and no inline identifier boxes", async () => {
    await openAtStep3("r-filter-offer");
    const what = doc.querySelector("#aw-trig-root .tgl-what") as unknown as { innerHTML: string };
    expect(what.innerHTML).toContain('label="Device identifier');
    expect(what.innerHTML).toContain('label="Component name');
    for (const d of ["hostnamePattern", "ipPattern", "macPattern", "manufacturerPattern", "modelPattern", "ifNamePattern", "tunnelName", "mountPathPattern"]) {
      expect(what.innerHTML).toContain('value="d:' + d + '"');
    }
    // The clutter this UX replaced: a condition row renders NO always-visible
    // identifier/name inputs (they appear only as unlifted-leftover fallbacks).
    expect(doc.querySelector("#aw-trig-root .scr-row:not([data-filter-row]) .tgl-dim")).toBeFalsy();
  });

  it("folds a hostname filter row into the condition and saves the shipped wire shape", async () => {
    await openAtStep3("r-filter-hostname");
    (doc.querySelector("#aw-trig-root .tgl-threshold") as unknown as { value: string }).value = "90";
    const row = await addRow();
    await pickWhat(row, "d:hostnamePattern");
    const frow = lastRow();
    expect((frow as unknown as { getAttribute: (a: string) => string | null }).getAttribute("data-filter-row")).toBe("1");
    (frow.querySelector(".tgl-dim") as unknown as { value: string }).value = "CORE-SW";
    (doc.querySelector("#aw-save") as unknown as { click: () => void }).click();
    await new Promise((r) => setTimeout(r, 30));
    expect(toastErrors).toEqual([]);
    const saved = savedPayloads[0]! as Record<string, any>;
    // One condition + one filter collapses to the legacy single trigger, the
    // filter riding as the dimensionFilter the engine already evaluates.
    expect(saved.trigger.type).toBe("asset_metric");
    expect(saved.trigger.metric).toBe("cpuPct");
    expect(saved.trigger.dimensionFilter).toEqual({ hostnamePattern: "CORE-SW" });
    expect(() => ruleInputSchema.parse(saved)).not.toThrow();
  });

  it("folds interface-name + hostname rows into a state condition", async () => {
    await openAtStep3("r-filter-state");
    await pickWhat(doc.querySelector("#aw-trig-root .scr-row") as unknown as Element, "f:ifOperStatus");
    (doc.querySelector("#aw-trig-root .tgl-value") as unknown as { value: string }).value = "down";
    const r1 = await addRow();
    await pickWhat(r1, "d:ifNamePattern");
    (lastRow().querySelector(".tgl-dim") as unknown as { value: string }).value = "wan";
    const r2 = await addRow();
    await pickWhat(r2, "d:hostnamePattern");
    (lastRow().querySelector(".tgl-dim") as unknown as { value: string }).value = "CORE";
    (doc.querySelector("#aw-save") as unknown as { click: () => void }).click();
    await new Promise((r) => setTimeout(r, 30));
    expect(toastErrors).toEqual([]);
    const saved = savedPayloads[0]! as Record<string, any>;
    expect(saved.trigger.type).toBe("asset_state");
    expect(saved.trigger.field).toBe("ifOperStatus");
    expect(saved.trigger.dimensionFilter).toEqual({ ifNamePattern: "wan", hostnamePattern: "CORE" });
    expect(() => ruleInputSchema.parse(saved)).not.toThrow();
  });

  it("offers the interface IP address as an equality-only condition with an address hint", async () => {
    // The SD-WAN case this field exists for: the loss condition is gated on the
    // overlay's underlay port actually having an address. An ordered comparator
    // over an address can only read false (compareValue), and "e.g. up / down"
    // is the wrong hint, so both come from the field's own fieldMeta.
    await openAtStep3("r-filter-ifip");
    await pickWhat(doc.querySelector("#aw-trig-root .scr-row") as unknown as Element, "f:ifIpAddress");
    const ops = Array.from(doc.querySelectorAll("#aw-trig-root .tgl-op option"))
      .map((el) => (el as unknown as { value: string }).value);
    expect(ops).toEqual(["==", "!="]);
    const box = doc.querySelector("#aw-trig-root .tgl-value") as unknown as { value: string; getAttribute: (a: string) => string | null };
    expect(box.getAttribute("placeholder")).toBe("e.g. 0.0.0.0");
    (doc.querySelector("#aw-trig-root .tgl-op") as unknown as { value: string }).value = "!=";
    box.value = "0.0.0.0";
    const r1 = await addRow();
    await pickWhat(r1, "d:ifNamePattern");
    (lastRow().querySelector(".tgl-dim") as unknown as { value: string }).value = "wan1";
    (doc.querySelector("#aw-save") as unknown as { click: () => void }).click();
    await new Promise((r) => setTimeout(r, 30));
    expect(toastErrors).toEqual([]);
    const saved = savedPayloads[0]! as Record<string, any>;
    expect(saved.trigger.type).toBe("asset_state");
    expect(saved.trigger.field).toBe("ifIpAddress");
    expect(saved.trigger.operator).toBe("!=");
    expect(saved.trigger.value).toBe("0.0.0.0");
    expect(saved.trigger.dimensionFilter).toEqual({ ifNamePattern: "wan1" });
    expect(() => ruleInputSchema.parse(saved)).not.toThrow();
  });

  it("keeps the interface picker ON the Interface IP address row and saves what it names", async () => {
    // The interface is INTEGRAL to this field (fieldMeta.integralDimension):
    // the row compares ONE port's address, so the control that names the port
    // belongs on it. It shipped with the interface reachable only as a group
    // filter row, which left the condition row with nothing saying which
    // interface it meant.
    await openAtStep3("r-ifip-inline");
    await pickWhat(doc.querySelector("#aw-trig-root .scr-row") as unknown as Element, "f:ifIpAddress");
    const row = doc.querySelector("#aw-trig-root .scr-row:not([data-filter-row])") as unknown as Element;
    const ifBox = row.querySelector('.tgl-dim[data-dim="ifNamePattern"]') as unknown as
      { value: string; getAttribute: (a: string) => string | null };
    expect(ifBox).toBeTruthy();
    // Its hint asks which port rather than describing an optional narrowing.
    expect(ifBox.getAttribute("placeholder")).toContain("which interface");
    // The other interface fields keep the filter-row shape — an "oper status is
    // down" rule per pinned port is a legitimate rule, an IP comparison over
    // every pinned port is not.
    await openAtStep3("r-ifoper-noinline");
    await pickWhat(doc.querySelector("#aw-trig-root .scr-row") as unknown as Element, "f:ifOperStatus");
    expect(doc.querySelector('#aw-trig-root .scr-row:not([data-filter-row]) .tgl-dim[data-dim="ifNamePattern"]')).toBeFalsy();

    await openAtStep3("r-ifip-inline-save");
    await pickWhat(doc.querySelector("#aw-trig-root .scr-row") as unknown as Element, "f:ifIpAddress");
    (doc.querySelector("#aw-trig-root .tgl-op") as unknown as { value: string }).value = "!=";
    (doc.querySelector("#aw-trig-root .tgl-value") as unknown as { value: string }).value = "0.0.0.0";
    (doc.querySelector('#aw-trig-root .scr-row:not([data-filter-row]) .tgl-dim[data-dim="ifNamePattern"]') as unknown as { value: string }).value = "wan2";
    (doc.querySelector("#aw-save") as unknown as { click: () => void }).click();
    await new Promise((r) => setTimeout(r, 30));
    expect(toastErrors).toEqual([]);
    const saved = savedPayloads[0]! as Record<string, any>;
    expect(saved.trigger.field).toBe("ifIpAddress");
    expect(saved.trigger.dimensionFilter).toEqual({ ifNamePattern: "wan2" });
    expect(() => ruleInputSchema.parse(saved)).not.toThrow();
  });

  it("re-opens a stored Interface IP address rule with the interface on the row, not as a filter", async () => {
    doc.body.innerHTML = "";
    savedPayloads.length = 0;
    toastErrors.length = 0;
    await (g.openAutomationWizard as (r: unknown) => Promise<void>)({
      ...BASE, id: "r-ifip-reopen", name: "stored ifIpAddress",
      trigger: { type: "asset_state", field: "ifIpAddress", operator: "!=", value: "0.0.0.0", forDurationSec: 0, dimensionFilter: { ifNamePattern: "wan1", hostnamePattern: "GATE-A" } },
    });
    for (let i = 0; i < 2; i++) {
      (doc.querySelector("#aw-next") as unknown as { click: () => void }).click();
      await new Promise((r) => setTimeout(r, 20));
    }
    // The integral dimension is invisible to the lift: the hostname rises into a
    // filter row, the interface stays where it was authored.
    const filterDims = Array.from(doc.querySelectorAll("#aw-trig-root .scr-row[data-filter-row] .tgl-dim"))
      .map((el) => (el as unknown as { getAttribute: (a: string) => string | null }).getAttribute("data-dim"));
    expect(filterDims).toEqual(["hostnamePattern"]);
    const inline = doc.querySelector('#aw-trig-root .scr-row:not([data-filter-row]) .tgl-dim[data-dim="ifNamePattern"]') as unknown as { value: string };
    expect(inline.value).toBe("wan1");
    // And an untouched save round-trips the stored shape either way.
    (doc.querySelector("#aw-save") as unknown as { click: () => void }).click();
    await new Promise((r) => setTimeout(r, 30));
    expect(toastErrors).toEqual([]);
    const saved = savedPayloads[0]! as Record<string, any>;
    expect(saved.trigger.dimensionFilter).toEqual({ ifNamePattern: "wan1", hostnamePattern: "GATE-A" });
  });

  it("folds an SD-WAN rule-name row into the sdwan state condition", async () => {
    await openAtStep3("r-filter-sdwan");
    await pickWhat(doc.querySelector("#aw-trig-root .scr-row") as unknown as Element, "f:sdwanRuleStatus");
    (doc.querySelector("#aw-trig-root .tgl-value") as unknown as { value: string }).value = "down";
    const r1 = await addRow();
    await pickWhat(r1, "d:sdwanRulePattern");
    (lastRow().querySelector(".tgl-dim") as unknown as { value: string }).value = "Internet-Traffic";
    (doc.querySelector("#aw-save") as unknown as { click: () => void }).click();
    await new Promise((r) => setTimeout(r, 30));
    expect(toastErrors).toEqual([]);
    const saved = savedPayloads[0]! as Record<string, any>;
    expect(saved.trigger.type).toBe("asset_state");
    expect(saved.trigger.field).toBe("sdwanRuleStatus");
    expect(saved.trigger.dimensionFilter).toEqual({ sdwanRulePattern: "Internet-Traffic" });
    expect(() => ruleInputSchema.parse(saved)).not.toThrow();
  });

  it("refuses an empty filter and a filter no condition in the group can take", async () => {
    await openAtStep3("r-filter-invalid");
    (doc.querySelector("#aw-trig-root .tgl-threshold") as unknown as { value: string }).value = "90";
    const row = await addRow();
    await pickWhat(row, "d:tunnelName");
    // Empty value first.
    (doc.querySelector("#aw-save") as unknown as { click: () => void }).click();
    await new Promise((r) => setTimeout(r, 30));
    expect(savedPayloads).toHaveLength(0);
    expect(toastErrors.join(" ")).toContain("give it a value");
    // A value, but no condition that takes tunnelName (cpuPct doesn't).
    toastErrors.length = 0;
    (lastRow().querySelector(".tgl-dim") as unknown as { value: string }).value = "to-hq";
    (doc.querySelector("#aw-save") as unknown as { click: () => void }).click();
    await new Promise((r) => setTimeout(r, 30));
    expect(savedPayloads).toHaveLength(0);
    expect(toastErrors.join(" ")).toContain("no condition in its group can take it");
  });

  it("a stored trigger with a uniform dimensionFilter re-opens as filter rows", async () => {
    doc.body.innerHTML = "";
    savedPayloads.length = 0;
    toastErrors.length = 0;
    await (g.openAutomationWizard as (r: unknown) => Promise<void>)({
      ...BASE, id: "r-filter-reopen", name: "stored filters",
      trigger: { type: "asset_state", field: "ifOperStatus", operator: "==", value: "down", forDurationSec: 0, dimensionFilter: { ifNamePattern: "port1", hostnamePattern: "SW-A" } },
    });
    for (let i = 0; i < 2; i++) {
      (doc.querySelector("#aw-next") as unknown as { click: () => void }).click();
      await new Promise((r) => setTimeout(r, 20));
    }
    const filterRows = Array.from(doc.querySelectorAll("#aw-trig-root .scr-row[data-filter-row]"));
    expect(filterRows.length).toBe(2);
    const byDim = new Map(filterRows.map((r) => [
      (r.querySelector(".tgl-dim") as unknown as { getAttribute: (a: string) => string }).getAttribute("data-dim"),
      (r.querySelector(".tgl-dim") as unknown as { value: string }).value,
    ]));
    expect(byDim.get("ifNamePattern")).toBe("port1");
    expect(byDim.get("hostnamePattern")).toBe("SW-A");
    // The condition row itself is clean — no inline leftovers.
    expect(doc.querySelector("#aw-trig-root .scr-row:not([data-filter-row]) .tgl-dim")).toBeFalsy();
    // And an untouched save round-trips the exact stored shape.
    (doc.querySelector("#aw-save") as unknown as { click: () => void }).click();
    await new Promise((r) => setTimeout(r, 30));
    expect(toastErrors).toEqual([]);
    const saved = savedPayloads[0]! as Record<string, any>;
    expect(saved.trigger.dimensionFilter).toEqual({ ifNamePattern: "port1", hostnamePattern: "SW-A" });
  });

  // ── Step 4: custom reset conditions on a single trigger ──────────────────
  // Unchecking "reset when the trigger is no longer true" used to leave only
  // timed/manual on a single-condition automation — the custom-condition builder
  // was composite-only. It is now offered everywhere a trigger has a continuous
  // condition, and SEEDED with the trigger inverted so the operator edits a real
  // starting position instead of filling in a blank row.
  describe("reset conditions", () => {
    /** The option the RENDERED markup marks selected — what a real browser would
     *  report as the select's value. happy-dom reports a neighbouring option, so
     *  reading `.value` here tests the DOM engine rather than the wizard. */
    const selectedOpt = (sel: string) =>
      (doc.querySelector(sel + " option[selected]") as unknown as { value: string } | null)?.value;

    /** Open the wizard on a stored rule and land on step 4 with the stored
     *  trigger intact.
     *
     *  The `fixSelects` call in the middle is load-bearing. Step 3 renders during
     *  open and its delegated handlers collect it, so the `<option selected>` bug
     *  rewrites the draft's TRIGGER before any assertion runs — a storageUsedPct
     *  rule arrives at step 4 as memPct — which is exactly the input the reset
     *  step branches on. The MARKUP is correct (built from the stored rule), so
     *  repairing step 3's selects and letting one input event re-run the panel's
     *  own collect restores the draft. */
    async function openOnStep4(rule: Record<string, unknown>): Promise<void> {
      const win = g.window as InstanceType<typeof Window>;
      doc.body.innerHTML = "";
      savedPayloads.length = 0;
      await (g.openAutomationWizard as (r: unknown) => Promise<void>)(rule);
      fixSelects(doc.querySelector("#aw-step-3")!);
      const anyInput = doc.querySelector("#aw-step-3 input") as unknown as { dispatchEvent: (e: unknown) => void } | null;
      if (anyInput) anyInput.dispatchEvent(new win.Event("input", { bubbles: true }));
      await new Promise((r) => setTimeout(r, 20));
      (doc.querySelector('.stepper-step[data-step="4"]') as unknown as { click: () => void }).click();
      await new Promise((r) => setTimeout(r, 20));
    }
    const metricRule = (extra: Record<string, unknown> = {}) => ({
      id: "r-reset",
      name: "CPU",
      description: null,
      enabled: true,
      severity: "warning",
      trigger: { type: "asset_metric", metric: "cpuPct", aggregation: "avg", windowSec: 300, operator: ">=", threshold: 90, forDurationSec: 0 },
      scope: { allAssets: true },
      reset: { mode: "auto" },
      cooldownSec: null,
      actions: [{ type: "notify", channelId: "c1", addresses: ["noc@example.invalid"] }],
      ...extra,
    });
    const uncheckAuto = () => {
      const win = g.window as InstanceType<typeof Window>;
      const cb = doc.querySelector("#aw-reset-auto") as unknown as { checked: boolean; dispatchEvent: (e: unknown) => void };
      cb.checked = false;
      cb.dispatchEvent(new win.Event("change", { bubbles: true }));
    };

    it("offers custom conditions on a SINGLE metric trigger, seeded with the trigger inverted", async () => {
      await openOnStep4(metricRule());
      expect(toastErrors).toEqual([]);
      // The radio exists even while auto is checked (the whole custom block is
      // rendered hidden), and "condition" leads — so unchecking lands on it.
      const modes = Array.from(doc.querySelectorAll('#aw-reset-custom input[name="aw-reset-mode"]'))
        .map((r) => (r as unknown as { value: string }).value);
      expect(modes).toEqual(["condition", "timed", "manual"]);
      const condRadio = doc.querySelector('#aw-reset-custom input[name="aw-reset-mode"][value="condition"]') as unknown as { checked: boolean };
      expect(condRadio.checked).toBe(true);

      // The seed: ONE leaf, the trigger's own metric, comparator flipped, and the
      // same aggregation/window (a reset measured differently from the trigger
      // would be a different question).
      const leaves = doc.querySelectorAll("#aw-reset-root .scr-row");
      expect(leaves).toHaveLength(1);
      expect(selectedOpt("#aw-reset-root .tgl-what")).toBe("m:cpuPct");
      expect(selectedOpt("#aw-reset-root .tgl-op")).toBe("<"); // >= flipped
      expect((doc.querySelector("#aw-reset-root .tgl-threshold") as unknown as { value: string }).value).toBe("90");
      expect(selectedOpt("#aw-reset-root .tgl-agg")).toBe("avg");
      // The group operator flips too — De Morgan, so the one-leaf AND becomes OR.
      expect(selectedOpt("#aw-reset-root > .scg-group > div > .scg-op")).toBe("or");
    });

    it("saves the seeded tree as reset.mode=condition once auto is unchecked", async () => {
      await openOnStep4(metricRule());
      fixSelects(doc.querySelector("#aw-reset-root")!); // happy-dom select bug; the markup is correct
      uncheckAuto();
      (doc.querySelector("#aw-save") as unknown as { click: () => void }).click();
      await new Promise((r) => setTimeout(r, 30));
      expect(toastErrors).toEqual([]);
      const p = savedPayloads[0]! as Record<string, any>;
      expect(p.reset.mode).toBe("condition");
      expect(p.reset.condition.op).toBe("or"); // De Morgan on the one-leaf AND
      expect(p.reset.condition.children).toHaveLength(1);
      expect(p.reset.condition.children[0]).toMatchObject({ type: "asset_metric", metric: "cpuPct", operator: "<", threshold: 90 });
      // The reset leaf inherits the TRIGGER's measurement window — the reset step
      // has no window control, and an aggregated leaf with windowSec 0 used to be
      // refused with a message naming a field that isn't on the step.
      expect(p.reset.condition.children[0].aggregation).toBe("avg");
      expect(p.reset.condition.children[0].windowSec).toBe(300);
      // Round-trips through the real server schema — the composite-only refusal
      // is gone, and a single trigger's reset tree now validates.
      expect(() => ruleInputSchema.parse(p)).not.toThrow();
    });

    it("a stored reset condition is kept verbatim, not re-seeded from the trigger", async () => {
      // The seed is a starting position. Once the operator has edited it, a
      // re-render must not quietly put the trigger's own clause back.
      await openOnStep4(metricRule({
        reset: {
          mode: "condition",
          condition: { op: "and", children: [{ type: "asset_metric", metric: "cpuPct", operator: "<", threshold: 60, aggregation: "avg", windowSec: 300 }] },
          sustainSec: 600,
        },
      }));
      expect((doc.querySelector("#aw-reset-root .tgl-threshold") as unknown as { value: string }).value).toBe("60");
      // Counted in readings too: 600s at the stubbed 120s cadence = 5.
      expect((doc.querySelector("#aw-crs-sustain-min") as unknown as { value: string }).value).toBe("5");
      expect((doc.querySelector("#aw-reset-auto") as unknown as { checked: boolean }).checked).toBe(false);
    });

    it("says whether a reset condition clears one alert or the whole device's", async () => {
      // A per-mount automation raises one alert per mount, and the reset tree
      // resolves dimension-first with a per-asset fallback — so which one an
      // operator gets depends on what they put in the tree. Said out loud,
      // because nothing on the step shows it.
      await openOnStep4(metricRule({
        trigger: { type: "asset_metric", metric: "storageUsedPct", aggregation: "latest", windowSec: 0, operator: ">=", threshold: 80, forDurationSec: 0 },
      }));
      const cond = doc.querySelector('#aw-reset-custom .aw-reset-extra[data-mode="condition"]')!;
      expect(cond.textContent).toContain("alerts per storage mount");
      // A device-wide trigger has no such note to make.
      await openOnStep4(metricRule());
      const cond2 = doc.querySelector('#aw-reset-custom .aw-reset-extra[data-mode="condition"]')!;
      expect(cond2.textContent).not.toContain("alerts per");
    });

    it("an event trigger gets the counterpart-event reset plus timed/manual — never the condition builder", async () => {
      // Built by DRIVING the trigger step to "event" rather than by opening a
      // stored event rule: the option-before bug means step 3 renders its fields
      // for the wrong category during open, so `#tf-action` doesn't exist and the
      // panel's own collect throws instead of producing an event trigger. Picking
      // the category here re-renders the fields, which is the path a real
      // operator takes anyway.
      const win = g.window as InstanceType<typeof Window>;
      doc.body.innerHTML = "";
      savedPayloads.length = 0;
      await (g.openAutomationWizard as (r: unknown) => Promise<void>)(metricRule());
      const typeSel = doc.querySelector("#aw-trigger-type") as unknown as { value: string; dispatchEvent: (e: unknown) => void };
      typeSel.value = "event";
      typeSel.dispatchEvent(new win.Event("change", { bubbles: true }));
      await new Promise((r) => setTimeout(r, 20));
      typeSel.value = "event"; // the re-render re-introduces the parse bug
      const action = doc.querySelector("#tf-action") as unknown as { value: string; dispatchEvent: (e: unknown) => void };
      action.value = "integration.discover.*";
      action.dispatchEvent(new win.Event("input", { bubbles: true }));
      await new Promise((r) => setTimeout(r, 20));
      (doc.querySelector('.stepper-step[data-step="4"]') as unknown as { click: () => void }).click();
      await new Promise((r) => setTimeout(r, 20));

      // No "reset when the trigger is no longer true" checkbox at all, and no
      // condition builder — an instant has no condition to recover from. It
      // does get the counterpart EVENT, which is the recovery it has.
      expect(doc.querySelector("#aw-reset-auto")).toBeFalsy();
      expect(doc.querySelector("#aw-reset-root")).toBeFalsy();
      const modes = Array.from(doc.querySelectorAll('input[name="aw-reset-mode"]'))
        .map((r) => (r as unknown as { value: string }).value);
      expect(modes).toEqual(["event", "timed", "manual"]);
      expect(doc.querySelector("#aw-reset-ev-action")).toBeTruthy();
      // Re-notify cooldown is gone from the builder entirely (2026-08).
      expect(doc.querySelector("#aw-cooldown-min")).toBeFalsy();
    });

    it("offers no re-notify cooldown on any step, and clears a stored one on save", async () => {
      // The control was retired in 2026-08 and clearNotificationCooldowns
      // empties the column. A rule that somehow still carries one (an API
      // caller, or a restore from before the migration) must not keep it
      // invisibly: an edit through the builder writes null, so what governs
      // this automation is only ever what the wizard actually showed.
      await openOnStep4(metricRule({ cooldownSec: 900 }));
      expect(doc.querySelector("#aw-step-4 #aw-cooldown-min")).toBeFalsy();
      (doc.querySelector('.stepper-step[data-step="5"]') as unknown as { click: () => void }).click();
      await new Promise((r) => setTimeout(r, 20));
      expect(doc.querySelector("#aw-step-5 #aw-cooldown-min")).toBeFalsy();
      (doc.querySelector("#aw-save") as unknown as { click: () => void }).click();
      await new Promise((r) => setTimeout(r, 30));
      expect(toastErrors).toEqual([]);
      expect((savedPayloads[0] as Record<string, any>).cooldownSec).toBeNull();
    });

    it("labels the repeat checkbox without restating what the fields below say", async () => {
      // "until it's handled" duplicated — less precisely — the "until
      // Acknowledged / Cleared only" select the checkbox reveals.
      await openOnStep4(metricRule({}));
      (doc.querySelector('.stepper-step[data-step="5"]') as unknown as { click: () => void }).click();
      await new Promise((r) => setTimeout(r, 20));
      const box = doc.querySelector("#aw-step-5 #aw-repeat-on");
      expect(box).toBeTruthy();
      const label = (box as unknown as { parentElement: { textContent: string } }).parentElement.textContent.trim();
      expect(label).toBe("Repeat this notification");
    });

    it("a NEW event automation whose action has a known counterpart starts on the event reset", async () => {
      // agent.disconnected → agent.connected: the reset an operator would have
      // to know Polaris's own verb to write. A four-hour timer was the old
      // default, and it cleared the alert whether or not the agent came back.
      const win = g.window as InstanceType<typeof Window>;
      doc.body.innerHTML = "";
      savedPayloads.length = 0;
      await (g.openAutomationWizard as (r?: unknown) => Promise<void>)();
      const nameEl = doc.querySelector("#aw-name") as unknown as { value: string; dispatchEvent: (e: unknown) => void } | null;
      if (nameEl) {
        nameEl.value = "Agent disconnected";
        nameEl.dispatchEvent(new win.Event("input", { bubbles: true }));
      }
      const typeSel = doc.querySelector("#aw-trigger-type") as unknown as { value: string; dispatchEvent: (e: unknown) => void };
      typeSel.value = "event";
      typeSel.dispatchEvent(new win.Event("change", { bubbles: true }));
      await new Promise((r) => setTimeout(r, 20));
      const action = doc.querySelector("#tf-action") as unknown as { value: string; dispatchEvent: (e: unknown) => void };
      action.value = "agent.disconnected";
      action.dispatchEvent(new win.Event("input", { bubbles: true }));
      await new Promise((r) => setTimeout(r, 20));
      // A new draft walks the stepper one step at a time (later steps are locked
      // until the ones before them validate), so this is Next, not a jump.
      const next = doc.querySelector("#aw-next") as unknown as { click: () => void };
      for (let i = 0; i < 3; i++) {
        next.click();
        await new Promise((r) => setTimeout(r, 20));
      }

      const picked = doc.querySelector('input[name="aw-reset-mode"][value="event"]') as unknown as { checked: boolean };
      expect(picked.checked).toBe(true);
      expect((doc.querySelector("#aw-reset-ev-action") as unknown as { value: string }).value).toBe("agent.connected");
      expect((doc.querySelector("#aw-reset-sentence") as unknown as { textContent: string }).textContent)
        .toContain("agent.connected");
    });
  });

  describe("down detection", () => {
    const downRule = (over: Record<string, unknown> = {}) => ({
      id: "r-down", name: "Asset down", description: null, enabled: true, severity: "critical",
      trigger: { type: "asset_state", field: "monitorStatus", operator: "==", value: "down", missedPolls: 3, forDurationSec: 0 },
      scope: { allAssets: true }, reset: { mode: "auto" }, cooldownSec: null, messageTemplate: "{asset} is down",
      actions: [{ type: "notify", channelId: "c1", recipientDeviceRegion: true }], escalation: null, severityBands: null, bandNotify: null,
      ...over,
    });

    async function openOnTrigger(rule: unknown) {
      doc.body.innerHTML = "";
      savedPayloads.length = 0;
      await (g.openAutomationWizard as (r: unknown) => Promise<void>)(rule);
      for (let i = 0; i < 2; i++) {
        (doc.querySelector("#aw-next") as unknown as { click: () => void }).click();
        await new Promise((r) => setTimeout(r, 20));
      }
    }

    it("renders the missed-poll count on the condition row and round-trips it", async () => {
      await openOnTrigger(downRule());
      const miss = doc.querySelector(".tgl-misses") as unknown as { value: string } | null;
      expect(miss).toBeTruthy();
      expect(miss!.value).toBe("3");
      (doc.querySelector("#aw-save") as unknown as { click: () => void }).click();
      await new Promise((r) => setTimeout(r, 30));
      expect(savedPayloads).toHaveLength(1);
      expect((savedPayloads[0] as { trigger: { missedPolls: number } }).trigger.missedPolls).toBe(3);
      expect(() => ruleInputSchema.parse(savedPayloads[0])).not.toThrow();
    });

    it("saves an edited count, and the sentence says what it means", async () => {
      await openOnTrigger(downRule());
      const w = g.window as InstanceType<typeof Window>;
      const miss = doc.querySelector(".tgl-misses") as unknown as { value: string; dispatchEvent: (e: unknown) => void };
      miss.value = "7";
      miss.dispatchEvent(new w.Event("input", { bubbles: true }));
      await new Promise((r) => setTimeout(r, 20));
      // The PHRASING is pinned deterministically in automationSentences.test.ts
      // against the factory directly; here we only care that the edited number
      // reaches the payload.
      (doc.querySelector("#aw-save") as unknown as { click: () => void }).click();
      await new Promise((r) => setTimeout(r, 30));
      expect((savedPayloads[0] as { trigger: { missedPolls: number } }).trigger.missedPolls).toBe(7);
    });

    it("refuses to save a blank count rather than silently governing at the default", async () => {
      await openOnTrigger(downRule());
      const w = g.window as InstanceType<typeof Window>;
      const miss = doc.querySelector(".tgl-misses") as unknown as { value: string; dispatchEvent: (e: unknown) => void };
      miss.value = "";
      miss.dispatchEvent(new w.Event("input", { bubbles: true }));
      toastErrors.length = 0;
      (doc.querySelector("#aw-save") as unknown as { click: () => void }).click();
      await new Promise((r) => setTimeout(r, 30));
      expect(savedPayloads).toHaveLength(0);
      expect(toastErrors.join(" ")).toMatch(/consecutive missed polls/i);
    });

    it("hides the count on a MULTI-condition trigger and strips it from the payload", async () => {
      // Authority lives on a bare trigger only — the probe loop cannot evaluate
      // a CPU reading on the way to deciding down, and the server rejects a
      // count inside a composite. The control must not sit there collecting a
      // number nothing would honour.
      await openOnTrigger(downRule({
        trigger: {
          type: "composite", kind: "asset", op: "and", forDurationSec: 0,
          children: [
            { type: "asset_state", field: "monitorStatus", operator: "==", value: "down" },
            { type: "asset_metric", metric: "cpuPct", aggregation: "latest", windowSec: 0, operator: ">", threshold: 90 },
          ],
        },
      }));
      const miss = doc.querySelector(".tgl-misses") as unknown as { style: { display: string } } | null;
      if (miss) expect(miss.style.display).toBe("none");
      (doc.querySelector("#aw-save") as unknown as { click: () => void }).click();
      await new Promise((r) => setTimeout(r, 30));
      expect(savedPayloads).toHaveLength(1);
      const p = savedPayloads[0] as { trigger: { type: string; children?: { missedPolls?: number }[] } };
      expect(p.trigger.type).toBe("composite");
      (p.trigger.children || []).forEach((c) => expect(c.missedPolls).toBeUndefined());
      expect(() => ruleInputSchema.parse(p)).not.toThrow();
    });
  });
});

// ─── Export / import / view code ────────────────────────────────────────────

describe("automation export / import / view code", () => {
  const win = () => g.window as Window & typeof globalThis;

  /** A complete stored automation. Opening in EDIT mode unlocks every step
   *  (visited = 6), which is what makes the Summary step reachable in one jump —
   *  a from-scratch draft has to be walked through Next, and exporting an
   *  automation that already exists is the realistic case anyway. */
  function storedRule(over?: Record<string, unknown>) {
    return {
      id: "r-export",
      name: "Exportable",
      description: null,
      enabled: true,
      severity: "warning",
      trigger: { type: "asset_metric", metric: "cpuPct", aggregation: "latest", windowSec: 0, operator: ">=", threshold: 80, forDurationSec: 0 },
      scope: { allAssets: true },
      reset: { mode: "manual" },
      actions: [{ type: "event" }, { type: "notify", channelId: "c1", recipientUserIds: ["u1"] }],
      cooldownSec: null,
      messageTemplate: null,
      requireAckNote: false,
      ...(over || {}),
    };
  }

  /** Open on the Summary step. */
  async function openToSummary(existing?: unknown, opts?: unknown) {
    await (g.openAutomationWizard as (r: unknown, o?: unknown) => Promise<void>)(existing || storedRule(), opts);
    (doc.querySelector('.stepper-step[data-step="6"]') as unknown as { click: () => void }).click();
    await new Promise((r) => setTimeout(r, 60));
  }

  beforeEach(() => {
    downloads.length = 0;
    savedPayloads.length = 0;
    // toastErrors accumulates across the whole file; these tests assert on it.
    toastErrors.length = 0;
    // buildOverlay removes its node on transitionend with a 400 ms fallback, so
    // a dialog closed by the previous test is still in the document — and a
    // plain querySelector would find that stale one instead of the live dialog.
    doc.querySelectorAll(".modal-overlay").forEach((n) => n.remove());
  });

  /** The live stacked dialog: always the LAST overlay in the document. */
  function inCode(sel: string): unknown {
    const all = doc.querySelectorAll(".modal-overlay " + sel);
    return all.length ? all[all.length - 1] : null;
  }

  it("step 1 offers Import when creating, and never when editing", async () => {
    await (g.openAutomationWizard as (r: unknown) => Promise<void>)(null);
    expect(toastErrors).toEqual([]);
    expect(doc.querySelector("#aw-import-btn")).toBeTruthy();
    expect(doc.querySelector("#aw-import-input")).toBeTruthy();

    // Editing an existing automation must NOT offer to replace it wholesale.
    await (g.openAutomationWizard as (r: unknown) => Promise<void>)({
      id: "r1",
      name: "Existing",
      severity: "warning",
      trigger: { type: "asset_metric", metric: "cpuPct", aggregation: "latest", windowSec: 0, operator: ">=", threshold: 80, forDurationSec: 0 },
      scope: { allAssets: true },
      reset: { mode: "manual" },
      actions: [{ type: "event" }],
    });
    expect(doc.querySelector("#aw-import-btn")).toBeFalsy();
  });

  it("step 6 offers Export and View code", async () => {
    await openToSummary();
    expect(toastErrors).toEqual([]);
    expect(doc.querySelector("#aw-export")).toBeTruthy();
    expect(doc.querySelector("#aw-view-code")).toBeTruthy();
  });

  it("Export downloads a dependency-led file named after the automation, carrying no channel id", async () => {
    await openToSummary();
    (doc.querySelector("#aw-export") as unknown as { click: () => void }).click();
    await new Promise((r) => setTimeout(r, 20));

    expect(downloads.length).toBe(1);
    expect(downloads[0]!.filename).toBe("Exportable.automation.json");
    const file = downloads[0]!.obj as Record<string, unknown>;
    // Dependencies come FIRST so they are what a human sees on opening the file.
    expect(Object.keys(file).indexOf("dependencies")).toBeLessThan(Object.keys(file).indexOf("rule"));
    expect(file.polarisAutomation).toBe(1);
    const rule = file.rule as Record<string, unknown>;
    expect(rule.name).toBe("Exportable");
    // No delivery wiring, and the audit Event is explicit rather than omitted.
    expect(rule.actions).toEqual([{ type: "event" }]);
    expect(rule.enabled).toBeUndefined();
    expect(JSON.stringify(file)).not.toContain('"c1"'); // the harness's channel id
  });

  it("View code shows the full stored body and can save it back through the one save path", async () => {
    await openToSummary();
    (doc.querySelector("#aw-view-code") as unknown as { click: () => void }).click();
    await new Promise((r) => setTimeout(r, 20));

    const ta = inCode("#aw-code-text") as unknown as { value: string } | null;
    expect(ta).toBeTruthy();
    const shown = JSON.parse(ta!.value) as Record<string, unknown>;
    // Full fidelity, unlike the export: `enabled` is present ...
    expect(shown.enabled).toBe(true);
    // ... and the legacy mirror is NOT, or deleting `actions` here would let the
    // server silently rebuild them from `targets`.
    expect(shown.targets).toBeUndefined();
    expect(shown.clearBehavior).toBeUndefined();

    // An edit that removes nothing destructive saves straight through. It must
    // NOT be treated as "no change" just because the destructive-field diff is
    // empty — that would silently discard the operator's edit.
    ta!.value = JSON.stringify({ ...shown, messageTemplate: "edited" });
    (inCode("#aw-code-save") as unknown as { click: () => void }).click();
    await new Promise((r) => setTimeout(r, 40));
    expect(savedPayloads.length).toBe(1);
    expect(savedPayloads[0]!.messageTemplate).toBe("edited");
    // Editing an existing automation keeps its delivery wiring — the code view
    // is full fidelity, unlike an export.
    expect(JSON.stringify(savedPayloads[0]!.actions)).toContain("c1");
  });

  it("View code offers Export, and it writes the PORTABLE file, not what is on screen", async () => {
    await openToSummary();
    (doc.querySelector("#aw-view-code") as unknown as { click: () => void }).click();
    await new Promise((r) => setTimeout(r, 20));

    const ta = inCode("#aw-code-text") as unknown as { value: string };
    // The code view is full fidelity, so the channel id IS on screen ...
    expect(ta.value).toContain("c1");

    (inCode("#aw-code-export") as unknown as { click: () => void }).click();
    await new Promise((r) => setTimeout(r, 20));

    expect(downloads.length).toBe(1);
    expect(downloads[0]!.filename).toBe("Exportable.automation.json");
    const file = downloads[0]!.obj as Record<string, unknown>;
    expect(file.polarisAutomation).toBe(1);
    // ... and the file it wrote is stripped anyway, or an export taken from here
    // would carry delivery wiring into a ticket.
    expect(JSON.stringify(file)).not.toContain('"c1"');
    // Saving is a separate button: exporting must not touch the automation.
    expect(savedPayloads.length).toBe(0);
    expect(toastErrors).toEqual([]);
  });

  it("Export carries the operator's unsaved edit, and refuses invalid JSON in place", async () => {
    await openToSummary();
    (doc.querySelector("#aw-view-code") as unknown as { click: () => void }).click();
    await new Promise((r) => setTimeout(r, 20));

    const ta = inCode("#aw-code-text") as unknown as { value: string };
    const shown = JSON.parse(ta.value) as Record<string, unknown>;
    ta.value = JSON.stringify({ ...shown, name: "Renamed in the editor" });
    (inCode("#aw-code-export") as unknown as { click: () => void }).click();
    await new Promise((r) => setTimeout(r, 20));

    expect(downloads.length).toBe(1);
    expect(downloads[0]!.filename).toBe("Renamed in the editor.automation.json");
    expect(((downloads[0]!.obj as Record<string, unknown>).rule as Record<string, unknown>).name)
      .toBe("Renamed in the editor");

    // An unparseable edit exports nothing: a file built off the last good body
    // would be indistinguishable from one built off the edit.
    ta.value = "{ not json";
    (inCode("#aw-code-export") as unknown as { click: () => void }).click();
    await new Promise((r) => setTimeout(r, 20));
    expect(downloads.length).toBe(1);
    const err = inCode("#aw-code-err") as unknown as { textContent: string; style: { display: string } };
    expect(err.style.display).toBe("");
    expect(err.textContent).toMatch(/Invalid JSON/);
  });

  it("saving an unchanged body just closes, and a destructive edit needs a confirm", async () => {
    await openToSummary();
    (doc.querySelector("#aw-view-code") as unknown as { click: () => void }).click();
    await new Promise((r) => setTimeout(r, 20));
    const ta = inCode("#aw-code-text") as unknown as { value: string };
    const shown = JSON.parse(ta.value) as Record<string, unknown>;

    // Untouched: nothing to save.
    (inCode("#aw-code-save") as unknown as { click: () => void }).click();
    await new Promise((r) => setTimeout(r, 20));
    expect(savedPayloads.length).toBe(0);

    // Deleting the action list is destructive, so it must be confirmed —
    // showConfirm is stubbed false here, so nothing saves.
    (doc.querySelector("#aw-view-code") as unknown as { click: () => void }).click();
    await new Promise((r) => setTimeout(r, 20));
    const gutted: Record<string, unknown> = { ...shown };
    delete gutted.actions;
    (inCode("#aw-code-text") as { value: string }).value = JSON.stringify(gutted);
    (inCode("#aw-code-save") as { click: () => void }).click();
    await new Promise((r) => setTimeout(r, 40));
    expect(savedPayloads.length).toBe(0);
  });

  it("View code refuses invalid JSON in place instead of losing the edit", async () => {
    await openToSummary();
    (doc.querySelector("#aw-view-code") as unknown as { click: () => void }).click();
    await new Promise((r) => setTimeout(r, 20));
    const ta = inCode("#aw-code-text") as unknown as { value: string };
    ta.value = "{ not json";
    (inCode("#aw-code-save") as unknown as { click: () => void }).click();
    await new Promise((r) => setTimeout(r, 20));

    const err = inCode("#aw-code-err") as unknown as { textContent: string; style: { display: string } };
    expect(err.style.display).toBe("");
    expect(err.textContent).toMatch(/Invalid JSON/);
    // The textarea still holds the operator's text.
    expect((inCode("#aw-code-text") as unknown as { value: string }).value).toBe("{ not json");
    expect(savedPayloads.length).toBe(0);
  });

  it("an imported automation opens in import mode: name from the filename, created disabled", async () => {
    const P = (g.window as unknown as { PolarisAutomationPortability: Record<string, unknown> }).PolarisAutomationPortability;
    const parse = P.parseImportFile as (t: string, f: string, tt?: string[]) => Record<string, unknown>;
    const fileText = JSON.stringify({
      polarisAutomation: 1,
      dependencies: [
        { kind: "deliveryChannel", name: "NOC email" },     // the harness HAS this one
        { kind: "deliveryChannel", name: "Teams NetOps" },  // and not this one
      ],
      rule: {
        name: "name in the body is ignored",
        severity: "serious",
        trigger: { type: "asset_metric", metric: "cpuPct", aggregation: "latest", windowSec: 0, operator: ">=", threshold: 77, forDurationSec: 0 },
        scope: { allAssets: true },
        reset: { mode: "manual" },
        actions: [{ type: "event" }],
      },
    });
    const parsed = parse(fileText, "Imported rule.automation.json", ["asset_metric", "event"]);

    await (g.openAutomationWizard as (r: unknown, o?: unknown) => Promise<void>)(parsed.rule, {
      import: true,
      name: parsed.name,
      importInfo: {
        dependencies: parsed.dependencies,
        needsDevices: parsed.needsDevices,
        blankedDimensions: parsed.blankedDimensions,
        problems: parsed.problems,
      },
    });
    expect(toastErrors).toEqual([]);

    // The filename wins over the name in the body.
    expect((doc.querySelector("#aw-name") as unknown as { value: string }).value).toBe("Imported rule");
    // The banner says it lands disabled, and splits present from missing.
    const note = doc.querySelector("#aw-step-1 .aw-clone-note") as unknown as { textContent: string };
    expect(note).toBeTruthy();
    expect(note.textContent).toMatch(/disabled/);
    expect(note.textContent).toMatch(/NOC email/);
    expect(note.textContent).toMatch(/not in this install/);
    expect(note.textContent).toMatch(/Teams NetOps/);
    // Actions always needs review — an import never carries delivery wiring.
    expect(note.textContent).toMatch(/Actions/);

    // It saves as a CREATE, disabled, whatever the file said.
    (doc.querySelector('.stepper-step[data-step="6"]') as unknown as { click: () => void }).click();
    await new Promise((r) => setTimeout(r, 40));
    (doc.querySelector("#aw-save") as unknown as { click: () => void }).click();
    await new Promise((r) => setTimeout(r, 40));
    expect(savedPayloads.length).toBe(1);
    expect(savedPayloads[0]!.enabled).toBe(false);
    expect(savedPayloads[0]!.name).toBe("Imported rule");
  });

  it("refuses to save a state-probe trigger whose probe was blanked (it would watch every probe)", async () => {
    await (g.openAutomationWizard as (r: unknown, o?: unknown) => Promise<void>)(
      {
        name: "Probe rule",
        severity: "warning",
        trigger: {
          type: "asset_metric",
          metric: "customStateValue",
          aggregation: "latest",
          windowSec: 0,
          operator: "==",
          threshold: 1,
          forDurationSec: 0,
          dimensionFilter: {}, // the probe id did not survive the export
        },
        scope: { allAssets: true },
        reset: { mode: "manual" },
        actions: [{ type: "event" }],
      },
      { import: true, name: "Probe rule", importInfo: { dependencies: [], blankedDimensions: ["stateProbeId"] } },
    );
    toastErrors.length = 0;
    (doc.querySelector('.stepper-step[data-step="6"]') as unknown as { click: () => void }).click();
    await new Promise((r) => setTimeout(r, 40));
    (doc.querySelector("#aw-save") as unknown as { click: () => void }).click();
    await new Promise((r) => setTimeout(r, 40));

    expect(savedPayloads.length).toBe(0);
    expect(toastErrors.join(" ")).toMatch(/state probe/i);
  });
});

describe("dynamic recipient typeahead", () => {
  const notifyRule = {
    id: "r-recip",
    name: "CPU",
    description: null,
    enabled: true,
    severity: "warning",
    trigger: { type: "asset_metric", metric: "cpuPct", aggregation: "avg", windowSec: 300, operator: ">=", threshold: 90, forDurationSec: 0 },
    scope: { allAssets: true },
    reset: { mode: "auto" },
    cooldownSec: null,
    actions: [{ type: "notify", channelId: "c1", addresses: ["noc@example.invalid"] }],
  };

  /** Open on the stored rule and land on the actions step. */
  async function openOnStep5(): Promise<void> {
    doc.body.innerHTML = "";
    toastErrors.length = 0;
    await (g.openAutomationWizard as (r: unknown) => Promise<void>)(JSON.parse(JSON.stringify(notifyRule)));
    await new Promise((r) => setTimeout(r, 20));
    (doc.querySelector('.stepper-step[data-step="5"]') as unknown as { click: () => void }).click();
    await new Promise((r) => setTimeout(r, 20));
  }

  /** Type into one recipient box and read back what it offered. */
  function suggestionsFor(field: string, typed: string): string[] {
    const win = g.window as InstanceType<typeof Window>;
    const box = doc.querySelector('#aw-step-5 .na-recip-box[data-field="' + field + '"]')!;
    const input = box.querySelector(".na-recip-input") as unknown as { value: string; dispatchEvent: (e: unknown) => void };
    input.value = typed;
    input.dispatchEvent(new win.Event("input", { bubbles: true }));
    return Array.from(box.querySelectorAll(".aw-suggest.open .aw-suggest-item")).map((el) => el.textContent || "");
  }

  it("offers the dynamic recipients for a straight-apostrophe \"asset's\"", async () => {
    await openOnStep5();
    expect(toastErrors).toEqual([]);
    // The entries are written with a typographic apostrophe; nobody types one,
    // so this is the fold that decides whether the feature is findable at all.
    const hits = suggestionsFor("to", "asset's");
    expect(hits.join(" | ")).toContain("Asset’s Responsible Contacts");
    expect(hits.join(" | ")).toContain("Asset’s Region Users");
    // Badged as what they are, not as their raw source name.
    expect(hits.every((h) => h.includes("dynamic"))).toBe(true);
    // No level entries: the stubbed catalogue reports no nesting, and on a flat
    // one "L1 Region Users" is a synonym for the entry above it.
    expect(hits.join(" | ")).not.toContain("L1 Region Users");
  });

  it("picking one adds the same pill the address-book picker would", async () => {
    await openOnStep5();
    suggestionsFor("to", "responsible");
    const box = doc.querySelector('#aw-step-5 .na-recip-box[data-field="to"]')!;
    const item = box.querySelector(".aw-suggest.open .aw-suggest-item") as unknown as { getAttribute: (a: string) => string };
    expect(item).toBeTruthy();
    // mousedown is what commits — the click never lands, since blur closes the list.
    const win = g.window as InstanceType<typeof Window>;
    (item as unknown as { dispatchEvent: (e: unknown) => void })
      .dispatchEvent(new win.Event("mousedown", { bubbles: true }));
    const pill = box.querySelector('.tag-chip[data-kind="assetContacts"]')!;
    expect(pill).toBeTruthy();
    expect(pill.getAttribute("data-value")).toBe("1");
    expect(pill.getAttribute("data-label")).toBe("Asset’s Responsible Contacts");
  });

  it("does not offer them in Cc, where they would send to nobody", async () => {
    await openOnStep5();
    expect(suggestionsFor("cc", "asset's")).toEqual([]);
    expect(doc.querySelector('#aw-step-5 .na-recip-box[data-field="cc"] .aw-suggest-empty')).toBeTruthy();
  });
});

describe("web push recipients", () => {
  const pushRule = {
    id: "r-push",
    name: "CPU",
    description: null,
    enabled: true,
    severity: "warning",
    trigger: { type: "asset_metric", metric: "cpuPct", aggregation: "avg", windowSec: 300, operator: ">=", threshold: 90, forDurationSec: 0 },
    scope: { allAssets: true },
    reset: { mode: "auto" },
    cooldownSec: null,
    // A STORED action, so the two broadcast toggles reflect what was saved
    // rather than defaulting to checked the way a new one does.
    actions: [{ type: "notify", channelId: "c2", recipientUserIds: ["u1", "u2"], recipientDeviceRegion: true }],
  };

  async function openPushStep5(): Promise<Element> {
    doc.body.innerHTML = "";
    toastErrors.length = 0;
    await (g.openAutomationWizard as (r: unknown) => Promise<void>)(JSON.parse(JSON.stringify(pushRule)));
    await new Promise((r) => setTimeout(r, 20));
    (doc.querySelector('.stepper-step[data-step="5"]') as unknown as { click: () => void }).click();
    await new Promise((r) => setTimeout(r, 20));
    return doc.querySelector("#aw-step-5 .aw-action .aw-action-fields")!;
  }

  it("mirrors the email field: one To box of pills, no Cc/Bcc, no account multi-select", async () => {
    const fields = await openPushStep5();
    expect(toastErrors).toEqual([]);
    expect(fields.querySelector('.na-recip-box[data-field="to"]')).toBeTruthy();
    expect(fields.querySelector('.na-recip-box[data-field="cc"]')).toBeFalsy();
    expect(fields.querySelector('.na-recip-box[data-field="bcc"]')).toBeFalsy();
    // The controls the pill field replaced are gone, including the separate
    // device-region checkbox — it is a pill now, like everywhere else.
    expect(fields.querySelector(".na-users")).toBeFalsy();
    expect(fields.querySelector(".na-role-picker")).toBeFalsy();
    expect(fields.querySelector(".na-region-picker")).toBeFalsy();
    expect(fields.querySelector(".na-device-region")).toBeFalsy();
    // Stored recipients round-trip into pills, dynamic entry included.
    const box = fields.querySelector('.na-recip-box[data-field="to"]')!;
    expect(box.getAttribute("data-mode")).toBe("push");
    const kinds = Array.from(box.querySelectorAll(":scope > .tag-chip")).map((el) => el.getAttribute("data-kind"));
    expect(kinds).toEqual(["deviceRegion", "user", "user"]);
    // ...and the Address book button comes with it: the picker is where the
    // per-user device counts live.
    expect(fields.querySelector(".na-book")).toBeTruthy();
    // The broadcast toggles survive — they are capabilities no pill can express.
    expect(fields.querySelector(".na-all-users")).toBeTruthy();
    expect(fields.querySelector(".na-all-regions")).toBeTruthy();
  });

  it("names the users who would receive nothing", async () => {
    const fields = await openPushStep5();
    // u2 has no enrolled browser; picking them is not the same as reaching them.
    expect(fields.querySelector(".na-push-warn")!.textContent).toContain("Quiet");
    expect(fields.querySelector(".na-push-warn")!.textContent).toContain("1 of 2");
  });

  it("refuses a typed address — push reaches an account, not a mailbox", async () => {
    const fields = await openPushStep5();
    const win = g.window as InstanceType<typeof Window>;
    const box = fields.querySelector('.na-recip-box[data-field="to"]')!;
    const input = box.querySelector(".na-recip-input") as unknown as { value: string; dispatchEvent: (e: unknown) => void };
    input.value = "someone@example.invalid";
    input.dispatchEvent(new win.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(box.querySelector('.tag-chip[data-kind="address"]')).toBeFalsy();
    expect(toastErrors.join(" ")).toMatch(/Polaris account/i);
  });

  it("offers no Responsible Contacts entry, which has no subscription behind it", async () => {
    const fields = await openPushStep5();
    const win = g.window as InstanceType<typeof Window>;
    const box = fields.querySelector('.na-recip-box[data-field="to"]')!;
    const input = box.querySelector(".na-recip-input") as unknown as { value: string; dispatchEvent: (e: unknown) => void };
    input.value = "asset's";
    input.dispatchEvent(new win.Event("input", { bubbles: true }));
    const hits = Array.from(box.querySelectorAll(".aw-suggest.open .aw-suggest-item")).map((el) => el.textContent || "");
    expect(hits.join(" | ")).toContain("Asset’s Region Users");
    expect(hits.join(" | ")).not.toContain("Responsible Contacts");
  });
});

describe("multi-channel notify + the user-preference filter", () => {
  // The stub catalogue carries exactly one of each method: c1 (smtp) and
  // c2 (web_push) — which is what makes "does this group offer both?"
  // testable by ticking one box.
  const rule = {
    id: "r-multi",
    name: "CPU",
    description: null,
    enabled: true,
    severity: "warning",
    trigger: { type: "asset_metric", metric: "cpuPct", aggregation: "avg", windowSec: 300, operator: ">=", threshold: 90, forDurationSec: 0 },
    scope: { allAssets: true },
    reset: { mode: "auto" },
    cooldownSec: null,
    actions: [{ type: "notify", channelId: "c1", addresses: ["noc@example.invalid"] }],
  };

  async function openStep5(): Promise<Element> {
    doc.body.innerHTML = "";
    toastErrors.length = 0;
    savedPayloads.length = 0;
    await (g.openAutomationWizard as (r: unknown) => Promise<void>)(JSON.parse(JSON.stringify(rule)));
    await new Promise((r) => setTimeout(r, 20));
    (doc.querySelector('.stepper-step[data-step="5"]') as unknown as { click: () => void }).click();
    await new Promise((r) => setTimeout(r, 20));
    return doc.querySelector("#aw-step-5 .aw-action .aw-action-fields")!;
  }

  function tick(fields: Element, id: string, on: boolean) {
    const win = g.window as InstanceType<typeof Window>;
    const cb = fields.querySelector(`.na-chan[value="${id}"]`) as unknown as
      { checked: boolean; dispatchEvent: (e: unknown) => void };
    cb.checked = on;
    cb.dispatchEvent(new win.Event("change", { bubbles: true }));
  }

  it("offers channels as a checklist, with the stored one ticked", async () => {
    const fields = await openStep5();
    expect(toastErrors).toEqual([]);
    // The single-select is gone — an action delivers through a SET of channels.
    expect(fields.querySelector(".na-channel")).toBeFalsy();
    const boxes = Array.from(fields.querySelectorAll(".na-chan")) as unknown as { value: string; checked: boolean }[];
    expect(boxes.map((b) => b.value)).toEqual(["c1", "c2"]);
    expect(boxes.map((b) => b.checked)).toEqual([true, false]);
  });

  it("grays the preference checkbox while the group offers only one method", async () => {
    const fields = await openStep5();
    // Email alone: honouring a push-preferring recipient's choice here would
    // remove them from the alert rather than route it (business rule 39).
    const cb = fields.querySelector(".na-pref-enable") as unknown as { disabled: boolean };
    expect(cb.disabled).toBe(true);
    expect(fields.querySelector(".na-pref-hint")!.textContent)
      .toMatch(/once this list offers both an email and a push channel/i);
  });

  it("enables it the moment the same action picks up a push channel", async () => {
    const fields = await openStep5();
    tick(fields, "c2", true);
    await new Promise((r) => setTimeout(r, 10));
    const cb = fields.querySelector(".na-pref-enable") as unknown as { disabled: boolean };
    expect(cb.disabled).toBe(false);
    // A mixed action renders the union: email's Cc/Bcc AND push's broadcast
    // toggles, off one shared To list.
    expect(fields.querySelector('.na-recip-box[data-field="cc"]')).toBeTruthy();
    expect(fields.querySelector('.na-recip-box[data-field="bcc"]')).toBeTruthy();
    expect(fields.querySelector(".na-all-users")).toBeTruthy();
    // The To box stays permissive: an email channel can still carry an address.
    expect(fields.querySelector('.na-recip-box[data-field="to"]')!.getAttribute("data-mode")).toBe("email");
  });

  it("saves channelIds with the primary first, and the flag once it is enabled", async () => {
    const fields = await openStep5();
    tick(fields, "c2", true);
    await new Promise((r) => setTimeout(r, 10));
    const win = g.window as InstanceType<typeof Window>;
    const pref = fields.querySelector(".na-pref-enable") as unknown as
      { checked: boolean; dispatchEvent: (e: unknown) => void };
    pref.checked = true;
    pref.dispatchEvent(new win.Event("change", { bubbles: true }));
    // "All Users" defaults on for a NEW push action; this one is stored, so it
    // is off and the To list still answers for both halves.
    (doc.querySelector("#aw-save") as unknown as { click: () => void }).click();
    await new Promise((r) => setTimeout(r, 30));
    expect(toastErrors).toEqual([]);
    const p = savedPayloads[0]! as Record<string, any>;
    const a = p.actions[0];
    expect(a.channelIds).toEqual(["c1", "c2"]);
    // channelId is the lossless single-channel mirror — the server refuses a
    // payload where it is not channelIds[0].
    expect(a.channelId).toBe("c1");
    expect(a.respectUserPreference).toBe(true);
    expect(() => ruleInputSchema.parse(p)).not.toThrow();
  });

  it("never saves the flag from a disabled checkbox", async () => {
    const fields = await openStep5();
    tick(fields, "c2", true);
    await new Promise((r) => setTimeout(r, 10));
    const win = g.window as InstanceType<typeof Window>;
    const pref = fields.querySelector(".na-pref-enable") as unknown as
      { checked: boolean; disabled: boolean; dispatchEvent: (e: unknown) => void };
    pref.checked = true;
    pref.dispatchEvent(new win.Event("change", { bubbles: true }));
    // Take the push channel away again: the group is single-method once more,
    // so the ticked-but-inert box must not persist — it would resurface on the
    // next edit as a setting that does nothing.
    tick(fields, "c2", false);
    await new Promise((r) => setTimeout(r, 10));
    expect(pref.disabled).toBe(true);
    (doc.querySelector("#aw-save") as unknown as { click: () => void }).click();
    await new Promise((r) => setTimeout(r, 30));
    expect(toastErrors).toEqual([]);
    const a = (savedPayloads[0]! as Record<string, any>).actions[0];
    expect(a.respectUserPreference).toBeUndefined();
    expect(a.channelIds).toBeUndefined();
    expect(a.channelId).toBe("c1");
  });
});
