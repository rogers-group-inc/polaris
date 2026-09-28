/**
 * tests/integration/alertTopProcesses.test.ts — the top-5 process read behind
 * a high-CPU / high-memory alert email, against a real Postgres.
 *
 * The unit test pins the query SHAPE against a mock; this pins what only the
 * database can answer: that `nulls: "last"` on a nullable column plus the
 * not-null filter really do rank the measured programs and leave the
 * unmeasured ones out, and that the read is capped at five.
 */

import { afterAll, beforeAll, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { prisma } from "../../src/db.js";
import { dbDescribe } from "./_helpers.js";
import { buildTopProcessBlocks, loadTopProcesses } from "../../src/services/alertProcessService.js";

// asset_processes has no FK to assets, so a bare id isolates this file's rows.
const ASSET = randomUUID();

dbDescribe("top processes for a CPU / memory alert", () => {
  beforeAll(async () => {
    const row = (name: string, cpuPct: number | null, mem: bigint | null, instanceCount = 1) => ({
      id: randomUUID(), assetId: ASSET, name, instanceCount, cpuPct, memRssBytes: mem,
    });
    await prisma.assetProcess.createMany({
      data: [
        row("sqlservr.exe", 150, 8n * 1024n ** 3n),
        row("chrome.exe", 30, 3n * 1024n ** 3n, 14),
        row("unmeasured.exe", null, 9n * 1024n ** 3n),
        row("nomem.exe", 90, null),
        row("a.exe", 5, 512n * 1024n ** 2n),
        row("b.exe", 5, 256n * 1024n ** 2n),
        row("c.exe", 1, 128n * 1024n ** 2n),
      ],
    });
    // The block's age reads the scrape stamp (the delta write keeps an
    // unchanged row's updatedAt), so seed one as persistAssetProcesses would.
    await prisma.assetInventoryScrape.create({ data: { assetId: ASSET, kind: "processes", scrapedAt: new Date() } });
  });

  afterAll(async () => {
    await prisma.assetProcess.deleteMany({ where: { assetId: ASSET } });
    await prisma.assetInventoryScrape.deleteMany({ where: { assetId: ASSET } });
  });

  it("ranks by CPU, NULL CPU left out, capped at five", async () => {
    const list = await loadTopProcesses(ASSET, "cpuPct");
    expect(list?.ranking).toBe("cpu");
    expect(list?.rows.map((r) => r.name)).toEqual(["sqlservr.exe", "nomem.exe", "chrome.exe", "a.exe", "b.exe"]);
    expect(list?.reportedAt).toBeInstanceOf(Date);
  });

  it("ranks by memory for a memory alert, NULL memory left out", async () => {
    const list = await loadTopProcesses(ASSET, "memUsedBytes");
    expect(list?.rows.map((r) => r.name)).toEqual(["unmeasured.exe", "sqlservr.exe", "chrome.exe", "a.exe", "b.exe"]);
  });

  it("renders both bodies from the one read", async () => {
    const blocks = await buildTopProcessBlocks(ASSET, "cpuPct");
    expect(blocks.text.split("\n")[0]).toMatch(/^Top 5 processes by CPU \(reported (just now|\d+ min before this email) · 100% CPU = one core\)$/);
    expect(blocks.html).toContain("chrome.exe ×14");
  });

  it("an asset with no inventory, or a non-resource alert, gets nothing", async () => {
    expect(await loadTopProcesses(randomUUID(), "cpuPct")).toBeNull();
    expect(await loadTopProcesses(ASSET, "responseTimeMs")).toBeNull();
  });
});
