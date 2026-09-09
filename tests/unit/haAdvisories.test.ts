/**
 * tests/unit/haAdvisories.test.ts — the HA guidance card's arithmetic.
 *
 * These figures are what an operator decides a two-datacenter deployment on,
 * so the thresholds and the LSN maths are pinned here rather than left to be
 * discovered wrong in front of a customer. The interesting cases are the ones
 * that must NOT produce a confident number: too few samples, a cluster
 * restored between samples, an unreachable node.
 */

import { describe, it, expect } from "vitest";
import {
  parseLsn,
  walRateFromSamples,
  walAdvisory,
  rttAdvisory,
  rpoAdvisory,
  estimateRto,
  rtoAdvisory,
  sizingAdvisory,
  assessInstallShape,
  placementConsequences,
  formatBytes,
  formatDuration,
  RTT_OK_MS,
  RTT_WARN_MS,
  WAL_HEADROOM_FACTOR,
  type InstallShape,
} from "../../src/utils/haAdvisories.js";

describe("parseLsn", () => {
  it("parses the hi/lo hex pair into a byte offset", () => {
    expect(parseLsn("0/1000")).toBe(4096n);
    // The high half is a 4 GiB multiple.
    expect(parseLsn("1/0")).toBe(4294967296n);
    expect(parseLsn("3/AF0001C8")).toBe((3n << 32n) + 0xaf0001c8n);
  });

  it("is case insensitive and tolerates surrounding whitespace", () => {
    expect(parseLsn("  2/af  ")).toBe(parseLsn("2/AF"));
  });

  it("returns null on anything malformed rather than NaN", () => {
    for (const bad of ["", "   ", "nonsense", "1", "1/", "/1", "1/2/3", "z/1", "1/-2"]) {
      expect(parseLsn(bad)).toBeNull();
    }
  });

  it("keeps precision past Number.MAX_SAFE_INTEGER", () => {
    const big = parseLsn("FFFFFFFF/FFFFFFFF");
    expect(big).not.toBeNull();
    expect(big! > BigInt(Number.MAX_SAFE_INTEGER)).toBe(true);
  });
});

describe("walRateFromSamples", () => {
  const at = (minutesAgo: number) => new Date(Date.UTC(2026, 8, 8, 12, 0, 0) - minutesAgo * 60_000).toISOString();

  it("computes bytes per second from the endpoints", () => {
    // 4096 bytes over 60 seconds.
    const rate = walRateFromSamples([
      { at: at(1), lsn: "0/0" },
      { at: at(0), lsn: "0/1000" },
    ]);
    expect(rate).not.toBeNull();
    expect(rate!.totalBytes).toBe(4096);
    expect(rate!.windowSec).toBe(60);
    expect(rate!.bytesPerSec).toBeCloseTo(4096 / 60, 6);
  });

  it("uses the endpoints and skips an unparseable sample in between", () => {
    const rate = walRateFromSamples([
      { at: at(2), lsn: "0/0" },
      { at: at(1), lsn: "garbage" },
      { at: at(0), lsn: "0/2000" },
    ]);
    expect(rate!.totalBytes).toBe(8192);
    expect(rate!.windowSec).toBe(120);
  });

  it("sorts by time, so ring order does not matter", () => {
    const unordered = walRateFromSamples([
      { at: at(0), lsn: "0/1000" },
      { at: at(1), lsn: "0/0" },
    ]);
    expect(unordered!.totalBytes).toBe(4096);
  });

  it("returns null with fewer than two usable samples", () => {
    expect(walRateFromSamples([])).toBeNull();
    expect(walRateFromSamples([{ at: at(0), lsn: "0/1000" }])).toBeNull();
    expect(walRateFromSamples([
      { at: at(1), lsn: "bad" },
      { at: at(0), lsn: "also bad" },
    ])).toBeNull();
  });

  it("refuses a backwards delta instead of reporting a negative rate", () => {
    // A restore or a rebuild between samples: not a rate.
    expect(walRateFromSamples([
      { at: at(1), lsn: "5/0" },
      { at: at(0), lsn: "1/0" },
    ])).toBeNull();
  });

  it("returns null when every sample shares a timestamp", () => {
    expect(walRateFromSamples([
      { at: at(0), lsn: "0/0" },
      { at: at(0), lsn: "0/1000" },
    ])).toBeNull();
  });
});

