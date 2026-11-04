/**
 * tests/unit/assetsMaintenanceEditMode.test.ts — the Maintenance modal's
 * editor tab says what Save will do. Opening a stored schedule (from the
 * Schedules tab, the Active Maintenance widget or the Events calendar) renames
 * the tab "Edit Schedule" and the banner names who created it; Cancel Edit
 * clears the form and renames it back to "Create Schedule". The Schedules list
 * carries a Created by column.
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Window } from "happy-dom";

vi.mock("../../src/db.js", () => ({ prisma: {} }));

const g = globalThis as Record<string, unknown>;

let win: Window;
let openMaintenanceModal: (opts?: { scheduleId?: string }) => Promise<void>;

const SCHEDULES = [
  {
    id: "s1", name: "Core switch patching", enabled: true, suppressChildren: true,
    criteria: { rules: [{ field: "hostname", op: "contains", value: "core" }] }, assetIds: [], pathCheckIds: [],
    schedule: { kind: "oneshot", startAt: "2026-11-10T20:00", endAt: "2026-11-10T22:00" },
    createdBy: "jsmith", createdAt: "2026-11-01T14:00:00.000Z",
  },
  {
    id: "s2", name: "Legacy window", enabled: true, suppressChildren: true,
    criteria: { rules: [{ field: "hostname", op: "contains", value: "old" }] }, assetIds: [], pathCheckIds: [],
    schedule: { kind: "oneshot", startAt: "2026-11-11T20:00", endAt: "2026-11-11T22:00" },
    createdBy: null, createdAt: "2026-01-01T00:00:00.000Z",
  },
];

/** The real tab strip shape (app.js tabbedBodyHTML), so the tab label the
 *  module renames is the element a browser shows. */
function renderTabbedBody(prefix: string, tabs: { key: string; label: string; html: string }[]): string {
  return '<div class="page-tabs" id="' + prefix + '-tabs">' +
    tabs.map((t) => '<button type="button" class="page-tab" data-tab="' + t.key + '">' + t.label + "</button>").join("") +
    "</div>" + tabs.map((t) => '<div id="' + prefix + "-tab-" + t.key + '">' + t.html + "</div>").join("");
}

beforeAll(() => {
  win = new Window();
  g.window = win;
  g.document = win.document;
  g.escapeHtml = (s: unknown) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;");
  g.showToast = () => {};
  g.showConfirm = async () => false;
  g.closeModal = () => {};
  g.wireModalTabs = () => {};
  g.tabbedBodyHTML = renderTabbedBody;
  g.collectTagCriteria = () => null;
  g.openModal = (_title: string, body: string, footer: string) => {
    win.document.body.innerHTML = body + footer;
  };
  g.api = {
    assetTypes: { list: async () => [] },
    integrations: { list: async () => ({ integrations: [] }) },
    assets: { list: async () => ({ assets: [] }) },
    maintenanceSchedules: {
      list: async () => ({ schedules: SCHEDULES }),
      occurrences: async () => ({ occurrences: [] }),
      preview: async () => ({ total: 0, assets: [] }),
    },
  };
  (0, eval)(readFileSync(resolve(__dirname, "../../public/js/recurrence-editor.js"), "utf8"));
  (0, eval)(readFileSync(resolve(__dirname, "../../public/js/assets-maintenance.js"), "utf8"));
  openMaintenanceModal = (win as unknown as { openMaintenanceModal: typeof openMaintenanceModal }).openMaintenanceModal;
});

beforeEach(() => { win.document.body.innerHTML = ""; });

const tabLabel = () => win.document.querySelector('#maint-tabs .page-tab[data-tab="create"]')!.textContent;
const el = (id: string) => win.document.getElementById(id) as unknown as
  { value: string; textContent: string; style: { display: string }; click: () => void };

describe("Maintenance modal edit mode", () => {
  it("a fresh modal's editor tab reads Create Schedule", async () => {
    await openMaintenanceModal();
    expect(tabLabel()).toBe("Create Schedule");
    expect(el("maint-cancel-edit").style.display).toBe("none");
  });

  it("opening a schedule renames the tab to Edit Schedule and names its creator", async () => {
    await openMaintenanceModal({ scheduleId: "s1" });
    expect(tabLabel()).toBe("Edit Schedule");
    expect(el("maint-name").value).toBe("Core switch patching");
    expect(el("maint-edit-banner").textContent).toContain("created by jsmith");
    expect(el("maint-save").textContent).toBe("Save Changes");
  });

  it("a schedule with no recorded creator says so rather than naming nobody", async () => {
    await openMaintenanceModal({ scheduleId: "s2" });
    expect(el("maint-edit-banner").textContent).toContain("created by an unknown user");
  });

  it("Cancel Edit clears the form and renames the tab back to Create Schedule", async () => {
    await openMaintenanceModal({ scheduleId: "s1" });
    el("maint-cancel-edit").click();
    expect(tabLabel()).toBe("Create Schedule");
    expect(el("maint-name").value).toBe("");
    expect(el("maint-save").textContent).toBe("Create Schedule");
    expect(el("maint-edit-banner").style.display).toBe("none");
  });

  it("the Schedules list has a Created by column", async () => {
    await openMaintenanceModal();
    await new Promise((r) => setTimeout(r, 10));
    const body = win.document.getElementById("maint-list-body")!;
    const heads = Array.from(body.querySelectorAll("th")).map((th) => th.textContent);
    expect(heads).toContain("Created by");
    const rows = Array.from(body.querySelectorAll("tbody tr"));
    expect(rows[0].textContent).toContain("jsmith");
    expect(rows[1].textContent).toContain("—");
  });
});
