/**
 * tests/unit/fortigateHttpsEngine.test.ts
 *
 * The FortiGate upgrade engine (business rule 87) driven against a fake
 * FortiOS on `node:http`. Unlike the switch and AP fakes this one is NOT a
 * transcription of captured traffic — the engine has never met a real gate —
 * so what is pinned is the engine's own contract, the part a lab run cannot
 * change: both ways in (an admin login echoing the per-port ccsrftoken, or a
 * bearer token and no login at all), the refusals that must come BEFORE a
 * byte of image is sent (wrong serial, an HA cluster, already current, a
 * login that opens no session), the multipart upload with the JSON-base64
 * retry byte-for-byte, and the reboot wait and version check.
 *
 * Every clock is milliseconds here except the reboot poll, which the engine
 * clamps to one second.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { upgradeFortiGate, readUpgradeAnswer } from "../../src/services/firmwareEngines/fortigateHttps.js";
import { Base64Encode, base64Length } from "../../src/services/firmwareEngines/deviceHttp.js";
import { DEFAULT_FIRMWARE_TIMEOUTS, type FirmwareEngineContext, type FirmwareRunStage } from "../../src/services/firmwareEngines/types.js";

const IMAGE_VERSION = { major: 7, minor: 6, patch: 8, build: 3500 };

interface FakeGate {
  version: string;
  build: number;
  serial: string;
  haMode: string;
  password: string;
  token: string;
  tokenStatus: number;
  /** Older builds name it ccsrftoken; 7.2+ suffix it per port. */
  csrfCookie: string;
  issueCsrf: boolean;
  multipartAnswer: { status: number; body: unknown } | null;
  down: boolean;
  afterReboot: { version: string; build: number };
  calls: string[];
  uploads: Array<{ kind: "multipart" | "json"; bytes: Buffer; source: string | null; contentLength: number; csrf: string | null; auth: string | null }>;
}

let server: Server;
let port: number;
let dir: string;
let imagePath: string;
let image: Buffer;
let gate: FakeGate;
let stages: FirmwareRunStage[];
let logs: string[];

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((res, rej) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => res(Buffer.concat(chunks)));
    req.on("error", rej);
  });
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function authorized(req: IncomingMessage): boolean {
  const auth = req.headers.authorization;
  if (auth) return auth === `Bearer ${gate.token}`;
  return /APSCOOKIE_FGT=ok/.test(String(req.headers.cookie ?? ""));
}

/** The multipart file part and the `source` field, from a raw body. */
function parseMultipart(body: Buffer): { source: string | null; file: Buffer } {
  const text = body.toString("latin1");
  const src = /name="source"\r\n\r\n([^\r]*)\r\n/.exec(text);
  const fileHead = text.indexOf('name="file"');
  const start = text.indexOf("\r\n\r\n", fileHead) + 4;
  const end = text.lastIndexOf("\r\n--");
  return { source: src ? src[1]! : null, file: body.subarray(start, end) };
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (gate.down) { req.socket.destroy(); return; }
  const url = req.url ?? "/";
  gate.calls.push(`${req.method} ${url}`);
  const body = await readBody(req);

  if (url === "/" && req.method === "GET") { res.writeHead(302, { location: "/login" }); res.end(); return; }
  if (url === "/logincheck") {
    const form = Object.fromEntries(body.toString("utf8").split("&").map((p) => p.split("=").map(decodeURIComponent)));
    const cookies = [];
    if (form.username === "admin" && form.secretkey === gate.password) {
      cookies.push("APSCOOKIE_FGT=ok; path=/");
      if (gate.issueCsrf) cookies.push(`${gate.csrfCookie}="csrf-123"; path=/`);
    }
    res.writeHead(200, { "set-cookie": cookies, "content-type": "text/html" });
    res.end(cookies.length ? "1" : "0");
    return;
  }
  if (url === "/logout") { res.writeHead(200); res.end(); return; }
  if (req.headers.authorization && gate.tokenStatus !== 200) { json(res, gate.tokenStatus, { status: "error" }); return; }
  if (!authorized(req)) { json(res, 401, { status: "error" }); return; }

  if (url === "/api/v2/monitor/system/status") {
    json(res, 200, { http_status: 200, status: "success", serial: gate.serial, version: gate.version, build: gate.build, results: { hostname: "lab-fg1", model_name: "FortiGate" } });
    return;
  }
  if (url === "/api/v2/cmdb/system/ha") {
    json(res, 200, { http_status: 200, results: { mode: gate.haMode } });
    return;
  }
  if (url === "/api/v2/monitor/system/firmware/upgrade" && req.method === "POST") {
    const csrf = typeof req.headers["x-csrftoken"] === "string" ? req.headers["x-csrftoken"] : null;
    const auth = typeof req.headers.authorization === "string" ? req.headers.authorization : null;
    const contentLength = Number(req.headers["content-length"]);
    if (String(req.headers["content-type"]).startsWith("multipart/form-data")) {
      const { source, file } = parseMultipart(body);
      gate.uploads.push({ kind: "multipart", bytes: Buffer.from(file), source, contentLength, csrf, auth });
      if (gate.multipartAnswer) { json(res, gate.multipartAnswer.status, gate.multipartAnswer.body); return; }
    } else {
      const parsed = JSON.parse(body.toString("utf8")) as { source: string; file_content: string };
      gate.uploads.push({ kind: "json", bytes: Buffer.from(parsed.file_content, "base64"), source: parsed.source, contentLength, csrf, auth });
    }
    json(res, 200, { http_status: 200, status: "success", results: { status: "success" } });
    // Write the image, go down, come back on the new version.
    setTimeout(() => { gate.down = true; }, 50);
    setTimeout(() => { gate.version = gate.afterReboot.version; gate.build = gate.afterReboot.build; gate.down = false; }, 1600);
    return;
  }
  json(res, 404, { status: "error" });
}

