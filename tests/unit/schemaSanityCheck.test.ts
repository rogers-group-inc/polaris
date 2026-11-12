/**
 * tests/unit/schemaSanityCheck.test.ts
 *
 * Boot-time client-vs-DB drift check: one findFirst per hot model; a P2022
 * (missing column) on any of them logs fatal, prints the recovery runbook and
 * exits 1; any other error propagates untouched; a clean schema returns.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../../src/db.js", () => import("./_dbStub.js"));
const loggerMock = vi.hoisted(() => ({ fatal: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }));
vi.mock("../../src/utils/logger.js", () => ({ logger: loggerMock }));

import { prisma } from "../../src/db.js";
import { resetDbStub } from "./_dbStub.js";
import { runSchemaSanityCheck } from "../../src/utils/schemaSanityCheck.js";

const MODELS = [
  "asset", "assetSource", "integration", "subnet", "reservation",
  "credential", "mibFile", "manufacturerProfile", "user", "role",
] as const;

const p2022 = (extra: Record<string, unknown> = {}) => Object.assign(new Error("column does not exist"), { code: "P2022", ...extra });

let exitSpy: ReturnType<typeof vi.spyOn>;
let errSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  resetDbStub();
  loggerMock.fatal.mockClear();
  exitSpy = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
  errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => {
  exitSpy.mockRestore();
  errSpy.mockRestore();
});

const p = prisma as unknown as Record<string, { findFirst: ReturnType<typeof vi.fn> }>;

describe("runSchemaSanityCheck", () => {
  it("probes every hot model with findFirst({}) and returns quietly when all succeed", async () => {
    await runSchemaSanityCheck();
    for (const m of MODELS) expect(p[m].findFirst).toHaveBeenCalledWith({});
    expect(exitSpy).not.toHaveBeenCalled();
    expect(loggerMock.fatal).not.toHaveBeenCalled();
  });

  it("collects every P2022, naming the column from either Prisma shape, then exits 1", async () => {
    p.asset.findFirst.mockRejectedValueOnce(p2022({ meta: { driverAdapterError: { cause: { column: "monitoredOperatorSet" } } } }));
    p.subnet.findFirst.mockRejectedValueOnce(p2022({ meta: { column: "legacyCol" } }));
    p.role.findFirst.mockRejectedValueOnce(p2022());
    await runSchemaSanityCheck();
    // Later models are still probed after a failure — failures are independent.
    expect(p.user.findFirst).toHaveBeenCalled();
    const failures = loggerMock.fatal.mock.calls[0][0].failures;
    expect(failures).toEqual([
      { model: "asset", column: "monitoredOperatorSet", message: "column does not exist" },
      { model: "subnet", column: "legacyCol", message: "column does not exist" },
      { model: "role", column: undefined, message: "column does not exist" },
    ]);
    const printed = errSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("\n");
    expect(printed).toContain('- asset: column "monitoredOperatorSet" missing from database');
    expect(printed).toContain("- role: missing from database");
    expect(printed).toContain("npx prisma generate");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("lets a non-P2022 error propagate without exiting", async () => {
    const conn = Object.assign(new Error("ECONNREFUSED"), { code: "P1001" });
    p.integration.findFirst.mockRejectedValueOnce(conn);
    await expect(runSchemaSanityCheck()).rejects.toBe(conn);
    expect(exitSpy).not.toHaveBeenCalled();
    expect(p.subnet.findFirst).not.toHaveBeenCalled();
  });
});
