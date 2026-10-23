/**
 * tests/unit/manufacturerProfileFormPreserve.test.ts — typed input must survive
 * the Manufacturer Profile editor's chained-select re-renders.
 *
 * The bug this pins: the MIB / symbol-type / widget-type selects are chained
 * (Symbol comes from the MIB, the sub-form from the widget type), so each one
 * re-renders. But the re-render rebuilds every row and card from STORED state,
 * and the only values carried across were the three selects themselves — so an
 * operator who typed a Name and then picked a MIB watched the Name vanish.
 * Reported from prod on the state-probe form; it affected every field on the
 * metric rows and override rows too.
 *
 * server-settings.js is a plain browser script whose only load-time side effects
 * are event listeners (DOMContentLoaded, never dispatched here, and the Symbol
 * combobox's delegated document handlers), so it evals into a happy-dom Window
 * and its `function`/`var` declarations land on that global.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Window } from "happy-dom";

interface Sandbox {
  document: Document;
  renderIdentificationTab: () => void;
  _mfgRerenderPreserving: (el: Element) => void;
  _mfgRerenderPreservingAll: () => void;
  _mfgEditContainerKey: (el: Element | null) => string;
  _mfgFieldKey: (el: Element) => string;
  _ensureMibSymbols: (mibId: string) => void;
  _mfgMibSymbolsCache: Record<string, unknown>;
  api: { serverSettings?: { getMibStructure: (id: string) => Promise<unknown> } };
}

let win: Window;
let sb: Sandbox;

beforeAll(() => {
  win = new Window({ url: "https://polaris.test/server-settings.html" });
  // App-shell globals the script binds at LOAD time (`var formatBytesShort =
  // formatBytes`), so they must exist before eval. Everything else it uses is
  // referenced lazily from handlers this test never fires.
  Object.assign(win as unknown as Record<string, unknown>, {
    formatBytes: (n: number) => String(n),
    escapeHtml: (x: unknown) => String(x ?? ""),
    showToast: () => {},
    permAtLeast: () => true,
    api: {},
  });
  const code = readFileSync(resolve(__dirname, "../../public/js/server-settings.js"), "utf8");
  // eval inside the window so declarations become globals we can call + stub.
  (win as unknown as { eval: (s: string) => void }).eval(code);
  sb = win as unknown as Sandbox;
});

/** The widget "add" card as the renderer emits it, with whatever the operator
 *  has typed so far. `nameValue` empty = a fresh render from stored state. */
function addCardHtml(profileId: string, nameValue: string, symbolOptions: string[], symbolValue: string) {
  return `<div class="mfg-widget-add-card" data-profile-id="${profileId}">
    <input type="text" class="mfg-widget-name" value="${nameValue}">
    <select class="mfg-widget-widgettype"><option value="gauge">Gauge</option><option value="state">State (0/1)</option></select>
    <select class="mfg-widget-mib"><option value="">(pick)</option><option value="mib-a">A</option><option value="mib-b">B</option></select>
    <select class="mfg-widget-type"><option value="scalar">scalar</option><option value="table">table</option></select>
    <select class="mfg-widget-symbol">${symbolOptions.map((s) => `<option value="${s}">${s}</option>`).join("")}</select>
    <input type="text" class="mfg-widget-model" value="">
    <input type="text" class="mfg-widget-statetrue" value="Alarm">
    <input type="checkbox" class="mfg-widget-stateproblem" checked>
  </div>`;
}

function setBody(html: string) {
  sb.document.body.innerHTML = html;
}

describe("_mfgFieldKey / _mfgEditContainerKey", () => {
  it("keys a field by its own mfg-* class", () => {
    setBody(addCardHtml("p1", "", ["x"], "x"));
    const name = sb.document.querySelector(".mfg-widget-name")!;
    expect(sb._mfgFieldKey(name)).toBe("mfg-widget-name");
  });

  it("keys an add card, an edit card and an override row by their stored-shadow identity", () => {
    setBody(`
      <div class="mfg-widget-add-card" data-profile-id="p1"></div>
      <div class="mfg-widget-edit-card" data-profile-id="p1" data-widget-id="w9"></div>
      <table><tbody><tr data-override-id="o5"><td></td></tr></tbody></table>`);
    expect(sb._mfgEditContainerKey(sb.document.querySelector(".mfg-widget-add-card")!)).toBe("new-widget:p1");
    expect(sb._mfgEditContainerKey(sb.document.querySelector(".mfg-widget-edit-card")!)).toBe("widget:w9");
    expect(sb._mfgEditContainerKey(sb.document.querySelector("tr[data-override-id]")!)).toBe("override:o5");
  });

  it("tells a metric row apart from the add-override row that shares its profile + metric key", () => {
    // Both carry the same data attributes; only the controls they own differ.
    setBody(`<table><tbody>
      <tr data-profile-id="p1" data-metric-key="cpu"><td><select class="mfg-edit-mib"></select></td></tr>
      <tr data-profile-id="p1" data-metric-key="cpu"><td><select class="mfg-new-override-mib"></select></td></tr>
    </tbody></table>`);
    const rows = sb.document.querySelectorAll("tr");
    expect(sb._mfgEditContainerKey(rows[0])).toBe("metric:p1:cpu");
    expect(sb._mfgEditContainerKey(rows[1])).toBe("new:p1:cpu");
  });
});

