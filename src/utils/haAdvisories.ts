/**
 * src/utils/haAdvisories.ts — the arithmetic behind the HA tab's guidance card.
 *
 * The tab tells an operator what enabling HA will actually cost them BEFORE
 * they enable it, using figures computed from this install rather than generic
 * advice: how far behind the standby would be, how much WAL has to cross the
 * link, how long a failover takes given their own load-balancer settings, and
 * how big the standby has to be.
 *
 * All of it is pure. The service gathers the raw inputs (LSN samples, socket
 * round-trips, `pg_settings`, disk figures) and this module turns them into
 * verdicts, so the thresholds are unit-testable without a second datacenter.
 *
 * The bands are deliberately conservative and deliberately explicit: an
 * operator reading "312 ms round-trip — elections will churn" can act on it,
 * where a green tick that quietly meant "under 250 ms" cannot be argued with.
 */

/** How a measured figure reads against its threshold. */
export type AdvisoryLevel = "ok" | "warn" | "bad" | "unknown";

export interface Advisory {
  level:  AdvisoryLevel;
  /** One sentence, operator-facing. Never a bare number. */
  detail: string;
}

// ─── Latency ────────────────────────────────────────────────────────────────
// etcd's election timeout is 2.5s (deploy/ha/etcd.conf.example). Round-trips
// in the low tens of milliseconds are unremarkable; past ~100ms Patroni's
// 10s loop starts to feel it, and past ~250ms elections churn and a failover
// slows down measurably.
export const RTT_OK_MS   = 100;
export const RTT_WARN_MS = 250;

export function rttAdvisory(rttMs: number | null, label: string): Advisory {
  if (rttMs === null || !Number.isFinite(rttMs)) {
    return { level: "unknown", detail: `Could not reach ${label} to measure round-trip time.` };
  }
  const ms = Math.round(rttMs);
  if (ms <= RTT_OK_MS) {
    return { level: "ok", detail: `${ms} ms round-trip to ${label} — comfortably inside the 2.5 s election timeout.` };
  }
  if (ms <= RTT_WARN_MS) {
    return {
      level: "warn",
      detail: `${ms} ms round-trip to ${label} — workable, but failover detection and promotion will be visibly slower.`,
    };
  }
  return {
    level: "bad",
    detail: `${ms} ms round-trip to ${label} — past the 250 ms this design is tested to. Expect leader elections to churn.`,
  };
}

// ─── WAL rate ───────────────────────────────────────────────────────────────

export interface LsnSample {
  /** ISO-8601. */
  at:  string;
  /** `pg_current_wal_lsn()` text, e.g. "3/AF0001C8". */
  lsn: string;
}

/**
 * Parse a PostgreSQL LSN ("hi/lo", both hex) into a byte offset.
 *
 * Returns null rather than NaN on anything unexpected: the ring is advisory
 * data written by a best-effort job, so a malformed entry must be skippable.
 * BigInt because the high half is shifted 32 bits — a WAL position outgrows
 * Number.MAX_SAFE_INTEGER on a busy cluster.
 */
export function parseLsn(lsn: string): bigint | null {
  const m = /^([0-9A-Fa-f]{1,16})\/([0-9A-Fa-f]{1,16})$/.exec((lsn || "").trim());
  if (!m) return null;
  try {
    return (BigInt("0x" + m[1]) << 32n) + BigInt("0x" + m[2]);
  } catch {
    return null;
  }
}

export interface WalRate {
  /** Bytes of WAL per second across the sampled window. */
  bytesPerSec: number;
  /** Length of the window actually measured. */
  windowSec:   number;
  /** Total bytes across the window. */
  totalBytes:  number;
}

/**
 * WAL generation rate from the sample ring.
 *
 * Uses the first and last usable samples rather than summing pairs: WAL
 * positions only move forward, so the endpoints are the whole answer and one
 * unparseable entry in the middle costs nothing. A backwards delta means the
 * cluster was rebuilt or restored between samples, which is not a rate — the
 * caller gets null and says so instead of reporting a negative.
 */
