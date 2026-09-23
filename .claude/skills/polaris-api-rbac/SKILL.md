---
name: polaris-api-rbac
description: "Polaris REST API under /api/v1 and its permission model: every route file and mount, Zod schema placement, the 32 function keys, requirePermission levels (none/read/write/fullwrite), shorter ladders, the ownership dimension, built-in roles, session role snapshots, role-bound bearer tokens, SSO/OIDC/LDAP/SAML/Entra App Proxy login, passkey/WebAuthn ceremony endpoints and the four registrations each one needs, group mappings, CSRF, rate limits, last-admin guard. Load when adding or changing an endpoint or route gate, adding a permission key, debugging a 401/403, asking who can do X, minting tokens, anything about login, SSO or passkeys, or touching src/api/."
---

# Polaris API and RBAC

All routes are prefixed `/api/v1/` and aggregated by `src/api/router.ts`. Route handlers
are thin: Zod schema at the top of the route file, validate, call a service, return.
Permission gates live in `src/api/middleware/permissions.ts` — `requirePermission(functionKey,
level)` resolves against the caller's role snapshot (session-stamped for browsers, resolved
from the bound Role for bearer tokens); `requireOwnership(functionKey)` adds the ownership
dimension for `subnets` / `reservations` / `contacts` / `credentials` / `networkScan`.

## Which file

| You need… | Read |
|---|---|
| the route-group overview as CLAUDE.md summarized it (which mount, which gate, the load-bearing quirks per group) | [references/routes-overview.md](references/routes-overview.md) |
| the RBAC model: dynamic roles, the 32-key catalogue, level ladders, ownership, session snapshot + cache invalidation, region/other tags, SSO/LDAP/App Proxy login, bearer tokens, last-admin guard, rate limits, the stale-Secure-cookie trap | [references/auth-rbac.md](references/auth-rbac.md) |
| per-endpoint bodies/shapes/gates — auth, TOTP, blocks, subnets, reservations, utilization, dashboard, user dashboard, table tabs, saved dashboards/filters, users, roles, group mappings, API tokens, credentials | [references/endpoints-ipam-identity.md](references/endpoints-ipam-identity.md) |
| `/assets` (~95 routes: CRUD, monitor history, quarantine, system-info, ARP, ip-context, upstream, agent install, pins, SNMP walk) | [references/endpoints-assets.md](references/endpoints-assets.md) |
| asset types + matching, monitor settings, conflicts, search, events, manufacturer aliases | [references/endpoints-assets-adjacent.md](references/endpoints-assets-adjacent.md) |
| integrations, device map, application map, weather, map regions, allocation templates, server settings, agents, MIBs, manufacturer profiles, device icons | [references/endpoints-integrations-maps-settings.md](references/endpoints-integrations-maps-settings.md) |

## The rules every route obeys

- **Declare the gate on the route.** `requirePermission(key, level)`; the level must exist in the key's ladder (`levels` on `FunctionKeyDef`) or the module throws at load. A key with an ownership dimension keeps both `write` and `fullwrite`.
- **Literal paths before `/:id`.** `GET /assets/quarantine-availability`, `/assets/ip-context`, `/subnets/archived`, `/subnets/exclusions`, `/automations/:id/removal-impact`, `/delivery-channels/web-push` and their siblings MUST stay declared above the parameterized route on the same mount.
- **Scoped-away resources answer 404, not 403** (`GET /alerts/:id`, saved dashboards, network scans) so a caller cannot enumerate ids it may not see.
- **Filter-don't-403 surfaces** (`/search`, `/dashboard/noc-summary`, `/dashboard/summary`) return empty sections instead of erroring.
- **Bearer callers skip CSRF** (`csrf.ts`); attribute their writes via `requestActor(req)` (`api:<token name>`). Sessions are 8h, PostgreSQL-backed, HttpOnly/Secure/SameSite=Lax.
- **Adding a function key** = catalogue entry in `FUNCTION_KEYS` + migration seeding it on every Role + route guard + the users.js matrix renders it from `GET /roles/functions`. **Narrowing a ladder** additionally needs a migration folding stored matrices DOWN.
- **Deprecated aliases** (`/notifications`, `/notification-rules`, `/notification-channels`) stay dual-mounted with `Deprecation` + successor `Link` headers; keep `/notification-rules` mounted before `/notifications`.
- **New endpoints go through a service** — never raw Prisma in a handler; any audit-worthy mutation writes an `Event`.
- Legacy route files still carrying inline Prisma (`agents.ts`, `assets.ts`, `integrations.ts`, `serverSettings.ts`, `users.ts`): extract opportunistically when you touch them.

## Built-in roles (seeded, see auth-rbac.md for the full table)

`admin` (protected, every key `fullwrite`) · `readonly` (protected) · `networkadmin` (IP space / integrations / map regions / discovery conflicts write) · `assetsadmin` (assets / quarantine / monitor settings write + own-row IPAM write) · `user` (own-row IPAM write). Custom roles are edited under Users → Manage Roles.

Related: `polaris-change-impact` → `cross-cutting/dynamic-roles-permission-matrix.md`,
`cross-cutting/sso-login-and-group-mapping.md`, `cross-cutting/csp-inline-script-policy.md`,
`patterns/backend-patterns-integration.md` → "Permission-gated route + dynamic-role function key";
`polaris-business-rules` rules 25, 31, 34, 43. The external developer contract is the
gated `/api` page (`public/api.html`) — the internal catalogue here documents more than it promises.
