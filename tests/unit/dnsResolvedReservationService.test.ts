/**
 * tests/unit/dnsResolvedReservationService.test.ts — the own suite for
 * src/services/dnsResolvedReservationService.ts (CQ-T010).
 *
 * Business rule 11: an eligible asset's primary IPv4 address inside a known
 * network that nobody else holds gets a `dns_resolved` reservation
 * (createdBy "system:dns-resolved", hostname || dnsName, MAC), which defers
 * silently to every authoritative row, never raises a Conflict, follows the
 * asset when its address moves and is released when the asset stops being
 * eligible — 11(a): also when a SWEEP retired the owner, through the
 * reservation-side pass. The DB is an in-memory reservation / asset table
 * behind the shared stub, so each case states a fleet and reads what is left.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { prisma } from "../../src/db.js";
import { resetDbStub, stubbed } from "./_dbStub.js";

const m = vi.hoisted(() => ({
  buildIpContexts: vi.fn(),
  warn: vi.fn(),
}));
vi.mock("../../src/db.js", () => import("./_dbStub.js"));
vi.mock("../../src/services/eventLogService.js", (orig) =>
  import("./_eventLogStub.js").then((s) => s.withEventLogStubs(orig)));
vi.mock("../../src/services/subnetService.js", () => ({ buildIpContexts: m.buildIpContexts }));
vi.mock("../../src/utils/logger.js", () => ({
  logger: { warn: m.warn, info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { eventLog, resetEventLogStub } from "./_eventLogStub.js";
const {
  reconcileDnsResolvedForAsset,
  reconcileDnsResolvedForAllAssets,
  rowsOfIneligibleOwners,
  releaseDnsResolvedForAsset,
  releaseDnsResolvedAt,
} = await import("../../src/services/dnsResolvedReservationService.js");

const SYSTEM = "system:dns-resolved";

// ─── a tiny in-memory table behind the stub ─────────────────────────────────

type Row = Record<string, any>;

function matchValue(actual: unknown, cond: unknown): boolean {
  if (cond !== null && typeof cond === "object" && !Array.isArray(cond) && !(cond instanceof Date)) {
    const c = cond as Record<string, unknown>;
    if ("in" in c) return (c.in as unknown[]).includes(actual);
    if ("not" in c) return c.not === null ? actual != null : actual !== c.not;
    if ("equals" in c) return actual === c.equals;
  }
  return actual === cond;
}
function matches(row: Row, where: Record<string, unknown> | undefined): boolean {
  if (!where) return true;
  for (const [k, v] of Object.entries(where)) {
    if (k === "OR") { if (!(v as Record<string, unknown>[]).some((w) => matches(row, w))) return false; continue; }
    if (k === "NOT") { if (matches(row, v as Record<string, unknown>)) return false; continue; }
    if (!matchValue(row[k], v)) return false;
  }
  return true;
}

let reservations: Row[] = [];
let assets: Row[] = [];
let nextRes = 0;
/** ip → containing network; anything absent is outside IPAM. */
let networks: Record<string, { subnetId: string; subnetCidr: string }> = {};

const db = {
  resFindMany: stubbed(prisma.reservation.findMany),
  resFindFirst: stubbed(prisma.reservation.findFirst),
  resDeleteMany: stubbed(prisma.reservation.deleteMany),
  resCreate: stubbed(prisma.reservation.create),
  resUpdate: stubbed(prisma.reservation.update),
  assetFindUnique: stubbed(prisma.asset.findUnique),
  assetFindMany: stubbed(prisma.asset.findMany),
};

