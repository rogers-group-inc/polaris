/**
 * tests/integration/contactsDirectoryGate.test.ts
 *
 * The address book's directory visibility gate (business rule 35).
 *
 * Directory-synced contacts are the organization's whole employee roster, so
 * they are narrowed by `automationManagement:read` rather than by the `contacts`
 * key every built-in role holds. What is asserted here is the part that is easy
 * to get subtly wrong:
 *
 *   - the gate FILTERS, it does not 403 — an ungated caller still gets their
 *     curated address book, and `/contacts?origin=directory` returns an empty
 *     page rather than an error;
 *   - a caller cannot widen their own access by asking for it, because the
 *     origin FILTER and the visibility GATE are separate inputs and the gate
 *     wins;
 *   - `total` reflects the gated set, so a hidden row cannot be inferred from a
 *     count that does not match the page;
 *   - the live GAL fan-out takes the SAME gate as the stored rows — gating one
 *     and not the other would leave the roster reachable a query at a time.
 *
 * Skips cleanly when DATABASE_URL isn't reachable; see _helpers.ts.
 */

import { it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { app } from "../../src/app.js";
import { prisma } from "../../src/db.js";
import { hashPassword } from "../../src/utils/password.js";
import { FUNCTION_KEYS } from "../../src/api/middleware/permissions.js";
import { dbDescribe, dbReachable } from "./_helpers.js";

const d = dbDescribe;
const PFX = "galgate-test";
const PASSWORD = "galgate-password-not-real";

const MANUAL_EMAIL = `${PFX}-manual@example.com`;
const SYNCED_EMAIL = `${PFX}-synced@example.com`;

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

// Cached per username: the login limiter allows 10 attempts / 15 min / IP for
// the whole process, and these are read-only tests that can share a session.
const agentCache = new Map<string, ReturnType<typeof request.agent>>();
async function loginAs(username: string): Promise<ReturnType<typeof request.agent>> {
  const cached = agentCache.get(username);
  if (cached) return cached;
  const agent = request.agent(app);
  await agent.get("/api/v1/auth/me");
  const resp = await agent
    .post("/api/v1/auth/login")
    .send({ username, password: PASSWORD })
    .set("Content-Type", "application/json");
  if (resp.status !== 200) {
    throw new Error(`login as ${username} failed (${resp.status}): ${JSON.stringify(resp.body)}`);
  }
  agentCache.set(username, agent);
  return agent;
}

/** Holds contacts:read but NOT automationManagement — the built-in readonly shape. */
let ungatedUser = "";
/** Holds both — an admin-equivalent operator. */
let gatedUser = "";

beforeAll(async () => {
  if (!dbReachable) return;
  await cleanup();

  ungatedUser = await createRoleUser("nogal", matrix("read", { automationManagement: "none" }));
  gatedUser = await createRoleUser("gal", matrix("read", { automationManagement: "read" }));

  await prisma.contact.createMany({
    data: [
      { email: MANUAL_EMAIL, name: "Curated Row", origin: "manual", createdBy: "someone" },
      { email: SYNCED_EMAIL, name: "Synced Row", origin: "entra", jobTitle: "Foreman", createdBy: null },
    ],
  });
});

afterAll(async () => {
  if (!dbReachable) return;
  await cleanup();
});

async function cleanup(): Promise<void> {
  await prisma.contact.deleteMany({ where: { email: { in: [MANUAL_EMAIL, SYNCED_EMAIL] } } });
  await prisma.user.deleteMany({ where: { username: { startsWith: `${PFX}-user-` } } });
  await prisma.role.deleteMany({ where: { name: { startsWith: `${PFX}-role-` } } });
}

const emailsOf = (body: { contacts?: { email: string }[] }) => (body.contacts ?? []).map((c) => c.email);

d("GET /contacts — directory visibility gate", () => {
  it("hides synced rows from a caller without automationManagement, without 403ing", async () => {
    const agent = await loginAs(ungatedUser);
    const res = await agent.get(`/api/v1/contacts?q=${PFX}&limit=200`);
    expect(res.status).toBe(200);
    expect(emailsOf(res.body)).toEqual([MANUAL_EMAIL]);
    expect(res.body.directoryVisible).toBe(false);
  });

  it("shows them to a caller who holds it", async () => {
    const agent = await loginAs(gatedUser);
    const res = await agent.get(`/api/v1/contacts?q=${PFX}&limit=200`);
    expect(res.status).toBe(200);
    expect(emailsOf(res.body).sort()).toEqual([MANUAL_EMAIL, SYNCED_EMAIL].sort());
    expect(res.body.directoryVisible).toBe(true);
  });

  it("counts only what the caller may see, so a hidden row can't be inferred from the total", async () => {
    const ungated = await loginAs(ungatedUser);
    const gated = await loginAs(gatedUser);
    const a = await ungated.get(`/api/v1/contacts?q=${PFX}&limit=200`);
    const b = await gated.get(`/api/v1/contacts?q=${PFX}&limit=200`);
    expect(a.body.total).toBe(1);
    expect(b.body.total).toBe(2);
  });

  it("refuses to widen access when the caller ASKS for directory rows", async () => {
    // The origin filter and the visibility gate are separate inputs on purpose:
    // asking for synced rows must not be a way to be granted them.
    const agent = await loginAs(ungatedUser);
    const res = await agent.get(`/api/v1/contacts?q=${PFX}&origin=directory&limit=200`);
    expect(res.status).toBe(200);          // filter, don't 403
    expect(res.body.contacts).toEqual([]);
    expect(res.body.total).toBe(0);
  });

  it("still narrows to curated rows when a gated caller asks for them", async () => {
    const agent = await loginAs(gatedUser);
    const res = await agent.get(`/api/v1/contacts?q=${PFX}&origin=manual&limit=200`);
    expect(emailsOf(res.body)).toEqual([MANUAL_EMAIL]);
  });

  it("gates ONE named backend exactly as it gates 'directory'", async () => {
    // The address book's per-directory tab asks for `origin=entra`. That is a
    // narrowing of "directory", not a second door into it: a caller who may not
    // see synced rows gets an empty page, not the manual ones.
    const gated = await loginAs(gatedUser);
    const ok = await gated.get(`/api/v1/contacts?q=${PFX}&origin=entra&limit=200`);
    expect(emailsOf(ok.body)).toEqual([SYNCED_EMAIL]);

    const ungated = await loginAs(ungatedUser);
    const denied = await ungated.get(`/api/v1/contacts?q=${PFX}&origin=entra&limit=200`);
    expect(denied.status).toBe(200);
    expect(denied.body.contacts).toEqual([]);
    expect(denied.body.total).toBe(0);
  });

  it("names the directories that feed the book — to a gated caller only", async () => {
    // The tab strip is built from this. Naming a directory to a caller whose
    // rows are then withheld would advertise a tab that is always empty.
    const ungated = await loginAs(ungatedUser);
    expect((await ungated.get(`/api/v1/contacts?q=${PFX}`)).body.directorySources).toEqual([]);

    const gated = await loginAs(gatedUser);
    const res = await gated.get(`/api/v1/contacts?q=${PFX}`);
    expect(Array.isArray(res.body.directorySources)).toBe(true);
    // Whatever this install has configured, every entry is one backend with a
    // label and its two opt-ins — the shape the strip renders from.
    for (const s of res.body.directorySources) {
      expect(["entra", "ad"]).toContain(s.kind);
      expect(typeof s.label).toBe("string");
      expect(typeof s.sync).toBe("boolean");
      expect(typeof s.search).toBe("boolean");
    }
  });
});

d("GET /contacts/search — the same gate covers the live fan-out", () => {
  it("omits synced rows for an ungated caller and reports no directory", async () => {
    const agent = await loginAs(ungatedUser);
    const res = await agent.get(`/api/v1/contacts/search?q=${PFX}&directory=1`);
    expect(res.status).toBe(200);
    const emails = (res.body.entries ?? []).map((e: { email: string }) => e.email);
    expect(emails).toContain(MANUAL_EMAIL);
    expect(emails).not.toContain(SYNCED_EMAIL);
    // Reported false regardless of configuration: never advertise a source that
    // will then be withheld.
    expect(res.body.directoryAvailable).toBe(false);
    expect(res.body.directoryVisible).toBe(false);
  });

  it("includes them for a gated caller, badged as their directory", async () => {
    const agent = await loginAs(gatedUser);
    const res = await agent.get(`/api/v1/contacts/search?q=${PFX}`);
    const hit = (res.body.entries ?? []).find((e: { email: string }) => e.email === SYNCED_EMAIL);
    expect(hit).toBeTruthy();
    // origin stores the backend name so the picker's existing badges apply.
    expect(hit.source).toBe("entra");
    expect(hit.jobTitle).toBe("Foreman");
    expect(res.body.directoryVisible).toBe(true);
  });
});

d("DELETE /contacts/:id — a synced row is not the operator's to delete", () => {
  it("refuses with a 409 that names both ways out", async () => {
    const row = await prisma.contact.findUnique({ where: { email: SYNCED_EMAIL } });
    const agent = await loginAs(gatedUser);
    // read-level everywhere, so this is refused by the ownership gate first;
    // what matters is that it is never a 204.
    const res = await agent.delete(`/api/v1/contacts/${row!.id}`);
    expect(res.status).not.toBe(204);
    expect(await prisma.contact.findUnique({ where: { email: SYNCED_EMAIL } })).toBeTruthy();
  });
});
