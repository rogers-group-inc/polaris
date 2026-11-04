/**
 * tests/integration/integrationFortigateRoster.test.ts
 *
 * GET /integrations/:id/fortigates — the Query API window's FortiGate picker.
 * Lists the integration's discovered, not-decommissioned firewalls by
 * FortiManager device name, one entry per HA cluster; never another
 * integration's gates; 400 for an integration type that discovers none.
 */

import { afterAll, beforeAll, expect, it } from "vitest";
import { app } from "../../src/app.js";
import { prisma } from "../../src/db.js";
import { authedAgent, dbDescribe, dbReachable, ensureTestUser } from "./_helpers.js";

const d = dbDescribe;
const NAME = "IT fortigate roster";
const SERIALS = ["FGTROSTER0001", "FGTROSTER0002", "FGTROSTER0003", "FGTROSTER0004", "FGTROSTER0005"];
let fmgId = "";
let otherId = "";
let entraId = "";

async function cleanup(): Promise<void> {
  await prisma.asset.deleteMany({ where: { serialNumber: { in: SERIALS } } });
  await prisma.integration.deleteMany({ where: { name: { startsWith: NAME } } });
}

beforeAll(async () => {
  if (!dbReachable) return;
  await ensureTestUser();
  await cleanup();
  fmgId = (await prisma.integration.create({ data: { type: "fortimanager", name: `${NAME} fmg`, config: {}, enabled: true } })).id;
  otherId = (await prisma.integration.create({ data: { type: "fortimanager", name: `${NAME} other`, config: {}, enabled: true } })).id;
  entraId = (await prisma.integration.create({ data: { type: "entraid", name: `${NAME} entra`, config: {}, enabled: true } })).id;
  const fw = (serial: string, integrationId: string, hostname: string, topo: Record<string, unknown>, status = "active") =>
    prisma.asset.create({ data: {
      serialNumber: serial, hostname, assetType: "firewall", status, discoveredByIntegrationId: integrationId,
      fortinetTopology: { role: "fortigate", ...topo },
    } });
  await fw(SERIALS[0], fmgId, "hq-a", { deviceName: "HQ-CLUSTER", haRole: "primary" });
  await fw(SERIALS[1], fmgId, "hq-b", { deviceName: "HQ-CLUSTER", haRole: "secondary" });
  await fw(SERIALS[2], fmgId, "branch-7", { deviceName: "BRANCH-7-61F" });
  await fw(SERIALS[3], fmgId, "gone", { deviceName: "GONE-61F" }, "decommissioned");
  await fw(SERIALS[4], otherId, "elsewhere", { deviceName: "OTHER-61F" });
});
afterAll(async () => { if (dbReachable) await cleanup(); });

d("GET /integrations/:id/fortigates", () => {
  it("lists this integration's live gates by FortiManager name, one per HA cluster", async () => {
    const { agent } = await authedAgent(app);
    const res = await agent.get(`/api/v1/integrations/${fmgId}/fortigates`);
    expect(res.status).toBe(200);
    expect(res.body.fortigates.map((g: any) => g.deviceName)).toEqual(["BRANCH-7-61F", "HQ-CLUSTER"]);
    expect(res.body.fortigates.find((g: any) => g.deviceName === "HQ-CLUSTER").hostname).toBe("hq-a");
  });

  it("refuses an integration type that discovers no FortiGates, and an unknown id", async () => {
    const { agent } = await authedAgent(app);
    expect((await agent.get(`/api/v1/integrations/${entraId}/fortigates`)).status).toBe(400);
    expect((await agent.get(`/api/v1/integrations/00000000-0000-0000-0000-000000000000/fortigates`)).status).toBe(404);
  });
});
