/**
 * tests/integration/firmwareRepository.test.ts
 *
 * Route-level contract for the firmware repository (business rule 87): the
 * `firmware` key's three rungs against every route, the upload's ceiling and
 * identity parsing, the tree built from real asset rows, the binding scopes
 * and their uniqueness, and the one gate that must be visible from outside —
 * a `write` holder may fill the repository and still may not flash.
 *
 * Runs only with a reachable DATABASE_URL (dbDescribe). Uploads land in the
 * real FIRMWARE_DIR; every row and file this suite makes is removed at the end.
 */

import { it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { rm } from "node:fs/promises";
import { app } from "../../src/app.js";
import { prisma } from "../../src/db.js";
import { hashPassword } from "../../src/utils/password.js";
import { FUNCTION_KEYS } from "../../src/api/middleware/permissions.js";
import { FIRMWARE_DIR } from "../../src/utils/paths.js";
import { dbDescribe, dbReachable, ensureTestUser } from "./_helpers.js";

const d = dbDescribe;
const PFX = "fwrepo-test";
const PASSWORD = "fwrepo-password-not-real";

function matrix(base: string, overrides: Record<string, string> = {}): Record<string, string> {
  const out: Record<string, string> = {};
  for (const { key } of FUNCTION_KEYS) out[key] = overrides[key] ?? base;
  return out;
}

async function createRoleUser(suffix: string, permissions: Record<string, string>): Promise<string> {
  const role = await prisma.role.create({ data: { name: PFX + "-role-" + suffix, permissions } });
  const username = PFX + "-user-" + suffix;
  await prisma.user.create({ data: { username, passwordHash: await hashPassword(PASSWORD), roleId: role.id, authProvider: "local" } });
  return username;
}

type Session = { agent: ReturnType<typeof request.agent>; csrf: string };
const sessions = new Map<string, Session>();
async function loginAs(username: string): Promise<Session> {
  const cached = sessions.get(username);
  if (cached) return cached;
  const agent = request.agent(app);
  await agent.get("/api/v1/auth/me");
  const resp = await agent.post("/api/v1/auth/login").send({ username, password: PASSWORD }).set("Content-Type", "application/json");
  if (resp.status !== 200) throw new Error(`login failed for ${username}: ${resp.status} ${JSON.stringify(resp.body)}`);
  // The CSRF cookie ROTATES on login; read the jar after a follow-up request.
  await agent.get("/api/v1/auth/me");
  const cookies = (agent.jar as any).getCookies({ domain: "127.0.0.1", path: "/", secure: false, script: false });
  const csrf = (cookies.find((c: any) => c.name === "polaris_csrf") || {}).value || "";
  if (!csrf) throw new Error("CSRF cookie not set after login");
  const s = { agent, csrf };
  sessions.set(username, s);
  return s;
}

/**
 * A tiny Fortinet-looking image: binary filler with the header token in the
 * first 512 bytes. The filler must not be alphanumeric — a real image has
 * binary there, and the header regex (transcribed from fortiupgrade) reads the
 * platform token as the run of capitals ending at the first dash.
 */
function image(token: string, filler: number): Buffer {
  const buf = Buffer.alloc(2048, filler);
  buf.write(token, 16, "latin1");
  return buf;
}

const MFR = "Fortinet";
let readerU: string, writerU: string, flasherU: string, noneU: string;
const createdAssetIds: string[] = [];
const createdImageIds: string[] = [];
let credId: string;

d("firmware repository routes", () => {
  beforeAll(async () => {
    if (!dbReachable) return;
    await ensureTestUser();
    readerU  = await createRoleUser("reader",  matrix("read",  { firmware: "read" }));
    writerU  = await createRoleUser("writer",  matrix("read",  { firmware: "write", credentials: "read" }));
    flasherU = await createRoleUser("flasher", matrix("read",  { firmware: "fullwrite" }));
    noneU    = await createRoleUser("none",    matrix("read",  { firmware: "none" }));
    // Two switches sharing a model, one AP, and a firewall that must never appear.
    for (const [hostname, assetType, model, serialNumber] of [
      ["fwrepo-sw1", "switch", "FortiSwitch S108FF", "S108FFTF23000001"],
      ["fwrepo-sw2", "switch", "FortiSwitch S108FF", "S108FFTF23000002"],
      ["fwrepo-ap1", "access_point", "FortiAP 231K", "FP231KTF24000001"],
      ["fwrepo-fg1", "firewall", "FortiGate 60F", "FGT60FTK20000001"],
    ] as const) {
      const a = await prisma.asset.create({ data: { hostname, assetType, model, serialNumber, manufacturer: MFR, ipAddress: null, osVersion: "7.4.3 build0542" } });
      createdAssetIds.push(a.id);
    }
    const cred = await prisma.credential.create({ data: { name: PFX + "-login", type: "http", config: { authMode: "form", username: "admin", password: "pw" }, createdBy: writerU } });
    credId = cred.id;
  });

  afterAll(async () => {
    if (!dbReachable) return;
    const imgs = await prisma.firmwareImage.findMany({ where: { manufacturer: MFR, model: { startsWith: "FortiSwitch S108FF" } } });
    for (const i of imgs) await rm(`${FIRMWARE_DIR}/${i.storagePath}`, { force: true }).catch(() => undefined);
    await prisma.firmwareUpgradeRun.deleteMany({ where: { assetId: { in: createdAssetIds } } });
    await prisma.firmwareImage.deleteMany({ where: { id: { in: [...createdImageIds, ...imgs.map((i) => i.id)] } } });
    await prisma.firmwareCredentialBinding.deleteMany({ where: { manufacturer: MFR, model: { startsWith: "FortiSwitch S108FF" } } });
    await prisma.firmwareCredentialBinding.deleteMany({ where: { manufacturer: MFR, assetType: "access_point", model: null } });
    await prisma.asset.deleteMany({ where: { id: { in: createdAssetIds } } });
    await prisma.credential.deleteMany({ where: { name: PFX + "-login" } });
    await prisma.user.deleteMany({ where: { username: { startsWith: PFX + "-user-" } } });
    await prisma.role.deleteMany({ where: { name: { startsWith: PFX + "-role-" } } });
  });

  it("the tree is reachable on firmware=read alone, lists switches and APs only, and 403s at none", async () => {
    const reader = await loginAs(readerU);
    const r = await reader.agent.get("/api/v1/server-settings/firmware/tree");
    expect(r.status).toBe(200);
    const fortinet = r.body.manufacturers.find((m: { name: string }) => m.name === MFR);
    expect(fortinet).toBeTruthy();
    const types = fortinet.assetTypes.map((t: { assetType: string }) => t.assetType);
    expect(types).toContain("switch");
    expect(types).not.toContain("firewall");
    const sw = fortinet.assetTypes.find((t: { assetType: string }) => t.assetType === "switch");
    const model = sw.models.find((m: { model: string }) => m.model === "FortiSwitch S108FF");
    expect(model.assetCount).toBe(2);
    expect(sw.engine).toBe("fortiswitch-https");
    const none = await loginAs(noneU);
    expect((await none.agent.get("/api/v1/server-settings/firmware/tree")).status).toBe(403);
  });

  it("a node's device list counts exactly what the tree counts, (no model) included, and needs assets:read too", async () => {
    // Its own manufacturer, so rows another test left in a shared database
    // cannot move these counts.
    const LM = PFX + "-listco";
    for (const [hostname, assetType, model, status] of [
      ["fwlist-sw-null", "switch", null, "active"],
      ["fwlist-sw-blank", "switch", "", "active"],
      ["fwlist-sw-a", "switch", "FortiSwitch S108FF", "active"],
      ["fwlist-sw-gone", "switch", "FortiSwitch S108FF", "decommissioned"],
      ["fwlist-ap", "access_point", "FortiAP 231K", "active"],
      ["fwlist-fg", "firewall", "FortiGate 60F", "active"],
    ] as const) {
      const a = await prisma.asset.create({ data: { hostname, assetType, model, status, manufacturer: LM, serialNumber: null, osVersion: "7.4.3 build0542" } });
      createdAssetIds.push(a.id);
    }
    const reader = await loginAs(readerU);
    const tree = (await reader.agent.get("/api/v1/server-settings/firmware/tree")).body;
    const m = tree.manufacturers.find((x: { name: string }) => x.name === LM);
    const sw = m.assetTypes.find((t: { assetType: string }) => t.assetType === "switch");
    const noModel = sw.models.find((x: { model: string }) => x.model === "");
    const list = async (q: string) => {
      const r = await reader.agent.get("/api/v1/server-settings/firmware/assets?" + q);
      expect(r.status, q).toBe(200);
      return r.body as { total: number; assets: Array<{ hostname: string; firmwareVsPrimary: string | null }> };
    };
    const enc = encodeURIComponent;
    const all = await list(`manufacturer=${enc(LM)}`);
    expect(all.total).toBe(m.assetCount);
    expect(all.assets.map((a) => a.hostname).sort()).toEqual(["fwlist-ap", "fwlist-sw-a", "fwlist-sw-blank", "fwlist-sw-null"]);
    expect((await list(`manufacturer=${enc(LM)}&assetType=switch`)).total).toBe(sw.assetCount);
    const nm = await list(`manufacturer=${enc(LM)}&assetType=switch&noModel=1`);
    expect(nm.total).toBe(noModel.assetCount);
    expect(nm.assets.map((a) => a.hostname).sort()).toEqual(["fwlist-sw-blank", "fwlist-sw-null"]);
    const one = await list(`manufacturer=${enc(LM)}&assetType=switch&model=${enc("FortiSwitch S108FF")}`);
    expect(one.assets.map((a) => a.hostname)).toEqual(["fwlist-sw-a"]);
    // No serial → the Repository cannot place the device, so no standing.
    expect(one.assets[0]!.firmwareVsPrimary).toBeNull();

    expect((await reader.agent.get(`/api/v1/server-settings/firmware/assets?manufacturer=${enc(LM)}&model=x`)).status).toBe(400);
    expect((await reader.agent.get(`/api/v1/server-settings/firmware/assets?manufacturer=${enc(LM)}&assetType=switch&model=x&noModel=1`)).status).toBe(400);
    // The tree's counts are firmware:read; the names behind them are the inventory's.
    const blindU = await createRoleUser("blind", matrix("none", { firmware: "read" }));
    const blind = await loginAs(blindU);
    expect((await blind.agent.get("/api/v1/server-settings/firmware/tree")).status).toBe(200);
    expect((await blind.agent.get(`/api/v1/server-settings/firmware/assets?manufacturer=${enc(LM)}`)).status).toBe(403);
    const none = await loginAs(noneU);
    expect((await none.agent.get(`/api/v1/server-settings/firmware/assets?manufacturer=${enc(LM)}`)).status).toBe(403);
  });

  it("read may not upload; write may, and the image is parsed from its header", async () => {
    const reader = await loginAs(readerU);
    const denied = await reader.agent.post("/api/v1/server-settings/firmware/images").set("X-CSRF-Token", reader.csrf)
      .field("manufacturer", MFR).field("assetType", "switch").field("model", "FortiSwitch S108FF")
      .attach("file", image("S108FF-7.06-FW-build1164-260709-patch08", 0x00), "FSW_108F-v7-build1164-FORTINET.out");
    expect(denied.status).toBe(403);

    const writer = await loginAs(writerU);
    const ok = await writer.agent.post("/api/v1/server-settings/firmware/images").set("X-CSRF-Token", writer.csrf)
      .field("manufacturer", MFR).field("assetType", "switch").field("model", "FortiSwitch S108FF")
      .attach("file", image("S108FF-7.06-FW-build1164-260709-patch08", 0x00), "FSW_108F-v7-build1164-FORTINET.out");
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    expect(ok.body.image.platform).toBe("S108FF");
    expect(ok.body.image.versionLabel).toBe("7.6.8 build1164");
    expect(ok.body.image.role).toBe("primary");
    expect(ok.body.warnings).toEqual([]);
    createdImageIds.push(ok.body.image.id);

    // The same bytes again → 409 naming where they live.
    const dup = await writer.agent.post("/api/v1/server-settings/firmware/images").set("X-CSRF-Token", writer.csrf)
      .field("manufacturer", MFR).field("assetType", "switch").field("model", "FortiSwitch S108FF")
      .attach("file", image("S108FF-7.06-FW-build1164-260709-patch08", 0x00), "again.out");
    expect(dup.status).toBe(409);
    expect(dup.body.error).toMatch(/already in the repository under Fortinet/);

    // Unrecognisable bytes with a versionless name → 400, nothing stored.
    const junk = await writer.agent.post("/api/v1/server-settings/firmware/images").set("X-CSRF-Token", writer.csrf)
      .field("manufacturer", MFR).field("assetType", "switch").field("model", "FortiSwitch S108FF")
      .attach("file", Buffer.alloc(1024, 0x00), "notes.bin");
    expect(junk.status).toBe(400);
    // A firewall is not a repository device type.
    const fw = await writer.agent.post("/api/v1/server-settings/firmware/images").set("X-CSRF-Token", writer.csrf)
      .field("manufacturer", MFR).field("assetType", "firewall").field("model", "FortiGate 60F")
      .attach("file", image("FGT60F-7.04-FW-build2500-250101", 0x02), "fg.out");
    expect(fw.status).toBe(400);
  });

  it("a second upload rotates roles; make-primary swaps them; the reader may look and not touch", async () => {
    const writer = await loginAs(writerU);
    const second = await writer.agent.post("/api/v1/server-settings/firmware/images").set("X-CSRF-Token", writer.csrf)
      .field("manufacturer", MFR).field("assetType", "switch").field("model", "FortiSwitch S108FF")
      .attach("file", image("S108FF-7.06-FW-build1200-260901-patch09", 0x01), "FSW_108F-v7-build1200-FORTINET.out");
    expect(second.status).toBe(201);
    createdImageIds.push(second.body.image.id);
    expect(second.body.demoted.versionLabel).toBe("7.6.8 build1164");
    expect(second.body.rotatedOut).toBeNull();

    const list = await writer.agent.get("/api/v1/server-settings/firmware/images").query({ manufacturer: MFR, assetType: "switch", model: "FortiSwitch S108FF" });
    expect(list.status).toBe(200);
    const roles = Object.fromEntries(list.body.images.map((i: { versionLabel: string; role: string }) => [i.versionLabel, i.role]));
    expect(roles).toEqual({ "7.6.8 build1164": "backup", "7.6.9 build1200": "primary" });

    const first = list.body.images.find((i: { role: string }) => i.role === "backup");
    const reader = await loginAs(readerU);
    expect((await reader.agent.post(`/api/v1/server-settings/firmware/images/${first.id}/make-primary`).set("X-CSRF-Token", reader.csrf)).status).toBe(403);
    const promoted = await writer.agent.post(`/api/v1/server-settings/firmware/images/${first.id}/make-primary`).set("X-CSRF-Token", writer.csrf);
    expect(promoted.status).toBe(200);
    expect(promoted.body.image.role).toBe("primary");
  });

  it("bindings: scope validation, one per node, form-mode credentials only, and the effective login on the tree", async () => {
    const writer = await loginAs(writerU);
    const bad = await writer.agent.put("/api/v1/server-settings/firmware/bindings").set("X-CSRF-Token", writer.csrf)
      .send({ manufacturer: MFR, model: "FortiSwitch S108FF", credentialId: credId });
    expect(bad.status).toBe(400); // a model needs its device type
    const ok = await writer.agent.put("/api/v1/server-settings/firmware/bindings").set("X-CSRF-Token", writer.csrf)
      .send({ manufacturer: MFR, assetType: "switch", model: "FortiSwitch S108FF", credentialId: credId });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.binding.credentialId).toBe(credId);
    // Upsert, not a second row.
    const again = await writer.agent.put("/api/v1/server-settings/firmware/bindings").set("X-CSRF-Token", writer.csrf)
      .send({ manufacturer: MFR, assetType: "switch", model: "FortiSwitch S108FF", credentialId: credId });
    expect(again.status).toBe(200);
    expect(again.body.binding.id).toBe(ok.body.binding.id);

    // A basic-mode http credential is not a device login.
    const basic = await prisma.credential.create({ data: { name: PFX + "-basic", type: "http", config: { authMode: "basic", username: "u", password: "p" } } });
    try {
      const refused = await writer.agent.put("/api/v1/server-settings/firmware/bindings").set("X-CSRF-Token", writer.csrf)
        .send({ manufacturer: MFR, assetType: "access_point", credentialId: basic.id });
      expect(refused.status).toBe(400);
      expect(refused.body.error).toMatch(/Device admin login \(form\)/);
    } finally {
      await prisma.credential.delete({ where: { id: basic.id } });
    }

    const tree = await writer.agent.get("/api/v1/server-settings/firmware/tree");
    const sw = tree.body.manufacturers.find((m: { name: string }) => m.name === MFR).assetTypes.find((t: { assetType: string }) => t.assetType === "switch");
    const model = sw.models.find((m: { model: string }) => m.model === "FortiSwitch S108FF");
    expect(model.effectiveBinding).toMatchObject({ credentialId: credId, scope: "model" });
    expect(model.binding.credentialName).toBe(PFX + "-login");
    expect(sw.effectiveBinding).toBeNull();
  });

  it("per-asset availability at read; POST is fullwrite and needs the approved imageId; a firewall gets nothing", async () => {
    const [sw1, , , fg] = createdAssetIds;
    const reader = await loginAs(readerU);
    const avail = await reader.agent.get(`/api/v1/assets/${sw1}/firmware-upgrade`);
    expect(avail.status, JSON.stringify(avail.body)).toBe(200);
    // The switch has no IP address, so the image is offered but the start is blocked.
    expect(avail.body.state).toBe("blocked");
    expect(avail.body.image.role).toBe("primary");
    expect(avail.body.credential.scope).toBe("model");
    expect(avail.body.blockers[0]).toMatch(/no IP address/);

    const writer = await loginAs(writerU);
    const denied = await writer.agent.post(`/api/v1/assets/${sw1}/firmware-upgrade`).set("X-CSRF-Token", writer.csrf).send({ imageId: avail.body.image.id });
    expect(denied.status).toBe(403);

    const flasher = await loginAs(flasherU);
    const noImage = await flasher.agent.post(`/api/v1/assets/${sw1}/firmware-upgrade`).set("X-CSRF-Token", flasher.csrf).send({});
    expect(noImage.status).toBe(400);
    const blocked = await flasher.agent.post(`/api/v1/assets/${sw1}/firmware-upgrade`).set("X-CSRF-Token", flasher.csrf).send({ imageId: avail.body.image.id });
    expect(blocked.status).toBe(400); // no address → refused before any socket
    expect(blocked.body.error).toMatch(/no IP address/);
    expect(await prisma.firmwareUpgradeRun.count({ where: { assetId: sw1 } })).toBe(0);

    const fgAvail = await reader.agent.get(`/api/v1/assets/${fg}/firmware-upgrade`);
    expect(fgAvail.status).toBe(200);
    expect(fgAvail.body.state).toBe("unsupported");

    const runs = await reader.agent.get(`/api/v1/assets/${sw1}/firmware-upgrade/runs`);
    expect(runs.status).toBe(200);
    expect(runs.body.runs).toEqual([]);
  });

  it("delete refuses at read and promotes the backup at write; purge empties a node", async () => {
    const writer = await loginAs(writerU);
    const list = await writer.agent.get("/api/v1/server-settings/firmware/images").query({ manufacturer: MFR, assetType: "switch", model: "FortiSwitch S108FF" });
    const primary = list.body.images.find((i: { role: string }) => i.role === "primary");
    const reader = await loginAs(readerU);
    expect((await reader.agent.delete(`/api/v1/server-settings/firmware/images/${primary.id}`).set("X-CSRF-Token", reader.csrf)).status).toBe(403);
    expect((await writer.agent.delete(`/api/v1/server-settings/firmware/images/${primary.id}`).set("X-CSRF-Token", writer.csrf)).status).toBe(204);
    const after = await writer.agent.get("/api/v1/server-settings/firmware/images").query({ manufacturer: MFR, assetType: "switch", model: "FortiSwitch S108FF" });
    expect(after.body.images).toHaveLength(1);
    expect(after.body.images[0].role).toBe("primary");
    const purge = await writer.agent.post("/api/v1/server-settings/firmware/models/purge").set("X-CSRF-Token", writer.csrf)
      .send({ manufacturer: MFR, assetType: "switch", model: "FortiSwitch S108FF" });
    expect(purge.status).toBe(200);
    expect(purge.body.deleted).toBe(1);
  });
});
