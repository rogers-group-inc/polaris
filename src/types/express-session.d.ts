import "express-session";
import type { SessionRoleSnapshot, AccessLevel } from "../api/middleware/permissions.js";

declare module "express-session" {
  interface SessionData {
    userId: string;
    username: string;
    // Legacy convenience field — mirrors roleSnapshot.name so the few
    // read paths that just need a display string (sidebar polling
    // projection, audit Event actor enrichment) don't have to deref the
    // snapshot. ALWAYS in sync with roleSnapshot.name; permission
    // checks must consult roleSnapshot via requirePermission /
    // hasPermission, never branch on this field's value.
    role: string;
    roleId: string;
    roleSnapshot: SessionRoleSnapshot;
    authProvider: string;   // "local" | "azure" | "oidc" | "ldap" | "entra-proxy"
    samlRelayState: string;   // CSRF token for SAML flow
    samlNameID: string;       // SAML NameID for logout
    samlSessionIndex: string; // SAML SessionIndex for logout
    // Transient OIDC Authorization-Code flow checks, set at /oidc/login and
    // consumed (then cleared) at /oidc/callback. Bind the callback to the
    // login attempt: state (CSRF), nonce (ID-token replay), PKCE verifier.
    oidcState: string;
    oidcNonce: string;
    oidcCodeVerifier: string;
    lastActivity: number;     // Timestamp for inactivity tracking
    mfaVerified: boolean;     // True when the session has cleared TOTP (local accounts only)
    csrfToken: string;        // Synchronizer token for state-changing requests
    checkedAt: number;        // Last time the user row was re-checked against this session (sessionRevalidate.ts)
  }
}

declare global {
  namespace Express {
    interface Request {
      // Set by attachApiToken middleware when the request presented a valid
      // bearer token. Mutually exclusive with req.session.userId in
      // practice — token callers don't get a session. roleId is the Role the
      // token was bound to at mint time; requirePermission resolves it.
      apiToken?: { id: string; name: string; roleId: string; integrationIds: string[] };

      // Resolved role snapshot for THIS request, memoized by the permission
      // resolver (requirePermission / ensureRoleSnapshot). For token callers
      // it's the only place the snapshot lives (no session); for session
      // callers it mirrors req.session.roleSnapshot. hasPermission reads it.
      roleSnapshot?: SessionRoleSnapshot;

      // Set by `requireAgentBearer` when the request presented a valid
      // Polaris Agent bearer (issued at /api/v1/agents/enroll). Mutually
      // exclusive with both session auth and apiToken — agent callers
      // hit a dedicated /api/v1/agents/* surface and never have either.
      // assetId is the asset the bearer was bound to at issuance.
      managedAgent?: { managedAgentId: string; assetId: string };

      // Set by `requirePermission` / `requireOwnership` after a successful
      // permission check. Lets handlers branch on the resolved access
      // level — chiefly the subnets/reservations ownership filter, which
      // skips when this is "fullwrite".
      permissionLevel?: AccessLevel;
    }
  }
}