function installTable(): void {
  db.resFindMany.mockImplementation(async ({ where }: any) => reservations.filter((r) => matches(r, where)).map((r) => ({ ...r })));
  db.resFindFirst.mockImplementation(async ({ where }: any) => {
    const r = reservations.find((x) => matches(x, where));
    return r ? { ...r } : null;
  });
  db.resDeleteMany.mockImplementation(async ({ where }: any) => {
    const before = reservations.length;
    reservations = reservations.filter((r) => !matches(r, where));
    return { count: before - reservations.length };
  });
  db.resCreate.mockImplementation(async ({ data }: any) => {
    const row = { id: `new${++nextRes}`, ...data };
    reservations.push(row);
    return { ...row };
  });
  db.resUpdate.mockImplementation(async ({ where, data }: any) => {
    const row = reservations.find((r) => r.id === where.id);
    Object.assign(row!, data);
    return { ...row };
  });
  db.assetFindUnique.mockImplementation(async ({ where }: any) => {
    const a = assets.find((x) => x.id === where.id);
    return a ? { ...a } : null;
  });
  db.assetFindMany.mockImplementation(async ({ where }: any) => assets.filter((a) => matches(a, where)).map((a) => ({ ...a })));
  m.buildIpContexts.mockImplementation(async (ips: string[]) => {
    const out = new Map<string, any>();
    for (const ip of ips) {
      const n = networks[ip];
      if (n) out.set(ip, { ...n, subnetName: "LAN", reservation: null });
    }
    return out;
  });
}

beforeEach(() => {
  resetDbStub();
  resetEventLogStub();
  m.warn.mockReset();
  m.buildIpContexts.mockReset();
  reservations = [];
  assets = [];
  nextRes = 0;
  networks = {
    "10.0.0.5": { subnetId: "s1", subnetCidr: "10.0.0.0/24" },
    "10.0.0.6": { subnetId: "s1", subnetCidr: "10.0.0.0/24" },
    "10.0.0.7": { subnetId: "s1", subnetCidr: "10.0.0.0/24" },
    "10.0.1.5": { subnetId: "s2", subnetCidr: "10.0.1.0/24" },
  };
  installTable();
});

const asset = (over: Row = {}): Row => ({
  id: "a1", ipAddress: "10.0.0.5", hostname: "printer-1", dnsName: null, macAddress: "AA:BB:CC:00:00:01", status: "active", ...over,
});
const sysRow = (over: Row = {}): Row => ({
  id: `r${reservations.length + 1}`, subnetId: "s1", ipAddress: "10.0.0.5", hostname: "printer-1", macAddress: "AA:BB:CC:00:00:01",
  status: "active", sourceType: "dns_resolved", createdBy: SYSTEM, ...over,
});
const actions = () => eventLog.logEvent.mock.calls.map((c) => c[0].action);

// ─── reconcileDnsResolvedForAsset ───────────────────────────────────────────

describe("reconcileDnsResolvedForAsset — creating the row", () => {
  it("creates a dns_resolved row at the asset's address with its hostname and MAC, never pushed, and logs it", async () => {
    assets = [asset()];
    const out = await reconcileDnsResolvedForAsset("a1");
    expect(out).toEqual({ created: 1, updated: 0, released: 0, skipped: false });
    expect(reservations).toEqual([expect.objectContaining({
      subnetId: "s1", ipAddress: "10.0.0.5", hostname: "printer-1", macAddress: "AA:BB:CC:00:00:01",
      status: "active", sourceType: "dns_resolved", createdBy: SYSTEM,
    })]);
    expect(reservations[0]).not.toHaveProperty("pushStatus");
    expect(reservations[0]).not.toHaveProperty("pushedToId");
    expect(eventLog.logEvent).toHaveBeenCalledWith(expect.objectContaining({
      action: "reservation.dns_resolved.created", resourceType: "reservation", resourceId: "new1", actor: SYSTEM,
      details: expect.objectContaining({ assetId: "a1", subnetId: "s1", ipAddress: "10.0.0.5" }),
    }));
  });

  it.each(["active", "maintenance", "storage", "quarantined"])("treats a %s asset as eligible", async (status) => {
    assets = [asset({ status })];
    expect((await reconcileDnsResolvedForAsset("a1")).created).toBe(1);
  });

  it("falls back to dnsName when the hostname is blank, and trims it", async () => {
    assets = [asset({ hostname: "   ", dnsName: "  pr1.corp.example  " })];
    await reconcileDnsResolvedForAsset("a1");
    expect(reservations[0].hostname).toBe("pr1.corp.example");
  });

  it("writes null hostname and MAC when the asset has neither", async () => {
    assets = [asset({ hostname: null, dnsName: null, macAddress: null })];
    await reconcileDnsResolvedForAsset("a1");
    expect(reservations[0]).toMatchObject({ hostname: null, macAddress: null });
  });

  it("asks the shared containment query for exactly the asset's address", async () => {
    assets = [asset()];
    await reconcileDnsResolvedForAsset("a1");
    expect(m.buildIpContexts).toHaveBeenCalledWith(["10.0.0.5"]);
  });

  it("raises no Conflict row on any path", async () => {
    assets = [asset()];
    reservations = [{ id: "m1", subnetId: "s1", ipAddress: "10.0.0.5", status: "active", sourceType: "manual", createdBy: "alice" }];
    await reconcileDnsResolvedForAsset("a1");
    expect(stubbed(prisma.conflict.create)).not.toHaveBeenCalled();
    expect(stubbed(prisma.conflict.upsert)).not.toHaveBeenCalled();
  });
});

