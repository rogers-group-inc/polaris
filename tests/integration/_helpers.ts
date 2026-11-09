/**
 * tests/integration/_helpers.ts
 *
 * Shared scaffolding for the integration test suites:
 *   - dbReachable: probes DATABASE_URL at module load. When the DB is
 *     unreachable, suites use `describe.skip` so vitest reports them as
 *     skipped rather than red on sandboxed / offline runs.
 *   - ensureTestUser: idempotent admin user used to authenticate every
 *     mutating request. One row across the whole test process.
 *   - authedAgent: returns a supertest agent with a live session +
 *     captured CSRF token. Pass the `csrf` value as `X-CSRF-Token` on
 *     every PUT/POST/DELETE.
 *
 * The probe runs once per worker process (vitest forks workers per file
 * by default, but Prisma + the helper module both no-op cleanly on the
 * second probe so this is safe under any concurrency model).
 */

import { describe } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { prisma } from "../../src/db.js";
import { hashPassword } from "../../src/utils/password.js";

const TEST_USERNAME = "polaris-integration-tester";
const TEST_PASSWORD = "test-password-do-not-use-in-prod";

/** True when DATABASE_URL is set AND the DB answers a trivial SELECT. */
export const dbReachable: boolean = await (async () => {
  if (!process.env.DATABASE_URL) return false;
  try {
    await prisma.$queryRaw`SELECT 1`;
    return true;
  } catch (err) {
    // Surface the real failure: without this, "DB down" and "DB up but the
    // probe crashed" look identical (suites silently skip either way).
    console.error("[integration tests] DATABASE_URL is set but the probe failed:", err);
    return false;
  }
})();

/** Use this in place of `describe` to make a suite skip cleanly when the DB is unreachable. */
export const dbDescribe = dbReachable ? describe : describe.skip;

if (!dbReachable) {
  console.warn("[integration tests] DB unreachable — suites will skip. Set DATABASE_URL and ensure the DB is up to run them.");
}

/**
 * Idempotently create the shared test user. Safe to call from every file's
 * beforeAll. The user is left in place across tests; per-file beforeEach
 * hooks wipe everything else.
 */
export async function ensureTestUser(): Promise<{ username: string; password: string }> {
  if (!dbReachable) return { username: TEST_USERNAME, password: TEST_PASSWORD };
  const existing = await prisma.user.findUnique({ where: { username: TEST_USERNAME } });
  if (!existing) {
    // Post-cutover RBAC: the User.role enum column is gone — users join the
    // Role table via roleId. The built-in roles are seeded by the
    // roles-table-cutover migration, so a migrated test DB always has "admin".
    const adminRole = await prisma.role.findUnique({ where: { name: "admin" } });
    if (!adminRole) {
      throw new Error(
        "built-in 'admin' Role row missing — run `npx prisma migrate deploy` against the test DB first",
      );
    }
    await prisma.user.create({
      data: {
        username:     TEST_USERNAME,
        passwordHash: await hashPassword(TEST_PASSWORD),
        roleId:       adminRole.id,
        authProvider: "local",
      },
    });
  }
  return { username: TEST_USERNAME, password: TEST_PASSWORD };
}

/**
 * Audit Events are written fire-and-forget (`void logEvent(...)`), so a test
 * asserting on Event rows right after a mutation response races the insert.
 * Poll until the count for `action` (optionally scoped to a resourceId)
 * reaches `expected`, or ~1s elapses; returns the final count either way so
 * the caller's expect() reports the real number.
 */
export async function waitForEventCount(
  action: string,
  expected: number,
  resourceId?: string,
): Promise<number> {
  const where = { action, ...(resourceId ? { resourceId } : {}) };
  for (let i = 0; i < 20; i++) {
    const n = await prisma.event.count({ where });
    if (n >= expected) return n;
    await new Promise((r) => setTimeout(r, 50));
  }
  return prisma.event.count({ where });
}

/**
 * Build a logged-in supertest agent. The agent's cookie jar holds the
 * session cookie + the polaris_csrf cookie across requests; the returned
 * `csrf` string is what mutating requests must echo in the `X-CSRF-Token`
 * header.
 *
 * The result is CACHED per process (vitest forks one process per file, so:
 * one login per suite). The login rate limiter allows 10 attempts / 15 min
 * per IP — a per-test login blows through that mid-suite. Pass
 * `{ fresh: true }` for a test that genuinely needs its own session (it
 * spends one login attempt from the same budget).
 */
let cachedAuthed: { agent: ReturnType<typeof request.agent>; csrf: string } | null = null;

export async function authedAgent(app: Express, opts?: { fresh?: boolean }): Promise<{
  agent: ReturnType<typeof request.agent>;
  csrf:  string;
}> {
  if (!opts?.fresh && cachedAuthed) return cachedAuthed;
  const agent = request.agent(app);
  // GET first so the session-pinned CSRF cookie gets set before login.
  await agent.get("/api/v1/auth/me");
  const loginResp = await agent
    .post("/api/v1/auth/login")
    .send({ username: TEST_USERNAME, password: TEST_PASSWORD })
    .set("Content-Type", "application/json");
  if (loginResp.status !== 200) {
    throw new Error(`Login failed (${loginResp.status}): ${JSON.stringify(loginResp.body)}`);
  }
  // Login regenerates the session (fixation defense), which discards the
  // pre-login CSRF token; the regenerated session only mints its token on the
  // NEXT request. One follow-up GET refreshes the cookie to the live value —
  // the same thing the SPA does naturally after login.
  await agent.get("/api/v1/auth/me");
  // cookiejar's getCookies takes a CookieAccessInfo-shaped object, not a URL
  // string (a string silently matches nothing). supertest binds the agent to
  // 127.0.0.1; the CSRF cookie is host-scoped with path "/".
  const cookies = (agent.jar as any).getCookies({ domain: "127.0.0.1", path: "/", secure: false, script: false });
  const csrf = (cookies.find((c: any) => c.name === "polaris_csrf") || {}).value || "";
  if (!csrf) throw new Error("CSRF cookie not set after login");
  const result = { agent, csrf };
  if (!opts?.fresh) cachedAuthed = result;
  return result;
}
