/**
 * tests/integration/automationMessageExample.test.ts
 *
 * POST /api/v1/automations/message-example — the wizard's In-app Alert example:
 * the draft's message rendered for ONE of its own devices (the one asked for,
 * or a random pick), with every token's value for that device.
 */

import { afterAll, beforeAll, expect, it } from "vitest";
import { app } from "../../src/app.js";
import { prisma } from "../../src/db.js";
import { authedAgent, dbDescribe, dbReachable, ensureTestUser } from "./_helpers.js";

const d = dbDescribe;
const TAG = "it-msg-example";
const A = "msg-example-it-a";
const B = "msg-example-it-b";
const OUTSIDE = "msg-example-it-outside";
let aId = "";
let bId = "";
let outsideId = "";

const scope = { condition: { op: "and", children: [{ field: "tag", operator: "has", value: TAG }] } };
const trigger = { type: "asset_state", field: "monitorStatus", operator: "==", value: "down" };

async function cleanup(): Promise<void> {
  await prisma.asset.deleteMany({ where: { hostname: { in: [A, B, OUTSIDE] } } });
}

beforeAll(async () => {
  if (!dbReachable) return;
  await ensureTestUser();
  await cleanup();
  const base = { assetType: "switch", status: "active", monitored: true, monitorStatus: "up" };
  aId = (await prisma.asset.create({ data: { ...base, hostname: A, ipAddress: "10.78.0.1", tags: [TAG], model: "FS-148F" } as never })).id;
  bId = (await prisma.asset.create({ data: { ...base, hostname: B, ipAddress: "10.78.0.2", tags: [TAG] } as never })).id;
  outsideId = (await prisma.asset.create({ data: { ...base, hostname: OUTSIDE, ipAddress: "10.78.0.3" } as never })).id;
});

afterAll(async () => {
  if (!dbReachable) return;
  try { await cleanup(); } catch { /* noop */ }
});

d("automation in-app message example", () => {
  it("renders the template for the device asked for, with its token values", async () => {
    const { agent, csrf } = await authedAgent(app);
    const res = await agent.post("/api/v1/automations/message-example").set("X-CSRF-Token", csrf).send({
      rule: { name: "IT example", severity: "critical", scope, trigger, messageTemplate: "{asset} ({asset.model}) at {asset.ip} is {value}" },
      assetId: aId,
    });
    expect(res.status).toBe(200);
    expect(res.body.asset).toEqual({ id: aId, hostname: A });
    expect(res.body.message).toBe(`${A} (FS-148F) at 10.78.0.1 is up`);
    expect(res.body.values["asset.ip"]).toBe("10.78.0.1");
    expect(res.body.values["rule"]).toBe("IT example");
    expect(res.body.severity).toBe("critical");
    // Deferred tokens are filled at delivery, so the example has no value for them.
    expect(res.body.values).not.toHaveProperty("ack");
    const ids = res.body.candidates.map((c: { id: string }) => c.id).sort();
    expect(ids).toEqual([aId, bId].sort());
  });

  it("picks one of the draft's own devices when none, or an out-of-scope one, is named", async () => {
    const { agent, csrf } = await authedAgent(app);
    for (const assetId of [undefined, outsideId]) {
      const res = await agent.post("/api/v1/automations/message-example").set("X-CSRF-Token", csrf).send({
        rule: { name: "IT example", scope, trigger },
        assetId,
      });
      expect(res.status).toBe(200);
      expect([aId, bId]).toContain(res.body.asset.id);
    }
  });

  it("uses the engine's default wording when the template is blank", async () => {
    const { agent, csrf } = await authedAgent(app);
    const res = await agent.post("/api/v1/automations/message-example").set("X-CSRF-Token", csrf).send({
      rule: { name: "IT example", scope, trigger, messageTemplate: "" },
      assetId: bId,
    });
    expect(res.status).toBe(200);
    expect(res.body.message).toBe(`IT example: ${B} — monitorStatus = up (threshold down)`);
  });
});