describe("reconcileDnsResolvedForAsset — skipping", () => {
  it("skips a missing asset without touching reservations", async () => {
    expect(await reconcileDnsResolvedForAsset("nope")).toEqual({ created: 0, updated: 0, released: 0, skipped: true });
    expect(db.resFindMany).not.toHaveBeenCalled();
  });

  it("skips (and logs a warning) when the asset read itself fails", async () => {
    db.assetFindUnique.mockRejectedValue(new Error("pool exhausted"));
    expect((await reconcileDnsResolvedForAsset("a1")).skipped).toBe(true);
    expect(m.warn).toHaveBeenCalledWith(expect.objectContaining({ assetId: "a1" }), "dns_resolved.reconcile: asset load failed");
  });

  it.each([
    ["decommissioned", { status: "decommissioned" }],
    ["disabled", { status: "disabled" }],
    ["no address", { ipAddress: null }],
    ["an invalid address", { ipAddress: "not-an-ip" }],
    ["an IPv6 address", { ipAddress: "2001:db8::5" }],
  ])("creates nothing for an asset with %s", async (_label, over) => {
    assets = [asset(over)];
    const out = await reconcileDnsResolvedForAsset("a1");
    expect(out.skipped).toBe(true);
    expect(db.resCreate).not.toHaveBeenCalled();
  });

  it("creates nothing when the address is in no known network", async () => {
    assets = [asset({ ipAddress: "192.168.9.9" })];
    expect((await reconcileDnsResolvedForAsset("a1")).skipped).toBe(true);
    expect(reservations).toEqual([]);
  });

  it("treats a failed containment query like no network (best-effort)", async () => {
    assets = [asset()];
    m.buildIpContexts.mockRejectedValue(new Error("boom"));
    expect((await reconcileDnsResolvedForAsset("a1")).skipped).toBe(true);
    expect(db.resCreate).not.toHaveBeenCalled();
  });

  it.each(["manual", "dhcp_reservation", "dhcp_lease", "interface_ip", "vip", "fortiswitch", "fortinap"])(
    "defers silently to an active %s row at the target",
    async (sourceType) => {
      assets = [asset()];
      reservations = [{ id: "auth", subnetId: "s1", ipAddress: "10.0.0.5", status: "active", sourceType, createdBy: "x" }];
      const out = await reconcileDnsResolvedForAsset("a1");
      expect(out).toEqual({ created: 0, updated: 0, released: 0, skipped: true });
      expect(reservations.map((r) => r.id)).toEqual(["auth"]);
      expect(eventLog.logEvent).not.toHaveBeenCalled();
    },
  );

  it("does not defer to a released authoritative row", async () => {
    assets = [asset()];
    reservations = [{ id: "old", subnetId: "s1", ipAddress: "10.0.0.5", status: "released", sourceType: "manual", createdBy: "x" }];
    expect((await reconcileDnsResolvedForAsset("a1")).created).toBe(1);
  });
});

