/**
 * tests/unit/assetsMaintenanceSelection.test.ts — pins the Assets-page bulk-bar
 * path into the Maintenance modal: select rows → Maintenance →
 * openMaintenanceModal({ assetIds }).
 *
 * The pins ride the SAME `_maintEditingAssetIds` channel an edited schedule's
 * stored assetIds ride, which is the whole point of the design — the preview,
 * the explicit-includes line and the save body get no selection-specific path.
 * That reuse is only correct if the pins survive `_maintWireEditor()`, which
 * resets the editor's fields, so the ordering inside openMaintenanceModal is
 * what these tests actually guard: a prefill done too early is silently wiped
 * and the operator sees an empty form that ignores their selection.
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Window } from "happy-dom";

vi.mock("../../src/db.js", () => ({ prisma: {} }));

const g = globalThis as Record<string, unknown>;

type PreviewArg = { criteria: unknown; assetIds: string[] };
const previewCalls: PreviewArg[] = [];

let win: Window;
let openMaintenanceModal: (opts?: { assetIds?: string[] }) => Promise<void>;

/** The tabbed-body stub concatenates every tab's html, so the editor markup
 *  openMaintenanceModal wires against is the REAL _maintEditorHTML() output. */
function renderTabbedBody(_prefix: string, tabs: { html: string }[]): string {
  return tabs.map((t) => t.html).join("");
}

beforeAll(() => {
  win = new Window();
  g.window = win;
  g.document = win.document;
  g.escapeHtml = (s: unknown) => String(s ?? "");
  g.showToast = () => {};
  g.showConfirm = async () => false;
  g.closeModal = () => {};
  g.wireModalTabs = () => {};
  g.tabbedBodyHTML = renderTabbedBody;
  g.collectTagCriteria = () => null; // empty rule row → no criteria
  g.openModal = (_title: string, body: string) => {
    win.document.body.innerHTML = body;
  };
  g.api = {
    assetTypes: { list: async () => [] },
    integrations: { list: async () => ({ integrations: [] }) },
    assets: { list: async () => ({ assets: [] }) },
    maintenanceSchedules: {
      list: async () => ({ schedules: [] }),
      occurrences: async () => ({ occurrences: [] }),
      preview: async (arg: PreviewArg) => {
        previewCalls.push({ criteria: arg.criteria, assetIds: (arg.assetIds || []).slice() });
        return { total: arg.assetIds.length, assets: [] };
      },
    },
  };
  // The shared recurrence editor, loaded before this file on every page that
  // carries it: the schedule editor's days-and-hours rows are built from it
  // while the modal body is assembled, so without it the whole modal throws.
  (0, eval)(readFileSync(resolve(__dirname, "../../public/js/recurrence-editor.js"), "utf8"));
  const src = readFileSync(resolve(__dirname, "../../public/js/assets-maintenance.js"), "utf8");
  (0, eval)(src);
  openMaintenanceModal = (win as unknown as { openMaintenanceModal: typeof openMaintenanceModal })
    .openMaintenanceModal;
});

beforeEach(() => {
  previewCalls.length = 0;
  win.document.body.innerHTML = "";
});

const $ = (id: string) => win.document.getElementById(id) as unknown as
  { value: string; style: { display: string }; textContent: string; innerHTML: string } | null;

describe("openMaintenanceModal with a bulk-bar selection", () => {
  it("shows the explicit-includes line with the selected count", async () => {
    await openMaintenanceModal({ assetIds: ["a1", "a2", "a3"] });
    const line = $("maint-explicit")!;
    expect(line.style.display).not.toBe("none");
    expect(line.innerHTML).toContain("<strong>3</strong>");
    expect(line.innerHTML).toContain("device");
    // Only monitored assets are eligible targets — say so where the operator
    // is looking, since a selection may well include unmonitored rows.
    expect(line.innerHTML).toContain("monitored");
  });

  it("prefills a name so the form is savable, and pluralizes it", async () => {
    await openMaintenanceModal({ assetIds: ["a1", "a2"] });
    expect($("maint-name")!.value).toBe("Maintenance — 2 devices");
    await openMaintenanceModal({ assetIds: ["a1"] });
    expect($("maint-name")!.value).toBe("Maintenance — 1 device");
  });

  it("previews the pinned devices even with no filter rule", async () => {
    await openMaintenanceModal({ assetIds: ["a1", "a2"] });
    // The preview is debounced (400ms) — nothing has been asked for yet.
    expect(previewCalls).toHaveLength(0);
    await new Promise((r) => setTimeout(r, 500));
    expect(previewCalls).toHaveLength(1);
    expect(previewCalls[0].assetIds).toEqual(["a1", "a2"]);
    expect(previewCalls[0].criteria).toBeNull();
  });

  it("does not mutate the caller's selection array", async () => {
    const ids = ["a1", "a2"];
    await openMaintenanceModal({ assetIds: ids });
    const removeBtn = win.document.getElementById("maint-clear-explicit") as unknown as
      { click: () => void } | null;
    removeBtn!.click();
    expect(ids).toEqual(["a1", "a2"]);
    expect($("maint-explicit")!.style.display).toBe("none");
  });

  it("opens with no pins when called from the toolbar button (no opts)", async () => {
    await openMaintenanceModal();
    expect($("maint-explicit")!.style.display).toBe("none");
    expect($("maint-name")!.value).toBe("");
    await new Promise((r) => setTimeout(r, 500));
    expect(previewCalls).toHaveLength(0);
  });
});
