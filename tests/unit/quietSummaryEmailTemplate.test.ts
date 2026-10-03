/**
 * tests/unit/quietSummaryEmailTemplate.test.ts — the quiet-time summary email
 * (business rule 92), rendered for one reader in one zone. Pins what the
 * operator asked for: a LIST, no graphs and no acknowledge button, a device link
 * per row that degrades to a name without POLARIS_PUBLIC_URL, the recurring
 * section with its count and every fire time, and the subject that says how
 * much is outstanding.
 */

import { describe, it, expect, afterEach } from "vitest";
import { renderQuietSummaryEmail, quietSummarySubject } from "../../src/utils/quietSummaryEmailTemplate.js";

const at = (y: number, m: number, d: number, hh = 0, mm = 0) => new Date(Date.UTC(y, m - 1, d, hh, mm));

const OUTSTANDING = [{
  notificationId: "n1", severity: "serious", assetId: "a1", assetHostname: "sw-1", ruleName: "Port down",
  message: "port12 is down", dimension: "port12", triggeredAt: at(2026, 10, 3, 2, 0).toISOString(),
}];
const RECURRING = [{
  assetId: "a2", assetHostname: "ap-7", ruleName: "AP flapping", dimension: null, severity: "warning", count: 3,
  times: [at(2026, 10, 3, 1, 0), at(2026, 10, 3, 2, 0), at(2026, 10, 3, 3, 0)].map((x) => x.toISOString()), stillActive: false,
}];

function render(over: Partial<Parameters<typeof renderQuietSummaryEmail>[0]> = {}) {
  return renderQuietSummaryEmail({
    sourceName: "Nights", sourceKind: "global", coveredFrom: at(2026, 10, 2, 22, 0), coveredTo: at(2026, 10, 3, 6, 0),
    zone: "UTC", outstanding: OUTSTANDING, recurring: RECURRING, recurrenceThreshold: 2, now: at(2026, 10, 3, 6, 0), ...over,
  });
}

afterEach(() => { delete process.env.POLARIS_PUBLIC_URL; });

describe("quietSummarySubject", () => {
  it("counts what is outstanding and what recurred", () => {
    expect(quietSummarySubject({ sourceName: "Nights", outstanding: OUTSTANDING, recurring: RECURRING })).toBe("[QUIET TIME SUMMARY] 1 outstanding · 1 recurring · Nights");
    expect(quietSummarySubject({ sourceName: "Nights", outstanding: [], recurring: [] })).toBe("[QUIET TIME SUMMARY] nothing outstanding · Nights");
  });
});

describe("renderQuietSummaryEmail", () => {
  it("lists the outstanding alert with its age and the recurring one with every time, in the reader's zone", () => {
    const r = render({ zone: "America/Chicago" });
    expect(r.text).toContain("STILL OUTSTANDING (1)");
    expect(r.text).toContain("SERIOUS · sw-1 · port12 — port12 is down");
    expect(r.text).toContain("(4h)");
    expect(r.text).toContain("RECURRING (1) — fired more than 2 times during the quiet period");
    expect(r.text).toContain("ap-7 — AP flapping: 3 times, recovered");
    expect(r.text).toContain("Times are shown in America/Chicago");
    // 02:00 UTC is 21:00 the evening before in Chicago.
    expect(r.html).toContain("9:00 PM");
    expect(r.html).toContain("Still outstanding (1)");
    expect(r.html).toContain("Recurring (1)");
    expect(r.html).toContain("<strong>3</strong> times");
    expect(r.html).toContain("{brand.header}");
  });

  it("links each device when the public URL is set, and names it otherwise", () => {
    process.env.POLARIS_PUBLIC_URL = "https://polaris.example.com/";
    const linked = render();
    expect(linked.html).toContain('href="https://polaris.example.com/assets/a1"');
    expect(linked.text).toContain("https://polaris.example.com/assets/a1");
    delete process.env.POLARIS_PUBLIC_URL;
    const bare = render();
    expect(bare.html).not.toContain("href=");
    expect(bare.html).toContain("sw-1");
  });

  it("carries no graphs and no acknowledge button, and escapes the alert text", () => {
    const r = render({ outstanding: [{ ...OUTSTANDING[0]!, message: "<b>down</b>" }] });
    expect(r.html).not.toContain("cid:");
    expect(r.html).not.toContain("Acknowledge");
    expect(r.html).toContain("&lt;b&gt;down&lt;/b&gt;");
  });

  it("says so when nothing is outstanding and nothing recurred", () => {
    const r = render({ outstanding: [], recurring: [] });
    expect(r.text).toContain("Nothing is outstanding");
    expect(r.html).toContain("Nothing is outstanding");
  });
});
