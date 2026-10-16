/**
 * tests/unit/assetsFirmwareGroupDom.test.ts — the Assets bulk bar's Upgrade
 * button and the group firmware upgrade dialogs (public/js/assets-firmware-
 * group.js, business rule 122).
 *
 * Pinned: grey for an empty or non-Fortinet selection; RED when the server
 * says the selection spans more than one FortiGate (or holds a device it
 * cannot place), and a red click opens the explanation — not the booking —
 * whose "Keep only these" narrows the selection; normal for one FortiGate's
 * fleet; the booking body lists the order, the dropped devices and the
 * single-device bookings it will cancel (with their own acknowledgement).
 *
 * @vitest-environment happy-dom
 */

import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const g = globalThis as Record<string, any>;
const src = readFileSync(resolve(__dirname, "../../public/js/assets-firmware-group.js"), "utf8");

let sourcesAnswer: any;
let modal: { title: string; body: string } | null;

function load() {
  document.body.innerHTML =
    '<button id="assets-bulk-firmware-btn" class="btn btn-sm btn-secondary" disabled>Upgrade</button>' +
    '<table><tbody id="assets-tbody">' +
      '<tr><td><input type="checkbox" class="row-cb" data-id="sw1" checked></td></tr>' +
      '<tr><td><input type="checkbox" class="row-cb" data-id="sw2" checked></td></tr>' +
    "</tbody></table>";
  (0, eval)(src);
}

beforeEach(() => {
  vi.useFakeTimers();
  modal = null;
  sourcesAnswer = { sources: [{ gateAssetId: "g1", gateName: "FGT-A", integrationId: null, integrationName: "FMG", assetIds: ["sw1", "sw2"] }], unresolved: [], unsupported: [] };
  g._assetsSelected = new Set<string>();
  g._assetsSelectedMeta = {};
  g._assetsData = [{ id: "sw1", hostname: "sw-one" }, { id: "sw2", hostname: "sw-two" }];
  g.escapeHtml = (s: unknown) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  g.showToast = vi.fn();
  g.showConfirm = vi.fn(async () => true);
  g.permAtLeast = () => true;
  g._fwWhenText = (d: string) => `WHEN(${d})`;
  g._fwLocalInputValue = () => "2026-10-17T02:00";
  g._fwBrowserZone = () => "UTC";
  g._fwParseEmails = (s: string) => s.split(",").map((x) => x.trim()).filter(Boolean);
  g._assetsUpdateSelectAll = vi.fn();
  g._assetsUpdateBulkBar = vi.fn(() => g.PolarisFirmwareGroup.syncButton());
  g.openModal = (title: string, body: string, footer: string) => {
    modal = { title, body };
    let el = document.getElementById("modal-overlay");
    if (!el) { el = document.createElement("div"); el.id = "modal-overlay"; document.body.appendChild(el); }
    el.innerHTML = `<h3 id="modal-title">${title}</h3><div class="modal-body">${body}</div><div class="modal-footer">${footer}</div>`;
  };
  g.closeModal = vi.fn(() => { document.getElementById("modal-overlay")?.remove(); });
  g.api = { assets: {
    firmwareGroupSources: vi.fn(async () => sourcesAnswer),
    firmwareGroupPreview: vi.fn(async () => ({ plan: { gate: { assetId: "g1", name: "FGT-A", integrationName: null }, included: [], dropped: [], individualBookings: [], existingGroup: null, otherGroups: [] }, defaults: { notifyEmails: [] } })),
  } };
  load();
});

afterEach(() => { vi.useRealTimers(); });

const btn = () => document.getElementById("assets-bulk-firmware-btn") as HTMLButtonElement;

async function select(ids: string[], types: Record<string, string> = {}) {
  g._assetsSelected = new Set(ids);
  g._assetsSelectedMeta = Object.fromEntries(ids.map((id) => [id, { assetType: types[id] ?? "switch", status: "active" }]));
  g.PolarisFirmwareGroup.syncButton();
  await vi.advanceTimersByTimeAsync(400);
}

describe("Upgrade button", () => {
  it("is grey with nothing selected, and for a non-Fortinet selection", async () => {
    await select([]);
    expect(btn().disabled).toBe(true);
    await select(["sw1", "pc1"], { pc1: "workstation" });
    expect(btn().disabled).toBe(true);
    expect(btn().title).toMatch(/Only FortiGates, FortiSwitches and FortiAPs/);
    expect(g.api.assets.firmwareGroupSources).not.toHaveBeenCalled();
  });

  it("is normal for one FortiGate's devices and opens the booking dialog", async () => {
    await select(["sw1", "sw2"]);
    expect(btn().disabled).toBe(false);
    expect(btn().classList.contains("btn-danger")).toBe(false);
    expect(btn().title).toMatch(/on FGT-A/);
    await g.PolarisFirmwareGroup.onClick();
    expect(g.api.assets.firmwareGroupPreview).toHaveBeenCalledWith(["sw1", "sw2"]);
  });

  it("turns red across two FortiGates; a click explains instead of booking; Keep only these narrows", async () => {
    sourcesAnswer = {
      sources: [
        { gateAssetId: "g1", gateName: "FGT-A", integrationId: null, integrationName: "FMG", assetIds: ["sw1"] },
        { gateAssetId: "g2", gateName: "FGT-B", integrationId: null, integrationName: "FMG", assetIds: ["sw2"] },
      ],
      unresolved: [], unsupported: [],
    };
    await select(["sw1", "sw2"]);
    expect(btn().disabled).toBe(false);
    expect(btn().classList.contains("btn-danger")).toBe(true);
    expect(btn().title).toBe("Selected devices come from 2 sources. Click for details.");

    await g.PolarisFirmwareGroup.onClick();
    expect(g.api.assets.firmwareGroupPreview).not.toHaveBeenCalled();
    expect(modal!.body).toMatch(/one FortiGate at a time/);
    expect(modal!.body).toMatch(/FGT-A/);
    expect(modal!.body).toMatch(/FGT-B/);

    (document.querySelector('[data-fwg-keep="1"]') as HTMLButtonElement).click();
    expect([...g._assetsSelected]).toEqual(["sw2"]);
    expect((document.querySelector('input[data-id="sw1"]') as HTMLInputElement).checked).toBe(false);
    expect(btn().classList.contains("btn-danger")).toBe(false);
  });

  it("turns red when a device cannot be placed under a FortiGate", async () => {
    sourcesAnswer = { sources: [sourcesAnswer.sources[0]], unresolved: [{ assetId: "ap9", name: "ap-9", reason: "no controller stamp" }], unsupported: [] };
    await select(["sw1", "ap9"], { ap9: "access_point" });
    expect(btn().classList.contains("btn-danger")).toBe(true);
    await g.PolarisFirmwareGroup.onClick();
    expect(modal!.body).toMatch(/ap-9 — no controller stamp/);
  });
});

