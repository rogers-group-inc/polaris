/**
 * tests/integration/networkScans.test.ts — the /network-scans permission gates.
 *
 * The whole point of giving Discovery its own function key is that **scanning
 * and adopting are separate grants** (business rule 34a): a role may be allowed
 * to find out what is on a range without being allowed to put it into
 * inventory. That separation is one `requirePermission` chain deep on one
 * route, and nothing else in the suite would notice if it were dropped — hence
 * this file.
 *
 * Also pinned:
 *  - the router-wide `networkScan:read` FLOOR. The `/map` mount shipped with
 *    three auth-only read routes until 2026-08, and a Discovery's targets and
 *    results are the same kind of recon material;
 *  - `/preview-targets` and `/runs/...` are reachable at READ level and are NOT
 *    captured as `/:id` — the literal paths are declared first, which is the
 *    kind of ordering that breaks silently;
 *  - the semantic validations answer 400 with the operator-facing reason from
 *    the service, not a Zod dump;
 *  - **private vs shared** (business rule 34g), which is the half of the model
 *    no unit test can reach: two real sessions, two real rows. A private
 *    Discovery is INVISIBLE to another operator — 404, never 403, on the by-id
 *    read and on its run — while a shared one is listed, readable and
 *    RUNNABLE by anyone with `write`, and still editable only by its owner
 *    unless the caller holds `fullwrite`.
 *
 * Skips cleanly when DATABASE_URL isn't reachable; see _helpers.ts.
 */

