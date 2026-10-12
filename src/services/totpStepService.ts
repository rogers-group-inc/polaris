/**
 * src/services/totpStepService.ts — one-time use of a TOTP code (RFC 6238 §5.2).
 *
 * `totpService.verifyCodeStep` says WHICH 30-second step a code belongs to; this
 * records the last step each account has used and refuses anything at or below
 * it. Without it a code that had already logged someone in verified again for
 * up to ~90 seconds (the step before, the current one and the next), so anyone
 * who saw it could replay it (scan finding F237; business rule 108).
 *
 * The write is one conditional UPDATE, so two concurrent submissions of the same
 * code cannot both win. A separate file from totpService, which stays pure.
 */

import { prisma } from "../db.js";

/**
 * Record `step` as used by `userId`. True when this call is the first use of it
 * (or of a later step than any before); false when the step — or a later one —
 * has already been accepted, i.e. the code is a replay.
 */
export async function claimTotpStep(userId: string, step: number): Promise<boolean> {
  const { count } = await prisma.user.updateMany({
    where: {
      id: userId,
      OR: [{ totpLastStep: null }, { totpLastStep: { lt: step } }],
    },
    data: { totpLastStep: step },
  });
  return count === 1;
}
