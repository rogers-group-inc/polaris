/**
 * src/services/firmwareEngines/fortigateHttps.ts — flash a FortiGate through
 * its own FortiOS REST API over HTTPS (business rule 87).
 *
 * Unlike the switch and AP engines this is not a transcription of a captured
 * browser session: it is the documented FortiOS REST surface, and it has NOT
 * yet been run against a real FortiGate. Every step that guesses says so in
 * the run log, so the first lab run shows which guess was wrong.
 *
 * Two ways in, chosen by the Repository binding:
 *
 *   token   `Authorization: Bearer <api token>` — the integration's REST API
 *           admin. Its profile needs System read-write (firmware upgrade is
 *           a `sysgrp` write); a 403 says so.
 *   login   POST /logincheck  ajax=1, username, secretkey → an APSCOOKIE_*
 *           session cookie and a `ccsrftoken` cookie (`ccsrftoken_<port>_<id>`
 *           on 7.2+), whose value is echoed as `X-CSRFTOKEN`. An admin with
 *           two-factor, a pre-login disclaimer or a forced password change
 *           gets no CSRF cookie — refused at preflight, never retried (each
 *           attempt counts toward the admin lockout).
 *
 *   status   GET  /api/v2/monitor/system/status → envelope serial, version
 *            ("v7.6.7"), build
 *   ha       GET  /api/v2/cmdb/system/ha → mode; anything but "standalone"
 *            is refused (an HA upgrade reboots every member; not supported)
 *   upgrade  POST /api/v2/monitor/system/firmware/upgrade, source=upload.
 *            Sent as multipart (`file` field, streamed, no inflation); if the
 *            gate answers that with a non-auth error, sent ONCE more as JSON
 *            with `file_content` base64-encoded on the fly (~4/3 the size).
 *            A connection dropped after the whole body went counts as taken
 *            — the gate reboots as soon as it has written the image.
 *   reboot   unauthenticated GET / until it stops answering, then until it
 *            answers again
 *   verify   status again (re-login on the login path) until the version
 *            matches the image
 */

import { basename } from "node:path";
import type { FirmwareEngineContext, FirmwareEngineResult } from "./types.js";
import { FirmwareEngineError, sleep } from "./types.js";
import { DeviceHttpClient, DeviceConnectionError, jsonOrNull, asString, asNumber, type DeviceHttpResponse } from "./deviceHttp.js";
import { parseFirmwareVersion, compareFirmwareVersions, formatFirmwareVersion } from "../../utils/firmwareVersion.js";

const LOGIN_PATH = "/logincheck";
const LOGOUT_PATH = "/logout";
const STATUS_PATH = "/api/v2/monitor/system/status";
const HA_PATH = "/api/v2/cmdb/system/ha";
const UPGRADE_PATH = "/api/v2/monitor/system/firmware/upgrade";
const CSRF_COOKIE = /^ccsrftoken/i;
/** Two refused logins in the verify loop and it stops — the admin lockout counts them. */
const MAX_AUTH_REJECTIONS = 2;

export interface FortiGateStatus {
  serial: string | null;
  /** "v7.6.7 build3401" — the version and build as one parseable string. */
  version: string | null;
  hostname: string | null;
}

function client(ctx: FirmwareEngineContext): DeviceHttpClient {
  const c = new DeviceHttpClient({
    host: ctx.host,
    port: ctx.port,
    scheme: ctx.scheme ?? "https",
    commandMs: ctx.timeouts.commandMs,
    uploadIdleMs: ctx.timeouts.uploadIdleMs,
    verifyTls: ctx.verifyTls === true,
  });
  if (ctx.bearerToken) c.setHeader("authorization", `Bearer ${ctx.bearerToken}`);
  return c;
}

function usesToken(ctx: FirmwareEngineContext): boolean {
  return !!ctx.bearerToken;
}

class AuthRejected extends FirmwareEngineError {}