describe("_mfgRerenderPreserving", () => {
  it("keeps a typed Name when the MIB select re-renders the card", () => {
    setBody(addCardHtml("p1", "Hardware sensor alarm", ["fgHwSensorEntAlarmStatus"], "fgHwSensorEntAlarmStatus"));
    // The operator picks a MIB; the handler records it and re-renders. The
    // re-render rebuilds from STORED state, so Name comes back empty.
    const mib = sb.document.querySelector(".mfg-widget-mib") as HTMLSelectElement;
    mib.value = "mib-b";
    sb.renderIdentificationTab = () => setBody(addCardHtml("p1", "", ["fgHwSensorEntAlarmStatus"], ""));

    sb._mfgRerenderPreserving(mib);

    const name = sb.document.querySelector(".mfg-widget-name") as HTMLInputElement;
    expect(name.value).toBe("Hardware sensor alarm");
    // The select that triggered it keeps the operator's new choice.
    expect((sb.document.querySelector(".mfg-widget-mib") as HTMLSelectElement).value).toBe("mib-b");
  });

  it("keeps every other typed field, including the state mapping and its checkbox", () => {
    setBody(addCardHtml("p1", "Probe", ["a"], "a"));
    (sb.document.querySelector(".mfg-widget-model") as HTMLInputElement).value = "FortiGate-60F";
    (sb.document.querySelector(".mfg-widget-statetrue") as HTMLInputElement).value = "Failed";
    (sb.document.querySelector(".mfg-widget-stateproblem") as HTMLInputElement).checked = false;
    const wt = sb.document.querySelector(".mfg-widget-widgettype") as HTMLSelectElement;
    wt.value = "state";
    sb.renderIdentificationTab = () => setBody(addCardHtml("p1", "", ["a"], ""));

    sb._mfgRerenderPreserving(wt);

    expect((sb.document.querySelector(".mfg-widget-model") as HTMLInputElement).value).toBe("FortiGate-60F");
    expect((sb.document.querySelector(".mfg-widget-statetrue") as HTMLInputElement).value).toBe("Failed");
    expect((sb.document.querySelector(".mfg-widget-stateproblem") as HTMLInputElement).checked).toBe(false);
  });

  it("drops a Symbol the newly-picked MIB doesn't offer, rather than restoring a stale one", () => {
    setBody(addCardHtml("p1", "Probe", ["oldSymbol"], "oldSymbol"));
    const mib = sb.document.querySelector(".mfg-widget-mib") as HTMLSelectElement;
    mib.value = "mib-b";
    // The new MIB's symbol list has nothing in common with the old one.
    sb.renderIdentificationTab = () => setBody(addCardHtml("p1", "", ["brandNewSymbol"], ""));

    sb._mfgRerenderPreserving(mib);

    const sym = sb.document.querySelector(".mfg-widget-symbol") as HTMLSelectElement;
    expect(sym.value).toBe("");
    expect((sb.document.querySelector(".mfg-widget-name") as HTMLInputElement).value).toBe("Probe");
  });

  it("restores into the row it came from when another card is also open", () => {
    setBody(addCardHtml("p1", "First", ["a"], "a") + addCardHtml("p2", "Second", ["a"], "a"));
    const secondMib = sb.document.querySelectorAll(".mfg-widget-mib")[1] as HTMLSelectElement;
    secondMib.value = "mib-a";
    sb.renderIdentificationTab = () =>
      setBody(addCardHtml("p1", "", ["a"], "") + addCardHtml("p2", "", ["a"], ""));

    sb._mfgRerenderPreserving(secondMib);

    const names = sb.document.querySelectorAll(".mfg-widget-name");
    // Only p2's snapshot exists, so p1 renders from stored state (blank) and p2
    // gets its typed value back — never the other way round.
    expect((names[0] as HTMLInputElement).value).toBe("");
    expect((names[1] as HTMLInputElement).value).toBe("Second");
  });

  it("preserves a metric row's typed symbol across its type select", () => {
    setBody(`<table><tbody><tr data-profile-id="p1" data-metric-key="cpu">
      <td><select class="mfg-edit-type"><option value="scalar">scalar</option><option value="table">table</option></select></td>
      <td><input type="text" class="mfg-edit-symbol" value="ssCpuRawUser"></td>
    </tr></tbody></table>`);
    const type = sb.document.querySelector(".mfg-edit-type") as HTMLSelectElement;
    type.value = "table";
    sb.renderIdentificationTab = () => setBody(`<table><tbody><tr data-profile-id="p1" data-metric-key="cpu">
      <td><select class="mfg-edit-type"><option value="scalar">scalar</option><option value="table">table</option></select></td>
      <td><input type="text" class="mfg-edit-symbol" value=""></td>
    </tr></tbody></table>`);

    sb._mfgRerenderPreserving(type);

    expect((sb.document.querySelector(".mfg-edit-symbol") as HTMLInputElement).value).toBe("ssCpuRawUser");
  });
});

