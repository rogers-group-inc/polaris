/**
 * tests/unit/assetsMaintenancePathChecks.test.ts — the Maintenance modal's
 * PATH-CHECK mode (business rule 135): openMaintenanceModal({ target:
 * "pathChecks" }) from the Path Monitor page.
 *
 * Pins what the mode swaps and what it must not: the check picker replaces the
 * asset filter, its preview and the dependents toggle; the Schedules tab asks
 * for path-check schedules only; Save posts `pathCheckIds` and NO asset fields
 * (the server refuses a body carrying both); and asset mode is unchanged —
 * opening it after a path-mode session lists asset schedules again.
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Window } from "happy-dom";

vi.mock("../../src/db.js", () => ({ prisma: {} }));

const g = globalThis as Record<string, unknown>;

const listCalls: Array<string | undefined> = [];
const created: Array<Record<string, unknown>> = [];
const toasts: Array<[string, string | undefined]> = [];
let changed = 0;

let win: Window;
let openMaintenanceModal: (opts?: Record<string, unknown>) => Promise<void>;

beforeAll(() => {
  win = new Window();
  g.window = win;
  g.document = win.document;
  g.escapeHtml = (s: unknown) => String(s ?? "");
  g.showToast = (msg: string, kind?: string) => { toasts.push([msg, kind]); };
  g.showConfirm = async () => false;
  g.closeModal = () => {};
  g.wireModalTabs = () => {};
  g.tabbedBodyHTML = (_p: string, tabs: { html: string }[]) => tabs.map((t) => t.html).join("");
  g.collectTagCriteria = () => null;
  g.openModal = (_title: string, body: string, footer: string) => {
    win.document.body.innerHTML = body + footer;
  };
  g.api = {
    assetTypes: { list: async () => [] },
    integrations: { list: async () => ({ integrations: [] }) },
    assets: { list: async () => ({ assets: [] }) },
    pathChecks: {
      list: async () => ({
        checks: [
          { id: "c1", name: "Payroll", kind: "https", target: "https://pay.example" },
          { id: "c2", name: "Intranet", kind: "https", target: "https://intra.example" },
        ],
      }),
    },
    maintenanceSchedules: {
      list: async (target?: string) => { listCalls.push(target); return { schedules: [] }; },
      occurrences: async () => ({ occurrences: [] }),
      preview: async () => ({ total: 0, assets: [] }),
      serverTime: async () => ({ now: "2026-07-10T12:00", timeZone: "UTC" }),
      create: async (body: Record<string, unknown>) => { created.push(body); return { schedule: { id: "s1" } }; },
    },
  };
  (0, eval)(readFileSync(resolve(__dirname, "../../public/js/recurrence-editor.js"), "utf8"));
  (0, eval)(readFileSync(resolve(__dirname, "../../public/js/assets-maintenance.js"), "utf8"));
  openMaintenanceModal = (win as unknown as { openMaintenanceModal: typeof openMaintenanceModal }).openMaintenanceModal;
});

beforeEach(() => {
  listCalls.length = 0;
  created.length = 0;
  toasts.length = 0;
  changed = 0;
  win.document.body.innerHTML = "";
});

const el = (id: string) => win.document.getElementById(id) as any;
const settle = () => new Promise((r) => setTimeout(r, 0));

describe("Maintenance modal — path-check mode (rule 135)", () => {
  it("swaps the asset filter, preview and dependents toggle for a check picker", async () => {
    await openMaintenanceModal({ target: "pathChecks" });
    await settle();
    // No asset filter. (Not `#maint-rules` — the recurrence editor's host
    // carries that id too, which is the trap the next test pins.)
    expect(win.document.querySelectorAll(".maint-rule")).toHaveLength(0);
    expect(el("maint-add-rule")).toBeNull();
    expect(el("maint-preview")).toBeNull();
    expect(el("maint-suppress-children").closest(".form-group").getAttribute("style")).toContain("display:none");
    const boxes = win.document.querySelectorAll(".maint-pc-cb");
    expect(boxes).toHaveLength(2);
    expect(listCalls).toEqual(["pathChecks"]);
  });

  it("pre-ticks the checks it was opened with, names the schedule, and saves pathCheckIds only", async () => {
    await openMaintenanceModal({ target: "pathChecks", pathCheckIds: ["c2"], onChange: () => { changed++; } });
    await settle();
    expect(el("maint-name").value).toBe("Maintenance — 1 path check");
    const ticked = [...win.document.querySelectorAll(".maint-pc-cb")].filter((b: any) => b.checked).map((b: any) => b.value);
    expect(ticked).toEqual(["c2"]);
    expect(el("maint-pc-count").textContent).toBe("1 path check selected");

    // Tick the other one through the picker.
    const c1 = [...win.document.querySelectorAll(".maint-pc-cb")].find((b: any) => b.value === "c1") as any;
    c1.checked = true;
    c1.dispatchEvent(new win.Event("change", { bubbles: true }));
    expect(el("maint-pc-count").textContent).toBe("2 path checks selected");

    el("maint-save").click();
    await settle(); await settle();
    expect(created).toHaveLength(1);
    expect(created[0].pathCheckIds).toEqual(["c2", "c1"]);
    expect(created[0]).not.toHaveProperty("assetIds");
    expect(created[0]).not.toHaveProperty("criteria");
    expect(changed).toBe(1);
    // The reset after a save must leave the days-and-hours editor intact: it
    // shares the id "maint-rules" with the asset filter, and an id lookup in
    // path mode used to overwrite it with an asset rule row.
    expect(win.document.querySelector("#maint-days .rc-rules")).not.toBeNull();
    expect(win.document.querySelectorAll("#maint-days .maint-rule")).toHaveLength(0);
  });

  it("refuses to save with no check ticked", async () => {
    await openMaintenanceModal({ target: "pathChecks" });
    await settle();
    el("maint-name").value = "Empty";
    el("maint-save").click();
    await settle();
    expect(created).toHaveLength(0);
    expect(toasts.some(([m, k]) => /Tick at least one path check/.test(m) && k === "error")).toBe(true);
  });

  it("leaves asset mode as it was: the next plain open lists asset schedules and shows the filter", async () => {
    await openMaintenanceModal({ target: "pathChecks" });
    await openMaintenanceModal();
    await settle();
    expect(listCalls).toEqual(["pathChecks", "assets"]);
    expect(el("maint-rules")).not.toBeNull();
    expect(el("maint-pc-list")).toBeNull();
  });
});