function ctx(over: Partial<FirmwareEngineContext> = {}): FirmwareEngineContext {
  return {
    host: "127.0.0.1",
    port,
    scheme: "http",
    credential: { username: "admin", password: "pw" },
    imagePath,
    imageSize: image.length,
    image: { platform: "FGT60F", versionLabel: "7.6.8 build3500", version: IMAGE_VERSION },
    expectedSerial: "FGT60FTK20001234",
    timeouts: {
      ...DEFAULT_FIRMWARE_TIMEOUTS,
      commandMs: 2_000, probeMs: 2_000, uploadIdleMs: 2_000, heartbeatMs: 10,
      rebootDownMs: 4_000, rebootUpMs: 6_000, verifyRetries: 3, verifyRetryDelayMs: 50,
    },
    onStage: (s) => stages.push(s),
    onProgress: () => undefined,
    onLog: (_l, m) => logs.push(m),
    ...over,
  };
}

beforeEach(async () => {
  gate = {
    version: "v7.4.4", build: 2662, serial: "FGT60FTK20001234", haMode: "standalone", password: "pw", token: "tok-abc", tokenStatus: 200,
    csrfCookie: "ccsrftoken_443_3f2a", issueCsrf: true, multipartAnswer: null, down: false,
    afterReboot: { version: "v7.6.8", build: 3500 }, calls: [], uploads: [],
  };
  stages = [];
  logs = [];
  dir = mkdtempSync(join(tmpdir(), "fgt-engine-"));
  // Not a multiple of 3, so the base64 tail carries padding.
  image = Buffer.alloc(200_003);
  for (let i = 0; i < image.length; i++) image[i] = (i * 31 + 7) & 0xff;
  imagePath = join(dir, "FGT_60F-v7.6.8.out");
  writeFileSync(imagePath, image);
  server = createServer((req, res) => { void handle(req, res); });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.address() as { port: number }).port;
});

afterEach(async () => {
  server.closeAllConnections?.();
  await new Promise<void>((r) => server.close(() => r()));
  rmSync(dir, { recursive: true, force: true });
});

describe("the happy paths", () => {
  it("admin login: echoes the per-port ccsrftoken, uploads multipart, waits out the reboot, reads the new version", async () => {
    const res = await upgradeFortiGate(ctx());
    expect(res).toMatchObject({ outcome: "upgraded", verifiedVersion: "v7.6.8 build3500", deviceSerial: "FGT60FTK20001234" });
    expect(gate.uploads).toHaveLength(1);
    const up = gate.uploads[0]!;
    expect(up.kind).toBe("multipart");
    expect(up.source).toBe("upload");
    expect(up.bytes.equals(image)).toBe(true);
    expect(up.csrf).toBe("csrf-123"); // quotes stripped
    expect(up.auth).toBeNull();
    expect(stages).toEqual(["preflight", "staging", "deploying", "rebooting", "verifying"]);
    expect(logs.join("\n")).toContain("went down to reboot");
  }, 20_000);

  it("integration token: a bearer header on every call and no login at all", async () => {
    const res = await upgradeFortiGate(ctx({ credential: { username: "", password: "" }, bearerToken: "tok-abc" }));
    expect(res.outcome).toBe("upgraded");
    expect(gate.calls.some((c) => c.includes("/logincheck"))).toBe(false);
    expect(gate.uploads[0]!.auth).toBe("Bearer tok-abc");
    // The token never reaches the run log.
    expect(logs.join("\n")).not.toContain("tok-abc");
  }, 20_000);

  it("a refused multipart upload is retried ONCE as JSON with the image base64-encoded, byte-identical", async () => {
    gate.multipartAnswer = { status: 400, body: { status: "error", http_status: 400, error: -651 } };
    const res = await upgradeFortiGate(ctx());
    expect(res.outcome).toBe("upgraded");
    expect(gate.uploads.map((u) => u.kind)).toEqual(["multipart", "json"]);
    const j = gate.uploads[1]!;
    expect(j.source).toBe("upload");
    expect(j.bytes.equals(image)).toBe(true);
    // Content-Length was computed, not chunked: prefix + base64 + suffix.
    expect(j.contentLength).toBe(`{"source":"upload","file_content":"`.length + base64Length(image.length) + 2);
    expect(logs.join("\n")).toMatch(/retrying once as JSON/);
  }, 20_000);
});

