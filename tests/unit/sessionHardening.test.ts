/**
 * tests/unit/sessionHardening.test.ts
 *
 * Business rule 108, the session half, at unit level:
 *   - revalidateSessionUser: the backstop that ends a session whose account is
 *     gone and adopts a changed role (F188);
 *   - revokeUserSessions: one set-based DELETE, best effort (F188);
 *   - requireSessionUser and the passkey services refuse a caller with no user,
 *     so an undefined userId can never reach a Prisma `where` (F229).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const { findUnique, executeRaw, passkeyFindFirst } = vi.hoisted(() => ({
  findUnique: vi.fn(),
  executeRaw: vi.fn(),
  passkeyFindFirst: vi.fn(),
}));

vi.mock("../../src/db.js", () => ({
  prisma: {
    user: { findUnique },
    $executeRaw: executeRaw,
    userPasskey: { findFirst: passkeyFindFirst, findMany: vi.fn(), update: vi.fn(), delete: vi.fn() },
  },
}));

import { revalidateSessionUser, SESSION_RECHECK_MS } from "../../src/api/middleware/sessionRevalidate.js";
import { revokeUserSessions } from "../../src/services/sessionRevocationService.js";
import { requireSessionUser } from "../../src/api/middleware/auth.js";
import { deletePasskey, listPasskeys, renamePasskey } from "../../src/services/passkeyService.js";

function fakeReq(session: Record<string, unknown> | undefined) {
  const s: any = session
    ? { ...session, regenerate: vi.fn((cb: () => void) => { for (const k of Object.keys(s)) if (k !== "regenerate") delete s[k]; cb(); }) }
    : undefined;
  return { session: s } as any;
}

beforeEach(() => {
  findUnique.mockReset();
  executeRaw.mockReset();
  passkeyFindFirst.mockReset();
});

describe("revalidateSessionUser", () => {
  it("does nothing for a request with no session user, and never touches the database", async () => {
    const next = vi.fn();
    await revalidateSessionUser(fakeReq(undefined), {} as any, next);
    await revalidateSessionUser(fakeReq({}), {} as any, next);
    expect(next).toHaveBeenCalledTimes(2);
    expect(findUnique).not.toHaveBeenCalled();
  });

  it("does not re-check a session that was checked recently", async () => {
    const next = vi.fn();
    const req = fakeReq({ userId: "u1", roleId: "r1", checkedAt: Date.now() - 1000 });
    await revalidateSessionUser(req, {} as any, next);
    expect(findUnique).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledOnce();
  });

  it("re-checks once the window has passed and records the time", async () => {
    findUnique.mockResolvedValue({ id: "u1", roleId: "r1" });
    const next = vi.fn();
    const req = fakeReq({ userId: "u1", roleId: "r1", checkedAt: Date.now() - SESSION_RECHECK_MS - 1 });
    await revalidateSessionUser(req, {} as any, next);
    expect(findUnique).toHaveBeenCalledOnce();
    expect(req.session.checkedAt).toBeGreaterThan(Date.now() - 5000);
    expect(req.session.userId).toBe("u1");
  });

  it("ends the session when the account no longer exists", async () => {
    findUnique.mockResolvedValue(null);
    const next = vi.fn();
    const req = fakeReq({ userId: "gone", roleId: "r1" });
    await revalidateSessionUser(req, {} as any, next);
    expect(req.session.regenerate).toHaveBeenCalledOnce();
    expect(req.session.userId).toBeUndefined();
    expect(next).toHaveBeenCalledOnce();
  });

  it("adopts a changed role so the snapshot is reloaded", async () => {
    findUnique.mockResolvedValue({ id: "u1", roleId: "r2" });
    const req = fakeReq({ userId: "u1", roleId: "r1" });
    await revalidateSessionUser(req, {} as any, vi.fn());
    expect(req.session.roleId).toBe("r2");
  });

  it("fails OPEN when the database errors: an outage must not log everyone out", async () => {
    findUnique.mockRejectedValue(new Error("db down"));
    const next = vi.fn();
    const req = fakeReq({ userId: "u1", roleId: "r1" });
    await revalidateSessionUser(req, {} as any, next);
    expect(req.session.userId).toBe("u1");
    expect(next).toHaveBeenCalledOnce();
  });
});

describe("revokeUserSessions", () => {
  it("issues one set-based delete and returns how many sessions went", async () => {
    executeRaw.mockResolvedValue(3);
    expect(await revokeUserSessions("u1", "keep-me")).toBe(3);
    expect(executeRaw).toHaveBeenCalledOnce();
  });

  it("returns 0 rather than throwing when the session store cannot be reached", async () => {
    executeRaw.mockRejectedValue(new Error("no table"));
    expect(await revokeUserSessions("u1")).toBe(0);
  });
});

describe("requireSessionUser", () => {
  it("admits a request with a signed-in user", () => {
    const next = vi.fn();
    requireSessionUser({ session: { userId: "u1" } } as any, {} as any, next);
    expect(next).toHaveBeenCalledWith();
  });

  it("refuses a bearer-token caller, who has no session user", () => {
    const next = vi.fn();
    requireSessionUser({ session: {}, apiToken: { id: "t" } } as any, {} as any, next);
    expect(next.mock.calls[0][0]).toMatchObject({ httpStatus: 401 });
    const next2 = vi.fn();
    requireSessionUser({} as any, {} as any, next2);
    expect(next2.mock.calls[0][0]).toMatchObject({ httpStatus: 401 });
  });
});

describe("passkey services never run a lookup with an empty userId", () => {
  it.each([undefined, null, ""])("refuses %j", async (bad) => {
    await expect(deletePasskey(bad as any, "pk1")).rejects.toMatchObject({ httpStatus: 401 });
    await expect(renamePasskey(bad as any, "pk1", "x")).rejects.toMatchObject({ httpStatus: 401 });
    await expect(listPasskeys(bad as any)).rejects.toMatchObject({ httpStatus: 401 });
    expect(passkeyFindFirst).not.toHaveBeenCalled();
  });
});
