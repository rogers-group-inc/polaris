/**
 * tests/unit/fortiswitchHttpsEngine.test.ts
 *
 * The FortiSwitch HTTPS upgrade engine (business rule 87) driven against a
 * fake switch on `node:http`. The fake implements exactly the endpoints the
 * fortiupgrade CLI captured from real switches, so what is pinned here is the
 * transcription: the multipart field ORDER the switch reads positionally, the
 * `status === "success"` contract on staging, the compat gate that refuses a
 * downgrade, "a dropped socket on deploy is not a failure", the reboot wait,
 * and the serial cross-check that stops an image reaching the wrong device.
 *
 * Every clock is milliseconds here; the defaults are minutes on a real switch.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { upgradeFortiSwitch } from "../../src/services/firmwareEngines/fortiswitchHttps.js";
import { DEFAULT_FIRMWARE_TIMEOUTS, type FirmwareEngineContext, type FirmwareRunStage } from "../../src/services/firmwareEngines/types.js";

const IMAGE_VERSION = { major: 7, minor: 6, patch: 8, build: 1164 };

interface FakeSwitchState {
  osVersion: string;
  build: string;
  serial: string;
  password: string;
  down: boolean;
  deployed: boolean;
  progressPolls: number;
  compat: Record<string, string>;
  uploads: Array<{ order: string[]; fileBytes: number; contentLength: number | null }>;
  calls: string[];
  dropOnDeploy: boolean;
  uploadStatus: string;
  /** How many status polls after deploy before the switch "goes down". */
  pollsBeforeDown: number;
  afterRebootVersion: { osVersion: string; build: string };
  /** ms the switch stays down once it drops. */
  downForMs: number;
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((res, rej) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => res(Buffer.concat(chunks)));
    req.on("error", rej);
  });
}

function parseForm(body: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of body.split("&")) {
    if (!part) continue;
    const [k, v = ""] = part.split("=");
    out[decodeURIComponent(k!)] = decodeURIComponent(v);
  }
  return out;
}

function multipartFieldOrder(body: Buffer): { order: string[]; fileBytes: number } {
  const text = body.toString("latin1");
  const order: string[] = [];
  const re = /Content-Disposition: form-data; name="([^"]+)"(?:; filename="[^"]*")?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) order.push(m[1]!);
  const fileStart = text.indexOf('name="file"');
  const dataStart = text.indexOf("\r\n\r\n", fileStart) + 4;
  const boundaryEnd = text.lastIndexOf("\r\n--");
  return { order, fileBytes: boundaryEnd - dataStart };
}

function makeFakeSwitch(state: FakeSwitchState): Server {
  return createServer(async (req: IncomingMessage, res: ServerResponse) => {
    if (state.down) { req.socket.destroy(); return; }
    const url = new URL(req.url ?? "/", "http://x");
    const cookie = req.headers.cookie ?? "";
    const authed = /APSCOOKIE=ok/.test(cookie);
    state.calls.push(`${req.method} ${url.pathname}`);

    if (req.method === "POST" && url.pathname === "/login") {
      const f = parseForm((await readBody(req)).toString());
      if (f.username === "admin" && f.password === state.password) {
        res.writeHead(302, { "set-cookie": "APSCOOKIE=ok; path=/; Domain=127.0.0.1", location: "/" });
      } else {
        res.writeHead(302, { location: "/login" });
      }
      return res.end();
    }
    if (req.method === "GET" && url.pathname === "/login") { res.writeHead(200, { "content-type": "text/html" }); return res.end('<form><input name="password"></form>'); }
    if (!authed) { res.writeHead(302, { location: "/login" }); return res.end(); }
    if (req.method === "GET" && url.pathname === "/") { res.writeHead(200, { "content-type": "text/html" }); return res.end("<html>home</html>"); }
    if (req.method === "GET" && url.pathname === "/logout") { res.writeHead(302, { location: "/login", "set-cookie": "APSCOOKIE=; path=/" }); return res.end(); }

    if (req.method === "GET" && url.pathname === "/system/config/firmware/image") {
      if (url.searchParams.has("cur_size")) { res.writeHead(200, { "content-type": "application/json" }); return res.end(JSON.stringify({ cur_size: 1 })); }
      if (state.deployed) {
        state.progressPolls += 1;
        if (state.progressPolls > state.pollsBeforeDown) {
          state.down = true;
          setTimeout(() => {
            state.down = false;
            state.deployed = false;
            state.osVersion = state.afterRebootVersion.osVersion;
            state.build = state.afterRebootVersion.build;
          }, state.downForMs);
          req.socket.destroy();
          return;
        }
        const pct = Math.min(100, state.progressPolls * 50);
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify({ msg: "Upgrade is done successfully!", status: 0, erase_progress: 100, write_progress: pct, verify_progress: 0, restart_progress: 0, cur_step: 2, tot_step: 4 }));
      }
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ os_version: state.osVersion, build: state.build, serial_number: state.serial, model: "FS-108F-FPOE", hostname: "lab-sw1", admin_timeout: 5, msg: "", status: 0 }));
    }
    if (req.method === "POST" && url.pathname === "/api/v2/execute/upload/file") {
      const body = await readBody(req);
      const { order, fileBytes } = multipartFieldOrder(body);
      const cl = req.headers["content-length"];
      state.uploads.push({ order, fileBytes, contentLength: cl ? Number(cl) : null });
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ status: state.uploadStatus, serial: state.serial }));
    }
    if (req.method === "POST" && url.pathname === "/system/config/firmware/compatible") {
      const f = parseForm((await readBody(req)).toString());
      state.calls.push(`compat:${f.action}`);
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify(f.action === "check" ? state.compat : { ok: true }));
    }
    if (req.method === "POST" && url.pathname === "/system/config/firmware/deploy") {
      await readBody(req);
      state.deployed = true;
      state.progressPolls = 0;
      if (state.dropOnDeploy) { req.socket.destroy(); return; }
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ status: 0 }));
    }
    res.writeHead(404); res.end();
  });
}

