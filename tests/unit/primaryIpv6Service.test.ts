/**
 * tests/unit/primaryIpv6Service.test.ts — an asset's primary IPv6 (business
 * rule 128(c); src/services/primaryIpv6Service.ts), against a stubbed Prisma
 * client, a stubbed IPv6 gate and a stubbed confidence scorer.
 *
 * Contract: the reconcile never touches a pinned value and writes only assets
 * whose choice changed (one $transaction per 200); with IPv6 off it clears
 * every unpinned value with one updateMany and keeps pins, and a pin is
 * refused 409; the tie-break is score → newest sighting → smallest address.
 * tests/integration/primaryIpv6.test.ts covers the same against a real DB.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { prisma } from "../../src/db.js";
import { resetDbStub, stubbed } from "./_dbStub.js";
import { eventLog, resetEventLogStub } from "./_eventLogStub.js";
import { AppError } from "../../src/utils/errors.js";

const m = vi.hoisted(() => ({
  ipv6Enabled: vi.fn(),
  buildAddressConfidence: vi.fn(),
}));

vi.mock("../../src/db.js", () => import("./_dbStub.js"));
vi.mock("../../src/services/eventLogService.js", (orig) =>
  import("./_eventLogStub.js").then((s) => s.withEventLogStubs(orig)));
vi.mock("../../src/services/ipv6GateService.js", () => ({ ipv6Enabled: m.ipv6Enabled }));
vi.mock("../../src/services/addressConfidenceService.js", () => ({ buildAddressConfidence: m.buildAddressConfidence }));

const { pickPrimaryIpv6, reconcilePrimaryIpv6, pinPrimaryIpv6, unpinPrimaryIpv6 } =
  await import("../../src/services/primaryIpv6Service.js");

const db = {
  assetUpdateMany: stubbed(prisma.asset.updateMany),
  assetFindMany: stubbed(prisma.asset.findMany),
  assetFindUnique: stubbed(prisma.asset.findUnique),
  assetUpdate: stubbed(prisma.asset.update),
  ipFindMany: stubbed(prisma.assetAssociatedIp.findMany),
  transaction: stubbed(prisma.$transaction),
};

const T0 = new Date("2026-11-10T00:00:00Z");
const T1 = new Date("2026-11-11T00:00:00Z");

/** buildAddressConfidence's shape: assetId → ip → { evidenceScore }. */
function scores(spec: Record<string, Record<string, number>>): Map<string, Map<string, { evidenceScore: number }>> {
  return new Map(Object.entries(spec).map(([id, ips]) =>
    [id, new Map(Object.entries(ips).map(([ip, s]) => [ip, { evidenceScore: s }]))]));
}

async function rejection(p: Promise<unknown>): Promise<AppError> {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(AppError);
    return err as AppError;
  }
  throw new Error("expected a rejection");
}

const lastEvent = () => eventLog.logEvent.mock.calls.at(-1)![0] as unknown as Record<string, any>;

beforeEach(() => {
  resetDbStub();
  resetEventLogStub();
  m.ipv6Enabled.mockReset().mockReturnValue(true);
  m.buildAddressConfidence.mockReset().mockResolvedValue(new Map());
  db.ipFindMany.mockResolvedValue([]);
  db.assetFindMany.mockResolvedValue([]);
  db.assetUpdate.mockImplementation(async (a: unknown) => a);
});

describe("pickPrimaryIpv6", () => {
  it("returns null for no candidates", () => {
    expect(pickPrimaryIpv6([])).toBeNull();
  });

  it("prefers the highest evidence score, regardless of order", () => {
    const c = [
      { ip: "2001:db8::1", evidenceScore: 2, lastSeen: T1 },
      { ip: "2001:db8::2", evidenceScore: 5, lastSeen: T0 },
    ];
    expect(pickPrimaryIpv6(c)).toBe("2001:db8::2");
    expect(pickPrimaryIpv6([...c].reverse())).toBe("2001:db8::2");
  });

  it("breaks a score tie on the newest sighting", () => {
    const c = [
      { ip: "2001:db8::1", evidenceScore: 3, lastSeen: T0 },
      { ip: "2001:db8::2", evidenceScore: 3, lastSeen: T1 },
    ];
    expect(pickPrimaryIpv6(c)).toBe("2001:db8::2");
    expect(pickPrimaryIpv6([...c].reverse())).toBe("2001:db8::2");
  });

  it("breaks a full tie on the lexically smallest address, stable across input order", () => {
    const c = [
      { ip: "2001:db8::b", evidenceScore: 1, lastSeen: T0 },
      { ip: "2001:db8::a", evidenceScore: 1, lastSeen: T0 },
    ];
    expect(pickPrimaryIpv6(c)).toBe("2001:db8::a");
    expect(pickPrimaryIpv6([...c].reverse())).toBe("2001:db8::a");
  });

  // Was a string compare until 2026-11-14 (::10 beat ::9); rule 128 says the
  // smallest ADDRESS, so it is numeric now.
  it("compares the tie-break numerically, not lexically", () => {
    expect(pickPrimaryIpv6([
      { ip: "2001:db8::10", evidenceScore: 1, lastSeen: T0 },
      { ip: "2001:db8::9", evidenceScore: 1, lastSeen: T0 },
    ])).toBe("2001:db8::9");
  });
});

