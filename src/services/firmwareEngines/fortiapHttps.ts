/**
 * src/services/firmwareEngines/fortiapHttps.ts — flash a FortiAP through its
 * own web UI (port 443, the "kore" web server), the fortiupgrade CLI's
 * `apHttp.ts` transcribed step for step.
 *
 * This works on a STANDALONE access point. A FortiGate-managed FortiAP usually
 * has its local UI disabled, and the probe below fails fast with "device web
 * UI unreachable" — expected, documented, not a bug (business rule 87).
 *
 *   probe    POST /logincheck (no body) → 200 / 401 / 403 = an AP UI is there
 *   login    POST /logincheck  username, secretkey → cookie FORTIPASS and,
 *            on some builds, an X-CSRF-TOKEN response header. Echo the token
 *            ONLY if the AP issued one (a FAP-234F issues none). 401 = bad
 *            credentials, 403 = locked out.
 *   status   GET  /api/v1/sys-status → firmware_version, serial_number, hostname
 *   upgrade  POST /api/v1/upgrade-image  multipart, ONE field `image`. This
 *            single request does the whole upgrade: 202 = accepted, and a
 *            connection dropped AFTER the full body was sent also counts. 400
 *            = the image was rejected.
 *   reboot   poll GET /api/v1/sys-perf with the OLD session until it answers
 *            401/403 — that proves the AP restarted. Do NOT log in again
 *            during this wait.
 *   verify   fresh login + sys-status until the version matches.
 *   logout   POST /logout
 */

import type { FirmwareEngineContext, FirmwareEngineResult } from "./types.js";
import { FirmwareEngineError, sleep } from "./types.js";
import { DeviceHttpClient, DeviceConnectionError, jsonOrNull, asString } from "./deviceHttp.js";
import { parseFirmwareVersion, compareFirmwareVersions, formatFirmwareVersion } from "../../utils/firmwareVersion.js";
import { basename } from "node:path";

const LOGIN_PATH = "/logincheck";
const STATUS_PATH = "/api/v1/sys-status";
const PERF_PATH = "/api/v1/sys-perf";
const UPGRADE_PATH = "/api/v1/upgrade-image";
const CSRF_HEADER = "x-csrf-token";

export interface FortiApStatus {
  firmwareVersion: string | null;
  serial: string | null;
  hostname: string | null;
}

function client(ctx: FirmwareEngineContext): DeviceHttpClient {
  return new DeviceHttpClient({
    host: ctx.host,
    port: ctx.port,
    scheme: ctx.scheme ?? "https",
    commandMs: ctx.timeouts.commandMs,
    uploadIdleMs: ctx.timeouts.uploadIdleMs,
  });
}

/** True when SOMETHING answered /logincheck — the AP has a local UI. */
export async function apProbe(c: DeviceHttpClient, ctx: FirmwareEngineContext): Promise<boolean> {
  const res = await c.postEmpty(LOGIN_PATH, ctx.timeouts.probeMs);
  return res.status === 200 || res.status === 401 || res.status === 403;
}

export async function apLogin(c: DeviceHttpClient, ctx: FirmwareEngineContext): Promise<void> {
  c.clearSession();
  const res = await c.postForm(LOGIN_PATH, [
    { name: "username", value: ctx.credential.username },
    { name: "secretkey", value: ctx.credential.password },
  ]);
  if (res.status === 401) throw new FirmwareEngineError("the access point rejected the username or password", "preflight");
  if (res.status === 403) throw new FirmwareEngineError("the access point refused the login (locked out)", "preflight");
  if (res.status < 200 || res.status >= 400) throw new FirmwareEngineError(`unexpected login answer (${res.status})`, "preflight");
  if (!c.hasCookie("FORTIPASS")) throw new FirmwareEngineError("the access point did not issue a session", "preflight");
  const token = res.headers[CSRF_HEADER];
  c.setHeader("X-CSRF-TOKEN", typeof token === "string" && token ? token : null);
}

export async function apStatus(c: DeviceHttpClient): Promise<FortiApStatus> {
  const res = await c.get(STATUS_PATH);
  if (res.status === 401 || res.status === 403) throw new FirmwareEngineError("session expired", "preflight");
  const j = jsonOrNull(res.body);
  if (res.status !== 200 || !j) throw new FirmwareEngineError(`unexpected status answer (${res.status})`, "preflight");
  return {
    firmwareVersion: asString(j.firmware_version),
    serial: asString(j.serial_number),
    hostname: asString(j.hostname),
  };
}

