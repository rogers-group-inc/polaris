/**
 * src/services/syslogForwarderService.ts — forwards Events to a remote syslog
 * server (business rule 187).
 *
 * `eventLogService.logEvent` / `logEventsBatch` hand every Event they WROTE to
 * `forwardEvents()` — a synchronous, bounded enqueue that never awaits and
 * never throws, so syslog can never slow or break an Event write. A flush on
 * the next tick reads the `eventSyslog` setting (cached 30 s, so every process
 * follows a change within half a minute), drops what is below the configured
 * minimum severity, formats each Event (RFC 5424 or RFC 3164) and sends it:
 * UDP one datagram per Event; TCP / TLS over ONE persistent connection per
 * process, reconnecting with backoff, with RFC 5424 octet-counting framing
 * (RFC 6587 / 5425) and RFC 3164 newline framing.
 *
 * Every role forwards the Events it writes itself, so each Event leaves once.
 * A forwarding failure is logged (rate-limited), never written as an Event —
 * that would feed itself.
 */

import { createSocket, type Socket as DgramSocket } from "node:dgram";
import { createConnection, isIP, type Socket } from "node:net";
import { connect as tlsConnect, rootCertificates, type ConnectionOptions } from "node:tls";
import { readFileSync } from "node:fs";
import { hostname as osHostname } from "node:os";
import { logger } from "../utils/logger.js";
import type { SyslogSettings } from "./eventArchiveService.js";

// ─── Formatting ─────────────────────────────────────────────────────────────

export interface ForwardedEvent {
  at: Date;
  action: string;
  level: string;
  message: string;
  resourceType?: string | null;
  resourceId?: string | null;
  resourceName?: string | null;
  actor?: string | null;
}

/** RFC 5424 § 6.2.1 facility codes, by the names syslog.conf uses. */
export const SYSLOG_FACILITIES: Readonly<Record<string, number>> = {
  kern: 0, user: 1, mail: 2, daemon: 3, auth: 4, syslog: 5, lpr: 6, news: 7,
  uucp: 8, cron: 9, authpriv: 10, ftp: 11,
  local0: 16, local1: 17, local2: 18, local3: 19, local4: 20, local5: 21, local6: 22, local7: 23,
};

/** Polaris Event level → syslog severity (error 3, warning 4, info 6). */
const SEVERITY_CODE: Readonly<Record<string, number>> = { error: 3, warning: 4, info: 6 };
const LEVEL_RANK: Readonly<Record<string, number>> = { info: 0, warning: 1, error: 2 };

/** The IANA example enterprise number, as most vendor SD-IDs without a PEN use. */
const SD_ID = "polaris@32473";

const MAX_UDP_BYTES = 2048;
const MAX_STREAM_BYTES = 8192;

export function syslogPri(facility: string, level: string): number {
  const f = SYSLOG_FACILITIES[facility] ?? SYSLOG_FACILITIES.local0;
  return f * 8 + (SEVERITY_CODE[level] ?? SEVERITY_CODE.info);
}

/** True when an Event of `level` passes a minimum of `minimum`. */
export function passesSeverity(level: string, minimum: string): boolean {
  return (LEVEL_RANK[level] ?? 0) >= (LEVEL_RANK[minimum] ?? 0);
}

/** RFC 5424 header fields are PRINTUSASCII (33–126) with a length cap; "-" when empty. */
function headerToken(raw: string, max: number): string {
  const t = raw.replace(/[^\x21-\x7e]/g, "").slice(0, max);
  return t || "-";
}

