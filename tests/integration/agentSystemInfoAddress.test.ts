/**
 * tests/integration/agentSystemInfoAddress.test.ts
 *
 * Business rule 195 through POST /api/v1/agents/system-info: the address the
 * agent connects from becomes the asset's primary when the agent's own report
 * backs it — on the push itself, not the next discovery run.
 *
 * The caller address is what Express resolves (`req.ip`), so the deployment
 * shapes are covered by toggling `trust proxy`: behind nginx (trusted
 * loopback, X-Forwarded-For carries the agent), and direct with no proxy trust
 * (the loopback peer confirms nothing — the feature degrades to rule 101).
 *
 * Skips cleanly when DATABASE_URL isn't reachable (tests/integration/_helpers).
 */

import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import request from "supertest";
import { app } from "../../src/app.js";
import { prisma } from "../../src/db.js";
import { dbDescribe, dbReachable } from "./_helpers.js";
import { generateRawToken, TOKEN_INDEX_PREFIX_LEN } from "../../src/utils/bearerToken.js";
import { hashPassword } from "../../src/utils/password.js";

const d = dbDescribe;
const HOST = "agent-sysinfo-addr-test";
const IP_ETH = "10.96.175.193";
const IP_WIFI = "10.96.174.134";
const IP_VIRTUAL = "172.29.0.1";

let assetId = "";
let bearer = "";
const priorTrustProxy = app.get("trust proxy");

async function seed(extra: Record<string, unknown> = {}): Promise<void> {
  await prisma.managedAgent.deleteMany({ where: { asset: { hostname: HOST } } });
  await prisma.asset.deleteMany({ where: { hostname: HOST } });
  const now = new Date();
  const asset = await prisma.asset.create({
    data: {
      hostname: HOST, assetType: "workstation", status: "active",
      ipAddress: IP_WIFI, ipSource: "GW-1",
      ...extra,
    } as never,
  });
  assetId = asset.id;
  // The agent's interface report: the virtual adapter it enumerates first, and
  // the real Ethernet card.
  await prisma.assetAssociatedIp.createMany({
    data: [IP_VIRTUAL, IP_ETH].map((ip) => ({ assetId, ip, source: "agent-interface", firstSeen: now, lastSeen: now })),
  });
  bearer = generateRawToken();
  await prisma.managedAgent.create({
    data: {
      assetId, osPlatform: "windows", arch: "amd64", installStatus: "active", installedBy: "test",
      serverCertFingerprint: "sha256:" + "e".repeat(64), additionalServerCertFingerprints: [],
      bearerPrefix: bearer.slice(0, TOKEN_INDEX_PREFIX_LEN), bearerHash: await hashPassword(bearer),
    },
  });
}

function push(fromIp: string | null, body: Record<string, unknown> = {}) {
  const r = request(app).post("/api/v1/agents/system-info").set("Authorization", `Bearer ${bearer}`);
  if (fromIp) r.set("X-Forwarded-For", fromIp);
  return r.send({ hostname: HOST, primaryIp: IP_VIRTUAL, ...body });
}

const readAsset = () =>
  prisma.asset.findUnique({ where: { id: assetId }, select: { ipAddress: true, ipSource: true } });
const agentObserved = async () =>
  (await prisma.assetSource.findFirst({ where: { assetId, sourceKind: "polaris-agent" }, select: { observed: true } }))
    ?.observed as Record<string, unknown> | undefined;

beforeAll(async () => {
  if (!dbReachable) return;
  await prisma.$connect();
});

afterAll(async () => {
  if (!dbReachable) return;
  try {
    await prisma.managedAgent.deleteMany({ where: { asset: { hostname: HOST } } });
    await prisma.asset.deleteMany({ where: { hostname: HOST } });
    await prisma.$disconnect();
  } catch { /* noop */ }
});

beforeEach(async () => {
  if (!dbReachable) return;
  // Behind nginx: the proxy hop is loopback and is trusted.
  app.set("trust proxy", "loopback");
  await seed();
});

afterEach(() => {
  app.set("trust proxy", priorTrustProxy);
});

d("POST /agents/system-info — the agent's confirmed address (business rule 195)", () => {
  it("the HMI: the address the agent connects from takes the primary at once", async () => {
    const resp = await push(IP_ETH);
    expect(resp.status).toBe(200);
    expect(await readAsset()).toEqual({ ipAddress: IP_ETH, ipSource: "polaris-agent" });
    expect((await agentObserved())?.confirmedIp).toBe(IP_ETH);
    const ev = await prisma.event.findFirst({ where: { resourceId: assetId, action: "asset.address.agent" } });
    expect(ev?.message).toContain(IP_WIFI);
  });

  it("never the raw primaryIp: a virtual adapter enumerated first decides nothing", async () => {
    // Connecting from an address the host does not report — a NAT in between.
    await push("10.9.9.9");
    expect(await readAsset()).toMatchObject({ ipAddress: IP_WIFI });
    expect((await agentObserved())?.confirmedIp).toBeUndefined();
  });

  it("a later push without confirmation drops the claim from the blob", async () => {
    await push(IP_ETH);
    await push("10.9.9.9");
    expect((await agentObserved())?.confirmedIp).toBeUndefined();
  });

  it("a primary-address pin stands", async () => {
    await prisma.asset.update({
      where: { id: assetId },
      data: { primaryAddressMac: "AA:BB:CC:00:00:01", primaryAddressIp: IP_WIFI, primaryAddressPinnedAt: new Date() },
    });
    await push(IP_ETH);
    expect(await readAsset()).toMatchObject({ ipAddress: IP_WIFI });
  });

  it("direct, with no proxy trust: the loopback peer confirms nothing", async () => {
    app.set("trust proxy", false);
    await push(IP_ETH);
    expect(await readAsset()).toMatchObject({ ipAddress: IP_WIFI });
    expect((await agentObserved())?.confirmedIp).toBeUndefined();
  });
});
