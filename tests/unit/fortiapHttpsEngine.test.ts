/**
 * tests/unit/fortiapHttpsEngine.test.ts
 *
 * The FortiAP HTTPS upgrade engine (business rule 87) against a fake access
 * point on `node:http`. Pins the fortiupgrade transcription: the bodiless
 * `/logincheck` probe, `secretkey` as the password field, the FORTIPASS
 * cookie, echoing X-CSRF-TOKEN only when the AP issued one, the single
 * `image` multipart field, 202 as acceptance, the reboot proof being the OLD
 * session's 401, and a fresh login for verification.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { upgradeFortiAp } from "../../src/services/firmwareEngines/fortiapHttps.js";
import { DEFAULT_FIRMWARE_TIMEOUTS, type FirmwareEngineContext, type FirmwareRunStage } from "../../src/services/firmwareEngines/types.js";

interface FakeApState {
  version: string;
  serial: string;
  password: string;
  issuesCsrf: boolean;
  session: string | null;
  upgradeStatus: number;
  perfPollsBeforeRestart: number;
  perfPolls: number;
  restarted: boolean;
  afterVersion: string;
  uploads: Array<{ fields: string[]; csrf: string | undefined; bytes: number }>;
  calls: string[];
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((res, rej) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => res(Buffer.concat(chunks)));
    req.on("error", rej);
  });
}

function makeFakeAp(state: FakeApState): Server {
  return createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://x");
    const cookie = req.headers.cookie ?? "";
    const authed = state.session !== null && cookie.includes(`FORTIPASS=${state.session}`) && !state.restarted;
    state.calls.push(`${req.method} ${url.pathname}`);

    if (req.method === "POST" && url.pathname === "/logincheck") {
      const body = (await readBody(req)).toString();
      if (!body) { res.writeHead(401); return res.end(); }
      const f = Object.fromEntries(body.split("&").map((p) => p.split("=").map(decodeURIComponent) as [string, string]));
      if (f.username !== "admin" || f.secretkey !== state.password) { res.writeHead(401); return res.end(); }
      state.session = "sess-" + Math.random().toString(36).slice(2);
      state.restarted = false;
      const headers: Record<string, string> = { "set-cookie": `FORTIPASS=${state.session}; path=/` };
      if (state.issuesCsrf) headers["x-csrf-token"] = "csrf-" + state.session;
      res.writeHead(200, headers);
      return res.end("ok");
    }
    if (!authed) { res.writeHead(401); return res.end(); }
    if (req.method === "POST" && url.pathname === "/logout") { res.writeHead(200); return res.end(); }
    if (req.method === "GET" && url.pathname === "/api/v1/sys-status") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ firmware_version: state.version, serial_number: state.serial, hostname: "lab-ap1" }));
    }
    if (req.method === "POST" && url.pathname === "/api/v1/upgrade-image") {
      const body = await readBody(req);
      const text = body.toString("latin1");
      const fields = Array.from(text.matchAll(/; name="([^"]+)"/g)).map((m) => m[1]!);
      const dataStart = text.indexOf("\r\n\r\n") + 4;
      state.uploads.push({ fields, csrf: req.headers["x-csrf-token"] as string | undefined, bytes: text.lastIndexOf("\r\n--") - dataStart });
      res.writeHead(state.upgradeStatus);
      if (state.upgradeStatus === 202) {
        state.perfPolls = 0;
        // The AP flashes and restarts; the old session dies with it.
        setTimeout(() => { state.restarted = true; state.version = state.afterVersion; }, 600);
      }
      return res.end();
    }
    if (req.method === "GET" && url.pathname === "/api/v1/sys-perf") {
      state.perfPolls += 1;
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ cpu: 3 }));
    }
    res.writeHead(404); res.end();
  });
}

function freshState(): FakeApState {
  return {
    version: "FP231K-v7.4.3-build0542", serial: "FP231KTF24005678", password: "s3cret", issuesCsrf: true, session: null,
    upgradeStatus: 202, perfPollsBeforeRestart: 2, perfPolls: 0, restarted: false, afterVersion: "FP231K-v7.6.8-build1105",
    uploads: [], calls: [],
  };
}

let server: Server;
let port: number;
let state: FakeApState;
let dir: string;
let imagePath: string;
const IMAGE_BYTES = 2048;

beforeEach(async () => {
  state = freshState();
  server = makeFakeAp(state);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  port = (server.address() as { port: number }).port;
  dir = mkdtempSync(join(tmpdir(), "polaris-fap-"));
  imagePath = join(dir, "ap.out");
  writeFileSync(imagePath, Buffer.alloc(IMAGE_BYTES, 0x42));
});
afterEach(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  rmSync(dir, { recursive: true, force: true });
});

function ctx(overrides: Partial<FirmwareEngineContext> = {}): FirmwareEngineContext & { stages: FirmwareRunStage[]; logs: string[] } {
  const stages: FirmwareRunStage[] = [];
  const logs: string[] = [];
  return {
    host: "127.0.0.1",
    port,
    scheme: "http",
    credential: { username: "admin", password: "s3cret" },
    imagePath,
    imageSize: IMAGE_BYTES,
    image: { platform: "FP231K", versionLabel: "7.6.8 build1105", version: { major: 7, minor: 6, patch: 8, build: 1105 } },
    expectedSerial: "FP231KTF24005678",
    timeouts: {
      ...DEFAULT_FIRMWARE_TIMEOUTS,
      commandMs: 2_000, probeMs: 2_000, transferMs: 5_000, rebootDownMs: 2_000, rebootUpMs: 3_000,
      verifyRetries: 4, verifyRetryDelayMs: 150, heartbeatMs: 200, uploadIdleMs: 3_000,
    },
    onStage: (s) => stages.push(s),
    onProgress: () => undefined,
    onLog: (_l, m) => logs.push(m),
    stages, logs,
    ...overrides,
  };
}

describe("FortiAP HTTPS engine", () => {
  it("probes, logs in, uploads the single image field, proves the restart on the old session and verifies", async () => {
    const c = ctx();
    const res = await upgradeFortiAp(c);
    expect(res.outcome, JSON.stringify({ res, logs: c.logs })).toBe("upgraded");
    expect(res.verifiedVersion).toBe("FP231K-v7.6.8-build1105");
    expect(c.stages).toEqual(["preflight", "staging", "deploying", "rebooting", "verifying"]);
    expect(state.uploads).toHaveLength(1);
    expect(state.uploads[0]!.fields).toEqual(["image"]);
    expect(state.uploads[0]!.bytes).toBe(IMAGE_BYTES);
    // The token the AP issued came back on the upload.
    expect(state.uploads[0]!.csrf).toMatch(/^csrf-sess-/);
    // The probe is the bodiless POST, and it happens before any login.
    expect(state.calls[0]).toBe("POST /logincheck");
    // No login attempt while waiting for the restart: every /logincheck sits
    // before the perf polls or after the last one.
    const perfIdx = state.calls.map((x, i) => [x, i] as const).filter(([x]) => x === "GET /api/v1/sys-perf").map(([, i]) => i);
    const loginIdx = state.calls.map((x, i) => [x, i] as const).filter(([x]) => x === "POST /logincheck").map(([, i]) => i);
    expect(loginIdx.some((i) => i > perfIdx[0]! && i < perfIdx[perfIdx.length - 1]!)).toBe(false);
  });

  it("sends no CSRF header when the AP issued none", async () => {
    state.issuesCsrf = false;
    const res = await upgradeFortiAp(ctx());
    expect(res.outcome).toBe("upgraded");
    expect(state.uploads[0]!.csrf).toBeUndefined();
  });

  it("reports already-current without uploading", async () => {
    state.version = "FP231K-v7.6.8-build1105";
    const res = await upgradeFortiAp(ctx());
    expect(res.outcome).toBe("already-current");
    expect(state.uploads).toHaveLength(0);
  });

  it("aborts on a serial that is not the asset's", async () => {
    const res = await upgradeFortiAp(ctx({ expectedSerial: "FP231KTF24000000" }));
    expect(res.outcome).toBe("failed");
    expect(res.error).toMatch(/reports serial FP231KTF24005678, not FP231KTF24000000/);
    expect(state.uploads).toHaveLength(0);
  });

  it("tells a bad password (401) from a lockout (403)", async () => {
    const bad = await upgradeFortiAp(ctx({ credential: { username: "admin", password: "nope" } }));
    expect(bad.outcome).toBe("failed");
    expect(bad.error).toMatch(/rejected the username or password/);
  });

  it("says the web UI is unreachable — the FortiGate-managed AP case", async () => {
    const res = await upgradeFortiAp(ctx({ port: 1 }));
    expect(res.outcome).toBe("failed");
    expect(res.error).toMatch(/device web UI unreachable/);
    expect(res.error).toMatch(/FortiGate-managed AP/);
  });

  it("fails when the AP rejects the image with 400", async () => {
    state.upgradeStatus = 400;
    const res = await upgradeFortiAp(ctx());
    expect(res.outcome).toBe("failed");
    expect(res.error).toMatch(/rejected the image/);
  });

  it("comes back unverified when the AP never invalidates the old session", async () => {
    // Accept the upload but never restart: the perf poll keeps answering 200.
    state.afterVersion = state.version;
    server.removeAllListeners("request");
    server.on("request", (req: IncomingMessage, res: ServerResponse) => {
      // Re-drive the fake, but neutralise the restart timer by never flipping.
      const url = new URL(req.url ?? "/", "http://x");
      if (req.method === "POST" && url.pathname === "/api/v1/upgrade-image") { readBody(req).then(() => { res.writeHead(202); res.end(); }); return; }
      if (req.method === "GET" && url.pathname === "/api/v1/sys-perf") { res.writeHead(200, { "content-type": "application/json" }); res.end("{}"); return; }
      if (req.method === "POST" && url.pathname === "/logincheck") {
        readBody(req).then((b) => {
          if (!b.length) { res.writeHead(401); res.end(); return; }
          res.writeHead(200, { "set-cookie": "FORTIPASS=s; path=/" }); res.end("ok");
        });
        return;
      }
      if (req.method === "GET" && url.pathname === "/api/v1/sys-status") { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ firmware_version: state.version, serial_number: state.serial })); return; }
      res.writeHead(404); res.end();
    });
    const c = ctx();
    c.timeouts = { ...c.timeouts, rebootDownMs: 400, rebootUpMs: 600 };
    const res = await upgradeFortiAp(c);
    expect(res.outcome).toBe("unverified");
    expect(res.error).toMatch(/never invalidated the old session/);
  }, 15_000);
});
