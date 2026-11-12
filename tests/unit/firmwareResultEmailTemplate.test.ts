/**
 * tests/unit/firmwareResultEmailTemplate.test.ts
 *
 * Business rule 93: the firmware notice / result email. The golden test pins
 * whole bodies and firmwareEmailService.test.ts the sending; this pins each
 * outcome's subject and summary, the already-current wording, the version
 * facts, the warning line and the link degradation.
 */

import { describe, it, expect, afterEach } from "vitest";
import { renderFirmwareResultEmail, type FirmwareResultEmailInput } from "../../src/utils/firmwareResultEmailTemplate.js";

const savedUrl = process.env.POLARIS_PUBLIC_URL;
afterEach(() => {
  if (savedUrl === undefined) delete process.env.POLARIS_PUBLIC_URL; else process.env.POLARIS_PUBLIC_URL = savedUrl;
});

const base = (over: Partial<FirmwareResultEmailInput> = {}): FirmwareResultEmailInput => ({
  outcome: "succeeded",
  assetId: "asset-1",
  deviceName: "AP-1",
  model: "FAP-431F",
  fromVersion: "7.4.3",
  toVersion: "7.6.8",
  verifiedVersion: "7.6.8",
  result: "upgraded",
  error: null,
  scheduledFor: "2026-07-01T02:00:00Z",
  startedAt: "2026-07-01T02:00:00Z",
  finishedAt: "2026-07-01T02:10:00Z",
  scheduledBy: "alice",
  log: [],
  zone: "UTC",
  ...over,
});

describe("renderFirmwareResultEmail — subjects", () => {
  it.each([
    ["succeeded", "[Polaris] Scheduled firmware upgrade succeeded: AP-1 → 7.6.8"],
    ["unverified", "[Polaris] Scheduled firmware upgrade finished unverified: AP-1 → 7.6.8"],
    ["failed", "[Polaris] Scheduled firmware upgrade FAILED: AP-1 → 7.6.8"],
    ["refused", "[Polaris] Scheduled firmware upgrade was not started: AP-1 → 7.6.8"],
    ["missed", "[Polaris] Scheduled firmware upgrade was missed: AP-1 → 7.6.8"],
    ["started", "[Polaris] Scheduled firmware upgrade started: AP-1 → 7.6.8"],
  ] as const)("%s", (outcome, subject) => {
    expect(renderFirmwareResultEmail(base({ outcome })).subject).toBe(subject);
  });

  it("a flash started now reads 'Firmware upgrade'", () => {
    expect(renderFirmwareResultEmail(base({ scheduled: false })).subject).toBe("[Polaris] Firmware upgrade succeeded: AP-1 → 7.6.8");
  });

  it("scheduled / rescheduled carry the booked time when present", () => {
    expect(renderFirmwareResultEmail(base({ outcome: "scheduled" })).subject).toMatch(/^\[Polaris\] Firmware upgrade scheduled for .+: AP-1 → 7\.6\.8$/);
    expect(renderFirmwareResultEmail(base({ outcome: "rescheduled", scheduledFor: null })).subject).toBe("[Polaris] Firmware upgrade rescheduled: AP-1 → 7.6.8");
  });
});

describe("renderFirmwareResultEmail — summaries", () => {
  it("succeeded reports what the device says, or the target when it said nothing", () => {
    expect(renderFirmwareResultEmail(base()).text).toContain("The device came back and reports 7.6.8.");
    expect(renderFirmwareResultEmail(base({ verifiedVersion: null })).text).toContain("reports 7.6.8.");
  });

  it("already-current says nothing was flashed", () => {
    expect(renderFirmwareResultEmail(base({ result: "already-current", verifiedVersion: "7.6.9" })).text)
      .toContain("The device was already running 7.6.9; nothing was flashed.");
  });

  it("failed warns a partial flash can brick the device", () => {
    const t = renderFirmwareResultEmail(base({ outcome: "failed", error: "TFTP timeout", verifiedVersion: null })).text;
    expect(t).toContain("The upgrade failed: TFTP timeout A flash that fails partway can leave a device unbootable");
  });

  it("unverified, refused and missed with and without an error", () => {
    expect(renderFirmwareResultEmail(base({ outcome: "unverified" })).text).toContain("its new version could not be confirmed. Check the device.");
    expect(renderFirmwareResultEmail(base({ outcome: "refused" })).text).toContain("Polaris did not start the upgrade. Nothing was sent");
    expect(renderFirmwareResultEmail(base({ outcome: "missed" })).text).toContain("Polaris was not running at the scheduled time. Nothing was sent");
  });

  it("a scheduled notice names the target and today's blockers", () => {
    const t = renderFirmwareResultEmail(base({ outcome: "scheduled", warnings: ["the AP is down", "a hold is active"] })).text;
    expect(t).toContain("The upgrade to 7.6.8 is booked for");
    expect(t).toContain("Right now the AP is down; a hold is active.");
    expect(t).toContain("when the upgrade is due");
  });
});

describe("renderFirmwareResultEmail — facts and link", () => {
  it("shows from → to, falling back to 'unknown', and the reported version", () => {
    expect(renderFirmwareResultEmail(base()).text).toContain("7.4.3 → 7.6.8");
    expect(renderFirmwareResultEmail(base({ fromVersion: null })).text).toContain("unknown → 7.6.8");
    expect(renderFirmwareResultEmail(base({ verifiedVersion: null })).text).not.toContain("Device reports");
  });

  it("a negative or half-known span has no duration", () => {
    expect(renderFirmwareResultEmail(base({ finishedAt: "2026-07-01T01:00:00Z" })).text).not.toContain("Duration");
    expect(renderFirmwareResultEmail(base({ finishedAt: null })).text).not.toContain("Duration");
  });

  it("links the device only when POLARIS_PUBLIC_URL is set", () => {
    delete process.env.POLARIS_PUBLIC_URL;
    expect(renderFirmwareResultEmail(base()).html).not.toContain("href=");
    process.env.POLARIS_PUBLIC_URL = "https://polaris.example";
    expect(renderFirmwareResultEmail(base()).html).toContain('href="https://polaris.example/');
  });

  it("leaves the letterhead placeholder for applyBrandLetterhead", () => {
    const r = renderFirmwareResultEmail(base());
    expect(r.text).toContain("{brand.header}");
    expect(r.html).toContain("{brand.header}");
  });
});
