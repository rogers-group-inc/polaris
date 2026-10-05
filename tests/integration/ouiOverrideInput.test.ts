/**
 * tests/integration/ouiOverrideInput.test.ts — POST /server-settings/oui/overrides input shape
 *
 * The override's prefix feeds a fleet-wide asset.updateMany ({ macAddress:
 * { startsWith } }), so a body field that isn't a plain string must be refused
 * as a 400 before anything reads it — it used to reach `.replace()` and come
 * back as a 500. Also pins the Express query parser: every Prisma `where` that
 * takes a query-string value relies on it never producing nested objects
 * (`?id[not]=x`), which only the "extended" parser does.
 *
 * Skips cleanly when DATABASE_URL isn't reachable.
 */

import { it, expect, beforeAll } from "vitest";
import { app } from "../../src/app.js";
import { authedAgent, dbDescribe, dbReachable, ensureTestUser } from "./_helpers.js";

const URL = "/api/v1/server-settings/oui/overrides";

beforeAll(async () => {
  if (!dbReachable) return;
  await ensureTestUser();
});

it("never parses query strings into nested objects", () => {
  expect(app.get("query parser")).not.toBe("extended");
});

dbDescribe("POST /server-settings/oui/overrides", () => {
  const rejects: Array<[string, unknown]> = [
    ["an object prefix", { prefix: { startsWith: "" }, manufacturer: "Acme" }],
    ["an array prefix", { prefix: ["AA:BB:CC"], manufacturer: "Acme" }],
    ["a numeric prefix", { prefix: 123456, manufacturer: "Acme" }],
    ["an object manufacturer", { prefix: "AA:BB:CC", manufacturer: { set: "x" } }],
    ["an object device", { prefix: "AA:BB:CC", manufacturer: "Acme", device: { set: "x" } }],
    ["a missing manufacturer", { prefix: "AA:BB:CC" }],
    ["a blank manufacturer", { prefix: "AA:BB:CC", manufacturer: "   " }],
    ["a missing prefix", { manufacturer: "Acme" }],
  ];

  for (const [label, body] of rejects) {
    it(`refuses ${label} with a 400`, async () => {
      const { agent, csrf } = await authedAgent(app);
      const res = await agent.post(URL).set("X-CSRF-Token", csrf).send(body as object);
      expect(res.status).toBe(400);
    });
  }

  it("still refuses a string prefix that isn't 6 hex characters", async () => {
    const { agent, csrf } = await authedAgent(app);
    const res = await agent.post(URL).set("X-CSRF-Token", csrf).send({ prefix: "ZZ:ZZ:ZZ", manufacturer: "Acme" });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toContain("6 hex characters");
  });

  it("accepts a well-formed override and trims its fields", async () => {
    const { agent, csrf } = await authedAgent(app);
    // A locally administered prefix no real asset carries.
    const res = await agent
      .post(URL)
      .set("X-CSRF-Token", csrf)
      .send({ prefix: "fe-ed-0a", manufacturer: "  Acme Test  ", device: "  Widget  " });
    try {
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ prefix: "FE:ED:0A", manufacturer: "Acme Test", device: "Widget" });
    } finally {
      await agent.delete(`${URL}/FE:ED:0A`).set("X-CSRF-Token", csrf);
    }
  });

  it("treats a null device as no device, as it did before the schema", async () => {
    const { agent, csrf } = await authedAgent(app);
    const res = await agent
      .post(URL)
      .set("X-CSRF-Token", csrf)
      .send({ prefix: "FE:ED:0B", manufacturer: "Acme Test", device: null });
    try {
      expect(res.status).toBe(200);
      expect(res.body.device).toBeUndefined();
    } finally {
      await agent.delete(`${URL}/FE:ED:0B`).set("X-CSRF-Token", csrf);
    }
  });
});