describe("reconcilePrimaryIpv6 — IPv6 off", () => {
  it("clears every unpinned value in one updateMany and reads nothing else", async () => {
    m.ipv6Enabled.mockReturnValue(false);
    db.assetUpdateMany.mockResolvedValue({ count: 4 });
    await expect(reconcilePrimaryIpv6()).resolves.toEqual({ checked: 0, changed: 0, cleared: 4 });
    expect(db.assetUpdateMany).toHaveBeenCalledWith({
      where: { ipv6Pinned: false, ipv6Address: { not: null } },
      data: { ipv6Address: null },
    });
    expect(db.ipFindMany).not.toHaveBeenCalled();
    expect(eventLog.logEventsBatch).not.toHaveBeenCalled();
  });
});

describe("reconcilePrimaryIpv6 — IPv6 on", () => {
  it("picks per asset by score, canonicalizes, skips non-IPAM addresses, and writes only changes", async () => {
    db.ipFindMany.mockResolvedValue([
      { assetId: "a1", ip: "2001:db8::1", lastSeen: T0 },
      { assetId: "a1", ip: "2001:db8::2", lastSeen: T0 },
      { assetId: "a1", ip: "fe80::1", lastSeen: T1 },           // link-local: never a candidate
      { assetId: "a2", ip: "2001:DB8:0:0:0:0:0:5", lastSeen: T0 }, // non-canonical
      { assetId: "a3", ip: "2001:db8::3", lastSeen: T0 },
      { assetId: "a4", ip: "ff02::1", lastSeen: T0 },          // multicast only
    ]);
    db.assetFindMany.mockResolvedValue([
      { id: "a1", hostname: "srv-1", ipv6Address: null },
      { id: "a2", hostname: "srv-2", ipv6Address: "2001:db8::9" },
      { id: "a3", hostname: "srv-3", ipv6Address: "2001:db8::3" }, // steady
      { id: "stale", hostname: "", ipv6Address: "2001:db8::77" }, // rows gone
    ]);
    m.buildAddressConfidence.mockResolvedValue(scores({ a1: { "2001:db8::1": 1, "2001:db8::2": 4 } }));

    const now = new Date("2026-11-16T00:00:00Z");
    const out = await reconcilePrimaryIpv6(now);
    expect(out).toEqual({ checked: 4, changed: 2, cleared: 1 });

    const holdersWhere = db.assetFindMany.mock.calls[0][0].where;
    expect(holdersWhere.ipv6Pinned).toBe(false);
    expect(holdersWhere.OR[0].id.in.sort()).toEqual(["a1", "a2", "a3"]);

    expect(m.buildAddressConfidence).toHaveBeenCalledTimes(1);
    expect(m.buildAddressConfidence.mock.calls[0][0].sort()).toEqual(["a1", "a2", "a3"]);
    expect(m.buildAddressConfidence.mock.calls[0][1]).toEqual({ now });

    const writes = db.assetUpdate.mock.calls.map((c) => [c[0].where.id, c[0].data.ipv6Address]);
    expect(writes).toEqual([
      ["a1", "2001:db8::2"],
      ["a2", "2001:db8::5"],
      ["stale", null],
    ]);
    expect(db.transaction).toHaveBeenCalledTimes(1);

    expect(eventLog.logEventsBatch).toHaveBeenCalledTimes(1);
    const events = eventLog.logEventsBatch.mock.calls[0][0];
    expect(events.map((e) => e.action)).toEqual(Array(3).fill("asset.primary_ipv6.changed"));
    expect(events[0]).toMatchObject({
      resourceId: "a1", actor: "system", level: "info",
      message: `Primary IPv6 of "srv-1" is now 2001:db8::2`,
      details: { ipv6Address: "2001:db8::2", previous: null },
    });
    expect(events[1].message).toBe(`Primary IPv6 of "srv-2" is now 2001:db8::5 (was 2001:db8::9)`);
    expect(events[2]).toMatchObject({
      resourceId: "stale",
      resourceName: "2001:db8::77",
      message: `Primary IPv6 of "stale" cleared — the asset no longer reports 2001:db8::77`,
      details: { ipv6Address: null, previous: "2001:db8::77" },
    });
  });

  it("writes nothing and logs nothing in the steady state", async () => {
    db.ipFindMany.mockResolvedValue([{ assetId: "a1", ip: "2001:db8::1", lastSeen: T0 }]);
    db.assetFindMany.mockResolvedValue([{ id: "a1", hostname: "h", ipv6Address: "2001:db8::1" }]);
    await expect(reconcilePrimaryIpv6()).resolves.toEqual({ checked: 1, changed: 0, cleared: 0 });
    expect(db.assetUpdate).not.toHaveBeenCalled();
    expect(db.transaction).not.toHaveBeenCalled();
    expect(eventLog.logEventsBatch).not.toHaveBeenCalled();
  });

  it("scores only assets that have rows (no scorer call for a batch of pure clears)", async () => {
    db.assetFindMany.mockResolvedValue([{ id: "a1", hostname: "h", ipv6Address: "2001:db8::1" }]);
    await expect(reconcilePrimaryIpv6()).resolves.toEqual({ checked: 1, changed: 0, cleared: 1 });
    expect(m.buildAddressConfidence).not.toHaveBeenCalled();
  });

  it("scores and writes in batches of 200", async () => {
    const n = 450;
    db.ipFindMany.mockResolvedValue(Array.from({ length: n }, (_, i) => ({ assetId: `a${i}`, ip: `2001:db8::${(i + 1).toString(16)}`, lastSeen: T0 })));
    db.assetFindMany.mockResolvedValue(Array.from({ length: n }, (_, i) => ({ id: `a${i}`, hostname: `h${i}`, ipv6Address: null })));
    const out = await reconcilePrimaryIpv6();
    expect(out).toEqual({ checked: n, changed: n, cleared: 0 });
    expect(m.buildAddressConfidence.mock.calls.map((c) => c[0].length)).toEqual([200, 200, 50]);
    expect(db.transaction).toHaveBeenCalledTimes(3);
    expect(eventLog.logEventsBatch).toHaveBeenCalledTimes(1);
    expect(eventLog.logEventsBatch.mock.calls[0][0]).toHaveLength(n);
  });
});

