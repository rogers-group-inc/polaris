/**
 * tests/unit/firmwareGroupResultEmailTemplate.test.ts
 *
 * Business rule 122: the group firmware summary email. firmwareGroupResult
 * Email.test.ts covers the counts, section order, failure/missed/stopped
 * headlines and escaping; this pins the remaining branches — the warnings
 * subject, "not started" and "already current" sections, the per-section
 * fallback notes, the type labels, duration and links.
 */

import { describe, it, expect, afterEach } from "vitest";
import {
  renderFirmwareGroupResultEmail,
  countGroupMembers,
  groupEmailSections,
  type GroupEmailMember,
  type FirmwareGroupResultEmailInput,
} from "../../src/utils/firmwareGroupResultEmailTemplate.js";

const savedUrl = process.env.POLARIS_PUBLIC_URL;
afterEach(() => {
  if (savedUrl === undefined) delete process.env.POLARIS_PUBLIC_URL; else process.env.POLARIS_PUBLIC_URL = savedUrl;
});

function mem(name: string, state: GroupEmailMember["state"], extra: Partial<GroupEmailMember> = {}): GroupEmailMember {
  return { assetId: `id-${name}`, deviceName: name, assetType: "switch", model: null, state, skipKind: null, detail: null, stage: null, fromVersion: "7.4.3", toVersion: "7.6.8", verifiedVersion: null, ...extra };
}

const input = (members: GroupEmailMember[], over: Partial<FirmwareGroupResultEmailInput> = {}): FirmwareGroupResultEmailInput => ({
  outcome: "completed",
  gateAssetId: "gate-1",
  gateName: "FGT-HQ",
  scheduledFor: "2026-10-17T02:00:00Z",
  startedAt: "2026-10-17T02:00:00Z",
  finishedAt: "2026-10-17T02:30:00Z",
  scheduledBy: "alice",
  cancelledBy: null,
  members,
  zone: "UTC",
  ...over,
});

describe("countGroupMembers", () => {
  it("ignores in-flight states and buckets other skips as 'other'", () => {
    const c = countGroupMembers([
      { state: "planned", skipKind: null }, { state: "waiting", skipKind: null }, { state: "running", skipKind: null },
      { state: "already-current", skipKind: null }, { state: "skipped", skipKind: "cancelled" }, { state: "skipped", skipKind: null },
    ]);
    expect(c).toEqual({ upgraded: 0, alreadyCurrent: 1, failed: 0, unverified: 0, skippedHealth: 0, skippedUpstream: 0, skippedOther: 2, dropped: 0 });
  });
});

describe("groupEmailSections", () => {
  it("fills a fallback note when a member carries no detail", () => {
    const secs = groupEmailSections([
      mem("a", "failed"),
      mem("b", "failed", { stage: "uploading", detail: "disk full" }),
      mem("c", "unverified"),
      mem("d", "skipped", { skipKind: "health" }),
      mem("e", "skipped", { skipKind: "subtree" }),
      mem("f", "skipped"),
      mem("g", "upgraded", { fromVersion: null, toVersion: null }),
      mem("h", "already-current", { toVersion: null, fromVersion: "7.6.8" }),
      mem("i", "dropped"),
    ]);
    const notes = Object.fromEntries(secs.flatMap((s) => s.rows.map((r) => [r.m.deviceName, r.note])));
    expect(notes).toEqual({
      a: "unknown error",
      b: "uploading: disk full",
      c: "the device came back but its version could not be confirmed",
      d: "the device was not healthy",
      e: "a device behind it did not end clean",
      f: "not started",
      g: "unknown → ?",
      h: "runs 7.6.8",
      i: "dropped",
    });
  });

  it("keeps upgrade order within a section and omits empty sections", () => {
    const secs = groupEmailSections([mem("deep", "upgraded"), mem("mid", "upgraded"), mem("top", "upgraded")]);
    expect(secs).toHaveLength(1);
    expect(secs[0].rows.map((r) => r.m.deviceName)).toEqual(["deep", "mid", "top"]);
    expect(groupEmailSections([])).toEqual([]);
  });
});

describe("renderFirmwareGroupResultEmail", () => {
  it("warnings (no failure) read 'finished with warnings'; the denominator excludes dropped members", () => {
    const r = renderFirmwareGroupResultEmail(input([mem("a", "upgraded"), mem("b", "unverified"), mem("c", "dropped")]));
    expect(r.subject).toBe("[Polaris] Group firmware upgrade finished with warnings: FGT-HQ (1 of 2 upgraded)");
    expect(r.text).toContain("GROUP UPGRADE FINISHED WITH WARNINGS");
    expect(r.text).toContain("The group upgrade finished. 1 upgraded, 1 unverified, 1 dropped.");
  });

  it("already-current alone is a success with its own section", () => {
    const r = renderFirmwareGroupResultEmail(input([mem("a", "already-current", { verifiedVersion: "7.6.8" })]));
    expect(r.subject).toBe("[Polaris] Group firmware upgrade succeeded: FGT-HQ (0 of 1 upgraded)");
    expect(r.text).toContain("ALREADY CURRENT (1)");
    expect(r.text).toContain("runs 7.6.8");
  });

  it("labels FortiAP / FortiSwitch / FortiGate and passes other types through, with the model", () => {
    const r = renderFirmwareGroupResultEmail(input([
      mem("ap", "upgraded", { assetType: "access_point", model: "431F" }),
      mem("sw", "upgraded"),
      mem("fw", "upgraded", { assetType: "firewall" }),
      mem("x", "upgraded", { assetType: "server" }),
    ]));
    expect(r.text).toContain("ap (FortiAP 431F)");
    expect(r.text).toContain("sw (FortiSwitch)");
    expect(r.text).toContain("fw (FortiGate)");
    expect(r.text).toContain("x (server)");
  });

  it("a stopped group without a name just says it was stopped", () => {
    const r = renderFirmwareGroupResultEmail(input([mem("a", "upgraded")], { outcome: "cancelled" }));
    expect(r.text).toContain("The group was stopped; flashes already under way finished");
  });

  it("shows a duration only for a non-negative span", () => {
    expect(renderFirmwareGroupResultEmail(input([mem("a", "upgraded")])).text).toMatch(/Duration: 30m/);
    expect(renderFirmwareGroupResultEmail(input([mem("a", "upgraded")], { finishedAt: "2026-10-17T01:00:00Z" })).text).not.toContain("Duration");
    expect(renderFirmwareGroupResultEmail(input([mem("a", "upgraded")], { startedAt: null })).text).not.toContain("Started:");
  });

  it("links the gate and every device only when POLARIS_PUBLIC_URL is set", () => {
    delete process.env.POLARIS_PUBLIC_URL;
    const bare = renderFirmwareGroupResultEmail(input([mem("a", "upgraded")]));
    expect(bare.html).not.toContain("href=");
    expect(bare.text).not.toContain("Open the FortiGate");
    process.env.POLARIS_PUBLIC_URL = "https://polaris.example";
    const linked = renderFirmwareGroupResultEmail(input([mem("a", "upgraded")]));
    expect(linked.text).toMatch(/Open the FortiGate: https:\/\/polaris\.example\//);
    expect(linked.html.match(/href="https:\/\/polaris\.example\//g)).toHaveLength(2);
  });
});
