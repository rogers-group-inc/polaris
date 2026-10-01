/**
 * tests/integration/assetDependenciesContract.test.ts
 *
 * Contract coverage for GET /api/v1/assets/:id/dependencies — the ~262-line
 * dependency-tree read. Written as the PREREQUISITE for splitting it (same
 * tests-first sequencing as the /samples and assets-PUT splits): the
 * override-wins effective-parent rule, the per-child binding filter, the
 * grandchild layer, the type-then-hostname ordering, and the HA-peer block
 * are pinned here first.
 */

import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { app } from "../../src/app.js";
import { prisma } from "../../src/db.js";
import { authedAgent, dbDescribe, dbReachable, ensureTestUser } from "./_helpers.js";

const d = dbDescribe;
const HOST = "dep-contract-test";

let fwId = "";
let swId = "";
let apId = "";
let otherId = "";
let peerId = "";

async function wipe(): Promise<void> {
  await prisma.notification.deleteMany({ where: { assetHostname: { startsWith: HOST } } });
  await prisma.assetDependencyParent.deleteMany({ where: { asset: { hostname: { startsWith: HOST } } } });
  await prisma.assetDependencyParent.deleteMany({ where: { parent: { hostname: { startsWith: HOST } } } });
  await prisma.asset.deleteMany({ where: { hostname: { startsWith: HOST } } });
}

async function seed(): Promise<void> {
  await wipe();
  const mk = (over: Record<string, unknown>) =>
    prisma.asset.create({
      data: {
        status: "active", monitored: true, ...over,
      } as never,
    });
  const fw = await mk({
    hostname: `${HOST}-fw`, assetType: "firewall", dependencyLayer: 1,
    serialNumber: "FGDEPTESTA", fortinetTopology: { haPeerSerial: "fgdeptestb" },
  });
  const peer = await mk({
    hostname: `${HOST}-fw-peer`, assetType: "firewall", dependencyLayer: 1,
    serialNumber: "FGDEPTESTB", fortinetTopology: { haRole: "secondary" },
  });
  const sw = await mk({ hostname: `${HOST}-sw`, assetType: "switch", dependencyLayer: 2 });
  const ap = await mk({ hostname: `${HOST}-ap`, assetType: "access_point", dependencyLayer: 3 });
  const other = await mk({ hostname: `${HOST}-other`, assetType: "server" });
  fwId = fw.id; peerId = peer.id; swId = sw.id; apId = ap.id; otherId = other.id;

  // Computed DAG: fw → sw → ap.
  await prisma.assetDependencyParent.createMany({
    data: [
      { assetId: swId, parentAssetId: fwId, source: "computed", detectedVia: "test" },
      { assetId: apId, parentAssetId: swId, source: "computed", detectedVia: "test" },
    ] as never,
  });
}

async function getDeps(id: string) {
  const { agent } = await authedAgent(app);
  return agent.get(`/api/v1/assets/${id}/dependencies`);
}

beforeAll(async () => {
  if (!dbReachable) return;
  await prisma.$connect();
  await ensureTestUser();
});

afterAll(async () => {
  if (!dbReachable) return;
  try { await wipe(); await prisma.$disconnect(); } catch { /* noop */ }
});

beforeEach(async () => {
  if (!dbReachable) return;
  await seed();
});

