/**
 * tests/unit/inventoryPresence.test.ts
 *
 * getInventoryPresence decides whether the asset slide-over draws the Services
 * and Software tabs at all: a tab appears only when something is pulling that
 * information in — rows, or a scrape stamp from a source that reported an
 * empty list. Prisma is mocked per table.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const { has } = vi.hoisted(() => ({
  has: { service: false, process: false, software: false, svcScrape: false, swScrape: false, lastScrapeWheres: [] as any[] },
}));

vi.mock("../../src/db.js", () => ({
  prisma: {
    assetService:  { findFirst: vi.fn(async () => (has.service ? { id: "s" } : null)) },
    assetProcess:  { findFirst: vi.fn(async () => (has.process ? { id: "p" } : null)) },
    assetSoftware: { findFirst: vi.fn(async () => (has.software ? { id: "w" } : null)) },
    assetInventoryScrape: {
      findFirst: vi.fn(async (a: any) => {
        has.lastScrapeWheres.push(a.where);
        if (a.where.kind?.in) return has.svcScrape ? { kind: "services" } : null;
        if (a.where.kind?.startsWith) return has.swScrape ? { kind: "software:intune" } : null;
        return null;
      }),
    },
  },
}));
vi.mock("../../src/utils/dbRetry.js", () => ({ retryOnDeadlock: (fn: () => Promise<unknown>) => fn() }));

import { getInventoryPresence } from "../../src/services/serviceInventoryService.js";

beforeEach(() => {
  Object.assign(has, { service: false, process: false, software: false, svcScrape: false, swScrape: false, lastScrapeWheres: [] });
});

describe("getInventoryPresence", () => {
  it("a host nothing reports on gets neither tab", async () => {
    expect(await getInventoryPresence("a")).toEqual({ services: false, software: false });
  });

  it("services: unit rows, process rows (agentless polling), or a services/processes stamp", async () => {
    has.service = true;
    expect((await getInventoryPresence("a")).services).toBe(true);
    has.service = false; has.process = true;
    expect((await getInventoryPresence("a")).services).toBe(true);
    has.process = false; has.svcScrape = true;
    expect((await getInventoryPresence("a")).services).toBe(true);
  });

  it("software: rows, or any source's software stamp — an empty list still counts", async () => {
    has.software = true;
    expect(await getInventoryPresence("a")).toEqual({ services: false, software: true });
    has.software = false; has.swScrape = true;
    expect(await getInventoryPresence("a")).toEqual({ services: false, software: true });
  });

  it("asks the scrape table for exactly the right kinds", async () => {
    await getInventoryPresence("a");
    expect(has.lastScrapeWheres).toContainEqual({ assetId: "a", kind: { in: ["services", "processes"] } });
    expect(has.lastScrapeWheres).toContainEqual({ assetId: "a", kind: { startsWith: "software" } });
  });
});