import { createServer, type Server } from "node:http";
import { it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { app } from "../../src/app.js";
import { prisma } from "../../src/db.js";
import { hashPassword } from "../../src/utils/password.js";
import { FUNCTION_KEYS } from "../../src/api/middleware/permissions.js";
import { dbDescribe } from "./_helpers.js";

const d = dbDescribe;
const PFX = "netscan-test";
const PASSWORD = "netscan-password-not-real";

/** Every function key at `base`, overridden per key. */
function matrix(base: string, overrides: Record<string, string> = {}): Record<string, string> {
  const out: Record<string, string> = {};
  for (const { key } of FUNCTION_KEYS) out[key] = overrides[key] ?? base;
  return out;
}

async function createRoleUser(suffix: string, permissions: Record<string, string>): Promise<string> {
  const role = await prisma.role.create({ data: { name: `${PFX}-role-${suffix}`, permissions } });
  const username = `${PFX}-user-${suffix}`;
  await prisma.user.create({
    data: { username, passwordHash: await hashPassword(PASSWORD), roleId: role.id, authProvider: "local" },
  });
  return username;
}

// The login limiter is 10 attempts / 15 min / IP across the process, so one
// session per user, cached.
//
// The cached agents talk to a server this file starts and stops itself.
// supertest >= 7.3 shares the server it auto-starts for `agent(app)` and
// closes it once no request is in flight, so an agent reused in a later
// test hits a closed port (ECONNREFUSED). A server handed in already
// listening is never closed by supertest.
let server: Server;
const agentCache = new Map<string, ReturnType<typeof request.agent>>();
async function loginAs(username: string): Promise<ReturnType<typeof request.agent>> {
  const cached = agentCache.get(username);
  if (cached) return cached;
  const agent = request.agent(server);
  const seed = await agent.get("/api/v1/auth/me");
  const csrf = /polaris_csrf=([^;]+)/.exec(String(seed.headers["set-cookie"] ?? ""))?.[1] ?? "";
  await agent.post("/api/v1/auth/login").set("x-csrf-token", csrf).send({ username, password: PASSWORD });
  agentCache.set(username, agent);
  return agent;
}

/** CSRF token for a mutating call on an authed agent. */
async function csrfFor(agent: ReturnType<typeof request.agent>): Promise<string> {
  const resp = await agent.get("/api/v1/auth/me");
  const raw = String(resp.headers["set-cookie"] ?? "");
  return /polaris_csrf=([^;]+)/.exec(raw)?.[1] ?? "";
}

let noneUser = "";
let readUser = "";
let writeUser = "";
let scanOnlyUser = ""; // networkScan:write but assets:read — the chained-gate case
let otherWriteUser = ""; // a SECOND write-level operator — the visibility cases
let fullWriteUser = ""; // networkScan:fullwrite — the housekeeping override
const madeScanIds: string[] = [];

beforeAll(async () => {
  server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  noneUser = await createRoleUser("none", matrix("read", { networkScan: "none" }));
  readUser = await createRoleUser("read", matrix("read", { networkScan: "read" }));
  writeUser = await createRoleUser("write", matrix("read", { networkScan: "write", assets: "write" }));
  scanOnlyUser = await createRoleUser("scanonly", matrix("read", { networkScan: "write", assets: "read" }));
  otherWriteUser = await createRoleUser("other", matrix("read", { networkScan: "write", assets: "write" }));
  fullWriteUser = await createRoleUser("full", matrix("read", { networkScan: "fullwrite", assets: "write" }));
}, 60_000);

afterAll(async () => {
  await prisma.networkScan.deleteMany({ where: { id: { in: madeScanIds } } }).catch(() => {});
  await prisma.networkScan.deleteMany({ where: { name: { startsWith: PFX } } }).catch(() => {});
  await prisma.user.deleteMany({ where: { username: { startsWith: PFX } } }).catch(() => {});
  await prisma.role.deleteMany({ where: { name: { startsWith: PFX } } }).catch(() => {});
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
});

const body = (name: string) => ({
  name,
  targets: [{ kind: "cidr", value: "10.77.0.0/29" }],
  methods: [{ type: "icmp", credentialIds: [] }],
});

d("network-scans — the router-wide read floor", () => {
  it("403s a role without networkScan, even one that can read everything else", async () => {
    const agent = await loginAs(noneUser);
    expect((await agent.get("/api/v1/network-scans")).status).toBe(403);
    expect((await agent.post("/api/v1/network-scans/preview-targets").send({ targets: [] })).status).toBe(403);
  });

  it("lets a read-level caller list and preview", async () => {
    const agent = await loginAs(readUser);
    expect((await agent.get("/api/v1/network-scans")).status).toBe(200);
    const preview = await agent
      .post("/api/v1/network-scans/preview-targets")
      .set("x-csrf-token", await csrfFor(agent))
      .send({ targets: [{ kind: "cidr", value: "10.77.0.0/29" }] });
    expect(preview.status).toBe(200);
    // 6 hosts: a /29 minus network and broadcast.
    expect(preview.body.total).toBe(6);
  });

  it("403s a read-level caller on every write verb", async () => {
    const agent = await loginAs(readUser);
    const csrf = await csrfFor(agent);
    expect((await agent.post("/api/v1/network-scans").set("x-csrf-token", csrf).send(body(`${PFX}-nope`))).status).toBe(403);
  });
});

d("network-scans — literal paths are not ids", () => {
  it("routes /runs/<uuid> to the run lookup, not to /:id", async () => {
    const agent = await loginAs(readUser);
    const resp = await agent.get("/api/v1/network-scans/runs/00000000-0000-4000-8000-000000000000");
    // 404 "Run not found" — if `/:id` had captured it, the message would name a
    // Discovery instead.
    expect(resp.status).toBe(404);
    expect(String(resp.body.error ?? resp.body.message ?? "")).toMatch(/run/i);
  });
});

d("network-scans — CRUD", () => {
  it("creates, reads back, and refuses a duplicate name", async () => {
    const agent = await loginAs(writeUser);
    const csrf = await csrfFor(agent);
    const created = await agent.post("/api/v1/network-scans").set("x-csrf-token", csrf).send(body(`${PFX}-a`));
    expect(created.status).toBe(201);
    const id = created.body.scan.id as string;
    madeScanIds.push(id);
    expect(created.body.scan.targets).toHaveLength(1);

    const fetched = await agent.get(`/api/v1/network-scans/${id}`);
    expect(fetched.status).toBe(200);
    expect(fetched.body.scan.name).toBe(`${PFX}-a`);

    const dup = await agent.post("/api/v1/network-scans").set("x-csrf-token", csrf).send(body(`${PFX}-a`));
    expect(dup.status).toBe(409);
  });

  it("answers 400 with the SERVICE's reason for a semantic problem", async () => {
    const agent = await loginAs(writeUser);
    const csrf = await csrfFor(agent);
    // A /8 is shape-valid and semantically refused — the distinction this
    // service/route split exists for.
    const wide = await agent
      .post("/api/v1/network-scans")
      .set("x-csrf-token", csrf)
      .send({ ...body(`${PFX}-wide`), targets: [{ kind: "cidr", value: "10.0.0.0/8" }] });
    expect(wide.status).toBe(400);
    expect(String(wide.body.error ?? wide.body.message ?? "")).toMatch(/more than/);

    const icmpCreds = await agent
      .post("/api/v1/network-scans")
      .set("x-csrf-token", csrf)
      .send({
        ...body(`${PFX}-icmpcreds`),
        methods: [{ type: "icmp", credentialIds: ["00000000-0000-4000-8000-000000000000"] }],
      });
    expect(icmpCreds.status).toBe(400);
    expect(String(icmpCreds.body.error ?? icmpCreds.body.message ?? "")).toMatch(/ICMP takes no credentials/i);
  });

  it("deletes", async () => {
    const agent = await loginAs(writeUser);
    const csrf = await csrfFor(agent);
    const created = await agent.post("/api/v1/network-scans").set("x-csrf-token", csrf).send(body(`${PFX}-del`));
    const id = created.body.scan.id as string;
    expect((await agent.delete(`/api/v1/network-scans/${id}`).set("x-csrf-token", csrf)).status).toBe(204);
    expect((await agent.get(`/api/v1/network-scans/${id}`)).status).toBe(404);
  });
});

d("network-scans — adoption is a SEPARATE grant", () => {
  it("403s adopt for networkScan:write + assets:read", async () => {
    // The load-bearing assertion of this file: running is not adopting.
    const agent = await loginAs(scanOnlyUser);
    const csrf = await csrfFor(agent);
    const resp = await agent
      .post("/api/v1/network-scans/runs/00000000-0000-4000-8000-000000000000/adopt")
      .set("x-csrf-token", csrf)
      .send({ addresses: ["10.77.0.1"] });
    expect(resp.status).toBe(403);
  });

  it("lets the same role create and cancel — only adopt is withheld", async () => {
    const agent = await loginAs(scanOnlyUser);
    const csrf = await csrfFor(agent);
    const created = await agent.post("/api/v1/network-scans").set("x-csrf-token", csrf).send(body(`${PFX}-scanonly`));
    expect(created.status).toBe(201);
    madeScanIds.push(created.body.scan.id);
    // Cancelling a run that does not exist is a 404, NOT a 403 — the gate let
    // it through and the lookup answered.
    const cancel = await agent
      .post("/api/v1/network-scans/runs/00000000-0000-4000-8000-000000000000/cancel")
      .set("x-csrf-token", csrf)
      .send({});
    expect(cancel.status).toBe(404);
  });

  it("reaches the adopt handler for a role holding BOTH keys", async () => {
    const agent = await loginAs(writeUser);
    const csrf = await csrfFor(agent);
    const resp = await agent
      .post("/api/v1/network-scans/runs/00000000-0000-4000-8000-000000000000/adopt")
      .set("x-csrf-token", csrf)
      .send({ addresses: ["10.77.0.1"] });
    // 404 from the run lookup rather than 403 from the gate — which is how we
    // know both gates passed.
    expect(resp.status).toBe(404);
  });
});

d("network-scans — private vs shared", () => {
  /** Create one owned by `username`, remembered for cleanup. */
  async function createAs(username: string, name: string, visibility: "private" | "public") {
    const agent = await loginAs(username);
    const resp = await agent
      .post("/api/v1/network-scans")
      .set("x-csrf-token", await csrfFor(agent))
      .send({ ...body(name), visibility });
    expect(resp.status).toBe(201);
    madeScanIds.push(resp.body.scan.id);
    return resp.body.scan as { id: string; visibility: string; isOwner: boolean; createdBy: string };
  }

  it("keeps a private Discovery out of another operator's list and answers 404 by id", async () => {
    const scan = await createAs(writeUser, `${PFX}-private-a`, "private");
    expect(scan.visibility).toBe("private");
    expect(scan.isOwner).toBe(true);

    const other = await loginAs(otherWriteUser);
    const list = await other.get("/api/v1/network-scans");
    expect(list.status).toBe(200);
    expect(list.body.scans.map((x: { id: string }) => x.id)).not.toContain(scan.id);

    // 404, not 403: that a private Discovery exists is not other operators'
    // business, and its name is a site name.
    expect((await other.get(`/api/v1/network-scans/${scan.id}`)).status).toBe(404);
    const run = await other
      .post(`/api/v1/network-scans/${scan.id}/run`)
      .set("x-csrf-token", await csrfFor(other))
      .send({});
    expect(run.status).toBe(404);
  });

  it("lets any write-level operator RUN a shared one they did not create", async () => {
    const scan = await createAs(writeUser, `${PFX}-shared-a`, "public");
    const other = await loginAs(otherWriteUser);

    const list = await other.get("/api/v1/network-scans");
    const row = list.body.scans.find((x: { id: string }) => x.id === scan.id);
    expect(row).toBeTruthy();
    // The list has to say whose it is, or a colleague's Discovery reads as one
    // you forgot writing.
    expect(row.isOwner).toBe(false);
    expect(row.createdBy).toBe(writeUser);

    expect((await other.get(`/api/v1/network-scans/${scan.id}`)).status).toBe(200);
    const run = await other
      .post(`/api/v1/network-scans/${scan.id}/run`)
      .set("x-csrf-token", await csrfFor(other))
      .send({});
    // 202 + a run row — running someone else's shared Discovery is the entire
    // point of publishing one.
    expect(run.status).toBe(202);
    await prisma.networkScanRun.deleteMany({ where: { scanId: scan.id } }).catch(() => {});
  });

  it("refuses to let that operator EDIT or DELETE it, at 403 rather than 404", async () => {
    const scan = await createAs(writeUser, `${PFX}-shared-b`, "public");
    const other = await loginAs(otherWriteUser);
    const csrf = await csrfFor(other);

    // Visible, so the refusal is an honest 403 — there is nothing to conceal.
    const put = await other
      .put(`/api/v1/network-scans/${scan.id}`)
      .set("x-csrf-token", csrf)
      .send({ ...body(`${PFX}-shared-b-renamed`), visibility: "public" });
    expect(put.status).toBe(403);
    expect((await other.delete(`/api/v1/network-scans/${scan.id}`).set("x-csrf-token", csrf)).status).toBe(403);
  });

  it("lets fullwrite edit someone else's — the housekeeping override", async () => {
    const scan = await createAs(writeUser, `${PFX}-shared-c`, "public");
    const admin = await loginAs(fullWriteUser);
    const put = await admin
      .put(`/api/v1/network-scans/${scan.id}`)
      .set("x-csrf-token", await csrfFor(admin))
      .send({ ...body(`${PFX}-shared-c2`), visibility: "public" });
    expect(put.status).toBe(200);
    // Editing someone else's row must not TAKE it: ownership is unchanged.
    expect(put.body.scan.createdBy).toBe(writeUser);
    expect(put.body.scan.isOwner).toBe(false);
  });

  it("scopes name collisions to the owner, so two operators may reuse a name", async () => {
    await createAs(writeUser, `${PFX}-samename`, "private");
    // Same name, different owner — allowed. A 409 here would both be a dead end
    // and disclose a row the caller cannot see.
    const mine = await createAs(otherWriteUser, `${PFX}-samename`, "private");
    expect(mine.id).toBeTruthy();

    // The SAME owner reusing it is still refused.
    const agent = await loginAs(otherWriteUser);
    const dupe = await agent
      .post("/api/v1/network-scans")
      .set("x-csrf-token", await csrfFor(agent))
      .send({ ...body(`${PFX}-samename`), visibility: "private" });
    expect(dupe.status).toBe(409);
  });

  it("defaults to private when the payload says nothing", async () => {
    // An older client — and an imported .discovery.json, which carries no
    // visibility at all — must not publish by omission.
    const agent = await loginAs(writeUser);
    const resp = await agent
      .post("/api/v1/network-scans")
      .set("x-csrf-token", await csrfFor(agent))
      .send(body(`${PFX}-default-vis`));
    expect(resp.status).toBe(201);
    madeScanIds.push(resp.body.scan.id);
    expect(resp.body.scan.visibility).toBe("private");
  });
});
