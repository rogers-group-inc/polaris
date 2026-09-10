/**
 * tests/integration/dashboardNocToken.test.ts
 *
 * Covers the bearer-token gate on GET /api/v1/dashboard/noc-summary.
 * The no-login NOC kiosk authenticates with an API token bound to a role
 * granting assets+events read; requirePermission/ensureRoleSnapshot resolve
 * the token's role matrix exactly like a session snapshot. A token whose
 * role grants neither still gets a 200 with the shape intact but every
 * section empty (filter-don't-403).
 *
 * Skips cleanly when DATABASE_URL isn't reachable; see _helpers.ts.
 */

import { it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import request from "supertest";
import { app } from "../../src/app.js";
import { prisma } from "../../src/db.js";
import { dbDescribe, dbReachable } from "./_helpers.js";
import { createToken } from "../../src/services/apiTokenService.js";
import { createRole, deleteRole } from "../../src/services/roleService.js";

const d = dbDescribe;

const NOC_ROLE = "test-noc-kiosk";
const NONE_ROLE = "test-noc-none";
const roleIds: string[] = [];

// Cleanup is scoped to THIS suite's rows (name prefixes) — vitest runs test
// files in parallel workers against the same DB, so a blanket deleteMany here
// would yank another suite's tokens/assets out from under it mid-run.
const TOKEN_NAME_PREFIX = "noc-kiosk-test-";

beforeAll(async () => {
  if (!dbReachable) return;
  await prisma.$connect();
  await prisma.apiToken.deleteMany({ where: { name: { startsWith: TOKEN_NAME_PREFIX } } });
  await prisma.role.deleteMany({ where: { name: { in: [NOC_ROLE, NONE_ROLE] } } });
  const noc = await createRole({
    name: NOC_ROLE,
    permissions: { assets: "read", events: "read" },
  });
  const none = await createRole({ name: NONE_ROLE, permissions: {} });
  roleIds.push(noc.id, none.id);
});

afterAll(async () => {
  if (!dbReachable) return;
  await prisma.apiToken.deleteMany({ where: { name: { startsWith: TOKEN_NAME_PREFIX } } });
  for (const id of roleIds) await deleteRole(id).catch(() => {});
  await prisma.$disconnect();
});

beforeEach(async () => {
  if (!dbReachable) return;
  await prisma.apiToken.deleteMany({ where: { name: { startsWith: TOKEN_NAME_PREFIX } } });
  await prisma.asset.deleteMany({ where: { hostname: "down-fw-01" } });
  // One monitored, down, non-suppressed firewall — surfaces in statusCounts.down
  // and downNodes when (and only when) the caller is granted the asset section.
  await prisma.asset.create({
    data: {
      hostname: "down-fw-01",
      assetType: "firewall",
      status: "active",
      monitored: true,
      monitorStatus: "down",
    },
  });
});

async function mintToken(roleName: string): Promise<string> {
  const role = await prisma.role.findUnique({ where: { name: roleName } });
  if (!role) throw new Error(`test role ${roleName} missing`);
  const { rawToken } = await createToken({
    name: `${TOKEN_NAME_PREFIX}${roleName}`,
    roleId: role.id,
    createdBy: "integration-test",
  });
  return rawToken;
}

d("GET /api/v1/dashboard/noc-summary — bearer token role gate", () => {
  it("a token bound to an assets+events-read role gets populated sections", async () => {
    const raw = await mintToken(NOC_ROLE);
    const res = await request(app)
      .get("/api/v1/dashboard/noc-summary")
      .set("Authorization", `Bearer ${raw}`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("statusCounts");
    expect(res.body.statusCounts.down).toBeGreaterThanOrEqual(1);
    expect(res.body.activeAlertCount).toBeGreaterThanOrEqual(1);
    expect(res.body.downNodes.map((n: { hostname: string }) => n.hostname)).toContain("down-fw-01");
  });

  it("the same token can read /filter-options (types + regions)", async () => {
    const raw = await mintToken(NOC_ROLE);
    const res = await request(app)
      .get("/api/v1/dashboard/filter-options")
      .set("Authorization", `Bearer ${raw}`);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.assetTypes)).toBe(true);
    // {name, label} entries — the label is what the gear grid shows, which is
    // how an operator-added type gets a readable checkbox.
    expect(res.body.assetTypes).toEqual(
      expect.arrayContaining([{ name: "firewall", label: expect.any(String) }]), // the seeded down-fw-01
    );
    expect(Array.isArray(res.body.regions)).toBe(true);
  });

  it("a token bound to a no-permission role gets the shape but empty sections", async () => {
    const raw = await mintToken(NONE_ROLE);
    const res = await request(app)
      .get("/api/v1/dashboard/noc-summary")
      .set("Authorization", `Bearer ${raw}`);

    expect(res.status).toBe(200);
    expect(res.body.statusCounts).toEqual({
      total: 0, up: 0, down: 0, warning: 0, unknown: 0, recovering: 0, passive: 0, maintenance: 0,
    });
    expect(res.body.activeAlertCount).toBe(0);
    expect(res.body.downNodes).toEqual([]);
    expect(res.body.sitesWithIssues).toEqual([]);
  });
});
