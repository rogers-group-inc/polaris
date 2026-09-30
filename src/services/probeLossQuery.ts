/**
 * src/services/probeLossQuery.ts — the ONE windowed failed-probe-ratio query
 * over asset_monitor_samples, shared by the notification engine's probeLossPct
 * trigger and the NOC dashboard's Packet Loss widget (2026-08 dedup — the two
 * hand-maintained copies had already drifted in their HAVING clauses, which
 * turned out to be a real semantic difference, so it's a parameter here):
 *
 *   - Engine mode (onlyLossy=false): every asset with ≥1 successful probe in
 *     the window, INCLUDING 0%-loss rows — an auto-clear/hysteresis rule needs
 *     the clean reading to recover. Fully-down assets (0 successes) are
 *     dropped either way — asset-down owns them.
 *   - Widget mode (onlyLossy=true): additionally requires actual LOSS — asked of
 *     the effective packet counts, not of row outcomes, so a device whose every
 *     burst dropped packets while still getting something back is not filtered
 *     out as spotless — orders lossiest-first, and caps at `limit`
 *     (null = uncapped; Postgres treats LIMIT NULL as ALL). `includeFullyDown`
 *     is retired: with every countable row in the ratio, a dark asset reads
 *     100% on its own rather than needing an opt-in not to vanish.
 *
 * IT COUNTS PACKETS, NOT ROWS, WHEREVER IT CAN (2026-09-01). The ICMP loss
 * sweep writes ONE row per burst carrying `packetsSent` / `packetsReceived`, so
 * an asset with any burst rows in the window has its ratio computed from those
 * sums and its response-time poll rows left out. Counting such a row as a
 * single outcome understated loss badly — a 5-echo burst that got one reply
 * back is an 80%-lossy reading but a perfectly "successful" row. Poll rows are
 * excluded rather than blended because that poll may be SNMP, SSH, REST or
 * WinRM, and folding a lost SNMP response into a figure labelled "packet loss"
 * would make the number mean something different per asset depending on how it
 * happens to be monitored. An asset with no burst rows falls back to the row
 * ratio, which is exactly the pre-sweep behaviour. The returned {total, failed}
 * shape is unchanged: the UNITS beneath it moved from rows to packets, the
 * arithmetic every caller does did not.
 *
 * THIS QUERY COUNTS EVERY `probeKind`. It is one of only THREE readers of
 * asset_monitor_samples that does (the others being alertChartService's loss
 * chart and the loss line sampleHistoryService.readMonitorHistory hands the
 * response-time chart); everything else filters to the response-time poll. That is the point
 * of the ICMP loss sweep (utils/lossSweep.ts): a uniform burst of echoes at
 * every eligible asset every cycle, so a 15-minute ratio divides ~90 samples
 * instead of ~15. Its rows carry probeKind='icmp' and a NULL responseTimeMs,
 * so they can only ever affect a ratio, never a timing.
 *
 * EVERY MISS THE DEVICE'S OWN OUTAGE DOES NOT EXPLAIN COUNTS. failed/total
 * over the whole window, with no trimming and exactly one exclusion: the
 * failures of any run that reached DOWN.
 *
 * That exclusion is business rule 29h and it is a claim about WHICH PROBES
 * produced the number, not about how big the number is. The failures of an
 * outage ARE that outage, and the down automation already alerted on it; a miss
 * taken while the device was answering is packet loss. Without the split, a
 * switch dark for twelve minutes came back, started answering, and its
 * 30-minute window still read 40 % — under every sensible `ignoreAtOrAbove`
 * ceiling — so a "High packet loss" warning arrived minutes AFTER the recovery,
 * about the outage the operator had already been paged for.
 *
 * THE UNIT IS THE RUN, NOT THE MARKED ROW. `AssetMonitorSample.assetDown` can
 * only be stamped from the probe that DECLARES the outage onward: when the
 * first missed poll is written, nobody knows yet whether it begins an outage or
 * is one lost packet. Dropping only the stamped rows therefore left every
 * outage's ONSET — `missedPolls - 1` fully-lost probes — in a denominator the
 * exclusion had already shrunk, which still read over 10 % for a full window
 * after the device came back. So the run is reconstructed instead (see the
 * `runId` / `runOutage` fragments): consecutive failures between successes form
 * one group, and a group holding any stamped row is an outage entire. Its
 * failures go; the answered probe that opens it stays.
 *
 * That also keeps this query out of the business of knowing how long an outage
 * is. `missedPolls` belongs to whichever automation covers the device (business
 * rule 36), so it differs per asset and changes the moment an operator edits a
 * rule — a run is bounded by successes and needs no threshold at all.
 *
 * It is narrow on purpose, and the narrowness is what distinguishes it from the
 * anchor below: only runs that actually REACHED down are dropped. A run of
 * misses that stayed below the threshold is loss and still counts in full, so
 * an alternating device — which never reaches `down` at all — is measured
 * exactly as it was.
 *
 * It is NOT retroactive. Rows written before the column carry NULL and read as
 * false (coalesced), so an outage already inside the window keeps counting
 * until it ages out of it.
 *
 * IT USED TO TRIM WHOLESALE, and why it stopped is why the exclusion above is
 * per-row. Between 2026-08 and 2026-09-01 the measurement started at
 * GREATEST(first success in window, Asset.recoveryStartedAt), discarding
 * everything before the window's last recovery rather than the outage itself. That
 * existed to stop a device reading ~92% the moment it came back from a
 * 55-minute outage and alerting for a full window BECAUSE it recovered. But it
 * also discarded loss nobody wanted discarded: a device flapping hard enough to
 * reach `down` each cycle re-stamped recoveryStartedAt on every recovery,
 * collapsing its window to the last few probes and reporting ~0% loss forever.
 * A badly lossy link that Polaris insisted was clean is the exact failure this
 * metric exists to catch, so the trim had to go.
 *
 * TWO ALERT-TIME GATES SIT ON TOP OF IT, in the engine rather than in the
 * arithmetic (business rule 29): only a device currently answering produces a
 * reading at all (assetIsAnsweringProbes), and a reading at or above the
 * automation's own `ignoreAtOrAbove` ceiling produces none either. Both CLEAR a
 * live loss alert rather than freezing it. They bound WHEN a reading may raise
 * an alert; the `assetDown` exclusion decides WHICH PROBES the reading is made
 * of. Neither one can do the other's job — the answering gate is silent about
 * an outage that has already ended inside the window, and a ceiling low enough
 * to catch that outage would also throw away every genuine reading of the same
 * size, which is the reading the metric exists for.
 *
 * Asset.recoveryStartedAt is still stamped (utils/probeLossAnchor.ts) but is
 * read by nothing — dormant on the cooldownSec precedent.
 * * The window is anchored to UTC wall-clock (`now() AT TIME ZONE 'UTC'`)
 * rather than a bound JS Date to avoid tz skew against the hypertable's
 * naive timestamps. All SQL fragments are compile-time literals; user data
 * rides positional parameters only.
 */