// ─── The ASYNC re-render ───────────────────────────────────────────────────
//
// Picking a MIB does two things: the handler re-renders synchronously (covered
// above) AND `_ensureMibSymbols` fetches that MIB's symbol list, re-rendering
// again when it resolves. The second render arrives after the first one's
// restore, from a callback holding no element — so while the tests above passed,
// prod still lost the Name: it came back, then vanished a few hundred ms later
// on every FIRST pick of a MIB (a warm cache short-circuits the fetch, which is
// why it looked intermittent). These pin the callback's own preservation.

describe("_ensureMibSymbols re-render", () => {
  it("keeps typed input when the symbol fetch resolves and re-renders", async () => {
    setBody(addCardHtml("p1", "Connected clients", ["oldSymbol"], "oldSymbol"));
    (sb.document.querySelector(".mfg-widget-model") as HTMLInputElement).value = "FortiAP-231F";
    // Fresh cache = the fetch actually runs, which is the reported case.
    sb._mfgMibSymbolsCache = {};
    sb.api.serverSettings = {
      getMibStructure: async () => ({ symbols: [{ name: "newSymbol" }], tables: [] }),
    };
    // The re-render rebuilds from stored state, as the real renderer does.
    sb.renderIdentificationTab = () => setBody(addCardHtml("p1", "", ["newSymbol"], ""));

    sb._ensureMibSymbols("mib-b");
    await new Promise((r) => setTimeout(r, 0));

    expect((sb.document.querySelector(".mfg-widget-name") as HTMLInputElement).value).toBe("Connected clients");
    expect((sb.document.querySelector(".mfg-widget-model") as HTMLInputElement).value).toBe("FortiAP-231F");
  });

  it("keeps typed input even when the fetch FAILS", async () => {
    setBody(addCardHtml("p1", "Connected clients", ["oldSymbol"], "oldSymbol"));
    sb._mfgMibSymbolsCache = {};
    sb.api.serverSettings = { getMibStructure: async () => { throw new Error("boom"); } };
    sb.renderIdentificationTab = () => setBody(addCardHtml("p1", "", [], ""));

    sb._ensureMibSymbols("mib-b");
    await new Promise((r) => setTimeout(r, 0));

    expect((sb.document.querySelector(".mfg-widget-name") as HTMLInputElement).value).toBe("Connected clients");
  });

  it("restores every open editor, since the callback has no triggering element", async () => {
    setBody(addCardHtml("p1", "First", ["a"], "a") + addCardHtml("p2", "Second", ["a"], "a"));
    sb._mfgMibSymbolsCache = {};
    sb.api.serverSettings = { getMibStructure: async () => ({ symbols: [], tables: [] }) };
    sb.renderIdentificationTab = () => setBody(addCardHtml("p1", "", ["a"], "") + addCardHtml("p2", "", ["a"], ""));

    sb._ensureMibSymbols("mib-a");
    await new Promise((r) => setTimeout(r, 0));

    const names = sb.document.querySelectorAll(".mfg-widget-name");
    expect((names[0] as HTMLInputElement).value).toBe("First");
    expect((names[1] as HTMLInputElement).value).toBe("Second");
  });
});
