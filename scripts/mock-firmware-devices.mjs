#!/usr/bin/env node
/**
 * scripts/mock-firmware-devices.mjs — fake FortiSwitch / FortiAP web UIs for a
 * dev stack, so the Repository tab and the asset Firmware card can be driven
 * end to end without touching hardware (business rule 87).
 *
 * Runs INSIDE the dev app container (podman exec …) and listens over HTTPS on
 * loopback aliases, port 443 — the port the real engines dial — so the seeded
 * assets point at 127.0.0.2 / 127.0.0.3 / 127.0.0.4 and the app reaches the
 * mocks exactly the way it would reach a device. Each mock speaks the protocol
 * the engines transcribed from fortiupgrade:
 *
 *   FortiSwitch  POST /login (username/password, 302 + APSCOOKIE) · GET / ·
 *                GET /system/config/firmware/image (version, serial, then
 *                erase/write/verify progress while flashing) ·
 *                POST /api/v2/execute/upload/file (stages; parses the image
 *                header to learn the version it will "flash") ·
 *                POST /system/config/firmware/compatible (check / reset) ·
 *                POST /system/config/firmware/deploy (drops the socket, the
 *                switch "flashes" for ~40 s, is down ~20 s, comes back at the
 *                staged version) · GET /logout
 *   FortiAP      POST /logincheck (bodiless probe; username/secretkey login →
 *                FORTIPASS + X-CSRF-TOKEN) · GET /api/v1/sys-status ·
 *                POST /api/v1/upgrade-image (202; ~10 s later the old session
 *                dies and the AP is "down" ~15 s) · GET /api/v1/sys-perf ·
 *                POST /logout
 *
 * Login is admin / admin on every device (the seeded "form" credential).
 * A self-signed certificate is generated with openssl into /tmp on start.
 *
 *   node scripts/mock-firmware-devices.mjs            # defaults below
 *   MOCK_FW_PORT=8443 node scripts/mock-firmware-devices.mjs   # if 443 is taken
 */

import { createServer } from "node:https";
import { execFileSync } from "node:child_process";
import { readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PORT = Number(process.env.MOCK_FW_PORT || 443);
const USER = process.env.MOCK_FW_USER || "admin";
const PASS = process.env.MOCK_FW_PASS || "admin";
const HEADER_RE = /([A-Z][0-9A-Z]{4,7})-(\d+)\.(\d{2})-(FW|AP)-build(\d+)-\d{6}(?:-patch(\d{2}))?/;

// ─── devices ─────────────────────────────────────────────────────────────────

const DEVICES = [
  { kind: "switch", host: "127.0.0.2", hostname: "MOCK-S108FF-1", serial: "S108FFTF23000001", model: "FS-108F-FPOE", osVersion: "7.4.3", build: "0542" },
  { kind: "switch", host: "127.0.0.3", hostname: "MOCK-S548DF-1", serial: "S548DFTF19000001", model: "FS-548D-FPOE", osVersion: "7.4.3", build: "0542" },
  { kind: "ap",     host: "127.0.0.4", hostname: "MOCK-FAP231K-1", serial: "FP231KTF24000001", model: "FAP-231K", firmwareVersion: "FP231K-v7.4.3-build0542" },
];

// Timings — long enough to watch on the card, short enough to demo.
const SWITCH_FLASH_MS = 40_000;   // progress polls answer for this long after deploy
const SWITCH_DOWN_MS  = 20_000;   // then the switch drops every socket
const AP_ACCEPT_MS    = 10_000;   // after the upload, before the AP restarts
const AP_DOWN_MS      = 15_000;

function log(dev, msg) {
  console.log(`[${new Date().toISOString()}] ${dev.hostname} (${dev.host}) ${msg}`);
}

function parseForm(body) {
  const out = {};
  for (const part of body.split("&")) {
    if (!part) continue;
    const i = part.indexOf("=");
    const k = decodeURIComponent(i < 0 ? part : part.slice(0, i));
    const v = decodeURIComponent(i < 0 ? "" : part.slice(i + 1).replace(/\+/g, " "));
    out[k] = v;
  }
  return out;
}

function readBody(req) {
  return new Promise((res, rej) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => res(Buffer.concat(chunks)));
    req.on("error", rej);
  });
}

/** The version a staged image would flash — from the header token in the upload body. */
function versionFromUpload(body) {
  const m = HEADER_RE.exec(body.toString("latin1"));
  if (!m) return null;
  const patch = m[6] !== undefined ? Number(m[6]) : 0;
  return { platform: m[1], osVersion: `${Number(m[2])}.${Number(m[3])}.${patch}`, build: m[5], family: m[4] };
}

