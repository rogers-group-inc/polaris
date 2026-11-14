/**
 * tests/unit/pathCheckIngestService.test.ts — the own suite for
 * src/services/pathCheckIngestService.ts (business rule 85, with 85(c)'s TLS
 * baseline; CQ-T010).
 *
 * Complements pathCheckIngest.test.ts (the happy paths of both streams, the
 * server subject and the TLS Event shapes). This file pins the remaining
 * contract against the shared Prisma stub:
 *   - the pure helpers' edges (sampleTime with junk / equal / future input,
 *     excerptToKeep's cut, hopIp's normalisation, pathHashOf's
 *     trailing-silent-hop fold vs an inner silent hop, the TLS day maths);
 *   - samples: the stored row field by field (hash lower-cased, error cut at
 *     512, missing numbers null, a junk tlsNotAfter null), the "newest sample
 *     per check" update, lastFailAt only on a failure, an EQUAL timestamp still
 *     updating, the metrics, rule 85's "never touches monitorStatus";
 *   - TLS (85(c)): same expiry with a new issuer is no change, an equal-time
 *     late push skipped, the Event's day pluralisation and its host label
 *     fallbacks, the baseline columns written only when moved;
 *   - traceroutes: one hop-resolution query for every hop IP (distinct, valid
 *     only), primary-address over associated-IP, the interface name, the
 *     subnet alone, hops sorted by TTL, the incomplete note, reason default,
 *     the floor, and the transaction's source update.
 *
 * No network, no agent: the write buffer and the metrics are mocked.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { createHash } from "node:crypto";

const h = vi.hoisted(() => ({
  enqueue: vi.fn(),
  recordSamples: vi.fn(),
  recordChange: vi.fn(),
}));

vi.mock("../../src/db.js", () => import("./_dbStub.js"));
vi.mock("../../src/services/eventLogService.js", (orig) => import("./_eventLogStub.js").then((s) => s.withEventLogStubs(orig)));
vi.mock("../../src/services/sampleWriteBuffer.js", () => ({ enqueuePathCheckSamples: h.enqueue }));
vi.mock("../../src/metrics.js", () => ({ recordPathCheckSamples: h.recordSamples, recordPathCheckPathChange: h.recordChange }));

import { prisma } from "../../src/db.js";
import { resetDbStub, stubbed } from "./_dbStub.js";
import { eventLog, resetEventLogStub } from "./_eventLogStub.js";
import { MAX_EXCERPT_CHARS } from "../../src/utils/httpCheck.js";
import {
  PATH_CHANGE_EVENT_FLOOR_MS,
  POLARIS_SERVER_SUBJECT,
  TLS_CHANGE_EVENT_FLOOR_MS,
  excerptToKeep,
  hopIp,
  ingestPathCheckSamples,
  ingestPathCheckTraceroutes,
  pathHashOf,
  sampleTime,
  tlsExpiryDirection,
  tlsExpiryShiftDays,
  type PathCheckSampleInput,
  type PathCheckTracerouteInput,
} from "../../src/services/pathCheckIngestService.js";

const NOW = new Date("2026-05-01T12:00:00.000Z");
const iso = (msAgo: number) => new Date(NOW.getTime() - msAgo).toISOString();
const ASSET = "11111111-1111-1111-1111-111111111111";

interface Src {
  id: string; checkId: string; lastOk: boolean | null; lastPathHash: string | null; lastPathChangeEventAt: Date | null;
  lastSampleAt: Date | null; lastTlsNotAfter: Date | null; lastTlsIssuer: string | null; lastTlsChangeEventAt: Date | null;
  check: { name: string; keepBodyExcerpt: boolean };
}

function src(checkId: string, over: Partial<Src> = {}): Src {
  return {
    id: `src-${checkId}`, checkId, lastOk: null, lastPathHash: null, lastPathChangeEventAt: null, lastSampleAt: null,
    lastTlsNotAfter: null, lastTlsIssuer: null, lastTlsChangeEventAt: null, check: { name: `Check ${checkId}`, keepBodyExcerpt: false },
    ...over,
  };
}

const sources = (...rows: Src[]) => stubbed(prisma.pathCheckSource.findMany).mockResolvedValue(rows);
const enqueued = () => h.enqueue.mock.calls[0][0] as Array<Record<string, any>>;
const srcUpdates = () => stubbed(prisma.pathCheckSource.update).mock.calls.map((c) => c[0]);
const hashOf = (seq: string[]) => createHash("sha256").update(seq.join(",")).digest("hex");

beforeEach(() => {
  resetDbStub();
  resetEventLogStub();
  for (const f of Object.values(h)) f.mockReset();
  sources();
  stubbed(prisma.asset.findUnique).mockResolvedValue({ hostname: "web-01", ipAddress: "10.0.0.10" });
  stubbed(prisma.$queryRaw).mockResolvedValue([]);
});

// ─── Pure helpers ─────────────────────────────────────────────────────────────

describe("pure helpers", () => {
  it("sampleTime: missing or unparseable → now; past kept; future clamped; equal kept", () => {
    expect(sampleTime(undefined, NOW)).toBe(NOW);
    expect(sampleTime("not a date", NOW)).toBe(NOW);
    expect(sampleTime(iso(5000), NOW).getTime()).toBe(NOW.getTime() - 5000);
    expect(sampleTime(iso(-5000), NOW)).toBe(NOW);
    expect(sampleTime(NOW.toISOString(), NOW).getTime()).toBe(NOW.getTime());
  });

  it("excerptToKeep: nothing for an empty excerpt, cut to MAX_EXCERPT_CHARS on a failure", () => {
    expect(excerptToKeep({ ok: false, bodyExcerpt: "" }, true)).toBeNull();
    expect(excerptToKeep({ ok: false, bodyExcerpt: null }, true)).toBeNull();
    expect(excerptToKeep({ ok: true, bodyExcerpt: "x" }, false)).toBeNull();
    expect(excerptToKeep({ ok: true, bodyExcerpt: "x" }, true)).toBe("x");
    expect(excerptToKeep({ ok: false, bodyExcerpt: "y".repeat(MAX_EXCERPT_CHARS + 50) }, false)).toHaveLength(MAX_EXCERPT_CHARS);
    expect(excerptToKeep({ ok: false, bodyExcerpt: "z".repeat(MAX_EXCERPT_CHARS) }, false)).toHaveLength(MAX_EXCERPT_CHARS);
  });

  it("hopIp: trims, accepts IPv4 / IPv6, silences blanks, stars and junk", () => {
    expect(hopIp(" 10.0.0.1 ")).toBe("10.0.0.1");
    expect(hopIp("2001:db8::1")).toBe("2001:db8::1");
    for (const v of [null, undefined, "", "  ", "*", "router.local", "999.1.1.1"]) expect(hopIp(v)).toBeNull();
  });

  it("pathHashOf: a silent INNER hop is part of the path; trailing silent hops are not", () => {
    expect(pathHashOf([{ ip: "a" }, { ip: null }, { ip: "b" }])).toBe(hashOf(["a", "*", "b"]));
    expect(pathHashOf([{ ip: "a" }, { ip: "b" }, { ip: null }, { ip: null }])).toBe(pathHashOf([{ ip: "a" }, { ip: "b" }]));
    expect(pathHashOf([{ ip: "a" }, { ip: null }, { ip: "b" }])).not.toBe(pathHashOf([{ ip: "a" }, { ip: "b" }]));
  });

  it("pathHashOf: an all-silent trace hashes like no hops at all", () => {
    expect(pathHashOf([{ ip: null }, { ip: null }])).toBe(pathHashOf([]));
    expect(pathHashOf([])).toBe(hashOf([]));
  });

  it("tls day maths: direction, signed whole days, rounding", () => {
    const a = new Date("2026-06-01T00:00:00Z");
    expect(tlsExpiryDirection(a, new Date(a))).toBeNull();
    expect(tlsExpiryDirection(a, new Date(a.getTime() + 1))).toBe("later");
    expect(tlsExpiryDirection(a, new Date(a.getTime() - 1))).toBe("earlier");
    expect(tlsExpiryShiftDays(a, new Date(a.getTime() + 90 * 86_400_000))).toBe(90);
    expect(tlsExpiryShiftDays(a, new Date(a.getTime() - 36 * 3_600_000))).toBe(-1);
    expect(tlsExpiryShiftDays(a, new Date(a.getTime() + 11 * 3_600_000))).toBe(0);
  });
});

// ─── ingestPathCheckSamples ───────────────────────────────────────────────────

describe("ingestPathCheckSamples", () => {
  const sample = (over: Partial<PathCheckSampleInput> = {}): PathCheckSampleInput => ({ checkId: "c1", ok: true, timestamp: iso(1000), ...over });

  it("reads only the pushing host's source rows for the distinct named checks", async () => {
    await ingestPathCheckSamples(ASSET, [sample(), sample(), sample({ checkId: "c2" })], NOW);
    expect(stubbed(prisma.pathCheckSource.findMany).mock.calls[0][0].where).toEqual({ assetId: ASSET, checkId: { in: ["c1", "c2"] } });
  });

  it("the server subject reads the source with assetId NULL", async () => {
    await ingestPathCheckSamples(POLARIS_SERVER_SUBJECT, [sample()], NOW);
    expect(stubbed(prisma.pathCheckSource.findMany).mock.calls[0][0].where.assetId).toBeNull();
  });

  it("an empty push stores nothing and updates nothing", async () => {
    expect(await ingestPathCheckSamples(ASSET, [], NOW)).toEqual({ accepted: 0, rejected: 0 });
    expect(h.enqueue).toHaveBeenCalledWith([]);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("stores each field: hash lower-cased, error cut at 512, absent numbers null, fast cadence, no hop count", async () => {
    sources(src("c1"));
    await ingestPathCheckSamples(ASSET, [sample({ ok: false, latencyMs: 12, httpStatus: 503, bodySha256: "ABCDEF", bodyBytes: 10, error: "e".repeat(600), resolvedIp: "1.2.3.4", tlsIssuer: "R3", bodyMatched: false })], NOW);
    const [row] = enqueued();
    expect(row).toEqual({
      assetId: ASSET, timestamp: new Date(iso(1000)), cadence: "fast", checkId: "c1", ok: false, latencyMs: 12,
      dnsMs: null, connectMs: null, tlsMs: null, ttfbMs: null, httpStatus: 503, bodyMatched: false, bodySha256: "abcdef",
      bodyBytes: 10, bodyExcerpt: null, error: "e".repeat(512), resolvedIp: "1.2.3.4", tlsNotAfter: null, tlsIssuer: "R3", hopCount: null,
    });
  });

  it("a junk tlsNotAfter is stored as null and never moves the baseline", async () => {
    sources(src("c1"));
    await ingestPathCheckSamples(ASSET, [sample({ tlsNotAfter: "garbage" })], NOW);
    expect(enqueued()[0].tlsNotAfter).toBeNull();
    expect(srcUpdates()[0].data).not.toHaveProperty("lastTlsNotAfter");
  });

  it("keeps a passing run's excerpt when the check asks for it", async () => {
    sources(src("c1", { check: { name: "C", keepBodyExcerpt: true } }));
    await ingestPathCheckSamples(ASSET, [sample({ bodyExcerpt: "<html>" })], NOW);
    expect(enqueued()[0].bodyExcerpt).toBe("<html>");
  });

  it("counts rejected samples for checks this host is not a source of", async () => {
    sources(src("c1"));
    const out = await ingestPathCheckSamples(ASSET, [sample(), sample({ checkId: "foreign" }), sample({ checkId: "foreign2", ok: false })], NOW);
    expect(out).toEqual({ accepted: 1, rejected: 2 });
    expect(enqueued()).toHaveLength(1);
  });

  it("records ok / fail / rejected metrics", async () => {
    sources(src("c1"));
    await ingestPathCheckSamples(ASSET, [sample(), sample({ ok: false, timestamp: iso(500) }), sample({ checkId: "x" })], NOW);
    expect(h.recordSamples.mock.calls).toEqual([["ok", 1], ["fail", 1], ["rejected", 1]]);
  });

  it("the NEWEST sample per check drives the latest-result columns; a failure stamps lastFailAt", async () => {
    sources(src("c1"), src("c2"));
    await ingestPathCheckSamples(ASSET, [
      sample({ timestamp: iso(1000), ok: false, error: "newest", latencyMs: 9 }),
      sample({ timestamp: iso(5000), ok: true, latencyMs: 1 }),
      sample({ checkId: "c2", timestamp: iso(2000), ok: true, httpStatus: 200, resolvedIp: "5.6.7.8" }),
    ], NOW);
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    const byId = new Map(srcUpdates().map((u) => [u.where.id, u.data]));
    expect(byId.get("src-c1")).toEqual({ lastOk: false, lastSampleAt: new Date(iso(1000)), lastLatencyMs: 9, lastHttpStatus: null, lastError: "newest", lastResolvedIp: null, lastFailAt: new Date(iso(1000)) });
    expect(byId.get("src-c2")).toEqual({ lastOk: true, lastSampleAt: new Date(iso(2000)), lastLatencyMs: null, lastHttpStatus: 200, lastError: null, lastResolvedIp: "5.6.7.8" });
  });

  it("an older late push is stored but leaves the latest result; an EQUAL timestamp still updates", async () => {
    sources(src("c1", { lastSampleAt: new Date(iso(1000)) }), src("c2", { lastSampleAt: new Date(iso(1000)) }));
    await ingestPathCheckSamples(ASSET, [sample({ timestamp: iso(2000) }), sample({ checkId: "c2", timestamp: iso(1000) })], NOW);
    expect(enqueued()).toHaveLength(2);
    expect(srcUpdates().map((u) => u.where.id)).toEqual(["src-c2"]);
  });

  it("never touches the asset's monitor state (rule 85)", async () => {
    sources(src("c1"));
    await ingestPathCheckSamples(ASSET, [sample({ ok: false })], NOW);
    expect(prisma.asset.update).not.toHaveBeenCalled();
    expect(prisma.asset.updateMany).not.toHaveBeenCalled();
  });
});

// ─── TLS baseline (85(c)) ─────────────────────────────────────────────────────

describe("TLS baseline (rule 85(c))", () => {
  const D1 = new Date("2026-07-01T00:00:00Z");
  const D2 = new Date("2026-07-02T00:00:00Z");
  const D90 = new Date("2026-09-29T00:00:00Z");
  const tlsSample = (notAfter: Date, msAgo: number, over: Partial<PathCheckSampleInput> = {}): PathCheckSampleInput =>
    ({ checkId: "c1", ok: true, timestamp: iso(msAgo), tlsNotAfter: notAfter.toISOString(), tlsIssuer: "R3", ...over });

  it("the same expiry under a new issuer is no change: no Event, baseline untouched", async () => {
    sources(src("c1", { lastTlsNotAfter: D1, lastTlsIssuer: "R3" }));
    await ingestPathCheckSamples(ASSET, [tlsSample(D1, 1000, { tlsIssuer: "E5" })], NOW);
    expect(eventLog.logEvent).not.toHaveBeenCalled();
    expect(srcUpdates()[0].data).not.toHaveProperty("lastTlsIssuer");
  });

  it("the first certificate is the baseline: columns written, no Event", async () => {
    sources(src("c1"));
    await ingestPathCheckSamples(ASSET, [tlsSample(D1, 1000)], NOW);
    expect(eventLog.logEvent).not.toHaveBeenCalled();
    expect(srcUpdates()[0].data).toMatchObject({ lastTlsNotAfter: D1, lastTlsIssuer: "R3", lastTlsChangeEventAt: null });
  });

  it("a renewal one day later is singular 'day', info level, naming the host", async () => {
    sources(src("c1", { lastTlsNotAfter: D1, lastTlsIssuer: "R3" }));
    await ingestPathCheckSamples(ASSET, [tlsSample(D2, 1000, { tlsIssuer: "R10" })], NOW);
    const ev = eventLog.logEvent.mock.calls[0][0];
    expect(ev).toMatchObject({ action: "path_check.tls_cert_changed", resourceType: "asset", resourceId: ASSET, resourceName: "web-01", level: "info" });
    expect(ev.message).toBe('TLS certificate seen from web-01 for path check "Check c1" renewed — expiry moved 1 day later (2026-07-01 → 2026-07-02)');
    expect(ev.details).toEqual({ checkId: "c1", checkName: "Check c1", direction: "later", shiftDays: 1, previousNotAfter: D1.toISOString(), notAfter: D2.toISOString(), previousIssuer: "R3", issuer: "R10" });
    expect(srcUpdates()[0].data).toMatchObject({ lastTlsNotAfter: D2, lastTlsIssuer: "R10", lastTlsChangeEventAt: new Date(iso(1000)) });
  });

  it("an earlier replacement is a warning in plural 'days EARLIER'", async () => {
    sources(src("c1", { lastTlsNotAfter: D90 }));
    await ingestPathCheckSamples(ASSET, [tlsSample(D1, 1000)], NOW);
    const ev = eventLog.logEvent.mock.calls[0][0];
    expect(ev.level).toBe("warning");
    expect(ev.message).toContain("replaced — expiry moved 90 days EARLIER");
    expect(ev.details?.shiftDays).toBe(-90);
  });

  it("a push at exactly the source's latest time is skipped for TLS", async () => {
    sources(src("c1", { lastTlsNotAfter: D1, lastSampleAt: new Date(iso(1000)) }));
    await ingestPathCheckSamples(ASSET, [tlsSample(D2, 1000)], NOW);
    expect(eventLog.logEvent).not.toHaveBeenCalled();
  });

  it("inside the floor of the last Event the baseline moves silently; at the floor an Event is written", async () => {
    sources(src("c1", { lastTlsNotAfter: D1, lastTlsChangeEventAt: new Date(NOW.getTime() - TLS_CHANGE_EVENT_FLOOR_MS + 60_000) }));
    await ingestPathCheckSamples(ASSET, [tlsSample(D2, 0)], NOW);
    expect(eventLog.logEvent).not.toHaveBeenCalled();
    expect(srcUpdates()[0].data).toMatchObject({ lastTlsNotAfter: D2 });
    resetDbStub();
    sources(src("c1", { lastTlsNotAfter: D1, lastTlsChangeEventAt: new Date(NOW.getTime() - TLS_CHANGE_EVENT_FLOOR_MS) }));
    stubbed(prisma.asset.findUnique).mockResolvedValue({ hostname: "web-01", ipAddress: null });
    await ingestPathCheckSamples(ASSET, [tlsSample(D2, 0)], NOW);
    expect(eventLog.logEvent).toHaveBeenCalledTimes(1);
  });

  it("several readings in one push are walked oldest first against each other", async () => {
    sources(src("c1", { lastTlsNotAfter: D1 }));
    await ingestPathCheckSamples(ASSET, [tlsSample(D1, 1000), tlsSample(D90, 30 * 60_000)], NOW);
    // oldest (D90, 30 min ago) is a change from D1; newest (D1) a change back 29 min later — past the floor
    const msgs = eventLog.logEvent.mock.calls.map((c) => c[0].details?.direction);
    expect(msgs).toEqual(["later", "earlier"]);
    expect(srcUpdates()[0].data).toMatchObject({ lastTlsNotAfter: D1 });
  });

  it("the host label falls back to the IP, then the asset id; the asset is read only when there is an Event", async () => {
    sources(src("c1"));
    await ingestPathCheckSamples(ASSET, [tlsSample(D1, 1000)], NOW);
    expect(prisma.asset.findUnique).not.toHaveBeenCalled();

    sources(src("c1", { lastTlsNotAfter: D90 }));
    stubbed(prisma.asset.findUnique).mockResolvedValue({ hostname: null, ipAddress: "10.9.9.9" });
    await ingestPathCheckSamples(ASSET, [tlsSample(D1, 1000)], NOW);
    expect(eventLog.logEvent.mock.calls[0][0].resourceName).toBe("10.9.9.9");

    stubbed(prisma.asset.findUnique).mockResolvedValue(null);
    await ingestPathCheckSamples(ASSET, [tlsSample(D1, 1000)], NOW);
    expect(eventLog.logEvent.mock.calls[1][0].resourceName).toBe(ASSET);
  });

  it("a failed run with no certificate never reads as a change", async () => {
    sources(src("c1", { lastTlsNotAfter: D1 }));
    await ingestPathCheckSamples(ASSET, [{ checkId: "c1", ok: false, timestamp: iso(1000), error: "ECONNREFUSED" }], NOW);
    expect(eventLog.logEvent).not.toHaveBeenCalled();
    expect(srcUpdates()[0].data).not.toHaveProperty("lastTlsNotAfter");
  });
});

// ─── ingestPathCheckTraceroutes ───────────────────────────────────────────────

describe("ingestPathCheckTraceroutes", () => {
  const trace = (over: Partial<PathCheckTracerouteInput> = {}): PathCheckTracerouteInput => ({
    checkId: "c1", timestamp: iso(1000), destinationIp: "8.8.8.8", complete: true,
    hops: [{ ttl: 1, ip: "10.0.0.1", rttMs: [1] }, { ttl: 2, ip: "8.8.8.8", rttMs: [9, 10] }], ...over,
  });
  const created = () => stubbed(prisma.assetPathCheckTraceroute.createMany).mock.calls[0][0].data as Array<Record<string, any>>;

  it("all rejected: no hop query, no write", async () => {
    const out = await ingestPathCheckTraceroutes(ASSET, [trace({ checkId: "nope" })], NOW);
    expect(out).toEqual({ accepted: 0, rejected: 1 });
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("resolves every hop IP in ONE query, distinct and valid only", async () => {
    sources(src("c1"), src("c2"));
    await ingestPathCheckTraceroutes(ASSET, [
      trace({ hops: [{ ttl: 1, ip: "10.0.0.1", rttMs: [] }, { ttl: 2, ip: "*", rttMs: [] }, { ttl: 3, ip: "junk", rttMs: [] }] }),
      trace({ checkId: "c2", hops: [{ ttl: 1, ip: "10.0.0.1", rttMs: [] }, { ttl: 2, ip: "10.0.0.2", rttMs: [] }] }),
    ], NOW);
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
    expect(stubbed(prisma.$queryRaw).mock.calls[0][1]).toEqual(["10.0.0.1", "10.0.0.2"]);
  });

  it("a trace of only silent hops makes no hop query", async () => {
    sources(src("c1"));
    await ingestPathCheckTraceroutes(ASSET, [trace({ hops: [{ ttl: 1, ip: null, rttMs: [] }] })], NOW);
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
  });

  it("decorates hops: the primary-address asset wins over an associated IP; an associated hit carries the port; a subnet alone is kept", async () => {
    sources(src("c1"));
    stubbed(prisma.$queryRaw).mockResolvedValue([
      { ip: "10.0.0.1", primary_id: "a-p", primary_hostname: "core", primary_status: "up", assoc_id: "a-x", assoc_hostname: "fw", assoc_status: "down", assoc_iface: "port1", subnet_cidr: "10.0.0.0/24" },
      { ip: "10.0.0.2", primary_id: null, primary_hostname: null, primary_status: null, assoc_id: "a-x", assoc_hostname: "fw", assoc_status: "up", assoc_iface: "wan1", subnet_cidr: null },
      { ip: "10.0.0.3", primary_id: null, primary_hostname: null, primary_status: null, assoc_id: null, assoc_hostname: null, assoc_status: null, assoc_iface: null, subnet_cidr: "10.0.0.0/22" },
    ]);
    await ingestPathCheckTraceroutes(ASSET, [trace({ hops: [
      { ttl: 3, ip: "10.0.0.3", rttMs: [3] },
      { ttl: 1, ip: "10.0.0.1", rdns: "  core.lan ", rttMs: [1] },
      { ttl: 2, ip: "10.0.0.2", rdns: "  ", rttMs: [2] },
      { ttl: 4, ip: "*", rttMs: [] },
    ] })], NOW);
    expect(created()[0].hops).toEqual([
      { ttl: 1, ip: "10.0.0.1", rdns: "core.lan", rttMs: [1], assetId: "a-p", hostname: "core", monitorStatus: "up", subnetCidr: "10.0.0.0/24" },
      { ttl: 2, ip: "10.0.0.2", rdns: null, rttMs: [2], assetId: "a-x", hostname: "fw", monitorStatus: "up", interfaceName: "wan1" },
      { ttl: 3, ip: "10.0.0.3", rdns: null, rttMs: [3], subnetCidr: "10.0.0.0/22" },
      { ttl: 4, ip: null, rdns: null, rttMs: [] },
    ]);
  });

  it("stores the row: hop count, hash over the TTL-sorted IPs, reason default 'scheduled', note null", async () => {
    sources(src("c1"));
    await ingestPathCheckTraceroutes(ASSET, [trace({ hops: [{ ttl: 2, ip: "8.8.8.8", rttMs: [] }, { ttl: 1, ip: "10.0.0.1", rttMs: [] }], destinationIp: undefined })], NOW);
    expect(created()[0]).toMatchObject({ assetId: ASSET, checkId: "c1", destinationIp: null, complete: true, hopCount: 2, pathHash: hashOf(["10.0.0.1", "8.8.8.8"]), reason: "scheduled", note: null, timestamp: new Date(iso(1000)) });
  });

  it("keeps a transition reason and a note", async () => {
    sources(src("c1"));
    await ingestPathCheckTraceroutes(ASSET, [trace({ reason: "transition", note: "ran after failure" })], NOW);
    expect(created()[0]).toMatchObject({ reason: "transition", note: "ran after failure" });
  });

  it("the first trace is a baseline: no Event, source stamped", async () => {
    sources(src("c1"));
    await ingestPathCheckTraceroutes(ASSET, [trace()], NOW);
    expect(eventLog.logEvent).not.toHaveBeenCalled();
    expect(h.recordChange).not.toHaveBeenCalled();
    expect(srcUpdates()[0]).toEqual({ where: { id: "src-c1" }, data: { lastPathHash: hashOf(["10.0.0.1", "8.8.8.8"]), lastTracerouteAt: new Date(iso(1000)), lastHopCount: 2, lastTracerouteComplete: true, lastPathChangeEventAt: null } });
  });

  it("the same path at another latency, or timing out at a later TTL, is no change", async () => {
    sources(src("c1", { lastPathHash: hashOf(["10.0.0.1", "8.8.8.8"]) }));
    await ingestPathCheckTraceroutes(ASSET, [trace({ complete: false, hops: [{ ttl: 1, ip: "10.0.0.1", rttMs: [50] }, { ttl: 2, ip: "8.8.8.8", rttMs: [99] }, { ttl: 3, ip: null, rttMs: [] }] })], NOW);
    expect(eventLog.logEvent).not.toHaveBeenCalled();
  });

  it("a changed path writes a warning naming the host, with previous hops unknown across pushes", async () => {
    sources(src("c1", { lastPathHash: "old-hash" }));
    await ingestPathCheckTraceroutes(ASSET, [trace({ complete: false })], NOW);
    expect(h.recordChange).toHaveBeenCalledTimes(1);
    const ev = eventLog.logEvent.mock.calls[0][0];
    expect(ev).toMatchObject({ action: "path_check.path_changed", resourceType: "asset", resourceId: ASSET, resourceName: "web-01", level: "warning" });
    expect(ev.message).toBe('Path from web-01 for path check "Check c1" changed (2 hops, incomplete)');
    expect(ev.details).toEqual({ checkId: "c1", checkName: "Check c1", destinationIp: "8.8.8.8", previousHops: null, hops: ["10.0.0.1", "8.8.8.8"], previousPathHash: "old-hash", pathHash: hashOf(["10.0.0.1", "8.8.8.8"]) });
    expect(srcUpdates()[0].data.lastPathChangeEventAt).toEqual(new Date(iso(1000)));
  });

  it("within one push, a change names the previous trace's hops; the floor holds back a second Event", async () => {
    sources(src("c1"));
    await ingestPathCheckTraceroutes(ASSET, [
      trace({ timestamp: iso(60_000), hops: [{ ttl: 1, ip: "10.0.0.1", rttMs: [] }] }),
      trace({ timestamp: iso(30_000), hops: [{ ttl: 1, ip: "10.0.0.2", rttMs: [] }] }),
      trace({ timestamp: iso(1000), hops: [{ ttl: 1, ip: "10.0.0.1", rttMs: [] }] }),
    ], NOW);
    expect(eventLog.logEvent).toHaveBeenCalledTimes(1);
    expect(eventLog.logEvent.mock.calls[0][0].details).toMatchObject({ previousHops: ["10.0.0.1"], hops: ["10.0.0.2"] });
    expect(created()).toHaveLength(3);
    expect(srcUpdates()).toHaveLength(1);
    expect(srcUpdates()[0].data).toMatchObject({ lastPathHash: hashOf(["10.0.0.1"]), lastTracerouteAt: new Date(iso(1000)), lastPathChangeEventAt: new Date(iso(30_000)) });
  });

  it("orders a push oldest first even when sent newest first", async () => {
    sources(src("c1"));
    await ingestPathCheckTraceroutes(ASSET, [trace({ timestamp: iso(1000) }), trace({ timestamp: iso(9000) })], NOW);
    expect(created().map((c) => c.timestamp.getTime())).toEqual([NOW.getTime() - 9000, NOW.getTime() - 1000]);
  });

  it("a change exactly at the floor after the last Event is written", async () => {
    sources(src("c1", { lastPathHash: "old", lastPathChangeEventAt: new Date(NOW.getTime() - 1000 - PATH_CHANGE_EVENT_FLOOR_MS) }));
    await ingestPathCheckTraceroutes(ASSET, [trace()], NOW);
    expect(eventLog.logEvent).toHaveBeenCalledTimes(1);
  });

  it("the server subject names the check and reads no asset", async () => {
    sources(src("c1", { lastPathHash: "old" }));
    await ingestPathCheckTraceroutes(POLARIS_SERVER_SUBJECT, [trace()], NOW);
    expect(prisma.asset.findUnique).not.toHaveBeenCalled();
    expect(eventLog.logEvent.mock.calls[0][0]).toMatchObject({ resourceType: "path-check", resourceId: "c1", resourceName: "Check c1", details: { source: "server" } });
    expect(eventLog.logEvent.mock.calls[0][0].message).toContain("Path from Polaris server");
  });

  it("counts accepted and rejected together", async () => {
    sources(src("c1"));
    expect(await ingestPathCheckTraceroutes(ASSET, [trace(), trace({ checkId: "x" })], NOW)).toEqual({ accepted: 1, rejected: 1 });
  });

  // NOTE (not asserted as a bug — no rule states it): unlike the sample stream,
  // the traceroute stream has no late-push guard. An older trace arriving after
  // a newer one is compared against the newer hash and rewinds the source's
  // latest-trace columns. Pinned as current behaviour.
  it("current behaviour: an older trace pushed late is still compared and rewinds lastTracerouteAt", async () => {
    sources(src("c1", { lastPathHash: "newer-hash" }));
    await ingestPathCheckTraceroutes(ASSET, [trace({ timestamp: iso(3_600_000) })], NOW);
    expect(eventLog.logEvent).toHaveBeenCalledTimes(1);
    expect(srcUpdates()[0].data.lastTracerouteAt).toEqual(new Date(iso(3_600_000)));
  });
});
