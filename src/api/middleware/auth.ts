/**
 * src/api/middleware/auth.ts — Session + bearer-token authentication
 *
 * Two parallel auth surfaces:
 *   - Session (UI / browser): cookie-bearing requests. RBAC is enforced by
 *     `requirePermission(functionKey, level)` from ./permissions.ts, which
 *     consults the session's role snapshot.
 *   - Bearer token (external): `Authorization: Bearer polaris_<...>` from a
 *     long-lived API token bound to a Role at mint time. requirePermission
 *     resolves the token's role matrix exactly like a session snapshot.
 *
 * The five hardcoded-role helpers (requireAdmin / requireNetworkAdmin /
 * requireAssetsAdmin / requireUserOrAbove / isNetworkAdminOrAbove) were
 * retired in the dynamic-roles cutover (migration
 * 20260524000000_roles_table_cutover); the parallel token scope-string
 * system followed in the api-tokens role cutover (20260706000000).
 */

import { Request, Response, NextFunction } from "express";
import { AppError } from "../../utils/errors.js";
import { verifyToken } from "../../services/apiTokenService.js";
import { verifyBearer as verifyAgentBearer } from "../../services/agentTokenService.js";

export function requireAuth(req: Request, _res: Response, next: NextFunction) {
  if (req.session?.userId || req.apiToken) {
    return next();
  }
  next(new AppError(401, "Unauthorized — please log in"));
}

/**
 * Display identity for audit Events: the session username when present,
 * otherwise `api:<token name>` for bearer-token callers. Returns undefined
 * for unauthenticated callers (logEvent stores a null actor). Use this in
 * any route handler a role-bound token can reach, so token writes are
 * attributed to the token instead of "unknown".
 */
export function requestActor(req: Request): string | undefined {
  if (req.session?.username) return req.session.username;
  if (req.apiToken) return `api:${req.apiToken.name}`;
  return undefined;
}

// ─── Bearer-token auth ────────────────────────────────────────────────

function extractBearerToken(req: Request): string | null {
  const auth = req.headers.authorization;
  if (!auth || typeof auth !== "string") return null;
  const m = auth.match(/^Bearer\s+(\S+)$/i);
  return m ? m[1] : null;
}

/**
 * Resolve a bearer token (if any) on the request and attach the
 * authenticated identity to `req.apiToken`. Always calls next() — does
 * not enforce auth on its own. `requirePermission` downstream resolves
 * the token's bound role and applies the actual gate.
 *
 * Mounted globally on the API router below the session/CSRF middleware
 * so every downstream route sees the resolved identity.
 */
export async function attachApiToken(req: Request, _res: Response, next: NextFunction) {
  try {
    const raw = extractBearerToken(req);
    if (!raw) return next();
    const callerIp = (req.ip || req.socket.remoteAddress || null) ?? null;
    const result = await verifyToken(raw, callerIp);
    if (result.ok) {
      req.apiToken = result.token;
    } else if (result.reason === "untrusted_host") {
      // A real token from outside its trusted hosts: refuse outright rather
      // than fall through to a bare 401, and name the address Polaris saw —
      // behind a proxy with TRUST_PROXY unset that is the proxy's own
      // address, which is the most likely reason a correct list "fails".
      return next(
        new AppError(
          403,
          `API token "${result.tokenName}" is not accepted from ${result.callerIp || "this source address"} — ` +
            "add the address to the token's trusted hosts, or if Polaris sits behind a reverse proxy, check TRUST_PROXY",
        ),
      );
    }
    next();
  } catch {
    // Swallow — invalid token is the same as no token. The downstream
    // guard returns 401/403 with a uniform message.
    next();
  }
}

/**
 * Polaris Agent bearer guard. Verifies the presented bearer against the
 * `ManagedAgent` token store (separate from `ApiToken`; see
 * `agentTokenService.ts` for the rationale). On success attaches
 * `{managedAgentId, assetId}` to `req.managedAgent`. 401 on missing/invalid.
 *
 * Used by every /api/v1/agents/* route EXCEPT /enroll (which uses the
 * one-shot enrollment token in the body, not a bearer header).
 */
export async function requireAgentBearer(req: Request, _res: Response, next: NextFunction) {
  try {
    const raw = extractBearerToken(req);
    if (!raw) return next(new AppError(401, "Unauthorized — agent bearer required"));
    const callerIp = (req.ip || req.socket.remoteAddress || null) ?? null;
    const verified = await verifyAgentBearer(raw, callerIp);
    if (!verified) return next(new AppError(401, "Unauthorized — agent bearer invalid or revoked"));
    req.managedAgent = verified;
    next();
  } catch (err) {
    next(err);
  }
}

// requireSessionOrTokenScope (and its successor requireSessionOrTokenPermission)
// retired — bearer tokens carry a roleId and pass the plain requirePermission
// gate in ./permissions.ts.
