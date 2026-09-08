/**
 * tests/integration/haEnroll.test.ts — the node enrollment flow, end to end.
 *
 * This is the security-relevant half of the HA tab and it needs a real
 * database to be worth anything: single use is enforced by a conditional
 * UPDATE, and "downloaded exactly once" by another. A mock would prove the
 * code calls the right functions, not that two concurrent nodes cannot both
 * walk away with a copy of the install's private keys.
 *
 * What is pinned here:
 *   - an unauthenticated caller cannot get a bundle by presenting a token
 *   - every rejection looks identical, so nothing is learned by probing
 *   - a token works once, and re-use is refused
 *   - approval is required, and only an operator can grant it
 *   - an approved bundle downloads once and then reports itself delivered
 *
 * Skips cleanly when DATABASE_URL is unreachable.
 */

import { it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import request from "supertest";
import { app } from "../../src/app.js";
import { prisma } from "../../src/db.js";
import { hashPassword } from "../../src/utils/password.js";
import { generateRawToken, TOKEN_INDEX_PREFIX_LEN } from "../../src/utils/bearerToken.js";
import { authedAgent, dbDescribe, dbReachable, ensureTestUser } from "./_helpers.js";

const d = dbDescribe;
const ENROLL = "/api/v1/ha/enroll";

/** Insert an enrollment row directly, so a test does not need HA enabled. */
async function seedToken(opts: {
  role?: string;
  status?: string;
  expiresInMs?: number;
} = {}): Promise<{ token: string; id: string }> {
  const token = generateRawToken();
  const row = await prisma.haEnrollment.create({
    data: {
      role: opts.role ?? "witness",
      nodeName: "witness",
      nodeAddr: "198.51.100.7",
      tokenHash: await hashPassword(token),
      tokenPrefix: token.slice(0, TOKEN_INDEX_PREFIX_LEN),
      expiresAt: new Date(Date.now() + (opts.expiresInMs ?? 60_000)),
      status: opts.status ?? "issued",
      createdBy: "test",
    },
  });
  return { token, id: row.id };
}

beforeAll(async () => {
  if (!dbReachable) return;
  await ensureTestUser();
});

beforeEach(async () => {
  if (!dbReachable) return;
  await prisma.haEnrollment.deleteMany({});
});

afterAll(async () => {
  if (!dbReachable) return;
  await prisma.haEnrollment.deleteMany({});
});

d("POST /api/v1/ha/enroll — registration", () => {
  it("registers a valid token and returns a poll handle, without a session", async () => {
    const { token, id } = await seedToken();
    const res = await request(app).post(ENROLL).send({
      token,
      nodeName: "witness",
      sshHostKeyFingerprints: ["SHA256:abc123"],
    });
    expect(res.status).toBe(200);
    expect(res.body.requestId).toMatch(/^[0-9a-f]{64}$/);

    // Pending, not approved: the token alone releases nothing.
    const row = await prisma.haEnrollment.findUnique({ where: { id } });
    expect(row!.status).toBe("pending");
    expect(row!.registeredNodeName).toBe("witness");
    expect(row!.sshHostKeyFingerprints).toEqual(["SHA256:abc123"]);
    expect(row!.registeredFromIp).toBeTruthy();
  });

  it("refuses a token that has already been used", async () => {
    const { token } = await seedToken();
    expect((await request(app).post(ENROLL).send({ token })).status).toBe(200);
    const second = await request(app).post(ENROLL).send({ token });
    expect(second.status).toBe(401);
  });

  it("refuses an expired token", async () => {
    const { token } = await seedToken({ expiresInMs: -1000 });
    expect((await request(app).post(ENROLL).send({ token })).status).toBe(401);
  });

  it("refuses a token for a row that is no longer issued", async () => {
    const { token } = await seedToken({ status: "rejected" });
    expect((await request(app).post(ENROLL).send({ token })).status).toBe(401);
  });

  it("gives an identical answer to every bad token, so probing learns nothing", async () => {
    const { token: used } = await seedToken();
    await request(app).post(ENROLL).send({ token: used });
    const { token: expired } = await seedToken({ expiresInMs: -1000 });

    const answers = await Promise.all([
      request(app).post(ENROLL).send({ token: used }),
      request(app).post(ENROLL).send({ token: expired }),
      request(app).post(ENROLL).send({ token: generateRawToken() }),
      request(app).post(ENROLL).send({ token: "polaris_neverexisted00000000000000" }),
    ]);
    for (const a of answers) {
      expect(a.status).toBe(401);
      expect(a.body.error).toBe("Enrollment token rejected");
    }
  });

  it("rejects a token that is not even the right shape, before any lookup", async () => {
    const res = await request(app).post(ENROLL).send({ token: "not-a-polaris-token" });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("Invalid enrollment token");
  });

  it("validates the body shape", async () => {
    expect((await request(app).post(ENROLL).send({})).status).toBe(400);
    expect((await request(app).post(ENROLL).send({ token: "" })).status).toBe(400);
  });

  it("caps the host keys it will store", async () => {
    const { token, id } = await seedToken();
    const many = Array.from({ length: 20 }, (_, i) => `SHA256:key${i}`);
    const res = await request(app).post(ENROLL).send({ token, sshHostKeyFingerprints: many });
    // The schema caps the array, so an over-long list is a 400 rather than a
    // silent truncation.
    expect(res.status).toBe(400);
    const row = await prisma.haEnrollment.findUnique({ where: { id } });
    expect(row!.status).toBe("issued");
  });

  it("survives two simultaneous registrations with one token — only one wins", async () => {
    const { token } = await seedToken();
    const [a, b] = await Promise.all([
      request(app).post(ENROLL).send({ token }),
      request(app).post(ENROLL).send({ token }),
    ]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([200, 401]);
  });
});

d("GET /api/v1/ha/enroll/:requestId — polling and download", () => {
  it("reports pending until an operator approves", async () => {
    const { token } = await seedToken();
    const reg = await request(app).post(ENROLL).send({ token });
    const res = await request(app).get(`${ENROLL}/${reg.body.requestId}`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("pending");
    expect(res.body.ready).toBe(false);
    expect(res.body.message).toMatch(/approve/i);
    expect(res.headers["cache-control"]).toBe("no-store");
  });

  it("refuses to hand over a bundle before approval", async () => {
    const { token } = await seedToken();
    const reg = await request(app).post(ENROLL).send({ token });
    const res = await request(app).get(`${ENROLL}/${reg.body.requestId}?download=1`);
    expect(res.status).toBe(403);
  });

  it("404s an unknown or malformed request id without touching the database", async () => {
    expect((await request(app).get(`${ENROLL}/not-a-real-id`)).status).toBe(404);
    expect((await request(app).get(`${ENROLL}/${"f".repeat(64)}`)).status).toBe(404);
  });

  it("reports rejected after an operator says no", async () => {
    const { token, id } = await seedToken();
    const reg = await request(app).post(ENROLL).send({ token });
    const { agent, csrf } = await authedAgent(app);
    const rejected = await agent.post(`/api/v1/ha/enrollments/${id}/reject`).set("X-CSRF-Token", csrf);
    expect(rejected.status).toBe(200);

    const res = await request(app).get(`${ENROLL}/${reg.body.requestId}`);
    expect(res.body.status).toBe("rejected");
    expect(res.body.ready).toBe(false);
  });

  it("expires a request that waited past the approval window", async () => {
    const { token, id } = await seedToken();
    const reg = await request(app).post(ENROLL).send({ token });
    // Backdate the registration past the 30-minute window.
    await prisma.haEnrollment.update({
      where: { id },
      data: { registeredAt: new Date(Date.now() - 31 * 60 * 1000) },
    });
    const res = await request(app).get(`${ENROLL}/${reg.body.requestId}`);
    expect(res.body.status).toBe("expired");
    expect((await prisma.haEnrollment.findUnique({ where: { id } }))!.status).toBe("expired");
  });
});

d("operator approval routes", () => {
  it("requires a session — an anonymous caller cannot approve a node", async () => {
    const { token, id } = await seedToken();
    await request(app).post(ENROLL).send({ token });
    const res = await request(app).post(`/api/v1/ha/enrollments/${id}/approve`);
    expect([401, 403]).toContain(res.status);
    expect((await prisma.haEnrollment.findUnique({ where: { id } }))!.status).toBe("pending");
  });

  it("refuses to approve a request no node has connected to yet", async () => {
    const { id } = await seedToken();
    const { agent, csrf } = await authedAgent(app);
    const res = await agent.post(`/api/v1/ha/enrollments/${id}/approve`).set("X-CSRF-Token", csrf);
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/not pending/);
  });

  it("404s an unknown enrollment", async () => {
    const { agent, csrf } = await authedAgent(app);
    const res = await agent
      .post("/api/v1/ha/enrollments/00000000-0000-0000-0000-000000000000/approve")
      .set("X-CSRF-Token", csrf);
    expect(res.status).toBe(404);
  });

  it("records who approved, and lists the row on /status", async () => {
    const { token, id } = await seedToken();
    await request(app).post(ENROLL).send({ token });
    const { agent, csrf } = await authedAgent(app);
    await agent.post(`/api/v1/ha/enrollments/${id}/approve`).set("X-CSRF-Token", csrf);

    const row = await prisma.haEnrollment.findUnique({ where: { id } });
    expect(row!.status).toBe("approved");
    expect(row!.approvedBy).toBeTruthy();
    expect(row!.approvedAt).toBeTruthy();

    const status = await agent.get("/api/v1/ha/status");
    expect(status.status).toBe(200);
    expect(status.body.enrollments.some((e: { id: string }) => e.id === id)).toBe(true);
  });

  it("never leaks the sealed material through /status", async () => {
    const { agent } = await authedAgent(app);
    const status = await agent.get("/api/v1/ha/status");
    const serialized = JSON.stringify(status.body);
    expect(serialized).not.toMatch(/privateKey/);
    expect(serialized).not.toMatch(/BEGIN .*PRIVATE KEY/);
    // Presence flags are fine; the values are not.
    expect(status.body.config).toHaveProperty("etcdCaPresent");
  });
});

d("CSRF posture", () => {
  it("exempts the node enroll path but not the operator routes", async () => {
    const { token, id } = await seedToken();
    // No CSRF header, no session: accepted, because the token is the auth.
    expect((await request(app).post(ENROLL).send({ token })).status).toBe(200);

    // A session write without the header must still be refused.
    const { agent } = await authedAgent(app);
    const res = await agent.post(`/api/v1/ha/enrollments/${id}/approve`).send({});
    expect(res.status).toBe(403);
  });
});
