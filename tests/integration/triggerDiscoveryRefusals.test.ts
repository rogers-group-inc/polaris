/**
 * tests/integration/triggerDiscoveryRefusals.test.ts — what triggerDiscovery
 * refuses before a run is queued (services/integrationAdapters.ts, CQ-B064).
 *
 * runDiscovery's collector dispatch used to end in a bare `else` that ran
 * FortiManager discovery, so a type no branch named — the AI assistant, or a
 * row carrying a type this release does not know — was aimed at an FMG
 * collector. The adapter registry now answers first: no adapter → 400, no
 * discovery → 400, a missing field → the adapter's own message. None of them
 * queues a DiscoveryRun.
 */

import { it, expect, beforeAll, afterAll } from "vitest";
import { dbDescribe } from "./_helpers.js";
import { prisma } from "../../src/db.js";
import { triggerDiscovery } from "../../src/services/discovery/discoveryEngine.js";

const PFX = `tdr-${Date.now()}`;
const ids: Record<string, string> = {};

dbDescribe("triggerDiscovery refusals", () => {
  beforeAll(async () => {
    const mk = async (key: string, type: string, config: Record<string, unknown>) => {
      ids[key] = (await prisma.integration.create({
        data: { name: `${PFX}-${key}`, type, enabled: false, config: config as never },
      })).id;
    };
    await mk("unknown", "paloalto", { host: "fw.example" });
    await mk("llm", "llm", { baseUrl: "http://127.0.0.1:11434" });
    await mk("entra", "entraid", { tenantId: "t" });
    await mk("fmg", "fortimanager", { host: "fmg.example" });
  });

  afterAll(async () => {
    await prisma.discoveryRun.deleteMany({ where: { integrationId: { in: Object.values(ids) } } }).catch(() => {});
    await prisma.integration.deleteMany({ where: { name: { startsWith: PFX } } });
  });

  it("refuses a type this release does not know, instead of running FortiManager discovery", async () => {
    await expect(triggerDiscovery(ids.unknown, "test")).rejects.toMatchObject({
      httpStatus: 400, message: expect.stringContaining("unknown integration type (paloalto)"),
    });
  });

  it("refuses the AI assistant: nothing to discover", async () => {
    await expect(triggerDiscovery(ids.llm, "test")).rejects.toMatchObject({
      httpStatus: 400, message: expect.stringContaining("is not a discovery integration"),
    });
  });

  it("names the first missing field from the type's adapter", async () => {
    await expect(triggerDiscovery(ids.entra, "test")).rejects.toMatchObject({
      httpStatus: 400, message: "Integration has no client ID configured",
    });
    await expect(triggerDiscovery(ids.fmg, "test")).rejects.toMatchObject({
      httpStatus: 400, message: "Integration has no API token configured",
    });
  });

  it("queues no run for any of them", async () => {
    const runs = await prisma.discoveryRun.count({ where: { integrationId: { in: Object.values(ids) } } });
    expect(runs).toBe(0);
  });
});