d("GET /assets/:id/dependencies contract", () => {
  it("404s an unknown asset id", async () => {
    const resp = await getDeps("00000000-0000-0000-0000-000000000000");
    expect(resp.status).toBe(404);
  });

  it("computed-only: effectiveParents mirror computed and hasOverride is false", async () => {
    const resp = await getDeps(swId);
    expect(resp.status).toBe(200);
    expect(resp.body.hasOverride).toBe(false);
    expect(resp.body.computedParents.map((p: any) => p.parent.id)).toEqual([fwId]);
    expect(resp.body.effectiveParents.map((p: any) => p.parent.id)).toEqual([fwId]);
    expect(resp.body.overrideParents).toEqual([]);
  });

  it("an override set wins over computed for the effective view", async () => {
    await prisma.assetDependencyParent.create({
      data: { assetId: swId, parentAssetId: otherId, source: "override", detectedVia: "operator" } as never,
    });
    const resp = await getDeps(swId);
    expect(resp.status).toBe(200);
    expect(resp.body.hasOverride).toBe(true);
    expect(resp.body.effectiveParents.map((p: any) => p.parent.id)).toEqual([otherId]);
    // The computed set is still reported alongside.
    expect(resp.body.computedParents.map((p: any) => p.parent.id)).toEqual([fwId]);
  });

  it("children apply the per-child binding rule (a child's override replaces its computed edge)", async () => {
    // Before any override: sw is fw's (only) bound child.
    let resp = await getDeps(fwId);
    expect(resp.status).toBe(200);
    expect(resp.body.children.map((c: any) => c.id)).toEqual([swId]);

    // sw pins a DIFFERENT parent via override → its computed edge to fw is
    // no longer binding, so fw's children view drops it.
    await prisma.assetDependencyParent.create({
      data: { assetId: swId, parentAssetId: otherId, source: "override", detectedVia: "operator" } as never,
    });
    resp = await getDeps(fwId);
    expect(resp.status).toBe(200);
    expect(resp.body.children).toEqual([]);
  });

  // The downward view is the INFRA chain (firewall → switch → AP). The endpoint
  // half of the DAG makes every workstation / server / printer a child of the
  // switch, AP or gate that last saw it, and a site gate is the last-seen device
  // for the whole site — so those rows are deliberately excluded here even
  // though they're real dependency edges the reconciler suppresses on. The
  // endpoint's own General tab is where its dependency is shown, as its parent.
  it("excludes endpoint children from the downward view while keeping them upward", async () => {
    await prisma.assetDependencyParent.create({
      data: { assetId: otherId, parentAssetId: fwId, source: "endpoint", detectedVia: "sighting" } as never,
    });

    // Downward: the server does NOT appear among the gate's children.
    const down = await getDeps(fwId);
    expect(down.status).toBe(200);
    expect(down.body.children.map((c: any) => c.id)).toEqual([swId]);

    // Upward: the same edge IS the server's effective parent, and it reports the
    // signal that produced it so the UI can name it.
    const up = await getDeps(otherId);
    expect(up.status).toBe(200);
    expect(up.body.hasOverride).toBe(false);
    expect(up.body.effectiveParents.map((p: any) => p.parent.id)).toEqual([fwId]);
    expect(up.body.effectiveParents[0].source).toBe("endpoint");
    expect(up.body.effectiveParents[0].detectedVia).toBe("sighting");
    expect(up.body.children).toEqual([]);
  });

  // The "+N more" hint must never become an endpoint tally — it counts only the
  // infra children the caps left out, matching what the tree actually renders.
  it("counts only infra children in childCount", async () => {
    await prisma.assetDependencyParent.create({
      data: { assetId: otherId, parentAssetId: fwId, source: "endpoint", detectedVia: "sighting" } as never,
    });
    const resp = await getDeps(fwId);
    expect(resp.status).toBe(200);
    expect(resp.body.childCount).toBe(1); // the switch, not the switch + the server
    expect(resp.body.childrenTruncated).toBe(false);
  });

  it("renders one grandchild layer under each bound child, type-then-hostname ordered", async () => {
    const resp = await getDeps(fwId);
    expect(resp.status).toBe(200);
    const sw = resp.body.children.find((c: any) => c.id === swId);
    expect(sw).toBeTruthy();
    expect(sw.grandchildren.map((g: any) => g.id)).toEqual([apId]);
  });

  it("resolves the HA peer for firewalls via the case-insensitive serial stamp", async () => {
    const resp = await getDeps(fwId);
    expect(resp.status).toBe(200);
    expect(resp.body.haPeer).toBeTruthy();
    expect(resp.body.haPeer.id).toBe(peerId);
    expect(resp.body.haPeer.haRole).toBe("secondary");

    // Non-firewall assets never carry a peer block.
    const swResp = await getDeps(swId);
    expect(swResp.body.haPeer).toBeNull();
  });

  // Every rendered node carries the assets list's active-alert summary, so the
  // tree can show which device in the chain is alerting — an up device with a
  // live alert is otherwise indistinguishable from a quiet one.
  it("stamps each node's worst active alert, and null where nothing is firing", async () => {
    const alert = (assetId: string, hostname: string, severity: string, extra: Record<string, unknown> = {}) =>
      ({ assetId, assetHostname: hostname, severity, message: "test", ...extra });
    await prisma.notification.createMany({
      data: [
        alert(swId, `${HOST}-sw`, "warning"),
        alert(swId, `${HOST}-sw`, "serious", { acknowledged: true }),
        alert(apId, `${HOST}-ap`, "critical", { acknowledged: true }),
        alert(peerId, `${HOST}-fw-peer`, "notice"),
        // A cleared alert is history, not an active one.
        alert(fwId, `${HOST}-fw`, "critical", { cleared: true }),
      ] as never,
    });

    const resp = await getDeps(fwId);
    expect(resp.status).toBe(200);
    expect(resp.body.asset.activeAlert).toBeNull();
    expect(resp.body.haPeer.activeAlert).toEqual({ severity: "notice", count: 1, unacknowledged: 1 });
    const sw = resp.body.children.find((c: any) => c.id === swId);
    expect(sw.activeAlert).toEqual({ severity: "serious", count: 2, unacknowledged: 1 });
    expect(sw.grandchildren[0].activeAlert).toEqual({ severity: "critical", count: 1, unacknowledged: 0 });

    // Upward: the parent rows carry it too.
    const up = await getDeps(apId);
    expect(up.body.asset.activeAlert).toEqual({ severity: "critical", count: 1, unacknowledged: 0 });
    expect(up.body.effectiveParents[0].parent.activeAlert).toEqual({ severity: "serious", count: 2, unacknowledged: 1 });
  });
});
