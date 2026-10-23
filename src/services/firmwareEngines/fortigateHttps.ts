/**
 * src/services/firmwareEngines/fortigateHttps.ts — flash a FortiGate through
 * its own FortiOS REST API over HTTPS (business rule 87).
 *
 * Lab-validated 2026-10-06 on two FortiGate 61F, FortiOS 7.6.7 build3704 →
 * 8.0.1 build245 (the FGT_61F-v8.0.1.F-build0245 .out, 99.7 MB): one through
 * the bearer token, one through the admin login. Both took the MULTIPART
 * upload (the JSON-base64 retry never fired), went down ~30 s after the
 * upload answered, and answered on the new version ~4 min later. What that
 * run corrected is marked "seen on 7.6.7" below. Older login paths and the
 * base64 retry are still unproven on hardware.
 *
 * Two ways in, chosen by the Repository binding:
 *
 *   token   `Authorization: Bearer <api token>` — the integration's REST API
 *           admin. Its profile needs System read-write (firmware upgrade is
 *           a `sysgrp` write); a 403 says so.
 *   login   POST /api/v2/authentication, JSON { username, password } (7.4+,
 *           seen on 7.6.7). The verdict is the body's `status_message` —
 *           LOGIN_SUCCESS, or LOGIN_FAILED with session and CSRF cookies SET
 *           anyway, so a cookie proves nothing. The CSRF cookie is
 *           `ccsrf_token_<port>_<hash>` there (`ccsrftoken[_<port>_<id>]` on
 *           older builds); its value is echoed as `X-CSRFTOKEN`. Logout is
 *           DELETE on the same path. A build with no such endpoint (401 /
 *           404 / not JSON) falls back to POST /logincheck ajax=1, username,
 *           secretkey — which on 7.6.7 answers 200 with the login page and no
 *           cookies whatever the password. An admin with two-factor, a
 *           pre-login disclaimer or a forced password change is refused at
 *           preflight, never retried (each attempt counts toward the lockout).
 *
 *   status   GET  /api/v2/monitor/system/status → envelope serial, version
 *            ("v7.6.7"), build
 *   ha       GET  /api/v2/cmdb/system/ha → mode. "standalone" is a plain
 *            gate. An a-p cluster is upgraded as one device through its
 *            PRIMARY when the runner says so (`ctx.cluster`, rule 129): every
 *            member present (ha-peer), configs in sync (ha-checksums), this
 *            unit flagged primary. FortiOS then upgrades the secondary, fails
 *            over, and reboots this unit — holding the upload's answer until
 *            the failover (`uploadAnswerMs`). Any other mode is refused.
 *   upgrade  POST /api/v2/monitor/system/firmware/upgrade, source=upload.
 *            Sent as multipart (`file` field, streamed, no inflation); if the
 *            gate answers that with a non-auth error, sent ONCE more as JSON
 *            with `file_content` base64-encoded on the fly (~4/3 the size).
 *            A connection dropped after the whole body went counts as taken
 *            — the gate reboots as soon as it has written the image.
 *   reboot   unauthenticated GET / until it stops answering, then until it
 *            answers again
 *   verify   status again (re-login on the login path) until the version
 *            matches the image; a cluster then waits for every member to be
 *            back, in sync, and (ha-history) rejoined since the flash began
 */

import { basename } from "node:path";
import type { FirmwareEngineContext, FirmwareEngineResult } from "./types.js";
import { FirmwareEngineError, sleep } from "./types.js";
import { DeviceHttpClient, DeviceConnectionError, jsonOrNull, asString, asNumber, type DeviceHttpResponse } from "./deviceHttp.js";
import { parseFirmwareVersion, compareFirmwareVersions, formatFirmwareVersion } from "../../utils/firmwareVersion.js";

const AUTH_PATH = "/api/v2/authentication";
const LOGIN_PATH = "/logincheck";
const LOGOUT_PATH = "/logout";
const STATUS_PATH = "/api/v2/monitor/system/status";
const HA_PATH = "/api/v2/cmdb/system/ha";
const UPGRADE_PATH = "/api/v2/monitor/system/firmware/upgrade";
// `ccsrftoken`, `ccsrftoken_<port>_<id>` (7.2) and `ccsrf_token_<port>_<hash>`
// (7.6.7 — its /api/v2/service/login-config names it as ccsrf_token_cookie_name).
const CSRF_COOKIE = /^ccsrf_?token/i;
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
    expectedSerial: ctx.expectedSerial,
    scheme: ctx.scheme ?? "https",
    commandMs: ctx.timeouts.commandMs,
    uploadIdleMs: ctx.timeouts.uploadIdleMs,
    uploadAnswerMs: ctx.timeouts.uploadAnswerMs,
    verifyTls: ctx.verifyTls === true,
  });
  if (ctx.bearerToken) c.setHeader("authorization", `Bearer ${ctx.bearerToken}`);
  return c;
}

