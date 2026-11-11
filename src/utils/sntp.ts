/**
 * src/utils/sntp.ts
 *
 * One SNTP query (RFC 4330 client over NTPv4, UDP 123) and one NTS key
 * exchange (RFC 8915 NTS-KE, TLS 1.3 on TCP 4460), for Server Settings → NTP
 * "Test Sync". Before this the test answered "Synchronized" with an invented
 * offset without contacting anything (found by CQ-T010).
 *
 * The packet builders and parsers are pure; `querySntp` / `checkNtsKe` take
 * their socket and resolver as options so tests run without a network.
 *
 * What a reply must prove before it counts:
 *   - it echoes our transmit timestamp as its originate timestamp (a stray or
 *     spoofed datagram is refused; the low fraction bits are random per query),
 *   - it is a server (mode 4) or broadcast (mode 5) reply,
 *   - the server is synchronized: stratum 1-15 and leap indicator not 3. A
 *     stratum-0 reply is a Kiss-o'-Death whose reference id names the reason
 *     (DENY, RSTR, RATE …) and is reported as such.
 *
 * NTS: the key exchange is checked for real (certificate verified by Node's
 * default trust store, ALPN "ntske/1", NTPv4 + AES-SIV-CMAC-256 agreed,
 * cookies issued). The time sample that follows is a PLAIN NTP query to the
 * server the exchange named: authenticating it needs AES-SIV, which Node does
 * not ship, so the caller must say the sample was not NTS-protected.
 */
import dgram from "node:dgram";
import tls from "node:tls";
import net from "node:net";
import { randomBytes } from "node:crypto";
import { lookup as dnsLookup } from "node:dns/promises";

/** Seconds between the NTP era-0 epoch (1900-01-01) and the Unix epoch. */
const NTP_UNIX_OFFSET_S = 2_208_988_800;
const NTP_PACKET_BYTES = 48;

export interface SntpReply {
  /** Server clock minus this host's clock, in ms (positive = this host is behind). */
  offsetMs: number;
  /** Round-trip delay in ms, the server's processing time excluded. */
  delayMs: number;
  stratum: number;
  /** For stratum 1 the 4-character reference source ("GPS", "PPS"); otherwise the upstream's IPv4. */
  refId: string;
  /** The address the query went to. */
  address: string;
}

/** Write a Unix-ms instant as a 64-bit NTP timestamp; `fractionNoise` fills the low 16 bits. */
export function writeNtpTimestamp(buf: Buffer, at: number, unixMs: number, fractionNoise = 0): void {
  const seconds = Math.floor(unixMs / 1000) + NTP_UNIX_OFFSET_S;
  const fraction = Math.floor(((unixMs % 1000) / 1000) * 0x1_0000_0000);
  buf.writeUInt32BE(seconds >>> 0, at);
  buf.writeUInt32BE(((fraction & 0xffff0000) | (fractionNoise & 0xffff)) >>> 0, at + 4);
}

/** Read a 64-bit NTP timestamp as Unix ms (era 0; good until 2036). */
export function readNtpTimestamp(buf: Buffer, at: number): number {
  const seconds = buf.readUInt32BE(at);
  const fraction = buf.readUInt32BE(at + 4);
  return (seconds - NTP_UNIX_OFFSET_S) * 1000 + (fraction / 0x1_0000_0000) * 1000;
}

/** A 48-byte client request (LI 0, version 4, mode 3) carrying `transmitMs` with random low fraction bits. */
export function buildSntpRequest(transmitMs: number, noise = randomBytes(2).readUInt16BE(0)): Buffer {
  const buf = Buffer.alloc(NTP_PACKET_BYTES);
  buf[0] = (0 << 6) | (4 << 3) | 3;
  writeNtpTimestamp(buf, 40, transmitMs, noise);
  return buf;
}

function refIdText(buf: Buffer): string {
  return buf.subarray(12, 16).toString("latin1").replace(/[^\x20-\x7e]/g, "").trim();
}

/**
 * Judge a reply to `request` (the exact bytes sent at `sentMs`, received at
 * `receivedMs`). Throws an Error whose message is fit to show an operator.
 */
