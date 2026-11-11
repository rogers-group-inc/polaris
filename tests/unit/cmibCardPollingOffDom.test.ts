/**
 * tests/unit/cmibCardPollingOffDom.test.ts — a Custom MIB widget switched off
 * for an asset (`_cmibCardHTML` in public/js/assets-snmp.js).
 *
 * The card used to draw the last reading dimmed under "Polling is off …
 * Showing the last reading collected." An operator switches a widget off on a
 * device precisely when it reads nothing useful there — an APC PDU with no
 * temperature probe answers -1, shown as 31.8 °F (2026-11-11) — so the stale
 * value kept advertising itself. Off now shows the notice alone.
 *
 * @vitest-environment happy-dom
 */

import { describe, it, expect } from "vitest";
import { assetsSource } from "./_assetsSource.js";

const lines = assetsSource().split(/\r?\n/);

function fnSrc(name: string): string {
  const start = lines.findIndex((l) => l.startsWith(`function ${name}(`));
  if (start < 0) throw new Error(`function ${name} not found`);
  const end = lines.findIndex((l, i) => i > start && l === "}");
  return lines.slice(start, end + 1).join("\n");
}

const card = new Function(
  "escapeHtml", "canManageAssets", "_cmibIsMfr", "_renderCustomWidgetBody", "CMIB_ROW_PX", "CMIB_GAP_PX",
  `${fnSrc("_cmibCardHTML")}; return _cmibCardHTML;`,
)(
  (s: unknown) => String(s ?? ""),
  () => true,
  () => true,
  () => '<div data-body="1">31.8 °F</div>',
  60, 12,
) as (w: Record<string, unknown>, opts?: Record<string, unknown>) => string;

const widget = (enabled: boolean, extra: Record<string, unknown> = {}) => ({
  id: "w1", name: "Probe Temperature", symbol: "rPDU2SensorTempHumidityStatusTempC", enabled,
  latest: { value: -1 }, ...extra,
});

function render(w: Record<string, unknown>) {
  document.body.innerHTML = card(w);
  return document.body;
}

describe("a widget switched off for this asset", () => {
  it("shows the notice and no last reading", () => {
    const el = render(widget(false));
    expect(el.textContent).toContain("Polling is off for this asset.");
    expect(el.textContent).not.toContain("last reading");
    expect(el.querySelector("[data-body]")).toBeNull();
  });

  it("shows no last state rows either", () => {
    const el = render(widget(false, { latest: null, stateRows: [{ rowKey: "1", value: 1 }] }));
    expect(el.querySelector("[data-body]")).toBeNull();
  });

  it("still draws the reading when polling is on", () => {
    const el = render(widget(true));
    expect(el.querySelector("[data-body]")).not.toBeNull();
    expect(el.textContent).not.toContain("Polling is off");
  });
});