/** Sign in with the bound admin login. A no-op on the token path. */
export async function gateLogin(c: DeviceHttpClient, ctx: FirmwareEngineContext, timeoutMs = ctx.timeouts.commandMs): Promise<void> {
  if (usesToken(ctx)) return;
  c.clearSession();
  const res = await c.postForm(LOGIN_PATH, [
    { name: "ajax", value: "1" },
    { name: "username", value: ctx.credential.username },
    { name: "secretkey", value: ctx.credential.password },
  ], timeoutMs);
  if (res.status === 401 || res.status === 403) throw new AuthRejected("the FortiGate rejected the login", "preflight");
  if (res.status < 200 || res.status >= 400) throw new FirmwareEngineError(`unexpected login answer (${res.status})`, "preflight");
  const csrf = c.cookieMatching(CSRF_COOKIE);
  if (!csrf) {
    throw new AuthRejected(
      "the FortiGate did not open a session for that login — wrong username or password, a locked-out admin, " +
      "or an admin account that needs two-factor, a disclaimer or a password change (use an API token binding instead)",
      "preflight",
    );
  }
  c.setHeader("X-CSRFTOKEN", csrf.replace(/^"|"$/g, ""));
}

async function gateLogout(c: DeviceHttpClient, ctx: FirmwareEngineContext): Promise<void> {
  if (usesToken(ctx)) return;
  await c.postEmpty(LOGOUT_PATH, 5_000).catch(() => undefined);
}

function authMessage(ctx: FirmwareEngineContext, status: number, what: string): string {
  if (usesToken(ctx)) {
    return status === 401
      ? `the FortiGate rejected the integration's API token (${what})`
      : `the integration's API token may not ${what} — its admin profile needs System read-write, and the Polaris host must be in its trusted hosts`;
  }
  return status === 401 ? `the session expired (${what})` : `the bound admin may not ${what} — its profile needs System read-write`;
}

export async function gateStatus(c: DeviceHttpClient, ctx: FirmwareEngineContext): Promise<FortiGateStatus> {
  const res = await c.get(STATUS_PATH);
  if (res.status === 401 || res.status === 403) throw new AuthRejected(authMessage(ctx, res.status, "read system status"), "preflight");
  const j = jsonOrNull(res.body);
  if (res.status !== 200 || !j) throw new FirmwareEngineError(`unexpected system status answer (${res.status})`, "preflight");
  const results = (j.results && typeof j.results === "object" ? j.results : {}) as Record<string, unknown>;
  const version = asString(j.version);
  const build = asNumber(j.build);
  return {
    serial: asString(j.serial),
    version: version ? (build !== null ? `${version} build${build}` : version) : null,
    hostname: asString(results.hostname),
  };
}

/** "standalone", "a-p", "a-a" — or null when the gate did not say. */
export async function gateHaMode(c: DeviceHttpClient, ctx: FirmwareEngineContext): Promise<string | null> {
  const res = await c.get(HA_PATH);
  if (res.status === 401 || res.status === 403) throw new AuthRejected(authMessage(ctx, res.status, "read the HA configuration"), "preflight");
  const j = jsonOrNull(res.body);
  if (res.status !== 200 || !j) return null;
  const r = Array.isArray(j.results) ? j.results[0] : j.results;
  return r && typeof r === "object" ? asString((r as Record<string, unknown>).mode) : null;
}

/** What an upgrade answer says: taken, refused (with why), or not understood. */
export function readUpgradeAnswer(res: DeviceHttpResponse): { accepted: boolean; error: string | null } {
  const j = jsonOrNull(res.body);
  const results = (j?.results && typeof j.results === "object" ? j.results : null) as Record<string, unknown> | null;
  const inner = results ? asString(results.status) : null;
  const outer = j ? asString(j.status) : null;
  if (res.status >= 200 && res.status < 300 && (inner ?? outer) !== "error") return { accepted: true, error: null };
  const why = (results && (asString(results.error) ?? asString(results.message))) ?? (j && (asString(j.error) ?? asString(j.message) ?? asString(j.cli_error))) ?? null;
  return { accepted: false, error: why ? `${why} (${res.status})` : `HTTP ${res.status}` };
}

/**
 * Wait for the gate to go down and come back. The probe is an unauthenticated
 * GET / — any HTTP answer, a redirect to the login page included, is "up".
 * Returns false when it was never seen to go down (the caller then verifies
 * anyway: a fast reboot between two polls looks exactly like that).
 */