describe("reconcileDnsResolvedForAsset — keeping, updating and releasing its own rows", () => {
  it("is a no-op when its row at the target already records its hostname and MAC", async () => {
    assets = [asset()];
    reservations = [sysRow({ id: "r1" })];
    expect(await reconcileDnsResolvedForAsset("a1")).toEqual({ created: 0, updated: 0, released: 0, skipped: false });
    expect(db.resUpdate).not.toHaveBeenCalled();
    expect(eventLog.logEvent).not.toHaveBeenCalled();
  });

  it("updates its row at the target when the hostname changed, and logs the update", async () => {
    assets = [asset({ hostname: "printer-1b" })];
    // The row is found by MAC (owned) and sits at the target.
    reservations = [sysRow({ id: "r1" })];
    const out = await reconcileDnsResolvedForAsset("a1");
    expect(out).toMatchObject({ updated: 1, created: 0, released: 0 });
    expect(reservations[0]).toMatchObject({ id: "r1", hostname: "printer-1b" });
    expect(actions()).toEqual(["reservation.dns_resolved.updated"]);
  });

  it("updates a row at the target whose MAC changed", async () => {
    assets = [asset({ macAddress: "AA:BB:CC:00:00:99" })];
    reservations = [sysRow({ id: "r1" })];
    await reconcileDnsResolvedForAsset("a1");
    expect(reservations[0].macAddress).toBe("AA:BB:CC:00:00:99");
  });

  it("leaves a row at the target that already describes ANOTHER eligible asset at the same address", async () => {
    assets = [
      asset(),
      asset({ id: "a2", hostname: "printer-2", macAddress: "AA:BB:CC:00:00:02" }),
    ];
    reservations = [sysRow({ id: "r1", hostname: "printer-2", macAddress: "AA:BB:CC:00:00:02" })];
    const out = await reconcileDnsResolvedForAsset("a1");
    expect(out).toMatchObject({ created: 0, updated: 0, released: 0 });
    expect(reservations[0]).toMatchObject({ hostname: "printer-2", macAddress: "AA:BB:CC:00:00:02" });
    expect(eventLog.logEvent).not.toHaveBeenCalled();
  });

  it("rewrites a row at the target whose recorded device is no longer at that address", async () => {
    assets = [asset(), asset({ id: "a2", hostname: "printer-2", macAddress: "AA:BB:CC:00:00:02", status: "decommissioned" })];
    reservations = [sysRow({ id: "r1", hostname: "printer-2", macAddress: "AA:BB:CC:00:00:02" })];
    expect((await reconcileDnsResolvedForAsset("a1")).updated).toBe(1);
    expect(reservations[0].hostname).toBe("printer-1");
  });

  it("moves with the asset: a new row at the new address, the old one released", async () => {
    assets = [asset({ ipAddress: "10.0.0.6" })];
    reservations = [sysRow({ id: "r1", ipAddress: "10.0.0.5" })];
    const out = await reconcileDnsResolvedForAsset("a1");
    expect(out).toMatchObject({ created: 1, released: 1 });
    expect(reservations.map((r) => r.ipAddress)).toEqual(["10.0.0.6"]);
    expect(actions()).toEqual(["reservation.dns_resolved.created", "reservation.dns_resolved.released"]);
    expect(eventLog.logEvent.mock.calls[1][0]).toMatchObject({
      resourceType: "asset", resourceId: "a1", details: { reason: "stale row replaced by current target", count: 1, ids: ["r1"] },
    });
  });

  it("follows the asset into another network", async () => {
    assets = [asset({ ipAddress: "10.0.1.5" })];
    reservations = [sysRow({ id: "r1" })];
    await reconcileDnsResolvedForAsset("a1");
    expect(reservations).toEqual([expect.objectContaining({ subnetId: "s2", ipAddress: "10.0.1.5" })]);
  });

  it("releases (hard-deletes) its rows when it becomes ineligible", async () => {
    assets = [asset({ status: "decommissioned" })];
    reservations = [sysRow({ id: "r1" })];
    const out = await reconcileDnsResolvedForAsset("a1");
    expect(out).toEqual({ created: 0, updated: 0, released: 1, skipped: true });
    expect(reservations).toEqual([]);
    expect(db.resDeleteMany).toHaveBeenCalledWith({ where: { id: { in: ["r1"] }, status: "active" } });
    expect(eventLog.logEvent.mock.calls[0][0]).toMatchObject({
      action: "reservation.dns_resolved.released", details: expect.objectContaining({ reason: expect.stringContaining("ineligible") }),
    });
  });

  it("releases its old row when its new address is outside every network", async () => {
    assets = [asset({ ipAddress: "192.168.9.9" })];
    reservations = [sysRow({ id: "r1" })];
    expect((await reconcileDnsResolvedForAsset("a1")).released).toBe(1);
    expect(reservations).toEqual([]);
  });

  it("releases its rows elsewhere when an authoritative row covers its new address", async () => {
    assets = [asset({ ipAddress: "10.0.0.6" })];
    reservations = [
      sysRow({ id: "r1" }),
      { id: "auth", subnetId: "s1", ipAddress: "10.0.0.6", status: "active", sourceType: "dhcp_reservation", createdBy: "fgt" },
    ];
    const out = await reconcileDnsResolvedForAsset("a1");
    expect(out).toMatchObject({ released: 1, skipped: true });
    expect(reservations.map((r) => r.id)).toEqual(["auth"]);
    expect(eventLog.logEvent.mock.calls[0][0].message).toContain("authoritative dhcp_reservation");
  });

  it("does not claim a dns_resolved row written by someone other than the system actor", async () => {
    assets = [asset({ status: "decommissioned" })];
    reservations = [sysRow({ id: "r1", createdBy: "alice" })];
    expect((await reconcileDnsResolvedForAsset("a1")).released).toBe(0);
    expect(reservations).toHaveLength(1);
  });

  it("owns nothing when it has neither MAC nor hostname", async () => {
    assets = [asset({ status: "decommissioned", macAddress: null, hostname: null, dnsName: null })];
    reservations = [sysRow({ id: "r1", hostname: null, macAddress: null })];
    await reconcileDnsResolvedForAsset("a1");
    expect(db.resFindMany).not.toHaveBeenCalled();
    expect(reservations).toHaveLength(1);
  });

  it("swallows a failed create (the sweep retries) and still releases stale rows", async () => {
    assets = [asset({ ipAddress: "10.0.0.6" })];
    reservations = [sysRow({ id: "r1" })];
    db.resCreate.mockRejectedValue(Object.assign(new Error("unique"), { code: "P2002" }));
    const out = await reconcileDnsResolvedForAsset("a1");
    expect(out).toMatchObject({ created: 0, released: 1 });
    expect(m.warn).toHaveBeenCalledWith(expect.objectContaining({ assetId: "a1", ip: "10.0.0.6" }), "dns_resolved.reconcile: upsert failed");
  });

  it("never throws when the ownership read fails — it just owns nothing", async () => {
    assets = [asset()];
    db.resFindMany.mockRejectedValue(new Error("db"));
    await expect(reconcileDnsResolvedForAsset("a1")).resolves.toMatchObject({ created: 1 });
  });

  it("logs no release event when the delete removed nothing (another writer got there first)", async () => {
    assets = [asset({ status: "disabled" })];
    reservations = [sysRow({ id: "r1" })];
    db.resDeleteMany.mockResolvedValue({ count: 0 });
    expect((await reconcileDnsResolvedForAsset("a1")).released).toBe(0);
    expect(eventLog.logEvent).not.toHaveBeenCalled();
  });

  // Was a bug until 2026-11-13: ownership was "same MAC OR same resolved hostname", so two live assets
  // that share a hostname (a: printer-1 / MAC …01 at .5, b: printer-1 / MAC
  // …02 at .6) each "own" the other's row. a's reconcile releases b's row at
  // .6 as "stale row replaced by current target" although b is eligible and
  // still at .6 — and b's reconcile then deletes a's, so the pair flaps on
  // every sweep with an event each way. A row whose MAC names a different
  // device should not be owned by hostname (match on hostname only when the
  // row has no MAC, or the MACs agree).
  it("does not release a namesake's row that records a different MAC at its own address", async () => {
    assets = [asset(), asset({ id: "b", ipAddress: "10.0.0.6", macAddress: "AA:BB:CC:00:00:02" })];
    reservations = [
      sysRow({ id: "ra" }),
      sysRow({ id: "rb", ipAddress: "10.0.0.6", macAddress: "AA:BB:CC:00:00:02" }),
    ];
    await reconcileDnsResolvedForAsset("a1");
    expect(reservations.map((r) => r.id).sort()).toEqual(["ra", "rb"]);
  });

  // The other side of that fix: a same-name row carrying a MAC NO other asset
  // holds is the orphan this asset's own MAC change left behind — still ours,
  // still released as stale.
  it("still releases its own orphan from before a MAC change (a MAC no other asset holds)", async () => {
    assets = [asset()];
    reservations = [
      sysRow({ id: "ra" }),
      sysRow({ id: "old", ipAddress: "10.0.0.6", macAddress: "AA:BB:CC:00:00:99" }),
    ];
    await reconcileDnsResolvedForAsset("a1");
    expect(reservations.map((r) => r.id)).toEqual(["ra"]);
  });
});

