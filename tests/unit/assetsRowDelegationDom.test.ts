/**
 * tests/unit/assetsRowDelegationDom.test.ts — the per-paint row loops in
 * public/js/assets.js that became delegated listeners (CQ-F042):
 *
 *   • the address / MAC hover pills (`.mac-hover-trigger`) on the Assets list
 *     and in the asset panel — `_wireHoverTriggersIn`, which rebuilds
 *     mouseenter / mouseleave (they do not bubble) from mouseover / mouseout;
 *   • the Device-column pivot links of the MAC Table, ARP Table and managed-
 *     children tabs — `_wireAssetPivotLinks`;
 *   • those tables' ▶ / ▼ group toggles — `_wireGroupToggles`;
 *   • the Wireless tab body's toggles and endpoint links — `_wireWirelessBody`.
 *
 * Each of those tables repaints on every keystroke in its filter box (the
 * Assets list on every page / sort / filter / refresh). Pinned for each: a row
 * painted AFTER the listener was bound still works, and wiring again on the
 * next paint never makes one gesture act twice.
 *
 * Functions are sliced out of assets.js by name and eval'd with their
 * collaborators stubbed (the approach of assetWirelessTreeDom.test.ts).
 *
 * @vitest-environment happy-dom
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const g = globalThis as Record<string, any>;
const lines = readFileSync(resolve(__dirname, "../../public/js/assets.js"), "utf8").split(/\r?\n/);

function fnSrc(name: string): string {
  const start = lines.findIndex((l) => l.startsWith(`function ${name}(`));
  if (start < 0) throw new Error(`assets.js: function ${name} not found`);
  const end = lines.findIndex((l, i) => i > start && l === "}");
  return lines.slice(start, end + 1).join("\n");
}

for (const name of [
  "_macTriggerEnter", "_macTriggerLeave", "_macTriggersCrossed", "_handleMacOver", "_handleMacOut",
  "_wireHoverTriggersIn", "_wireAssetPivotLinks", "_handleAssetPivotClick", "_wireGroupToggles", "_wireWirelessBody",
]) {
  (0, eval)(fnSrc(name));
}

function mouse(type: string, target: Element, related: Element | null): MouseEvent {
  const ev = new MouseEvent(type, { bubbles: true, cancelable: true, relatedTarget: related });
  target.dispatchEvent(ev);
  return ev;
}

function click(el: Element): MouseEvent {
  const ev = new MouseEvent("click", { bubbles: true, cancelable: true });
  el.dispatchEvent(ev);
  return ev;
}

describe("hover pills — delegated mouseenter / mouseleave", () => {
  let shown: Element[];
  let hidden: Element[];

  beforeEach(() => {
    vi.useFakeTimers();
    shown = [];
    hidden = [];
    g._macTooltipShowTimer = null;
    g._MAC_TOOLTIP_SHOW_DELAY = 300;
    g._showMacTooltip = (t: Element) => { shown.push(t); };
    g._scheduleMacHide = (tip: Element) => { hidden.push(tip); };
    document.body.innerHTML = '<p id="outside">x</p><table><tbody id="tb"></tbody></table>';
  });
  afterEach(() => { vi.useRealTimers(); });

  const pill = (id: string) =>
    `<tr><td><span class="mac-hover-trigger" id="${id}"><span class="copy-cell">10.0.0.1</span>` +
    '<span class="mac-badge-count">+2</span><div class="mac-tooltip">tip</div></span></td></tr>';

  it("no longer binds a listener per pill on each paint", () => {
    expect(fnSrc("renderAssetsPage")).not.toContain("querySelectorAll('.mac-hover-trigger')");
    expect(fnSrc("_wireHoverTriggersIn")).not.toContain("querySelectorAll");
  });

  it("shows a pill painted after binding, once, however often the container was wired", () => {
    const tb = document.getElementById("tb")!;
    g._wireHoverTriggersIn(tb);
    tb.innerHTML = pill("p1");
    g._wireHoverTriggersIn(tb);
    tb.innerHTML = pill("p1") + pill("p2");
    g._wireHoverTriggersIn(tb);
    const p2 = document.getElementById("p2")!;
    mouse("mouseover", p2.querySelector(".copy-cell")!, document.getElementById("outside"));
    vi.advanceTimersByTime(300);
    expect(shown).toEqual([p2]);
  });

  it("treats moving between a pill's own children as staying inside it", () => {
    const tb = document.getElementById("tb")!;
    g._wireHoverTriggersIn(tb);
    tb.innerHTML = pill("p1");
    const p1 = document.getElementById("p1")!;
    const [ip, badge] = [p1.querySelector(".copy-cell")!, p1.querySelector(".mac-badge-count")!];
    mouse("mouseover", ip, null);
    vi.advanceTimersByTime(300);
    expect(shown).toEqual([p1]);
    // ip → badge: an out on ip and an over on badge, both relatedTarget inside p1.
    mouse("mouseout", ip, badge);
    mouse("mouseover", badge, ip);
    vi.advanceTimersByTime(300);
    expect(shown).toEqual([p1]);
    expect(hidden).toEqual([]);
  });

  it("schedules the hide when the pointer leaves the pill, and cancels a pending show", () => {
    const tb = document.getElementById("tb")!;
    g._wireHoverTriggersIn(tb);
    tb.innerHTML = pill("p1");
    const p1 = document.getElementById("p1")!;
    mouse("mouseover", p1, null);
    mouse("mouseout", p1, document.getElementById("outside"));
    vi.advanceTimersByTime(300);
    expect(shown).toEqual([]);
    expect(hidden).toEqual([p1.querySelector(".mac-tooltip")]);
  });

  it("enters nested pills outermost first, so the innermost one's tooltip is the one shown", () => {
    const box = document.createElement("div");
    document.body.appendChild(box);
    g._wireHoverTriggersIn(box);
    box.innerHTML =
      '<span class="mac-hover-trigger" id="outer">a <span class="mac-hover-trigger" id="inner">b' +
      '<div class="mac-tooltip">in</div></span><div class="mac-tooltip">out</div></span>';
    mouse("mouseover", document.getElementById("inner")!, null);
    vi.advanceTimersByTime(300);
    expect(shown).toEqual([document.getElementById("inner")]);
  });
});

describe("pivot links — delegated, bound once per table body", () => {
  it("opens the asset of a link painted after binding, once, and cancels the navigation", () => {
    const opened: string[] = [];
    g.openViewModal = (id: string) => { opened.push(id); };
    document.body.innerHTML = '<div id="b"></div>';
    const b = document.getElementById("b")!;
    for (let i = 0; i < 3; i++) {
      b.innerHTML = '<table><tbody><tr><td><a href="#" class="asset-link" data-asset-id="a7"><b>sw-1</b></a></td></tr></tbody></table>';
      g._wireAssetPivotLinks(b);
    }
    const ev = click(b.querySelector(".asset-link b")!);
    expect(ev.defaultPrevented).toBe(true);
    expect(opened).toEqual(["a7"]);
  });

  it("leaves other clicks in the body alone", () => {
    const opened: string[] = [];
    g.openViewModal = (id: string) => { opened.push(id); };
    document.body.innerHTML = '<div id="b"><a href="#x" class="other">x</a></div>';
    const b = document.getElementById("b")!;
    g._wireAssetPivotLinks(b);
    expect(click(b.querySelector(".other")!).defaultPrevented).toBe(false);
    expect(opened).toEqual([]);
  });
});

describe("group toggles — delegated, bound once per table body", () => {
  const OPTS = { toggle: ".arptable-group-toggle", entry: ".arptable-entry", expandTitle: "Expand entries", collapseTitle: "Collapse entries" };
  const paint = (b: HTMLElement) => {
    b.innerHTML =
      '<table><tbody>' +
      '<tr><td><button class="arptable-group-toggle" data-group="port1">▼</button></td></tr>' +
      '<tr class="arptable-entry" data-group="port1"><td>a</td></tr>' +
      '<tr class="arptable-entry" data-group="port1"><td>b</td></tr>' +
      '<tr><td><button class="arptable-group-toggle" data-group="port2">▼</button></td></tr>' +
      '<tr class="arptable-entry" data-group="port2"><td>c</td></tr>' +
      '</tbody></table>';
    g._wireGroupToggles(b, OPTS);
  };

  it("collapses and re-opens only its own group on a repainted body, one flip per click", () => {
    document.body.innerHTML = '<div id="b"></div>';
    const b = document.getElementById("b")!;
    paint(b);
    paint(b);
    paint(b);
    const tog = b.querySelector('[data-group="port1"].arptable-group-toggle') as HTMLElement;
    click(tog);
    expect(tog.textContent).toBe("▶");
    expect(tog.title).toBe("Expand entries");
    const rows = (k: string) => Array.from(b.querySelectorAll(`.arptable-entry[data-group="${k}"]`)) as HTMLElement[];
    expect(rows("port1").map((r) => r.style.display)).toEqual(["none", "none"]);
    expect(rows("port2").map((r) => r.style.display)).toEqual([""]);
    click(tog);
    expect(tog.textContent).toBe("▼");
    expect(tog.title).toBe("Collapse entries");
    expect(rows("port1").map((r) => r.style.display)).toEqual(["", ""]);
  });
});

describe("Wireless tab body — delegated, acting on the latest paint", () => {
  it("records the collapse against the asset and set of the paint on screen, and stops the click there", () => {
    const saved: Array<[string, string[]]> = [];
    g._setCollapsedIfaces = (id: string, set: Set<string>) => { saved.push([id, Array.from(set)]); };
    document.body.innerHTML = '<div id="outer"><div id="w"></div></div>';
    let reachedOuter = 0;
    document.getElementById("outer")!.addEventListener("click", () => { reachedOuter++; });
    const w = document.getElementById("w")!;
    const body =
      '<table><tbody><tr><td><span class="wireless-expand-toggle" data-parent="radio-1">▼</span></td></tr>' +
      '<tr class="wireless-child" data-parent="radio-1"><td>client</td></tr></tbody></table>';
    const first = new Set<string>();
    w.innerHTML = body;
    g._wireWirelessBody(w, { id: "ap-old" }, first);
    const latest = new Set<string>();
    w.innerHTML = body;
    g._wireWirelessBody(w, { id: "ap-1" }, latest);
    click(w.querySelector(".wireless-expand-toggle")!);
    expect((w.querySelector(".wireless-child") as HTMLElement).style.display).toBe("none");
    expect(saved).toEqual([["ap-1", ["radio-1"]]]);
    expect(first.size).toBe(0);
    expect(reachedOuter).toBe(0);
  });

  it("opens a matched client's endpoint from the flat list without a second open after repaints", () => {
    const opened: string[] = [];
    g.openViewModal = (id: string) => { opened.push(id); };
    document.body.innerHTML = '<div id="w"></div>';
    const w = document.getElementById("w")!;
    for (let i = 0; i < 2; i++) {
      w.innerHTML = '<a href="#" class="asset-station-link" data-asset-id="pc-9">pc</a>';
      g._wireWirelessBody(w, { id: "ap-1" }, null);
    }
    expect(click(w.querySelector(".asset-station-link")!).defaultPrevented).toBe(true);
    expect(opened).toEqual(["pc-9"]);
  });
});