/** RFC 5424 § 6.3.3: `"`, `\` and `]` are escaped inside a PARAM-VALUE. */
function sdValue(raw: string): string {
  return raw.slice(0, 256).replace(/[\\"\]]/g, (c) => `\\${c}`);
}

/** One line: a CR / LF inside a message would split it under newline framing. */
function oneLine(raw: string): string {
  return raw.replace(/[\r\n]+/g, " ").trim();
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** RFC 3164 TIMESTAMP — "Mmm dd hh:mm:ss" in the process's local zone, day space-padded. */
function bsdTimestamp(d: Date): string {
  const p2 = (n: number) => String(n).padStart(2, "0");
  return `${MONTHS[d.getMonth()]} ${String(d.getDate()).padStart(2, " ")} ${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;
}

/** Cut `s` to at most `maxBytes` of UTF-8 without splitting a character. */
export function truncateUtf8(s: string, maxBytes: number): string {
  const buf = Buffer.from(s, "utf8");
  if (buf.length <= maxBytes) return s;
  let n = maxBytes;
  while (n > 0 && (buf[n] & 0xc0) === 0x80) n--;
  return buf.subarray(0, n).toString("utf8");
}

export function formatSyslogMessage(
  ev: ForwardedEvent,
  settings: Pick<SyslogSettings, "facility" | "format">,
  host: string = osHostname(),
): string {
  const pri = syslogPri(settings.facility, ev.level);
  const msg = oneLine(ev.message);
  if (settings.format === "rfc3164") {
    return `<${pri}>${bsdTimestamp(ev.at)} ${headerToken(host, 255)} polaris[${process.pid}]: ${oneLine(ev.action)}: ${msg}`;
  }
  const params: Array<[string, string | null | undefined]> = [
    ["action", ev.action], ["level", ev.level], ["resourceType", ev.resourceType],
    ["resourceId", ev.resourceId], ["resourceName", ev.resourceName], ["actor", ev.actor],
  ];
  const sd = `[${SD_ID}${params
    .filter(([, v]) => typeof v === "string" && v !== "")
    .map(([k, v]) => ` ${k}="${sdValue(oneLine(v as string))}"`)
    .join("")}]`;
  return `<${pri}>1 ${ev.at.toISOString()} ${headerToken(host, 255)} polaris ${process.pid} ${headerToken(ev.action, 32)} ${sd} ${msg}`;
}

/** Stream framing: RFC 5424 → octet counting ("LEN SP MSG"); RFC 3164 → newline. */
export function frameForStream(msg: string, format: SyslogSettings["format"]): string {
  return format === "rfc3164" ? `${msg}\n` : `${Buffer.byteLength(msg, "utf8")} ${msg}`;
}

// ─── TLS trust ──────────────────────────────────────────────────────────────

/**
 * The server certificate is always verified: against the CA file named in
 * the settings when one is, else against the system trust store PLUS the CAs
 * uploaded under Server Settings → Trusted Certificate Authorities.
 */
export function buildTlsOptions(s: SyslogSettings, uploadedCaPems: readonly string[]): ConnectionOptions {
  const opts: ConnectionOptions = {
    host: s.host,
    port: s.port,
    rejectUnauthorized: true,
    ca: s.tlsCaPath ? [readFileSync(s.tlsCaPath)] : [...rootCertificates, ...uploadedCaPems],
  };
  if (!isIP(s.host)) opts.servername = s.host;
  if (s.tlsCertPath) opts.cert = readFileSync(s.tlsCertPath);
  if (s.tlsKeyPath) opts.key = readFileSync(s.tlsKeyPath);
  return opts;
}

async function loadUploadedCaPems(): Promise<string[]> {
  try {
    const { listCertificates } = await import("./serverSettingsService.js");
    const { trustedCAs } = await listCertificates();
    return trustedCAs.filter((c) => c.type === "cert" && c.pem).map((c) => c.pem);
  } catch {
    return [];
  }
}

// ─── One-shot send (the Test button) ────────────────────────────────────────

const CONNECT_TIMEOUT_MS = 10_000;

function udpFamily(host: string): "udp4" | "udp6" {
  // An IPv6 server needs a udp6 socket (rule 128), as buildSnmpSession picks.
  return isIP(host) === 6 ? "udp6" : "udp4";
}

function sendUdpOnce(host: string, port: number, payload: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const client = createSocket(udpFamily(host));
    const buf = Buffer.from(payload);
    client.send(buf, 0, buf.length, port, host, (err) => {
      client.close();
      if (err) reject(err);
      else resolve();
    });
  });
}

function sendStreamOnce(open: (onConnect: () => void) => Socket, payload: string, label: string): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = (err?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (err) { socket.destroy(); reject(err); } else resolve();
    };
    const timeout = setTimeout(() => settle(new Error(`${label} connection timeout`)), CONNECT_TIMEOUT_MS);
    const socket = open(() => {
      socket.write(payload, () => {
        socket.end();
        settle();
      });
    });
    socket.on("error", (err) => settle(err));
  });
}

/** Send ONE formatted message with the given settings — what the Test button does. */
export async function sendSyslogOnce(settings: SyslogSettings, msg: string): Promise<void> {
  if (settings.protocol === "udp") {
    return sendUdpOnce(settings.host, settings.port, truncateUtf8(msg, MAX_UDP_BYTES));
  }
  const payload = frameForStream(truncateUtf8(msg, MAX_STREAM_BYTES), settings.format);
  if (settings.protocol === "tcp") {
    return sendStreamOnce((cb) => createConnection({ host: settings.host, port: settings.port }, cb), payload, "TCP");
  }
  const opts = buildTlsOptions(settings, await loadUploadedCaPems());
  return sendStreamOnce((cb) => tlsConnect(opts, cb), payload, "TLS");
}

// ─── The forwarder ──────────────────────────────────────────────────────────

export const MAX_QUEUE = 10_000;
const SETTINGS_TTL_MS = 30_000;
const RECONNECT_MIN_MS = 1_000;
const RECONNECT_MAX_MS = 60_000;
const WARN_EVERY_MS = 60_000;

type SettingsLoader = () => Promise<SyslogSettings>;

let loadSettings: SettingsLoader = async () => {
  const { getSyslogSettings } = await import("./eventArchiveService.js");
  return getSyslogSettings();
};

let cached: { settings: SyslogSettings; caPems: string[]; at: number } | null = null;
let pending: ForwardedEvent[] = [];
let flushScheduled = false;
let droppedSinceWarn = 0;
let lastWarnAt = 0;

/** A persistent sink for one destination (protocol + host + port + TLS files). */
interface Sink {
  key: string;
  send(lines: string[]): void;
  close(): void;
}

let sink: Sink | null = null;

function warn(msg: string, err?: unknown): void {
  const now = Date.now();
  if (now - lastWarnAt < WARN_EVERY_MS) return;
  lastWarnAt = now;
  const dropped = droppedSinceWarn;
  droppedSinceWarn = 0;
  logger.warn({ err: err instanceof Error ? err.message : err, dropped }, msg);
}

function sinkKey(s: SyslogSettings): string {
  return JSON.stringify([s.protocol, s.host, s.port, s.format, s.tlsCaPath ?? "", s.tlsCertPath ?? "", s.tlsKeyPath ?? ""]);
}

function makeUdpSink(s: SyslogSettings): Sink {
  let socket: DgramSocket | null = null;
  const open = () => {
    const sock = createSocket(udpFamily(s.host));
    sock.on("error", (err) => { warn("syslog forwarder: UDP socket error", err); sock.close(); if (socket === sock) socket = null; });
    sock.unref();
    return sock;
  };
  return {
    key: sinkKey(s),
    send(lines) {
      socket ??= open();
      for (const line of lines) {
        const buf = Buffer.from(truncateUtf8(line, MAX_UDP_BYTES));
        socket.send(buf, 0, buf.length, s.port, s.host, (err) => { if (err) warn("syslog forwarder: UDP send failed", err); });
      }
    },
    close() { try { socket?.close(); } catch { /* already closed */ } socket = null; },
  };
}

function makeStreamSink(s: SyslogSettings, caPems: readonly string[]): Sink {
  let socket: Socket | null = null;
  let connected = false;
  let closed = false;
  let backoff = RECONNECT_MIN_MS;
  let retryTimer: NodeJS.Timeout | null = null;
  const queue: string[] = [];

  const flushQueue = () => {
    while (connected && socket && queue.length) {
      const ok = socket.write(queue.shift()!);
      if (!ok) { socket.once("drain", flushQueue); return; }
    }
  };
  const scheduleReconnect = () => {
    if (closed || retryTimer) return;
    retryTimer = setTimeout(() => { retryTimer = null; connect(); }, backoff);
    retryTimer.unref();
    backoff = Math.min(backoff * 2, RECONNECT_MAX_MS);
  };
  const connect = () => {
    if (closed) return;
    let sock: Socket;
    try {
      const onConnect = () => { connected = true; backoff = RECONNECT_MIN_MS; flushQueue(); };
      sock = s.protocol === "tls"
        ? tlsConnect(buildTlsOptions(s, caPems), onConnect)
        : createConnection({ host: s.host, port: s.port }, onConnect);
    } catch (err) {
      // readFileSync of a missing CA / cert / key file throws synchronously.
      warn("syslog forwarder: cannot open the connection", err);
      scheduleReconnect();
      return;
    }
    socket = sock;
    sock.setKeepAlive(true, 60_000);
    sock.unref();
    sock.on("error", (err) => warn(`syslog forwarder: ${s.protocol.toUpperCase()} connection error`, err));
    sock.on("close", () => {
      if (socket === sock) { socket = null; connected = false; }
      scheduleReconnect();
    });
  };

  return {
    key: sinkKey(s),
    send(lines) {
      for (const line of lines) queue.push(frameForStream(truncateUtf8(line, MAX_STREAM_BYTES), s.format));
      if (queue.length > MAX_QUEUE) {
        const over = queue.length - MAX_QUEUE;
        queue.splice(0, over);
        droppedSinceWarn += over;
        warn("syslog forwarder: server unreachable, oldest queued messages dropped");
      }
      if (!socket && !retryTimer) connect();
      else flushQueue();
    },
    close() {
      closed = true;
      if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
      socket?.end();
      socket = null;
      connected = false;
      queue.length = 0;
    },
  };
}

async function currentSettings(): Promise<{ settings: SyslogSettings; caPems: string[] }> {
  if (cached && Date.now() - cached.at < SETTINGS_TTL_MS) return cached;
  const settings = await loadSettings();
  const caPems = settings.enabled && settings.protocol === "tls" && !settings.tlsCaPath ? await loadUploadedCaPems() : [];
  cached = { settings, caPems, at: Date.now() };
  return cached;
}

async function flush(): Promise<void> {
  flushScheduled = false;
  const batch = pending;
  pending = [];
  if (!batch.length) return;
  let cfg: { settings: SyslogSettings; caPems: string[] };
  try {
    cfg = await currentSettings();
  } catch (err) {
    warn("syslog forwarder: cannot read the syslog settings", err);
    return;
  }
  const s = cfg.settings;
  if (!s.enabled || !s.host) {
    if (sink) { sink.close(); sink = null; }
    return;
  }
  const key = sinkKey(s);
  if (sink && sink.key !== key) { sink.close(); sink = null; }
  sink ??= s.protocol === "udp" ? makeUdpSink(s) : makeStreamSink(s, cfg.caPems);
  const host = osHostname();
  const lines = batch.filter((e) => passesSeverity(e.level, s.severity)).map((e) => formatSyslogMessage(e, s, host));
  if (lines.length) sink.send(lines);
}

/**
 * Hand Events that were just written to the forwarder. Synchronous, bounded
 * and exception-free: the caller is an Event write and must never wait on, or
 * fail because of, syslog.
 */
export function forwardEvents(events: readonly ForwardedEvent[]): void {
  try {
    if (!events.length) return;
    pending.push(...events);
    if (pending.length > MAX_QUEUE) {
      const over = pending.length - MAX_QUEUE;
      pending.splice(0, over);
      droppedSinceWarn += over;
    }
    if (!flushScheduled) {
      flushScheduled = true;
      setImmediate(() => { flush().catch((err) => warn("syslog forwarder: flush failed", err)); });
    }
  } catch {
    // never let forwarding break an Event write
  }
}

/** Drop the cached settings so this process re-reads them on the next Event. */
export function invalidateSyslogSettingsCache(): void {
  cached = null;
}

/** Test seam: replace the settings loader and reset all forwarder state. */
export function _resetSyslogForwarderForTests(loader?: SettingsLoader): void {
  if (sink) sink.close();
  sink = null;
  cached = null;
  pending = [];
  flushScheduled = false;
  droppedSinceWarn = 0;
  lastWarnAt = 0;
  if (loader) loadSettings = loader;
}

/** Test seam: run the pending flush now instead of on the next tick. */
export async function _flushSyslogForwarderForTests(): Promise<void> {
  await flush();
}
