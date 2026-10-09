/**
 * tests/integration/serverRestartContainer.test.ts
 *
 * POST /server-settings/restart refuses inside a container. There is no
 * systemd there, so restartService() falls through to a plain exit, and a
 * container whose restart policy is "no" (Unraid's default) stays stopped —
 * which is how a Capacity Advisor "Restart Polaris to apply" click took an
 * Unraid install down. The operator restarts the container instead; the
 * advisor GET carries `runtimeIsContainer` so the card can say so.
 *
 * Only the container branch is exercised: the non-container branch really
 * exits the process.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

const h = vi.hoisted(() => ({ restartService: vi.fn() }));

vi.mock("../../src/utils/deploymentContext.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/utils/deploymentContext.js")>()),
  runtimeIsContainer: () => true,
}));

vi.mock("../../src/services/updateService.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/services/updateService.js")>()),
  restartService: h.restartService,
}));

import { app } from "../../src/app.js";
import { prisma } from "../../src/db.js";
import { authedAgent, dbReachable, dbDescribe, ensureTestUser } from "./_helpers.js";

const d = dbDescribe;

beforeAll(async () => {
  if (!dbReachable) return;
  await prisma.$connect();
  await ensureTestUser();
});

afterAll(async () => {
  if (!dbReachable) return;
  await prisma.$disconnect();
});

d("POST /api/v1/server-settings/restart in a container", () => {
  it("refuses with 409 and never calls restartService", async () => {
    const { agent, csrf } = await authedAgent(app);
    const res = await agent
      .post("/api/v1/server-settings/restart")
      .set("X-CSRF-Token", csrf)
      .send({});
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/container/i);
    // restartService is scheduled 500ms after the response on the allowed
    // path; wait past that so a regression can't slip by on timing.
    await new Promise((r) => setTimeout(r, 700));
    expect(h.restartService).not.toHaveBeenCalled();
  });
});

d("GET /api/v1/server-settings/capacity-advisor in a container", () => {
  it("reports runtimeIsContainer so the card drops its restart button", async () => {
    const { agent } = await authedAgent(app);
    const res = await agent.get("/api/v1/server-settings/capacity-advisor");
    expect(res.status).toBe(200);
    expect(res.body.runtimeIsContainer).toBe(true);
  });
});