export function walRateFromSamples(samples: LsnSample[]): WalRate | null {
  const usable = (samples || [])
    .map((s) => ({ t: Date.parse(s?.at ?? ""), lsn: parseLsn(s?.lsn ?? "") }))
    .filter((s): s is { t: number; lsn: bigint } => Number.isFinite(s.t) && s.lsn !== null)
    .sort((a, b) => a.t - b.t);
  if (usable.length < 2) return null;

  const first = usable[0];
  const last  = usable[usable.length - 1];
  const windowSec = (last.t - first.t) / 1000;
  if (windowSec <= 0) return null;
  const delta = last.lsn - first.lsn;
  if (delta < 0n) return null;

  const totalBytes = Number(delta);
  return { bytesPerSec: totalBytes / windowSec, windowSec, totalBytes };
}

/** Headroom over the measured average: compression bursts and catch-up after an outage. */
export const WAL_HEADROOM_FACTOR = 3;

export function formatBytes(bytes: number): string {
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let v = Math.abs(bytes);
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1; }
  const rounded = v >= 100 ? Math.round(v) : Math.round(v * 10) / 10;
  return `${rounded} ${units[i]}`;
}

export function walAdvisory(rate: WalRate | null): Advisory & { recommendedMbps?: number } {
  if (!rate) {
    return {
      level: "unknown",
      detail: "Not enough write-ahead-log samples yet — the figure needs a few hours of history. It is collected every five minutes.",
    };
  }
  const mbps = (rate.bytesPerSec * 8) / 1_000_000;
  const recommendedMbps = Math.max(1, Math.ceil(mbps * WAL_HEADROOM_FACTOR));
  const hours = Math.round(rate.windowSec / 360) / 10;
  return {
    level: "ok",
    recommendedMbps,
    detail:
      `${formatBytes(rate.bytesPerSec)}/s of write-ahead log over the last ${hours} h ` +
      `(${formatBytes(rate.totalBytes)} total). Size the link for at least ${recommendedMbps} Mbps ` +
      `so compression bursts and catch-up after an outage have room.`,
  };
}

// ─── Recovery point ─────────────────────────────────────────────────────────

/** Buffered samples not yet flushed; see sampleWriteBuffer. */
export const BUFFER_LOSS_SEC = 2;

export function rpoAdvisory(lagBytes: number | null, rate: WalRate | null): Advisory {
  if (lagBytes === null) {
    return {
      level: "unknown",
      detail:
        `Replication is not running yet. Once it is, the recovery point is the replication lag at the ` +
        `moment of failure, plus up to ${BUFFER_LOSS_SEC} s of buffered samples.`,
    };
  }
  // Turning a byte lag into seconds needs a rate; without one, state the bytes.
  const lagSec = rate && rate.bytesPerSec > 0 ? lagBytes / rate.bytesPerSec : null;
  const bufferNote = `Add up to ${BUFFER_LOSS_SEC} s of buffered samples, and any agent-pushed samples during the outage gap.`;
  if (lagSec === null) {
    return { level: lagBytes > 64 * 1024 * 1024 ? "warn" : "ok", detail: `${formatBytes(lagBytes)} behind. ${bufferNote}` };
  }
  const shown = lagSec < 1 ? "under a second" : `about ${Math.round(lagSec)} s`;
  return {
    level: lagSec > 60 ? "warn" : "ok",
    detail: `If the primary died now you would lose ${shown} of database writes (${formatBytes(lagBytes)} behind). ${bufferNote}`,
  };
}

// ─── Recovery time ──────────────────────────────────────────────────────────

