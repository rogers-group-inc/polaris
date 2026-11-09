/**
 * tests/unit/operationResultEmailGolden.test.ts — the firmware (rule 93) and
 * reboot (rule 115) operation emails, pinned byte for byte.
 *
 * `tests/fixtures/operationResultEmails.golden.json` holds the subject, text
 * and HTML each template rendered for every case below BEFORE the two
 * templates were moved onto the shared layout (`operationResultEmailLayout`,
 * CQ-B033). A change to what an email says is a deliberate act: regenerate
 * the file with `WRITE_GOLDEN=1 npx vitest run tests/unit/operationResultEmailGolden.test.ts`
 * and review its diff.
 */

import { describe, it, expect, afterEach, vi } from "vitest";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { renderFirmwareResultEmail, type FirmwareResultEmailInput } from "../../src/utils/firmwareResultEmailTemplate.js";
import { renderRebootResultEmail, type RebootResultEmailInput } from "../../src/utils/rebootResultEmailTemplate.js";

const GOLDEN = fileURLToPath(new URL("../fixtures/operationResultEmails.golden.json", import.meta.url));

const LONG_LOG = Array.from({ length: 18 }, (_, i) => ({
  t: new Date(Date.UTC(2026, 10, 9, 14, i, 5)).toISOString(),
  level: i % 5 === 0 ? "warn" : "info",
  msg: `step ${i} <ok> & "quoted"`,
}));

type Case<T> = { name: string; publicUrl: string | null; input: T };

const fwBase: FirmwareResultEmailInput = {
  outcome: "succeeded",
  assetId: "asset-1",
  deviceName: "FS-<core>&1",
  model: "FS-148F",
  fromVersion: "7.4.3",
  toVersion: "7.4.5",
  verifiedVersion: "7.4.5",
  result: "upgraded",
  error: null,
  scheduledFor: new Date(Date.UTC(2026, 10, 9, 14, 0, 0)),
  startedAt: new Date(Date.UTC(2026, 10, 9, 14, 0, 30)),
  finishedAt: new Date(Date.UTC(2026, 10, 9, 14, 12, 45)),
  scheduledBy: "alice@example.com",
  log: LONG_LOG,
  zone: "America/Chicago",
};