// ─── rowsOfIneligibleOwners (pure, rule 11(a)) ──────────────────────────────

describe("rowsOfIneligibleOwners", () => {
  const row = (id: string, hostname: string | null, macAddress: string | null) => ({ id, hostname, macAddress });
  const a = (id: string, over: Partial<Row> = {}) => ({
    id, ipAddress: "10.0.0.5", hostname: null, dnsName: null, macAddress: null, status: "active", ...over,
  } as { id: string; ipAddress: string | null; hostname: string | null; dnsName: string | null; macAddress: string | null; status: string });

  it("releases a row whose only owner (by MAC) is decommissioned", () => {
    expect(rowsOfIneligibleOwners([row("r1", null, "M1")], [a("x", { macAddress: "M1", status: "decommissioned" })]))
      .toEqual([{ rowId: "r1", assetId: "x" }]);
  });

  it("releases a row whose owner (by resolved hostname) lost its address", () => {
    expect(rowsOfIneligibleOwners([row("r1", "pc", null)], [a("x", { hostname: "pc", ipAddress: null })]))
      .toEqual([{ rowId: "r1", assetId: "x" }]);
  });

  it("matches an owner through dnsName when its hostname is blank", () => {
    expect(rowsOfIneligibleOwners([row("r1", "pc.corp", null)], [a("x", { hostname: " ", dnsName: "pc.corp", status: "disabled" })]))
      .toEqual([{ rowId: "r1", assetId: "x" }]);
  });

  it("keeps a row while any owner is eligible — a replacement beside its retired namesake", () => {
    const retired = a("old", { hostname: "pc", status: "decommissioned" });
    const replacement = a("new", { hostname: "pc" });
    expect(rowsOfIneligibleOwners([row("r1", "pc", null)], [retired, replacement])).toEqual([]);
  });

  it("keeps a row an eligible owner reaches by MAC even when a retired asset matches its hostname", () => {
    expect(rowsOfIneligibleOwners(
      [row("r1", "pc", "M1")],
      [a("old", { hostname: "pc", status: "decommissioned" }), a("new", { macAddress: "M1" })],
    )).toEqual([]);
  });

  it("leaves a row no asset owns", () => {
    expect(rowsOfIneligibleOwners([row("r1", "ghost", "M9")], [a("x", { hostname: "pc" })])).toEqual([]);
  });

  it("treats an IPv6-only owner as ineligible", () => {
    expect(rowsOfIneligibleOwners([row("r1", null, "M1")], [a("x", { macAddress: "M1", ipAddress: "2001:db8::1" })]))
      .toHaveLength(1);
  });

  it("names the first owner found (MAC owners before hostname owners)", () => {
    const out = rowsOfIneligibleOwners(
      [row("r1", "pc", "M1")],
      [a("byHost", { hostname: "pc", status: "disabled" }), a("byMac", { macAddress: "M1", status: "decommissioned" })],
    );
    expect(out).toEqual([{ rowId: "r1", assetId: "byMac" }]);
  });

  it("handles empty inputs", () => {
    expect(rowsOfIneligibleOwners([], [])).toEqual([]);
  });
});

