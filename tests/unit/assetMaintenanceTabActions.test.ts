/**
 * tests/unit/assetMaintenanceTabActions.test.ts — the Maintenance tab of the
 * asset edit modal: the covering-schedule rows and their two actions
 * (`_maintenanceInfoHTML` / `_wireMaintenanceScheduleActions` in
 * public/js/assets.js).
 *
 * What the rows have to get right, and why each is pinned here:
 *
 *  - The actions are maintenanceManagement:fullwrite. A reader sees the same
 *    coverage lines with no buttons at all, rather than buttons that 403.
 *  - A schedule that reaches the asset through its FILTER offers no per-asset
 *    removal: dropping the explicit id would leave the filter matching and the
 *    next reconcile would put the asset straight back, so the row says to edit
 *    the filter instead. The server refuses the same call (see
 *    removeAssetFromSchedule) — this keeps the UI from asking for it.
 *  - A schedule whose only device is this asset is deleted by the removal, and
 *    the confirm has to say so BEFORE the operator agrees to it.
 *
 * assets.js is an ~18k-line browser script with no module boundary, so the
 * three functions are sliced out by name and eval'd — the approach in
 * assetRowMenu.test.ts.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Window } from "happy-dom";

vi.mock("../../src/db.js", () => ({ prisma: {} }));

const g = globalThis as Record<string, any>;
const assetsLines = readFileSync(resolve(__dirname, "../../public/js/assets.js"), "utf8").split(/\r?\n/);

/** Slice a top-level `function NAME(...) {` … `}` block out of assets.js. */
function fnSrc(name: string): string {
  const start = assetsLines.findIndex((l) => l.startsWith(`function ${name}(`));
  if (start < 0) throw new Error(`assets.js: function ${name} not found`);
  const end = assetsLines.findIndex((l, i) => i > start && l === "}");
  if (end < 0) throw new Error(`assets.js: no end of function ${name}`);
  return assetsLines.slice(start, end + 1).join("\n");
}

const win = new Window();
g.window = win;
g.document = win.document;
g.escapeHtml = (s: unknown) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");

let canManage = true;
g.canManageMaintenance = () => canManage;

let confirmAnswer = true;
const toasts: Array<{ msg: string; kind?: string }> = [];
g.showConfirm = vi.fn(async () => confirmAnswer);
g.showToast = (msg: string, kind?: string) => { toasts.push({ msg, kind }); };
g.loadAssets = vi.fn();

const removeAsset = vi.fn(async () => ({ scheduleDeleted: false, scheduleName: "Nightly", remainingAssetIds: 2 }));
const deleteSchedule = vi.fn(async () => {});
let infoPayload: any = { openWindows: [], schedules: [] };
g.api = {
  assets: { maintenanceInfo: vi.fn(async () => infoPayload) },
  maintenanceSchedules: { removeAsset, delete: deleteSchedule },
};

// eslint-disable-next-line @typescript-eslint/no-implied-eval
(0, eval)(
  [
    fnSrc("_loadMaintenanceEditInfo"),
    fnSrc("_syncStatusSelectTo"),
    fnSrc("_maintenanceInfoHTML"),
    fnSrc("_wireMaintenanceScheduleActions"),
  ].join("\n") +
    // Indirect eval runs in global scope, so the handles are hung off
    // globalThis — this file's own `g` binding isn't visible in there.
    "\nglobalThis.__load = _loadMaintenanceEditInfo; globalThis.__html = _maintenanceInfoHTML;",
);

const load = (assetId: string) => g.__load({ id: assetId }) as void;
const infoHTML = (info: any) => g.__html(info) as string;

function schedule(over: Record<string, unknown> = {}) {
  return {
    id: "s1",
    name: "Nightly",
    enabled: true,
    activeNow: true,
    nextStart: null,
    nextEnd: null,
    explicit: true,
    byCriteria: false,
    removable: true,
    lastTarget: false,
    ...over,
  };
}

/**
 * Render into a real #f-maint-info element and let the load settle. The
 * General tab's Status dropdown rides along: the modal renders every tab's
 * markup into one body, so it is in the DOM whenever this tab is.
 */
async function render(info: any, status = "maintenance"): Promise<any> {
  infoPayload = info;
  win.document.body.innerHTML =
    '<select id="f-status">' +
      '<option value="active">Active</option>' +
      '<option value="maintenance" selected>Maintenance</option>' +
      '<option value="storage">Storage</option>' +
    "</select>" +
    '<div id="f-maint-info"></div>';
  (win.document.getElementById("f-status") as any).value = status;
  load("a1");
  await new Promise((r) => setTimeout(r, 0));
  return win.document.getElementById("f-maint-info");
}

const statusValue = () => (win.document.getElementById("f-status") as any).value;

const clickAction = async (el: any, act: string) => {
  el.querySelector(`[data-maint-act="${act}"]`).click();
  await new Promise((r) => setTimeout(r, 0));
};

beforeEach(() => {
  canManage = true;
  confirmAnswer = true;
  toasts.length = 0;
  vi.clearAllMocks();
  removeAsset.mockResolvedValue({ scheduleDeleted: false, scheduleName: "Nightly", remainingAssetIds: 2 });
});

