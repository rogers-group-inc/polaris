/**
 * tests/integration/credentialTestRateLimit.test.ts — `POST /credentials/test`
 * carries its own limiter.
 *
 * The endpoint logs in to a device with whatever secret the body carries, so
 * without a ceiling it is a password-guessing oracle against the fleet for any
 * session that may test credentials (CodeQL js/missing-rate-limiting,
 * 2026-09-28). An empty body is refused by validation before any device I/O,
 * and still spends the budget — the limiter runs first — so the case needs no
 * device and no credential row.
 */

import { it, expect, beforeAll } from "vitest";
import { app } from "../../src/app.js";
import { authedAgent, dbDescribe, ensureTestUser } from "./_helpers.js";

dbDescribe("credential test is rate limited", () => {
  beforeAll(async () => {
    await ensureTestUser();
  });

  it("refuses the 61st call in the window with a 429", async () => {
    const { agent, csrf } = await authedAgent(app, { fresh: true });
    for (let i = 0; i < 60; i++) {
      const res = await agent.post("/api/v1/credentials/test").set("X-CSRF-Token", csrf).send({});
      expect(res.status, `call ${i + 1} was rate limited too early`).toBe(400);
    }
    const spent = await agent.post("/api/v1/credentials/test").set("X-CSRF-Token", csrf).send({});
    expect(spent.status).toBe(429);
  });
});
