/**
 * tests/unit/assetEditDeleteDom.test.ts — the Delete Asset button in the asset
 * edit modal's footer (`openEditModal` in public/js/assets.js).
 *
 * Deleting an asset is irreversible and there is no undo anywhere in the app,
 * so the three things that keep this button safe are pinned here:
 *
 *  - it is gated on canManageAssets(). DELETE /assets/:id is assets:write
 *    server-side, so a read-only operator's click could only 403 — and a
 *    destructive verb that appears for someone who may not use it is worse
 *    than no verb at all;
 *  - it confirms FIRST and only deletes on a yes. A cancelled confirm must
 *    leave the edit modal and its unsaved form standing, which is why the
 *    confirm is showConfirm's stacked overlay and not openModal (openModal
 *    overwrites the one shared overlay and would destroy the form DOM);
 *  - on success it closes the edit modal AND the details panel behind it when
 *    that panel is showing the asset just removed. Left open, the panel renders
 *    a record that no longer exists and its refresh timers 404 on the next tick.
 *
 * assets.js is a ~21k-line browser script with no module boundary, so
 * openEditModal is sliced out by name and eval'd with its collaborators stubbed
 * — the approach of tests/unit/assetAlertsTabDom.test.ts.
 *
 * @vitest-environment happy-dom
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { APP_SHELL_STUBS } from "./_appShellStubs.js";

const g = globalThis as Record<string, any>;

const assetsLines = readFileSync(resolve(__dirname, "../../public/js/assets.js"), "utf8").split(/\r?\n/);

/** Slice a top-level `[async ]function NAME(...) {` … `}` block out of assets.js. */
function fnSrc(name: string): string {
  const start = assetsLines.findIndex(
    (l) => l.startsWith(`function ${name}(`) || l.startsWith(`async function ${name}(`),
  );
  if (start < 0) throw new Error(`assets.js: function ${name} not found`);
  const end = assetsLines.findIndex((l, i) => i > start && l === "}");
  if (end < 0) throw new Error(`assets.js: no end of function ${name}`);
  return assetsLines.slice(start, end + 1).join("\n");
}

const SRC =
  APP_SHELL_STUBS + "\n" + fnSrc("openEditModal") + "\nglobalThis.openEditModal = openEditModal;";

interface Ctx {
  deleted: string[];
  toasts: { msg: string; type: string }[];
  modalOpen: boolean;
  panelClosed: boolean;
  assetsReloaded: number;
  confirmAnswer: boolean;
  currentPanelAssetId: string | null;
}

let ctx: Ctx;

/** Open the edit modal for an existing asset against the stubbed collaborators. */
async function openEdit(opts?: { perm?: string; hostname?: string }) {
  const perm = opts?.perm ?? "write";
  const RANK: Record<string, number> = { none: 0, read: 1, write: 2, fullwrite: 3 };
  g.permAtLeast = (_key: string, level: string) => RANK[perm] >= RANK[level];
  g.canManageAssets = () => g.permAtLeast("assets", "write");
  // From api.js in the browser, not app.js — APP_SHELL_STUBS leaves it to the
  // harness. tabbedBodyHTML runs the tab labels through it.
  g.escapeHtml = (s: any) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");

  g.api = {
    assets: {
      get: vi.fn(async (id: string) => ({ id, hostname: opts?.hostname ?? "wks-01" })),
      agent: vi.fn(async () => null),
      delete: vi.fn(async (id: string) => { ctx.deleted.push(id); }),
    },
  };

  // The three tab bodies are someone else's test; this one is about the footer.
  g.assetFormHTML = () => '<div id="tab-general-body"></div>';
  g.assetMonitoringFormHTML = () => '<div id="tab-monitoring-body"></div>';
  g.assetMaintenanceFormHTML = () => '<div id="tab-maintenance-body"></div>';
  g._ensureTagCache = async () => {};
  g.wireDescriptionCapWarning = () => {};
  g.wireTagPicker = () => {};
  g._wireMonitorEditTab = () => {};
  g._populateUploadedMibsInDropdowns = () => {};

  g.openModal = (_title: string, body: string, footer: string) => {
    ctx.modalOpen = true;
    document.body.innerHTML =
      '<div id="modal-body">' + body + "</div>" + '<div id="modal-footer">' + footer + "</div>";
  };
  g.closeModal = () => { ctx.modalOpen = false; };
  g.showToast = (msg: string, type?: string) => ctx.toasts.push({ msg, type: type || "success" });
  g.showConfirm = vi.fn(async () => ctx.confirmAnswer);
  g.loadAssets = () => { ctx.assetsReloaded++; };
  g._isCurrentAsset = (id: string) => ctx.currentPanelAssetId === id;
  g.closeAssetPanel = () => { ctx.panelClosed = true; ctx.currentPanelAssetId = null; };
  g.openViewModal = vi.fn();

  await g.openEditModal("A1");
}

