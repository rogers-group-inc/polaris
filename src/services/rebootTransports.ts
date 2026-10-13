/**
 * src/services/rebootTransports.ts — how a reboot reaches a FortiGate
 * (business rule 114). The protocol half of the reboot runner: no Prisma, no
 * Events, no holds — a link in, a few operations out.
 *
 * Four links, all answering to one `GateOps` surface:
 *
 *   token      FortiOS REST with an API token, through `fgRequest` — the one
 *              paced, 401-pausing path every direct FortiOS REST call takes
 *              (business rule 96). A REST API credential's token, or a
 *              standalone FortiGate integration's / FortiManager's direct-mode
 *              FortiGate token.
 *   login      FortiOS REST with a device admin login (an `http` credential in
 *              form mode), signed in exactly as the firmware engine signs in
 *              (`gateLogin`: POST /api/v2/authentication, then /logincheck).
 *   fmg-proxy  FortiOS REST relayed by FortiManager's /sys/proxy/json, keyed
 *              by the gate's FortiManager DEVICE NAME — the name a child's
 *              `controllerFortigate` stamp carries (see fortinetParentKey's
 *              header: an API call keeps using the name).
 *   ssh        The FortiOS CLI over an interactive SSH shell: `execute reboot`,
 *              `execute switch-controller switch-action restart swtp <id>`,
 *              `execute wireless-controller reset-wtp <serial>` — each
 *              confirmation prompt answered "y".
 *
 * Endpoints, all lab-verified on FortiOS 7.6.7 build3704 and 8.0.1 build245
 * from the gate's own `/api/v2/monitor/?action=schema` (2026-10-13):
 *
 *   POST /api/v2/monitor/system/os/reboot          { event_log_message }
 *   POST /api/v2/monitor/switch-controller/managed-switch/restart  { mkey: <switch-id> }
 *   POST /api/v2/monitor/wifi/managed_ap/restart   { wtpname: <wtp-id> }
 *   GET  /api/v2/monitor/web-ui/state              → results.utc_last_reboot (ms)
 *
 * `mkey` is the switch's NAME (its switch-id), which a FortiLink fleet may
 * rename away from the serial — so the runner looks the device up on the
 * gate by SERIAL first, which also proves the gate manages it.
 *
 * A reboot request is the one call whose answer may never arrive: the box can
 * drop the connection as it goes down. `RebootSendError` is a clear refusal
 * (an HTTP error, an auth failure, a CLI error); a lost answer is returned as
 * `{ uncertain }` and the runner decides by watching for the reboot.
 */

import { fgRequest, type FortiGateConfig } from "./fortigateService.js";
import { fmgProxyRest, type FortiManagerConfig } from "./fortimanagerService.js";
import { readSystemStatus } from "../utils/fortiosEnvelope.js";
import { DeviceHttpClient, DeviceConnectionError, jsonOrNull, asString, asNumber } from "./firmwareEngines/deviceHttp.js";
import { gateLogin } from "./firmwareEngines/fortigateHttps.js";
import { DEFAULT_FIRMWARE_TIMEOUTS, type FirmwareEngineContext } from "./firmwareEngines/types.js";
import { withSshClient } from "../utils/remoteExec.js";
import { AppError } from "../utils/errors.js";

export const REBOOT_PATH = "/api/v2/monitor/system/os/reboot";
export const SWITCH_RESTART_PATH = "/api/v2/monitor/switch-controller/managed-switch/restart";
export const AP_RESTART_PATH = "/api/v2/monitor/wifi/managed_ap/restart";
const STATUS_PATH = "/api/v2/monitor/system/status";
const HA_PATH = "/api/v2/cmdb/system/ha";
const WEB_UI_STATE_PATH = "/api/v2/monitor/web-ui/state";
const SWITCH_STATUS_PATH = "/api/v2/monitor/switch-controller/managed-switch/status";
const AP_STATUS_PATH = "/api/v2/monitor/wifi/managed_ap";

