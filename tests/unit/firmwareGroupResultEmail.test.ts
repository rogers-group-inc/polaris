/**
 * tests/unit/firmwareGroupResultEmail.test.ts
 *
 * The group firmware upgrade summary email (business rule 122): counts,
 * problems first (failed with stage, unverified, health skips with what was
 * wrong, upstream skips naming the device behind), then upgraded and dropped;
 * missed / stopped headlines; HTML escaping.
 */

import { describe, it, expect } from "vitest";
import { renderFirmwareGroupResultEmail, countGroupMembers, groupEmailSections, type GroupEmailMember } from "../../src/utils/firmwareGroupResultEmailTemplate.js";

function mem(name: string, state: GroupEmailMember["state"], extra: Partial<GroupEmailMember> = {}): GroupEmailMember {
  return { assetId: `id-${name}`, deviceName: name, assetType: "switch", model: null, state, skipKind: null, detail: null, stage: null, fromVersion: "7.4.3", toVersion: "7.6.8", verifiedVersion: null, ...extra };
}

const members: GroupEmailMember[] = [
  mem("ap-1", "failed", { assetType: "access_point", stage: "rebooting", detail: "device did not come back" }),
  mem("ap-2", "skipped", { assetType: "access_point", skipKind: "health", detail: "the device is down" }),
  mem("ap-3", "unverified", { assetType: "access_point", detail: "version unreadable" }),
  mem("sw-1", "skipped", { skipKind: "subtree", detail: "ap-1, behind it, failed" }),
  mem("sw-2", "upgraded", { verifiedVersion: "7.6.8" }),
  mem("sw-3", "dropped", { detail: "No Repository image is newer than 7.6.8." }),
  mem("<b>gate</b>", "skipped", { assetType: "firewall", skipKind: "subtree", detail: "sw-1, behind it, was skipped (subtree)" }),
];

const base = { gateAssetId: "gate-1", gateName: "FGT-HQ", scheduledFor: "2026-10-17T02:00:00Z", startedAt: "2026-10-17T02:00:30Z", finishedAt: "2026-10-17T03:10:00Z", scheduledBy: "alice", cancelledBy: null, zone: "UTC" };

describe("group summary email", () => {
  it("counts each outcome", () => {
    expect(countGroupMembers(members)).toEqual({ upgraded: 1, alreadyCurrent: 0, failed: 1, unverified: 1, skippedHealth: 1, skippedUpstream: 2, skippedOther: 0, dropped: 1 });
  });

  it("lists problems first, then upgraded, then dropped", () => {
    expect(groupEmailSections(members).map((s) => s.title)).toEqual([
      "Failed",
      "Unverified — check the device",
      "Skipped — health",
      "Skipped — upstream of a device that did not finish cleanly",
      "Upgraded",
      "Dropped from the schedule",
    ]);
  });

  it("text names each device with its reason", () => {
    const r = renderFirmwareGroupResultEmail({ outcome: "completed", members, ...base });
    expect(r.subject).toBe("[Polaris] Group firmware upgrade finished — 1 FAILED: FGT-HQ (1 of 6 upgraded)");
    expect(r.text).toContain("ap-1 (FortiAP): rebooting: device did not come back");
    expect(r.text).toContain("ap-2 (FortiAP): the device is down");
    expect(r.text).toContain("sw-1 (FortiSwitch): ap-1, behind it, failed");
    expect(r.text).toContain("sw-2 (FortiSwitch): 7.4.3 → 7.6.8");
    expect(r.text).toContain("sw-3 (FortiSwitch): No Repository image is newer than 7.6.8.");
    expect(r.text).toContain("{brand.header}");
  });

  it("escapes device names in HTML", () => {
    const r = renderFirmwareGroupResultEmail({ outcome: "completed", members, ...base });
    expect(r.html).toContain("&lt;b&gt;gate&lt;/b&gt;");
    expect(r.html).not.toContain("<b>gate</b>");
  });

  it("a clean run reads as success; missed and stopped say so", () => {
    const ok = renderFirmwareGroupResultEmail({ outcome: "completed", members: [mem("sw-2", "upgraded")], ...base });
    expect(ok.subject).toMatch(/succeeded/);
    const missed = renderFirmwareGroupResultEmail({ outcome: "missed", members: [mem("sw-2", "skipped", { skipKind: "cancelled", detail: "the group was missed" })], ...base, startedAt: null });
    expect(missed.subject).toMatch(/was missed/);
    expect(missed.text).toMatch(/Nothing was sent to any device/);
    const stopped = renderFirmwareGroupResultEmail({ outcome: "cancelled", members: [mem("sw-2", "upgraded"), mem("sw-4", "skipped", { skipKind: "cancelled", detail: "stopped by bob" })], ...base, cancelledBy: "bob" });
    expect(stopped.subject).toMatch(/was stopped/);
    expect(stopped.text).toMatch(/stopped by bob/);
    expect(stopped.text).toMatch(/NOT STARTED \(1\)/);
  });
});
