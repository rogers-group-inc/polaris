/**
 * tests/integration/probeLossQuery.test.ts
 *
 * Integration tests for src/services/probeLossQuery.ts —
 * `queryProbeLossRatios`. The whole function IS one raw SQL statement (a
 * grouped aggregate over the window), so it's exercised against a live Postgres
 * rather than mocked.
 *
 * Skips cleanly when DATABASE_URL isn't reachable; see _helpers.ts.
 *
 * Coverage:
 *   - EVERY MISS COUNTS: the anchor that used to trim the window is gone, and
 *     Asset.recoveryStartedAt must be ignored — including for the flapping
 *     device the anchor reported as ~0% lossy forever.
 *   - EXCEPT the misses taken while the device was DOWN (`assetDown`, business
 *     rule 29h): those are the outage, and the down automation owns it. The
 *     misses below the threshold still count, and an unstamped row still
 *     counts — the exclusion is not retroactive.
 *   - Engine mode keeps 0%-loss assets (hysteresis recovery); widget mode
 *     (onlyLossy) hides them and orders lossiest-first.
 *   - assetIds scoping + the window bound.
 *   - probeKind: this query counts EVERY kind, which is the entire reason the
 *     ICMP loss sweep exists — and a burst row is weighed by its PACKETS.
 */