export type GateLink =
  | { kind: "token"; host: string; port: number; token: string; verifyTls: boolean; vdom: string }
  | { kind: "login"; host: string; port: number; username: string; password: string; verifyTls: boolean; vdom: string }
  | { kind: "fmg-proxy"; fmgConfig: FortiManagerConfig; deviceName: string; integrationId: string; vdom: string }
  | { kind: "ssh"; host: string; config: Record<string, unknown> };

/** `joinTime` is epoch ms — when the device last joined its controller (FortiLink / CAPWAP). */
export interface ManagedSwitchState { serial: string; switchId: string; status: string | null; joinTime: number | null }
export interface ManagedApState { serial: string; wtpId: string; status: string | null; joinTime: number | null }

/**
 * A controller join time to epoch ms. A managed switch's `join_time` is a
 * DATE STRING ("Fri Sep  4 07:26:15 2026", the gate's local clock); an AP's
 * `join_time_raw` is epoch SECONDS. Seen on FortiOS 7.6.7 (2026-10-13).
 */
export function parseJoinTime(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v) && v > 0) return v < 1e12 ? v * 1000 : v;
  if (typeof v === "string" && v.trim()) {
    const ms = Date.parse(v.replace(/\s+/g, " ").trim());
    return Number.isFinite(ms) ? ms : null;
  }
  return null;
}

export interface SendResult {
  /** Set when the request went out but its answer never came back (the box may already be rebooting). */
  uncertain?: string;
}

/** A clear refusal: nothing was rebooted. */
export class RebootSendError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RebootSendError";
  }
}

export interface GateOps {
  /** "https://10.0.0.1:443 with an API token", "FortiManager proxy to HQ-FGT", … — for the run log. */
  readonly label: string;
  /** The serial of the box that answers — null when this link cannot read it. */
  serial(): Promise<string | null>;
  /** "standalone" | "a-p" | "a-a" — null when this link cannot read it. */
  haMode(): Promise<string | null>;
  /** When the box last booted — null when this link cannot read it. */
  bootTime(): Promise<Date | null>;
  /** The FortiSwitches this gate manages — null when this link cannot list them. */
  managedSwitches(): Promise<ManagedSwitchState[] | null>;
  /** The FortiAPs this gate manages — null when this link cannot list them. */
  managedAps(): Promise<ManagedApState[] | null>;
  rebootSelf(message: string): Promise<SendResult>;
  restartSwitch(switchId: string): Promise<SendResult>;
  restartAp(wtpId: string): Promise<SendResult>;
  close(): Promise<void>;
}

/** A switch-id / wtp-id / serial that is safe to put on a CLI line or in a query: no spaces, no control characters (rule 107). */
export function assertCliToken(v: string, what: string): string {
  if (!/^[A-Za-z0-9._:-]{1,64}$/.test(v)) throw new RebootSendError(`${what} "${v}" is not a plain device name — refusing to send it to the FortiGate`);
  return v;
}

// ─── REST (token / login / FortiManager proxy) ──────────────────────────────

interface RestAdapter {
  label: string;
  get(path: string, envelope?: boolean): Promise<unknown>;
  post(path: string, body: unknown): Promise<SendResult>;
  close(): Promise<void>;
}

function vdomQuery(path: string, vdom: string): string {
  return `${path}${path.includes("?") ? "&" : "?"}vdom=${encodeURIComponent(vdom)}`;
}