describe("pinPrimaryIpv6", () => {
  beforeEach(() => {
    db.assetFindUnique.mockResolvedValue({ id: "a1", hostname: "srv-1", ipv6Address: "2001:db8::9" });
  });

  it("is refused 409 while IPv6 is off", async () => {
    m.ipv6Enabled.mockReturnValue(false);
    const err = await rejection(pinPrimaryIpv6({ assetId: "a1", ip: "2001:db8::1", actor: "u" }));
    expect(err.httpStatus).toBe(409);
    expect(db.assetUpdate).not.toHaveBeenCalled();
  });

  it("refuses a non-IPv6 value with 400", async () => {
    for (const ip of ["10.0.0.1", "nonsense", ""]) {
      expect((await rejection(pinPrimaryIpv6({ assetId: "a1", ip, actor: "u" }))).httpStatus).toBe(400);
    }
  });

  it("refuses loopback, link-local and multicast with 400", async () => {
    for (const ip of ["::1", "fe80::1", "ff02::1"]) {
      const err = await rejection(pinPrimaryIpv6({ assetId: "a1", ip, actor: "u" }));
      expect(err.httpStatus).toBe(400);
      expect(err.message).toMatch(/cannot be a device's address/);
    }
  });

  it("404s an unknown asset", async () => {
    db.assetFindUnique.mockResolvedValue(null);
    expect((await rejection(pinPrimaryIpv6({ assetId: "x", ip: "2001:db8::1", actor: "u" }))).httpStatus).toBe(404);
  });

  it("stores the canonical address as pinned, stamps who and when, and audits it", async () => {
    const r = await pinPrimaryIpv6({ assetId: "a1", ip: "  2001:DB8:0:0::1 ", actor: "alice" });
    expect(r).toEqual({ assetId: "a1", ipv6Address: "2001:db8::1" });
    const data = db.assetUpdate.mock.calls[0][0].data;
    expect(data).toMatchObject({ ipv6Address: "2001:db8::1", ipv6Pinned: true, ipv6PinnedBy: "alice" });
    expect(data.ipv6PinnedAt).toBeInstanceOf(Date);
    expect(lastEvent()).toMatchObject({
      action: "asset.primary_ipv6.pinned",
      resourceType: "asset",
      resourceId: "a1",
      resourceName: "srv-1",
      actor: "alice",
      message: `Primary IPv6 of "srv-1" pinned to 2001:db8::1 (was 2001:db8::9)`,
      details: { ipv6Address: "2001:db8::1", previous: "2001:db8::9" },
    });
  });

  it("omits the 'was' clause when re-pinning the current value", async () => {
    db.assetFindUnique.mockResolvedValue({ id: "a1", hostname: null, ipv6Address: "2001:db8::1" });
    await pinPrimaryIpv6({ assetId: "a1", ip: "2001:db8::1", actor: "u" });
    expect(lastEvent().message).toBe(`Primary IPv6 of "a1" pinned to 2001:db8::1`);
    expect(lastEvent().resourceName).toBe("2001:db8::1");
  });
});

describe("unpinPrimaryIpv6", () => {
  it("404s an unknown asset", async () => {
    db.assetFindUnique.mockResolvedValue(null);
    expect((await rejection(unpinPrimaryIpv6({ assetId: "x", actor: "u" }))).httpStatus).toBe(404);
  });

  it("is a no-op (no write, no Event) on an asset that is not pinned", async () => {
    db.assetFindUnique.mockResolvedValue({ id: "a1", hostname: "h", ipv6Address: "2001:db8::4", ipv6Pinned: false });
    await expect(unpinPrimaryIpv6({ assetId: "a1", actor: "u" })).resolves.toEqual({ ipv6Address: "2001:db8::4" });
    expect(db.assetUpdate).not.toHaveBeenCalled();
    expect(eventLog.logEvent).not.toHaveBeenCalled();
  });

  it("drops the pin and re-chooses straight away from the address list", async () => {
    db.assetFindUnique.mockResolvedValue({ id: "a1", hostname: "srv-1", ipv6Address: "2001:db8::99", ipv6Pinned: true });
    db.ipFindMany.mockResolvedValue([
      { ip: "2001:db8::1", lastSeen: T0 },
      { ip: "2001:db8::2", lastSeen: T0 },
      { ip: "fe80::5", lastSeen: T1 },
    ]);
    m.buildAddressConfidence.mockResolvedValue(scores({ a1: { "2001:db8::1": 7, "2001:db8::2": 1 } }));
    await expect(unpinPrimaryIpv6({ assetId: "a1", actor: "bob" })).resolves.toEqual({ ipv6Address: "2001:db8::1" });
    expect(db.ipFindMany.mock.calls[0][0].where).toEqual({ assetId: "a1", ip: { contains: ":" } });
    expect(db.assetUpdate).toHaveBeenCalledWith({
      where: { id: "a1" },
      data: { ipv6Address: "2001:db8::1", ipv6Pinned: false, ipv6PinnedAt: null, ipv6PinnedBy: null },
    });
    expect(lastEvent()).toMatchObject({
      action: "asset.primary_ipv6.unpinned",
      actor: "bob",
      message: `Primary IPv6 pin on "srv-1" removed — now 2001:db8::1, chosen automatically`,
      details: { previous: "2001:db8::99", ipv6Address: "2001:db8::1" },
    });
  });

  it("clears the value when the asset has no usable IPv6, without calling the scorer", async () => {
    db.assetFindUnique.mockResolvedValue({ id: "a1", hostname: "srv-1", ipv6Address: "2001:db8::99", ipv6Pinned: true });
    db.ipFindMany.mockResolvedValue([{ ip: "fe80::1", lastSeen: T0 }]);
    await expect(unpinPrimaryIpv6({ assetId: "a1", actor: "u" })).resolves.toEqual({ ipv6Address: null });
    expect(m.buildAddressConfidence).not.toHaveBeenCalled();
    expect(lastEvent().message).toBe(`Primary IPv6 pin on "srv-1" removed — no IPv6 to choose from`);
  });

  it("while IPv6 is off, unpins to null without reading the address list", async () => {
    m.ipv6Enabled.mockReturnValue(false);
    db.assetFindUnique.mockResolvedValue({ id: "a1", hostname: "srv-1", ipv6Address: "2001:db8::99", ipv6Pinned: true });
    await expect(unpinPrimaryIpv6({ assetId: "a1", actor: "u" })).resolves.toEqual({ ipv6Address: null });
    expect(db.ipFindMany).not.toHaveBeenCalled();
    expect(db.assetUpdate.mock.calls[0][0].data).toMatchObject({ ipv6Address: null, ipv6Pinned: false });
  });
});
