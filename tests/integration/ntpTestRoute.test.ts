/**
 * tests/integration/ntpTestRoute.test.ts
 *
 * POST /api/v1/server-settings/ntp/test end to end: the body is validated
 * (a host name or address per entry, at most ten), and a server that cannot
 * answer is reported as a failure — until 2026-11-11 every server "synchronized"
 * with an invented offset. 192.0.2.1 is TEST-NET-1: nothing answers there, so
 * the real query either times out (3 s) or fails to send; both are `ok: false`.
 *
 * Skips cleanly when DATABASE_URL isn't reachable; see _helpers.ts.
 */

import { it, expect, beforeAll } from "vitest";
import { app } from "../../src/app.js";
import { authedAgent, dbDescribe, ensureTestUser } from "./_helpers.js";

dbDescribe("POST /server-settings/ntp/test", () => {
  beforeAll(async () => { await ensureTestUser(); });

  it("refuses an entry that is not a host, and more than ten servers", async () => {
    const { agent, csrf } = await authedAgent(app);
    const post = (body: unknown) => agent.post("/api/v1/server-settings/ntp/test").set("x-csrf-token", csrf).send(body);
    expect((await post({ mode: "ntp", servers: ["http://time.example/x"] })).status).toBe(400);
    expect((await post({ mode: "ntp", servers: Array.from({ length: 11 }, (_, i) => `t${i}.example`) })).status).toBe(400);
    expect((await post({ mode: "chrony", servers: ["a.example"] })).status).toBe(400);
  });

  it("reports a server that cannot answer as a failure, never as synchronized", async () => {
    const { agent, csrf } = await authedAgent(app);
    const res = await agent.post("/api/v1/server-settings/ntp/test").set("x-csrf-token", csrf).send({ mode: "ntp", servers: ["192.0.2.1"] });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(false);
    expect(res.body.results).toEqual([expect.objectContaining({ server: "192.0.2.1", ok: false })]);
    expect(res.body.message).not.toMatch(/Synchronized/);
  }, 15_000);
});
