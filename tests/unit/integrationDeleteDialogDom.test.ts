/**
 * tests/unit/integrationDeleteDialogDom.test.ts — business rule 160: the
 * Delete Integration dialog says what the integration discovered before it is
 * deleted, offers to decommission what nothing else reports, and says that
 * pushed DHCP entries stay on the device.
 *
 * Same eval-into-happy-dom idiom as arcIntegrationDom.test.ts.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { integrationsSource } from "./_integrationsSource.js";
import { Window } from "happy-dom";
import { APP_SHELL_STUBS } from "./_appShellStubs.js";

vi.mock("../../src/db.js", () => ({ prisma: {} }));

const g = globalThis as Record<string, unknown>;
const SRC = integrationsSource();
const POLLING_SRC = readFileSync(resolve(__dirname, "../../public/js/polling-methods.js"), "utf8");
const DOWN_AFTER_SRC = readFileSync(resolve(__dirname, "../../public/js/monitor-down-after.js"), "utf8");

let win: any;
const flush = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); await new Promise((r) => setTimeout(r, 0)); };

const EMPTY = { sourcedAssets: 0, soleSourceAssets: 0, soleSourceMonitored: 0, networks: 0, pushedReservations: 0, azureTaggedAssets: 0, canDecommission: true };
const BUSY = { sourcedAssets: 412, soleSourceAssets: 38, soleSourceMonitored: 5, networks: 12, pushedReservations: 6, azureTaggedAssets: 0, canDecommission: true };

function boot(): any {
  win = new Window();
  g.window = win;
  g.document = win.document;
  g.localStorage = win.localStorage;
  const stubs = `
    function escapeHtml(s){ return String(s == null ? "" : s).replace(/[&<>"']/g, function(c){
      return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]; }); }
    var __calls = [], __toasts = [], __preview = null, __confirm = true, __deleteError = null;
    function showToast(m, k){ __toasts.push({ msg: m, kind: k }); }
    function showConfirm(m){ __calls.push("confirm:" + m); return Promise.resolve(__confirm); }
    function openModal(t, body, footer){
      __calls.push("openModal:" + t);
      document.body.innerHTML = '<div id="m-body">' + body + '</div><div id="m-foot">' + footer + '</div>';
    }
    function closeModal(){ __calls.push("closeModal"); document.body.innerHTML = ""; }
    function copyTextToClipboard(){ return Promise.resolve(true); }
    function val(id){ var el = document.getElementById(id); return el ? el.value.trim() : ""; }
    var api = { credentials: {}, monitorSettings: {}, integrations: {
      deletePreview: function(id){ __calls.push("preview:" + id); return __preview === "throw" ? Promise.reject(new Error("nope")) : Promise.resolve(__preview); },
      delete: function(id, opts){ __calls.push("delete:" + id + ":" + JSON.stringify(opts || null)); return __deleteError ? Promise.reject(new Error(__deleteError)) : Promise.resolve(); },
    } };
    var permAtLeast = function(){ return true; };
  `;
  win.eval(APP_SHELL_STUBS + "\n" + stubs + "\n" + DOWN_AFTER_SRC + "\n" + POLLING_SRC + "\n" + SRC +
    "\n;loadIntegrations = function(){ __calls.push('loadIntegrations'); };" +
    "\n;window.__t = { calls: __calls, toasts: __toasts, set: function(k, v){ if (k === 'preview') __preview = v; if (k === 'confirm') __confirm = v; if (k === 'deleteError') __deleteError = v; } };");
  return win;
}

beforeEach(() => { boot(); });

const t = () => win.__t as { calls: string[]; toasts: { msg: string; kind?: string }[]; set: (k: string, v: unknown) => void };
const doc = () => win.document as Document;

describe("an integration that discovered nothing", () => {
  it("keeps the one-line confirm and deletes without the decommission flag", async () => {
    t().set("preview", EMPTY);
    await win.confirmDeleteIntegration("i1", "Lab FortiGate");
    await flush();
    expect(t().calls.some((c) => c.startsWith("openModal"))).toBe(false);
    expect(t().calls).toContain('delete:i1:null');
    expect(t().calls).toContain("loadIntegrations");
  });

  it("does nothing when declined, and still works when the preview cannot be read", async () => {
    t().set("preview", EMPTY);
    t().set("confirm", false);
    await win.confirmDeleteIntegration("i1", "Lab FortiGate");
    expect(t().calls.some((c) => c.startsWith("delete:"))).toBe(false);

    boot();
    t().set("preview", "throw");
    await win.confirmDeleteIntegration("i1", "Lab FortiGate");
    await flush();
    expect(t().calls).toContain('delete:i1:null');
  });
});

describe("an integration that discovered things", () => {
  it("states what is kept, what is removed and what stays on the device", async () => {
    t().set("preview", BUSY);
    await win.confirmDeleteIntegration("i1", "HQ FortiManager");
    const text = doc().getElementById("m-body")!.textContent!;
    expect(text).toContain("412 assets it discovered are kept");
    expect(text).toContain("12 networks it discovered are kept as manual networks");
    expect(text).toContain("6 DHCP reservations it pushed stay on the device");
    expect(text).toContain("listed in Events");
    expect(text).toContain("decommission the 38 assets that no other source reports");
    expect(text).toContain("5 of them are monitored now and will stop being polled");
    expect(text).not.toContain("azure:");
  });

  it("leaves the decommission box unticked, and deletes without it by default", async () => {
    t().set("preview", BUSY);
    await win.confirmDeleteIntegration("i1", "HQ FortiManager");
    const box = doc().getElementById("idel-decom") as HTMLInputElement;
    expect(box.checked).toBe(false);
    expect(box.disabled).toBe(false);
    doc().getElementById("idel-ok")!.click();
    await flush();
    expect(t().calls).toContain('delete:i1:{"decommission":false}');
    expect(t().toasts[0].msg).toBe("Integration deleted");
  });

  it("sends the flag when ticked and says how many were decommissioned", async () => {
    t().set("preview", BUSY);
    await win.confirmDeleteIntegration("i1", "HQ FortiManager");
    (doc().getElementById("idel-decom") as HTMLInputElement).checked = true;
    doc().getElementById("idel-ok")!.click();
    await flush();
    expect(t().calls).toContain('delete:i1:{"decommission":true}');
    expect(t().toasts[0].msg).toBe("Integration deleted; 38 assets decommissioned");
    expect(t().calls).toContain("closeModal");
  });

  it("locks the box, with the reason, for a caller who may not decommission", async () => {
    t().set("preview", { ...BUSY, canDecommission: false });
    await win.confirmDeleteIntegration("i1", "HQ FortiManager");
    const box = doc().getElementById("idel-decom") as HTMLInputElement;
    expect(box.disabled).toBe(true);
    expect(doc().getElementById("m-body")!.textContent).toContain("You need Full Read-Write on Assets");
  });

  it("offers no box when every asset is also reported by something else", async () => {
    t().set("preview", { ...BUSY, soleSourceAssets: 0, soleSourceMonitored: 0 });
    await win.confirmDeleteIntegration("i1", "HQ FortiManager");
    expect(doc().getElementById("idel-decom")).toBeNull();
    doc().getElementById("idel-ok")!.click();
    await flush();
    expect(t().calls).toContain('delete:i1:{"decommission":false}');
  });

  it("mentions the azure: tags for an Arc integration, and uses the singular", async () => {
    t().set("preview", { ...EMPTY, sourcedAssets: 1, azureTaggedAssets: 1, pushedReservations: 1, networks: 1 });
    await win.confirmDeleteIntegration("i1", "Arc");
    const text = doc().getElementById("m-body")!.textContent!;
    expect(text).toContain("1 asset it discovered is kept");
    expect(text).toContain("azure: tags on 1 asset are removed");
    expect(text).toContain("1 DHCP reservation it pushed stays on the device");
    expect(text).toContain("1 network it discovered is kept as a manual network.");
  });

  it("keeps the dialog open and re-enables the button when the delete fails", async () => {
    t().set("preview", BUSY);
    t().set("deleteError", "Forbidden");
    await win.confirmDeleteIntegration("i1", "HQ FortiManager");
    doc().getElementById("idel-ok")!.click();
    await flush();
    expect(t().toasts[0]).toEqual({ msg: "Forbidden", kind: "error" });
    expect((doc().getElementById("idel-ok") as HTMLButtonElement).disabled).toBe(false);
    expect(t().calls).not.toContain("closeModal");
  });

  it("escapes the integration's name", async () => {
    t().set("preview", BUSY);
    await win.confirmDeleteIntegration("i1", "<img src=x>");
    expect(doc().querySelector("#m-body img")).toBeNull();
  });
});
