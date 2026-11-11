/**
 * tests/unit/assetDeleteAgentDialogDom.test.ts — business rule 163: deleting
 * an asset that has the Polaris Agent warns first, offers to uninstall, and —
 * when an uninstall fails — says why and asks before anything is deleted.
 *
 * `confirmAssetDeletion` (public/js/assets-panel.js) is the one function all
 * three delete paths go through. It is sliced out of the file and evaluated in
 * happy-dom with the few collaborators it uses.
 *
 * Pinned, because each is a way for an agent to be left behind silently:
 *   - no agent → the plain confirm, unchanged;
 *   - an agent → no delete without an explicit choice;
 *   - a successful uninstall → the delete follows by itself;
 *   - a FAILED uninstall → nothing is deleted until the operator answers;
 *   - closing the dialog at any stage is a cancel;
 *   - no Agent Deploy permission → the uninstall button is locked, with why.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { Window } from "happy-dom";
import { assetsFileSource } from "./_assetsSource.js";

vi.mock("../../src/db.js", () => ({ prisma: {} }));

const g = globalThis as Record<string, unknown>;
const FILE = assetsFileSource("assets-panel.js").replace(/\r\n/g, "\n");
const START = FILE.indexOf("// ─── Deleting an asset that has the Polaris Agent");
const END = FILE.indexOf("async function confirmDelete(");
if (START < 0 || END < 0 || END < START) throw new Error("the rule-163 block moved in assets-panel.js");
const BLOCK = FILE.slice(START, END);

let win: any;
const flush = async (n = 8) => { for (let i = 0; i < n; i++) { await Promise.resolve(); await new Promise((r) => setTimeout(r, 0)); } };

interface Harness {
  calls: string[];
  set(k: string, v: unknown): void;
  layers(): number;
}

function boot(): void {
  win = new Window();
  g.window = win;
  g.document = win.document;
  const stubs = `
    var __calls = [], __hosts = [], __confirm = true, __mayDeploy = true, __layers = [];
    var __agentCards = {};      // assetId -> array of cards the poll returns in turn (null = gone)
    var __startError = {};      // assetId -> message thrown by the uninstall call
    function escapeHtml(s){ return String(s == null ? "" : s).replace(/[&<>"']/g, function(c){
      return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]; }); }
    function showConfirm(m){ __calls.push("confirm:" + m); return Promise.resolve(__confirm); }
    function canDeployAgent(){ return __mayDeploy; }
    // The stacked-overlay helper, reduced to what the dialog uses: a node, and
    // close() firing onClose exactly as the real one does.
    function buildOverlay(z, title, body, footer, onClose){
      var el = document.createElement("div");
      el.className = "ov";
      el.innerHTML = '<h3>' + escapeHtml(title) + '</h3><div class="b">' + body + '</div><div class="f">' + footer + '</div>';
      document.body.appendChild(el);
      var closed = false;
      var layer = { overlay: el, close: function(){ if (closed) return; closed = true; el.remove(); __layers.splice(__layers.indexOf(layer), 1); if (onClose) onClose(); } };
      __layers.push(layer);
      return layer;
    }
    var api = { assets: {
      agentHosts: function(ids){ __calls.push("agentHosts:" + ids.join(",")); return __hosts === "throw" ? Promise.reject(new Error("x")) : Promise.resolve({ hosts: __hosts }); },
      deleteAgent: function(id, opts){ __calls.push("uninstall:" + id + ":" + JSON.stringify(opts)); return __startError[id] ? Promise.reject(new Error(__startError[id])) : Promise.resolve({}); },
      agent: function(id){ var q = __agentCards[id] || [null]; var v = q.length > 1 ? q.shift() : q[0]; return Promise.resolve(v); },
    } };
  `;
  win.eval(stubs + "\n" + BLOCK +
    "\n;_AGENT_UNINSTALL_POLL_MS = 1; _AGENT_UNINSTALL_TIMEOUT_MS = 40;" +
    "\n;window.__t = { calls: __calls, layers: function(){ return __layers.length; }, set: function(k, v){" +
    " if (k === 'hosts') __hosts = v; if (k === 'confirm') __confirm = v; if (k === 'mayDeploy') __mayDeploy = v;" +
    " if (k === 'cards') __agentCards = v; if (k === 'startError') __startError = v; } };" +
    "\n;window.confirmAssetDeletion = confirmAssetDeletion;");
}

const t = () => win.__t as Harness;
const doc = () => win.document as Document;
const top = () => { const all = doc().querySelectorAll(".ov"); return all[all.length - 1] as HTMLElement; };
const click = (act: string) => (top().querySelector(`[data-act="${act}"]`) as HTMLButtonElement).click();
const HOST = (id: string, name: string) => ({ assetId: id, name, installStatus: "active", agentVersion: "0.30.0" });

beforeEach(() => { boot(); });

describe("no agent among the assets", () => {
  it("is the plain confirm, and returns the ids on yes", async () => {
    const ids = await win.confirmAssetDeletion(["a1"], 'Delete asset "x"?');
    expect(ids).toEqual(["a1"]);
    expect(t().calls).toEqual(["agentHosts:a1", 'confirm:Delete asset "x"?']);
    expect(doc().querySelector(".ov")).toBeNull();
  });
  it("returns null on no, and still asks when the agent check cannot be read", async () => {
    t().set("confirm", false);
    expect(await win.confirmAssetDeletion(["a1"], "Delete?")).toBeNull();
    boot();
    t().set("hosts", "throw");
    expect(await win.confirmAssetDeletion(["a1"], "Delete?")).toEqual(["a1"]);
  });
});

describe("an asset with the Polaris Agent", () => {
  it("warns instead of the plain confirm, and deletes nothing until a choice is made", async () => {
    t().set("hosts", [HOST("a1", "db-01")]);
    let answered = false;
    const p = win.confirmAssetDeletion(["a1"], "Delete?").then((v: unknown) => { answered = true; return v; });
    await flush();
    expect(t().calls).not.toContain("confirm:Delete?");
    expect(top().textContent).toContain("db-01 has the Polaris Agent installed");
    expect(top().textContent).toContain("Deleting the record does not remove the agent");
    expect(answered).toBe(false);
    click("cancel");
    expect(await p).toBeNull();
    expect(t().layers()).toBe(0);
  });

  it("'Delete anyway' returns the ids without touching the agent", async () => {
    t().set("hosts", [HOST("a1", "db-01")]);
    const p = win.confirmAssetDeletion(["a1"], "Delete?");
    await flush();
    click("anyway");
    expect(await p).toEqual(["a1"]);
    expect(t().calls.some((c) => c.startsWith("uninstall:"))).toBe(false);
  });

  it("'Uninstall, then delete' waits for the agent to go, then returns the ids by itself", async () => {
    t().set("hosts", [HOST("a1", "db-01")]);
    // Still uninstalling on the first two polls, gone on the third.
    t().set("cards", { a1: [{ installStatus: "uninstalling" }, { installStatus: "uninstalling" }, null] });
    const p = win.confirmAssetDeletion(["a1"], "Delete?");
    await flush();
    click("uninstall");
    await flush(2);
    expect(top().textContent).toContain("Uninstalling");
    expect(await p).toEqual(["a1"]);
    expect(t().calls).toContain('uninstall:a1:{"force":false}');
    expect(t().layers()).toBe(0);
  });

  it("a FAILED uninstall deletes nothing: it says why and asks", async () => {
    t().set("hosts", [HOST("a1", "db-01")]);
    t().set("cards", { a1: [{ installStatus: "uninstalling" }, { installStatus: "uninstall_failed", installError: "ssh: connection refused" }] });
    let answered = false;
    const p = win.confirmAssetDeletion(["a1"], "Delete?").then((v: unknown) => { answered = true; return v; });
    await flush();
    click("uninstall");
    await flush(20);
    expect(answered).toBe(false);
    expect(top().querySelector("h3")!.textContent).toBe("The agent could not be uninstalled");
    expect(top().textContent).toContain("ssh: connection refused");
    expect(top().textContent).toContain("Nothing has been deleted");
    // One asset: there is no "the others" to offer.
    expect(top().querySelector('[data-act="others"]')).toBeNull();
    click("anyway");
    expect(await p).toEqual(["a1"]);
  });

  it("after a failure, Cancel leaves the asset alone", async () => {
    t().set("hosts", [HOST("a1", "db-01")]);
    t().set("startError", { a1: "No credential on file for this agent" });
    const p = win.confirmAssetDeletion(["a1"], "Delete?");
    await flush();
    click("uninstall");
    await flush(20);
    expect(top().textContent).toContain("No credential on file for this agent");
    click("cancel");
    expect(await p).toBeNull();
  });

  it("an uninstall that never finishes counts as failed, not as success", async () => {
    t().set("hosts", [HOST("a1", "db-01")]);
    t().set("cards", { a1: [{ installStatus: "uninstalling" }] }); // forever
    const p = win.confirmAssetDeletion(["a1"], "Delete?");
    await flush();
    click("uninstall");
    await new Promise((r) => setTimeout(r, 120));
    await flush(10);
    expect(top().textContent).toContain("did not finish");
    click("cancel");
    expect(await p).toBeNull();
  });

  it("locks the uninstall button, with the reason, without the Agent Deploy permission", async () => {
    t().set("hosts", [HOST("a1", "db-01")]);
    t().set("mayDeploy", false);
    const p = win.confirmAssetDeletion(["a1"], "Delete?");
    await flush();
    expect((top().querySelector('[data-act="uninstall"]') as HTMLButtonElement).disabled).toBe(true);
    expect(top().textContent).toContain("Uninstalling needs the Agent Deploy permission");
    click("cancel");
    await p;
  });

  it("closing the dialog (X, Escape, off-click) is a cancel", async () => {
    t().set("hosts", [HOST("a1", "db-01")]);
    const p = win.confirmAssetDeletion(["a1"], "Delete?");
    await flush();
    // What buildOverlay does on dismiss: close the layer, which fires onClose.
    win.eval("__layers[__layers.length - 1].close()");
    expect(await p).toBeNull();
  });

  it("escapes the host's name and the failure reason", async () => {
    t().set("hosts", [HOST("a1", "<img src=x>")]);
    t().set("startError", { a1: "<b>boom</b>" });
    const p = win.confirmAssetDeletion(["a1"], "Delete?");
    await flush();
    expect(doc().querySelector(".ov img")).toBeNull();
    click("uninstall");
    await flush(20);
    expect(doc().querySelector(".ov b")).toBeNull();
    expect(doc().querySelector(".ov img")).toBeNull();
    click("cancel");
    await p;
  });
});

describe("a bulk delete", () => {
  const IDS = ["a1", "a2", "a3", "a4"];

  it("says how many of the selection have an agent and names them", async () => {
    t().set("hosts", [HOST("a1", "db-01"), HOST("a3", "web-03")]);
    const p = win.confirmAssetDeletion(IDS, "Delete 4?");
    await flush();
    expect(top().querySelector("h3")!.textContent).toBe("Delete 4 assets");
    expect(top().textContent).toContain("2 devices of these 4 have the Polaris Agent installed");
    expect(top().textContent).toContain("db-01");
    expect(top().textContent).toContain("web-03");
    click("cancel");
    await p;
  });

  it("uninstalls on every agent host and returns all ids when all succeed", async () => {
    t().set("hosts", [HOST("a1", "db-01"), HOST("a3", "web-03")]);
    const p = win.confirmAssetDeletion(IDS, "Delete 4?");
    await flush();
    click("uninstall");
    expect(await p).toEqual(IDS);
    expect(t().calls.filter((c) => c.startsWith("uninstall:")).sort()).toEqual(['uninstall:a1:{"force":false}', 'uninstall:a3:{"force":false}']);
  });

  it("when one fails, offers 'the other N only' and returns just those", async () => {
    t().set("hosts", [HOST("a1", "db-01"), HOST("a3", "web-03")]);
    t().set("startError", { a3: "host unreachable" });
    const p = win.confirmAssetDeletion(IDS, "Delete 4?");
    await flush();
    click("uninstall");
    await flush(20);
    expect(top().textContent).toContain("could not be removed from 1 device");
    expect(top().textContent).toContain("web-03");
    expect(top().textContent).toContain("host unreachable");
    expect((top().querySelector('[data-act="others"]') as HTMLElement).textContent).toBe("Delete the other 3 only");
    click("others");
    expect(await p).toEqual(["a1", "a2", "a4"]);
  });

  it("when one fails, 'Delete anyway' still returns every id", async () => {
    t().set("hosts", [HOST("a1", "db-01")]);
    t().set("startError", { a1: "host unreachable" });
    const p = win.confirmAssetDeletion(IDS, "Delete 4?");
    await flush();
    click("uninstall");
    await flush(20);
    click("anyway");
    expect(await p).toEqual(IDS);
  });
});