describe("refusals before a byte of image is sent", () => {
  it("an HA cluster member", async () => {
    gate.haMode = "a-p";
    const res = await upgradeFortiGate(ctx());
    expect(res.outcome).toBe("failed");
    expect(res.error).toMatch(/HA cluster \(mode a-p\)/);
    expect(gate.uploads).toHaveLength(0);
  });

  it("a gate whose serial is not the asset's", async () => {
    gate.serial = "FGT60FTK29999999";
    const res = await upgradeFortiGate(ctx());
    expect(res.outcome).toBe("failed");
    expect(res.error).toMatch(/reports serial FGT60FTK29999999, not FGT60FTK20001234/);
    expect(gate.uploads).toHaveLength(0);
  });

  it("a gate already on (or past) the image", async () => {
    gate.version = "v7.6.8";
    gate.build = 3500;
    const res = await upgradeFortiGate(ctx());
    expect(res).toMatchObject({ outcome: "already-current", verifiedVersion: "v7.6.8 build3500" });
    expect(gate.uploads).toHaveLength(0);
  });

  it("a login that opens no session (wrong password, or an admin with two-factor) — one attempt only", async () => {
    gate.issueCsrf = false;
    const res = await upgradeFortiGate(ctx());
    expect(res.outcome).toBe("failed");
    expect(res.error).toMatch(/did not open a session/);
    expect(gate.calls.filter((c) => c.includes("/logincheck"))).toHaveLength(1);
    expect(gate.uploads).toHaveLength(0);
  });

  it("a token whose profile may not read the gate says what it needs", async () => {
    gate.tokenStatus = 403;
    const res = await upgradeFortiGate(ctx({ credential: { username: "", password: "" }, bearerToken: "tok-abc" }));
    expect(res.outcome).toBe("failed");
    expect(res.error).toMatch(/System read-write/);
  });

  it("nothing listening is 'unreachable', fast", async () => {
    const res = await upgradeFortiGate(ctx({ port: 1 }));
    expect(res.outcome).toBe("failed");
    expect(res.error).toMatch(/unreachable/);
  });
});

describe("after the upload", () => {
  it("a gate that comes back on the OLD version is unverified, not upgraded", async () => {
    gate.afterReboot = { version: "v7.4.4", build: 2662 };
    const res = await upgradeFortiGate(ctx());
    expect(res.outcome).toBe("unverified");
    expect(res.error).toMatch(/came back reporting v7\.4\.4 build2662/);
  }, 20_000);

  it("the image itself refused twice is a failure naming both answers", async () => {
    gate.multipartAnswer = { status: 500, body: { status: "error", results: { status: "error", error: "Image validation failed" } } };
    // Make the JSON retry fail too by refusing everything JSON-shaped.
    const orig = server.listeners("request")[0] as (req: IncomingMessage, res: ServerResponse) => void;
    server.removeAllListeners("request");
    server.on("request", (req, res) => {
      if (String(req.headers["content-type"]).startsWith("application/json") && req.url?.includes("firmware/upgrade")) {
        req.resume();
        req.on("end", () => json(res, 500, { status: "error", results: { status: "error", error: "Image validation failed" } }));
        return;
      }
      orig(req, res);
    });
    const res = await upgradeFortiGate(ctx());
    expect(res.outcome).toBe("failed");
    expect(res.error).toMatch(/refused the image: Image validation failed \(500\) \(multipart: Image validation failed \(500\)\)/);
  });
});

describe("pure pieces", () => {
  it("readUpgradeAnswer: 2xx success, an inner error status, and the message lifted", () => {
    const r = (status: number, body: unknown) => readUpgradeAnswer({ status, headers: {}, body: JSON.stringify(body), location: null });
    expect(r(200, { status: "success", results: { status: "success" } })).toEqual({ accepted: true, error: null });
    expect(r(200, { status: "success", results: { status: "error", error: "bad image" } })).toEqual({ accepted: false, error: "bad image (200)" });
    expect(r(424, { status: "error", error: -651 })).toEqual({ accepted: false, error: "-651 (424)" });
    expect(readUpgradeAnswer({ status: 502, headers: {}, body: "<html>", location: null })).toEqual({ accepted: false, error: "HTTP 502" });
  });

  it("Base64Encode matches a whole-buffer encode whatever the chunk boundaries", async () => {
    const data = Buffer.from(Array.from({ length: 1001 }, (_, i) => (i * 97) & 0xff));
    for (const sizes of [[1], [2], [3], [5, 7, 11], [1000, 1]]) {
      const chunks: Buffer[] = [];
      let i = 0, k = 0;
      while (i < data.length) { const n = sizes[k++ % sizes.length]!; chunks.push(data.subarray(i, i + n)); i += n; }
      const out: string[] = [];
      await new Promise<void>((res, rej) => {
        Readable.from(chunks).pipe(new Base64Encode()).on("data", (s: Buffer | string) => out.push(String(s))).on("end", res).on("error", rej);
      });
      expect(out.join("")).toBe(data.toString("base64"));
      expect(out.join("").length).toBe(base64Length(data.length));
    }
  });
});
