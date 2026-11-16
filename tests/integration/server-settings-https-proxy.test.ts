/**
 * tests/integration/server-settings-https-proxy.test.ts
 *
 * Asserts the Server Settings → Certificates routes behave correctly under
 * nginx-front mode (which is the only mode post-Phase-4):
 *   - GET /server-settings/https returns the externally-managed payload
 *     (externallyManaged: true, fingerprint, SANs, expiry, certPath)
 *   - POST /server-settings/certificates with category=server returns 409
 *   - POST /server-settings/certificates with category=ca STILL works
 *     (CAs are needed for outbound TLS to LDAP/SMTP/etc.)
 *
 * Skips cleanly when DATABASE_URL isn't reachable (matches the rest of the
 * integration suite).
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import request from "supertest";
import { dbReachable, ensureTestUser, authedAgent } from "./_helpers.js";

const FIXTURE_PATH = path.join(__dirname, "..", "fixtures", "test-cert.pem");

// Reach for app + prisma DYNAMICALLY so the env-var flip below takes effect
// before module init. The dynamic import is awaited inside beforeAll once
// the env is right; assigning to module-scope lets the test cases use it.
let app: any;
let prisma: any;
let tmpDir: string | null = null;

const savedCertPath = process.env.POLARIS_PROXY_CERT_PATH;
const savedPublicUrl = process.env.POLARIS_PUBLIC_URL;

beforeAll(async () => {
  if (!dbReachable) return;
  // Stage the proxy-mode env vars before any app module loads.
  tmpDir = mkdtempSync(path.join(tmpdir(), "polaris-proxytest-"));
  const certPath = path.join(tmpDir, "cert.pem");
  copyFileSync(FIXTURE_PATH, certPath);
  process.env.POLARIS_PROXY_CERT_PATH = certPath;
  process.env.POLARIS_PUBLIC_URL = "https://polaris-test.example.com";

  // vi.resetModules() would normally clear, but vitest runs each test file
  // in its own worker so a clean `import()` here suffices — no prior load
  // has happened in this worker.
  const appModule = await import("../../src/app.js");
  const dbModule = await import("../../src/db.js");
  app = appModule.app;
  prisma = dbModule.prisma;
  await prisma.$connect();
  await ensureTestUser();
  // Importing the whole app (every route, the boot-time refreshes) takes
  // 10–14 s on a loaded dev box — over Vitest's 10 s hook default, so this
  // suite flaked on a cold run (2026-11-16, before and after rule 188).
}, 60_000);

afterAll(async () => {
  if (!dbReachable) return;
  try { await prisma.$disconnect(); } catch { /* noop */ }
  if (savedCertPath === undefined) delete process.env.POLARIS_PROXY_CERT_PATH;
  else process.env.POLARIS_PROXY_CERT_PATH = savedCertPath;
  if (savedPublicUrl === undefined) delete process.env.POLARIS_PUBLIC_URL;
  else process.env.POLARIS_PUBLIC_URL = savedPublicUrl;
  if (tmpDir) {
    rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = null;
  }
});

beforeEach(async () => {
  if (!dbReachable) return;
  // No specific table wipe — these tests read Setting only.
});

const d = dbReachable ? describe : describe.skip;

d("Server Settings HTTPS routes in proxy mode", () => {
  it("GET /server-settings/https returns the externally-managed payload", async () => {
    const { agent } = await authedAgent(app);
    const resp = await agent.get("/api/v1/server-settings/https");
    expect(resp.status).toBe(200);
    expect(resp.body.externallyManaged).toBe(true);
    expect(resp.body.running).toBe(true);
    expect(resp.body.certPath).toMatch(/cert\.pem$/);
    // fingerprint is the SHA-256 of the fixture cert
    expect(resp.body.fingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(resp.body.cn).toBe("polaris-test.example.com");
    expect(resp.body.dnsSans).toEqual(expect.arrayContaining(["polaris-test.example.com"]));
    expect(resp.body.expiresAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("POST /server-settings/certificates with category=server returns 409", async () => {
    const { agent, csrf } = await authedAgent(app);
    // A minimal-looking PEM is fine — the 409 fires before parsing.
    const resp = await agent
      .post("/api/v1/server-settings/certificates")
      .set("X-CSRF-Token", csrf)
      .field("category", "server")
      .attach("file", FIXTURE_PATH, "cert.pem");
    expect(resp.status).toBe(409);
    expect(resp.body.error).toMatch(/external proxy/i);
  });

  it("POST /server-settings/certificates with category=ca STILL works (CAs are operator-editable)", async () => {
    const { agent, csrf } = await authedAgent(app);
    const resp = await agent
      .post("/api/v1/server-settings/certificates")
      .set("X-CSRF-Token", csrf)
      .field("category", "ca")
      .attach("file", FIXTURE_PATH, "fake-ca.pem");
    expect(resp.status).toBe(201);
    expect(resp.body.category).toBe("ca");
    // Cleanup: remove the test CA so it doesn't accumulate.
    if (resp.body.id) {
      await agent
        .delete(`/api/v1/server-settings/certificates/${resp.body.id}`)
        .set("X-CSRF-Token", csrf);
    }
  });

});

// Silence the unused-import warning on machines where dbReachable is false.
void request;