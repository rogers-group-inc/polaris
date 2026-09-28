/**
 * tests/unit/alertResourceEmail.test.ts
 *
 * The high-CPU / high-memory alert email. Two changes, one reason: the host is
 * answering (that is how its CPU was read), so its connectivity graphs —
 * response time and packet loss — say nothing about the fault.
 *
 *   - buildAlertCharts keeps ONLY the CPU and memory charts on a CPU or memory
 *     alert, whichever fired, and never queries the probe tables for one.
 *   - `{processes.top}` (alertProcessService) lists the five programs using the
 *     most of that resource — ranked by CPU on a CPU alert, by memory on a
 *     memory alert — and renders away on every other alert.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

const { calls, processRows, lastProcessArgs } = vi.hoisted(() => ({
  calls: [] as string[],
  processRows: { rows: [] as unknown[] },
  lastProcessArgs: { args: null as unknown },
}));

vi.mock("../../src/db.js", () => ({
  prisma: {
    assetTelemetrySample: { findMany: vi.fn(async () => { calls.push("telemetry"); return []; }) },
    assetMonitorSample: { findMany: vi.fn(async () => { calls.push("monitor"); return []; }) },
    assetHardwareSensorSample: { findMany: vi.fn(async () => { calls.push("sensor"); return []; }) },
    assetPerfSlaSample: { findMany: vi.fn(async () => { calls.push("perfSla"); return []; }) },
    asset: { findUnique: vi.fn(async () => null) },
    assetProcess: {
      findMany: vi.fn(async (args: unknown) => {
        calls.push("processes");
        lastProcessArgs.args = args;
        return processRows.rows;
      }),
    },
  },
}));

vi.mock("@resvg/resvg-js", () => ({
  Resvg: class {
    render() { return { asPng: () => new Uint8Array([1, 2, 3]) }; }
  },
}));

vi.mock("../../src/services/downDetectionService.js", () => ({
  describeDownDetectionFor: vi.fn(async () => null),
  recoveryPollsFor: vi.fn(() => 0),
}));

import { buildAlertCharts, isResourceScopedAlert, type ChartToken } from "../../src/services/alertChartService.js";
import {
  ageBefore,
  buildTopProcessBlocks,
  loadTopProcesses,
  processRankingForMetric,
  processTokensIn,
  rankProcesses,
  renderTopProcesses,
  substituteProcessTokens,
  type TopProcessRow,
} from "../../src/services/alertProcessService.js";
import { isDeferredToken, renderNotificationTemplate } from "../../src/utils/notificationTemplate.js";
import { DEFAULT_ALERT_HTML, DEFAULT_ALERT_TEXT, pruneEmptyTextLines } from "../../src/utils/alertEmailTemplate.js";

const ALL_TOKENS: ChartToken[] = [
  "chart.trigger", "chart.sensor", "chart.probeLoss",
  "chart.sdwanLatency", "chart.sdwanJitter", "chart.sdwanLoss",
  "chart.cpu", "chart.memory", "chart.responseTime",
];

const NOW = new Date("2026-09-28T15:00:00Z");

beforeEach(() => {
  calls.length = 0;
  processRows.rows = [];
  lastProcessArgs.args = null;
});

describe("charts on a CPU / memory alert", () => {
  it("scopes exactly the three load metrics", () => {
    expect(isResourceScopedAlert("cpuPct")).toBe(true);
    expect(isResourceScopedAlert("memPct")).toBe(true);
    expect(isResourceScopedAlert("memUsedBytes")).toBe(true);
    expect(isResourceScopedAlert("responseTimeMs")).toBe(false);
    expect(isResourceScopedAlert(null)).toBe(false);
  });

  for (const metric of ["cpuPct", "memPct", "memUsedBytes"]) {
    it(`${metric}: draws CPU and memory only — no response time, no packet loss`, async () => {
      const charts = await buildAlertCharts("a1", ALL_TOKENS, { now: NOW, metric });
      const drawn = [...charts.keys()].filter((t) => t !== "chart.trigger").sort();
      expect(drawn).toEqual(["chart.cpu", "chart.memory"]);
      // The trigger alias still leads with the chart that fired.
      expect(charts.get("chart.trigger")?.token).toBe("chart.trigger");
      expect(charts.get("chart.trigger")?.cid).toBe(charts.get(metric === "cpuPct" ? "chart.cpu" : "chart.memory")?.cid);
      // Telemetry for the two lines, plus the probe history the CPU / memory
      // lines read for their failed-poll dives — and nothing else.
      expect(calls.sort()).toEqual(["monitor", "telemetry"]);
    });
  }

  it("does the same on the wizard's test email", async () => {
    const charts = await buildAlertCharts(null, ALL_TOKENS, { sampleData: true, metric: "cpuPct" });
    expect([...charts.keys()].filter((t) => t !== "chart.trigger").sort()).toEqual(["chart.cpu", "chart.memory"]);
  });

  it("adds nothing a body did not ask for", async () => {
    const charts = await buildAlertCharts("a1", ["chart.cpu", "chart.responseTime"], { now: NOW, metric: "memPct" });
    expect([...charts.keys()]).toEqual(["chart.cpu"]);
  });

  it("leaves every other alert's connectivity charts alone", async () => {
    const charts = await buildAlertCharts("a1", ALL_TOKENS, { now: NOW, metric: "responseTimeMs" });
    expect(charts.has("chart.responseTime")).toBe(true);
    expect(charts.has("chart.probeLoss")).toBe(true);
  });
});

const rows: TopProcessRow[] = [
  { name: "sqlservr.exe", instanceCount: 1, cpuPct: 150, memRssBytes: 8n * 1024n ** 3n },
  { name: "chrome.exe", instanceCount: 14, cpuPct: 30, memRssBytes: 3n * 1024n ** 3n },
  { name: "fresh.exe", instanceCount: 1, cpuPct: null, memRssBytes: 1024n ** 2n },
  { name: "idle.exe", instanceCount: 1, cpuPct: 0, memRssBytes: null },
  { name: "a.exe", instanceCount: 1, cpuPct: 5, memRssBytes: 512n * 1024n ** 2n },
  { name: "b.exe", instanceCount: 1, cpuPct: 5, memRssBytes: 256n * 1024n ** 2n },
  { name: "c.exe", instanceCount: 1, cpuPct: 1, memRssBytes: 128n * 1024n ** 2n },
];

describe("ranking", () => {
  it("maps the metric to the resource", () => {
    expect(processRankingForMetric("cpuPct")).toBe("cpu");
    expect(processRankingForMetric("memPct")).toBe("memory");
    expect(processRankingForMetric("memUsedBytes")).toBe("memory");
    expect(processRankingForMetric("responseTimeMs")).toBeNull();
  });

  it("ranks by CPU, drops the unmeasured, breaks ties by name, keeps five", () => {
    expect(rankProcesses(rows, "cpu").map((r) => r.name)).toEqual(["sqlservr.exe", "chrome.exe", "a.exe", "b.exe", "c.exe"]);
  });

  it("ranks by memory for a memory alert", () => {
    // fresh.exe (1 MiB) is measured for memory and ranks — just below the five;
    // idle.exe has no memory reading and is dropped, not ranked as zero.
    expect(rankProcesses(rows, "memory").map((r) => r.name)).toEqual(["sqlservr.exe", "chrome.exe", "a.exe", "b.exe", "c.exe"]);
    expect(rankProcesses(rows, "memory", 10).map((r) => r.name)).toEqual(["sqlservr.exe", "chrome.exe", "a.exe", "b.exe", "c.exe", "fresh.exe"]);
  });
});

describe("the rendered block", () => {
  const list = { ranking: "cpu" as const, rows: rankProcesses(rows, "cpu"), reportedAt: new Date(NOW.getTime() - 4 * 60_000) };

  it("leads a CPU list with CPU and says how old the inventory is", () => {
    const text = renderTopProcesses(list, { html: false, now: NOW });
    const lines = text.split("\n");
    expect(lines[0]).toBe("Top 5 processes by CPU (reported 4 min before this email · 100% CPU = one core)");
    expect(lines[1]).toMatch(/^ {2}Process\s+CPU\s+Memory$/);
    expect(lines[2]).toMatch(/^ {2}sqlservr\.exe\s+150\.0%\s+8 GiB$/);
    expect(lines[3]).toMatch(/^ {2}chrome\.exe ×14\s+30\.0%\s+3 GiB$/);
  });

  it("survives the text pruner line for line (no colons to trip it)", () => {
    const text = renderTopProcesses(list, { html: false, now: NOW });
    expect(text).not.toContain(":");
    expect(pruneEmptyTextLines(text)).toBe(text);
  });

  it("leads a memory list with memory", () => {
    const mem = { ranking: "memory" as const, rows: rankProcesses(rows, "memory"), reportedAt: null };
    const text = renderTopProcesses(mem, { html: false, now: NOW });
    expect(text.split("\n")[0]).toBe("Top 5 processes by memory (100% CPU = one core)");
    expect(text.split("\n")[1]).toMatch(/Process\s+Memory\s+CPU/);
    const html = renderTopProcesses(mem, { html: true, now: NOW });
    expect(html.indexOf(">Memory<")).toBeLessThan(html.indexOf(">CPU<"));
  });

  it("escapes process names in HTML and survives a replacement pattern", () => {
    const evil = { ranking: "cpu" as const, rows: [{ name: "<b>$&x", instanceCount: 1, cpuPct: 9, memRssBytes: null }], reportedAt: null };
    const html = renderTopProcesses(evil, { html: true, now: NOW });
    expect(html).toContain("&lt;b&gt;$&amp;x");
    expect(html).not.toContain("<b>");
    expect(html).toContain("Top process by CPU");
    expect(substituteProcessTokens("A{processes.top}B", "$&")).toBe("A$&B");
  });

  it("renders nothing when there is nothing to list", () => {
    expect(renderTopProcesses(null, { html: true })).toBe("");
    expect(renderTopProcesses({ ranking: "cpu", rows: [], reportedAt: null }, { html: false })).toBe("");
  });

  it("words the age", () => {
    expect(ageBefore(new Date(NOW.getTime() - 20_000), NOW)).toBe("just now");
    expect(ageBefore(new Date(NOW.getTime() - 3 * 3600_000), NOW)).toBe("3 h before this email");
    expect(ageBefore(null, NOW)).toBeNull();
  });
});

describe("loading", () => {
  it("never queries for an alert that is not about CPU or memory", async () => {
    expect(await loadTopProcesses("a1", "responseTimeMs")).toBeNull();
    expect(await loadTopProcesses(null, "cpuPct")).toBeNull();
    expect(calls).toEqual([]);
  });

  it("asks SQL for five rows ranked by the resource, nulls last", async () => {
    processRows.rows = [{ name: "x", instanceCount: 1, cpuPct: 3, memRssBytes: 1n, updatedAt: NOW }];
    const list = await loadTopProcesses("a1", "cpuPct", { now: NOW });
    const args = lastProcessArgs.args as { where: Record<string, unknown>; orderBy: unknown[]; take: number };
    expect(args.take).toBe(5);
    expect(args.where).toEqual({ assetId: "a1", cpuPct: { not: null } });
    expect(args.orderBy[0]).toEqual({ cpuPct: { sort: "desc", nulls: "last" } });
    expect(list?.reportedAt).toEqual(NOW);

    await loadTopProcesses("a1", "memPct", { now: NOW });
    const memArgs = lastProcessArgs.args as { orderBy: unknown[] };
    expect(memArgs.orderBy[0]).toEqual({ memRssBytes: { sort: "desc", nulls: "last" } });
  });

  it("renders away on a host with no process inventory", async () => {
    const blocks = await buildTopProcessBlocks("a1", "cpuPct", { now: NOW });
    expect(blocks).toEqual({ html: "", text: "" });
  });

  it("fills the wizard's test email with invented rows, no query", async () => {
    const blocks = await buildTopProcessBlocks(null, "memPct", { sample: true, now: NOW });
    expect(blocks.text).toContain("Top 5 processes by memory");
    expect(blocks.text).toContain("sqlservr.exe");
    expect(calls).toEqual([]);
  });
});

describe("the token in the default email", () => {
  it("is in both bodies, below the charts", () => {
    expect(DEFAULT_ALERT_TEXT.indexOf("{processes.top}")).toBeGreaterThan(DEFAULT_ALERT_TEXT.indexOf("{chart.responseTime}"));
    expect(DEFAULT_ALERT_HTML.indexOf("{processes.top}")).toBeGreaterThan(DEFAULT_ALERT_HTML.indexOf("{chart.responseTime}"));
    expect(processTokensIn(DEFAULT_ALERT_TEXT, DEFAULT_ALERT_HTML)).toEqual(new Set(["processes.top"]));
  });

  it("survives the compose-time render for the delivery pass to fill", () => {
    expect(isDeferredToken("processes.top")).toBe(true);
    expect(renderNotificationTemplate("x {processes.top} y", {}, { unknown: "blank" })).toBe("x {processes.top} y");
  });
});
