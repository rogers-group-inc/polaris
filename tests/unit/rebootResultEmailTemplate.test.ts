/**
 * tests/unit/rebootResultEmailTemplate.test.ts
 *
 * Business rule 115 (rule-93 shape): the reboot notice / result email.
 * operationResultEmailGolden.test.ts pins the full bodies and rebootNote
 * .test.ts the Reason line; this pins every outcome's subject and summary,
 * the booked-vs-started-now wording, the facts, the warning line and the
 * link degrading when POLARIS_PUBLIC_URL is unset.
 */

import { describe, it, expect, afterEach } from "vitest";
import { renderRebootResultEmail, type RebootResultEmailInput } from "../../src/utils/rebootResultEmailTemplate.js";

const savedUrl = process.env.POLARIS_PUBLIC_URL;
afterEach(() => {
  if (savedUrl === undefined) delete process.env.POLARIS_PUBLIC_URL; else process.env.POLARIS_PUBLIC_URL = savedUrl;
});

const base = (over: Partial<RebootResultEmailInput> = {}): RebootResultEmailInput => ({
  outcome: "succeeded",
  assetId: "asset-1",
  deviceName: "SW-CORE",
  model: "FS-448E",
  method: "through FortiGate HQ",
  authority: "FGT-HQ admin token",
  error: null,
  scheduledFor: "2026-07-01T02:00:00Z",
  startedAt: "2026-07-01T02:00:05Z",
  finishedAt: "2026-07-01T02:04:05Z",
  scheduledBy: "alice",
  log: [],
  zone: "UTC",
  ...over,
});

describe("renderRebootResultEmail — subjects", () => {
  it.each([
    ["succeeded", "[Polaris] Scheduled reboot succeeded: SW-CORE"],
    ["unverified", "[Polaris] Scheduled reboot finished unverified: SW-CORE"],
    ["failed", "[Polaris] Scheduled reboot FAILED: SW-CORE"],
    ["refused", "[Polaris] Scheduled reboot was not started: SW-CORE"],
    ["missed", "[Polaris] Scheduled reboot was missed: SW-CORE"],
    ["started", "[Polaris] Scheduled reboot started: SW-CORE"],
  ] as const)("%s", (outcome, subject) => {
    expect(renderRebootResultEmail(base({ outcome })).subject).toBe(subject);
  });

  it("a reboot started now reads 'Reboot', not 'Scheduled reboot'", () => {
    expect(renderRebootResultEmail(base({ outcome: "failed", scheduled: false })).subject).toBe("[Polaris] Reboot FAILED: SW-CORE");
  });

  it("scheduled / rescheduled name the booked time when there is one", () => {
    expect(renderRebootResultEmail(base({ outcome: "scheduled" })).subject).toMatch(/^\[Polaris\] Reboot scheduled for .+2026.*: SW-CORE$/);
    expect(renderRebootResultEmail(base({ outcome: "rescheduled", scheduledFor: null })).subject).toBe("[Polaris] Reboot rescheduled: SW-CORE");
  });
});

describe("renderRebootResultEmail — summaries", () => {
  it("states the error when there is one, and a clean sentence when not", () => {
    expect(renderRebootResultEmail(base({ outcome: "failed", error: "timeout" })).text).toContain("The reboot failed: timeout Check the device.");
    expect(renderRebootResultEmail(base({ outcome: "failed" })).text).toContain("The reboot failed. Check the device.");
    expect(renderRebootResultEmail(base({ outcome: "unverified", error: "no uptime" })).text).toContain("could not confirm it happened (no uptime)");
    expect(renderRebootResultEmail(base({ outcome: "refused", error: "device is down" })).text).toContain("Polaris did not start the reboot: device is down Nothing was sent");
  });

  it("missed uses the error as the whole reason, with a default", () => {
    expect(renderRebootResultEmail(base({ outcome: "missed" })).text).toContain("Polaris was not running at the scheduled time. Nothing was sent to the device.");
    expect(renderRebootResultEmail(base({ outcome: "missed", error: "Booking too old." })).text).toContain("Booking too old. Nothing was sent to the device.");
  });

  it("a rescheduled notice says 'now booked'; with no time it says 'later'", () => {
    expect(renderRebootResultEmail(base({ outcome: "rescheduled" })).text).toContain("The reboot is now booked for");
    expect(renderRebootResultEmail(base({ outcome: "scheduled", scheduledFor: null })).text).toContain("The reboot is booked for later.");
  });

  it("carries today's blockers only on a scheduled / rescheduled notice", () => {
    const warn = ["the device is down"];
    expect(renderRebootResultEmail(base({ outcome: "scheduled", warnings: warn })).text).toContain("Right now the device is down.");
    expect(renderRebootResultEmail(base({ outcome: "succeeded", warnings: warn })).text).not.toContain("Right now");
  });
});

describe("renderRebootResultEmail — facts and link", () => {
  it("lists the sent method, authority, times, duration and booker", () => {
    const t = renderRebootResultEmail(base()).text;
    expect(t).toContain("SW-CORE (FS-448E)");
    expect(t).toContain("through FortiGate HQ");
    expect(t).toContain("FGT-HQ admin token");
    expect(t).toMatch(/Scheduled by\W+alice/);
    expect(t).toMatch(/Duration\W+4m/);
  });

  it("omits what was never sent and says 'Started by' for a reboot started now", () => {
    const t = renderRebootResultEmail(base({ scheduled: false, method: null, authority: null, scheduledFor: null, model: null })).text;
    expect(t).not.toContain("Signed by");
    expect(t).not.toContain("Scheduled for");
    expect(t).toMatch(/Started by\W+alice/);
    expect(t).not.toContain("SW-CORE (");
  });

  it("links the device only when POLARIS_PUBLIC_URL is set", () => {
    delete process.env.POLARIS_PUBLIC_URL;
    expect(renderRebootResultEmail(base()).html).not.toContain("href=");
    process.env.POLARIS_PUBLIC_URL = "https://polaris.example/";
    expect(renderRebootResultEmail(base()).html).toContain('href="https://polaris.example/');
  });

  it("escapes the device name in the HTML", () => {
    const h = renderRebootResultEmail(base({ deviceName: "<img src=x>" })).html;
    expect(h).not.toContain("<img src=x>");
    expect(h).toContain("&lt;img src=x&gt;");
  });
});
