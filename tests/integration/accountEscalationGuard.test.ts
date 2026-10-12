/**
 * tests/integration/accountEscalationGuard.test.ts
 *
 * Business rule 48 on the paths a security review found open:
 *
 *   - `users:write` could reset the password / TOTP / passkeys of, delete, or
 *     re-role an admin-equivalent account — i.e. become an admin.
 *   - `apiTokens:write` could mint a bearer token bound to an admin-equivalent
 *     role — the same escalation through a long-lived credential.
 *
 * Both now require the caller to be admin-equivalent themselves (users AND
 * roles at Full Read-Write, which the built-in admin role carries), while the
 * delegation `users:write` exists for — managing accounts on lesser roles —
 * is left intact.
 *
 * Skips cleanly when DATABASE_URL isn't reachable; see _helpers.ts.
 */

import { it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { app } from "../../src/app.js";
import { prisma } from "../../src/db.js";
import { dbDescribe, dbReachable } from "./_helpers.js";
import { createToken } from "../../src/services/apiTokenService.js";
import { createRole, deleteRole } from "../../src/services/roleService.js";
import { hashPassword } from "../../src/utils/password.js";

const d = dbDescribe;

const MANAGER_ROLE = "test-escalation-manager";
const PLAIN_ROLE = "test-escalation-plain";
// Admin-equivalent (users + roles Full Read-Write) without the quarantine grant
// that makes the built-in admin role demand a FortiGate integration on a token.
const ADMINLIKE_ROLE = "test-escalation-adminlike";
const TOKEN_PREFIX = "test-escalation-";
const ADMIN_TARGET = "test-escalation-admin-target";
const PLAIN_TARGET = "test-escalation-plain-target";
const NEW_PASSWORD = "Tr1cky-Unlikely-Passphrase-2026!";

let adminRoleId = "";
let managerRoleId = "";
let plainRoleId = "";
let adminLikeRoleId = "";
let adminTargetId = "";
let plainTargetId = "";
let managerToken = "";
let adminToken = "";
let adminTargetHash = "";

const bearer = (raw: string) => ({ Authorization: `Bearer ${raw}` });

async function cleanup() {
  await prisma.apiToken.deleteMany({ where: { name: { startsWith: TOKEN_PREFIX } } });
  await prisma.user.deleteMany({ where: { username: { in: [ADMIN_TARGET, PLAIN_TARGET] } } });
  await prisma.role.deleteMany({ where: { name: { in: [MANAGER_ROLE, PLAIN_ROLE, ADMINLIKE_ROLE] } } });
}

beforeAll(async () => {
  if (!dbReachable) return;
  await prisma.$connect();
  await cleanup();

  const admin = await prisma.role.findFirst({ where: { name: "admin" } });
  if (!admin) throw new Error("built-in admin role missing");
  adminRoleId = admin.id;

  // The attacker the review described: users:write + apiTokens:write and
  // nothing that makes them admin-equivalent.
  managerRoleId = (await createRole({
    name: MANAGER_ROLE,
    permissions: { users: "write", apiTokens: "write" },
  })).id;
  plainRoleId = (await createRole({ name: PLAIN_ROLE, permissions: { assets: "read" } })).id;
  adminLikeRoleId = (await createRole({
    name: ADMINLIKE_ROLE,
    permissions: { users: "fullwrite", roles: "fullwrite", apiTokens: "write" },
  })).id;

  const passwordHash = await hashPassword("Initial-Passphrase-Not-Used-1!");
  const adminTarget = await prisma.user.create({
    data: { username: ADMIN_TARGET, passwordHash, roleId: adminRoleId, authProvider: "local" },
  });
  const plainTarget = await prisma.user.create({
    data: { username: PLAIN_TARGET, passwordHash, roleId: plainRoleId, authProvider: "local" },
  });
  adminTargetId = adminTarget.id;
  adminTargetHash = adminTarget.passwordHash;
  plainTargetId = plainTarget.id;

  managerToken = (await createToken({ name: `${TOKEN_PREFIX}manager`, roleId: managerRoleId, createdBy: "integration-test" })).rawToken;
  adminToken = (await createToken({ name: `${TOKEN_PREFIX}admin`, roleId: adminLikeRoleId, createdBy: "integration-test" })).rawToken;
});

afterAll(async () => {
  if (!dbReachable) return;
  await cleanup();
  await deleteRole(managerRoleId).catch(() => {});
  await deleteRole(plainRoleId).catch(() => {});
  await deleteRole(adminLikeRoleId).catch(() => {});
  await prisma.$disconnect();
});

d("users:write against an admin-equivalent account", () => {
  it("cannot reset its password, and the stored hash is untouched", async () => {
    const res = await request(app)
      .put(`/api/v1/users/${adminTargetId}/password`)
      .set(bearer(managerToken))
      .send({ password: NEW_PASSWORD });
    expect(res.status).toBe(403);
    const after = await prisma.user.findUnique({ where: { id: adminTargetId } });
    expect(after?.passwordHash).toBe(adminTargetHash);
  });

  it("cannot reset its two-factor authentication", async () => {
    const res = await request(app).delete(`/api/v1/users/${adminTargetId}/totp`).set(bearer(managerToken));
    expect(res.status).toBe(403);
  });

  it("cannot revoke its passkeys", async () => {
    const res = await request(app).delete(`/api/v1/users/${adminTargetId}/passkeys`).set(bearer(managerToken));
    expect(res.status).toBe(403);
  });

  it("cannot delete it", async () => {
    const res = await request(app).delete(`/api/v1/users/${adminTargetId}`).set(bearer(managerToken));
    expect(res.status).toBe(403);
    expect(await prisma.user.findUnique({ where: { id: adminTargetId } })).not.toBeNull();
  });

  it("cannot move it to a lesser role", async () => {
    const res = await request(app)
      .put(`/api/v1/users/${adminTargetId}/role`)
      .set(bearer(managerToken))
      .send({ roleId: plainRoleId });
    expect(res.status).toBe(403);
    expect((await prisma.user.findUnique({ where: { id: adminTargetId } }))?.roleId).toBe(adminRoleId);
  });
});

d("users:write against an account on a lesser role", () => {
  it("still resets the password — that is the delegation the key exists for", async () => {
    const res = await request(app)
      .put(`/api/v1/users/${plainTargetId}/password`)
      .set(bearer(managerToken))
      .send({ password: NEW_PASSWORD });
    expect(res.status).toBe(200);
  });
});

d("an admin-equivalent caller", () => {
  it("can reset an admin-equivalent account's password", async () => {
    const res = await request(app)
      .put(`/api/v1/users/${adminTargetId}/password`)
      .set(bearer(adminToken))
      .send({ password: NEW_PASSWORD });
    expect(res.status).toBe(200);
  });
});

d("apiTokens:write binding a token to a role", () => {
  it("cannot mint a token bound to an admin-equivalent role, and nothing is created", async () => {
    const res = await request(app)
      .post("/api/v1/api-tokens")
      .set(bearer(managerToken))
      .send({ name: `${TOKEN_PREFIX}escalated`, roleId: adminLikeRoleId });
    expect(res.status).toBe(403);
    expect(await prisma.apiToken.findUnique({ where: { name: `${TOKEN_PREFIX}escalated` } })).toBeNull();
  });

  it("can still mint a token bound to a role that is not admin-equivalent", async () => {
    const res = await request(app)
      .post("/api/v1/api-tokens")
      .set(bearer(managerToken))
      .send({ name: `${TOKEN_PREFIX}plain`, roleId: plainRoleId });
    expect(res.status).toBe(201);
    expect(typeof res.body.rawToken).toBe("string");
  });

  it("lets an admin-equivalent caller bind one to an admin-equivalent role", async () => {
    const res = await request(app)
      .post("/api/v1/api-tokens")
      .set(bearer(adminToken))
      .send({ name: `${TOKEN_PREFIX}by-admin`, roleId: adminLikeRoleId });
    expect(res.status).toBe(201);
  });
});
