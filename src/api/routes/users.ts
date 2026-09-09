/**
 * src/api/routes/users.ts — User management (list, create, reset password, delete)
 *
 * Role identity is referenced by `roleId` (FK → Role). Every user-returning
 * response includes `role: { id, name }` so the frontend renders the badge
 * from a single field. Role assignment goes through PUT /:id/role with
 * `{ roleId }`. Region tag assignment goes through PUT /:id/regions with
 * `{ regionTags }` (admin operator-driven; effective region set for a
 * session is union(role.regionTags, user.regionTags)).
 *
 * `lastAdminEquivalent` invariant: any operation that would leave Polaris
 * with zero users holding an admin-equivalent role (`users=fullwrite` AND
 * `roles=fullwrite`) is refused with 409.
 */

import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../db.js";
import { AppError } from "../../utils/errors.js";
import { hashPassword } from "../../utils/password.js";
import { clearLockout } from "../../utils/loginLockout.js";
import {
  countAdminEquivalentUsers,
  isAdminEquivalentRole,
} from "../../services/roleService.js";
import { requirePermission, assertNoPrivilegeEscalation } from "../middleware/permissions.js";
import { normalizeTags } from "../../utils/tagNormalize.js";
import * as mfaPending from "../../utils/mfaPending.js";
import { logEvent } from "./events.js";

const router = Router();

const passwordSchema = z.string()
  .min(8, "Password must be at least 8 characters")
  .regex(/[a-z]/, "Password must contain a lowercase letter")
  .regex(/[A-Z]/, "Password must contain an uppercase letter")
  .regex(/[0-9]/, "Password must contain a number")
  .regex(/[^a-zA-Z0-9]/, "Password must contain a special character");

const RegionTagsSchema = z.array(z.string().max(64)).max(64);

const CreateUserSchema = z.object({
  username: z.string().min(1).max(64),
  password: passwordSchema,
  roleId:   z.string().uuid("roleId must be a UUID"),
  regionTags: RegionTagsSchema.optional(),
  otherTags: RegionTagsSchema.optional(),
});

const ResetPasswordSchema = z.object({
  password: passwordSchema,
});

const UpdateRoleSchema = z.object({
  roleId: z.string().uuid("roleId must be a UUID"),
});

const UpdateRegionsSchema = z.object({
  regionTags: RegionTagsSchema.optional(),
  otherTags: RegionTagsSchema.optional(),
});

const USER_LIST_SELECT = {
  id: true,
  username: true,
  authProvider: true,
  displayName: true,
  email: true,
  lastLogin: true,
  createdAt: true,
  updatedAt: true,
  totpEnabledAt: true,
  needsRoleReview: true,
  regionTags: true,
  otherTags: true,
  role: { select: { id: true, name: true, color: true, isProtected: true, isBuiltIn: true } },
} as const;

