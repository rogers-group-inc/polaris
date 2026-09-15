/**
 * tests/integration/passkeyRoutes.test.ts
 *
 * The passkey and password-policy endpoints over the real app: who may reach
 * each one, and whether the source-IP login gate covers the new ways in.
 *
 * What is NOT here is a completed ceremony — verifying an assertion needs an
 * authenticator holding a private key, and a fixture signed against a fixed
 * challenge would only prove the fixture. passkeyService.test.ts covers the
 * decisions around verification with the library mocked; this file covers the
 * things only the assembled app can answer:
 *
 *   1. The gates. `/passkeys/config` and `/passkeys/login/*` are deliberately
 *      unauthenticated (a login page has no session), registration is not, and
 *      the policy PUTs are admin-only. An accidental `requireAuth` on the first
 *      group makes passkey sign-in impossible; a missing one on the last lets
 *      any reader weaken the install's password rules.
 *   2. The source-IP login gate covers the passkey paths. A passkey login is a
 *      local credential that issues a session outright — if app.ts's
 *      LOGIN_CREDENTIAL_PATHS misses it, an install that restricted local login
 *      to its own networks has a way in from anywhere, and nothing about the
 *      UI would show it.
 *
 * Skips cleanly when DATABASE_URL isn't reachable.
 */