function freshState(): FakeSwitchState {
  return {
    osVersion: "7.4.3", build: "0542", serial: "S108FFTF23001234", password: "s3cret", down: false, deployed: false,
    progressPolls: 0, compat: { downgrade: "false", check_signature: "true", inc_adminpw: "true", inc_snmppw: "true" },
    uploads: [], calls: [], dropOnDeploy: true, uploadStatus: "success", pollsBeforeDown: 3,
    afterRebootVersion: { osVersion: "7.6.8", build: "1164" }, downForMs: 1500,
  };
}

let server: Server;
let port: number;
let state: FakeSwitchState;
let dir: string;
let imagePath: string;
const IMAGE_BYTES = 4096;

beforeEach(async () => {
  state = freshState();
  server = makeFakeSwitch(state);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  port = (server.address() as { port: number }).port;
  dir = mkdtempSync(join(tmpdir(), "polaris-fsw-"));
  imagePath = join(dir, "img.out");
  writeFileSync(imagePath, Buffer.alloc(IMAGE_BYTES, 0x41));
});
afterEach(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  rmSync(dir, { recursive: true, force: true });
});

function ctx(overrides: Partial<FirmwareEngineContext> = {}): FirmwareEngineContext & { stages: FirmwareRunStage[]; logs: string[]; progress: unknown[] } {
  const stages: FirmwareRunStage[] = [];
  const logs: string[] = [];
  const progress: unknown[] = [];
  return {
    host: "127.0.0.1",
    port,
    scheme: "http",
    credential: { username: "admin", password: "s3cret" },
    imagePath,
    imageSize: IMAGE_BYTES,
    image: { platform: "S108FF", versionLabel: "7.6.8 build1164", version: IMAGE_VERSION },
    expectedSerial: "S108FFTF23001234",
    timeouts: {
      ...DEFAULT_FIRMWARE_TIMEOUTS,
      commandMs: 2_000, probeMs: 2_000, transferMs: 5_000, rebootDownMs: 4_000, rebootUpMs: 6_000,
      switchUpgradeMs: 10_000, verifyRetries: 4, verifyRetryDelayMs: 200, heartbeatMs: 250, uploadIdleMs: 3_000,
    },
    onStage: (s) => stages.push(s),
    onProgress: (p) => progress.push(p),
    onLog: (_l, m) => logs.push(m),
    stages, logs, progress,
    ...overrides,
  };
}

