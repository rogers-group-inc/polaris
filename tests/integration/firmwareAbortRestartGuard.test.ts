/**
 * tests/integration/firmwareAbortRestartGuard.test.ts
 *
 * Business rule 138, end to end through the routes. A firmware flash runs
 * inside the web process (rule 87), so Apply Update and Restart refuse 409
 * while one is live — naming the asset, its stage and who started it — and
 * go ahead only when the operator chose "abort and continue", in which case
 * the run is aborted IN THEIR NAME first: the run's log line, its error and a
 * firmware.upgrade_aborted Event all say who and why. Also: the nav bar's
 * list of live runs, and its Abort.
 *
 * The runs here are rows with no runner behind them (nothing is flashed), so
 * every abort takes the "no runner was driving this run" path; the runner's
 * own abort is pinned in tests/unit/firmwareUpgradeGates.test.ts.
 */

import { it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";

const h = vi.hoisted(() => ({ restartService: vi.fn(), applyUpdate: vi.fn(async () => undefined) }));

vi.mock("../../src/utils/deploymentContext.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/utils/deploymentContext.js")>()),
  runtimeIsContainer: () => false,
}));

vi.mock("../../src/services/updateService.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/services/updateService.js")>()),
  restartService: h.restartService,
  applyUpdate: h.applyUpdate,
  isUpdateMechanismAvailable: () => true,
}));

// The boot sweep closes every queued / running run with no runner — exactly
// the rows these cases insert — and it fires on import with nothing to await,
// so on a cold DB it can land after a fixture and fail it first.
vi.mock("../../src/jobs/failOrphanedFirmwareRuns.js", () => ({}));

import { app } from "../../src/app.js";
import { prisma } from "../../src/db.js";
import { authedAgent, dbReachable, dbDescribe, ensureTestUser } from "./_helpers.js";

const d = dbDescribe;
const HOST = "fwabort-sw1";
let assetId = "";
let username = "";

async function liveRun(stage = "deploying"): Promise<string> {
  await prisma.firmwareUpgradeRun.deleteMany({ where: { assetId } });
  const run = await prisma.firmwareUpgradeRun.create({
    data: { assetId, platform: "S108FF", fromVersion: "7.4.3 build0542", toVersion: "7.6.8 build1164", engine: "fortiswitch-https", status: "running", stage, startedBy: "ops-person", log: [{ t: new Date().toISOString(), level: "info", msg: "stage: " + stage }] },
  });
  return run.id;
}

beforeAll(async () => {
  if (!dbReachable) return;
  await prisma.$connect();
  username = (await ensureTestUser()).username;
  await prisma.asset.deleteMany({ where: { hostname: HOST } });
  const a = await prisma.asset.create({ data: { hostname: HOST, assetType: "switch", manufacturer: "Fortinet", serialNumber: "S108FFTF23009138", ipAddress: "192.0.2.138", monitored: false } });
  assetId = a.id;
});

afterAll(async () => {
  if (!dbReachable) return;
  await prisma.asset.deleteMany({ where: { hostname: HOST } });
  await prisma.$disconnect();
});

beforeEach(() => {
  h.restartService.mockClear();
  h.applyUpdate.mockClear();
});

d("the nav bar's live firmware runs", () => {
  it("lists a live run with its asset, stage and who started it, and Abort closes it in the aborter's name", async () => {
    const runId = await liveRun("staging");
    const { agent, csrf } = await authedAgent(app);
    const list = await agent.get("/api/v1/assets/firmware-runs/active");
    expect(list.status).toBe(200);
    expect(list.body.runs.find((r: { id: string }) => r.id === runId)).toMatchObject({ assetId, assetName: HOST, stage: "staging", startedBy: "ops-person", toVersion: "7.6.8 build1164" });

    const res = await agent.post(`/api/v1/assets/${assetId}/firmware-upgrade/runs/${runId}/abort`).set("X-CSRF-Token", csrf).send({});
    expect(res.status).toBe(200);
    expect(res.body.run).toMatchObject({ status: "failed", result: "aborted" });
    const row = await prisma.firmwareUpgradeRun.findUniqueOrThrow({ where: { id: runId } });
    expect(row.error).toMatch(new RegExp(`^Aborted by ${username} during staging`));
    expect((row.log as Array<{ msg: string }>).at(-1)!.msg).toMatch(new RegExp(`^aborted by ${username} during staging`));
    const ev = await prisma.event.findFirst({ where: { action: "firmware.upgrade_aborted", resourceId: assetId }, orderBy: { timestamp: "desc" } });
    expect(ev?.actor).toBe(username);

    // Ended now: a second Abort is a 409, and the list no longer has it.
    const again = await agent.post(`/api/v1/assets/${assetId}/firmware-upgrade/runs/${runId}/abort`).set("X-CSRF-Token", csrf).send({});
    expect(again.status).toBe(409);
    const after = await agent.get("/api/v1/assets/firmware-runs/active");
    expect(after.body.runs.find((r: { id: string }) => r.id === runId)).toBeUndefined();
  });

  it("refuses another asset's run with 404", async () => {
    const runId = await liveRun();
    const { agent, csrf } = await authedAgent(app);
    const res = await agent.post(`/api/v1/assets/00000000-0000-0000-0000-000000000000/firmware-upgrade/runs/${runId}/abort`).set("X-CSRF-Token", csrf).send({});
    expect(res.status).toBe(404);
    expect((await prisma.firmwareUpgradeRun.findUniqueOrThrow({ where: { id: runId } })).status).toBe("running");
  });
});