/** An error that says the request may have gone out and the answer was lost, rather than refused. */
function lostAnswer(err: unknown): string | null {
  const msg = err instanceof Error ? err.message : String(err);
  if (err instanceof AppError && /HTTP (40\d|50\d)|permission denied|Authentication failed|error \(/i.test(msg)) return null;
  if (/fetch failed|socket|ECONNRESET|EPIPE|ETIMEDOUT|aborted|other side closed|Unexpected end of JSON|JSON/i.test(msg)) return msg;
  return null;
}

function tokenAdapter(l: Extract<GateLink, { kind: "token" }>): RestAdapter {
  const cfg: FortiGateConfig = { host: l.host, port: l.port, apiUser: "", apiToken: l.token, vdom: l.vdom, verifySsl: l.verifyTls };
  return {
    label: `https://${l.host}:${l.port} with an API token`,
    get: (path, envelope) => fgRequest(cfg, "GET", path, { query: { vdom: l.vdom }, envelope }),
    async post(path, body) {
      try {
        await fgRequest(cfg, "POST", path, { query: { vdom: l.vdom }, body });
        return {};
      } catch (err) {
        const lost = lostAnswer(err);
        if (lost) return { uncertain: lost };
        throw new RebootSendError(err instanceof Error ? err.message : String(err));
      }
    },
    close: async () => undefined,
  };
}

function loginAdapter(l: Extract<GateLink, { kind: "login" }>): RestAdapter {
  const c = new DeviceHttpClient({ host: l.host, port: l.port, scheme: "https", commandMs: 15_000, uploadIdleMs: 15_000, verifyTls: l.verifyTls });
  // gateLogin reads only the login, the token switch and the command timeout.
  const ctx = { credential: { username: l.username, password: l.password }, timeouts: DEFAULT_FIRMWARE_TIMEOUTS } as unknown as FirmwareEngineContext;
  let signedIn = false;
  // Logins the gate REFUSED (not ones that never reached it). The admin
  // lockout counts them, so after two the link stops signing in for good —
  // the firmware engine's MAX_AUTH_REJECTIONS posture.
  let rejectedLogins = 0;
  const ensure = async () => {
    if (signedIn) return;
    if (rejectedLogins >= 2) throw new AppError(502, `the FortiGate refused admin "${l.username}" twice — stopped signing in before the admin is locked out`);
    try {
      await gateLogin(c, ctx, 10_000);
    } catch (err) {
      if (!(err instanceof DeviceConnectionError)) rejectedLogins++;
      throw err;
    }
    signedIn = true;
  };
  // A reboot ends the gate's sessions, so a read that is refused — or whose
  // connection dropped — forgets the session and signs in again on the next
  // call. Without this, every read after the reboot carried a dead cookie and
  // the run took the refusals for "still down" (seen on the lab, 2026-10-13).
  const read = async (path: string, envelope?: boolean) => {
    await ensure();
    let res;
    try {
      res = await c.get(vdomQuery(path, l.vdom));
    } catch (err) {
      signedIn = false;
      c.clearSession();
      throw err;
    }
    if (res.status === 401 || res.status === 403) {
      signedIn = false;
      c.clearSession();
      throw new AppError(502, `the FortiGate refused admin "${l.username}" on ${path} (HTTP ${res.status}) — its profile needs System read-write`);
    }
    const j = jsonOrNull(res.body);
    if (res.status !== 200 || !j) throw new AppError(502, `unexpected answer from ${path} (HTTP ${res.status})`);
    return envelope ? j : (j.results ?? j);
  };
  return {
    label: `https://${l.host}:${l.port} as admin "${l.username}"`,
    get: read,
    async post(path, body) {
      try {
        await ensure();
      } catch (err) {
        throw new RebootSendError(err instanceof Error ? err.message : String(err));
      }
      try {
        const res = await c.postJson(vdomQuery(path, l.vdom), body);
        if (res.status === 401 || res.status === 403) throw new RebootSendError(`the FortiGate refused admin "${l.username}" (HTTP ${res.status}) — its profile needs System read-write`);
        const j = jsonOrNull(res.body);
        if (res.status >= 200 && res.status < 300 && asString(j?.status) !== "error") return {};
        const why = (j && (asString(j.error) ?? asString(j.message) ?? asString(j.cli_error))) ?? null;
        throw new RebootSendError(`the FortiGate refused the request${why ? `: ${why}` : ""} (HTTP ${res.status})`);
      } catch (err) {
        if (err instanceof RebootSendError) throw err;
        if (err instanceof DeviceConnectionError) return { uncertain: err.message };
        throw new RebootSendError(err instanceof Error ? err.message : String(err));
      }
    },
    async close() {
      if (signedIn) await c.delete("/api/v2/authentication", 5_000).catch(() => undefined);
    },
  };
}

function proxyAdapter(l: Extract<GateLink, { kind: "fmg-proxy" }>): RestAdapter {
  return {
    label: `FortiManager ${l.fmgConfig.host} proxy to device "${l.deviceName}"`,
    // The proxy unwraps to `results`; envelope fields (serial) are not relayed.
    get: (path) => fmgProxyRest(l.fmgConfig, l.deviceName, "GET", vdomQuery(path, l.vdom), { integrationId: l.integrationId }),
    async post(path, body) {
      try {
        await fmgProxyRest(l.fmgConfig, l.deviceName, "POST", vdomQuery(path, l.vdom), { body, integrationId: l.integrationId });
        return {};
      } catch (err) {
        const lost = lostAnswer(err);
        if (lost && !(err instanceof AppError)) return { uncertain: lost };
        throw new RebootSendError(err instanceof Error ? err.message : String(err));
      }
    },
    close: async () => undefined,
  };
}

function restOps(a: RestAdapter, opts: { envelopeSerial: boolean }): GateOps {
  return {
    label: a.label,
    async serial() {
      if (!opts.envelopeSerial) return null;
      const body = await a.get(STATUS_PATH, true);
      return readSystemStatus(body).serial ?? null;
    },
    async haMode() {
      const r = await a.get(HA_PATH);
      const row = Array.isArray(r) ? r[0] : r;
      return row && typeof row === "object" ? asString((row as Record<string, unknown>).mode) : null;
    },
    async bootTime() {
      const r = (await a.get(WEB_UI_STATE_PATH)) as Record<string, unknown> | null;
      const ms = asNumber(r?.utc_last_reboot);
      return ms && ms > 0 ? new Date(ms) : null;
    },
    async managedSwitches() {
      const r = await a.get(SWITCH_STATUS_PATH);
      if (!Array.isArray(r)) return [];
      return r.map((s: Record<string, unknown>) => ({
        serial: String(s.serial ?? ""),
        switchId: String(s["switch-id"] ?? s.serial ?? ""),
        status: asString(s.status),
        joinTime: parseJoinTime(s.join_time),
      })).filter((s) => s.serial);
    },
    async managedAps() {
      const r = await a.get(AP_STATUS_PATH);
      if (!Array.isArray(r)) return [];
      return r.map((x: Record<string, unknown>) => ({
        serial: String(x.serial ?? ""),
        wtpId: String(x.wtp_id ?? x.name ?? x.serial ?? ""),
        status: asString(x.status),
        joinTime: parseJoinTime(x.join_time_raw),
      })).filter((x) => x.serial);
    },
    rebootSelf: (message) => a.post(REBOOT_PATH, { event_log_message: message }),
    restartSwitch: (switchId) => a.post(SWITCH_RESTART_PATH, { mkey: assertCliToken(switchId, "switch-id") }),
    restartAp: (wtpId) => a.post(AP_RESTART_PATH, { wtpname: assertCliToken(wtpId, "FortiAP id") }),
    close: () => a.close(),
  };
}

// ─── SSH (FortiOS CLI) ──────────────────────────────────────────────────────

const PROMPT = /[\w.-]+ (?:\([^)]*\) )?[#$] ?$/;
const CONFIRM = /\(y\/n\)\s*$/i;
const MORE = /--More--\s*$/;
const CLI_ERROR = /Command fail|command parse error|Unknown action|invalid (?:input|value)|entry not found|Return code -\d+/i;

/**
 * One CLI command on an interactive FortiOS shell. The confirmation prompt is
 * answered "y"; a pager stop is answered with a space. Resolves with the text
 * printed between the command and the next prompt — or, for a command that
 * takes the box down, whatever arrived before the connection dropped.
 */
export async function runFortiCli(host: string, config: Record<string, unknown>, command: string, opts: { timeoutMs?: number; expectDrop?: boolean } = {}): Promise<{ output: string; dropped: boolean }> {
  if (/[\r\n]/.test(command)) throw new RebootSendError("a CLI command cannot span lines");
  const timeoutMs = opts.timeoutMs ?? 30_000;
  return withSshClient(host, config, (client) => new Promise((resolve, reject) => {
    client.shell({ term: "vt100", cols: 200, rows: 1000 }, (err, stream) => {
      if (err) return reject(err);
      let buf = "";
      let sent = false;
      let answered = false;
      let done = false;
      const clean = (s: string) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").replace(/\r/g, "");
      const finish = (dropped: boolean) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        const text = clean(buf);
        const at = text.indexOf(command);
        const out = (at >= 0 ? text.slice(at + command.length) : text).replace(PROMPT, "").trim();
        try { stream.end(); } catch { /* closed */ }
        resolve({ output: out, dropped });
      };
      const timer = setTimeout(() => {
        if (opts.expectDrop && answered) return finish(true);
        if (done) return;
        done = true;
        try { stream.end(); } catch { /* closed */ }
        reject(new Error(`the FortiGate CLI did not answer "${command}" within ${Math.round(timeoutMs / 1000)} s`));
      }, timeoutMs);
      stream.on("data", (b: Buffer) => {
        buf += b.toString("utf8");
        const tail = clean(buf).slice(-200);
        if (!sent && PROMPT.test(tail)) {
          sent = true;
          buf = "";
          stream.write(`${command}\n`);
          return;
        }
        if (!sent) return;
        if (MORE.test(tail)) { stream.write(" "); return; }
        if (CONFIRM.test(tail) && !answered) { answered = true; stream.write("y"); return; }
        if (PROMPT.test(tail) && clean(buf).includes(command) && clean(buf).trim().length > command.length) finish(false);
      });
      stream.on("close", () => finish(true));
      stream.on("error", () => finish(true));
    });
  }));
}

