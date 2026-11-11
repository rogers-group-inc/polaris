/**
 * tests/unit/usersDepartingBookings.test.ts — business rule 140(b): the
 * Disable and Delete dialogs on the Users page list the reboots and firmware
 * upgrades the account has booked, and cancel the ticked ones — through each
 * booking's own cancel route, BEFORE the account changes.
 *
 * What is pinned, because each is a way for this to go quietly wrong:
 *   - nothing is ticked by default (cancelling a planned window is a decision);
 *   - a booking the caller may not cancel is still LISTED, with its box locked;
 *   - a refused cancel stops the dialog before the account is touched;
 *   - a booking that already fired or was cancelled (409 / 404) is passed over;
 *   - an account with nothing booked keeps the plain delete confirm.
 *
 * users.js is a classic browser script; an indirect eval puts its top-level
 * functions on globalThis (not on the happy-dom window).
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Window } from "happy-dom";

vi.mock("../../src/db.js", () => ({ prisma: {} }));

interface Booking { kind: string; id: string; assetId: string; assetName: string; scheduledFor: string; detail: string; canCancel: boolean }

const g = globalThis as Record<string, any>;
const calls: string[] = [];
const toasts: { msg: string; kind?: string }[] = [];
let preview: { deleted: object; ownerless: object; bookings: Booking[] };
let failCancel: Record<string, { status: number; message: string }> = {};
let confirmAnswer = true;

const BOOKINGS: Booking[] = [
  { kind: "reboot", id: "rb1", assetId: "a1", assetName: "core-sw-01", scheduledFor: "2026-11-14T02:00:00.000Z", detail: "kernel patch", canCancel: true },
  { kind: "firmware", id: "fw1", assetId: "a2", assetName: "fw-edge", scheduledFor: "2026-11-15T03:00:00.000Z", detail: "to 7.6.8", canCancel: true },
  { kind: "firmwareGroup", id: "grp1", assetId: "a3", assetName: "hub-gate", scheduledFor: "2026-11-16T04:00:00.000Z", detail: "12 devices", canCancel: false },
];

function cancelStub(name: string, idOf: (...a: string[]) => string) {
  return async (...args: string[]) => {
    const id = idOf(...args);
    calls.push(`${name}:${id}`);
    const f = failCancel[id];
    if (f) throw Object.assign(new Error(f.message), { status: f.status });
    return {};
  };
}

const doc = () => g.document as Document;
const boxes = () => Array.from(doc().querySelectorAll<HTMLInputElement>(".ub-box"));
const tick = (i: number) => { const b = boxes()[i]; b.checked = true; b.dispatchEvent(new (g.window.Event)("change")); };
const flush = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); await new Promise((r) => setTimeout(r, 0)); };

beforeAll(() => {
  const win = new Window();
  g.window = win;
  g.document = win.document;
  g.PolarisPrefs = { save: () => {}, load: () => null };
  g.escapeHtml = (s: unknown) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;");
  g.showToast = (msg: string, kind?: string) => { toasts.push({ msg, kind }); };
  g.showConfirm = async () => confirmAnswer;
  g.permAtLeast = () => true;
  g.currentUsername = "alice";
  g.formatDate = () => "";
  g.formatDateTime = (v: string) => "T:" + v.slice(0, 10);
  g.regionPillsHtml = () => "";
  g.TableSF = function () {};
  g.setupColumnLayout = () => null;
  g.userReady = Promise.resolve();
  g.loadUsers = () => { calls.push("loadUsers"); };
  // The shared modal, reduced to what the dialog needs: a body and a footer.
  g.openModal = (_title: string, body: string, footer: string) => {
    win.document.body.innerHTML = `<div id="modal-overlay" class="open"><div id="m-body">${body}</div><div id="m-foot">${footer}</div></div>`;
  };
  g.closeModal = () => { calls.push("closeModal"); win.document.body.innerHTML = ""; };
  g.api = {
    users: {
      disablePreview: async () => preview,
      disable: async (id: string) => { calls.push(`disable:${id}`); return { ok: true }; },
      delete: async (id: string) => { calls.push(`delete:${id}`); },
    },
    assets: {
      cancelRebootSchedule: cancelStub("cancelReboot", (_asset, sid) => sid),
      cancelFirmwareSchedule: cancelStub("cancelFirmware", (_asset, sid) => sid),
      cancelFirmwareGroup: cancelStub("cancelGroup", (gid) => gid),
    },
  };

  (0, eval)(readFileSync(resolve(__dirname, "../../public/js/users.js"), "utf8"));
  // users.js defines its own loadUsers; the dialogs must call ours.
  g.loadUsers = () => { calls.push("loadUsers"); };
  expect(typeof g.confirmDisableUser).toBe("function");
  expect(typeof g.confirmDeleteUser).toBe("function");
});

beforeEach(() => {
  calls.length = 0;
  toasts.length = 0;
  failCancel = {};
  confirmAnswer = true;
  preview = { deleted: {}, ownerless: {}, bookings: BOOKINGS.map((b) => ({ ...b })) };
  doc().body.innerHTML = "";
});

describe("the Disable dialog", () => {
  it("lists every pending booking, none ticked, and locks the one the caller cannot cancel", async () => {
    await g.confirmDisableUser("u1", "bob");
    const b = boxes();
    expect(b).toHaveLength(3);
    expect(b.every((x) => !x.checked)).toBe(true);
    expect(b.map((x) => x.disabled)).toEqual([false, false, true]);
    const text = doc().getElementById("ub-section")!.textContent!;
    expect(text).toContain("Reboot · core-sw-01 · T:2026-11-14 · kernel patch");
    expect(text).toContain("Firmware upgrade · fw-edge · T:2026-11-15 · to 7.6.8");
    expect(text).toContain("Group firmware upgrade · hub-gate · T:2026-11-16 · 12 devices");
    expect(text).toContain("you cannot cancel this one");
    expect(text).toContain("These 3 bookings still run on schedule after the account is disabled");
  });

  it("with nothing ticked, disables and cancels nothing", async () => {
    await g.confirmDisableUser("u1", "bob");
    doc().getElementById("ud-ok")!.click();
    await flush();
    expect(calls).toEqual(["disable:u1", "closeModal", "loadUsers"]);
    expect(toasts[0].msg).toBe('Disabled "bob"');
  });

  it("cancels the ticked bookings through their own routes, then disables", async () => {
    await g.confirmDisableUser("u1", "bob");
    tick(0);
    tick(1);
    doc().getElementById("ud-ok")!.click();
    await flush();
    expect(calls).toEqual(["cancelReboot:rb1", "cancelFirmware:fw1", "disable:u1", "closeModal", "loadUsers"]);
    expect(toasts[0].msg).toBe('Disabled "bob"; 2 scheduled bookings cancelled');
  });

  it("'Cancel all of them' ticks only the boxes the caller can reach", async () => {
    await g.confirmDisableUser("u1", "bob");
    const all = doc().getElementById("ub-all") as HTMLInputElement;
    all.checked = true;
    all.dispatchEvent(new (g.window.Event)("change"));
    expect(boxes().map((x) => x.checked)).toEqual([true, true, false]);
  });

  it("stops, with the account untouched, when a cancel is refused", async () => {
    failCancel = { fw1: { status: 403, message: "Forbidden" } };
    await g.confirmDisableUser("u1", "bob");
    tick(0);
    tick(1);
    doc().getElementById("ud-ok")!.click();
    await flush();
    expect(calls).toEqual(["cancelReboot:rb1", "cancelFirmware:fw1"]);
    expect(calls).not.toContain("disable:u1");
    expect(toasts[0].kind).toBe("error");
    expect(toasts[0].msg).toContain("Could not cancel Firmware upgrade · fw-edge");
    expect((doc().getElementById("ud-ok") as HTMLButtonElement).disabled).toBe(false);
  });

  it("passes over a booking that already fired or was cancelled since the dialog opened", async () => {
    failCancel = { rb1: { status: 409, message: "already started" } };
    await g.confirmDisableUser("u1", "bob");
    tick(0);
    tick(1);
    doc().getElementById("ud-ok")!.click();
    await flush();
    expect(calls).toContain("disable:u1");
    expect(toasts[0].msg).toBe('Disabled "bob"; 1 scheduled booking cancelled');
  });

  it("shows no scheduled-work block for an account that booked nothing", async () => {
    preview.bookings = [];
    await g.confirmDisableUser("u1", "bob");
    expect(doc().getElementById("ub-section")).toBeNull();
  });

  it("escapes a device name and a reboot note", async () => {
    preview.bookings = [{ ...BOOKINGS[0], assetName: "<img src=x>", detail: "<b>x</b>" }];
    await g.confirmDisableUser("u1", "bob");
    expect(doc().querySelector("#ub-section img")).toBeNull();
    expect(doc().querySelector("#ub-section b")).toBeNull();
  });
});

describe("the Delete dialog", () => {
  it("keeps the plain confirm when nothing is booked", async () => {
    preview.bookings = [];
    await g.confirmDeleteUser("u1", "bob");
    await flush();
    expect(doc().getElementById("ub-section")).toBeNull();
    expect(calls).toEqual(["delete:u1", "loadUsers"]);
  });

  it("does nothing when that confirm is declined", async () => {
    preview.bookings = [];
    confirmAnswer = false;
    await g.confirmDeleteUser("u1", "bob");
    expect(calls).toEqual([]);
  });

  it("lists the bookings, cancels the ticked ones, then deletes", async () => {
    await g.confirmDeleteUser("u1", "bob");
    expect(doc().getElementById("ub-section")!.textContent).toContain("after the account is deleted");
    tick(0);
    doc().getElementById("udel-ok")!.click();
    await flush();
    expect(calls).toEqual(["cancelReboot:rb1", "delete:u1", "closeModal", "loadUsers"]);
    expect(toasts[0].msg).toBe("User deleted; 1 scheduled booking cancelled");
  });

  it("does not delete when a cancel is refused", async () => {
    failCancel = { rb1: { status: 403, message: "Forbidden" } };
    await g.confirmDeleteUser("u1", "bob");
    tick(0);
    doc().getElementById("udel-ok")!.click();
    await flush();
    expect(calls).toEqual(["cancelReboot:rb1"]);
  });
});