// ─── reconcileDnsResolvedForAllAssets ───────────────────────────────────────

describe("reconcileDnsResolvedForAllAssets", () => {
  it("scans every asset with an address and creates the missing rows", async () => {
    assets = [asset(), asset({ id: "a2", ipAddress: "10.0.0.6", hostname: "pc-2", macAddress: "M2" }), asset({ id: "a3", ipAddress: null })];
    const out = await reconcileDnsResolvedForAllAssets();
    expect(out).toEqual({ created: 2, updated: 0, released: 0, scanned: 2 });
    expect(reservations.map((r) => r.ipAddress).sort()).toEqual(["10.0.0.5", "10.0.0.6"]);
  });

  it("settles an already-correct asset in memory without its per-asset reads", async () => {
    assets = [asset()];
    reservations = [sysRow({ id: "r1" })];
    const out = await reconcileDnsResolvedForAllAssets();
    expect(out).toEqual({ created: 0, updated: 0, released: 0, scanned: 1 });
    expect(db.assetFindUnique).not.toHaveBeenCalled();
  });

  it("hands an asset whose row is stale to the per-asset path", async () => {
    assets = [asset({ hostname: "renamed" })];
    reservations = [sysRow({ id: "r1" })];
    const out = await reconcileDnsResolvedForAllAssets();
    expect(out.updated).toBe(1);
    expect(db.assetFindUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "a1" } }));
  });

  it("leaves an asset deferring to an authoritative row alone when it owns nothing", async () => {
    assets = [asset()];
    reservations = [{ id: "auth", subnetId: "s1", ipAddress: "10.0.0.5", status: "active", sourceType: "manual", createdBy: "x", hostname: null, macAddress: null }];
    await reconcileDnsResolvedForAllAssets();
    expect(db.assetFindUnique).not.toHaveBeenCalled();
  });

  it("falls back to reconciling every asset when the shared pre-read fails", async () => {
    assets = [asset()];
    reservations = [sysRow({ id: "r1" })];
    m.buildIpContexts.mockRejectedValueOnce(new Error("boom"));
    await reconcileDnsResolvedForAllAssets();
    expect(m.warn).toHaveBeenCalledWith(expect.anything(), "dns_resolved.reconcile: shared pre-read failed; reconciling every asset");
    expect(db.assetFindUnique).toHaveBeenCalledTimes(1);
  });

  it("releases an ineligible addressed asset's row through the per-asset path", async () => {
    assets = [asset({ status: "disabled" })];
    reservations = [sysRow({ id: "r1" })];
    expect((await reconcileDnsResolvedForAllAssets()).released).toBe(1);
    expect(reservations).toEqual([]);
  });

  it("rule 11(a): releases the row of an owner a bulk sweep retired and stripped of its address", async () => {
    // Decommissioned in an updateMany: no address, so the per-asset scan never sees it.
    assets = [asset({ status: "decommissioned", ipAddress: null })];
    reservations = [sysRow({ id: "r1" })];
    const out = await reconcileDnsResolvedForAllAssets();
    expect(out).toMatchObject({ scanned: 0, released: 1 });
    expect(reservations).toEqual([]);
    expect(eventLog.logEvent.mock.calls[0][0]).toMatchObject({
      action: "reservation.dns_resolved.released", resourceId: "a1",
      details: expect.objectContaining({ reason: "the device that held it is decommissioned, disabled or has no address" }),
    });
  });

  it("rule 11(a): keeps a row a live replacement owns beside its retired namesake", async () => {
    assets = [
      asset({ id: "old", status: "decommissioned", ipAddress: null, macAddress: "OLD" }),
      asset({ id: "new", macAddress: "AA:BB:CC:00:00:01" }),
    ];
    reservations = [sysRow({ id: "r1" })];
    await reconcileDnsResolvedForAllAssets();
    expect(reservations.map((r) => r.id)).toEqual(["r1"]);
  });

  it("rule 11(a): leaves a row nobody owns", async () => {
    reservations = [sysRow({ id: "r1", hostname: "ghost", macAddress: "GHOST" })];
    expect((await reconcileDnsResolvedForAllAssets()).released).toBe(0);
    expect(reservations).toHaveLength(1);
  });

  it("rule 11(a): the owner query is skipped for rows with neither MAC nor hostname", async () => {
    reservations = [sysRow({ id: "r1", hostname: null, macAddress: null })];
    await reconcileDnsResolvedForAllAssets();
    // Only the per-asset scan's own read — no owner lookup.
    expect(db.assetFindMany).toHaveBeenCalledTimes(1);
  });

  it("never throws when the reservation-side pass fails", async () => {
    assets = [];
    db.resFindMany.mockRejectedValue(new Error("db"));
    await expect(reconcileDnsResolvedForAllAssets()).resolves.toMatchObject({ released: 0 });
    expect(m.warn).toHaveBeenCalledWith(expect.anything(), "dns_resolved.sweep: releasing rows of ineligible owners failed");
  });

  it("counts a per-asset failure as nothing and carries on", async () => {
    assets = [asset(), asset({ id: "a2", ipAddress: "10.0.0.6", hostname: "pc-2", macAddress: "M2" })];
    db.assetFindUnique.mockImplementation(async ({ where }: any) => {
      if (where.id === "a1") throw new Error("gone");
      return { ...assets.find((x) => x.id === where.id) };
    });
    expect((await reconcileDnsResolvedForAllAssets()).created).toBe(1);
  });
});