describe("_maintenanceInfoHTML", () => {
  it("offers both actions on a schedule that names the asset directly", () => {
    const html = infoHTML({ openWindows: [], schedules: [schedule()] });
    expect(html).toContain('data-maint-act="remove"');
    expect(html).toContain('data-maint-act="delete"');
    expect(html).toContain("Nightly");
  });

  it("offers no actions at all without maintenanceManagement", () => {
    canManage = false;
    const html = infoHTML({ openWindows: [], schedules: [schedule()] });
    expect(html).not.toContain("data-maint-act");
    expect(html).toContain("Nightly"); // the coverage line still reads
  });

  it("replaces the remove button with the filter explanation on a criteria match", () => {
    const html = infoHTML({
      openWindows: [],
      schedules: [schedule({ explicit: false, byCriteria: true, removable: false })],
    });
    expect(html).not.toContain('data-maint-act="remove"');
    expect(html).toMatch(/filter/i);
    // Deleting the whole schedule is still on the table.
    expect(html).toContain('data-maint-act="delete"');
  });

  it("flags the last-target case so the confirm can warn about the delete", () => {
    const html = infoHTML({ openWindows: [], schedules: [schedule({ lastTarget: true })] });
    expect(html).toContain('data-last-target="true"');
  });

  it("keeps the open-window line and the no-coverage fallback", () => {
    const open = infoHTML({
      openWindows: [{ id: "w1", scheduleName: "Nightly", startedAt: new Date().toISOString(), until: null }],
      schedules: [],
    });
    expect(open).toContain("In maintenance now");
    expect(infoHTML({ openWindows: [], schedules: [] })).toContain("Not covered by any maintenance schedule");
  });
});

describe("Maintenance tab actions", () => {
  it("removes the asset from the schedule after a confirm, then reloads", async () => {
    const el = await render({ openWindows: [], schedules: [schedule()] });
    await clickAction(el, "remove");

    expect(removeAsset).toHaveBeenCalledWith("s1", "a1");
    expect(toasts[0].msg).toContain("Nightly");
    // Re-read + list refresh so the pill and the rows agree with the server.
    expect(g.api.assets.maintenanceInfo).toHaveBeenCalledTimes(2);
    expect(g.loadAssets).toHaveBeenCalled();
  });

  it("does nothing when the confirm is declined", async () => {
    confirmAnswer = false;
    const el = await render({ openWindows: [], schedules: [schedule()] });
    await clickAction(el, "remove");

    expect(removeAsset).not.toHaveBeenCalled();
    expect(deleteSchedule).not.toHaveBeenCalled();
  });

  it("warns that the schedule goes with the asset when it is the last target", async () => {
    const el = await render({ openWindows: [], schedules: [schedule({ lastTarget: true })] });
    await clickAction(el, "remove");

    expect(String(vi.mocked(g.showConfirm).mock.calls[0][0])).toMatch(/only device/i);
  });

  it("says so when the removal deleted the schedule", async () => {
    removeAsset.mockResolvedValue({ scheduleDeleted: true, scheduleName: "Nightly", remainingAssetIds: 0 });
    const el = await render({ openWindows: [], schedules: [schedule({ lastTarget: true })] });
    await clickAction(el, "remove");

    expect(toasts[0].msg).toMatch(/deleted/i);
  });

  it("deletes the whole schedule from the delete action", async () => {
    const el = await render({ openWindows: [], schedules: [schedule()] });
    await clickAction(el, "delete");

    expect(deleteSchedule).toHaveBeenCalledWith("s1");
    expect(removeAsset).not.toHaveBeenCalled();
    expect(String(vi.mocked(g.showConfirm).mock.calls[0][0])).toMatch(/cannot be undone/i);
  });

  it("fires exactly one request per click after a reload has re-rendered the rows", async () => {
    const el = await render({ openWindows: [], schedules: [schedule()] });
    await clickAction(el, "remove"); // this reload re-renders the same element
    await clickAction(el, "remove");

    // Two clicks, two calls — not 1 + 2 from a listener re-attached per render.
    expect(removeAsset).toHaveBeenCalledTimes(2);
  });

  it("re-points the Status dropdown at the status the removal left behind", async () => {
    // The modal opened on an asset in a window, so the dropdown reads
    // "maintenance"; the removal ended the window and the asset is active
    // again. Saving the stale value would park it in maintenance BY HAND.
    infoPayload = { openWindows: [], schedules: [schedule()], status: "maintenance" };
    const el = await render(infoPayload);
    infoPayload = { openWindows: [], schedules: [], status: "active" };
    await clickAction(el, "remove");

    expect(statusValue()).toBe("active");
  });

  it("leaves a manually-set maintenance alone — the server still says maintenance", async () => {
    // Parked verbatim (business rule 16), so the window closing restores
    // "maintenance" and the dropdown was right all along.
    infoPayload = { openWindows: [], schedules: [schedule()], status: "maintenance" };
    const el = await render(infoPayload);
    infoPayload = { openWindows: [], schedules: [], status: "maintenance" };
    await clickAction(el, "remove");

    expect(statusValue()).toBe("maintenance");
  });

  it("never touches the dropdown on the tab's first load", async () => {
    // The dropdown is the operator's unsaved edit until they save it: the
    // initial read only describes the server, and must not be mistaken for an
    // action's aftermath.
    await render({ openWindows: [], schedules: [], status: "active" }, "maintenance");
    expect(statusValue()).toBe("maintenance");
  });

  it("surfaces a refusal and still re-reads, since a refusal means the tab was stale", async () => {
    removeAsset.mockRejectedValue(Object.assign(new Error("targets this asset through its filter"), {}));
    const el = await render({ openWindows: [], schedules: [schedule()] });
    await clickAction(el, "remove");

    expect(toasts[0]).toMatchObject({ kind: "error" });
    expect(toasts[0].msg).toMatch(/filter/i);
    expect(g.api.assets.maintenanceInfo).toHaveBeenCalledTimes(2);
  });
});
