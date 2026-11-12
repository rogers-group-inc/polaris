/**
 * tests/unit/quarantinePushAvailability.test.ts — the quarantine verbs are
 * offered only when some integration can actually be pushed to.
 *
 * `config.pushQuarantine` is per-integration and OFF by default, and
 * `quarantineAsset` skips every sighting whose integration has it off. With it
 * off fleet-wide the push therefore resolves to zero targets and throws a 502
 * reading "0/0 FortiGate(s) accepted the push" — a device-shaped error for a
 * feature that was never turned on. `getQuarantinePushAvailability` is what the
 * frontends ask so they can withhold the verb instead.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../src/db.js", () => import("./_dbStub.js"));

import { getQuarantinePushAvailability } from "../../src/services/assetQuarantineService.js";
import { prisma } from "../../src/db.js";
import { resetDbStub, stubbed } from "./_dbStub.js";

const findMany = stubbed(prisma.integration.findMany);

beforeEach(() => resetDbStub());

describe("getQuarantinePushAvailability", () => {
  it("reports unavailable when no Fortinet integration carries the toggle", async () => {
    findMany.mockResolvedValue([{ config: { pushQuarantine: false } }, { config: {} }]);
    expect(await getQuarantinePushAvailability()).toEqual({
      pushEnabled: false,
      integrationCount: 2,
      pushEnabledCount: 0,
    });
  });

  it("reports unavailable on an install with no Fortinet integration at all", async () => {
    findMany.mockResolvedValue([]);
    const r = await getQuarantinePushAvailability();
    expect(r.pushEnabled).toBe(false);
    expect(r.integrationCount).toBe(0);
  });

  it("reports available as soon as one carries it", async () => {
    findMany.mockResolvedValue([{ config: { pushQuarantine: false } }, { config: { pushQuarantine: true } }]);
    expect(await getQuarantinePushAvailability()).toEqual({
      pushEnabled: true,
      integrationCount: 2,
      pushEnabledCount: 1,
    });
  });

  it("only true counts — a truthy string is not the toggle", async () => {
    // The config blob is operator-editable JSON; `pushQuarantine` is written by
    // the integration form as a real boolean, and quarantineAsset itself tests
    // `!== true`. Anything looser here would offer a verb the push then skips.
    findMany.mockResolvedValue([{ config: { pushQuarantine: "yes" } }, { config: { pushQuarantine: 1 } }]);
    expect((await getQuarantinePushAvailability()).pushEnabled).toBe(false);
  });

  it("tolerates a null config", async () => {
    findMany.mockResolvedValue([{ config: null }]);
    expect((await getQuarantinePushAvailability()).pushEnabled).toBe(false);
  });

  it("asks only about ENABLED FortiManager / FortiGate integrations", async () => {
    // A disabled integration is skipped by quarantineAsset's own
    // `enabled: true` load, and no other integration type can be pushed to —
    // counting either would re-offer the verb on an install that cannot push.
    findMany.mockResolvedValue([]);
    await getQuarantinePushAvailability();
    const arg = findMany.mock.calls[0]![0] as any;
    expect(arg.where.enabled).toBe(true);
    expect(arg.where.type.in.sort()).toEqual(["fortigate", "fortimanager"]);
    // Only the config column — the row carries secrets that the read
    // extension would otherwise walk for nothing.
    expect(arg.select).toEqual({ config: true });
  });
});