import { it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { prisma } from "../../src/db.js";
import { dbDescribe, dbReachable } from "./_helpers.js";
import { queryProbeLossRatios } from "../../src/services/probeLossQuery.js";
import { probeLossSeriesFrom } from "../../src/services/alertChartService.js";

const d = dbDescribe;

// Fixed ids keep the GROUP BY deterministic and scope the cleanup. The sample
// tables carry assetId but no FK to Asset (TimescaleDB hypertables — see
// polaris-change-impact cross-cutting/tiered-sample-retention), so no real Asset rows are needed — the
// query's join to assets is a LEFT JOIN precisely so a sample row whose asset
// is gone still counts. The recovery-anchor block below creates real rows,
// because the anchor lives on one.
const A = "00000000-0000-0000-0000-0000000000b1";
const B = "00000000-0000-0000-0000-0000000000b2";
const ALL = [A, B];

/** `minutesAgo` before now, as the naive-UTC Date Prisma writes. */
function ago(minutesAgo: number): Date {
  return new Date(Date.now() - minutesAgo * 60 * 1000);
}

/**
 * Seed one probe per minute for `assetId`, oldest first: `pattern[i]` is the
 * success flag at (pattern.length - i) minutes ago. Reads like a timeline —
 * "F F F S S" is "failed three minutes, then came back".
 */
async function seedProbes(assetId: string, pattern: boolean[], probeKind?: string): Promise<void> {
  await prisma.assetMonitorSample.createMany({
    data: pattern.map((success, i) => ({
      assetId,
      timestamp: ago(pattern.length - i),
      success,
      responseTimeMs: success && !probeKind ? 10 : null,
      ...(probeKind ? { probeKind } : {}),
    })),
  });
}

const F = false, S = true;

/**
 * Seed ONE OUTAGE as the probe path actually writes it: `onset` failures that
 * could not yet be stamped (nobody knows the first missed poll begins an
 * outage) followed by `declared` failures stamped `assetDown`, oldest first,
 * ending `endMinutesAgo` before now. The onset is what makes the RUN the unit
 * of exclusion rather than the marker (business rule 29h).
 */
async function seedOutage(
  assetId: string,
  onset: number,
  declared: number,
  endMinutesAgo: number,
): Promise<void> {
  const total = onset + declared;
  await prisma.assetMonitorSample.createMany({
    data: Array.from({ length: total }, (_, i) => ({
      assetId,
      timestamp: ago(endMinutesAgo + total - i),
      success: false,
      responseTimeMs: null,
      ...(i >= onset ? { assetDown: true } : {}),
    })),
  });
}

/**
 * Seed ICMP BURST rows: one row per entry carrying packetsSent/packetsReceived,
 * oldest first at minute granularity. `success` is derived the way the sweep
 * derives it (received > 0), because the query has to keep agreeing with that
 * invariant — a burst that got one reply back is a "successful" row and an
 * 80%-lossy reading, and conflating the two is the bug these tests exist for.
 */
async function seedBursts(
  assetId: string,
  bursts: Array<[sent: number, received: number]>,
): Promise<void> {
  await prisma.assetMonitorSample.createMany({
    data: bursts.map(([sent, received], i) => ({
      assetId,
      timestamp: ago(bursts.length - i),
      success: received > 0,
      responseTimeMs: null,
      probeKind: "icmp",
      packetsSent: sent,
      packetsReceived: received,
    })),
  });
}

/**
 * Seed explicit rows at second granularity. The two-transport cases need the
 * ordering to be unambiguous: `seedProbes` above is minute-granular per call, so
 * calling it twice for one asset interleaves rows onto identical timestamps and
 * the first-success anchor lands somewhere the test didn't intend.
 */
async function seedAt(
  assetId: string,
  rows: Array<{ secondsAgo: number; success: boolean; probeKind?: string }>,
): Promise<void> {
  await prisma.assetMonitorSample.createMany({
    data: rows.map((r) => ({
      assetId,
      timestamp: new Date(Date.now() - r.secondsAgo * 1000),
      success: r.success,
      responseTimeMs: r.success && !r.probeKind ? 10 : null,
      ...(r.probeKind ? { probeKind: r.probeKind } : {}),
    })),
  });
}

beforeAll(async () => {
  if (!dbReachable) return;
  await prisma.$connect();
});

afterAll(async () => {
  if (!dbReachable) return;
  await prisma.assetMonitorSample.deleteMany({ where: { assetId: { in: ALL } } });
  await prisma.asset.deleteMany({ where: { id: { in: ALL } } });
  await prisma.$disconnect();
});

beforeEach(async () => {
  if (!dbReachable) return;
  await prisma.assetMonitorSample.deleteMany({ where: { assetId: { in: ALL } } });
  await prisma.asset.deleteMany({ where: { id: { in: ALL } } });
});

/** A real Asset row carrying the recovery anchor the query joins for. */
async function seedAssetWithRecovery(assetId: string, recoveryStartedAt: Date | null): Promise<void> {
  await prisma.asset.create({
    data: { id: assetId, hostname: `loss-${assetId.slice(-2)}`, assetType: "server", status: "active", recoveryStartedAt },
  });
}

d("queryProbeLossRatios — every miss in the window counts", () => {
  it("counts an outage that preceded recovery — the case the anchor used to hide", async () => {
    // Ten failures then two successes. The first-success anchor made this 0%;
    // it is 83%, and that is the honest reading of the last twelve probes.
    await seedProbes(A, [F, F, F, F, F, F, F, F, F, F, S, S]);
    const rows = await queryProbeLossRatios({ sinceMinutes: 60, assetIds: [A] });
    expect(Number(rows[0]!.total)).toBe(12);
    expect(Number(rows[0]!.failed)).toBe(10);
  });

  it("keeps measuring a device that flaps to down and back every cycle", async () => {
    // THE BUG THE ANCHOR CAUSED. Every recovery out of `down` re-stamped
    // Asset.recoveryStartedAt, collapsing the window to the last few probes, so
    // a device losing half its packets reported ~0% loss forever. The stamp is
    // still written and must now be ignored.
    await seedAssetWithRecovery(A, ago(1));
    await seedProbes(A, [S, F, S, F, S, F, S, F]);
    const rows = await queryProbeLossRatios({ sinceMinutes: 60, assetIds: [A] });
    expect(Number(rows[0]!.total)).toBe(8);
    expect(Number(rows[0]!.failed)).toBe(4);
  });

  it("counts a leading failure run that no success precedes", async () => {
    // Previously an asset with zero successes was dropped outright. It now
    // reads 100%, and whether that may ALERT is the engine's decision (the
    // answering gate and the ignoreAtOrAbove ceiling), not this query's.
    await seedProbes(A, [F, F, F, F, F]);
    const rows = await queryProbeLossRatios({ sinceMinutes: 60, assetIds: [A] });
    expect(rows).toHaveLength(1);
    expect(Number(rows[0]!.failed)).toBe(Number(rows[0]!.total));
  });

  it("surfaces the fully-dark asset in widget mode with no opt-in flag", async () => {
    // This is what includeFullyDown used to buy. Vanishing read as "no loss",
    // the opposite of the truth.
    await seedProbes(A, [F, F, F]);
    const rows = await queryProbeLossRatios({
      sinceMinutes: 60, assetIds: [A], onlyLossy: true, limit: 10,
    });
    expect(rows).toHaveLength(1);
    expect(Number(rows[0]!.failed)).toBe(Number(rows[0]!.total));
  });

  it("ignores Asset.recoveryStartedAt entirely", async () => {
    // The column is still stamped by the probe path; nothing may read it.
    await seedAssetWithRecovery(A, ago(2));
    await seedProbes(A, [F, F, F, F, S, S]);
    const rows = await queryProbeLossRatios({ sinceMinutes: 60, assetIds: [A] });
    expect(Number(rows[0]!.total)).toBe(6);
    expect(Number(rows[0]!.failed)).toBe(4);
  });
});

d("queryProbeLossRatios — a miss taken while DOWN is the outage, not loss", () => {
  it("drops the whole outage run a recovered device is still carrying", async () => {
    // PROD, 2026-09-03. A FortiSwitch dark for twelve minutes came back, and
    // its 30-minute window still read 40% — under any sensible
    // ignoreAtOrAbove ceiling — so a "High packet loss" WARNING landed minutes
    // AFTER the recovery, about the outage its down alert had already reported.
    // The answering gate cannot see this case: by the time it fires, the
    // device is answering again.
    await seedOutage(A, 2, 10, 3);          // 12 dark minutes, ending 3 min ago
    await seedProbes(A, [S, S, S]);         // then answering again
    const rows = await queryProbeLossRatios({ sinceMinutes: 60, assetIds: [A] });
    expect(Number(rows[0]!.total)).toBe(3);
    expect(Number(rows[0]!.failed)).toBe(0);
  });

  it("drops the ONSET too — the misses that could not yet be stamped", async () => {
    // The marker can only go on from the probe that DECLARES the outage. Had
    // only the stamped rows been dropped, the 2 onset misses would sit in a
    // denominator the exclusion had already shrunk and read 40% here — still
    // over the seeded rule's 10% threshold, a full window after recovery.
    await seedOutage(A, 2, 10, 3);
    await seedProbes(A, [S, S, S]);
    const rows = await queryProbeLossRatios({ sinceMinutes: 60, assetIds: [A] });
    // Three answered probes and nothing else: the run went whole.
    expect(Number(rows[0]!.total)).toBe(3);
  });

  it("keeps a failure run that never reached DOWN", async () => {
    // The narrowness. Two misses in a row on a device whose automation declares
    // down at three is loss, and nothing in that run is stamped to say
    // otherwise. Also the flapping case: an alternating device never reaches
    // `down` at all and is measured exactly as it was.
    await seedProbes(A, [S, F, F, S, S, F, S, S]);
    const rows = await queryProbeLossRatios({ sinceMinutes: 60, assetIds: [A] });
    expect(Number(rows[0]!.total)).toBe(8);
    expect(Number(rows[0]!.failed)).toBe(3);
  });

  it("keeps the loss on either side of an outage, and the probe that opens it", async () => {
    await seedOutage(A, 1, 2, 6);           // outage ending 6 minutes ago
    await seedAt(A, [
      { secondsAgo: 700, success: false },  // isolated loss, before the outage
      { secondsAgo: 660, success: true },
      { secondsAgo: 240, success: true },   // recovery
      { secondsAgo: 180, success: false },  // isolated loss, after
      { secondsAgo: 120, success: true },
    ]);
    const rows = await queryProbeLossRatios({ sinceMinutes: 60, assetIds: [A] });
    expect(Number(rows[0]!.total)).toBe(5);
    expect(Number(rows[0]!.failed)).toBe(2);
  });

  it("keeps the misses BELOW the threshold — only the ones drawn as Down are dropped", async () => {
    // The narrowness IS the design. An alternating device never reaches three
    // consecutive misses, so nothing about it is ever stamped and it stays as
    // measurable as it was — unlike under the retired recovery anchor, which
    // trimmed the whole window before the last recovery and reported ~0%.
    await seedProbes(A, [S, F, S, F, S, F, S, F]);
    const rows = await queryProbeLossRatios({ sinceMinutes: 60, assetIds: [A] });
    expect(Number(rows[0]!.total)).toBe(8);
    expect(Number(rows[0]!.failed)).toBe(4);
  });

  it("counts an unstamped miss — the exclusion is not retroactive", async () => {
    // Rows written before the column carry NULL, and `IS NOT TRUE` keeps them.
    // NULL is not the same claim as false.
    await seedProbes(A, [F, F, F, F, S, S]);
    const rows = await queryProbeLossRatios({ sinceMinutes: 60, assetIds: [A] });
    expect(Number(rows[0]!.failed)).toBe(4);
  });

  it("drops the outage's BURST rows whole, packets and all", async () => {
    // A sweep burst fired into an outage measures the outage, not the link —
    // and it carries five echoes, so counting it would dominate the ratio it is
    // excluded from. The unstamped onset burst goes with the run.
    await prisma.assetMonitorSample.createMany({
      data: [
        { assetId: A, timestamp: ago(8), success: false, responseTimeMs: null, probeKind: "icmp", packetsSent: 5, packetsReceived: 0 },
        { assetId: A, timestamp: ago(6), success: false, responseTimeMs: null, probeKind: "icmp", packetsSent: 5, packetsReceived: 0, assetDown: true },
        { assetId: A, timestamp: ago(4), success: true, responseTimeMs: null, probeKind: "icmp", packetsSent: 5, packetsReceived: 5 },
        { assetId: A, timestamp: ago(2), success: true, responseTimeMs: null, probeKind: "icmp", packetsSent: 5, packetsReceived: 4 },
      ],
    });
    const rows = await queryProbeLossRatios({ sinceMinutes: 60, assetIds: [A] });
    expect(Number(rows[0]!.total)).toBe(10);
    expect(Number(rows[0]!.failed)).toBe(1);
  });

  it("drops an asset out of the result entirely when its whole window was the outage", async () => {
    // No countable probes is no reading — which is right: a device still down
    // is the answering gate's business (rule 29a), and it clears the loss alert
    // rather than leaving one to freeze.
    await seedOutage(A, 2, 6, 1);
    const rows = await queryProbeLossRatios({ sinceMinutes: 60, assetIds: [A] });
    expect(rows).toHaveLength(0);
  });

  it("hides the recovered device from the widget too — one definition, both readers", async () => {
    await seedOutage(A, 2, 10, 3);
    await seedProbes(A, [S, S, S]);
    const rows = await queryProbeLossRatios({
      sinceMinutes: 60, assetIds: [A], onlyLossy: true, limit: 10,
    });
    expect(rows).toHaveLength(0);
  });
});

d("queryProbeLossRatios — SQL/JS parity on the outage run", () => {
  it("agrees with alertChartService's mirror on the same probes", async () => {
    // The exclusion is implemented twice by necessity — two window functions
    // in this query, and `outageRunFailures` in the browser-free JS of
    // alertChartService. Since 2026-09-14 the JS mirror no longer shapes what
    // the loss chart draws (the chart counts every probe, business rule 29h
    // applies to the metric alone), so it is `engineRatioPct` that carries it
    // and `engineRatioPct` the query is pinned against. Pinning the two
    // implementations to each other rather than each to its own expectation is
    // still the point: a drift in either would otherwise pass.
    //
    // Primary rows only: the chart deliberately keeps poll rows once burst rows
    // exist (a picture of the window has to be continuous) while the query
    // drops them, which is a documented divergence in the PACKET weighting, not
    // in the run rule.
    const pattern = [S, F, S, F, F, F, F, S, S, F, S, S];
    // The outage is the run at indices 3..6, declared from the third miss.
    const rows = pattern.map((success, i) => ({
      assetId: A,
      timestamp: ago(pattern.length - i),
      success,
      responseTimeMs: success ? 10 : null,
      // Stamped from the probe that DECLARES the outage (the third consecutive
      // miss) to its end. Indices 3 and 4 are the onset the marker cannot
      // reach; index 9 is an isolated miss and stays loss.
      ...(i === 5 || i === 6 ? { assetDown: true } : {}),
    }));
    await prisma.assetMonitorSample.createMany({ data: rows });

    const sql = await queryProbeLossRatios({ sinceMinutes: 60, assetIds: [A] });
    const sqlPct = Math.round((Number(sql[0]!.failed) / Number(sql[0]!.total)) * 1000) / 10;
    const js = probeLossSeriesFrom(
      rows.map((r) => ({ timestamp: r.timestamp, success: r.success, assetDown: (r as { assetDown?: boolean }).assetDown ?? null })),
      2 * 60 * 1000,
    );

    // Eight countable probes (12 less the four-failure outage run), two lost.
    expect(Number(sql[0]!.total)).toBe(8);
    expect(sqlPct).toBe(25);
    expect(js.engineRatioPct).toBe(sqlPct);
    // And the chart, over the same probes, counts all six failures of twelve.
    expect(js.ratioPct).toBe(50);
  });

  it("agrees when nothing is stamped, which is most of the fleet", async () => {
    const pattern = [S, F, S, F, F, S, S, F, S, S];
    const rows = pattern.map((success, i) => ({
      assetId: A,
      timestamp: ago(pattern.length - i),
      success,
      responseTimeMs: success ? 10 : null,
    }));
    await prisma.assetMonitorSample.createMany({ data: rows });

    const sql = await queryProbeLossRatios({ sinceMinutes: 60, assetIds: [A] });
    const sqlPct = Math.round((Number(sql[0]!.failed) / Number(sql[0]!.total)) * 1000) / 10;
    const js = probeLossSeriesFrom(rows.map((r) => ({ timestamp: r.timestamp, success: r.success })), 2 * 60 * 1000);

    expect(Number(sql[0]!.total)).toBe(10);
    expect(js.engineRatioPct).toBe(sqlPct);
    // With nothing stamped there is no exclusion, so the chart agrees too.
    expect(js.ratioPct).toBe(sqlPct);
  });
});

d("queryProbeLossRatios — mode + scoping contracts", () => {
  it("engine mode keeps a clean asset (0% feeds hysteresis recovery); widget mode hides it", async () => {
    await seedProbes(A, [S, S, S, S, S]);

    const engine = await queryProbeLossRatios({ sinceMinutes: 60, assetIds: [A] });
    expect(engine).toHaveLength(1);
    expect(Number(engine[0]!.failed)).toBe(0);

    const widget = await queryProbeLossRatios({ sinceMinutes: 60, assetIds: [A], onlyLossy: true, limit: 10 });
    expect(widget).toHaveLength(0);
  });

  it("widget mode orders lossiest-first and honours the cap", async () => {
    await seedProbes(A, [S, F, S, S, S]);        // 1/5 = 20%
    await seedProbes(B, [S, F, F, F, S]);        // 3/5 = 60%

    const ordered = await queryProbeLossRatios({ sinceMinutes: 60, assetIds: ALL, onlyLossy: true, limit: null });
    expect(ordered.map((r) => r.assetId)).toEqual([B, A]);

    const capped = await queryProbeLossRatios({ sinceMinutes: 60, assetIds: ALL, onlyLossy: true, limit: 1 });
    expect(capped.map((r) => r.assetId)).toEqual([B]);
  });

  it("scopes to assetIds and to the window", async () => {
    await seedProbes(A, [S, F, S]);
    await seedProbes(B, [S, F, S]);

    const scoped = await queryProbeLossRatios({ sinceMinutes: 60, assetIds: [A] });
    expect(scoped.map((r) => r.assetId)).toEqual([A]);

    // Samples older than the window are invisible.
    await prisma.assetMonitorSample.deleteMany({ where: { assetId: { in: ALL } } });
    await prisma.assetMonitorSample.createMany({
      data: [
        { assetId: A, timestamp: ago(120), success: true,  responseTimeMs: 10 },
        { assetId: A, timestamp: ago(90),  success: false, responseTimeMs: null },
      ],
    });
    expect(await queryProbeLossRatios({ sinceMinutes: 60, assetIds: [A] })).toHaveLength(0);
  });
});


d("queryProbeLossRatios — probeKind", () => {
  it("counts ICMP loss-sampler rows alongside the response-time poll", async () => {
    // The whole point of the sampler: a 15-minute ratio divides ~90 samples
    // instead of ~15. Three primary polls (1 failed) and six sampler pings
    // (3 failed) all count together: 4 of 10, not 1 of 4.
    await seedAt(A, [
      { secondsAgo: 300, success: S },
      { secondsAgo: 240, success: F },
      { secondsAgo: 180, success: S },
      { secondsAgo: 120, success: S },
      { secondsAgo: 230, success: F, probeKind: "icmp" },
      { secondsAgo: 220, success: F, probeKind: "icmp" },
      { secondsAgo: 210, success: F, probeKind: "icmp" },
      { secondsAgo: 200, success: S, probeKind: "icmp" },
      { secondsAgo: 190, success: S, probeKind: "icmp" },
      { secondsAgo: 170, success: S, probeKind: "icmp" },
    ]);

    const rows = await queryProbeLossRatios({ sinceMinutes: 60, assetIds: [A] });
    expect(Number(rows[0].total)).toBe(10);
    expect(Number(rows[0].failed)).toBe(4);
  });

  it("counts sampler rows that precede any primary success", async () => {
    // This used to test the ANCHOR: the sampler ping was the first success, so
    // the three primary failures before it were discarded as "an outage". With
    // the trim gone they are loss like any other miss — 3 of 5.
    await seedAt(A, [
      { secondsAgo: 300, success: F },
      { secondsAgo: 240, success: F },
      { secondsAgo: 180, success: F },
      { secondsAgo: 120, success: S, probeKind: "icmp" },
      { secondsAgo: 60,  success: S, probeKind: "icmp" },
    ]);

    const rows = await queryProbeLossRatios({ sinceMinutes: 60, assetIds: [A] });
    expect(Number(rows[0]!.total)).toBe(5);
    expect(Number(rows[0]!.failed)).toBe(3);
  });
});

dbDescribe("packet counts (ICMP burst rows)", () => {
  it("measures PACKETS, not row outcomes", async () => {
    // Five bursts, each 5 sent / 1 received. Every row is `success: true`
    // (something came back), so the old row-counting ratio called this a
    // perfectly clean device. It is 80% lossy.
    await seedBursts(A, [[5, 1], [5, 1], [5, 1], [5, 1], [5, 1]]);
    const rows = await queryProbeLossRatios({ sinceMinutes: 60, assetIds: [A] });
    expect(rows).toHaveLength(1);
    expect(pct(rows[0]!)).toBeCloseTo(80, 5);
  });

  it("reads 0% when every echo came back", async () => {
    await seedBursts(A, [[5, 5], [5, 5], [5, 5]]);
    const rows = await queryProbeLossRatios({ sinceMinutes: 60, assetIds: [A] });
    expect(pct(rows[0]!)).toBe(0);
  });

  it("weights by packets rather than by burst, so a long burst counts more", async () => {
    // 5/5 then 10/0 is 10 lost of 15 sent = 66.7%, NOT the 50% a mean of
    // per-burst percentages would give. The clean burst goes FIRST on purpose:
    // the first-success anchor would otherwise trim a leading all-lost burst
    // out of the window, and the assertion would be measuring the anchor
    // rather than the weighting. (That trim is business rule 29b, pinned by
    // its own tests above.)
    await seedBursts(A, [[5, 5], [10, 0]]);
    const rows = await queryProbeLossRatios({ sinceMinutes: 60, assetIds: [A] });
    expect(pct(rows[0]!)).toBeCloseTo(66.67, 1);
  });

  it("falls back to the row ratio for an asset with no burst rows", async () => {
    // The pre-sweep behaviour, still exactly what an asset with no pingable
    // target or a disabled sweep gets.
    await seedProbes(A, [S, S, F, F]);
    const rows = await queryProbeLossRatios({ sinceMinutes: 60, assetIds: [A] });
    expect(pct(rows[0]!)).toBe(50);
  });

  it("IGNORES the response-time poll's rows once burst rows exist", async () => {
    // The poll may be SNMP/SSH/REST/WinRM; folding a lost SNMP response into a
    // figure labelled "packet loss" would make the number mean something
    // different per asset depending on how it is monitored. Bursts are clean
    // here while every poll row failed, and the answer must be 0%.
    await seedAt(A, [
      { secondsAgo: 50, success: false },
      { secondsAgo: 40, success: false },
      { secondsAgo: 30, success: true },
    ]);
    await seedBursts(A, [[5, 5], [5, 5]]);
    const rows = await queryProbeLossRatios({ sinceMinutes: 60, assetIds: [A] });
    expect(pct(rows[0]!)).toBe(0);
  });

  it("surfaces a partially-lossy device in widget mode even though no ROW failed", async () => {
    // The HAVING has to be asked of packets too: every one of these rows is a
    // success, so a row-based `≥1 failure` test would filter out exactly the
    // device the Packet Loss widget exists to show.
    await seedBursts(A, [[5, 3], [5, 3]]);
    const rows = await queryProbeLossRatios({
      sinceMinutes: 60, assetIds: [A], onlyLossy: true, limit: 10,
    });
    expect(rows).toHaveLength(1);
    expect(pct(rows[0]!)).toBeCloseTo(40, 5);
  });

  it("still hides a spotless device in widget mode", async () => {
    await seedBursts(A, [[5, 5], [5, 5]]);
    const rows = await queryProbeLossRatios({
      sinceMinutes: 60, assetIds: [A], onlyLossy: true, limit: 10,
    });
    expect(rows).toEqual([]);
  });

  it("orders lossiest-first by the packet ratio", async () => {
    await seedBursts(A, [[5, 4]]);            // 20%
    await seedBursts(B, [[5, 1]]);            // 80%
    const rows = await queryProbeLossRatios({
      sinceMinutes: 60, assetIds: ALL, onlyLossy: true, limit: 10,
    });
    expect(rows.map((r) => r.assetId)).toEqual([B, A]);
  });

  it("reads a fully-dark burst run as 100% under includeFullyDown", async () => {
    await seedBursts(A, [[5, 0], [5, 0]]);
    const rows = await queryProbeLossRatios({
      sinceMinutes: 60, assetIds: [A], onlyLossy: true, limit: 10, includeFullyDown: true,
    });
    expect(pct(rows[0]!)).toBe(100);
  });
});

/** Loss percentage from a returned row — the arithmetic every caller does. */
function pct(r: { total: bigint; failed: bigint }): number {
  return (Number(r.failed) / Number(r.total)) * 100;
}
