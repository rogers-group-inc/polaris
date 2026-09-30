/**
 * src/services/firmwareEngines/fortiswitchHttps.ts — flash a FortiSwitch
 * through its own web UI (port 443), the fortiupgrade CLI's `switchHttp.ts`
 * transcribed step for step.
 *
 * On a FortiSwitch, uploading only STAGES the image; a separate deploy call
 * flashes it. Every endpoint, field, and quirk below was captured from a
 * browser session against real switches:
 *
 *   login      POST /login  (username, password, next_link) → 302 + cookie
 *   status     GET  /system/config/firmware/image?_=<ms>
 *              → os_version, build, serial_number, model, hostname,
 *                admin_timeout — and, WHILE FLASHING, erase_progress /
 *                write_progress / verify_progress / restart_progress /
 *                cur_step / tot_step. Never add `?cur_size`: that answers the
 *                upload byte count, not the version. Ignore `msg` ("Upgrade is
 *                done successfully!" on every poll) and `status` (always 0).
 *   stage      POST /api/v2/execute/upload/file  multipart, fields IN ORDER:
 *              upgrade_from=undefined, firmware_version=undefined, file_size,
 *              size, then the file in `file`. The literal "undefined" copies
 *              what the browser sends. ≤ 104857600 bytes. Must answer 2xx
 *              with JSON status === "success".
 *   compat     POST /system/config/firmware/compatible  action=check&account=true
 *              → { downgrade, check_signature, inc_adminpw, inc_snmppw }
 *   deploy     POST /system/config/firmware/deploy  file_size=<n>
 *              A dropped socket here is NOT a failure — the reboot began.
 *   cleanup    POST /system/config/firmware/compatible  action=reset
 *   logout     GET  /logout
 *
 * Timings observed: ~60 s to the first progress line, erase ~3m45s, write
 * ~3m30s, verify ~40 s, then the switch disappears. The 5-minute idle timeout
 * expires during that, so ONE re-login is allowed mid-poll.
 */

import type { FirmwareEngineContext, FirmwareEngineResult, FirmwareProgress } from "./types.js";
import { FirmwareEngineError, sleep } from "./types.js";
import { DeviceHttpClient, DeviceConnectionError, jsonOrNull, asString, asNumber } from "./deviceHttp.js";
import { parseFirmwareVersion, compareFirmwareVersions, formatFirmwareVersion } from "../../utils/firmwareVersion.js";
import { basename } from "node:path";

export const FORTISWITCH_MAX_IMAGE_BYTES = 104_857_600;

const IMAGE_PATH = "/system/config/firmware/image";
const UPLOAD_PATH = "/api/v2/execute/upload/file";
const COMPAT_PATH = "/system/config/firmware/compatible";
const DEPLOY_PATH = "/system/config/firmware/deploy";

