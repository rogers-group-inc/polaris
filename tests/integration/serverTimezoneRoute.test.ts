/**
 * tests/integration/serverTimezoneRoute.test.ts
 *
 * GET / PUT /api/v1/server-settings/timezone end to end (business rule 170):
 * a saved zone is stored, applied to this process at once and audited; an
 * unknown zone is a 400; null puts the host's zone back. Restores the host
 * zone afterwards so no other suite runs in Tokyo.
 *
 * Skips cleanly when DATABASE_URL isn't reachable; see _helpers.ts.
 */

import { it, expect, beforeAll, afterAll } from "vitest";
import { app } from "../../src/app.js";
import { prisma } from "../../src/db.js";
import { applyProcessTimezone } from "../../src/services/serverSettingsService.js";
import { authedAgent, dbDescribe, ensureTestUser } from "./_helpers.js";

const zoneNow = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

dbDescribe("/server-settings/timezone", () => {
  const host = zoneNow();
  const other = host === "Asia/Tokyo" ? "America/Chicago" : "Asia/Tokyo";

  beforeAll(async () => {
    await ensureTestUser();
    await prisma.setting.deleteMany({ where: { key: "timezone" } });
  });

  afterAll(async () => {
    await prisma.setting.deleteMany({ where: { key: "timezone" } });
    applyProcessTimezone(null);
  });

  it("with nothing saved, the server runs in the host's zone", async () => {
    const { agent } = await authedAgent(app);
    const res = await agent.get("/api/v1/server-settings/timezone");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ override: null, effective: host, host });
  });

  it("an unknown zone is refused and nothing changes", async () => {
    const { agent, csrf } = await authedAgent(app);
    const res = await agent.put("/api/v1/server-settings/timezone").set("x-csrf-token", csrf).send({ override: "Mars/Olympus" });
    expect(res.status).toBe(400);
    expect(zoneNow()).toBe(host);
  });

  it("a saved zone is stored, applied to this process and audited; null clears it", async () => {
    const { agent, csrf } = await authedAgent(app);
    const put = (override: string | null) =>
      agent.put("/api/v1/server-settings/timezone").set("x-csrf-token", csrf).send({ override });

    const set = await put(other);
    expect(set.status).toBe(200);
    expect(set.body).toEqual({ override: other, effective: other, host });
    expect(zoneNow()).toBe(other);
    expect((await prisma.setting.findUnique({ where: { key: "timezone" } }))?.value).toEqual({ override: other });
    const ev = await prisma.event.findFirst({ where: { action: "server.timezone.changed" }, orderBy: { timestamp: "desc" } });
    expect(ev?.message).toContain(other);

    const cleared = await put(null);
    expect(cleared.body).toEqual({ override: null, effective: host, host });
    expect(zoneNow()).toBe(host);
  });
});