export async function upgradeFortiAp(ctx: FirmwareEngineContext): Promise<FirmwareEngineResult> {
  const c = client(ctx);
  let deviceSerial: string | undefined;
  try {
    // ── preflight ────────────────────────────────────────────────────────
    ctx.onStage("preflight");
    let present: boolean;
    try {
      present = await apProbe(c, ctx);
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err);
      throw new FirmwareEngineError(`device web UI unreachable at ${c.base} (${why}) — a FortiGate-managed AP usually has its local UI disabled`, "preflight");
    }
    if (!present) throw new FirmwareEngineError(`nothing at ${c.base} answers like a FortiAP web UI`, "preflight");
    await apLogin(c, ctx);
    const before = await apStatus(c);
    deviceSerial = before.serial ?? undefined;
    ctx.onLog("info", `access point ${before.hostname ?? ctx.host}: serial ${before.serial ?? "?"}, running ${before.firmwareVersion ?? "unknown"}`);
    if (ctx.expectedSerial && before.serial && before.serial.toUpperCase() !== ctx.expectedSerial.toUpperCase()) {
      throw new FirmwareEngineError(`the device at ${ctx.host} reports serial ${before.serial}, not ${ctx.expectedSerial} — refusing to flash a device that is not this asset`, "preflight");
    }
    const running = parseFirmwareVersion(before.firmwareVersion);
    if (running && compareFirmwareVersions(running, ctx.image.version) >= 0) {
      ctx.onLog("info", `already at ${formatFirmwareVersion(running)} — nothing to do`);
      await c.postEmpty("/logout").catch(() => undefined);
      return { outcome: "already-current", verifiedVersion: before.firmwareVersion ?? undefined, deviceSerial };
    }

    // ── upgrade (upload IS the trigger) ──────────────────────────────────
    ctx.onStage("staging");
    ctx.signal?.throwIfAborted();
    let lastPct = -1;
    let accepted = false;
    try {
      const res = await c.postMultipart(UPGRADE_PATH, [], {
        field: "image", filename: basename(ctx.imagePath), path: ctx.imagePath, size: ctx.imageSize,
      }, (sent, total) => {
        const pct = Math.floor((sent / total) * 100);
        if (pct !== lastPct && pct % 10 === 0) { lastPct = pct; ctx.onLog("info", `upload ${pct}%`); }
      });
      if (res.status === 400) throw new FirmwareEngineError("the access point rejected the image", "staging");
      if (res.status === 401 || res.status === 403) throw new FirmwareEngineError("the session expired during the upload", "staging");
      if (res.status === 202 || (res.status >= 200 && res.status < 300)) accepted = true;
      else throw new FirmwareEngineError(`unexpected upgrade answer (${res.status})`, "staging");
    } catch (err) {
      if (err instanceof DeviceConnectionError && err.bodyFullySent) {
        // The AP starts flashing the moment the body is in and drops us.
        accepted = true;
        ctx.onLog("info", `connection dropped after the upload completed (${err.message}) — the AP has taken the image`);
      } else if (err instanceof DeviceConnectionError) {
        throw new FirmwareEngineError(`upload failed: ${err.message}`, "staging");
      } else {
        throw err;
      }
    }
    if (!accepted) throw new FirmwareEngineError("the access point did not accept the image", "staging");
    ctx.onStage("deploying");
    ctx.onLog("info", "image accepted — the access point is flashing and will reboot");

    // ── reboot: the OLD session must start failing ───────────────────────
    ctx.onStage("rebooting");
    const budget = ctx.timeouts.rebootDownMs + ctx.timeouts.rebootUpMs;
    const interval = Math.min(10_000, Math.max(1_000, ctx.timeouts.heartbeatMs));
    const deadline = Date.now() + budget;
    let restarted = false;
    while (Date.now() < deadline) {
      await sleep(interval, ctx.signal);
      try {
        const res = await c.get(PERF_PATH, 5_000);
        if (res.status === 401 || res.status === 403) { restarted = true; break; }
      } catch {
        // Down — keep waiting; a 401 once it is back is the proof.
      }
    }
    if (!restarted) {
      return { outcome: "unverified", deviceSerial, error: "the access point never invalidated the old session — it may not have rebooted" };
    }
    ctx.onLog("info", "access point restarted");

    // ── verify ───────────────────────────────────────────────────────────
    ctx.onStage("verifying");
    let lastSeen: string | null = null;
    for (let i = 0; i < ctx.timeouts.verifyRetries; i++) {
      try {
        await apLogin(c, ctx);
        const after = await apStatus(c);
        lastSeen = after.firmwareVersion;
        const v = parseFirmwareVersion(lastSeen);
        if (v && compareFirmwareVersions(v, ctx.image.version) === 0) {
          ctx.onLog("info", `access point is back at ${lastSeen}`);
          await c.postEmpty("/logout").catch(() => undefined);
          return { outcome: "upgraded", verifiedVersion: lastSeen ?? undefined, deviceSerial: after.serial ?? deviceSerial };
        }
        ctx.onLog("warn", `access point reports ${lastSeen ?? "no version"}; expected ${ctx.image.versionLabel}`);
      } catch (err) {
        ctx.onLog("warn", `verify attempt ${i + 1} failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      await sleep(ctx.timeouts.verifyRetryDelayMs, ctx.signal);
    }
    return { outcome: "unverified", verifiedVersion: lastSeen ?? undefined, deviceSerial, error: `the access point came back reporting ${lastSeen ?? "no version"}, not ${ctx.image.versionLabel}` };
  } catch (err) {
    if (err instanceof FirmwareEngineError) return { outcome: "failed", error: err.message, deviceSerial };
    if (err instanceof DeviceConnectionError) return { outcome: "failed", error: `device web UI unreachable at ${c.base} (${err.message})`, deviceSerial };
    if (err instanceof Error && err.name === "AbortError") return { outcome: "failed", error: "cancelled", deviceSerial };
    return { outcome: "failed", error: err instanceof Error ? err.message : String(err), deviceSerial };
  }
}
