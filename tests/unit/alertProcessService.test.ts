/**
 * tests/unit/alertProcessService.test.ts — own suite for
 * src/services/alertProcessService.ts (CQ-T010).
 *
 * alertResourceEmail.test.ts pins the block inside the composed email (the
 * chart scoping, the pruner, the default template). This file covers the
 * module's own surface edge by edge: the metric gate (zero queries for any
 * other alert), the in-memory ranking, the read (scrape stamp, not row
 * updatedAt; failure → null), the age wording's boundaries, both rendered
 * forms, the invented test rows (rule 65) and the token helpers.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../src/db.js", () => import("./_dbStub.js"));

import { prisma } from "../../src/db.js";
import { resetDbStub, stubbed } from "./_dbStub.js";
import {
  ageBefore,
  buildTopProcessBlocks,
  loadTopProcesses,
  processRankingForMetric,
  processTokensIn,
  rankProcesses,
  renderTopProcesses,
  substituteProcessTokens,
  type TopProcessList,
  type TopProcessRow,
} from "../../src/services/alertProcessService.js";

const NOW = new Date("2026-11-14T12:00:00Z");
const minsAgo = (m: number) => new Date(NOW.getTime() - m * 60_000);
const row = (name: string, cpuPct: number | null, mem: bigint | null, instanceCount = 1): TopProcessRow => ({
  name, instanceCount, cpuPct, memRssBytes: mem,
});

beforeEach(() => resetDbStub());

describe("processRankingForMetric", () => {
  it("ranks CPU alerts (whole-host and per-core) by CPU", () => {
    expect(processRankingForMetric("cpuPct")).toBe("cpu");
    expect(processRankingForMetric("cpuCorePct")).toBe("cpu");
  });

  it("ranks every memory alert, the forecasts included, by memory", () => {
    for (const m of ["memPct", "memUsedBytes", "memDaysUntilFull", "memForecastPct"]) {
      expect(processRankingForMetric(m)).toBe("memory");
    }
  });

  it("is null for anything else, and for no metric", () => {
    for (const m of ["monitorStatus", "probeLossPct", "diskPct", "CPUPCT", "", null, undefined]) {
      expect(processRankingForMetric(m)).toBeNull();
    }
  });
});

describe("rankProcesses", () => {
  const rows = [
    row("b", 10, 300n), row("a", 10, 100n), row("c", null, 900n), row("d", 50, null), row("e", 0, 0n),
  ];

  it("ranks by CPU descending, ties by name, drops the unmeasured but keeps a measured zero", () => {
    expect(rankProcesses(rows, "cpu").map((r) => r.name)).toEqual(["d", "a", "b", "e"]);
  });

  it("ranks by memory, reading the bigint", () => {
    expect(rankProcesses(rows, "memory").map((r) => r.name)).toEqual(["c", "b", "a", "e"]);
  });

  it("keeps n (default five) and does not mutate its input", () => {
    const many = Array.from({ length: 8 }, (_, i) => row(`p${i}`, i, BigInt(i)));
    const before = many.map((r) => r.name);
    expect(rankProcesses(many, "cpu")).toHaveLength(5);
    expect(rankProcesses(many, "cpu", 2).map((r) => r.name)).toEqual(["p7", "p6"]);
    expect(many.map((r) => r.name)).toEqual(before);
    expect(rankProcesses([], "memory")).toEqual([]);
  });
});

describe("loadTopProcesses", () => {
  it("costs zero queries for an alert that is not about CPU or memory", async () => {
    expect(await loadTopProcesses("a-1", "monitorStatus")).toBeNull();
    expect(await loadTopProcesses("a-1", null)).toBeNull();
    expect(prisma.assetProcess.findMany).not.toHaveBeenCalled();
  });

  it("is null with no asset (a Polaris-internal alert)", async () => {
    expect(await loadTopProcesses(null, "cpuPct")).toBeNull();
    expect(prisma.assetProcess.findMany).not.toHaveBeenCalled();
  });

  it("reads five rows for a memory alert, ranked in SQL by memory, and dates them from the scrape stamp", async () => {
    stubbed(prisma.assetProcess.findMany).mockResolvedValue([row("java", 3, 2_000n), row("sql", 1, 9_000n)]);
    stubbed(prisma.assetInventoryScrape.findUnique).mockResolvedValue({ scrapedAt: minsAgo(4) });
    const list = await loadTopProcesses("a-1", "memPct");
    const args = stubbed(prisma.assetProcess.findMany).mock.calls[0]![0];
    expect(args).toMatchObject({
      where: { assetId: "a-1", memRssBytes: { not: null } },
      orderBy: [{ memRssBytes: { sort: "desc", nulls: "last" } }, { name: "asc" }],
      take: 5,
    });
    expect(stubbed(prisma.assetInventoryScrape.findUnique).mock.calls[0]![0]).toMatchObject({
      where: { assetId_kind: { assetId: "a-1", kind: "processes" } },
    });
    expect(list).toEqual({ ranking: "memory", rows: [row("sql", 1, 9_000n), row("java", 3, 2_000n)], reportedAt: minsAgo(4) });
  });

  it("filters on cpuPct for a CPU alert and leaves reportedAt null with no scrape row", async () => {
    stubbed(prisma.assetProcess.findMany).mockResolvedValue([row("x", 5, null)]);
    stubbed(prisma.assetInventoryScrape.findUnique).mockResolvedValue(null);
    const list = await loadTopProcesses("a-1", "cpuCorePct");
    expect(stubbed(prisma.assetProcess.findMany).mock.calls[0]![0].where).toEqual({ assetId: "a-1", cpuPct: { not: null } });
    expect(list).toMatchObject({ ranking: "cpu", reportedAt: null });
  });

  it("is null for a host with no process inventory", async () => {
    stubbed(prisma.assetProcess.findMany).mockResolvedValue([]);
    stubbed(prisma.assetInventoryScrape.findUnique).mockResolvedValue({ scrapedAt: NOW });
    expect(await loadTopProcesses("a-1", "cpuPct")).toBeNull();
  });

  it("is null, never a throw, when the read fails", async () => {
    stubbed(prisma.assetProcess.findMany).mockRejectedValue(new Error("connection reset"));
    stubbed(prisma.assetInventoryScrape.findUnique).mockResolvedValue(null);
    await expect(loadTopProcesses("a-1", "cpuPct")).resolves.toBeNull();
  });

  it("gives a test alert invented Example rows, three minutes old, with no query (rule 65)", async () => {
    const list = await loadTopProcesses(null, "cpuPct", { sample: true, now: NOW });
    expect(prisma.assetProcess.findMany).not.toHaveBeenCalled();
    expect(list!.rows).toHaveLength(5);
    expect(list!.rows.every((r) => r.name.startsWith("Example"))).toBe(true);
    expect(list!.rows[0]!.name).toBe("ExampleDatabase.exe");
    expect(list!.reportedAt).toEqual(minsAgo(3));
    const mem = await loadTopProcesses(null, "memPct", { sample: true, now: NOW });
    expect(mem!.rows.map((r) => r.name).slice(0, 2)).toEqual(["ExampleDatabase.exe", "ExampleWebWorker.exe"]);
  });

  it("still gates a test alert on the metric", async () => {
    expect(await loadTopProcesses(null, "monitorStatus", { sample: true })).toBeNull();
  });
});

describe("ageBefore", () => {
  it("is null with no stamp", () => {
    expect(ageBefore(null, NOW)).toBeNull();
  });

  it("words each range at its boundaries", () => {
    expect(ageBefore(new Date(NOW.getTime() - 29_000), NOW)).toBe("just now");
    expect(ageBefore(minsAgo(1), NOW)).toBe("1 min before this email");
    expect(ageBefore(minsAgo(119), NOW)).toBe("119 min before this email");
    expect(ageBefore(minsAgo(120), NOW)).toBe("2 h before this email");
    expect(ageBefore(minsAgo(47 * 60), NOW)).toBe("47 h before this email");
    expect(ageBefore(minsAgo(48 * 60), NOW)).toBe("2 days before this email");
  });

  it("reads a stamp in the future (clock skew) as just now", () => {
    expect(ageBefore(new Date(NOW.getTime() + 600_000), NOW)).toBe("just now");
  });
});

describe("renderTopProcesses", () => {
  const cpuList: TopProcessList = {
    ranking: "cpu",
    rows: [row("svchost.exe", 184.25, 1_073_741_824n, 71), row("lsass.exe", null, null)],
    reportedAt: minsAgo(4),
  };

  it("renders nothing for no list or no rows", () => {
    expect(renderTopProcesses(null, { html: true })).toBe("");
    expect(renderTopProcesses({ ranking: "cpu", rows: [], reportedAt: null }, { html: false })).toBe("");
  });

  it("text: heading with age and scale note, CPU column first, ×count, dashes for no reading", () => {
    const lines = renderTopProcesses(cpuList, { html: false, now: NOW }).split("\n");
    expect(lines[0]).toBe("Top 2 processes by CPU (reported 4 min before this email · 100% CPU = one core)");
    expect(lines[1]).toMatch(/^ {2}Process\s+CPU\s+Memory$/);
    expect(lines[2]).toMatch(/^ {2}svchost\.exe ×71\s+184\.3%\s+1 GiB$/);
    expect(lines[3]).toMatch(/^ {2}lsass\.exe\s+—\s+—$/);
    expect(lines.join("\n")).not.toContain(":");
  });

  it("text: a single row says 'process', and no age leaves only the scale note", () => {
    const text = renderTopProcesses({ ranking: "memory", rows: [row("a", 1, 2048n)], reportedAt: null }, { html: false, now: NOW });
    expect(text.split("\n")[0]).toBe("Top process by memory (100% CPU = one core)");
    expect(text.split("\n")[2]).toMatch(/^ {2}a\s+2 KiB\s+1\.0%$/);
  });

  it("html: one <tr> block, heading, bold ranked column, capitalised note, names escaped", () => {
    const html = renderTopProcesses(
      { ranking: "memory", rows: [row("<evil> & co", 2, 5_368_709_120n, 2)], reportedAt: minsAgo(0) },
      { html: true, now: NOW },
    );
    expect(html.startsWith("<tr><td")).toBe(true);
    expect(html.endsWith("</td></tr>")).toBe(true);
    expect(html).toContain(">Top process by memory</div>");
    expect(html).toContain("&lt;evil&gt; &amp; co ×2");
    expect(html).not.toContain("<evil>");
    expect(html).toMatch(/font-weight:600;">5 GiB<\/td>/);
    expect(html).toContain(">Reported just now · 100% CPU = one core</div>");
    // header row order follows the ranking
    expect(html.indexOf(">Memory</td>")).toBeLessThan(html.indexOf(">CPU</td>"));
  });
});

describe("buildTopProcessBlocks", () => {
  it("renders both bodies from one read against the same now", async () => {
    stubbed(prisma.assetProcess.findMany).mockResolvedValue([row("x", 90, 10n)]);
    stubbed(prisma.assetInventoryScrape.findUnique).mockResolvedValue({ scrapedAt: minsAgo(10) });
    const b = await buildTopProcessBlocks("a-1", "cpuPct", { now: NOW });
    expect(prisma.assetProcess.findMany).toHaveBeenCalledTimes(1);
    expect(b.text).toContain("reported 10 min before this email");
    expect(b.html).toContain("Reported 10 min before this email");
  });

  it("is two empty strings for an alert with no list", async () => {
    expect(await buildTopProcessBlocks("a-1", "diskPct")).toEqual({ html: "", text: "" });
  });

  it("passes the sample flag through", async () => {
    const b = await buildTopProcessBlocks(null, "memPct", { sample: true, now: NOW });
    expect(b.text).toContain("ExampleDatabase.exe");
  });
});

describe("processTokensIn / substituteProcessTokens", () => {
  it("finds {processes.top} across templates, skipping empties", () => {
    expect([...processTokensIn(undefined, null, "", "{processes.top}")]).toEqual(["processes.top"]);
    expect(processTokensIn("{processes.all} {processes}").size).toBe(0);
  });

  it("fills every occurrence literally — $ patterns stay text — and removes it when empty", () => {
    expect(substituteProcessTokens("a{processes.top}b{processes.top}", "$&")).toBe("a$&b$&");
    expect(substituteProcessTokens("a{processes.top}b", "")).toBe("ab");
    expect(substituteProcessTokens("", "X")).toBe("");
  });
});