const footerBtns = () =>
  Array.from(document.querySelectorAll("#modal-footer .btn")) as HTMLButtonElement[];
const deleteBtn = () => document.getElementById("btn-delete-asset") as HTMLButtonElement | null;

/** Click Delete and let the confirm promise chain settle. */
async function clickDelete() {
  deleteBtn()!.click();
  await new Promise((r) => setTimeout(r, 0));
}

beforeEach(() => {
  ctx = {
    deleted: [],
    toasts: [],
    modalOpen: false,
    panelClosed: false,
    assetsReloaded: 0,
    confirmAnswer: true,
    currentPanelAssetId: null,
  };
  document.body.innerHTML = "";
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  new Function(SRC)();
});

describe("asset edit modal — Delete Asset", () => {
  it("offers Delete to an operator who may manage assets", async () => {
    await openEdit({ perm: "write" });
    expect(deleteBtn()).toBeTruthy();
    expect(deleteBtn()!.classList.contains("btn-danger")).toBe(true);
  });

  it("keeps Delete away from Save: first in the footer, pushed to the far left", async () => {
    await openEdit();
    const btns = footerBtns();
    // Order matters as much as the margin — the auto margin only creates the
    // gap if the danger button is the one before Cancel/Save.
    expect(btns.map((b) => b.textContent)).toEqual(["Delete Asset", "Cancel", "Save Changes"]);
    expect(btns[0].style.marginRight).toBe("auto");
  });

  it("hides Delete from a read-only operator", async () => {
    await openEdit({ perm: "read" });
    expect(deleteBtn()).toBeNull();
    expect(footerBtns().map((b) => b.textContent)).toEqual(["Cancel", "Save Changes"]);
  });

  it("confirms by name before deleting", async () => {
    await openEdit({ hostname: "core-sw-01" });
    await clickDelete();
    expect(g.showConfirm).toHaveBeenCalledTimes(1);
    expect(g.showConfirm.mock.calls[0][0]).toContain("core-sw-01");
    expect(g.showConfirm.mock.calls[0][0]).toContain("cannot be undone");
  });

  it("deletes, closes the modal, toasts and reloads the list on confirm", async () => {
    await openEdit();
    await clickDelete();
    expect(ctx.deleted).toEqual(["A1"]);
    expect(ctx.modalOpen).toBe(false);
    expect(ctx.toasts).toEqual([{ msg: "Asset deleted", type: "success" }]);
    expect(ctx.assetsReloaded).toBe(1);
  });

  it("closes the details panel behind it when that panel holds the deleted asset", async () => {
    ctx.currentPanelAssetId = "A1";
    await openEdit();
    await clickDelete();
    expect(ctx.panelClosed).toBe(true);
  });

  it("leaves a panel showing a DIFFERENT asset open", async () => {
    ctx.currentPanelAssetId = "A2";
    await openEdit();
    await clickDelete();
    expect(ctx.panelClosed).toBe(false);
  });

  it("does nothing at all when the confirm is cancelled", async () => {
    ctx.confirmAnswer = false;
    await openEdit();
    await clickDelete();
    expect(ctx.deleted).toEqual([]);
    expect(ctx.assetsReloaded).toBe(0);
    // The edit modal and its unsaved form survive — the whole reason the
    // confirm is a stacked overlay rather than openModal.
    expect(ctx.modalOpen).toBe(true);
    expect(deleteBtn()!.disabled).toBe(false);
  });

  it("re-enables the button and reports the error when the delete fails", async () => {
    await openEdit();
    g.api.assets.delete = vi.fn(async () => { throw new Error("Asset is referenced by a reservation"); });
    await clickDelete();
    expect(ctx.modalOpen).toBe(true);
    expect(deleteBtn()!.disabled).toBe(false);
    expect(ctx.toasts).toEqual([{ msg: "Asset is referenced by a reservation", type: "error" }]);
  });
});
