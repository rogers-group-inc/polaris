/**
 * tests/unit/capacityAlertHoldDom.test.ts — the alert-hold row on the
 * Maintenance tab's Database card (public/js/server-settings.js). Business
 * rule 105.
 *
 * The card grades capacity live; the alert is recorded only once a change has
 * held. The row must say what the alerting side last recorded and any change
 * it is waiting out, so an alert beside a card reading Healthy is explained on
 * the same screen.
 *
 * Functions are sliced out of the browser script by name and eval'd with the
 * app-shell globals stubbed — the approach of capacityAdvisorRestartDom.test.ts.
 * The selected option is asserted on the HTML string, not `select.value`:
 * happy-dom mis-parses `<option selected>` in some layouts.
 *
 * @vitest-environment happy-dom
 */

import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const g = globalThis as Record<string, any>;
const lines = readFileSync(resolve(__dirname, "../../public/js/server-settings.js"), "utf8").split(/\r?\n/);

function fnSrc(name: string): string {
  const start = lines.findIndex((l) => l.startsWith(`function ${name}(`));
  if (start < 0) throw new Error(`function ${name} not found in server-settings.js`);
  const end = lines.findIndex((l, i) => i > start && l === "}");
  if (end < 0) throw new Error(`no end of function ${name}`);
  return lines.slice(start, end + 1).join("\n");
}

const FN_NAMES = ["_capacitySeverityLabel", "_capacityHoldLabel", "renderCapacityAlertHoldHtml"];

let render: (t: any) => string;

beforeEach(() => {
  g.escapeHtml = (s: any) =>
    String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  g.formatLocalTime = (s: string) => String(s);
  const choicesLine = lines.find((l) => l.startsWith("var CAPACITY_ALERT_HOLD_CHOICES"));
  if (!choicesLine) throw new Error("CAPACITY_ALERT_HOLD_CHOICES not found");
  // eslint-disable-next-line no-eval
  render = eval(`(function () {
    ${choicesLine}
    ${FN_NAMES.map(fnSrc).join("\n")}
    return renderCapacityAlertHoldHtml;
  })()`);
});

const base = { recorded: { severity: "ok", recordedAt: "2026-10-12T10:00:00Z" }, pending: null, holdMinutes: 30, intervalMinutes: 10 };

describe("capacity alert-hold row", () => {
  it("renders nothing when the server sent no transition state", () => {
    expect(render(null)).toBe("");
  });

  it("selects the stored hold and names the recorded severity", () => {
    const html = render(base);
    expect(html).toContain('<option value="30" selected>30 minutes</option>');
    expect(html).toContain('<option value="0">Alert on the first reading</option>');
    document.body.innerHTML = html;
    expect(document.getElementById("capacity-alert-hold-status")!.textContent)
      .toBe("Alerting last recorded Healthy at 2026-10-12T10:00:00Z.");
  });

  it("keeps a hold set through the API that is not one of the presets", () => {
    const html = render({ ...base, holdMinutes: 45 });
    expect(html).toContain('<option value="45" selected>45 minutes</option>');
    expect(html.indexOf('value="30"')).toBeLessThan(html.indexOf('value="45"'));
    expect(html.indexOf('value="45"')).toBeLessThan(html.indexOf('value="60"'));
  });

  it("explains a pending change: what it is, how long it has held, and what discards it", () => {
    const since = new Date(Date.now() - 10 * 60_000).toISOString();
    document.body.innerHTML = render({ ...base, pending: { severity: "warning", since, lastAt: since } });
    const text = document.getElementById("capacity-alert-hold-status")!.textContent!;
    expect(text).toContain("Waiting out a change to Action recommended");
    expect(text).toContain("seen for 10 of 30 min");
    expect(text).toContain("one check back at Healthy discards it");
  });
});
