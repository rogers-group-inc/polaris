/**
 * tests/integration/quarantineStranded.test.ts — business rule 165 against a
 * real database: a release that cannot reach a FortiGate still releases the
 * asset, REMEMBERS the gate, and that entry can be retried, cleared by the
 * background pass, dismissed, or superseded by a new quarantine.
 *
 * No device is called: `buildTransportForIntegration` is replaced so a gate is
 * "down" (throws) unless the test marks it reachable, and the retry service's
 * un-push is a stub. (`releaseQuarantine` calls its own un-push inside its
 * module, so the release cases here are all "every gate is down".)
 *
 * Skips cleanly when DATABASE_URL isn't reachable; see _helpers.ts.
 */

import { it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";

const gates = vi.hoisted(() => ({ reachable: new Set<string>(), unpushed: [] as string[] }));

vi.mock("../../src/services/reservationPushService.js", async (orig) => ({
  ...(await orig<object>()),
  buildTransportForIntegration: vi.fn(async (_integration: unknown, device: string) => {
    if (!gates.reachable.has(device)) throw new Error(`connect ETIMEDOUT ${device}`);
    return { device };
  }),
}));
vi.mock("../../src/services/assetQuarantineService.js", async (orig) => ({
  ...(await orig<object>()),
  // What quarantineStrandedService imports. Reaching it at all means the
  // transport was built, i.e. the gate is reachable.
  unpushQuarantineFromFortigate: vi.fn(async ({ transport }: { transport: { device: string } }) => {
    gates.unpushed.push(transport.device);
    return { removed: true, alreadyAbsent: false };
  }),
}));

import { app } from "../../src/app.js";
import { prisma } from "../../src/db.js";
import { authedAgent, dbDescribe, dbReachable, ensureTestUser, waitForEventCount } from "./_helpers.js";
import { retryAllStrandedQuarantine, retryStrandedQuarantine } from "../../src/services/quarantineStrandedService.js";
import { parseStranded } from "../../src/utils/quarantineStranded.js";

const d = dbDescribe;
const PFX = "qtn-stranded-test";
let integrationId = "";

async function cleanup() {
  await prisma.asset.deleteMany({ where: { hostname: { startsWith: PFX } } });
  await prisma.integration.deleteMany({ where: { name: { startsWith: PFX } } });
}

/** An asset quarantined on the given gates, as quarantineAsset would have left it. */
async function quarantined(suffix: string, devices: string[], intg = integrationId) {
  return prisma.asset.create({
    data: {
      hostname: `${PFX}-${suffix}`, assetType: "workstation", status: "quarantined",
      statusBeforeQuarantine: "active", monitoredBeforeQuarantine: true, monitored: false,
      quarantineReason: "test", quarantinedAt: new Date(), quarantinedBy: "t",
      quarantineTargets: devices.map((fortigateDevice) => ({ fortigateDevice, integrationId: intg, pushedMacs: ["AA:BB:CC:00:00:01"], pushedAt: new Date().toISOString(), status: "synced" })),
    } as never,
  });
}
const strandedOf = async (id: string) => parseStranded((await prisma.asset.findUnique({ where: { id } }))!.quarantineStranded);

beforeAll(async () => {
  if (!dbReachable) return;
  await prisma.$connect();
  await ensureTestUser();
});
beforeEach(async () => {
  if (!dbReachable) return;
  await cleanup();
  gates.reachable.clear();
  gates.unpushed.length = 0;
  integrationId = (await prisma.integration.create({ data: { name: `${PFX} fmg`, type: "fortimanager", config: {} } as never })).id;
});
afterAll(async () => {
  if (!dbReachable) return;
  await cleanup();
  await prisma.$disconnect();
});

d("releasing a quarantine when a FortiGate cannot be reached (rule 165)", () => {
  it("releases the asset as before, and remembers the gates that still hold the block", async () => {
    const a = await quarantined("release", ["FG-HQ", "FG-BRANCH"]);
    const adm = await authedAgent(app);
    const res = await adm.agent.delete(`/api/v1/assets/${a.id}/quarantine`).set("X-CSRF-Token", adm.csrf);

    // The response contract is unchanged: 200, released, failures listed.
    expect(res.status).toBe(200);
    expect(res.body.newStatus).toBe("active");
    expect(res.body.failedToUnpush.map((f: { fortigateDevice: string }) => f.fortigateDevice).sort()).toEqual(["FG-BRANCH", "FG-HQ"]);

    const after = await prisma.asset.findUnique({ where: { id: a.id } });
    expect(after!.status).toBe("active");
    expect(after!.monitored).toBe(true);
    expect(after!.quarantineTargets).toEqual([]);
    const stranded = parseStranded(after!.quarantineStranded);
    expect(stranded.map((e) => e.fortigateDevice).sort()).toEqual(["FG-BRANCH", "FG-HQ"]);
    expect(stranded[0]).toMatchObject({ integrationId, attempts: 1 });
    expect(stranded[0].error).toContain("ETIMEDOUT");

    // And it is on the status endpoint the panel reads.
    const status = await adm.agent.get(`/api/v1/assets/${a.id}/quarantine-status`);
    expect(status.body.quarantineStranded).toHaveLength(2);
  });

  it("remembers a gate whose integration was deleted, too", async () => {
    const a = await quarantined("orphan-intg", ["FG-GONE"], "integration-that-was-deleted");
    const adm = await authedAgent(app);
    expect((await adm.agent.delete(`/api/v1/assets/${a.id}/quarantine`).set("X-CSRF-Token", adm.csrf)).status).toBe(200);
    const stranded = await strandedOf(a.id);
    expect(stranded).toHaveLength(1);
    expect(stranded[0].error).toMatch(/no longer exists/);
  });
});

d("retrying, dismissing and superseding a stranded entry (rule 165)", () => {
  async function releasedWithStranded(suffix: string, devices: string[]) {
    const a = await quarantined(suffix, devices);
    const adm = await authedAgent(app);
    await adm.agent.delete(`/api/v1/assets/${a.id}/quarantine`).set("X-CSRF-Token", adm.csrf);
    return { a, adm };
  }

  it("Retry clears a gate that is back, keeps one that is not, and bumps its attempts", async () => {
    const { a, adm } = await releasedWithStranded("retry", ["FG-HQ", "FG-BRANCH"]);
    gates.reachable.add("FG-HQ");

    const res = await adm.agent.post(`/api/v1/assets/${a.id}/quarantine/stranded/retry`).set("X-CSRF-Token", adm.csrf).send({});
    expect(res.status).toBe(200);
    expect(res.body.cleared).toEqual(["FG-HQ"]);
    expect(gates.unpushed).toEqual(["FG-HQ"]);

    const left = await strandedOf(a.id);
    expect(left.map((e) => e.fortigateDevice)).toEqual(["FG-BRANCH"]);
    expect(left[0].attempts).toBe(2);

    await waitForEventCount("asset.quarantine.stranded_cleared", 1, a.id);
    const ev = await prisma.event.findFirst({ where: { action: "asset.quarantine.stranded_cleared", resourceId: a.id } });
    expect(ev!.message).toContain("FG-HQ");
    expect(ev!.message).toContain("1 FortiGate still holds it");
  });

  it("Retry can name one gate, and 404s for one that is not listed", async () => {
    const { a, adm } = await releasedWithStranded("retry-one", ["FG-HQ", "FG-BRANCH"]);
    gates.reachable.add("FG-HQ");
    gates.reachable.add("FG-BRANCH");
    const one = await adm.agent.post(`/api/v1/assets/${a.id}/quarantine/stranded/retry`).set("X-CSRF-Token", adm.csrf).send({ fortigateDevice: "FG-BRANCH" });
    expect(one.body.cleared).toEqual(["FG-BRANCH"]);
    expect((await strandedOf(a.id)).map((e) => e.fortigateDevice)).toEqual(["FG-HQ"]);
    const missing = await adm.agent.post(`/api/v1/assets/${a.id}/quarantine/stranded/retry`).set("X-CSRF-Token", adm.csrf).send({ fortigateDevice: "FG-NOPE" });
    expect(missing.status).toBe(404);
  });

  it("the background pass retries only entries whose backoff has elapsed", async () => {
    const { a } = await releasedWithStranded("job", ["FG-HQ"]);
    gates.reachable.add("FG-HQ");

    // Five minutes after the failed release: not due yet (15-minute backoff).
    const soon = await retryAllStrandedQuarantine(new Date(Date.now() + 5 * 60_000));
    expect(soon.cleared).toBe(0);
    expect(await strandedOf(a.id)).toHaveLength(1);

    const due = await retryAllStrandedQuarantine(new Date(Date.now() + 16 * 60_000));
    expect(due.cleared).toBeGreaterThanOrEqual(1);
    expect(await strandedOf(a.id)).toHaveLength(0);
  });

  it("Dismiss stops tracking without calling the device, and says so in Events", async () => {
    const { a, adm } = await releasedWithStranded("dismiss", ["FG-HQ", "FG-BRANCH"]);
    const res = await adm.agent.delete(`/api/v1/assets/${a.id}/quarantine/stranded?device=FG-HQ`).set("X-CSRF-Token", adm.csrf);
    expect(res.status).toBe(200);
    expect(gates.unpushed).toEqual([]);
    expect((await strandedOf(a.id)).map((e) => e.fortigateDevice)).toEqual(["FG-BRANCH"]);

    await waitForEventCount("asset.quarantine.stranded_dismissed", 1, a.id);
    const ev = await prisma.event.findFirst({ where: { action: "asset.quarantine.stranded_dismissed", resourceId: a.id } });
    expect(ev!.level).toBe("warning");
    expect(ev!.message).toContain("without removing it");

    // No `device`: everything left.
    expect((await adm.agent.delete(`/api/v1/assets/${a.id}/quarantine/stranded`).set("X-CSRF-Token", adm.csrf)).status).toBe(200);
    expect(await strandedOf(a.id)).toEqual([]);
    expect((await adm.agent.delete(`/api/v1/assets/${a.id}/quarantine/stranded`).set("X-CSRF-Token", adm.csrf)).status).toBe(404);
  });

  it("a token scoped to other integrations may not retry or dismiss the entry", async () => {
    const { a } = await releasedWithStranded("token", ["FG-HQ"]);
    await expect(retryStrandedQuarantine(a.id, { actor: "api:x", tokenIntegrationIds: ["some-other-integration"] })).rejects.toThrow(/not allowed/);
    expect(await strandedOf(a.id)).toHaveLength(1);
  });

  // ── Rule 165(a): the record of a block survives a delete and a merge ──────

  it("refuses to delete an asset still blocked on a FortiGate, single and bulk, until it is dismissed", async () => {
    const { a, adm } = await releasedWithStranded("del", ["FG-HQ"]);
    const one = await adm.agent.delete(`/api/v1/assets/${a.id}`).set("X-CSRF-Token", adm.csrf);
    expect(one.status).toBe(409);
    expect(one.body.error || one.body.message).toMatch(/still blocked on 1 FortiGate/);
    const bulk = await adm.agent.delete(`/api/v1/assets`).set("X-CSRF-Token", adm.csrf).send({ ids: [a.id] });
    expect(bulk.status).toBe(409);
    expect(await prisma.asset.findUnique({ where: { id: a.id } })).not.toBeNull();

    await adm.agent.delete(`/api/v1/assets/${a.id}/quarantine/stranded`).set("X-CSRF-Token", adm.csrf);
    expect((await adm.agent.delete(`/api/v1/assets/${a.id}`).set("X-CSRF-Token", adm.csrf)).status).toBeLessThan(300);
    expect(await prisma.asset.findUnique({ where: { id: a.id } })).toBeNull();
  });

  it("merging a released asset away hands its stranded gates to the survivor", async () => {
    const { a, adm } = await releasedWithStranded("merge-src", ["FG-HQ", "FG-BRANCH"]);
    const keep = await prisma.asset.create({ data: { hostname: `${PFX}-merge-keep`, assetType: "workstation", status: "active" } as never });
    const res = await adm.agent.post(`/api/v1/assets/${keep.id}/merge`).set("X-CSRF-Token", adm.csrf).send({ otherAssetId: a.id, survivor: "this" });
    expect(res.status).toBe(200);
    expect(await prisma.asset.findUnique({ where: { id: a.id } })).toBeNull();
    expect((await strandedOf(keep.id)).map((e) => e.fortigateDevice).sort()).toEqual(["FG-BRANCH", "FG-HQ"]);
    expect((await prisma.asset.findUnique({ where: { id: keep.id } }))!.status).toBe("active");
    await waitForEventCount("asset.quarantine.carried", 1, keep.id);

    // The survivor's own background retry now clears them.
    gates.reachable.add("FG-HQ");
    gates.reachable.add("FG-BRANCH");
    await retryAllStrandedQuarantine(new Date(Date.now() + 24 * 3600_000));
    expect(await strandedOf(keep.id)).toEqual([]);
  });

  it("merging a QUARANTINED asset away quarantines the survivor, and releasing the survivor un-pushes the gates", async () => {
    const q = await quarantined("merge-q", ["FG-HQ"]);
    const keep = await prisma.asset.create({ data: { hostname: `${PFX}-merge-q-keep`, assetType: "workstation", status: "active", monitored: false } as never });
    const adm = await authedAgent(app);
    // Even with the absorbed record's field chosen for Status, quarantine owns it.
    const res = await adm.agent.post(`/api/v1/assets/${keep.id}/merge`).set("X-CSRF-Token", adm.csrf)
      .send({ otherAssetId: q.id, survivor: "this", fieldWinners: { status: "this" } });
    expect(res.status).toBe(200);

    const after = await prisma.asset.findUnique({ where: { id: keep.id } });
    expect(after).toMatchObject({ status: "quarantined", statusBeforeQuarantine: "active", monitoredBeforeQuarantine: false, quarantineReason: "test", monitored: false });
    expect((after!.quarantineTargets as Array<{ fortigateDevice: string }>).map((t) => t.fortigateDevice)).toEqual(["FG-HQ"]);

    // The survivor is now protected like any quarantined asset…
    expect((await adm.agent.delete(`/api/v1/assets/${keep.id}`).set("X-CSRF-Token", adm.csrf)).status).toBe(409);
    // …and a release with the gate unreachable leaves it stranded on the survivor.
    const rel = await adm.agent.delete(`/api/v1/assets/${keep.id}/quarantine`).set("X-CSRF-Token", adm.csrf);
    expect(rel.status).toBe(200);
    expect(rel.body.newStatus).toBe("active");
    expect((await strandedOf(keep.id)).map((e) => e.fortigateDevice)).toEqual(["FG-HQ"]);
  });

  it("merging INTO a quarantined asset with another status chosen leaves the quarantine in force", async () => {
    const q = await quarantined("merge-into", ["FG-HQ"]);
    const other = await prisma.asset.create({ data: { hostname: `${PFX}-merge-into-other`, assetType: "workstation", status: "storage" } as never });
    const adm = await authedAgent(app);
    const res = await adm.agent.post(`/api/v1/assets/${q.id}/merge`).set("X-CSRF-Token", adm.csrf)
      .send({ otherAssetId: other.id, survivor: "this", fieldWinners: { status: "other" } });
    expect(res.status).toBe(200);
    expect((await prisma.asset.findUnique({ where: { id: q.id } }))!.status).toBe("quarantined");
  });

  it("an asset with nothing stranded is untouched by the background pass", async () => {
    const plain = await prisma.asset.create({ data: { hostname: `${PFX}-plain`, assetType: "server", status: "active" } as never });
    await retryAllStrandedQuarantine(new Date(Date.now() + 24 * 3600_000));
    expect((await prisma.asset.findUnique({ where: { id: plain.id } }))!.quarantineStranded).toEqual([]);
  });
});