// ─── FortiSwitch ─────────────────────────────────────────────────────────────

function fortiSwitch(dev) {
  const state = { session: null, down: false, staged: null, deployedAt: null, flashing: false };
  return async (req, res) => {
    if (state.down) { req.socket.destroy(); return; }
    const url = new URL(req.url, "https://x");
    const cookie = req.headers.cookie || "";
    const authed = state.session && cookie.includes(`APSCOOKIE=${state.session}`);
    const path = url.pathname;

    if (req.method === "POST" && path === "/login") {
      const f = parseForm((await readBody(req)).toString());
      if (f.username === USER && f.password === PASS) {
        state.session = Math.random().toString(36).slice(2);
        log(dev, "login ok");
        res.writeHead(302, { "set-cookie": `APSCOOKIE=${state.session}; path=/; Domain=${dev.host}`, location: "/" });
      } else {
        log(dev, `login REJECTED (${f.username})`);
        res.writeHead(302, { location: "/login" });
      }
      return res.end();
    }
    if (req.method === "GET" && path === "/login") { res.writeHead(200, { "content-type": "text/html" }); return res.end('<html><form><input name="username"><input name="password" type="password"></form></html>'); }
    if (!authed) { res.writeHead(302, { location: "/login" }); return res.end(); }
    if (req.method === "GET" && path === "/") { res.writeHead(200, { "content-type": "text/html" }); return res.end("<html><body>FortiSwitch</body></html>"); }
    if (req.method === "GET" && path === "/logout") { state.session = null; res.writeHead(302, { location: "/login", "set-cookie": "APSCOOKIE=; path=/" }); return res.end(); }

    if (req.method === "GET" && path === "/system/config/firmware/image") {
      if (url.searchParams.has("cur_size")) { res.writeHead(200, { "content-type": "application/json" }); return res.end(JSON.stringify({ cur_size: state.staged ? state.staged.bytes : 0 })); }
      if (state.flashing) {
        const t = Date.now() - state.deployedAt;
        if (t > SWITCH_FLASH_MS) {
          // Reboot: drop everything for a while, then come back on the staged version.
          state.flashing = false;
          state.down = true;
          state.session = null;
          log(dev, `rebooting — down for ${SWITCH_DOWN_MS / 1000} s`);
          setTimeout(() => {
            if (state.staged) { dev.osVersion = state.staged.osVersion; dev.build = state.staged.build; }
            state.staged = null;
            state.down = false;
            log(dev, `back up at ${dev.osVersion} build${dev.build}`);
          }, SWITCH_DOWN_MS);
          req.socket.destroy();
          return;
        }
        // A real switch reports each stage as a 0..1 FRACTION — erase an exact
        // 1 once done, the others long decimals — and pins cur_step/tot_step
        // at 6/40 the whole time. Mimic both.
        const frac = t / SWITCH_FLASH_MS;
        const erase = frac >= 0.33 ? 1 : frac / 0.33;
        const write = Math.min(1, Math.max(0, (frac - 0.33) / 0.33));
        const verify = Math.min(1, Math.max(0, (frac - 0.66) / 0.34));
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify({ msg: "Upgrade is done successfully!", status: 0, erase_progress: erase, write_progress: write, verify_progress: verify, restart_progress: 0, cur_step: 6, tot_step: 40 }));
      }
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ os_version: dev.osVersion, build: dev.build, serial_number: dev.serial, model: dev.model, hostname: dev.hostname, admin_timeout: 5, msg: "", status: 0 }));
    }
    if (req.method === "POST" && path === "/api/v2/execute/upload/file") {
      const body = await readBody(req);
      const parsed = versionFromUpload(body);
      if (!parsed) { log(dev, "upload: no Fortinet header in the image"); res.writeHead(200, { "content-type": "application/json" }); return res.end(JSON.stringify({ status: "error", serial: dev.serial })); }
      state.staged = { ...parsed, bytes: body.length };
      log(dev, `staged ${parsed.osVersion} build${parsed.build} (${body.length} bytes)`);
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ status: "success", serial: dev.serial }));
    }
    if (req.method === "POST" && path === "/system/config/firmware/compatible") {
      const f = parseForm((await readBody(req)).toString());
      if (f.action === "reset") { state.staged = null; log(dev, "un-staged"); res.writeHead(200, { "content-type": "application/json" }); return res.end("{}"); }
      const downgrade = state.staged && (Number(state.staged.osVersion.split(".")[0]) < Number(dev.osVersion.split(".")[0]));
      const platformOk = state.staged && dev.serial.startsWith(state.staged.platform);
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ downgrade: downgrade ? "true" : "false", check_signature: platformOk ? "true" : "false", inc_adminpw: "true", inc_snmppw: "true" }));
    }
    if (req.method === "POST" && path === "/system/config/firmware/deploy") {
      await readBody(req);
      if (!state.staged) { res.writeHead(400); return res.end(); }
      state.flashing = true;
      state.deployedAt = Date.now();
      log(dev, `deploy — flashing ${state.staged.osVersion} for ${SWITCH_FLASH_MS / 1000} s`);
      // Real switches drop the socket here.
      req.socket.destroy();
      return;
    }
    res.writeHead(404); res.end();
  };
}

