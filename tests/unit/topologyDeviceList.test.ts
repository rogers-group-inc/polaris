/**
 * tests/unit/topologyDeviceList.test.ts — the Device List of a topology
 * view's Topology and Rack canvases (public/js/topology-device-list.js):
 * one list of every shown device, a device on the canvas highlighted with an
 * × (edit mode) and the rest draggable, a filter that survives a redraw.
 */
// @vitest-environment happy-dom
import { describe, it, expect, beforeAll, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

type DL = {
  html: (o: Record<string, unknown>) => string;
  wire: (pane: Element, o: Record<string, unknown>) => void;
  _matches: (row: { label?: string; meta?: string }, f: string) => boolean;
};
let DL: DL;

beforeAll(() => {
  const src = readFileSync(resolve(__dirname, "../../public/js/topology-device-list.js"), "utf8");
  new Function(src)();
  DL = (window as unknown as { PolarisTopologyDeviceList: DL }).PolarisTopologyDeviceList;
});

const rows = [
  { id: "sw1", label: "PL-SW1", meta: "b:Plant", inUse: true },
  { id: "ap1", label: "PL-AP1", meta: "access point", inUse: false },
  { id: "fw", label: "HQ-FGT01", meta: "firewall", inUse: false },
];

function mount(opts: Record<string, unknown>): HTMLElement {
  const pane = document.createElement("div");
  pane.innerHTML = DL.html({ rows, ...opts });
  document.body.appendChild(pane);
  return pane;
}

describe("topology Device List", () => {
  it("matches on the name or the meta column, any case", () => {
    expect(DL._matches({ label: "PL-SW1", meta: "b:Plant" }, "plant")).toBe(true);
    expect(DL._matches({ label: "PL-SW1", meta: "b:Plant" }, "ap")).toBe(false);
    expect(DL._matches({ label: "x" }, "  ")).toBe(true);
  });

  it("highlights the rows on the canvas; while editing they get an × and the rest are draggable", () => {
    const pane = mount({ editing: true });
    expect(pane.querySelector("h5")!.textContent).toContain("Device List");
    expect(pane.querySelector("h5")!.textContent).toContain("1 / 3");
    const sw = pane.querySelector('[data-device-row="sw1"]')!;
    expect(sw.classList.contains("is-in-use")).toBe(true);
    expect(sw.querySelector("[data-unplace]")).not.toBeNull();
    expect(sw.getAttribute("draggable")).toBeNull();
    const ap = pane.querySelector('[data-device-row="ap1"]')!;
    expect(ap.getAttribute("draggable")).toBe("true");
    expect(ap.querySelector("[data-unplace]")).toBeNull();
  });

  it("viewing: no × and nothing draggable", () => {
    const pane = mount({ editing: false });
    expect(pane.querySelectorAll("[data-unplace]").length).toBe(0);
    expect(pane.querySelectorAll("[draggable]").length).toBe(0);
  });

  it("a kept filter is applied on render; typing filters and reports the text", () => {
    const onFilter = vi.fn();
    const pane = mount({ editing: true, filter: "fgt" });
    expect((pane.querySelector('[data-device-row="sw1"]') as HTMLElement).hidden).toBe(true);
    expect((pane.querySelector('[data-device-row="fw"]') as HTMLElement).hidden).toBe(false);
    DL.wire(pane, { dragMime: "x", onFilter });
    const input = pane.querySelector(".topo-device-filter") as HTMLInputElement;
    input.value = "nothing-matches";
    input.dispatchEvent(new Event("input"));
    expect(onFilter).toHaveBeenCalledWith("nothing-matches");
    expect((pane.querySelector(".topo-device-none") as HTMLElement).hidden).toBe(false);
  });

  it("the × removes and a row click selects", () => {
    const onRemove = vi.fn();
    const onSelect = vi.fn();
    const pane = mount({ editing: true });
    DL.wire(pane, { dragMime: "x", onRemove, onSelect });
    (pane.querySelector('[data-unplace="sw1"]') as HTMLElement).click();
    expect(onRemove).toHaveBeenCalledWith("sw1");
    expect(onSelect).not.toHaveBeenCalled();
    (pane.querySelector('[data-device-row="ap1"] .topo-device-name') as HTMLElement).click();
    expect(onSelect).toHaveBeenCalledWith("ap1");
  });

  it("escapes device names", () => {
    const pane = document.createElement("div");
    pane.innerHTML = DL.html({ rows: [{ id: "x", label: "<img src=x onerror=alert(1)>", meta: "", inUse: false }] });
    expect(pane.querySelector("img")).toBeNull();
  });
});
