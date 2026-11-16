/**
 * tests/unit/presenceVerificationService.test.ts
 *
 * runPresenceVerification (business rule 12) — the post-discovery pass that
 * establishes Asset.lastSeen for directory-discovered assets, cheapest signal
 * first: already fresh → agent heartbeat → answering monitor probe → one ICMP
 * echo. A failed ping writes NOTHING; writes go through bumpLastSeen (real
 * here) in chunked transactions; the pass is bounded by a deadline. The pure
 * classifier's own cases live in tests/unit/presenceVerification.test.ts;
 * this file adds its boundaries and the runner. pingHost is mocked.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const h = vi.hoisted(() => ({ pingHost: vi.fn() }));

vi.mock("../../src/db.js", () => import("./_dbStub.js"));
vi.mock("../../src/services/eventLogService.js", (orig) => import("./_eventLogStub.js").then((s) => s.withEventLogStubs(orig)));
vi.mock("../../src/utils/icmpPing.js", () => ({ pingHost: h.pingHost }));
vi.mock("../../src/utils/logger.js", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import { prisma } from "../../src/db.js";
import { resetDbStub, stubbed } from "./_dbStub.js";
import { eventLog, resetEventLogStub } from "./_eventLogStub.js";
import { classifyPresenceSignal, runPresenceVerification } from "../../src/services/presenceVerificationService.js";

const NOW = new Date("2026-11-14T12:00:00Z");
const HOUR = 3_600_000;
const ago = (ms: number) => new Date(NOW.getTime() - ms);

const asset = { findMany: stubbed(prisma.asset.findMany), update: stubbed(prisma.asset.update) };

type Row = {
  id: string; hostname?: string | null; dnsName?: string | null; ipAddress?: string | null;
  lastSeen?: Date | null; monitored?: boolean; monitorStatus?: string | null; lastMonitorAt?: Date | null;
  managedAgent?: { lastSeenAt: Date | null } | null;
};
function row(r: Row) {
  return { hostname: null, dnsName: null, ipAddress: null, lastSeen: null, monitored: false, monitorStatus: null, lastMonitorAt: null, managedAgent: null, ...r };
}
const opts = (over: Record<string, unknown> = {}) => ({ integrationId: "int-1", integrationName: "Corp AD", pollIntervalHours: 4, actor: "discovery", ...over });
/** The data each asset.update was called with, by id. */
const writes = () => Object.fromEntries(asset.update.mock.calls.map((c: any[]) => [c[0].where.id, c[0].data]));

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  resetDbStub();
  resetEventLogStub();
  vi.clearAllMocks();
  h.pingHost.mockReset().mockResolvedValue({ success: false });
  asset.findMany.mockResolvedValue([]);
  asset.update.mockImplementation(async (a: any) => a);
});
afterEach(() => {
  vi.useRealTimers();
});

describe("classifyPresenceSignal — boundaries", () => {
  const floor = NOW.getTime() - HOUR;
  const base = { lastSeen: null, monitored: false, monitorStatus: null, lastMonitorAt: null, managedAgent: null };

  it("a timestamp exactly on the floor counts as fresh", () => {
    expect(classifyPresenceSignal({ ...base, lastSeen: new Date(floor) }, floor)).toEqual({ kind: "fresh" });
    expect(classifyPresenceSignal({ ...base, managedAgent: { lastSeenAt: new Date(floor) } }, floor).kind).toBe("agent");
  });

  it("an agent with no heartbeat yet falls through", () => {
    expect(classifyPresenceSignal({ ...base, managedAgent: { lastSeenAt: null } }, floor)).toEqual({ kind: "ping" });
  });

  it("a fresh probe on an UNMONITORED asset is not evidence", () => {
    expect(classifyPresenceSignal({ ...base, monitorStatus: "up", lastMonitorAt: new Date(NOW) }, floor)).toEqual({ kind: "ping" });
  });

  it("an up monitored asset with no lastMonitorAt falls through", () => {
    expect(classifyPresenceSignal({ ...base, monitored: true, monitorStatus: "up" }, floor)).toEqual({ kind: "ping" });
  });

  it("the agent outranks the probe and carries its own time as evidence", () => {
    const at = new Date(NOW.getTime() - 60_000);
    expect(classifyPresenceSignal({ ...base, monitored: true, monitorStatus: "up", lastMonitorAt: new Date(NOW), managedAgent: { lastSeenAt: at } }, floor))
      .toEqual({ kind: "agent", evidenceAt: at });
  });
});