// ─── FortiAP ─────────────────────────────────────────────────────────────────

function fortiAp(dev) {
  const state = { session: null, down: false };
  return async (req, res) => {
    if (state.down) { req.socket.destroy(); return; }
    const url = new URL(req.url, "https://x");
    const cookie = req.headers.cookie || "";
    const authed = state.session && cookie.includes(`FORTIPASS=${state.session}`);
    const path = url.pathname;

    if (req.method === "POST" && path === "/logincheck") {
      const body = (await readBody(req)).toString();
      if (!body) { res.writeHead(401); return res.end(); }
      const f = parseForm(body);
      if (f.username !== USER || f.secretkey !== PASS) { log(dev, `login REJECTED (${f.username})`); res.writeHead(401); return res.end(); }
      state.session = Math.random().toString(36).slice(2);
      log(dev, "login ok");
      res.writeHead(200, { "set-cookie": `FORTIPASS=${state.session}; path=/`, "x-csrf-token": "csrf-" + state.session });
      return res.end("ok");
    }
    if (!authed) { res.writeHead(401); return res.end(); }
    if (req.method === "POST" && path === "/logout") { state.session = null; res.writeHead(200); return res.end(); }
    if (req.method === "GET" && path === "/api/v1/sys-status") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ firmware_version: dev.firmwareVersion, serial_number: dev.serial, hostname: dev.hostname }));
    }
    if (req.method === "GET" && path === "/api/v1/sys-perf") { res.writeHead(200, { "content-type": "application/json" }); return res.end(JSON.stringify({ cpu: 3, mem: 41 })); }
    if (req.method === "POST" && path === "/api/v1/upgrade-image") {
      const body = await readBody(req);
      const parsed = versionFromUpload(body);
      if (!parsed || !dev.serial.startsWith(parsed.platform)) { log(dev, "upgrade-image REJECTED"); res.writeHead(400); return res.end(); }
      log(dev, `accepted ${parsed.osVersion} build${parsed.build} (${body.length} bytes) — restarting in ${AP_ACCEPT_MS / 1000} s`);
      res.writeHead(202); res.end();
      setTimeout(() => {
        state.session = null; // the old session dies with the restart
        state.down = true;
        log(dev, `restarting — down for ${AP_DOWN_MS / 1000} s`);
        setTimeout(() => {
          dev.firmwareVersion = `${parsed.platform}-v${parsed.osVersion}-build${parsed.build}`;
          state.down = false;
          log(dev, `back up at ${dev.firmwareVersion}`);
        }, AP_DOWN_MS);
      }, AP_ACCEPT_MS);
      return;
    }
    res.writeHead(404); res.end();
  };
}

// ─── boot ────────────────────────────────────────────────────────────────────

function selfSignedCert() {
  const dir = mkdtempSync(join(tmpdir(), "mock-fw-"));
  const key = join(dir, "key.pem");
  const cert = join(dir, "cert.pem");
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", cert, "-days", "30", "-subj", "/CN=mock-fortinet-device"], { stdio: "ignore" });
  return { key: readFileSync(key), cert: readFileSync(cert) };
}

const tls = selfSignedCert();
for (const dev of DEVICES) {
  const handler = dev.kind === "switch" ? fortiSwitch(dev) : fortiAp(dev);
  const server = createServer(tls, (req, res) => { handler(req, res).catch((err) => { console.error(err); try { res.writeHead(500); res.end(); } catch { /* gone */ } }); });
  server.keepAliveTimeout = 1000;
  server.listen(PORT, dev.host, () => log(dev, `listening on https://${dev.host}:${PORT} (${dev.kind}, ${dev.serial}, ${dev.kind === "switch" ? dev.osVersion + " build" + dev.build : dev.firmwareVersion})`));
  server.on("error", (err) => { console.error(`${dev.hostname}: ${err.message}`); process.exitCode = 1; });
}