function usesToken(ctx: FirmwareEngineContext): boolean {
  return !!ctx.bearerToken;
}

class AuthRejected extends FirmwareEngineError {}

/** Which login a client's session came from, so logout uses the matching call. */
const loginStyle = new WeakMap<DeviceHttpClient, "api" | "legacy">();

const NO_SESSION_HINT =
  "wrong username or password, a locked-out admin, or an admin account that needs two-factor, " +
  "a disclaimer or a password change (use an API token binding instead)";

function echoCsrf(c: DeviceHttpClient): boolean {
  const csrf = c.cookieMatching(CSRF_COOKIE);
  if (csrf) c.setHeader("X-CSRFTOKEN", csrf.replace(/^"|"$/g, ""));
  return !!csrf;
}

/**
 * Sign in with the bound admin login. A no-op on the token path.
 *
 * FortiOS 7.4+ signs a browser in with POST /api/v2/authentication, JSON
 * `{ username, password }`, and says whether it worked in the BODY
 * (`status_message: "LOGIN_SUCCESS"`) — it sets session and CSRF cookies even
 * on LOGIN_FAILED, so a cookie proves nothing. Seen on a FortiGate 61F, 7.6.7
 * (2026-10-06), where /logincheck answers 200 with the login page and no
 * cookies whatever the password. Older builds have no such endpoint (404, or
 * a non-JSON answer), and fall back to /logincheck.
 */
export async function gateLogin(c: DeviceHttpClient, ctx: FirmwareEngineContext, timeoutMs = ctx.timeouts.commandMs): Promise<void> {
  if (usesToken(ctx)) return;
  c.clearSession();
  const res = await c.postJson(AUTH_PATH, { username: ctx.credential.username, password: ctx.credential.password }, timeoutMs);
  const j = jsonOrNull(res.body);
  const verdict = j ? asString(j.status_message) : null;
  if (res.status === 200 && verdict) {
    if (verdict === "LOGIN_SUCCESS") {
      loginStyle.set(c, "api");
      if (!echoCsrf(c)) throw new FirmwareEngineError("the FortiGate signed the admin in but issued no CSRF cookie", "preflight");
      return;
    }
    if (verdict === "LOGIN_FAILED") throw new AuthRejected(`the FortiGate refused the login (LOGIN_FAILED) — ${NO_SESSION_HINT}`, "preflight");
    // Two-factor, a disclaimer, a forced password change: a prompt this engine cannot answer.
    throw new AuthRejected(`the FortiGate wants more than a password for this admin (${verdict}) — use an API token binding, or an admin without two-factor or a pre-login disclaimer`, "preflight");
  }

  // Pre-7.4: the form login. Only a JSON verdict above decides anything — an
  // older build answers an unknown /api/v2 path with 401 or 404, which says
  // nothing about the password.
  c.clearSession();
  const legacy = await c.postForm(LOGIN_PATH, [
    { name: "ajax", value: "1" },
    { name: "username", value: ctx.credential.username },
    { name: "secretkey", value: ctx.credential.password },
  ], timeoutMs);
  if (legacy.status === 401 || legacy.status === 403) throw new AuthRejected("the FortiGate rejected the login", "preflight");
  if (legacy.status < 200 || legacy.status >= 400) throw new FirmwareEngineError(`unexpected login answer (${legacy.status})`, "preflight");
  if (!echoCsrf(c)) throw new AuthRejected(`the FortiGate did not open a session for that login — ${NO_SESSION_HINT}`, "preflight");
  loginStyle.set(c, "legacy");
}