describe("walAdvisory", () => {
  it("says what is missing when there is no rate yet", () => {
    const a = walAdvisory(null);
    expect(a.level).toBe("unknown");
    expect(a.detail).toMatch(/five minutes/);
  });

  it("recommends a link sized with headroom over the average", () => {
    // 1 MiB/s ≈ 8.39 Mbps, tripled and rounded up.
    const a = walAdvisory({ bytesPerSec: 1024 * 1024, windowSec: 3600, totalBytes: 1024 * 1024 * 3600 });
    expect(a.level).toBe("ok");
    const expected = Math.ceil(((1024 * 1024 * 8) / 1_000_000) * WAL_HEADROOM_FACTOR);
    expect(a.recommendedMbps).toBe(expected);
    expect(a.detail).toContain(`${expected} Mbps`);
  });

  it("never recommends less than 1 Mbps on a nearly idle cluster", () => {
    expect(walAdvisory({ bytesPerSec: 1, windowSec: 86400, totalBytes: 86400 }).recommendedMbps).toBe(1);
  });
});

describe("rttAdvisory", () => {
  it("is ok at or below the comfortable threshold", () => {
    expect(rttAdvisory(5, "the standby").level).toBe("ok");
    expect(rttAdvisory(RTT_OK_MS, "the standby").level).toBe("ok");
  });

  it("warns between the thresholds and names the number", () => {
    const a = rttAdvisory(180, "the witness");
    expect(a.level).toBe("warn");
    expect(a.detail).toContain("180 ms");
    expect(a.detail).toContain("the witness");
  });

  it("is bad past the tested ceiling", () => {
    expect(rttAdvisory(RTT_WARN_MS + 1, "the standby").level).toBe("bad");
  });

  it("is unknown, not ok, when the node could not be reached", () => {
    expect(rttAdvisory(null, "the witness").level).toBe("unknown");
    expect(rttAdvisory(Number.NaN, "the witness").level).toBe("unknown");
  });
});

describe("rpoAdvisory", () => {
  it("is explicit that nothing is replicating yet", () => {
    const a = rpoAdvisory(null, null);
    expect(a.level).toBe("unknown");
    expect(a.detail).toMatch(/not running yet/);
  });

  it("converts a byte lag to seconds when a rate is known", () => {
    const a = rpoAdvisory(1024 * 1024, { bytesPerSec: 1024 * 1024, windowSec: 3600, totalBytes: 1 });
    expect(a.detail).toMatch(/about 1 s/);
    expect(a.level).toBe("ok");
  });

  it("says 'under a second' rather than rounding to zero", () => {
    const a = rpoAdvisory(1024, { bytesPerSec: 1024 * 1024, windowSec: 3600, totalBytes: 1 });
    expect(a.detail).toContain("under a second");
  });

  it("falls back to bytes when no rate is available", () => {
    const a = rpoAdvisory(5 * 1024 * 1024, null);
    expect(a.detail).toContain("5 MiB");
  });

  it("warns on a lag over a minute", () => {
    expect(rpoAdvisory(120 * 1024 * 1024, { bytesPerSec: 1024 * 1024, windowSec: 3600, totalBytes: 1 }).level).toBe("warn");
  });

  it("always mentions the buffered-sample loss", () => {
    for (const a of [rpoAdvisory(null, null), rpoAdvisory(0, null), rpoAdvisory(1024, { bytesPerSec: 1024, windowSec: 60, totalBytes: 1 })]) {
      expect(a.detail).toMatch(/buffered samples/);
    }
  });
});

describe("estimateRto", () => {
  const base = { ttlSec: 30, monitorIntervalSec: 5, monitorRetries: 3, dnsTtlSec: 5 };

  it("produces the documented 1.5 to 3 minute range at the shipped defaults", () => {
    const e = estimateRto(base);
    expect(e.minSec).toBeGreaterThanOrEqual(60);
    expect(e.maxSec).toBeLessThanOrEqual(180);
    expect(e.maxSec).toBeGreaterThan(e.minSec);
  });

  it("grows with the lease TTL", () => {
    expect(estimateRto({ ...base, ttlSec: 60 }).maxSec).toBeGreaterThan(estimateRto(base).maxSec);
  });

  it("grows with a slower monitor and a longer DNS TTL", () => {
    expect(estimateRto({ ...base, monitorIntervalSec: 30 }).maxSec).toBeGreaterThan(estimateRto(base).maxSec);
    expect(estimateRto({ ...base, dnsTtlSec: 300 }).maxSec).toBeGreaterThan(estimateRto(base).maxSec);
  });

  it("never returns a max below its min, even on nonsense input", () => {
    const e = estimateRto({ ttlSec: 0, monitorIntervalSec: 0, monitorRetries: 0, dnsTtlSec: 0 });
    expect(e.maxSec).toBeGreaterThanOrEqual(e.minSec);
  });

  it("treats negative inputs as zero rather than shortening the estimate", () => {
    const e = estimateRto({ ttlSec: -30, monitorIntervalSec: -5, monitorRetries: -1, dnsTtlSec: -5 });
    expect(e.minSec).toBeGreaterThan(0);
  });

  it("warns when the operator's own settings push downtime past ten minutes", () => {
    expect(rtoAdvisory({ ...base, dnsTtlSec: 900 }).level).toBe("warn");
    expect(rtoAdvisory(base).level).toBe("ok");
  });
});

