/**
 * src/services/sessionRevocationService.ts — end a user's live sessions.
 *
 * A session carries its own role snapshot and `userId`, and nothing else ties
 * it back to the account. So deleting a user, changing their role, or resetting
 * their password, second factor or passkeys left every session that account
 * already held working until it expired — the account was gone or locked down,
 * and the person (or whoever stole the cookie) was still in (scan finding F188;
 * business rule 108). The one code path that cut sessions off was a user
 * changing their own password.
 *
 * Sessions live in the `session` table owned by connect-pg-simple, not by
 * Prisma's schema, so this is raw SQL. It is BEST EFFORT by design: the change
 * that triggered it has already been committed, and a failure here must not turn
 * into a failed request — the revalidation middleware is the backstop.
 */

import { prisma } from "../db.js";
import { logger } from "../utils/logger.js";

/**
 * Delete every session belonging to `userId`, except `keepSid` (the caller's
 * own, when they are acting on themselves). Returns how many were removed, or 0
 * when the store could not be reached. One set-based statement: it filters in
 * the database rather than reading every live session into memory.
 */
export async function revokeUserSessions(userId: string, keepSid?: string): Promise<number> {
  try {
    const removed = await prisma.$executeRaw`
      DELETE FROM session
      WHERE (sess::jsonb)->>'userId' = ${userId}
        AND sid <> ${keepSid ?? ""}
    `;
    return Number(removed);
  } catch (err) {
    logger.warn({ err: (err as Error)?.message }, "Could not revoke the user's sessions");
    return 0;
  }
}