export interface RtoInputs {
  /** Patroni lease TTL, seconds. */
  ttlSec:            number;
  /** Load-balancer monitor interval, seconds. */
  monitorIntervalSec: number;
  /** Consecutive failures before the monitor marks the site down. */
  monitorRetries:    number;
  /** DNS TTL the balancer serves, seconds. */
  dnsTtlSec:         number;
}

export interface RtoEstimate {
  minSec: number;
  maxSec: number;
}

/** Promote plus the app group coming up: measured range, not a guess to tune. */
export const PROMOTE_SEC     = 10;
export const APP_START_MIN_SEC = 20;
export const APP_START_MAX_SEC = 40;

/**
 * Downtime range for an unplanned failover.
 *
 * The lower bound assumes the failure happens just before a lease renewal and
 * the monitor's next probe lands immediately; the upper bound assumes it
 * happens just after one and the probe has just been missed. Both include the
 * DNS TTL, because a client holding the old answer is still down even after
 * the new site is serving.
 */
export function estimateRto(input: RtoInputs): RtoEstimate {
  const detect = Math.max(0, input.ttlSec);
  const monitor = Math.max(0, input.monitorIntervalSec) * Math.max(1, input.monitorRetries);
  const dns = Math.max(0, input.dnsTtlSec);
  const minSec = Math.round(detect + PROMOTE_SEC + APP_START_MIN_SEC + Math.max(0, input.monitorIntervalSec));
  const maxSec = Math.round(detect + PROMOTE_SEC + APP_START_MAX_SEC + monitor + dns);
  return { minSec, maxSec: Math.max(maxSec, minSec) };
}

export function formatDuration(sec: number): string {
  if (sec < 60) return `${Math.round(sec)} s`;
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return s === 0 ? `${m} min` : `${m} min ${s} s`;
}

export function rtoAdvisory(input: RtoInputs): Advisory & { estimate: RtoEstimate } {
  const estimate = estimateRto(input);
  return {
    level: estimate.maxSec > 600 ? "warn" : "ok",
    estimate,
    detail:
      `About ${formatDuration(estimate.minSec)} to ${formatDuration(estimate.maxSec)} of downtime for an ` +
      `unplanned failover: ${input.ttlSec} s to notice, ~${PROMOTE_SEC} s to promote, ` +
      `${APP_START_MIN_SEC}-${APP_START_MAX_SEC} s for the application group, then your monitor ` +
      `(${input.monitorIntervalSec} s x ${input.monitorRetries}) and a ${input.dnsTtlSec} s DNS TTL. ` +
      `Sessions survive; users may need to reload.`,
  };
}

// ─── Standby sizing ─────────────────────────────────────────────────────────

export interface SizingInputs {
  cpuCount:      number | null;
  totalMemBytes: number | null;
  dbSizeBytes:   number | null;
  /** max_slot_wal_keep_size as bytes, when it could be resolved. */
  walKeepBytes:  number | null;
}

/** Growth headroom on top of the current database size. */
export const DB_GROWTH_FACTOR = 1.3;

export function sizingAdvisory(input: SizingInputs): Advisory & { minDbVolumeBytes?: number } {
  const parts: string[] = [];
  if (input.cpuCount) parts.push(`${input.cpuCount} vCPU`);
  if (input.totalMemBytes) parts.push(`${formatBytes(input.totalMemBytes)} RAM`);
  if (!parts.length) {
    return { level: "unknown", detail: "Could not read this host's CPU and memory to size the standby against it." };
  }
  let minDbVolumeBytes: number | undefined;
  let dbNote = "";
  if (input.dbSizeBytes) {
    minDbVolumeBytes = Math.ceil(input.dbSizeBytes * DB_GROWTH_FACTOR + (input.walKeepBytes ?? 0));
    dbNote =
      ` Database volume at least ${formatBytes(minDbVolumeBytes)} ` +
      `(${formatBytes(input.dbSizeBytes)} now, plus retained write-ahead log and 30% growth).`;
  }
  return {
    level: "ok",
    minDbVolumeBytes,
    detail:
      `Match this host: ${parts.join(", ")}. After a failover the standby carries the whole fleet alone, ` +
      `so a smaller box is a slower fleet, not a cheaper one.${dbNote}`,
  };
}

