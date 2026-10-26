/**
 * tests/integration/assistantServices.test.ts
 *
 * The assistant's list_services tool (business rule 95) against real
 * AssetService rows. The two platforms' vocabularies map to plain words:
 *  - `problems` is a failed systemd unit OR a Windows automatic-start service
 *    that is not running — and NOT an enabled-but-inactive systemd unit
 *    (timer / socket units sit there normally);
 *  - state / startup filters match either platform's spelling, any case;
 *  - watchedOnly keeps each device's own pinned units only;
 *  - device filters narrow which devices' services are read.
 */

import { afterAll, beforeEach, expect, it } from "vitest";
import { prisma } from "../../src/db.js";
import { dbDescribe } from "./_helpers.js";
import { runAssistantTool } from "../../src/services/assistantToolService.js";

const d = dbDescribe;
const HOST = "assistant-svc-test";
const req = { session: { userId: "u1", roleSnapshot: { permissions: { assets: "read" } } } } as never;
const ids: Record<string, string> = {};

async function wipe(): Promise<void> {
  const assets = await prisma.asset.findMany({ where: { hostname: { startsWith: HOST } }, select: { id: true } });
  const list = assets.map((a) => a.id);
  if (!list.length) return;
  await prisma.assetService.deleteMany({ where: { assetId: { in: list } } });
  await prisma.asset.deleteMany({ where: { id: { in: list } } });
}

async function host(name: string, os: string, monitoredServices: string[] = []): Promise<void> {
  const a = await prisma.asset.create({
    data: { hostname: `${HOST}-${name}`, status: "active", assetType: "server", os, monitoredServices } as never,
  });
  ids[name] = a.id;
}

type Svc = { unit: string; platform: "systemd" | "windows"; activeState: string; subState?: string; enabledState: string };
async function svc(name: string, rows: Svc[]): Promise<void> {
  await prisma.assetService.createMany({ data: rows.map((r) => ({ assetId: ids[name], subState: "", loadState: "loaded", ...r })) });
}

const run = async (args: Record<string, unknown>) =>
  (await runAssistantTool("list_services", JSON.stringify({ search: HOST, ...args }), { req, maxRows: 100 })).data as any;
const names = (r: any) => r.rows.map((x: any) => `${x.hostname.slice(HOST.length + 1)}:${x.service}`).sort();

d("list_services", () => {
  beforeEach(async () => {
    await wipe();
    await host("lin", "Linux", ["nginx.service"]);
    await host("win", "Windows Server 2022");
    await svc("lin", [
      { unit: "nginx.service", platform: "systemd", activeState: "active", subState: "running", enabledState: "enabled" },
      { unit: "app.service", platform: "systemd", activeState: "failed", subState: "failed", enabledState: "enabled" },
      { unit: "backup.service", platform: "systemd", activeState: "inactive", subState: "dead", enabledState: "enabled" },
    ]);
    await svc("win", [
      { unit: "MSSQLSERVER", platform: "windows", activeState: "Stopped", enabledState: "Auto" },
      { unit: "W32Time", platform: "windows", activeState: "Running", enabledState: "auto-delayed" },
      { unit: "Fax", platform: "windows", activeState: "Stopped", enabledState: "Manual" },
    ]);
  });
  afterAll(wipe);

  it("problems: a failed unit and a stopped automatic Windows service, not an idle timer unit", async () => {
    expect(names(await run({ problems: true }))).toEqual(["lin:app.service", "win:MSSQLSERVER"]);
  });

  it("state and startup match either platform's spelling, any case", async () => {
    expect(names(await run({ state: ["running"] }))).toEqual(["lin:nginx.service", "win:W32Time"]);
    expect(names(await run({ state: "stopped", startup: "manual" }))).toEqual(["win:Fax"]);
    expect(names(await run({ startup: ["automatic"], state: ["stopped"] }))).toEqual(["lin:backup.service", "win:MSSQLSERVER"]);
  });

  it("filters by service name / display name, by device, and to watched units", async () => {
    expect(names(await run({ service: "sql" }))).toEqual(["win:MSSQLSERVER"]);
    expect(names(await run({ os: "windows" }))).toEqual(["win:Fax", "win:MSSQLSERVER", "win:W32Time"]);
    const watched = await run({ watchedOnly: true });
    expect(names(watched)).toEqual(["lin:nginx.service"]);
    expect(watched.rows[0].watched).toBe(true);
  });

  it("says how many matching devices report services at all", async () => {
    const r = await run({});
    expect(r).toMatchObject({ total: 6, matchedDevices: 2, devicesReportingServices: 2 });
  });
});