const firmwareCases: Array<Case<FirmwareResultEmailInput>> = [
  { name: "fw succeeded booked, url", publicUrl: "https://polaris.example.com/", input: fwBase },
  { name: "fw succeeded booked, no url", publicUrl: null, input: fwBase },
  { name: "fw succeeded already-current, no model, short log", publicUrl: "https://polaris.example.com", input: { ...fwBase, result: "already-current", model: null, fromVersion: null, verifiedVersion: null, log: LONG_LOG.slice(0, 3) } },
  { name: "fw succeeded started now", publicUrl: "https://polaris.example.com", input: { ...fwBase, scheduled: false, scheduledFor: null } },
  { name: "fw unverified with error", publicUrl: "https://polaris.example.com", input: { ...fwBase, outcome: "unverified", verifiedVersion: null, error: "version read <timed out>" } },
  { name: "fw unverified no error, started now", publicUrl: null, input: { ...fwBase, outcome: "unverified", scheduled: false, scheduledFor: null, verifiedVersion: null } },
  { name: "fw failed with error", publicUrl: "https://polaris.example.com", input: { ...fwBase, outcome: "failed", verifiedVersion: null, error: "upload rejected: image & signature" } },
  { name: "fw failed no error, no finish", publicUrl: null, input: { ...fwBase, outcome: "failed", verifiedVersion: null, finishedAt: null } },
  { name: "fw failed negative duration", publicUrl: null, input: { ...fwBase, outcome: "failed", finishedAt: new Date(Date.UTC(2026, 10, 9, 13, 0, 0)) } },
  { name: "fw refused", publicUrl: "https://polaris.example.com", input: { ...fwBase, outcome: "refused", verifiedVersion: null, result: null, error: "HA standby", startedAt: null, finishedAt: null, log: [] } },
  { name: "fw refused no error", publicUrl: null, input: { ...fwBase, outcome: "refused", verifiedVersion: null, result: null, startedAt: null, finishedAt: null, log: [] } },
  { name: "fw missed with error", publicUrl: "https://polaris.example.com", input: { ...fwBase, outcome: "missed", verifiedVersion: null, result: null, error: "Polaris was down for 40 min.", startedAt: null, finishedAt: null, log: [] } },
  { name: "fw missed no error", publicUrl: null, input: { ...fwBase, outcome: "missed", verifiedVersion: null, result: null, startedAt: null, finishedAt: null, log: [] } },
  { name: "fw scheduled with warnings", publicUrl: "https://polaris.example.com", input: { ...fwBase, outcome: "scheduled", verifiedVersion: null, result: null, startedAt: null, finishedAt: null, log: [], warnings: ["the device is down", "a <relative> is flashing"] } },
  { name: "fw scheduled no warnings, string date", publicUrl: null, input: { ...fwBase, outcome: "scheduled", verifiedVersion: null, result: null, startedAt: null, finishedAt: null, log: [], scheduledFor: "2026-12-01T03:30:00.000Z" } },
  { name: "fw scheduled no time", publicUrl: null, input: { ...fwBase, outcome: "scheduled", verifiedVersion: null, result: null, startedAt: null, finishedAt: null, log: [], scheduledFor: null } },
  { name: "fw rescheduled with warnings", publicUrl: "https://polaris.example.com", input: { ...fwBase, outcome: "rescheduled", verifiedVersion: null, result: null, startedAt: null, finishedAt: null, log: [], warnings: ["the device is down"] } },
  { name: "fw started booked", publicUrl: "https://polaris.example.com", input: { ...fwBase, outcome: "started", verifiedVersion: null, result: null, finishedAt: null, log: [], warnings: ["ignored on started"] } },
  { name: "fw started now", publicUrl: null, input: { ...fwBase, outcome: "started", scheduled: false, scheduledFor: null, verifiedVersion: null, result: null, finishedAt: null, log: [] } },
  { name: "fw succeeded UTC zone", publicUrl: "https://polaris.example.com", input: { ...fwBase, zone: "UTC" } },
];

const rbBase: RebootResultEmailInput = {
  outcome: "succeeded",
  assetId: "asset-2",
  deviceName: "AP-<lobby>&2",
  model: "FAP-431F",
  method: "through the controlling FortiGate (managed FortiAP restart)",
  authority: "FortiGate <HQ> integration",
  error: null,
  scheduledFor: new Date(Date.UTC(2026, 10, 9, 2, 0, 0)),
  startedAt: new Date(Date.UTC(2026, 10, 9, 2, 0, 20)),
  finishedAt: new Date(Date.UTC(2026, 10, 9, 2, 6, 2)),
  scheduledBy: "bob@example.com",
  note: "Clearing a <stuck> radio & retry",
  log: LONG_LOG,
  zone: "America/New_York",
};