d("Restart while a flash is live", () => {
  it("refuses 409 naming the run, and never restarts", async () => {
    const runId = await liveRun();
    const { agent, csrf } = await authedAgent(app);
    const res = await agent.post("/api/v1/server-settings/restart").set("X-CSRF-Token", csrf).send({});
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("firmware-upgrade-running");
    expect(res.body.error).toMatch(new RegExp(`${HOST} \\(deploying, started by ops-person\\)`));
    expect(res.body.firmwareRuns.map((r: { id: string }) => r.id)).toContain(runId);
    await new Promise((r) => setTimeout(r, 700));
    expect(h.restartService).not.toHaveBeenCalled();
    expect((await prisma.firmwareUpgradeRun.findUniqueOrThrow({ where: { id: runId } })).status).toBe("running");
  });

  it("with abortFirmwareRuns aborts the run in the operator's name, then restarts", async () => {
    const runId = await liveRun();
    const { agent, csrf } = await authedAgent(app);
    const res = await agent.post("/api/v1/server-settings/restart").set("X-CSRF-Token", csrf).send({ abortFirmwareRuns: true });
    expect(res.status).toBe(200);
    const row = await prisma.firmwareUpgradeRun.findUniqueOrThrow({ where: { id: runId } });
    expect(row).toMatchObject({ status: "failed", result: "aborted" });
    expect(row.error).toMatch(new RegExp(`^Aborted by ${username} during deploying \\(to restart Polaris\\)`));
    await new Promise((r) => setTimeout(r, 700));
    expect(h.restartService).toHaveBeenCalledTimes(1);
  });
});

d("Apply Update while a flash is live", () => {
  it("refuses 409 without the flag and never starts the update", async () => {
    await liveRun();
    const { agent, csrf } = await authedAgent(app);
    const res = await agent.post("/api/v1/server-settings/updates/apply").set("X-CSRF-Token", csrf).send({});
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("firmware-upgrade-running");
    expect(h.applyUpdate).not.toHaveBeenCalled();
  });

  it("with abortFirmwareRuns aborts it — the log and Event say who and why — then starts the update", async () => {
    const runId = await liveRun();
    const { agent, csrf } = await authedAgent(app);
    const res = await agent.post("/api/v1/server-settings/updates/apply").set("X-CSRF-Token", csrf).send({ abortFirmwareRuns: true });
    expect(res.status).toBe(200);
    expect(h.applyUpdate).toHaveBeenCalledTimes(1);
    const row = await prisma.firmwareUpgradeRun.findUniqueOrThrow({ where: { id: runId } });
    expect(row.error).toMatch(new RegExp(`^Aborted by ${username} during deploying \\(to apply an in-app update\\)`));
    expect((row.log as Array<{ msg: string }>).at(-1)!.msg).toBe(`aborted by ${username} during deploying — to apply an in-app update (no runner was driving this run)`);
    const ev = await prisma.event.findFirst({ where: { action: "firmware.upgrade_aborted", resourceId: assetId }, orderBy: { timestamp: "desc" } });
    expect(ev).toMatchObject({ actor: username });
    expect(ev?.message).toMatch(/to apply an in-app update/);
  });

  it("goes straight through when nothing is flashing", async () => {
    await prisma.firmwareUpgradeRun.deleteMany({ where: { assetId } });
    const { agent, csrf } = await authedAgent(app);
    const res = await agent.post("/api/v1/server-settings/updates/apply").set("X-CSRF-Token", csrf).send({});
    expect(res.status).toBe(200);
    expect(h.applyUpdate).toHaveBeenCalledTimes(1);
  });
});