// ─── releaseDnsResolvedForAsset / releaseDnsResolvedAt ──────────────────────

describe("releaseDnsResolvedForAsset (asset-delete hook)", () => {
  it("releases every row the asset owns, with an 'asset deleted' event", async () => {
    assets = [asset()];
    reservations = [sysRow({ id: "r1" }), sysRow({ id: "r2", ipAddress: "10.0.0.7", hostname: "other", macAddress: "AA:BB:CC:00:00:01" })];
    await releaseDnsResolvedForAsset("a1");
    expect(reservations).toEqual([]);
    expect(eventLog.logEvent.mock.calls[0][0]).toMatchObject({ resourceId: "a1", details: { reason: "asset deleted", count: 2 } });
  });

  it("does nothing for an asset that is already gone", async () => {
    await releaseDnsResolvedForAsset("nope");
    expect(db.resDeleteMany).not.toHaveBeenCalled();
  });

  it("never throws", async () => {
    db.assetFindUnique.mockRejectedValue(new Error("db"));
    await expect(releaseDnsResolvedForAsset("a1")).resolves.toBeUndefined();
    expect(m.warn).toHaveBeenCalledWith(expect.objectContaining({ assetId: "a1" }), "dns_resolved.releaseOnDelete failed");
  });
});

describe("releaseDnsResolvedAt (discovery hand-off)", () => {
  it("deletes any active dns_resolved row at the target and logs the hand-off", async () => {
    reservations = [sysRow({ id: "r1" }), sysRow({ id: "r2", createdBy: "alice" })];
    await releaseDnsResolvedAt("s1", "10.0.0.5");
    expect(reservations).toEqual([]);
    expect(db.resDeleteMany).toHaveBeenCalledWith({
      where: { subnetId: "s1", ipAddress: "10.0.0.5", status: "active", sourceType: "dns_resolved" },
    });
    expect(eventLog.logEvent).toHaveBeenCalledWith(expect.objectContaining({
      action: "reservation.dns_resolved.released", resourceType: "reservation", resourceName: "10.0.0.5",
      details: { reason: "discovery_handoff", subnetId: "s1", ipAddress: "10.0.0.5", count: 2 },
    }));
  });

  it("leaves authoritative rows and logs nothing when there is no dns_resolved row", async () => {
    reservations = [{ id: "m", subnetId: "s1", ipAddress: "10.0.0.5", status: "active", sourceType: "manual" }];
    await releaseDnsResolvedAt("s1", "10.0.0.5");
    expect(reservations).toHaveLength(1);
    expect(eventLog.logEvent).not.toHaveBeenCalled();
  });

  it("never throws", async () => {
    db.resDeleteMany.mockRejectedValue(new Error("db"));
    await expect(releaseDnsResolvedAt("s1", "10.0.0.5")).resolves.toBeUndefined();
    expect(m.warn).toHaveBeenCalledWith(expect.objectContaining({ subnetId: "s1" }), "dns_resolved.releaseAt failed");
  });
});
