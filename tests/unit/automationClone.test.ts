/**
 * tests/unit/automationClone.test.ts — the Automations list's Clone action.
 *
 * Two halves, both regression-prone:
 *
 *  1. `cloneName` (public/js/automations.js) — the suggested copy name.
 *     NotificationRule.name has no unique constraint, so a bad suggestion saves
 *     cleanly and simply leaves two indistinguishable rows in the list. Repeated
 *     cloning is the case that actually happens, so "(copy) (copy)" is pinned out.
 *
 *  2. Clone mode in `openAutomationWizard` (public/js/automations-wizard.js) —
 *     a clone is populated like an edit but must save as a CREATE, and must be
 *     created DISABLED. That second part is the load-bearing one: business
 *     rule 18 says two automations with the same trigger signature at the same
 *     scope rank BOTH fire, and a clone is by construction identical to its
 *     source, so an enabled clone double-alerts the entire matched fleet. The
 *     wizard has no enabled control to make that visible, so nothing but this
 *     test stops a refactor from quietly flipping it back on.
 *
 * Both files are plain browser scripts (no module exports), so each is eval'd
 * into a happy-dom Window with the app-shell globals stubbed — the approach in
 * automationsScopeTooltip.test.ts and automationsWizardDom.test.ts.
 */

import { describe, it, expect, beforeAll, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Window } from "happy-dom";
import { buildSchemaCatalog, ruleInputSchema } from "../../src/services/notificationTypes.js";
import { dimensionPickerMeta } from "../../src/services/notificationDimensionService.js";

vi.mock("../../src/db.js", () => ({ prisma: {} }));

const g = globalThis as Record<string, unknown>;

// ── Part 1: cloneName ───────────────────────────────────────────────────────

describe("cloneName", () => {
  let cloneName: (base: string, taken?: string[]) => string;

  beforeAll(() => {
    const win = new Window();
    win.document.body.innerHTML = '<button id="btn-refresh"></button>';
    g.window = win;
    g.document = win.document;
    g.escapeHtml = (s: unknown) => String(s ?? "");
    g.showToast = () => {};
    g.showConfirm = async () => false;
    g.permAtLeast = () => false;
    g.api = {};
    g._ruleSchema = null;
    (0, eval)(readFileSync(resolve(__dirname, "../../public/js/automations.js"), "utf8"));
    cloneName = (win as unknown as { _automationCloneName: typeof cloneName })._automationCloneName;
    expect(typeof cloneName, "automations.js no longer exports _automationCloneName").toBe("function");
  });

  it("suffixes an unused name with (copy)", () => {
    expect(cloneName("High CPU usage", ["High CPU usage"])).toBe("High CPU usage (copy)");
  });

  it("walks to the next free number when copies already exist", () => {
    const taken = ["High CPU usage", "High CPU usage (copy)"];
    expect(cloneName("High CPU usage", taken)).toBe("High CPU usage (copy 2)");
    expect(cloneName("High CPU usage", taken.concat("High CPU usage (copy 2)")))
      .toBe("High CPU usage (copy 3)");
  });

  it("strips the source's own copy suffix instead of nesting one", () => {
    // Cloning a clone is the common case — "X (copy) (copy)" is the bug.
    expect(cloneName("High CPU usage (copy)", ["High CPU usage", "High CPU usage (copy)"]))
      .toBe("High CPU usage (copy 2)");
    expect(cloneName("High CPU usage (copy 3)", ["High CPU usage (copy 3)"]))
      .toBe("High CPU usage (copy)");
  });

  it("compares names case-insensitively and ignores surrounding whitespace", () => {
    expect(cloneName("Disk full", ["disk full (COPY)"])).toBe("Disk full (copy 2)");
    expect(cloneName("Disk full", ["  Disk full (copy)  "])).toBe("Disk full (copy 2)");
  });

  it("falls back to a usable name when the source name is empty", () => {
    expect(cloneName("", [])).toBe("Automation (copy)");
    expect(cloneName("(copy)", [])).toBe("Automation (copy)");
  });

  it("never returns an empty string", () => {
    expect(cloneName("   ", []).length).toBeGreaterThan(0);
  });
});

