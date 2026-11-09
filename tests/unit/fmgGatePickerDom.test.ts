// @vitest-environment happy-dom
/**
 * tests/unit/fmgGatePickerDom.test.ts
 *
 * The FortiGate picker of the FortiManager Query API window
 * (`_wireFmgGatePicker` in public/js/integrations.js): the .aw-suggest
 * combobox recipe — focus lists every discovered gate, typing filters,
 * ArrowDown + Enter picks, a mousedown on a row picks, Escape closes the list
 * without letting the keydown reach the modal, and a typed name is kept.
 *
 * integrations.js cannot run here as a whole, so the function and the pure
 * matcher it calls are sliced out of the source and evaluated with a stub api.
 */
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { integrationsSource } from "./_integrationsSource";

const here = dirname(fileURLToPath(import.meta.url));
let wire: (id: string) => void;
let resolveGates: (v: unknown) => void;
let rejectGates: (e: unknown) => void;

function slice(src: string, start: string, end: string): string {
  const a = src.indexOf(start);
  const b = src.indexOf(end, a);
  expect(a).toBeGreaterThan(-1);
  expect(b).toBeGreaterThan(a);
  return src.slice(a, b);
}

beforeAll(() => {
  const src = integrationsSource();
  const matcher = slice(src, "var FMG_GATE_SUGGEST_CAP", "// </fortinet-query-presets>");
  const picker = slice(src, "function _wireFmgGatePicker(", "\nfunction openApiQueryModal(");
  const api = {
    integrations: {
      fortigates: () => new Promise((res, rej) => { resolveGates = res; rejectGates = rej; }),
    },
  };
  const escapeHtml = (s: unknown) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  wire = new Function("api", "escapeHtml", matcher + "\n" + picker + "\nreturn _wireFmgGatePicker;")(api, escapeHtml);
});

const GATES = {
  fortigates: [
    { deviceName: "BRANCH-7-61F", hostname: "branch7", ipAddress: "10.7.0.1", status: "active" },
    { deviceName: "HQ-CLUSTER", hostname: "hq-a", ipAddress: "10.1.1.1", status: "active" },
  ],
};

let input: HTMLInputElement;
let sug: HTMLElement;
let modalKeydowns: number;
const flush = () => new Promise((r) => setTimeout(r, 0));
const key = (k: string) => input.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));
const rows = () => Array.from(sug.querySelectorAll(".aw-suggest-item")).map((i) => i.getAttribute("data-val"));

beforeEach(() => {
  document.body.innerHTML =
    '<div id="modal">' +
      '<span class="aw-combo"><input type="text" id="fmg-fgt-device"><div class="aw-suggest" id="fmg-fgt-device-suggest"></div></span>' +
    '</div>';
  input = document.getElementById("fmg-fgt-device") as HTMLInputElement;
  sug = document.getElementById("fmg-fgt-device-suggest") as HTMLElement;
  modalKeydowns = 0;
  document.getElementById("modal")!.addEventListener("keydown", (e) => { if ((e as KeyboardEvent).key === "Escape") modalKeydowns++; });
  wire("int-1");
});

describe("FortiGate picker", () => {
  it("says it is loading, then lists every discovered gate on focus", async () => {
    input.dispatchEvent(new Event("focus"));
    expect(sug.classList.contains("open")).toBe(true);
    expect(sug.textContent).toMatch(/Loading/);
    resolveGates(GATES);
    await flush();
    expect(rows()).toEqual(["BRANCH-7-61F", "HQ-CLUSTER"]);
    expect(sug.textContent).toContain("hq-a · 10.1.1.1");
  });

  it("lists every gate on focus even when a remembered name is in the box", async () => {
    resolveGates(GATES);
    await flush();
    input.value = "HQ-CLUSTER";
    input.dispatchEvent(new Event("focus"));
    expect(rows()).toEqual(["BRANCH-7-61F", "HQ-CLUSTER"]);
  });

  it("filters as you type and picks with ArrowDown + Enter", async () => {
    resolveGates(GATES);
    await flush();
    input.value = "hq";
    input.dispatchEvent(new Event("input"));
    expect(rows()).toEqual(["HQ-CLUSTER"]);
    key("ArrowDown");
    key("Enter");
    expect(input.value).toBe("HQ-CLUSTER");
    expect(sug.classList.contains("open")).toBe(false);
  });

  it("picks a row on mousedown", async () => {
    resolveGates(GATES);
    await flush();
    input.dispatchEvent(new Event("focus"));
    const row = sug.querySelector('.aw-suggest-item[data-val="BRANCH-7-61F"]')!;
    row.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    expect(input.value).toBe("BRANCH-7-61F");
  });

  it("keeps a typed name nothing matches, and says it will be sent as typed", async () => {
    resolveGates(GATES);
    await flush();
    input.value = "NEW-GATE-01";
    input.dispatchEvent(new Event("input"));
    expect(rows()).toEqual([]);
    expect(sug.textContent).toMatch(/sent as typed/);
    expect(input.value).toBe("NEW-GATE-01");
  });

  it("Escape closes the list without reaching the modal; a second Escape does", async () => {
    resolveGates(GATES);
    await flush();
    input.dispatchEvent(new Event("focus"));
    key("Escape");
    expect(sug.classList.contains("open")).toBe(false);
    expect(modalKeydowns).toBe(0);
    key("Escape");
    expect(modalKeydowns).toBe(1);
  });

  it("still takes a typed name when the lookup fails", async () => {
    rejectGates(new Error("403"));
    await flush();
    input.dispatchEvent(new Event("focus"));
    expect(sug.textContent).toMatch(/Typing a name still works/);
  });
});