describe("runPresenceVerification — candidates", () => {
  it("reads active / quarantined assets with a directory-kind source from this integration", async () => {
    await runPresenceVerification(opts());
    const arg = asset.findMany.mock.calls[0][0];
    expect(arg.where).toEqual({
      status: { in: ["active", "quarantined"] },
      sources: { some: { integrationId: "int-1", sourceKind: { in: ["ad", "entra", "intune", "arc", "generic-api"] } } },
    });
    expect(arg.select.managedAgent).toEqual({ select: { lastSeenAt: true } });
  });

  it("returns an all-zero summary with no write and no Event when nothing qualifies", async () => {
    const out = await runPresenceVerification(opts());
    expect(out).toEqual({ candidates: 0, alreadyFresh: 0, viaAgent: 0, viaProbe: 0, viaPing: 0, pingUnreachable: 0, pingSkippedNoTarget: 0, pingSkippedDeadline: 0 });
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(eventLog.logEvent).not.toHaveBeenCalled();
  });
});

describe("runPresenceVerification — the cascade", () => {
  it("routes each asset to the cheapest fresh signal and writes only the evidence it found", async () => {
    asset.findMany.mockResolvedValue([
      row({ id: "fresh", lastSeen: ago(10 * 60_000), dnsName: "fresh.corp" }),
      row({ id: "agent", lastSeen: ago(48 * HOUR), managedAgent: { lastSeenAt: ago(60_000) } }),
      row({ id: "probe", monitored: true, monitorStatus: "recovering", lastMonitorAt: ago(30_000) }),
      row({ id: "pong", dnsName: "pong.corp" }),
      row({ id: "silent", hostname: "silent" }),
    ]);
    h.pingHost.mockImplementation(async (target: string) => ({ success: target === "pong.corp" }));
    const out = await runPresenceVerification(opts());
    expect(out).toEqual({ candidates: 5, alreadyFresh: 1, viaAgent: 1, viaProbe: 1, viaPing: 1, pingUnreachable: 1, pingSkippedNoTarget: 0, pingSkippedDeadline: 0 });
    const w = writes();
    expect(Object.keys(w).sort()).toEqual(["agent", "pong", "probe"]);
    expect(w.agent).toEqual({ lastSeen: ago(60_000), lastSeenSource: "agent" });
    expect(w.probe).toEqual({ lastSeen: ago(30_000), lastSeenSource: "probe" });
    expect(w.pong).toEqual({ lastSeen: NOW, lastSeenSource: "ping" });
    expect(h.pingHost).toHaveBeenCalledTimes(2);
    expect(h.pingHost).toHaveBeenCalledWith("pong.corp", 2_000);
  });

  it("a failed ping writes NOTHING", async () => {
    asset.findMany.mockResolvedValue([row({ id: "a", lastSeen: ago(72 * HOUR), dnsName: "a.corp" })]);
    const out = await runPresenceVerification(opts());
    expect(out.pingUnreachable).toBe(1);
    expect(asset.update).not.toHaveBeenCalled();
  });

  it("pings the DNS name first, then the hostname, then the IP (IPv6 included)", async () => {
    asset.findMany.mockResolvedValue([
      row({ id: "1", dnsName: "pc1.corp", hostname: "PC1", ipAddress: "10.0.0.1" }),
      row({ id: "2", hostname: " PC2 ", ipAddress: "10.0.0.2" }),
      row({ id: "3", ipAddress: "2001:db8::3" }),
    ]);
    await runPresenceVerification(opts());
    expect(h.pingHost.mock.calls.map((c) => c[0]).sort()).toEqual(["2001:db8::3", "PC2", "pc1.corp"]);
  });

  // Was a bug until 2026-11-16: a whitespace-only dnsName hid the hostname and the asset counted as "no target".
  it("falls back past a whitespace-only DNS name to the hostname", async () => {
    asset.findMany.mockResolvedValue([row({ id: "1", dnsName: "   ", hostname: "PC1", ipAddress: "10.0.0.1" })]);
    const out = await runPresenceVerification(opts());
    expect(out.pingSkippedNoTarget).toBe(0);
    expect(h.pingHost).toHaveBeenCalledWith("PC1", 2_000);
  });

  it("counts an asset with nothing to ping as skipped (no target)", async () => {
    asset.findMany.mockResolvedValue([row({ id: "a" }), row({ id: "b", hostname: "   " })]);
    const out = await runPresenceVerification(opts());
    expect(out.pingSkippedNoTarget).toBe(2);
    expect(h.pingHost).not.toHaveBeenCalled();
    expect(eventLog.logEvent.mock.calls[0][0].message).toMatch(/2 skipped \(no target\)/);
  });

  it("a monitored asset that is down still gets its lastSeen from an answered ping", async () => {
    asset.findMany.mockResolvedValue([row({ id: "a", monitored: true, monitorStatus: "down", lastMonitorAt: ago(1000), hostname: "a" })]);
    h.pingHost.mockResolvedValue({ success: true });
    const out = await runPresenceVerification(opts());
    expect(out.viaPing).toBe(1);
    expect(writes().a).toEqual({ lastSeen: NOW, lastSeenSource: "ping" });
  });
});

