/**
 * src/api/middleware/sessionRevalidate.ts — a session is only as good as the
 * account behind it.
 *
 * Authorization is read from the role snapshot stored IN the session, and
 * `requireAuth` only checks that `req.session.userId` is set. Neither asks
 * whether the user still exists or still holds that role, so an account deleted
 * or re-roled by any path that does not revoke its sessions (a direct database
 * change, an SSO group-mapping change, a restore) stayed fully authorised until
 * the cookie expired (scan finding F188; business rule 108).
 *
 * The routes that change an account now revoke its sessions directly
 * (sessionRevocationService). This is the backstop for everything else: once per
 * RECHECK_MS per session it confirms the user row exists and carries the role
 * the session believes it does. A missing user ends the session; a changed role
 * is adopted, which makes the snapshot resolver reload the new matrix.
 *
 * One indexed primary-key read per session per minute, not per request. A
 * database error fails OPEN — an outage must not log everybody out.
 */

import type { NextFunction, Request, Response } from "express";
import { prisma } from "../../db.js";

export const SESSION_RECHECK_MS = 60_000;

export async function revalidateSessionUser(req: Request, _res: Response, next: NextFunction): Promise<void> {
  try {
    const session = req.session;
    const userId = session?.userId;
    if (!session || !userId) return next();

    const now = Date.now();
    const checkedAt = session.checkedAt ?? 0;
    if (now - checkedAt < SESSION_RECHECK_MS) return next();

    const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true, roleId: true } });
    if (!user) {
      // The account is gone: start over with an empty, unauthenticated session.
      await new Promise<void>((resolve) => session.regenerate(() => resolve()));
      return next();
    }
    if (session.roleId && session.roleId !== user.roleId) {
      // Role changed under the session: adopt it. The snapshot no longer
      // matches `roleId`, so the resolver reloads the new permission matrix.
      session.roleId = user.roleId;
    }
    session.checkedAt = now;
  } catch {
    /* fail open: never turn a database error into a mass logout */
  }
  next();
}