describe("sizingAdvisory", () => {
  it("adds growth headroom and the retained write-ahead log to the current size", () => {
    const a = sizingAdvisory({
      cpuCount: 8,
      totalMemBytes: 32 * 1024 ** 3,
      dbSizeBytes: 100 * 1024 ** 3,
      walKeepBytes: 20 * 1024 ** 3,
    });
    expect(a.level).toBe("ok");
    expect(a.minDbVolumeBytes).toBe(Math.ceil(100 * 1024 ** 3 * 1.3 + 20 * 1024 ** 3));
    expect(a.detail).toContain("8 vCPU");
  });

  it("still answers without a database size", () => {
    const a = sizingAdvisory({ cpuCount: 4, totalMemBytes: 8 * 1024 ** 3, dbSizeBytes: null, walKeepBytes: null });
    expect(a.level).toBe("ok");
    expect(a.minDbVolumeBytes).toBeUndefined();
  });

  it("is unknown when it cannot read the host at all", () => {
    expect(sizingAdvisory({ cpuCount: null, totalMemBytes: null, dbSizeBytes: null, walKeepBytes: null }).level).toBe("unknown");
  });
});

describe("assessInstallShape", () => {
  const supported: InstallShape = {
    platform: "linux", proxyMode: true, pgbouncer: false, localPgdata: true, docker: false,
  };

  it("accepts an nginx-fronted Linux install with a local database", () => {
    expect(assessInstallShape(supported)).toEqual({ supported: true, reasons: [] });
  });

  it("rejects Windows, containers, PgBouncer, a remote database and a missing proxy", () => {
    expect(assessInstallShape({ ...supported, platform: "win32" }).supported).toBe(false);
    expect(assessInstallShape({ ...supported, docker: true }).supported).toBe(false);
    expect(assessInstallShape({ ...supported, pgbouncer: true }).supported).toBe(false);
    expect(assessInstallShape({ ...supported, localPgdata: false }).supported).toBe(false);
    expect(assessInstallShape({ ...supported, proxyMode: false }).supported).toBe(false);
  });

  it("reports EVERY blocker at once so they can be fixed in one pass", () => {
    const v = assessInstallShape({ platform: "win32", proxyMode: false, pgbouncer: true, localPgdata: false, docker: true });
    expect(v.supported).toBe(false);
    expect(v.reasons.length).toBe(5);
  });

  it("explains the proxy requirement in terms of the pinned certificate", () => {
    const v = assessInstallShape({ ...supported, proxyMode: false });
    expect(v.reasons.join(" ")).toMatch(/certificate agents pin/);
  });
});

describe("placementConsequences", () => {
  it("covers all three locations and recommends exactly one", () => {
    const rows = placementConsequences();
    expect(rows.map((r) => r.placement).sort()).toEqual(["primary-dc", "standby-dc", "third-site"]);
    expect(rows.filter((r) => r.recommended).map((r) => r.placement)).toEqual(["third-site"]);
  });

  it("is the only row where losing the standby site demotes the primary", () => {
    const demoting = placementConsequences().filter((r) => r.standbyDcDark === "primary demotes");
    expect(demoting.map((r) => r.placement)).toEqual(["standby-dc"]);
  });

  it("is the only row where losing the primary datacenter needs a human", () => {
    const manual = placementConsequences().filter((r) => r.primaryDcDark === "manual");
    expect(manual.map((r) => r.placement)).toEqual(["primary-dc"]);
  });

  it("recovers a dead primary host automatically wherever the witness sits", () => {
    expect(placementConsequences().every((r) => r.primaryHostDies === "automatic")).toBe(true);
  });
});

describe("formatters", () => {
  it("scales bytes to a readable unit", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1024)).toBe("1 KiB");
    expect(formatBytes(1536)).toBe("1.5 KiB");
    expect(formatBytes(5 * 1024 ** 3)).toBe("5 GiB");
  });

  it("renders durations as seconds or minutes", () => {
    expect(formatDuration(45)).toBe("45 s");
    expect(formatDuration(120)).toBe("2 min");
    expect(formatDuration(150)).toBe("2 min 30 s");
  });
});