// GET /api/v1/users/role-review-notifications — sidebar badge feed
// Lists users whose `needsRoleReview` flag is currently set (i.e. completed
// their first login and an admin hasn't dismissed the notification yet).
// Mounted before "/" since Express matches in declaration order; "/" still
// works because "/role-review-notifications" only matches its exact path.
router.get("/role-review-notifications", async (_req, res, next) => {
  try {
    const rows = await prisma.user.findMany({
      where: { needsRoleReview: true },
      select: USER_LIST_SELECT,
      orderBy: { lastLogin: "asc" },
    });
    res.json({ users: rows, count: rows.length });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/v1/users/:id/role-review — dismiss the notification for one user
router.delete("/:id/role-review", requirePermission("users", "write"), async (req, res, next) => {
  try {
    const id = req.params.id as string;
    const user = await prisma.user.findUnique({
      where: { id },
      select: { id: true, needsRoleReview: true },
    });
    if (!user) throw new AppError(404, "User not found");
    if (user.needsRoleReview) {
      await prisma.user.update({ where: { id }, data: { needsRoleReview: false } });
    }
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/users
router.get("/", async (_req, res, next) => {
  try {
    const [users, onlineUserIds] = await Promise.all([
      prisma.user.findMany({
        select: USER_LIST_SELECT,
        orderBy: { username: "asc" },
      }),
      getOnlineUserIds(),
    ]);
    res.json(users.map((u) => {
      const { totpEnabledAt, ...rest } = u;
      return { ...rest, isOnline: onlineUserIds.has(u.id), totpEnabled: !!totpEnabledAt };
    }));
  } catch (err) {
    next(err);
  }
});

// Query the connect-pg-simple session store for non-expired sessions and
// extract their `userId`s. Returns an empty set if the session table does not
// yet exist (e.g. first boot before anyone has logged in).
async function getOnlineUserIds(): Promise<Set<string>> {
  try {
    const rows = await prisma.$queryRaw<{ sess: unknown }[]>`
      SELECT sess FROM session WHERE expire > NOW()
    `;
    const ids = new Set<string>();
    for (const row of rows) {
      const sess = row.sess as { userId?: unknown } | null;
      if (sess && typeof sess.userId === "string") ids.add(sess.userId);
    }
    return ids;
  } catch {
    return new Set();
  }
}

// POST /api/v1/users
router.post("/", requirePermission("users", "write"), async (req, res, next) => {
  try {
    const { username, password, roleId, regionTags, otherTags } = CreateUserSchema.parse(req.body);

    const [existing, role] = await Promise.all([
      prisma.user.findUnique({ where: { username } }),
      prisma.role.findUnique({ where: { id: roleId } }),
    ]);
    if (existing) throw new AppError(409, `User "${username}" already exists`);
    if (!role) throw new AppError(400, `Role ${roleId} not found`);
    // Rule 48: creating an account on an admin-equivalent role — with a
    // password the creator chooses — is the shortest path from users:write to
    // full control of the install.
    assertNoPrivilegeEscalation(req, role.permissions, `the role "${role.name}"`);

    const passwordHash = await hashPassword(password);
    const user = await prisma.user.create({
      data: {
        username,
        passwordHash,
        roleId: role.id,
        authProvider: "local",
        regionTags: normalizeTags(regionTags ?? [], "region tag"),
        otherTags: normalizeTags(otherTags ?? [], "tag"),
      },
      select: USER_LIST_SELECT,
    });
    logEvent({
      action: "user.created",
      resourceType: "user",
      resourceId: user.id,
      resourceName: user.username,
      actor: req.session?.username,
      message: `User "${user.username}" created with role "${role.name}"`,
    });
    res.status(201).json(user);
  } catch (err) {
    next(err);
  }
});

// PUT /api/v1/users/:id/password
router.put("/:id/password", requirePermission("users", "write"), async (req, res, next) => {
  try {
    const id = req.params.id as string;
    const { password } = ResetPasswordSchema.parse(req.body);
    const user = await prisma.user.findUnique({ where: { id } });
    if (!user) throw new AppError(404, "User not found");
    if (user.authProvider !== "local") throw new AppError(400, "Cannot reset password for SSO/LDAP accounts — credentials are managed by the identity provider.");

    const passwordHash = await hashPassword(password);
    await prisma.user.update({
      where: { id },
      data: { passwordHash },
    });
    clearLockout(user.username);
    // A pending TOTP challenge was minted against the OLD password — a
    // successful password step must not survive the reset.
    mfaPending.revokeForUser(id);
    logEvent({
      action: "user.password_reset",
      level: "warning",
      resourceType: "user",
      resourceId: id,
      resourceName: user.username,
      actor: req.session?.username,
      message: `Password reset for user "${user.username}" by an administrator`,
    });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// PUT /api/v1/users/:id/role — assign a new role
router.put("/:id/role", requirePermission("users", "write"), async (req, res, next) => {
  try {
    const id = req.params.id as string;
    const { roleId } = UpdateRoleSchema.parse(req.body);
    const [user, role] = await Promise.all([
      prisma.user.findUnique({ where: { id }, include: { role: true } }),
      prisma.role.findUnique({ where: { id: roleId } }),
    ]);
    if (!user) throw new AppError(404, "User not found");
    if (!role) throw new AppError(400, `Role ${roleId} not found`);

    // Prevent demoting yourself
    if (req.session?.userId === user.id) {
      throw new AppError(400, "You cannot change your own role");
    }

    // Rule 48: the self-check above is not an escalation guard — it only stops
    // you editing your OWN row. Promoting somebody else into an
    // admin-equivalent role is the same escalation by one extra step.
    assertNoPrivilegeEscalation(req, role.permissions, `the role "${role.name}"`);

    // lastAdminEquivalent invariant: refuse to move the last admin-equiv
    // user into a non-admin-equiv role.
    if (await isAdminEquivalentRole(user.roleId) && !(await isAdminEquivalentRole(role.id))) {
      const remaining = await countAdminEquivalentUsers(user.id);
      if (remaining === 0) {
        throw new AppError(409, "Cannot reassign — this is the last admin-equivalent account. Promote another user first.");
      }
    }

    const updated = await prisma.user.update({
      where: { id },
      data: { roleId: role.id, needsRoleReview: false },
      select: USER_LIST_SELECT,
    });
    logEvent({
      action: "user.role_changed",
      resourceType: "user",
      resourceId: user.id,
      resourceName: user.username,
      actor: req.session?.username,
      message: `Role for "${user.username}" changed from "${user.role.name}" to "${role.name}"`,
      details: { from: user.role.name, to: role.name },
    });
    res.json({ ok: true, user: updated });
  } catch (err) {
    next(err);
  }
});

// PUT /api/v1/users/:id/regions — set the user's region + other-tag scope
// (additive on top of the role's tags and any group-derived tags). Each field
// is optional; an empty array clears that dimension. These are operator-set
// tags only — group-derived tags are computed at /auth/me, never persisted.
router.put("/:id/regions", requirePermission("users", "write"), async (req, res, next) => {
  try {
    const id = req.params.id as string;
    const { regionTags, otherTags } = UpdateRegionsSchema.parse(req.body);
    const before = await prisma.user.findUnique({ where: { id }, select: { id: true, username: true, regionTags: true, otherTags: true } });
    if (!before) throw new AppError(404, "User not found");

    const data: { regionTags?: string[]; otherTags?: string[] } = {};
    const details: Record<string, unknown> = {};
    if (regionTags !== undefined) {
      data.regionTags = normalizeTags(regionTags, "region tag");
      details.regions = { from: before.regionTags, to: data.regionTags };
    }
    if (otherTags !== undefined) {
      data.otherTags = normalizeTags(otherTags, "tag");
      details.other = { from: before.otherTags, to: data.otherTags };
    }
    const updated = await prisma.user.update({ where: { id }, data, select: USER_LIST_SELECT });
    logEvent({
      action: "user.regions_updated",
      resourceType: "user",
      resourceId: updated.id,
      resourceName: updated.username,
      actor: req.session?.username,
      message: `Tag scope for "${updated.username}" updated`,
      details,
    });
    res.json({ ok: true, user: updated });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/v1/users/:id/totp — admin-initiated TOTP reset
// Used when a user lost their device and can't produce a backup code.
// Clears the secret + backup codes so the user can re-enroll on next login.
router.delete("/:id/totp", requirePermission("users", "write"), async (req, res, next) => {
  try {
    const id = req.params.id as string;
    const user = await prisma.user.findUnique({ where: { id } });
    if (!user) throw new AppError(404, "User not found");
    if (!user.totpEnabledAt && !user.totpSecret) {
      throw new AppError(400, "Two-factor auth is not configured for this user.");
    }

    await prisma.user.update({
      where: { id },
      data: { totpSecret: null, totpEnabledAt: null, totpBackupCodes: [] },
    });
    logEvent({
      action: "user.totp_reset",
      level: "warning",
      resourceType: "user",
      resourceId: id,
      resourceName: user.username,
      actor: req.session?.username,
      message: `Two-factor auth reset for user "${user.username}" by an administrator`,
    });

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/v1/users/:id
router.delete("/:id", requirePermission("users", "write"), async (req, res, next) => {
  try {
    const id = req.params.id as string;
    const user = await prisma.user.findUnique({ where: { id }, include: { role: true } });
    if (!user) throw new AppError(404, "User not found");

    // Prevent deleting yourself
    if (req.session?.userId === user.id) {
      throw new AppError(400, "You cannot delete your own account");
    }

    // lastAdminEquivalent invariant
    if (await isAdminEquivalentRole(user.roleId)) {
      const remaining = await countAdminEquivalentUsers(user.id);
      if (remaining === 0) {
        throw new AppError(409, "Cannot delete — this is the last admin-equivalent account. Promote another user first.");
      }
    }

    // Saved table filters are ownerId-SetNull so this user's PUBLIC presets
    // survive them (other operators are using those). Their private ones would
    // be orphaned rows nobody can ever see, so drop those first.
    await prisma.savedTableFilter.deleteMany({ where: { ownerId: id, visibility: "private" } });
    // Same rule for saved dashboards, for the same reason — a published one may
    // be on a wallboard right now, a private one is unreachable once its owner
    // is gone.
    await prisma.savedDashboard.deleteMany({ where: { ownerId: id, visibility: "private" } });

    await prisma.user.delete({ where: { id } });
    logEvent({
      action: "user.deleted",
      resourceType: "user",
      resourceId: user.id,
      resourceName: user.username,
      actor: req.session?.username,
      message: `User "${user.username}" deleted (was role "${user.role.name}")`,
    });
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

export default router;
