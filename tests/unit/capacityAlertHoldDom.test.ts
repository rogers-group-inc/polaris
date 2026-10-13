/**
 * tests/unit/capacityAlertHoldDom.test.ts — the alert-hold row on the
 * Maintenance tab's Database card (public/js/server-settings.js). Business
 * rule 105.
 *
 * The card grades capacity live; the alert is recorded only once a change has
 * held. The row must say what the alerting side last recorded and any change
 * it is waiting out, so an alert beside a card reading Healthy is explained on
 * the same screen. The hold itself is set on the event trigger step of a
 * capacity automation (automationsWizardDom.test.ts), so here it is only named.
 *
 * Functions are sliced out of the browser script by name and eval'd with the
 * app-shell globals stubbed — the approach of capacityAdvisorRestartDom.test.ts.
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
  // eslint-disable-next-line no-eval
  render = eval(`(function () {
    ${FN_NAMES.map(fnSrc).join("\n")}
    return renderCapacityAlertHoldHtml;
  })()`);
});

const base = { recorded: { severity: "ok", recordedAt: "2026-10-12T10:00:00Z" }, pending: null, holdMinutes: 30, intervalMinutes: 10 };

describe("capacity alert-hold row", () => {
  it("renders nothing when the server sent no transition state", () => {
    expect(render(null)).toBe("");
  });

  it("names the hold, points at Automations, and names the recorded severity", () => {
    document.body.innerHTML = render(base);
    // Read-only here: the control lives on the automation's trigger step.
    expect(document.querySelector("select")).toBeNull();
    const rule = document.getElementById("capacity-alert-hold-rule")!;
    expect(rule.textContent).toContain("Capacity alerts fire after a change holds for 30 minutes.");
    expect(rule.querySelector("a")!.getAttribute("href")).toBe("/automations.html");
    expect(document.getElementById("capacity-alert-hold-status")!.textContent)
      .toBe("Alerting last recorded Healthy at 2026-10-12T10:00:00Z.");
  });

  it("words a zero hold and an hour-multiple hold naturally", () => {
    document.body.innerHTML = render({ ...base, holdMinutes: 0 });
    expect(document.getElementById("capacity-alert-hold-rule")!.textContent)
      .toContain("Capacity alerts fire on the first reading.");
    document.body.innerHTML = render({ ...base, holdMinutes: 120 });
    expect(document.getElementById("capacity-alert-hold-rule")!.textContent)
      .toContain("after a change holds for 2 hours.");
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