describe("FortiSwitch HTTPS engine — the happy path", () => {
  it("stages, checks, deploys, rides the flash, waits for the reboot and verifies", async () => {
    const c = ctx();
    const res = await upgradeFortiSwitch(c);
    expect(res.outcome, JSON.stringify({ res, logs: c.logs })).toBe("upgraded");
    expect(res.verifiedVersion).toBe("7.6.8 build1164");
    expect(res.deviceSerial).toBe("S108FFTF23001234");
    expect(c.stages).toEqual(["preflight", "staging", "compat", "deploying", "rebooting", "verifying"]);
    // The fields the switch reads positionally, in the order the browser sends them.
    expect(state.uploads).toHaveLength(1);
    expect(state.uploads[0]!.order).toEqual(["upgrade_from", "firmware_version", "file_size", "size", "file"]);
    expect(state.uploads[0]!.fileBytes).toBe(IMAGE_BYTES);
    // A precomputed Content-Length, never chunked.
    expect(state.uploads[0]!.contentLength).toBeGreaterThan(IMAGE_BYTES);
    // Never asks the switch for a downgrade.
    expect(state.calls).toContain("compat:check");
    expect(state.calls).not.toContain("compat:reset");
    // Progress reached the caller.
    expect(c.progress.length).toBeGreaterThan(0);
    expect((c.progress[0] as { erase: number }).erase).toBe(100);
  });

  it("does not treat a dropped socket on deploy as a failure, and a 200 there is equally fine", async () => {
    state.dropOnDeploy = false;
    const res = await upgradeFortiSwitch(ctx());
    expect(res.outcome).toBe("upgraded");
  });
});

describe("FortiSwitch HTTPS engine — refusals", () => {
  it("reports already-current without uploading when the switch is at or past the image", async () => {
    state.osVersion = "7.6.8"; state.build = "1164";
    const res = await upgradeFortiSwitch(ctx());
    expect(res.outcome).toBe("already-current");
    expect(state.uploads).toHaveLength(0);
  });

  it("aborts at preflight when the device's serial is not the asset's", async () => {
    const res = await upgradeFortiSwitch(ctx({ expectedSerial: "S108FFTF23009999" }));
    expect(res.outcome).toBe("failed");
    expect(res.error).toMatch(/reports serial S108FFTF23001234, not S108FFTF23009999/);
    expect(state.uploads).toHaveLength(0);
  });

  it("names a bad password", async () => {
    const res = await upgradeFortiSwitch(ctx({ credential: { username: "admin", password: "wrong" } }));
    expect(res.outcome).toBe("failed");
    expect(res.error).toMatch(/rejected the username or password/);
  });

  it("says the web UI is unreachable when nothing listens", async () => {
    const res = await upgradeFortiSwitch(ctx({ port: 1 }));
    expect(res.outcome).toBe("failed");
    expect(res.error).toMatch(/device web UI unreachable/);
  });

  it("refuses when the switch calls the image a downgrade, and un-stages it", async () => {
    state.compat = { ...state.compat, downgrade: "true" };
    const res = await upgradeFortiSwitch(ctx());
    expect(res.outcome).toBe("failed");
    expect(res.error).toMatch(/DOWNGRADE/);
    expect(state.calls).toContain("compat:reset");
    expect(state.deployed).toBe(false);
  });

  it("refuses when the signature check fails", async () => {
    state.compat = { ...state.compat, check_signature: "false" };
    const res = await upgradeFortiSwitch(ctx());
    expect(res.outcome).toBe("failed");
    expect(res.error).toMatch(/signature/);
  });

  it("fails staging when the switch does not answer status success", async () => {
    state.uploadStatus = "error";
    const res = await upgradeFortiSwitch(ctx());
    expect(res.outcome).toBe("failed");
    expect(res.error).toMatch(/did not accept the image/);
    expect(state.deployed).toBe(false);
  });

  it("refuses an image over the switch's 100 MiB ceiling before touching the device", async () => {
    const res = await upgradeFortiSwitch(ctx({ imageSize: 104_857_601 }));
    expect(res.outcome).toBe("failed");
    expect(state.calls).toHaveLength(0);
  });

  it("comes back unverified when the switch reboots into a version other than the image's", async () => {
    state.afterRebootVersion = { osVersion: "7.4.3", build: "0542" };
    const c = ctx();
    // The verify budget is retries × (delay + commandMs); keep it short here.
    c.timeouts = { ...c.timeouts, verifyRetries: 2, verifyRetryDelayMs: 100, commandMs: 400 };
    const res = await upgradeFortiSwitch(c);
    expect(res.outcome).toBe("unverified");
    expect(res.error).toMatch(/reporting 7\.4\.3 build0542, not 7\.6\.8 build1164/);
  }, 20_000);
});
