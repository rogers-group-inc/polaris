/**
 * tests/unit/sessionRevocationService.test.ts — business rule 108(e): end a
 * user's live sessions in one set-based DELETE, sparing the caller's own, and
 * never fail the request that asked (best effort).
 *
 * The count and the store-down path are also in sessionHardening.test.ts; this
 * file pins the statement's parameters.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../../src/db.js", () => import("./_dbStub.js"));
const warn = vi.hoisted(() => vi.fn());
vi.mock("../../src/utils/logger.js", () => ({ logger: { warn, info: vi.fn(), debug: vi.fn(), error: vi.fn() } }));

import { revokeUserSessions } from "../../src/services/sessionRevocationService.js";
import { prisma } from "../../src/db.js";
import { resetDbStub, stubbed } from "./_dbStub.js";

const executeRaw = () => stubbed(prisma.$executeRaw);

beforeEach(() => {
  resetDbStub();
  warn.mockReset();
});

describe("revokeUserSessions", () => {
  it("binds the user id and the kept sid as parameters, never into the SQL text", async () => {
    executeRaw().mockResolvedValue(2);
    expect(await revokeUserSessions("u-'; DROP TABLE session; --", "sid-keep")).toBe(2);
    const [strings, ...values] = executeRaw().mock.calls[0];
    expect(values).toEqual(["u-'; DROP TABLE session; --", "sid-keep"]);
    const sql = (strings as string[]).join("?");
    expect(sql).toMatch(/DELETE FROM session/);
    expect(sql).toMatch(/'userId' = \?/);
    expect(sql).toMatch(/sid <> \?/);
  });

  it("spares nothing when no sid is kept (an empty sid matches no session)", async () => {
    executeRaw().mockResolvedValue(4);
    expect(await revokeUserSessions("u1")).toBe(4);
    expect(executeRaw().mock.calls[0].slice(1)).toEqual(["u1", ""]);
  });

  it("returns a plain number when the driver answers a bigint", async () => {
    executeRaw().mockResolvedValue(3n);
    const n = await revokeUserSessions("u1");
    expect(n).toBe(3);
    expect(typeof n).toBe("number");
  });

  it("returns 0 and logs a warning when the store cannot be reached", async () => {
    executeRaw().mockRejectedValue(new Error("relation \"session\" does not exist"));
    expect(await revokeUserSessions("u1", "s")).toBe(0);
    expect(warn).toHaveBeenCalledOnce();
  });
});