function sshOps(l: Extract<GateLink, { kind: "ssh" }>): GateOps {
  const cli = (cmd: string) => runFortiCli(l.host, l.config, cmd).then((r) => r.output);
  const send = async (cmd: string): Promise<SendResult> => {
    let r: { output: string; dropped: boolean };
    try {
      r = await runFortiCli(l.host, l.config, cmd, { expectDrop: true, timeoutMs: 20_000 });
    } catch (err) {
      throw new RebootSendError(err instanceof Error ? err.message : String(err));
    }
    if (CLI_ERROR.test(r.output)) throw new RebootSendError(`the FortiGate CLI refused "${cmd}": ${r.output.split("\n").slice(-3).join(" ").trim()}`);
    return r.dropped ? { uncertain: "the SSH session closed as the command ran" } : {};
  };
  return {
    label: `SSH ${l.host} as "${String(l.config.username ?? "")}"`,
    async serial() {
      const out = await cli("get system status");
      return /Serial-Number:\s*(\S+)/i.exec(out)?.[1] ?? null;
    },
    async haMode() {
      const out = await cli("get system ha");
      return /^\s*mode\s*:\s*(\S+)/im.exec(out)?.[1] ?? null;
    },
    async bootTime() {
      const out = await cli("get system performance status");
      const m = /Uptime:\s*(\d+)\s*days?,\s*(\d+)\s*hours?,\s*(\d+)\s*minutes?/i.exec(out);
      if (!m) return null;
      const secs = (Number(m[1]) * 86_400) + (Number(m[2]) * 3_600) + (Number(m[3]) * 60);
      return new Date(Date.now() - secs * 1000);
    },
    managedSwitches: async () => null,
    managedAps: async () => null,
    rebootSelf: () => send("execute reboot"),
    restartSwitch: (switchId) => send(`execute switch-controller switch-action restart swtp ${assertCliToken(switchId, "switch-id")}`),
    restartAp: (serial) => send(`execute wireless-controller reset-wtp ${assertCliToken(serial, "FortiAP serial")}`),
    close: async () => undefined,
  };
}

/** The operations a link supports. */
export function gateOps(link: GateLink): GateOps {
  switch (link.kind) {
    case "token":     return restOps(tokenAdapter(link), { envelopeSerial: true });
    case "login":     return restOps(loginAdapter(link), { envelopeSerial: true });
    case "fmg-proxy": return restOps(proxyAdapter(link), { envelopeSerial: false });
    case "ssh":       return sshOps(link);
  }
}

/** Test seam: the runner builds its ops through this, so a test can hand it a fake gate. */
export const _rebootTransportSeams = { gateOps };