async function waitForReboot(c: DeviceHttpClient, ctx: FirmwareEngineContext): Promise<{ wentDown: boolean; cameBack: boolean }> {
  const interval = Math.min(10_000, Math.max(1_000, ctx.timeouts.heartbeatMs));
  const up = async () => {
    try { await c.get("/", 5_000); return true; } catch { return false; }
  };
  let wentDown = false;
  const downBy = Date.now() + ctx.timeouts.rebootDownMs;
  while (Date.now() < downBy) {
    await sleep(interval, ctx.signal);
    if (!(await up())) { wentDown = true; break; }
  }
  if (!wentDown) return { wentDown: false, cameBack: true };
  ctx.onLog("info", "the FortiGate went down to reboot");
  const upBy = Date.now() + ctx.timeouts.rebootUpMs;
  while (Date.now() < upBy) {
    await sleep(interval, ctx.signal);
    if (await up()) return { wentDown: true, cameBack: true };
  }
  return { wentDown: true, cameBack: false };
}

export async function upgradeFortiGate(ctx: FirmwareEngineContext): Promise<FirmwareEngineResult> {
  const c = client(ctx);
  let deviceSerial: string | undefined;
  try {
    // ── preflight ────────────────────────────────────────────────────────
    ctx.onStage("preflight");
    ctx.onLog("info", `signing in to ${c.base} with ${usesToken(ctx) ? "the integration's API token" : `admin "${ctx.credential.username}"`}`);
    try {
      await gateLogin(c, ctx, ctx.timeouts.probeMs);
    } catch (err) {
      if (err instanceof DeviceConnectionError) throw new FirmwareEngineError(`FortiGate HTTPS unreachable at ${c.base} (${err.message})`, "preflight");
      throw err;
    }
    let before: FortiGateStatus;
    try {
      before = await gateStatus(c, ctx);
    } catch (err) {
      if (err instanceof DeviceConnectionError) throw new FirmwareEngineError(`FortiGate HTTPS unreachable at ${c.base} (${err.message})`, "preflight");
      throw err;
    }
    deviceSerial = before.serial ?? undefined;
    ctx.onLog("info", `FortiGate ${before.hostname ?? ctx.host}: serial ${before.serial ?? "?"}, running ${before.version ?? "unknown"}`);
    if (ctx.expectedSerial && before.serial && before.serial.toUpperCase() !== ctx.expectedSerial.toUpperCase()) {
      throw new FirmwareEngineError(`the device at ${ctx.host} reports serial ${before.serial}, not ${ctx.expectedSerial} — refusing to flash a device that is not this asset`, "preflight");
    }
    const haMode = await gateHaMode(c, ctx);
    if (haMode === null) throw new FirmwareEngineError("could not read the FortiGate's HA mode — refusing, since an HA upgrade reboots every cluster member", "preflight");
    if (haMode !== "standalone") throw new FirmwareEngineError(`the FortiGate is in an HA cluster (mode ${haMode}) — upgrading HA clusters is not supported yet`, "preflight");
    const running = parseFirmwareVersion(before.version);
    if (running && compareFirmwareVersions(running, ctx.image.version) >= 0) {
      ctx.onLog("info", `already at ${formatFirmwareVersion(running)} — nothing to do`);
      await gateLogout(c, ctx);
      return { outcome: "already-current", verifiedVersion: before.version ?? undefined, deviceSerial };
    }

    // ── upload (the upload IS the trigger) ───────────────────────────────
    ctx.onStage("staging");
    ctx.signal?.throwIfAborted();
    let lastPct = -1;
    const progress = (label: string) => (sent: number, total: number) => {
      const pct = Math.floor((sent / total) * 100);
      if (pct !== lastPct && pct % 10 === 0) { lastPct = pct; ctx.onLog("info", `${label} ${pct}%`); }
    };
    const send = async (how: "multipart" | "json"): Promise<{ accepted: boolean; error: string | null; status: number | null }> => {
      try {
        const res = how === "multipart"
          ? await c.postMultipart(UPGRADE_PATH, [{ name: "source", value: "upload" }], {
              field: "file", filename: basename(ctx.imagePath), path: ctx.imagePath, size: ctx.imageSize,
            }, progress("upload"))
          : await c.postJsonBase64File(UPGRADE_PATH, { source: "upload" }, "file_content", { path: ctx.imagePath, size: ctx.imageSize }, progress("upload (base64)"));
        if (res.status === 401 || res.status === 403) throw new AuthRejected(authMessage(ctx, res.status, "upgrade firmware"), "staging");
        return { ...readUpgradeAnswer(res), status: res.status };
      } catch (err) {
        if (err instanceof DeviceConnectionError && err.bodyFullySent) {
          ctx.onLog("info", `connection dropped after the upload completed (${err.message}) — the FortiGate has taken the image`);
          return { accepted: true, error: null, status: null };
        }
        if (err instanceof DeviceConnectionError) throw new FirmwareEngineError(`upload failed: ${err.message}`, "staging");
        throw err;
      }
    };
    let answer = await send("multipart");
    if (!answer.accepted) {
      ctx.onLog("warn", `the multipart upload was refused (${answer.error}); retrying once as JSON with the image base64-encoded`);
      lastPct = -1;
      const first = answer.error;
      answer = await send("json");
      if (!answer.accepted) throw new FirmwareEngineError(`the FortiGate refused the image: ${answer.error} (multipart: ${first})`, "staging");
    }
    ctx.onStage("deploying");
    ctx.onLog("info", "image accepted — the FortiGate is writing it and will reboot");

    // ── reboot ───────────────────────────────────────────────────────────
    ctx.onStage("rebooting");
    const reboot = await waitForReboot(c, ctx);
    if (!reboot.cameBack) {
      return { outcome: "unverified", deviceSerial, error: `the FortiGate went down to reboot and did not answer again within ${Math.round(ctx.timeouts.rebootUpMs / 60_000)} min` };
    }
    if (!reboot.wentDown) ctx.onLog("warn", `the FortiGate was never seen to go down within ${Math.round(ctx.timeouts.rebootDownMs / 60_000)} min — checking its version anyway`);

    // ── verify ───────────────────────────────────────────────────────────
    ctx.onStage("verifying");
    let lastSeen: string | null = null;
    let rejections = 0;
    for (let i = 0; i < ctx.timeouts.verifyRetries; i++) {
      try {
        await gateLogin(c, ctx);
        const after = await gateStatus(c, ctx);
        lastSeen = after.version;
        const v = parseFirmwareVersion(lastSeen);
        if (v && compareFirmwareVersions(v, ctx.image.version) === 0) {
          ctx.onLog("info", `the FortiGate is back at ${lastSeen}`);
          await gateLogout(c, ctx);
          return { outcome: "upgraded", verifiedVersion: lastSeen ?? undefined, deviceSerial: after.serial ?? deviceSerial };
        }
        ctx.onLog("warn", `the FortiGate reports ${lastSeen ?? "no version"}; expected ${ctx.image.versionLabel}`);
      } catch (err) {
        if (err instanceof AuthRejected && ++rejections >= MAX_AUTH_REJECTIONS) {
          return { outcome: "unverified", deviceSerial, error: `the FortiGate came back but refused to sign in twice (${err.message}) — stopped before the admin is locked out; check its version by hand` };
        }
        ctx.onLog("warn", `verify attempt ${i + 1} failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      await sleep(ctx.timeouts.verifyRetryDelayMs, ctx.signal);
    }
    return { outcome: "unverified", verifiedVersion: lastSeen ?? undefined, deviceSerial, error: `the FortiGate came back reporting ${lastSeen ?? "no version"}, not ${ctx.image.versionLabel}` };
  } catch (err) {
    if (err instanceof FirmwareEngineError) return { outcome: "failed", error: err.message, deviceSerial };
    if (err instanceof DeviceConnectionError) return { outcome: "failed", error: `FortiGate HTTPS unreachable at ${c.base} (${err.message})`, deviceSerial };
    if (err instanceof Error && err.name === "AbortError") return { outcome: "failed", error: "cancelled", deviceSerial };
    return { outcome: "failed", error: err instanceof Error ? err.message : String(err), deviceSerial };
  }
}
