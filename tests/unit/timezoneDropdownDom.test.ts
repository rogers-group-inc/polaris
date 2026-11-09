/**
 * tests/unit/timezoneDropdownDom.test.ts — the Server Settings NTP card's
 * searchable timezone picker (public/js/server-settings.js →
 * initTimezoneDropdown) picks an option through ONE delegated mousedown on
 * #tz-dropdown, bound once (CQ-F042).
 *
 * The list repaints every zone the browser knows (~400) on each keystroke and
 * used to bind a listener per option per keystroke. Pinned:
 *   • an option painted AFTER the listener was bound still picks — the point
 *     of delegation;
 *   • repainting never makes one press pick twice;
 *   • the press still preventDefault()s, which is what keeps the input from
 *     blurring (and closing the list) before the pick lands.
 *
 * @vitest-environment happy-dom
 */

import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { serverSettingsSource } from "./_serverSettingsSource";

const g = globalThis as Record<string, any>;
const lines = serverSettingsSource().split(/\r?\n/);

function fnSrc(name: string): string {
  const start = lines.findIndex((l) => l.startsWith(`function ${name}(`));
  if (start < 0) throw new Error(`server-settings.js: function ${name} not found`);
  const end = lines.findIndex((l, i) => i > start && l === "}");
  return lines.slice(start, end + 1).join("\n");
}

let picks = 0;

beforeEach(() => {
  document.body.innerHTML =
    '<input id="f-ntp-timezone"><input type="hidden" id="f-ntp-timezone-val">' +
    '<button id="tz-clear"></button><div class="search-select-dropdown" id="tz-dropdown"></div>';
  picks = 0;
  g.escapeHtml = (s: unknown) => String(s ?? "");
  g.updateCurrentTime = () => { picks++; };
  (0, eval)(fnSrc("initTimezoneDropdown"));
  g.initTimezoneDropdown("");
});

function typeInto(value: string): void {
  const input = document.getElementById("f-ntp-timezone") as HTMLInputElement;
  input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function press(el: Element): MouseEvent {
  const ev = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
  el.dispatchEvent(ev);
  return ev;
}

describe("initTimezoneDropdown — delegated option pick", () => {
  it("no longer binds a listener per option inside renderOptions", () => {
    expect(fnSrc("initTimezoneDropdown")).not.toMatch(/\.search-select-option"\)\.forEach/);
  });

  it("picks an option painted after binding, once per press across repaints, without blurring", () => {
    typeInto("a");
    typeInto("am");
    typeInto("amsterdam");
    const dropdown = document.getElementById("tz-dropdown")!;
    const opt = dropdown.querySelector('.search-select-option[data-value="Europe/Amsterdam"]');
    expect(opt, "Europe/Amsterdam option").not.toBeNull();
    // Pressing the inner zone-id span still picks the option it sits in.
    const ev = press(opt!.querySelector("span")!);
    expect(ev.defaultPrevented).toBe(true);
    expect((document.getElementById("f-ntp-timezone-val") as HTMLInputElement).value).toBe("Europe/Amsterdam");
    expect(picks).toBe(1);
    expect(dropdown.dataset.tzWired).toBe("1");
  });

  it("ignores a press on a region heading or the empty note", () => {
    typeInto("europe/");
    const dropdown = document.getElementById("tz-dropdown")!;
    const ev = press(dropdown.querySelector(".search-select-group")!);
    expect(ev.defaultPrevented).toBe(false);
    expect(picks).toBe(0);
    typeInto("no-such-zone");
    press(dropdown.querySelector(".search-select-empty")!);
    expect(picks).toBe(0);
  });
});
