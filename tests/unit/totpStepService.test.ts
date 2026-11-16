/**
 * tests/unit/totpStepService.test.ts — business rule 108(d): a TOTP code is
 * used once. claimTotpStep is one conditional UPDATE that wins only when the
 * account has no recorded step or a lower one.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../../src/db.js", () => import("./_dbStub.js"));

import { claimTotpStep } from "../../src/services/totpStepService.js";
import { prisma } from "../../src/db.js";
import { resetDbStub, stubbed } from "./_dbStub.js";

const updateMany = () => stubbed(prisma.user.updateMany);

/** A one-row user table that applies the service's where the way Postgres would. */
function backedBy(row: { id: string; totpLastStep: number | null }) {
  updateMany().mockImplementation(async ({ where, data }: any) => {
    if (where.id !== row.id) return { count: 0 };
    const ok = where.OR.some((c: any) =>
      ("totpLastStep" in c && c.totpLastStep === null && row.totpLastStep === null) ||
      (c.totpLastStep?.lt !== undefined && row.totpLastStep !== null && row.totpLastStep < c.totpLastStep.lt));
    if (!ok) return { count: 0 };
    row.totpLastStep = data.totpLastStep;
    return { count: 1 };
  });
}

beforeEach(() => resetDbStub());

describe("claimTotpStep", () => {
  it("sends one conditional update: no step yet, or a lower one", async () => {
    updateMany().mockResolvedValue({ count: 1 });
    expect(await claimTotpStep("u1", 1000)).toBe(true);
    expect(updateMany()).toHaveBeenCalledOnce();
    expect(updateMany().mock.calls[0][0]).toEqual({
      where: { id: "u1", OR: [{ totpLastStep: null }, { totpLastStep: { lt: 1000 } }] },
      data: { totpLastStep: 1000 },
    });
  });

  it("wins the first use of a step and refuses the replay", async () => {
    const row = { id: "u1", totpLastStep: null as number | null };
    backedBy(row);
    expect(await claimTotpStep("u1", 1000)).toBe(true);
    expect(row.totpLastStep).toBe(1000);
    expect(await claimTotpStep("u1", 1000)).toBe(false);
  });

  it("refuses an earlier step once a later one was used (the code before, inside the drift window)", async () => {
    const row = { id: "u1", totpLastStep: 1001 as number | null };
    backedBy(row);
    expect(await claimTotpStep("u1", 1000)).toBe(false);
    expect(await claimTotpStep("u1", 1002)).toBe(true);
    expect(row.totpLastStep).toBe(1002);
  });

  it("is false when no such user exists", async () => {
    updateMany().mockResolvedValue({ count: 0 });
    expect(await claimTotpStep("ghost", 5)).toBe(false);
  });
});