export function parseSntpReply(reply: Buffer, request: Buffer, sentMs: number, receivedMs: number, address = ""): SntpReply {
  if (reply.length < NTP_PACKET_BYTES) throw new Error(`short reply (${reply.length} bytes)`);
  const leap = reply[0] >> 6;
  const mode = reply[0] & 0x07;
  const stratum = reply[1];
  if (mode !== 4 && mode !== 5) throw new Error(`not a server reply (mode ${mode})`);
  if (!reply.subarray(24, 32).equals(request.subarray(40, 48))) {
    throw new Error("reply does not answer this query (originate timestamp mismatch)");
  }
  if (stratum === 0) throw new Error(`server refused the query (kiss code ${refIdText(reply) || "unknown"})`);
  if (stratum > 15 || leap === 3) throw new Error("server is not synchronized to a time source");
  if (reply.readUInt32BE(40) === 0 && reply.readUInt32BE(44) === 0) throw new Error("server sent no time");

  const t1 = sentMs;
  const t2 = readNtpTimestamp(reply, 32);
  const t3 = readNtpTimestamp(reply, 40);
  const t4 = receivedMs;
  const refId = stratum === 1 ? refIdText(reply) : Array.from(reply.subarray(12, 16)).join(".");
  return {
    offsetMs: ((t2 - t1) + (t3 - t4)) / 2,
    delayMs: Math.max(0, (t4 - t1) - (t3 - t2)),
    stratum,
    refId,
    address,
  };
}

type Lookup = (host: string) => Promise<{ address: string; family: number }>;

export interface SntpQueryOptions {
  port?: number;
  timeoutMs?: number;
  now?: () => number;
  lookup?: Lookup;
  createSocket?: (type: "udp4" | "udp6") => dgram.Socket;
}

async function resolve(host: string, lookup: Lookup): Promise<{ address: string; family: number }> {
  const bare = host.replace(/^\[|\]$/g, "");
  const literal = net.isIP(bare);
  if (literal) return { address: bare, family: literal };
  try {
    return await lookup(bare);
  } catch {
    throw new Error("name does not resolve");
  }
}

/** Ask one server for the time. Rejects with an operator-readable Error. */
export async function querySntp(host: string, opts: SntpQueryOptions = {}): Promise<SntpReply> {
  const { port = 123, timeoutMs = 3000, now = Date.now } = opts;
  const { address, family } = await resolve(host, opts.lookup ?? ((h) => dnsLookup(h)));
  const socket = (opts.createSocket ?? ((t) => dgram.createSocket(t)))(family === 6 ? "udp6" : "udp4");
  return new Promise<SntpReply>((resolvePromise, reject) => {
    let request: Buffer = Buffer.alloc(0);
    let sentMs = 0;
    let done = false;
    const finish = (err: Error | null, value?: SntpReply) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { socket.close(); } catch { /* already closed */ }
      if (err) reject(err); else resolvePromise(value!);
    };
    const timer = setTimeout(() => finish(new Error(`no answer within ${timeoutMs / 1000} s`)), timeoutMs);
    socket.on("error", (err) => finish(new Error(err.message)));
    socket.on("message", (msg) => {
      try {
        finish(null, parseSntpReply(msg, request, sentMs, now(), address));
      } catch (err: any) {
        // A reply to a different query is ignored (keep waiting); anything else is the answer.
        if (/originate timestamp mismatch/.test(err.message)) return;
        finish(err);
      }
    });
    sentMs = now();
    request = buildSntpRequest(sentMs);
    socket.send(request, port, address, (err) => { if (err) finish(new Error(err.message)); });
  });
}

// ─── NTS key exchange (RFC 8915 §4) ─────────────────────────────────────────

const NTSKE = { END: 0, NEXT_PROTOCOL: 1, ERROR: 2, WARNING: 3, AEAD: 4, COOKIE: 5, SERVER: 6, PORT: 7 } as const;
/** AEAD_AES_SIV_CMAC_256 — the one algorithm every NTS server must support. */
export const NTS_AEAD_AES_SIV_CMAC_256 = 15;

function ntsRecord(type: number, critical: boolean, body: Buffer): Buffer {
  const head = Buffer.alloc(4);
  head.writeUInt16BE((critical ? 0x8000 : 0) | type, 0);
  head.writeUInt16BE(body.length, 2);
  return Buffer.concat([head, body]);
}

