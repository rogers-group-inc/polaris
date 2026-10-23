/**
 * tests/unit/capacityAlertHoldDom.test.ts — the alert-hold row on the
 * Maintenance tab's Database card (public/js/server-settings.js). Business
 * rule 105.
 *
 * The card grades capacity live; the alert is recorded only once a change has
 * held. The row must say what the alerting side last recorded and any change
 * it is waiting out, so an alert beside a card reading Healthy is explained on
 * the same screen. The hold itself is set on the event trigger step of a
 * capacity automation (automationsWizardDom.test.ts); the card does not restate it.
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

const FN_NAMES = ["_capacitySeverityLabel", "_capacityAlertHoldStatus", "renderCapacityAlertHoldHtml", "_capacityAllPassedHtml"];

let render: (t: any) => string;
let renderAllPassed: (computedAt: string | null, t: any) => string;

beforeEach(() => {
  g.escapeHtml = (s: any) =>
    String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  g.formatLocalTime = (s: string) => String(s);
  // eslint-disable-next-line no-eval
  [render, renderAllPassed] = eval(`(function () {
    ${FN_NAMES.map(fnSrc).join("\n")}
    return [renderCapacityAlertHoldHtml, _capacityAllPassedHtml];
  })()`);
});

const base = { recorded: { severity: "ok", recordedAt: "2026-10-12T10:00:00Z" }, pending: null, holdMinutes: 30, intervalMinutes: 10 };

describe("capacity alert-hold row", () => {
  it("renders nothing when the server sent no transition state", () => {
    expect(render(null)).toBe("");
  });

  it("renders nothing when there is neither a recorded nor a pending state", () => {
    expect(render({ ...base, recorded: null })).toBe("");
  });

  it("names the recorded severity and does not restate the hold", () => {
    document.body.innerHTML = render(base);
    // Read-only here: the control lives on the automation's trigger step.
    expect(document.querySelector("select")).toBeNull();
    expect(document.body.textContent).not.toContain("Capacity alerts fire");
    expect(document.querySelector("a")).toBeNull();
    expect(document.getElementById("capacity-alert-hold-status")!.textContent)
      .toBe("Alerting has recorded Healthy since 2026-10-12T10:00:00Z.");
  });

  it("folds the alerting state into the all-checks-passed row as one line", () => {
    document.body.innerHTML = renderAllPassed("2026-10-23T11:21:41Z", base);
    expect(document.querySelectorAll(".capacity-reason")).toHaveLength(1);
    expect(document.querySelector(".capacity-alert-hold")).toBeNull();
    expect(document.querySelector(".capacity-reason-msg")!.textContent)
      .toBe("All capacity checks passed at 2026-10-23T11:21:41Z. Alerting has recorded Healthy since 2026-10-12T10:00:00Z.");
  });

  it("leaves the all-checks-passed row alone when there is no alerting state", () => {
    document.body.innerHTML = renderAllPassed("2026-10-23T11:21:41Z", null);
    expect(document.querySelector(".capacity-reason-msg")!.textContent)
      .toBe("All capacity checks passed at 2026-10-23T11:21:41Z.");
    expect(document.getElementById("capacity-alert-hold-status")).toBeNull();
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