const rebootCases: Array<Case<RebootResultEmailInput>> = [
  { name: "rb succeeded booked, url", publicUrl: "https://polaris.example.com", input: rbBase },
  { name: "rb succeeded booked, no url", publicUrl: null, input: rbBase },
  { name: "rb succeeded no note, no model, short log", publicUrl: "https://polaris.example.com", input: { ...rbBase, note: null, model: null, log: LONG_LOG.slice(0, 2) } },
  { name: "rb succeeded started now", publicUrl: "https://polaris.example.com", input: { ...rbBase, scheduled: false, scheduledFor: null } },
  { name: "rb unverified with error", publicUrl: "https://polaris.example.com", input: { ...rbBase, outcome: "unverified", error: "uptime unreadable" } },
  { name: "rb unverified no error", publicUrl: null, input: { ...rbBase, outcome: "unverified" } },
  { name: "rb failed with error", publicUrl: "https://polaris.example.com", input: { ...rbBase, outcome: "failed", error: "did not come back <15 min>" } },
  { name: "rb failed no error, no finish, now", publicUrl: null, input: { ...rbBase, outcome: "failed", scheduled: false, scheduledFor: null, finishedAt: null } },
  { name: "rb refused", publicUrl: "https://polaris.example.com", input: { ...rbBase, outcome: "refused", method: null, authority: null, error: "no opt-in", startedAt: null, finishedAt: null, log: [] } },
  { name: "rb refused no error", publicUrl: null, input: { ...rbBase, outcome: "refused", method: null, authority: null, startedAt: null, finishedAt: null, log: [] } },
  { name: "rb missed with error", publicUrl: null, input: { ...rbBase, outcome: "missed", method: null, authority: null, error: "Polaris was down.", startedAt: null, finishedAt: null, log: [] } },
  { name: "rb missed no error", publicUrl: "https://polaris.example.com", input: { ...rbBase, outcome: "missed", method: null, authority: null, startedAt: null, finishedAt: null, log: [] } },
  { name: "rb scheduled with warnings", publicUrl: "https://polaris.example.com", input: { ...rbBase, outcome: "scheduled", method: null, authority: null, startedAt: null, finishedAt: null, log: [], warnings: ["the agent is offline", "an <HA> gate"] } },
  { name: "rb scheduled no warnings, no time", publicUrl: null, input: { ...rbBase, outcome: "scheduled", method: null, authority: null, startedAt: null, finishedAt: null, log: [], scheduledFor: null, note: undefined } },
  { name: "rb rescheduled", publicUrl: "https://polaris.example.com", input: { ...rbBase, outcome: "rescheduled", method: null, authority: null, startedAt: null, finishedAt: null, log: [], scheduledFor: "2026-12-24T23:00:00.000Z", warnings: [] } },
  { name: "rb started booked", publicUrl: "https://polaris.example.com", input: { ...rbBase, outcome: "started", finishedAt: null, log: [], warnings: ["ignored on started"] } },
  { name: "rb started now", publicUrl: null, input: { ...rbBase, outcome: "started", scheduled: false, scheduledFor: null, finishedAt: null, log: [] } },
];

function renderAll(): Record<string, { subject: string; text: string; html: string }> {
  const out: Record<string, { subject: string; text: string; html: string }> = {};
  const run = <T>(cases: Array<Case<T>>, render: (i: T) => { subject: string; text: string; html: string }) => {
    for (const c of cases) {
      if (c.publicUrl) vi.stubEnv("POLARIS_PUBLIC_URL", c.publicUrl);
      else vi.stubEnv("POLARIS_PUBLIC_URL", "");
      out[c.name] = render(c.input);
    }
  };
  run(firmwareCases, renderFirmwareResultEmail);
  run(rebootCases, renderRebootResultEmail);
  return out;
}

describe("operation result emails — golden output (CQ-B033)", () => {
  afterEach(() => { vi.unstubAllEnvs(); });

  it("every case renders exactly what it rendered before the shared layout", () => {
    const rendered = renderAll();
    if (process.env.WRITE_GOLDEN === "1" || !existsSync(GOLDEN)) {
      writeFileSync(GOLDEN, JSON.stringify(rendered, null, 2) + "\n", "utf8");
      if (process.env.WRITE_GOLDEN !== "1") throw new Error(`golden file was missing; wrote ${GOLDEN} — review and commit it`);
    }
    const golden = JSON.parse(readFileSync(GOLDEN, "utf8")) as typeof rendered;
    expect(Object.keys(rendered).sort()).toEqual(Object.keys(golden).sort());
    for (const name of Object.keys(golden)) {
      expect(rendered[name].subject, `${name} subject`).toBe(golden[name].subject);
      expect(rendered[name].text, `${name} text`).toBe(golden[name].text);
      expect(rendered[name].html, `${name} html`).toBe(golden[name].html);
    }
  });
});