/** Next Protocol = NTPv4, AEAD = AES-SIV-CMAC-256, End of Message. */
export function buildNtsKeRequest(): Buffer {
  const u16 = (v: number) => { const b = Buffer.alloc(2); b.writeUInt16BE(v, 0); return b; };
  return Buffer.concat([
    ntsRecord(NTSKE.NEXT_PROTOCOL, true, u16(0)),
    ntsRecord(NTSKE.AEAD, true, u16(NTS_AEAD_AES_SIV_CMAC_256)),
    ntsRecord(NTSKE.END, true, Buffer.alloc(0)),
  ]);
}

export interface NtsKeResult {
  complete: boolean;
  protocols: number[];
  aead: number[];
  cookies: number;
  server: string | null;
  port: number | null;
  error: number | null;
}

/** Parse the records received so far; `complete` once End of Message arrived. */
export function parseNtsKeResponse(buf: Buffer): NtsKeResult {
  const out: NtsKeResult = { complete: false, protocols: [], aead: [], cookies: 0, server: null, port: null, error: null };
  let at = 0;
  while (at + 4 <= buf.length) {
    const type = buf.readUInt16BE(at) & 0x7fff;
    const len = buf.readUInt16BE(at + 2);
    if (at + 4 + len > buf.length) break;
    const body = buf.subarray(at + 4, at + 4 + len);
    at += 4 + len;
    const u16s = () => Array.from({ length: Math.floor(len / 2) }, (_, i) => body.readUInt16BE(i * 2));
    if (type === NTSKE.END) { out.complete = true; break; }
    if (type === NTSKE.NEXT_PROTOCOL) out.protocols.push(...u16s());
    else if (type === NTSKE.ERROR) out.error = len >= 2 ? body.readUInt16BE(0) : -1;
    else if (type === NTSKE.AEAD) out.aead.push(...u16s());
    else if (type === NTSKE.COOKIE) out.cookies++;
    else if (type === NTSKE.SERVER) out.server = body.toString("ascii");
    else if (type === NTSKE.PORT && len >= 2) out.port = body.readUInt16BE(0);
  }
  return out;
}

const NTS_ERRORS: Record<number, string> = { 0: "unrecognized critical record", 1: "bad request", 2: "internal server error" };

export interface NtsKeOptions {
  port?: number;
  timeoutMs?: number;
  connect?: (opts: tls.ConnectionOptions) => tls.TLSSocket;
}

/** Run an NTS key exchange and judge it. Rejects with an operator-readable Error. */
export async function checkNtsKe(host: string, opts: NtsKeOptions = {}): Promise<NtsKeResult> {
  const { port = 4460, timeoutMs = 5000 } = opts;
  const bare = host.replace(/^\[|\]$/g, "");
  const socket = (opts.connect ?? tls.connect)({
    host: bare,
    port,
    servername: net.isIP(bare) ? undefined : bare,
    ALPNProtocols: ["ntske/1"],
    minVersion: "TLSv1.3",
  });
  return new Promise<NtsKeResult>((resolvePromise, reject) => {
    let received = Buffer.alloc(0);
    let done = false;
    const finish = (err: Error | null, value?: NtsKeResult) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.destroy();
      if (err) reject(err); else resolvePromise(value!);
    };
    const timer = setTimeout(() => finish(new Error(`NTS key exchange: no answer within ${timeoutMs / 1000} s`)), timeoutMs);
    socket.on("error", (err) => finish(new Error(`NTS key exchange: ${err.message}`)));
    socket.on("secureConnect", () => {
      if (socket.alpnProtocol !== "ntske/1") {
        finish(new Error("NTS key exchange: the server did not agree to NTS-KE (no ntske/1 ALPN)"));
        return;
      }
      socket.write(buildNtsKeRequest());
    });
    socket.on("data", (chunk: Buffer) => {
      received = Buffer.concat([received, chunk]);
      const r = parseNtsKeResponse(received);
      if (r.error !== null) { finish(new Error(`NTS key exchange refused: ${NTS_ERRORS[r.error] ?? `error ${r.error}`}`)); return; }
      if (!r.complete) return;
      if (!r.protocols.includes(0)) finish(new Error("NTS key exchange: the server did not agree to NTPv4"));
      else if (!r.aead.includes(NTS_AEAD_AES_SIV_CMAC_256)) finish(new Error("NTS key exchange: the server did not agree to AES-SIV-CMAC-256"));
      else if (r.cookies === 0) finish(new Error("NTS key exchange: the server issued no cookies"));
      else finish(null, r);
    });
    socket.on("end", () => finish(new Error("NTS key exchange: the server closed the connection before End of Message")));
  });
}