describe("booking body", () => {
  const plan = {
    gate: { assetId: "g1", name: "FGT-A", integrationName: "FMG" },
    included: [
      { assetId: "ap1", name: "ap-1", assetType: "access_point", model: null, depth: 3, fromVersion: "7.4.0", toVersion: "7.4.4", warnings: ["no firmware upgrade has succeeded on this FortiAP before"] },
      { assetId: "sw1", name: "sw-1", assetType: "switch", model: null, depth: 2, fromVersion: "7.4.3", toVersion: "7.6.8", warnings: [] },
      { assetId: "g1", name: "FGT-A", assetType: "firewall", model: null, depth: 1, fromVersion: "7.4.5", toVersion: "7.6.4", warnings: [] },
    ],
    dropped: [{ assetId: "sw2", name: "sw-2", assetType: "switch", fromVersion: "7.6.8", kind: "current", reason: "No Repository image is newer than 7.6.8." }],
    individualBookings: [{ scheduleId: "s1", assetId: "sw1", name: "sw-1", scheduledFor: "2026-10-20T02:00:00Z", toVersion: "7.6.8" }],
    existingGroup: null,
    otherGroups: [],
  };

  it("lists the order by stage, the dropped devices, and the bookings it cancels with their own acknowledgement", () => {
    document.body.innerHTML = g.PolarisFirmwareGroup._bookingBodyHTML(plan, { notifyEmails: ["ops@example.com"], maxConcurrency: 10 });
    const order = [...document.querySelectorAll("#fwg-order-table tbody tr")].map((r) => [r.children[0].textContent, r.children[1].textContent]);
    expect(order).toEqual([["1", "ap-1"], ["2", "sw-1"], ["3", "FGT-A"]]);
    expect(document.querySelector("#fwg-dropped-table")!.textContent).toMatch(/sw-2.*No Repository image is newer/);
    expect(document.getElementById("fwg-individual-warning")!.textContent).toMatch(/cancels it/);
    expect(document.getElementById("fwg-ack-cancel")).not.toBeNull();
    expect(document.getElementById("fwg-ack")).not.toBeNull();
    expect((document.getElementById("fwg-concurrency") as HTMLInputElement).value).toBe("1");
  });

  it("an existing group on the FortiGate blocks booking and points at it", () => {
    document.body.innerHTML = g.PolarisFirmwareGroup._bookingBodyHTML({ ...plan, existingGroup: { id: "grp-9", scheduledFor: "2026-10-18T02:00:00Z", status: "pending" } }, {});
    expect(document.getElementById("fwg-open-existing")!.getAttribute("data-group-id")).toBe("grp-9");
    expect(document.getElementById("fwg-ack")).toBeNull();
  });
});

describe("group detail", () => {
  it("shows each device's state with the skip kind and failure stage", () => {
    document.body.innerHTML = g.PolarisFirmwareGroup._detailBodyHTML({
      gateName: "FGT-A", status: "running", scheduledFor: "2026-10-17T02:00:00Z", concurrency: 2, createdBy: "alice", error: null,
      members: [
        { name: "ap-1", assetType: "access_point", state: "failed", skipKind: null, detail: "did not come back", fromVersion: "7.4.0", toVersion: "7.4.4", run: { stage: "rebooting" } },
        { name: "ap-2", assetType: "access_point", state: "skipped", skipKind: "health", detail: "the device is down", fromVersion: "7.4.0", toVersion: "7.4.4", run: null },
        { name: "sw-1", assetType: "switch", state: "skipped", skipKind: "subtree", detail: "ap-1, behind it, failed", fromVersion: "7.4.3", toVersion: "7.6.8", run: null },
      ],
    });
    const rows = [...document.querySelectorAll("#fwg-detail-table tbody tr")].map((r) => [r.children[3].textContent, r.children[4].textContent]);
    expect(rows).toEqual([
      ["Failed", "rebooting: did not come back"],
      ["Skipped (health)", "the device is down"],
      ["Skipped (upstream of a failure)", "ap-1, behind it, failed"],
    ]);
  });
});
