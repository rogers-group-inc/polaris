/**
 * tests/unit/setupToken.test.ts
 *
 * The first-run wizard runs before any account exists, so it proves host access
 * with a one-time setup token instead (scan finding F178; business rule 108).
 * Every wizard route that acts on the host must refuse a request without it,
 * and the values the wizard writes into `.env` must not carry a line break.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express from "express";
import request from "supertest";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const { stateDir } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { mkdtempSync } = require("node:fs");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { tmpdir } = require("node:os");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { join } = require("node:path");
  return { stateDir: mkdtempSync(join(tmpdir(), "polaris-setup-token-")) as string };
});

vi.mock("../../src/utils/paths.js", async (orig) => {
  const real = await orig<typeof import("../../src/utils/paths.js")>();
  return { ...real, STATE_DIR: stateDir, ENV_FILE: join(stateDir, ".env") };
});
vi.mock("../../src/db.js", () => ({ prisma: {} }));

import {
  SETUP_TOKEN_FILE,
  currentSetupToken,
  discardSetupToken,
  loadOrCreateSetupToken,
  setupTokenMatches,
} from "../../src/setup/setupToken.js";
import setupRoutes from "../../src/setup/setupRoutes.js";

const savedEnv = process.env.POLARIS_SETUP_TOKEN;

beforeEach(() => {
  delete process.env.POLARIS_SETUP_TOKEN;
  discardSetupToken();
});
afterEach(() => {
  if (savedEnv === undefined) delete process.env.POLARIS_SETUP_TOKEN;
  else process.env.POLARIS_SETUP_TOKEN = savedEnv;
  discardSetupToken();
});

describe("setupTokenMatches", () => {
  it("accepts only the exact token", () => {
    expect(setupTokenMatches("abcdefghijklmnop", "abcdefghijklmnop")).toBe(true);
    expect(setupTokenMatches("abcdefghijklmnoq", "abcdefghijklmnop")).toBe(false);
    expect(setupTokenMatches("abcdefghijklmno", "abcdefghijklmnop")).toBe(false);
  });

  it("refuses values of any other type and the empty string", () => {
    for (const v of [undefined, null, 0, {}, [], ["abcdefghijklmnop"], ""]) {
      expect(setupTokenMatches(v, "abcdefghijklmnop")).toBe(false);
    }
  });
});

describe("loadOrCreateSetupToken", () => {
  it("creates a token, writes it to the state directory and reuses it after a restart", () => {
    const first = loadOrCreateSetupToken();
    expect(first.source).toBe("new");
    expect(first.token).toMatch(/^[A-Za-z0-9_-]{16,}$/);
    expect(existsSync(SETUP_TOKEN_FILE)).toBe(true);
    expect(readFileSync(SETUP_TOKEN_FILE, "utf8").trim()).toBe(first.token);

    const second = loadOrCreateSetupToken();
    expect(second.source).toBe("file");
    expect(second.token).toBe(first.token);
  });

  it("prefers a valid POLARIS_SETUP_TOKEN", () => {
    process.env.POLARIS_SETUP_TOKEN = "pre-set-token-0123456789";
    const t = loadOrCreateSetupToken();
    expect(t).toMatchObject({ token: "pre-set-token-0123456789", source: "env", file: null });
  });

  it("ignores an environment token that is too short or carries odd characters", () => {
    for (const bad of ["short", "has space in it 0123456789", "line\nbreak0123456789"]) {
      process.env.POLARIS_SETUP_TOKEN = bad;
      const t = loadOrCreateSetupToken();
      expect(t.source).toBe("new");
      expect(t.token).not.toBe(bad);
      discardSetupToken();
    }
  });

  it("replaces a stored token that is malformed", () => {
    writeFileSync(SETUP_TOKEN_FILE, "bad\n");
    expect(loadOrCreateSetupToken().source).toBe("new");
  });

  it("discardSetupToken forgets the token and removes the file", () => {
    loadOrCreateSetupToken();
    discardSetupToken();
    expect(currentSetupToken()).toBeNull();
    expect(existsSync(SETUP_TOKEN_FILE)).toBe(false);
  });
});

function wizard() {
  const app = express();
  app.use(express.json());
  app.use("/api/setup", setupRoutes);
  return app;
}

const GOOD_DB = { host: "db.example.com", port: 5432, username: "polaris", password: "x", database: "polaris" };

describe("wizard routes demand the token", () => {
  it("serves /status without it and says a token is required", async () => {
    const res = await request(wizard()).get("/api/setup/status");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ needsSetup: true, tokenRequired: true });
  });

  it.each([
    ["post", "/api/setup/preflight", { dbHost: "localhost" }],
    ["post", "/api/setup/generate-secret", {}],
    ["post", "/api/setup/test-connection", GOOD_DB],
    ["post", "/api/setup/finalize", { db: GOOD_DB, admin: { username: "admin", password: "Str0ng-Passw0rd-Ex4mple!" }, app: { port: 3000, sessionSecret: "a".repeat(32) } }],
    ["post", "/api/setup/verify-token", {}],
  ] as const)("refuses %s %s with no token, a wrong token, and no token loaded at all", async (_m, url, body) => {
    // No token loaded: fail CLOSED, even for a request that supplies one.
    let res = await request(wizard()).post(url).set("X-Setup-Token", "anything-at-all-0123456789").send(body);
    expect(res.status).toBe(401);
    expect(res.body.tokenRequired).toBe(true);

    loadOrCreateSetupToken();
    res = await request(wizard()).post(url).send(body);
    expect(res.status).toBe(401);
    res = await request(wizard()).post(url).set("X-Setup-Token", "wrong-token-0123456789abc").send(body);
    expect(res.status).toBe(401);
  });

  it("lets a correct token through to the route", async () => {
    const { token } = loadOrCreateSetupToken();
    const verify = await request(wizard()).post("/api/setup/verify-token").set("X-Setup-Token", token).send({});
    expect(verify.status).toBe(200);
    const secret = await request(wizard()).post("/api/setup/generate-secret").set("X-Setup-Token", token).send({});
    expect(secret.status).toBe(200);
    expect(secret.body.secret).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("finalize refuses values that would add lines to .env", () => {
  const admin = { username: "admin", password: "Str0ng-Passw0rd-Ex4mple!" };
  const post = async (body: unknown) => {
    const { token } = loadOrCreateSetupToken();
    return request(wizard()).post("/api/setup/finalize").set("X-Setup-Token", token).send(body);
  };

  it.each([
    ["sessionSecret", { db: GOOD_DB, admin, app: { port: 3000, sessionSecret: "a".repeat(20) + "\nNODE_OPTIONS=--require=/tmp/x.js" } }],
    ["sessionSecret", { db: GOOD_DB, admin, app: { port: 3000, sessionSecret: "a".repeat(20) + " b" } }],
    ["host", { db: { ...GOOD_DB, host: "db.example.com\nPOLARIS_X=1" }, admin, app: { port: 3000, sessionSecret: "a".repeat(32) } }],
    ["host", { db: { ...GOOD_DB, host: "db.example.com/evil" }, admin, app: { port: 3000, sessionSecret: "a".repeat(32) } }],
    ["database", { db: { ...GOOD_DB, database: "polaris\nX=1" }, admin, app: { port: 3000, sessionSecret: "a".repeat(32) } }],
  ])("rejects a hostile %s before touching the database", async (_field, body) => {
    const res = await post(body);
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.body.ok).toBe(false);
  });
});