/** The witness is a vote, not a database. */
export function witnessAdvisory(): Advisory {
  return {
    level: "ok",
    detail:
      "1 vCPU, 1 GB RAM and about 10 GB of SSD is enough — it stores only the leader key and member " +
      "addresses. Avoid spinning disks and throttled burst storage: etcd is sensitive to disk sync latency.",
  };
}

// ─── Supported install shapes ───────────────────────────────────────────────

export interface InstallShape {
  platform:     string;   // process.platform
  proxyMode:    boolean;  // nginx in front (POLARIS_PROXY_CERT_PATH set)
  pgbouncer:    boolean;
  localPgdata:  boolean;  // this host holds the data directory
  docker:       boolean;
}

export interface SupportVerdict {
  supported: boolean;
  /** Every reason it is unsupported, so the operator fixes them in one pass. */
  reasons:   string[];
}

/**
 * Can this install take the HA path at all?
 *
 * Refusing up front beats letting someone build a standby for a topology the
 * tooling does not cover. Each reason names the actual blocker rather than
 * "unsupported configuration".
 */
export function assessInstallShape(shape: InstallShape): SupportVerdict {
  const reasons: string[] = [];
  if (shape.platform !== "linux") {
    reasons.push("This deployment only supports Linux hosts; the Windows and container installs are not covered.");
  }
  if (shape.docker) {
    reasons.push("Container installs are not covered — the tooling manages systemd units and a local PostgreSQL data directory.");
  }
  if (!shape.proxyMode) {
    reasons.push("nginx must terminate TLS in front of Polaris: the standby has to serve the same certificate agents pin.");
  }
  if (shape.pgbouncer) {
    reasons.push("PgBouncer in front of the local database is not covered; Patroni manages PostgreSQL directly.");
  }
  if (!shape.localPgdata) {
    reasons.push("The database must be local to this host. An external or managed PostgreSQL has its own failover story.");
  }
  return { supported: reasons.length === 0, reasons };
}

// ─── Witness placement ──────────────────────────────────────────────────────

export type WitnessPlacement = "third-site" | "standby-dc" | "primary-dc";

export interface PlacementConsequence {
  placement:        WitnessPlacement;
  primaryHostDies:  "automatic" | "manual";
  primaryDcDark:    "automatic" | "manual";
  standbyDcDark:    "no effect" | "primary demotes";
  recommended:      boolean;
  note:             string;
}

/**
 * What each witness location makes automatic.
 *
 * This is the single most consequential choice in the whole design and the
 * least obvious, so the tab states all three rows rather than only the one
 * chosen: with two sites, wherever the third vote sits decides which outage
 * recovers by itself and which needs a human.
 */
export function placementConsequences(): PlacementConsequence[] {
  return [
    {
      placement: "third-site",
      primaryHostDies: "automatic",
      primaryDcDark: "automatic",
      standbyDcDark: "no effect",
      recommended: true,
      note: "A small VM in a third location — any cloud micro-instance or VPS. Every failure recovers on its own.",
    },
    {
      placement: "standby-dc",
      primaryHostDies: "automatic",
      primaryDcDark: "automatic",
      standbyDcDark: "primary demotes",
      recommended: false,
      note: "Losing the standby site, or the link to it, leaves the primary without a quorum: it demotes itself and the service stops until an operator rebuilds a single-member etcd. Drill that runbook before choosing this.",
    },
    {
      placement: "primary-dc",
      primaryHostDies: "automatic",
      primaryDcDark: "manual",
      standbyDcDark: "no effect",
      recommended: false,
      note: "Safe against a standby-site outage, but losing the primary datacenter means promoting the standby by hand.",
    },
  ];
}
