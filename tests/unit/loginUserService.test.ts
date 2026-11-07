/**
 * tests/unit/loginUserService.test.ts — the sign-in flows' User reads and
 * writes (services/loginUserService.ts, lifted out of routes/auth.ts by
 * CQ-B044 part 3). The flows themselves are pinned by the integration suite.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const db = vi.hoisted(() => ({ user: { findUnique: vi.fn(), update: vi.fn() } }));
vi.mock("../../src/db.js", () => ({ prisma: db }));
vi.mock("../../src/utils/password.js", () => ({ hashPassword: async (p: string) => `hash(${p})` }));

const svc = await import("../../src/services/loginUserService.js");

const user = (over: Record<string, unknown> = {}) => ({
  id: "u1", lastLogin: new Date("2026-01-01T00:00:00Z"), role: { name: "operator" }, ...over,
});
const lastData = () => db.user.update.mock.calls.at(-1)![0].data;

beforeEach(() => vi.clearAllMocks());

describe("user lookups", () => {
  it("join the role, by username and by id", async () => {
    await svc.findUserWithRoleByUsername("alice");
    expect(db.user.findUnique).toHaveBeenCalledWith({ where: { username: "alice" }, include: { role: true } });
    await svc.findUserWithRoleById("u1");
    expect(db.user.findUnique).toHaveBeenCalledWith({ where: { id: "u1" }, include: { role: true } });
  });
});

describe("recordSuccessfulLogin", () => {
  it("always stamps lastLogin, and nothing else by default", async () => {
    await svc.recordSuccessfulLogin(user({ lastLogin: null }));
    expect(Object.keys(lastData())).toEqual(["lastLogin"]);
    expect(lastData().lastLogin).toBeInstanceOf(Date);
  });

  it("stamps needsRoleReview only on a first login of a non-admin, and only when asked", async () => {
    await svc.recordSuccessfulLogin(user({ lastLogin: null }), { stampFirstLogin: true });
    expect(lastData().needsRoleReview).toBe(true);
    await svc.recordSuccessfulLogin(user(), { stampFirstLogin: true });
    expect(lastData()).not.toHaveProperty("needsRoleReview");
    await svc.recordSuccessfulLogin(user({ lastLogin: null, role: { name: "admin" } }), { stampFirstLogin: true });
    expect(lastData()).not.toHaveProperty("needsRoleReview");
  });

  it("re-hashes when asked and writes the backup codes left after one was spent", async () => {
    await svc.recordSuccessfulLogin(user(), { rehashPassword: "pw" });
    expect(lastData().passwordHash).toBe("hash(pw)");
    await svc.recordSuccessfulLogin(user(), { remainingBackupCodes: ["h1"] });
    expect(lastData().totpBackupCodes).toEqual(["h1"]);
    await svc.recordSuccessfulLogin(user(), { remainingBackupCodes: null });
    expect(lastData()).not.toHaveProperty("totpBackupCodes");
  });
});

describe("setPasswordHash", () => {
  it("writes the hash of the new password", async () => {
    await svc.setPasswordHash("u1", "new");
    expect(db.user.update).toHaveBeenCalledWith({ where: { id: "u1" }, data: { passwordHash: "hash(new)" } });
  });
});