// ── Part 2: wizard clone mode ───────────────────────────────────────────────

/** A complete, valid stored rule — the shape the list hands the wizard. */
const SOURCE_RULE = {
  id: "rule-1",
  name: "High CPU usage",
  description: "Watches sustained CPU",
  enabled: true,
  severity: "warning",
  trigger: {
    type: "asset_metric", metric: "cpuPct", aggregation: "latest",
    windowSec: 0, operator: ">=", threshold: 90, forDurationSec: 300,
  },
  scope: { allAssets: true },
  reset: { mode: "auto" },
  actions: [{ type: "event" }],
  cooldownSec: null,
  messageTemplate: null,
  escalation: null,
  severityBands: null,
  bandNotify: null,
  resetActions: null,
};

describe("openAutomationWizard — clone mode", () => {
  let doc: Window["document"];
  let toastErrors: string[];
  let toastSuccesses: string[];
  const created: Record<string, unknown>[] = [];
  const updated: Array<{ id: string; payload: Record<string, unknown> }> = [];
  const previewBodies: Record<string, unknown>[] = [];

  beforeAll(async () => {
    const win = new Window();
    doc = win.document;
    g.window = win;
    g.document = doc;
    toastErrors = [];
    toastSuccesses = [];
    g.escapeHtml = (s: unknown) =>
      String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
    g.showToast = (msg: string, kind: string) => {
      if (kind === "error") toastErrors.push(msg); else toastSuccesses.push(msg);
    };
    // A clone must never consult the unsaved-draft stash; if it did, this
    // always-false confirm would still be the wrong branch to take.
    g.showConfirm = async () => false;
    g.permAtLeast = () => true;
    g.closeModal = () => {};
    g.openModal = (title: string, body: string, footer: string) => {
      doc.body.innerHTML =
        '<div class="modal"><div class="modal-header"><h3 id="test-modal-title">' + title + "</h3></div>" +
        '<div class="modal-body">' + body + "</div>" +
        '<div class="modal-footer">' + footer + "</div></div>";
    };
    g.api = {
      automations: {
        update: async (id: string, payload: unknown) => {
          updated.push({ id, payload: payload as Record<string, unknown> }); return { rule: {} };
        },
        create: async (payload: unknown) => {
          created.push(payload as Record<string, unknown>); return { rule: {} };
        },
        schema: async () => ({ ...buildSchemaCatalog(), dimensionPickers: dimensionPickerMeta() }),
        recipientUsers: async () => ({ users: [] }),
        scopeOptions: async () => ({ manufacturers: [], models: [], subnets: [], regions: [] }),
        preview: async (body: Record<string, unknown>) => {
          previewBodies.push(body);
          return { supported: true, totalEvaluated: 0, totalAssets: 0, matches: [] };
        },
        dimensionValues: async () => ({ values: [], noun: "", narrowLabel: "", scopedAssets: 0, sampledAssets: 0, assetsWithData: 0, windowHours: 3 }),
      },
      assets: { tags: async () => ({ tags: [] }) },
      assetTypes: { list: async () => ({ types: [{ name: "server", label: "Server" }] }) },
      deliveryChannels: { list: async () => ({ channels: [] }) },
      automationScripts: { list: async () => ({ scripts: [] }) },
      contacts: { list: async () => ({ contacts: [] }) },
    };
    g._ruleSchema = null;
    g._ruleTagList = null;
    g._ruleAssetTypes = null;
    g._ruleChannels = null;
    g._ruleRecipientUsers = null;
    g._looksLikeDeviceId = () => false;

    // condition-builder.js and the shared device-selection vocabulary both
    // load before the wizard on every page carrying it, and the wizard reads
    // both while assembling the modal body.
    (0, eval)(readFileSync(resolve(__dirname, "../../public/js/condition-builder.js"), "utf8"));
    (0, eval)(readFileSync(resolve(__dirname, "../../public/js/scope-vocabulary.js"), "utf8"));
    (0, eval)(readFileSync(resolve(__dirname, "../../public/js/automations-wizard.js"), "utf8"));

    await (g.openAutomationWizard as (r: unknown, o?: unknown) => Promise<void>)(
      SOURCE_RULE, { clone: true, name: "High CPU usage (copy)" },
    );
  });

  it("opens without error, titled as a clone", () => {
    expect(toastErrors).toEqual([]);
    expect(doc.querySelector("#test-modal-title")!.textContent).toBe("Clone automation");
  });

  it("labels the primary button 'Create clone', not 'Save changes'", () => {
    expect(doc.querySelector("#aw-save")!.textContent).toBe("Create clone");
  });

  it("unlocks every step, like edit mode", () => {
    // A populated draft shouldn't force a 6-step walk to change one threshold.
    expect(doc.querySelectorAll("#aw-stepper .stepper-step").length).toBe(6);
    expect((doc.querySelector("#aw-save") as unknown as { style: { display: string } }).style.display).not.toBe("none");
  });

  it("pre-fills the caller's suggested name", () => {
    expect((doc.querySelector("#aw-name") as unknown as { value: string }).value).toBe("High CPU usage (copy)");
  });

  it("carries the source's description over", () => {
    expect((doc.querySelector("#aw-desc") as unknown as { value: string }).value).toBe("Watches sustained CPU");
  });

  it("pre-selects the source's severity in the trigger step", () => {
    // Asserted on the rendered `selected` attribute, NOT on select.value.
    //
    // Opening the wizard runs wireStep3 → renderTriggerFields →
    // refreshTriggerSentence → collectStep3, whose last act is
    // `draft.severity = baseSel.value` — a no-op re-assert in a browser, where
    // that select reads back the option marked `selected`. happy-dom returns a
    // different option for this control in that context, so the DRAFT (and
    // therefore any payload saved without visiting step 3) picks up a value the
    // real page never produces. Verified against a live browser: severity
    // survives an edit-and-save from step 1. The attribute is the only
    // harness-independent statement of what the wizard actually painted.
    const selected = doc.querySelector("#aw-trigger-severity option[selected]");
    expect(selected).toBeTruthy();
    expect(selected!.getAttribute("value")).toBe("warning");
  });

  it("names the source and warns that the copy starts disabled", () => {
    const note = doc.querySelector(".aw-clone-note");
    expect(note).toBeTruthy();
    expect(note!.textContent).toContain("High CPU usage");
    expect(note!.textContent!.toLowerCase()).toContain("disabled");
  });

  it("does not send the source's id to the preview — the clone is a peer, not itself", async () => {
    // Sending it would suppress the carve-out/tie warning against the very
    // automation the operator just copied, which is the one they most need.
    await new Promise((r) => setTimeout(r, 30));
    previewBodies.forEach((b) => expect(b.id).toBeUndefined());
  });

  it("saves as a CREATE with enabled:false, and the payload validates server-side", async () => {
    (doc.querySelector("#aw-save") as unknown as { click: () => void }).click();
    await new Promise((r) => setTimeout(r, 60));

    expect(toastErrors).toEqual([]);
    expect(updated, "a clone must never PUT over the rule it was copied from").toEqual([]);
    expect(created.length).toBe(1);

    const payload = created[0]!;
    expect(payload.enabled).toBe(false);
    expect(payload.name).toBe("High CPU usage (copy)");
    // The copied behaviour survives the round trip.
    expect(payload.trigger).toMatchObject({ metric: "cpuPct", threshold: 90, forDurationSec: 300 });
    expect(payload.scope).toMatchObject({ allAssets: true });
    expect(payload.actions).toEqual([{ type: "event" }]);
    // No stray id anywhere in the create body.
    expect((payload as { id?: unknown }).id).toBeUndefined();
    // And the server's own schema accepts it.
    expect(() => ruleInputSchema.parse(payload)).not.toThrow();
    // NOTE: payload.severity is deliberately NOT asserted here — see the
    // severity test above. collectStep3 re-asserts draft.severity from the
    // select, which happy-dom reads back wrongly, so the value reaching this
    // payload is a harness artifact rather than product behaviour. The rendered
    // `selected` option is pinned above instead.
  });

  it("says the clone starts disabled in the success toast", () => {
    expect(toastSuccesses.join(" ").toLowerCase()).toContain("disabled");
  });
});