async function gateLogout(c: DeviceHttpClient, ctx: FirmwareEngineContext): Promise<void> {
  if (usesToken(ctx)) return;
  if (loginStyle.get(c) === "api") await c.delete(AUTH_PATH, 5_000).catch(() => undefined);
  else await c.postEmpty(LOGOUT_PATH, 5_000).catch(() => undefined);
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

// ─── HA clusters (business rule 129) ────────────────────────────────────────

const HA_PEER_PATH = "/api/v2/monitor/system/ha-peer";
const HA_CHECKSUMS_PATH = "/api/v2/monitor/system/ha-checksums";
const HA_HISTORY_PATH = "/api/v2/monitor/system/ha-history";
/** The only cluster mode an upgrade has been proven on (a 61F pair, 2026-10-23). */
const HA_UPGRADABLE_MODES = new Set(["a-p"]);

export interface ClusterState {
  /** Every member the cluster reports right now, by serial (upper case). */
  members: string[];
  /** The serial ha-peer flags as primary, or null. */
  primary: string | null;
  /** Every member's whole-config checksum is present and identical. */
  inSync: boolean;
}

/**
 * The cluster as the unit we are talking to sees it: `ha-peer` (members and
 * the primary flag; no addresses, no versions) and `ha-checksums` (config
 * sync). Seen on 7.6.7 / 7.6.8.
 */
export async function gateClusterState(c: DeviceHttpClient, ctx: FirmwareEngineContext): Promise<ClusterState> {
  const peers = await c.get(HA_PEER_PATH);
  if (peers.status === 401 || peers.status === 403) throw new AuthRejected(authMessage(ctx, peers.status, "read the HA cluster"), "preflight");
  const pj = jsonOrNull(peers.body);
  const rows = Array.isArray(pj?.results) ? (pj!.results as Array<Record<string, unknown>>) : [];
  const members = rows.map((r) => asString(r.serial_no)).filter((s): s is string => !!s).map((s) => s.toUpperCase());
  const prim = rows.find((r) => r.primary === true || r.master === true);
  const primary = prim ? (asString(prim.serial_no)?.toUpperCase() ?? null) : null;

  const sums = await c.get(HA_CHECKSUMS_PATH);
  const sj = jsonOrNull(sums.body);
  const sumRows = Array.isArray(sj?.results) ? (sj!.results as Array<Record<string, unknown>>) : [];
  const alls = sumRows.map((r) => {
    const cs = (r.checksum && typeof r.checksum === "object" ? r.checksum : {}) as Record<string, unknown>;
    return asString(cs.all);
  });
  const inSync = alls.length >= 2 && alls.every((x) => !!x && x === alls[0]);
  return { members, primary, inSync };
}

/**
 * The cluster's own event log, in the GATE's clock: its newest event time and
 * which serials it says joined the cluster after `since`. A member that
 * rebooted onto the new image rejoins, so a join after the flash began is the
 * reboot's evidence — no endpoint reports another member's version. null when
 * the build has no such log.
 */
export async function gateHaHistory(c: DeviceHttpClient, since: number | null): Promise<{ newest: number; joinedSince: Set<string> } | null> {
  const res = await c.get(HA_HISTORY_PATH).catch(() => null);
  const j = res && res.status === 200 ? jsonOrNull(res.body) : null;
  const r = (j?.results && typeof j.results === "object" ? j.results : null) as Record<string, unknown> | null;
  if (!r || !Array.isArray(r.history)) return null;
  let newest = asNumber(r.last_change) ?? 0;
  const joinedSince = new Set<string>();
  for (const e of r.history as Array<Record<string, unknown>>) {
    const t = asNumber(e.time) ?? 0;
    if (t > newest) newest = t;
    const ev = asString(e.event) ?? "";
    const m = /new member '([A-Za-z0-9]+)' joins the cluster/.exec(ev);
    if (m && since !== null && t > since) joinedSince.add(m[1]!.toUpperCase());
  }
  return { newest, joinedSince };
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

/**
 * Rule 129: after the primary is back on the image, wait for the whole cluster.
 * Done = every member Polaris knew is back in the cluster, their configs are
 * in sync, and every OTHER member logged a rejoin after the flash began (in
 * the gate's clock). FortiOS reboots the primary only after its secondaries
 * have upgraded, so with the primary verified on the image these prove the
 * cluster went through; no endpoint reports another member's version. A
 * build with no HA history is judged on membership and sync alone, and says so.
 */
async function verifyCluster(c: DeviceHttpClient, ctx: FirmwareEngineContext, since: number | null, self: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const expected = (ctx.cluster?.memberSerials ?? []).map((s) => s.toUpperCase());
  const others = expected.filter((s) => s !== self);
  const deadline = Date.now() + ctx.timeouts.clusterSettleMs;
  let last = "no answer yet";
  ctx.onLog("info", `waiting for the cluster to settle: ${expected.join(", ")} back and in sync`);
  let warnedNoHistory = false;
  for (;;) {
    try {
      await gateLogin(c, ctx);
      const cs = await gateClusterState(c, ctx);
      const hist = since === null ? null : await gateHaHistory(c, since);
      const missing = expected.filter((s) => !cs.members.includes(s));
      const notRejoined = hist ? others.filter((s) => !hist.joinedSince.has(s)) : [];
      if (!hist && !warnedNoHistory) {
        warnedNoHistory = true;
        ctx.onLog("warn", "the gate keeps no readable HA history, so the other members' reboots cannot be confirmed — judging the cluster on membership and sync");
      }
      if (missing.length === 0 && cs.inSync && notRejoined.length === 0) {
        ctx.onLog("info", `the cluster is whole and in sync (${cs.members.join(", ")}; primary ${cs.primary ?? "?"})`);
        return { ok: true };
      }
      last = [
        missing.length ? `${missing.join(", ")} not in the cluster` : "",
        !cs.inSync ? "members not in sync" : "",
        notRejoined.length ? `${notRejoined.join(", ")} has not rejoined since the flash began` : "",
      ].filter(Boolean).join("; ");
      ctx.onLog("info", `cluster not settled yet: ${last}`);
    } catch (err) {
      // A single dropped call is normal right after a member rejoins (seen on a 61F pair).
      last = err instanceof Error ? err.message : String(err);
      ctx.onLog("warn", `cluster check failed (${last}) — retrying`);
    }
    if (Date.now() >= deadline) break;
    await sleep(ctx.timeouts.verifyRetryDelayMs, ctx.signal);
  }
  return { ok: false, error: `the primary is on ${ctx.image.versionLabel} but the cluster did not settle within ${Math.round(ctx.timeouts.clusterSettleMs / 60_000)} min (${last}) — check the other member` };
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
    // Rule 129: a cluster is upgraded as one device, through its primary, and
    // only when it is whole and in sync. Discovery's record can lag the gate,
    // so the gate's own answers decide here.
    let haSince: number | null = null;
    if (haMode !== "standalone") {
      if (!ctx.cluster) {
        throw new FirmwareEngineError(`the FortiGate is in an HA cluster (mode ${haMode}) but Polaris has it recorded as a standalone gate — run discovery, then upgrade the cluster from its primary's card`, "preflight");
      }
      if (!HA_UPGRADABLE_MODES.has(haMode)) {
        throw new FirmwareEngineError(`the cluster runs HA mode ${haMode} — Polaris upgrades active-passive (a-p) clusters only so far`, "preflight");
      }
      const cs = await gateClusterState(c, ctx);
      const self = (before.serial ?? "").toUpperCase();
      if (!self || cs.primary !== self) {
        throw new FirmwareEngineError(`this member is not the cluster's primary (the primary is ${cs.primary ?? "unknown"}) — a cluster upgrade goes through its primary`, "preflight");
      }
      const missing = ctx.cluster.memberSerials.map((s) => s.toUpperCase()).filter((s) => !cs.members.includes(s));
      if (missing.length > 0) {
        throw new FirmwareEngineError(`cluster member ${missing.join(", ")} is not in the cluster right now — a cluster upgrade needs every member up`, "preflight");
      }
      if (!cs.inSync) throw new FirmwareEngineError("the cluster's members are not in sync (their configuration checksums differ) — fix the cluster before upgrading it", "preflight");
      const hist = await gateHaHistory(c, null);
      haSince = hist?.newest ?? null;
      ctx.onLog("info", `HA cluster (${haMode}): ${cs.members.length} members (${cs.members.join(", ")}), in sync, this unit is the primary. FortiOS upgrades the secondary first, fails over to it, then reboots this unit.`);
    } else if (ctx.cluster) {
      ctx.onLog("warn", "Polaris has this gate recorded as an HA member, but the gate says standalone — upgrading it as a standalone gate");
    }
    const clusterRun = haMode !== "standalone" && !!ctx.cluster;
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
    if (clusterRun) {
      ctx.onLog("info", `the primary answers only once its secondary has upgraded and the cluster has failed over — allowing up to ${Math.round(ctx.timeouts.uploadAnswerMs / 60_000)} min`);
    }
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
          if (clusterRun) {
            const settled = await verifyCluster(c, ctx, haSince, (after.serial ?? deviceSerial ?? "").toUpperCase());
            await gateLogout(c, ctx);
            if (!settled.ok) return { outcome: "unverified", verifiedVersion: lastSeen ?? undefined, deviceSerial: after.serial ?? deviceSerial, error: settled.error };
            return { outcome: "upgraded", verifiedVersion: lastSeen ?? undefined, deviceSerial: after.serial ?? deviceSerial };
          }
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
