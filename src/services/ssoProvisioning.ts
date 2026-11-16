/**
 * src/services/ssoProvisioning.ts — Shared find-or-provision for SSO/LDAP users
 *
 * The OIDC, LDAP, and Entra App Proxy (header-SSO) login flows converge here.
 * Given a verified external profile (stable id + username hint + groups), this:
 *   1. Resolves the user's IdP groups → role + tags via groupMappingService.
 *   2. Matches an existing user by the provider's stable id column, or creates
 *      one (collision-handled username, placeholder password).
 *   3. Applies the GROUP-RESOLVED role (highest-privilege wins). On an EXISTING
 *      user a no-group-match login LEAVES the current role intact (so a manual
 *      admin assignment isn't clobbered every login); a NEW user with no match
 *      falls back to `readonly` + needsRoleReview, matching SAML behavior.
 *   4. Records the user's normalized groups in `ssoGroups` so GET /auth/me can
 *      re-resolve region/other tags dynamically. Group-derived tags are NEVER
 *      written to the user's own regionTags/otherTags columns — those stay
 *      operator-owned and union with the group-derived set at read time.
 *
 * Cross-provider convergence on azureOid: entra-proxy keys on the SAME Entra
 * object ID the Azure SAML path stores, deliberately — a user who has signed
 * in via SAML and later arrives through App Proxy lands on the same account.
 * The existing-user branch stamps `authProvider` to the current provider so
 * `resolveTagScopesForUser` re-resolves the freshly-written ssoGroups under
 * the matching group-mapping provider. Since the 2026-08 fold the Azure SAML
 * path (findOrProvisionSamlUser) delegates here too with provider "azure":
 * the LAST login path owns authProvider + ssoGroups, so an azureOid account
 * alternating between SAML and App Proxy always has its stored groups
 * re-resolved under the provider that wrote them. authProvider "azure" is
 * not itself a group-mapping provider — its groups resolve under "saml"
 * (mappingProviderForAuthProvider), the key the Group Mappings UI offers.
 */

import { randomBytes } from "node:crypto";
import { prisma } from "../db.js";
import { AppError } from "../utils/errors.js";
import { hashPassword } from "../utils/password.js";
import { resolveGroupsToAccess, normalizeGroupKey, mappingProviderForAuthProvider } from "./groupMappingService.js";

// Cap stored groups so an IdP that emits hundreds of group claims can't bloat
// the row. The resolver only needs the groups that might match a mapping.
const SSO_GROUPS_MAX = 256;
const USERNAME_SAFE_RE = /[^a-z0-9._-]/g;

export interface ExternalUserProfile {
  /**
   * The authProvider value stamped on the user. "azure" (the SAML path) is
   * special-cased for group resolution: its mappings live under the "saml"
   * provider key, but its username-collision suffixes still use "azure" —
   * which reproduces the pre-fold SAML naming byte-for-byte.
   */
  provider: "oidc" | "ldap" | "entra-proxy" | "azure";
  externalIdField: "oidcSubject" | "ldapUid" | "azureOid";
  externalId: string; // OIDC `sub`, LDAP objectGUID hex, or Entra object ID — stable per user
  usernameHint: string; // preferred_username / sAMAccountName / email local-part
  displayName?: string | null;
  email?: string | null;
  groups: string[]; // raw group claim values / group DNs / SAML group object-IDs
}

function deriveUsername(hint: string, provider: string, externalId: string): string {
  let username = (hint || "").split("@")[0].toLowerCase().replace(USERNAME_SAFE_RE, "");
  if (!username) username = `${provider}-${externalId.slice(0, 8)}`;
  return username;
}

function normalizeGroupList(provider: string, groups: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const g of groups) {
    const k = normalizeGroupKey(provider, g);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(k);
    if (out.length >= SSO_GROUPS_MAX) break;
  }
  return out;
}

/**
 * Returns the user row (with `role` included) ready for session stamping.
 */
export async function provisionExternalUser(profile: ExternalUserProfile) {
  const { provider, externalIdField, externalId } = profile;
  if (!externalId) throw new AppError(502, `${provider} login: missing stable user identifier`);

  // Group resolution rides the MAPPING provider key ("azure" → "saml");
  // username derivation below keeps the authProvider name.
  const groupProvider = mappingProviderForAuthProvider(provider);
  const access = await resolveGroupsToAccess(groupProvider, profile.groups);
  const ssoGroups = normalizeGroupList(groupProvider, profile.groups);

  // Validate a group-resolved role actually exists (it could have been deleted
  // between resolve and now → onDelete:SetNull already nulled the mapping, but
  // be defensive). null means "no group resolved a role".
  let resolvedRoleId: string | null = access.roleId;
  let resolvedRoleName: string | null = null;
  if (resolvedRoleId) {
    const exists = await prisma.role.findUnique({ where: { id: resolvedRoleId }, select: { id: true, name: true } });
    if (!exists) resolvedRoleId = null;
    else resolvedRoleName = exists.name ?? null;
  }

  const existing = await prisma.user.findFirst({
    where: { [externalIdField]: externalId } as any,
    include: { role: true },
  });

  if (existing) {
    const isFirstLogin = existing.lastLogin === null;
    // Override role only when groups resolved one; otherwise keep the current
    // (possibly admin-assigned) role so a coverage gap doesn't demote anyone.
    const roleId = resolvedRoleId ?? existing.roleId;
    // The admin exemption (an admin reviewing their own role is redundant)
    // holds only while the user stays admin: a first login whose groups move
    // the role — onto admin or off it — is exactly what the review is for.
    const wasAdmin = existing.role.name === "admin";
    const endsAdmin = resolvedRoleId ? resolvedRoleName === "admin" : wasAdmin;
    const stampReview = isFirstLogin && !(wasAdmin && endsAdmin);
    return prisma.user.update({
      where: { id: existing.id },
      data: {
        displayName: profile.displayName || existing.displayName,
        email: profile.email || existing.email,
        roleId,
        ssoGroups,
        // Keep authProvider aligned with the login path that owns ssoGroups —
        // a no-op for oidc/ldap (rows found by their own id column), but an
        // azureOid row provisioned by SAML converts to entra-proxy here so
        // group→tag re-resolution reads the right provider's mappings.
        authProvider: provider,
        lastLogin: new Date(),
        ...(stampReview ? { needsRoleReview: true } : {}),
      },
      include: { role: true },
    });
  }

  // New user. Resolve role: group-mapped role, else the built-in readonly.
  let roleId = resolvedRoleId;
  if (!roleId) {
    const readonly = await prisma.role.findUnique({ where: { name: "readonly" } });
    if (!readonly) {
      throw new AppError(500, `${provider} auto-provision: built-in 'readonly' role not found — Polaris is mis-seeded`);
    }
    roleId = readonly.id;
  }

  // Collision-handled username, placeholder password (never used for SSO/LDAP).
  let username = deriveUsername(profile.usernameHint, provider, externalId);
  const collision = await prisma.user.findUnique({ where: { username } });
  if (collision) {
    username = `${username}-${provider}`;
    const collision2 = await prisma.user.findUnique({ where: { username } });
    if (collision2) username = `${provider}-${externalId.slice(0, 12)}`;
  }
  const placeholderHash = await hashPassword(randomBytes(32).toString("hex"));

  return prisma.user.create({
    data: {
      username,
      passwordHash: placeholderHash,
      roleId,
      authProvider: provider,
      [externalIdField]: externalId,
      ssoGroups,
      displayName: profile.displayName || null,
      email: profile.email || null,
      lastLogin: new Date(),
      needsRoleReview: true,
    } as any,
    include: { role: true },
  });
}
