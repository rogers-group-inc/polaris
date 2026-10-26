/**
 * tests/unit/firmwareRepositoryNewLoginFlow.test.ts — "Add a device admin
 * login…" on Server Settings → Repository (business rule 87).
 *
 * The binding editor fetches the credential list once, when it opens. An
 * operator who added a login from the editor saved it and found the select
 * still without it. What is pinned: a credential saved from the credential
 * modal (the `polaris:credentials-changed` event it dispatches) re-fetches the
 * list, the open editor redraws with the new login, and a login created from
 * that editor is picked, ready to Save.
 *
 * @vitest-environment node
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Window } from "happy-dom";

const MODEL = "FortiSwitch S108FF";

function tree() {
  return { manufacturers: [{ name: "Fortinet", assetCount: 1, binding: null, effectiveBinding: null, assetTypes: [
    { assetType: "switch", label: "Switch", engine: "fortiswitch-https", assetCount: 1, binding: null, effectiveBinding: null, models: [
      { model: MODEL, assetCount: 1, orphaned: false, images: [], binding: null, effectiveBinding: null },
    ] },
  ] }] };
}

const login = { id: "cred-new", name: "Switch admin", type: "http", config: { authMode: "form" } };

function boot() {
  const win = new Window({ url: "https://polaris.test/server-settings.html" });
  let creds: unknown[] = [];
  const modalOpens: unknown[] = [];
  let listCalls = 0;
  Object.assign(win as unknown as Record<string, unknown>, {
    formatBytes: (n: number) => n + " B",
    timeAgo: () => "2 days ago",
    escapeHtml: (x: unknown) => String(x ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] as string)),
    showToast: () => {},
    calloutHTML: () => "",
    permAtLeast: () => true,
    isAdmin: () => true,
    openCredentialModal: (id: unknown, state: unknown) => { modalOpens.push({ id, state }); },
    api: {
      serverSettings: { getFirmwareTree: async () => tree(), listFirmwareRuns: async () => ({ runs: [] }) },
      credentials: { list: async () => { listCalls++; return creds; } },
    },
  });
  win.document.body.innerHTML = '<div id="tab-firmware"></div>';
  (win as unknown as { eval: (s: string) => void }).eval(readFileSync(resolve(__dirname, "../../public/js/server-settings-firmware.js"), "utf8"));
  const tab = (win as unknown as { PolarisFirmwareTab: { load: () => Promise<void>; nodeKey: (...p: string[]) => string; _setState: (s: unknown) => void } }).PolarisFirmwareTab;
  return { win, tab, modalOpens, setCreds: (c: unknown[]) => { creds = c; }, listCalls: () => listCalls };
}

const tick = () => new Promise((r) => setTimeout(r, 30));

describe("Add a device admin login from the Repository binding editor", () => {
  it("re-fetches the credentials on save, redraws the select with the new login, and picks it", async () => {
    const { win, tab, modalOpens, setCreds, listCalls } = boot();
    const key = tab.nodeKey("Fortinet", "switch", MODEL);
    tab._setState({ expanded: { [tab.nodeKey("Fortinet")]: true, [tab.nodeKey("Fortinet", "switch")]: true, [key]: true } });
    await tab.load();
    const doc = win.document as unknown as Document;
    const node = () => doc.querySelector(`.fw-node[data-fw-key="${key}"]`) as HTMLElement;

    (node().querySelector(".fw-binding-edit") as HTMLElement).click();
    await tick();
    const optionValues = () => Array.from((node().querySelector(".fw-binding-select") as HTMLSelectElement).options).map((o) => o.value);
    expect(optionValues()).toEqual([""]);

    (node().querySelector(".fw-binding-new") as HTMLElement).click();
    expect(modalOpens).toHaveLength(1);

    // The credential modal saves and announces it.
    setCreds([login]);
    win.dispatchEvent(new win.CustomEvent("polaris:credentials-changed", { detail: { id: "cred-new", created: true } }));
    await tick();

    expect(listCalls()).toBe(2);
    expect(optionValues()).toEqual(["", "cred-new"]);
    expect((node().querySelector(".fw-binding-select") as HTMLSelectElement).value).toBe("cred-new");
  });

  it("a credential edited elsewhere refreshes an open editor but changes nobody's pick", async () => {
    const { win, tab, setCreds } = boot();
    const key = tab.nodeKey("Fortinet", "switch", MODEL);
    tab._setState({ expanded: { [tab.nodeKey("Fortinet")]: true, [tab.nodeKey("Fortinet", "switch")]: true, [key]: true } });
    await tab.load();
    const doc = win.document as unknown as Document;
    const node = () => doc.querySelector(`.fw-node[data-fw-key="${key}"]`) as HTMLElement;
    (node().querySelector(".fw-binding-edit") as HTMLElement).click();
    await tick();

    setCreds([login]);
    win.dispatchEvent(new win.CustomEvent("polaris:credentials-changed", { detail: { id: "cred-new", created: false } }));
    await tick();

    const sel = node().querySelector(".fw-binding-select") as HTMLSelectElement;
    expect(Array.from(sel.options).map((o) => o.value)).toEqual(["", "cred-new"]);
    expect(sel.value).toBe("");
  });
});