describe("runPresenceVerification — window, writes and bounds", () => {
  it("the window is pollInterval hours, floored at one hour", async () => {
    const r = row({ id: "a", lastSeen: ago(90 * 60_000) });
    asset.findMany.mockResolvedValue([r]);
    expect((await runPresenceVerification(opts({ pollIntervalHours: 2 }))).alreadyFresh).toBe(1);
    expect((await runPresenceVerification(opts({ pollIntervalHours: 0 }))).alreadyFresh).toBe(0);
    asset.findMany.mockResolvedValue([row({ id: "b", lastSeen: ago(50 * 60_000) })]);
    expect((await runPresenceVerification(opts({ pollIntervalHours: 0 }))).alreadyFresh).toBe(1);
  });

  it("batches the lastSeen writes in transactions of 200", async () => {
    asset.findMany.mockResolvedValue(Array.from({ length: 450 }, (_, i) => row({ id: `a${i}`, managedAgent: { lastSeenAt: ago(1000) } })));
    const out = await runPresenceVerification(opts());
    expect(out.viaAgent).toBe(450);
    expect(vi.mocked(prisma.$transaction).mock.calls.map((c: any[]) => c[0].length)).toEqual([200, 200, 50]);
  });

  it("caps pings in flight at 16", async () => {
    let inFlight = 0;
    let peak = 0;
    h.pingHost.mockImplementation(async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await Promise.resolve();
      await Promise.resolve();
      inFlight--;
      return { success: false };
    });
    asset.findMany.mockResolvedValue(Array.from({ length: 40 }, (_, i) => row({ id: `a${i}`, hostname: `h${i}` })));
    const out = await runPresenceVerification(opts());
    expect(out.pingUnreachable).toBe(40);
    expect(peak).toBe(16);
  });

  it("skips the pings left after the 3-minute deadline, counts them, and warns", async () => {
    h.pingHost.mockImplementation(async () => {
      await Promise.resolve(); // every worker has checked the deadline before the clock moves
      vi.setSystemTime(new Date(NOW.getTime() + 3 * 60_000 + 1));
      return { success: true };
    });
    asset.findMany.mockResolvedValue(Array.from({ length: 20 }, (_, i) => row({ id: `a${i}`, hostname: `h${i}` })));
    const out = await runPresenceVerification(opts());
    expect(out.viaPing).toBe(16);
    expect(out.pingSkippedDeadline).toBe(4);
    const ev = eventLog.logEvent.mock.calls[0][0];
    expect(ev.level).toBe("warning");
    expect(ev.message).toMatch(/4 skipped \(pass deadline\)/);
  });

  it("stops pinging after an abort without counting the rest", async () => {
    const ac = new AbortController();
    h.pingHost.mockImplementation(async () => {
      await Promise.resolve(); // the first 16 are already in flight
      ac.abort();
      return { success: false };
    });
    asset.findMany.mockResolvedValue(Array.from({ length: 30 }, (_, i) => row({ id: `a${i}`, hostname: `h${i}` })));
    const out = await runPresenceVerification(opts({ signal: ac.signal }));
    expect(h.pingHost).toHaveBeenCalledTimes(16);
    expect(out.pingUnreachable).toBe(16);
    expect(out.pingSkippedDeadline + out.pingSkippedNoTarget + out.viaPing).toBe(0);
  });

  it("writes one info Event with the summary", async () => {
    asset.findMany.mockResolvedValue([row({ id: "a", lastSeen: ago(1000) })]);
    await runPresenceVerification(opts());
    expect(eventLog.logEvent).toHaveBeenCalledTimes(1);
    const ev = eventLog.logEvent.mock.calls[0][0];
    expect(ev).toMatchObject({
      action: "integration.presence_verification", resourceType: "integration", resourceId: "int-1", resourceName: "Corp AD", actor: "discovery", level: "info",
      details: { candidates: 1, alreadyFresh: 1 },
    });
    expect(ev.message).toMatch(/1 candidate\(s\): 1 already fresh, 0 via agent heartbeat, 0 via monitor probe, 0 via ping; 0 unreachable \(unchanged\)$/);
  });
});