import { it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import request from "supertest";
import { app } from "../../src/app.js";
import { prisma } from "../../src/db.js";
import { hashPassword } from "../../src/utils/password.js";
import {
  saveLoginAccessSettings,
  invalidateLoginAccessCache,
} from "../../src/services/loginAccessService.js";
import {
  savePasskeySettings,
  invalidatePasskeyCache,
  defaultPasskeySettings,
} from "../../src/services/passkeyService.js";
import {
  savePasswordPolicy,
  invalidatePasswordPolicyCache,
} from "../../src/services/passwordPolicyService.js";
import { defaultPasswordPolicy } from "../../src/utils/passwordPolicy.js";
import { dbDescribe, dbReachable, authedAgent } from "./_helpers.js";

const d = dbDescribe;

const READER = "polaris-passkey-reader";
const READER_PASSWORD = "Reader-Pass-1!";

async function setPasskeyMode(mode: "off" | "login" | "second-factor" | "both"): Promise<void> {
  await savePasskeySettings({ ...defaultPasskeySettings(), mode });
  invalidatePasskeyCache();
}

/** Blocked: loopback is outside a custom list holding only a TEST-NET address. */
async function blockLoopback(): Promise<void> {
  await saveLoginAccessSettings({ enabled: true, ipScope: "custom", allowedCidrs: ["203.0.113.99/32"] });
  invalidateLoginAccessCache();
}

async function allowEveryone(): Promise<void> {
  await saveLoginAccessSettings({ enabled: false, ipScope: "rfc1918", allowedCidrs: [] });
  invalidateLoginAccessCache();
}

beforeAll(async () => {
  if (!dbReachable) return;
  const role = await prisma.role.findUnique({ where: { name: "readonly" } });
  if (!role) throw new Error("built-in 'readonly' Role row missing — run `npx prisma migrate deploy` first");
  await prisma.user.deleteMany({ where: { username: READER } });
  await prisma.user.create({
    data: {
      username: READER,
      passwordHash: await hashPassword(READER_PASSWORD),
      roleId: role.id,
      authProvider: "local",
    },
  });
  await allowEveryone();
});

afterAll(async () => {
  if (!dbReachable) return;
  await allowEveryone();
  await setPasskeyMode("both");
  await savePasswordPolicy(defaultPasswordPolicy());
  invalidatePasswordPolicyCache();
  await prisma.user.deleteMany({ where: { username: READER } });
});

beforeEach(async () => {
  if (!dbReachable) return;
  await setPasskeyMode("both");
});

// supertest speaks to 127.0.0.1 over plain HTTP, and neither an IP literal nor
// a non-secure context can host a passkey — correctly, and the availability
// endpoint says so. Any request that needs the RP to actually RESOLVE sends
// Host: localhost, which is a secure context in every browser that implements
// WebAuthn and is exactly how the dev stack is reached.
const asLocalhost = (r: request.Test) => r.set("Host", "localhost");

d("GET /auth/passkeys/config", () => {
  it("answers WITHOUT a session — the login page has none", async () => {
    const res = await request(app).get("/api/v1/auth/passkeys/config");
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("loginEnabled");
    expect(res.body).toHaveProperty("secondFactorEnabled");
  });

  it("refuses an IP-address install and says why, rather than offering a dead button", async () => {
    // 127.0.0.1 is a supported way to reach Polaris and an impossible RP ID.
    const res = await request(app).get("/api/v1/auth/passkeys/config");
    expect(res.body.loginEnabled).toBe(false);
    expect(res.body.unavailableReason).toMatch(/domain name/);
    expect(res.body.rpId).toBeNull();
  });

  it("reports both entry points off once the mode is off", async () => {
    await setPasskeyMode("off");
    const res = await asLocalhost(request(app).get("/api/v1/auth/passkeys/config"));
    expect(res.body.loginEnabled).toBe(false);
    expect(res.body.secondFactorEnabled).toBe(false);
    // The mode is why, not the origin.
    expect(res.body.unavailableReason).toBeNull();
  });

  it("reports sign-in only under the 'login' mode", async () => {
    await setPasskeyMode("login");
    const res = await asLocalhost(request(app).get("/api/v1/auth/passkeys/config"));
    expect(res.body.loginEnabled).toBe(true);
    expect(res.body.secondFactorEnabled).toBe(false);
    expect(res.body.rpId).toBe("localhost");
  });

  it("discloses nothing about who is enrolled", async () => {
    const res = await asLocalhost(request(app).get("/api/v1/auth/passkeys/config"));
    expect(JSON.stringify(res.body)).not.toMatch(/user|account|credential/i);
  });
});

d("POST /auth/passkeys/login/options", () => {
  it("issues a challenge with no session and no CSRF token", async () => {
    // Both halves matter: a login page has neither, so an accidental
    // requireAuth OR a missing CSRF exemption makes passkey sign-in impossible.
    const res = await asLocalhost(request(app).post("/api/v1/auth/passkeys/login/options").send({}));
    expect(res.status).toBe(200);
    expect(res.body.token).toBeTruthy();
    expect(res.body.options.challenge).toBeTruthy();
  });

  it("names NO credentials — it must not be an account-enumeration oracle", async () => {
    const res = await asLocalhost(request(app).post("/api/v1/auth/passkeys/login/options").send({}));
    expect(res.body.options.allowCredentials).toBeUndefined();
  });

  it("refuses while the mode is second-factor only", async () => {
    await setPasskeyMode("second-factor");
    const res = await asLocalhost(request(app).post("/api/v1/auth/passkeys/login/options").send({}));
    expect(res.status).toBe(400);
  });

  it("refuses while passkeys are off", async () => {
    await setPasskeyMode("off");
    const res = await asLocalhost(request(app).post("/api/v1/auth/passkeys/login/options").send({}));
    expect(res.status).toBe(400);
  });
});

d("the CSRF exemption stops at the login pair", () => {
  // The exemption entry is `/api/v1/auth/passkeys/login`, matched on a segment
  // boundary. A bare prefix match would also exempt every route below —
  // registration and deletion, both mutating session routes — which is the
  // mistake the HA enrollment entry already made once.
  it("still demands a token on registration", async () => {
    const { agent } = await authedAgent(app);
    const res = await agent.post("/api/v1/auth/passkeys/register/options").send({});
    expect(res.status).toBe(403);
  });

  it("still demands a token on delete", async () => {
    const { agent } = await authedAgent(app);
    const res = await agent.delete("/api/v1/auth/passkeys/some-id").send({});
    expect(res.status).toBe(403);
  });
});

d("self-service registration", () => {
  it("requires a session to list", async () => {
    expect((await request(app).get("/api/v1/auth/passkeys")).status).toBe(401);
  });

  it("needs NO permission beyond being logged in — a reader manages their own", async () => {
    // The whole reason this lives off the account menu: /users.html is
    // admin-gated, so a gate here would leave ordinary users unable to enroll.
    const agent = request.agent(app);
    await agent.get("/api/v1/auth/me");
    const login = await agent.post("/api/v1/auth/login").send({ username: READER, password: READER_PASSWORD });
    expect(login.status).toBe(200);
    const res = await agent.get("/api/v1/auth/passkeys");
    expect(res.status).toBe(200);
    expect(res.body.passkeys).toEqual([]);
    expect(res.body.authProvider).toBe("local");
  });
});

d("GET /auth/password-policy", () => {
  it("answers without a session — the login page's forced-change step needs it", async () => {
    const res = await request(app).get("/api/v1/auth/password-policy");
    expect(res.status).toBe(200);
    expect(res.body.policy.minLength).toBeGreaterThanOrEqual(8);
    expect(res.body.rules.map((r: { key: string }) => r.key)).toContain("length");
    expect(res.body.limits.minLengthFloor).toBe(8);
  });

  it("returns labels that match the configured minimum", async () => {
    await savePasswordPolicy({ ...defaultPasswordPolicy(), minLength: 15 });
    invalidatePasswordPolicyCache();
    const res = await request(app).get("/api/v1/auth/password-policy");
    expect(res.body.rules[0].label).toBe("At least 15 characters");
    await savePasswordPolicy(defaultPasswordPolicy());
    invalidatePasswordPolicyCache();
  });
});

d("the admin-only writes", () => {
  // Refused with 403 rather than 401: these are session routes, so CSRF
  // answers before requireAuth ever runs. What is being pinned is that an
  // anonymous caller cannot change them, not which of the two guards spoke.
  it("refuses an unauthenticated password-policy write", async () => {
    const res = await request(app).put("/api/v1/auth/password-policy").send({ minLength: 8 });
    expect(res.status).toBe(403);
  });

  it("refuses an unauthenticated passkey-settings write", async () => {
    const res = await request(app).put("/api/v1/auth/passkey-settings").send({ mode: "off" });
    expect(res.status).toBe(403);
  });

  it("refuses a READER's password-policy write — weakening the bar is admin work", async () => {
    const agent = request.agent(app);
    await agent.get("/api/v1/auth/me");
    await agent.post("/api/v1/auth/login").send({ username: READER, password: READER_PASSWORD });
    await agent.get("/api/v1/auth/me");
    const cookies = (agent.jar as never as { getCookies: (o: unknown) => { name: string; value: string }[] })
      .getCookies({ domain: "127.0.0.1", path: "/", secure: false, script: false });
    const csrf = (cookies.find((c) => c.name === "polaris_csrf") || { value: "" }).value;
    const res = await agent
      .put("/api/v1/auth/password-policy")
      .set("X-CSRF-Token", csrf)
      .send({ minLength: 8, requireSpecial: false });
    expect(res.status).toBe(403);
  });

  it("lets an admin save both, and writes an audit Event for each", async () => {
    const { agent, csrf } = await authedAgent(app);
    const policy = await agent
      .put("/api/v1/auth/password-policy")
      .set("X-CSRF-Token", csrf)
      .send({ minLength: 12 });
    expect(policy.status).toBe(200);
    expect(policy.body.policy.minLength).toBe(12);

    const passkeys = await agent
      .put("/api/v1/auth/passkey-settings")
      .set("X-CSRF-Token", csrf)
      .send({ mode: "second-factor" });
    expect(passkeys.status).toBe(200);
    expect(passkeys.body.settings.mode).toBe("second-factor");

    await new Promise((r) => setTimeout(r, 200));
    expect(await prisma.event.count({ where: { action: "password_policy.updated" } })).toBeGreaterThan(0);
    expect(await prisma.event.count({ where: { action: "passkey_settings.updated" } })).toBeGreaterThan(0);

    await savePasswordPolicy(defaultPasswordPolicy());
    invalidatePasswordPolicyCache();
  });

  it("clamps a minimum length below the floor at the route", async () => {
    const { agent, csrf } = await authedAgent(app);
    const res = await agent.put("/api/v1/auth/password-policy").set("X-CSRF-Token", csrf).send({ minLength: 2 });
    expect(res.status).toBe(400);
  });
});

d("the source-IP login gate covers the passkey paths", () => {
  afterAll(async () => {
    if (!dbReachable) return;
    await allowEveryone();
  });

  it("blocks the passwordless options call from an out-of-scope source", async () => {
    // Without this the restriction is decorative: /passkeys/login issues a
    // session outright, with no password step in front of it for the gate to
    // have caught.
    await blockLoopback();
    const res = await asLocalhost(request(app).post("/api/v1/auth/passkeys/login/options").send({}));
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("Invalid username or password");
  });

  it("blocks the passwordless verify from an out-of-scope source", async () => {
    await blockLoopback();
    const res = await asLocalhost(request(app).post("/api/v1/auth/passkeys/login").send({ token: "x", response: {} }));
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("Invalid username or password");
  });

  it("blocks the second-factor step too, so a login cannot be resumed from elsewhere", async () => {
    await blockLoopback();
    const res = await asLocalhost(
      request(app).post("/api/v1/auth/login/passkey").send({ pendingToken: "x", token: "y", response: {} }),
    );
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("Invalid username or password");
  });

  it("blocks the forced password-change step", async () => {
    await blockLoopback();
    const res = await asLocalhost(
      request(app)
        .post("/api/v1/auth/login/password-change")
        .send({ pendingToken: "x", newPassword: "Replacement-Pass-2!" }),
    );
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("Invalid username or password");
  });

  it("leaves the availability probe reachable — it is not a credential", async () => {
    // The login page still has to be able to say "passkeys are unavailable
    // here"; the probe reveals nothing about any account.
    await blockLoopback();
    const res = await asLocalhost(request(app).get("/api/v1/auth/passkeys/config"));
    expect(res.status).toBe(200);
  });
});