export interface FortiSwitchStatus {
  osVersion: string | null;
  build: string | null;
  serial: string | null;
  model: string | null;
  hostname: string | null;
  adminTimeoutMin: number | null;
  progress: FirmwareProgress | null;
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

function loggedOut(res: { status: number; location: string | null; body: string }): boolean {
  if (res.status === 401 || res.status === 403) return true;
  if (res.status >= 300 && res.status < 400 && /\/login/i.test(res.location ?? "")) return true;
  if (res.status === 200 && /name="password"/i.test(res.body)) return true;
  return false;
}

/** "HTTP 302 → /login" — what the device actually answered, for an error a human reads. */
function answered(res: { status: number; location: string | null }): string {
  return `HTTP ${res.status}` + (res.location ? ` → ${res.location}` : "");
}

/**
 * Sign in. Throws a FirmwareEngineError with the reason on refusal.
 *
 * The WHERE of the login's redirect is not evidence either way — FortiSwitchOS
 * 7.6.6 answers a GOOD password with `302 Location: /login` (plus the
 * `APSCOOKIE_<n>` / `ssession` session cookies), and reading that as a refusal
 * turned every sign-in on those switches into "rejected the username or
 * password". fortiupgrade never looked at the target: a cookie must be set,
 * and a page that needs a session must then load. Same here, and a refusal
 * names what the switch answered so the next firmware's quirk is readable
 * from the run log instead of a curl session.
 */
export async function switchLogin(c: DeviceHttpClient, ctx: FirmwareEngineContext, timeoutMs = ctx.timeouts.commandMs): Promise<void> {
  c.clearSession();
  const res = await c.postForm("/login", [
    { name: "username", value: ctx.credential.username },
    { name: "password", value: ctx.credential.password },
    { name: "next_link", value: "" },
  ], timeoutMs);
  if (res.status === 403) throw new FirmwareEngineError(`the switch refused the login — locked out? (${answered(res)})`, "preflight");
  if (res.status === 401) throw new FirmwareEngineError(`the switch rejected the username or password (${answered(res)})`, "preflight");
  if (c.cookieCount() === 0) {
    throw new FirmwareEngineError(`the switch rejected the username or password — the login set no session cookie (${answered(res)})`, "preflight");
  }
  // A rejected login can still hand out a cookie, so only a page that needs a
  // session proves the login worked.
  const confirm = await c.get("/", timeoutMs);
  if (loggedOut(confirm)) {
    throw new FirmwareEngineError(
      `the switch rejected the username or password — the login answered ${answered(res)} and a page that needs a session answered ${answered(confirm)}`,
      "preflight",
    );
  }
}

/** GET the firmware status; null progress when the switch is not flashing. */
export async function switchStatus(c: DeviceHttpClient, _ctx: FirmwareEngineContext): Promise<FortiSwitchStatus> {
  const res = await c.get(`${IMAGE_PATH}?_=${Date.now()}`);
  if (loggedOut(res)) throw new FirmwareEngineError("session expired", "preflight");
  const j = jsonOrNull(res.body);
  if (res.status !== 200 || !j) throw new FirmwareEngineError(`unexpected status answer (${res.status})`, "preflight");
  const progress: FirmwareProgress = {};
  let any = false;
  // The switch reports each stage as a FRACTION, 0..1 — erase as an exact 1
  // once done, the others as long decimals (fortiupgrade's capture; confirmed
  // on prod, where a finished erase drew as "1%"). FirmwareProgress is a
  // PERCENT, 0..100, so convert here, at the one place the device is read,
  // clamped so a 1.0000000002 from some build never draws past full.
  for (const [k, key] of [["erase_progress", "erase"], ["write_progress", "write"], ["verify_progress", "verify"], ["restart_progress", "restart"]] as const) {
    const n = asNumber(j[k]);
    if (n !== null) { progress[key] = Math.round(Math.min(1, Math.max(0, n)) * 1000) / 10; any = true; }
  }
  // The step counter is carried for the run log only: observed pinned at 6/40
  // for an entire flash, so nothing displays or decides on it.
  for (const [k, key] of [["cur_step", "curStep"], ["tot_step", "totStep"]] as const) {
    const n = asNumber(j[k]);
    if (n !== null) progress[key] = n;
  }
  return {
    osVersion: asString(j.os_version),
    build: asString(j.build),
    serial: asString(j.serial_number),
    model: asString(j.model),
    hostname: asString(j.hostname),
    adminTimeoutMin: asNumber(j.admin_timeout),
    progress: any ? progress : null,
  };
}

function versionOf(st: FortiSwitchStatus): string | null {
  if (!st.osVersion) return null;
  // The UI reports os_version and build separately ("7.6.5" + "1105");
  // fold them so the compare can use the build.
  return st.build && !/build/i.test(st.osVersion) ? `${st.osVersion} build${st.build}` : st.osVersion;
}

export async function upgradeFortiSwitch(ctx: FirmwareEngineContext): Promise<FirmwareEngineResult> {
  if (ctx.imageSize > FORTISWITCH_MAX_IMAGE_BYTES) {
    return { outcome: "failed", error: `image is ${ctx.imageSize} bytes; the FortiSwitch upload endpoint takes at most ${FORTISWITCH_MAX_IMAGE_BYTES}` };
  }
  const c = client(ctx);
  let staged = false;
  let deployed = false;
  let deviceSerial: string | undefined;
  try {
    // ── preflight ────────────────────────────────────────────────────────
    ctx.onStage("preflight");
    try {
      await switchLogin(c, ctx, ctx.timeouts.probeMs);
    } catch (err) {
      if (err instanceof DeviceConnectionError) {
        throw new FirmwareEngineError(`device web UI unreachable at ${c.base} (${err.message})`, "preflight");
      }
      throw err;
    }
    const before = await switchStatus(c, ctx);
    deviceSerial = before.serial ?? undefined;
    ctx.onLog("info", `switch ${before.hostname ?? ctx.host}: model ${before.model ?? "?"}, serial ${before.serial ?? "?"}, running ${versionOf(before) ?? "unknown"}`);
    if (ctx.expectedSerial && before.serial && before.serial.toUpperCase() !== ctx.expectedSerial.toUpperCase()) {
      throw new FirmwareEngineError(`the device at ${ctx.host} reports serial ${before.serial}, not ${ctx.expectedSerial} — refusing to flash a device that is not this asset`, "preflight");
    }
    const running = parseFirmwareVersion(versionOf(before));
    if (running && compareFirmwareVersions(running, ctx.image.version) >= 0) {
      ctx.onLog("info", `already at ${formatFirmwareVersion(running)} — nothing to do`);
      await c.get("/logout").catch(() => undefined);
      return { outcome: "already-current", verifiedVersion: versionOf(before) ?? undefined, deviceSerial };
    }
    const imageMb = ctx.imageSize / (1024 * 1024);
    if (before.adminTimeoutMin !== null && before.adminTimeoutMin < imageMb / 60) {
      ctx.onLog("warn", `admin timeout is ${before.adminTimeoutMin} min; a ${imageMb.toFixed(0)} MB upload may outlive the session`);
    }

    // ── stage ────────────────────────────────────────────────────────────
    ctx.onStage("staging");
    ctx.signal?.throwIfAborted();
    let lastPct = -1;
    const up = await c.postMultipart(UPLOAD_PATH, [
      { name: "upgrade_from", value: "undefined" },
      { name: "firmware_version", value: "undefined" },
      { name: "file_size", value: String(ctx.imageSize) },
      { name: "size", value: String(ctx.imageSize) },
    ], { field: "file", filename: basename(ctx.imagePath), path: ctx.imagePath, size: ctx.imageSize }, (sent, total) => {
      const pct = Math.floor((sent / total) * 100);
      if (pct !== lastPct && pct % 10 === 0) { lastPct = pct; ctx.onLog("info", `upload ${pct}%`); }
    }).catch((err) => {
      // A dropped connection during staging IS a failure — nothing was flashed.
      throw new FirmwareEngineError(`upload failed: ${err instanceof Error ? err.message : String(err)}`, "staging");
    });
    if (loggedOut(up)) throw new FirmwareEngineError("the session expired during the upload", "staging");
    const upJson = jsonOrNull(up.body);
    if (up.status < 200 || up.status >= 300 || !upJson || upJson.status !== "success") {
      throw new FirmwareEngineError(`the switch did not accept the image (${up.status}${upJson?.status ? `, status ${String(upJson.status)}` : ""})`, "staging");
    }
    staged = true;
    const upSerial = asString(upJson.serial);
    if (upSerial && before.serial && upSerial.toUpperCase() !== before.serial.toUpperCase()) {
      throw new FirmwareEngineError(`the upload answer names serial ${upSerial}, not ${before.serial}`, "staging");
    }
    ctx.onLog("info", "image staged");

    // ── compatibility ────────────────────────────────────────────────────
    ctx.onStage("compat");
    const compat = await c.postForm(COMPAT_PATH, [{ name: "action", value: "check" }, { name: "account", value: "true" }]);
    const cj = jsonOrNull(compat.body) ?? {};
    if (String(cj.downgrade) === "true") throw new FirmwareEngineError("the switch reports this image as a DOWNGRADE — never flashed", "compat");
    if (String(cj.check_signature) === "false") throw new FirmwareEngineError("the switch could not verify the image signature", "compat");
    if (String(cj.inc_adminpw) === "false") ctx.onLog("warn", "the switch reports the admin password may not carry over");
    if (String(cj.inc_snmppw) === "false") ctx.onLog("warn", "the switch reports the SNMP community may not carry over");

    // ── deploy ───────────────────────────────────────────────────────────
    ctx.onStage("deploying");
    ctx.signal?.throwIfAborted();
    const deployedAt = Date.now();
    try {
      const dep = await c.postForm(DEPLOY_PATH, [{ name: "file_size", value: String(ctx.imageSize) }]);
      if (loggedOut(dep)) throw new FirmwareEngineError("the session expired before deploy", "deploying");
      if (dep.status >= 400) throw new FirmwareEngineError(`deploy refused (${dep.status})`, "deploying");
    } catch (err) {
      // The socket usually drops here: the switch has started erasing.
      if (!(err instanceof DeviceConnectionError)) throw err;
      ctx.onLog("info", `connection dropped on deploy (${err.message}) — the flash has started`);
    }
    deployed = true;

    // ── flash progress ───────────────────────────────────────────────────
    const deadline = deployedAt + ctx.timeouts.switchUpgradeMs;
    let reloggedIn = false;
    let sawProgress = false;
    let lastProgressKey = "";
    const pollMs = Math.min(10_000, Math.max(200, ctx.timeouts.heartbeatMs));
    while (Date.now() < deadline) {
      await sleep(pollMs, ctx.signal);
      let st: FortiSwitchStatus;
      try {
        st = await switchStatus(c, ctx);
      } catch (err) {
        if (err instanceof FirmwareEngineError && /session expired/.test(err.message) && !reloggedIn) {
          reloggedIn = true;
          ctx.onLog("info", "session expired during the flash — signing in once more");
          try { await switchLogin(c, ctx); continue; } catch { break; }
        }
        // Any other failure to read status means the switch has gone down to reboot.
        break;
      }
      if (st.progress) {
        sawProgress = true;
        const key = JSON.stringify(st.progress);
        if (key !== lastProgressKey) {
          lastProgressKey = key;
          ctx.onProgress({ ...st.progress, lastMsgAt: new Date().toISOString() });
        }
      }
    }
    if (!sawProgress) ctx.onLog("warn", "never saw flash progress from the switch — waiting for it to reboot regardless");

    // ── reboot ───────────────────────────────────────────────────────────
    ctx.onStage("rebooting");
    const upAgain = await waitForReboot(c, ctx, Math.max(0, deadline - Date.now()));
    if (!upAgain) {
      return { outcome: "unverified", deviceSerial, error: "the switch did not answer again within the upgrade budget" };
    }

    // ── verify ───────────────────────────────────────────────────────────
    ctx.onStage("verifying");
    const verifyDeadline = Date.now() + ctx.timeouts.verifyRetries * (ctx.timeouts.verifyRetryDelayMs + ctx.timeouts.commandMs);
    let authRejections = 0;
    let lastSeen: string | null = null;
    while (Date.now() < verifyDeadline) {
      try {
        await switchLogin(c, ctx);
        const after = await switchStatus(c, ctx);
        lastSeen = versionOf(after);
        const v = parseFirmwareVersion(lastSeen);
        if (v && compareFirmwareVersions(v, ctx.image.version) === 0) {
          ctx.onLog("info", `switch is back at ${lastSeen}`);
          await c.get("/logout").catch(() => undefined);
          return { outcome: "upgraded", verifiedVersion: lastSeen ?? undefined, deviceSerial: after.serial ?? deviceSerial };
        }
        ctx.onLog("warn", `switch reports ${lastSeen ?? "no version"}; expected ${ctx.image.versionLabel}`);
      } catch (err) {
        if (err instanceof FirmwareEngineError && /rejected the username|refused the login/.test(err.message)) {
          authRejections += 1;
          if (authRejections >= 2) {
            return { outcome: "unverified", deviceSerial, error: "the switch came back but rejected the login twice — stopping before the account locks" };
          }
        }
      }
      await sleep(ctx.timeouts.verifyRetryDelayMs, ctx.signal);
    }
    return { outcome: "unverified", verifiedVersion: lastSeen ?? undefined, deviceSerial, error: `the switch came back reporting ${lastSeen ?? "no version"}, not ${ctx.image.versionLabel}` };
  } catch (err) {
    if (staged && !deployed) {
      // Un-stage so the next attempt starts clean.
      await c.postForm(COMPAT_PATH, [{ name: "action", value: "reset" }]).catch(() => undefined);
    }
    if (err instanceof FirmwareEngineError) return { outcome: "failed", error: err.message, deviceSerial };
    if (err instanceof DeviceConnectionError) return { outcome: "failed", error: `device web UI unreachable at ${c.base} (${err.message})`, deviceSerial };
    if (err instanceof Error && err.name === "AbortError") return { outcome: "failed", error: "cancelled", deviceSerial };
    return { outcome: "failed", error: err instanceof Error ? err.message : String(err), deviceSerial };
  }
}

/**
 * Wait for the switch to stop answering, then to answer again. Any HTTP
 * answer on GET /login counts as up. Not seeing it go DOWN is not a failure —
 * the poll may simply have missed the window.
 */
async function waitForReboot(c: DeviceHttpClient, ctx: FirmwareEngineContext, budgetMs: number): Promise<boolean> {
  const start = Date.now();
  const downBy = start + Math.min(ctx.timeouts.rebootDownMs, budgetMs);
  const interval = Math.min(10_000, Math.max(1_000, ctx.timeouts.heartbeatMs));
  let wentDown = false;
  while (Date.now() < downBy) {
    try {
      await c.get("/login", 5_000);
    } catch {
      wentDown = true;
      break;
    }
    await sleep(interval, ctx.signal);
  }
  if (!wentDown) ctx.onLog("info", "did not see the switch go down — it may have rebooted between polls");
  else ctx.onLog("info", "switch is rebooting");
  const upBy = Math.min(start + budgetMs, Date.now() + ctx.timeouts.rebootUpMs);
  while (Date.now() < upBy) {
    await sleep(interval, ctx.signal);
    try {
      await c.get("/login", 5_000);
      ctx.onLog("info", "switch is answering again");
      return true;
    } catch {
      /* still down */
    }
  }
  return false;
}