import { prisma } from "../db.js";

export interface ProbeLossRow {
  assetId: string;
  total: bigint;
  failed: bigint;
}

export async function queryProbeLossRatios(opts: {
  sinceMinutes: number;
  assetIds?: string[] | null;
  onlyLossy?: boolean;
  limit?: number | null;
}): Promise<ProbeLossRow[]> {
  const params: unknown[] = [String(opts.sinceMinutes)];
  let p = 1;

  let idClause = "";
  if (opts.assetIds) {

    idClause = ` AND "assetId" = ANY($${++p}::text[])`;
    params.push(opts.assetIds);
  }

  // EFFECTIVE PACKET COUNTS. A burst row (the ICMP loss sweep) describes N
  // echoes in one row; a response-time poll row describes one probe and leaves
  // the columns NULL. Mixing the two by COUNTING ROWS understates loss badly —
  // a 5-echo burst that got 1 reply back is a 80%-lossy reading but a
  // perfectly "successful" row — so when an asset has ANY burst rows in the
  // window its ratio is computed from PACKETS and the poll rows are left out
  // of it entirely.
  //
  // Leaving them out is deliberate rather than lazy: the response-time poll
  // may be SNMP, SSH, REST or WinRM, and folding a lost SNMP response into a
  // figure labelled "packet loss" would make the number mean something
  // different per asset depending on how it happens to be monitored. An asset
  // with no burst rows (no pingable target, sweep disabled, or the window
  // predates the sweep) falls back to the row ratio, which is exactly the
  // pre-sweep behaviour.
  //
  // The results keep the {total, failed} shape so every caller is unchanged —
  // the units under it changed from rows to packets, the arithmetic did not.
  const hasBursts = `count(*) FILTER (WHERE "packetsSent" IS NOT NULL) > 0`;
  const effSent = `CASE WHEN ${hasBursts} THEN sum("packetsSent") ELSE count(*) END`;
  const effRecv = `CASE WHEN ${hasBursts} THEN coalesce(sum("packetsReceived"), 0) ELSE count(*) FILTER (WHERE "success") END`;

  // Widget mode still hides clean assets — but "clean" now has to be asked of
  // the effective counts, or a device whose every burst lost packets while
  // still getting SOMETHING back (so no row is a failure) would be filtered
  // out as spotless, which is the exact device the widget exists to surface.
  const having = opts.onlyLossy ? `HAVING (${effSent}) > (${effRecv})` : "";

  // THE OUTAGE IS THE WHOLE FAILURE RUN, not just the part after the verdict
  // (business rule 29h). `assetDown` can only be stamped from the probe that
  // DECLARES the outage onward — at the time the first missed poll is written,
  // nobody knows yet whether it is the start of an outage or one lost packet —
  // so excluding stamped rows alone would leave every outage's ONSET counted as
  // loss: `missedPolls - 1` fully-lost probes, which is ~10 lost echoes and,
  // against a denominator the exclusion has already shrunk, still reads over
  // 10% for a whole window after the device came back.
  //
  // So the run is reconstructed here instead: `runId` is the number of
  // successes seen so far per asset, which makes every maximal stretch of
  // consecutive failures one group, and a group containing ANY stamped row is
  // an outage in its entirety. Its FAILURES are dropped; the answered probe
  // that opens the group is kept, because it answered.
  //
  // Reconstructing beats counting back `missedPolls - 1` rows, and not only
  // because it is simpler: the count is the covering automation's, so it
  // differs per device and changes the moment an operator edits a rule, while
  // a run is bounded by successes and needs to know no threshold at all.
  //
  // coalesce() is load-bearing: `assetDown` is nullable, so bool_or over a run
  // of pre-column rows returns NULL, and `NOT (NULL AND NOT success)` is NULL —
  // which WHERE reads as false and would drop every failure in an UNSTAMPED
  // run, i.e. all loss on every asset. ROWS framing (not the default RANGE)
  // keeps two rows sharing a timestamp from sharing a cumulative count.
  const runId = `sum(CASE WHEN "success" THEN 1 ELSE 0 END) OVER (
             PARTITION BY "assetId" ORDER BY "timestamp", "id"
             ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS "runId"`;
  const runOutage = `coalesce(bool_or("assetDown") OVER (PARTITION BY "assetId", "runId"), false) AS "runOutage"`;


  let tail = "";
  if (opts.onlyLossy) {
    tail = `
     ORDER BY 1 - (${effRecv})::float / NULLIF((${effSent}), 0) DESC
     LIMIT $${++p}`;
    params.push(opts.limit ?? null);
  }

  return prisma.$queryRawUnsafe<ProbeLossRow[]>(
    // One scan, two window functions over it, then the grouped aggregate. The
    // anchor's partitioned min() and its LEFT JOIN to `assets` are still gone —
    // this reads no other table and asks nothing about the asset's CURRENT
    // state, only about the shape of its own probe history.
    //
    // Measured plan (EXPLAIN, 2026-09-03): chunk-excluded scan of the recent
    // chunks only, one sort by (assetId, timestamp, id), WindowAgg, an
    // INCREMENTAL sort to (assetId, runId) — cheap, since assetId is already
    // presorted — second WindowAgg, GroupAggregate. So the cost over the plain
    // hash aggregate this replaces is one sort of the window's own rows: ~60k
    // at 2000 assets over 15 minutes, on a 60s tick. That is the same order as
    // the partitioned min() the anchor used to carry here.
    `SELECT "assetId", (${effSent}) AS total, (${effSent}) - (${effRecv}) AS failed
     FROM (
       SELECT "assetId", "success", "packetsSent", "packetsReceived", ${runOutage}
       FROM (
         SELECT "assetId", "timestamp", "id", "success", "packetsSent", "packetsReceived", "assetDown",
                ${runId}
         FROM "asset_monitor_samples"
         WHERE "timestamp" > (now() AT TIME ZONE 'UTC') - ($1 || ' minutes')::interval${idClause}
       ) runs
     ) probes
     WHERE NOT ("runOutage" AND NOT "success")
     GROUP BY "assetId"
     ${having}${tail}`,
    ...params,
  );
}
