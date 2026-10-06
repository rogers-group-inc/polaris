/**
 * src/services/firmwareEngines/deviceHttp.ts — the HTTP client both engines
 * use to talk to a switch or access point's OWN web UI.
 *
 * Every rule here was learned on real hardware by the fortiupgrade CLI and is
 * transcribed, not redesigned:
 *
 *   - Device certificates are self-signed, so TLS is not verified. An
 *     "unsafe legacy renegotiation" error is retried ONCE with
 *     SSL_OP_LEGACY_SERVER_CONNECT — older FortiSwitch builds need it.
 *   - Redirects are NEVER followed. A 302 to /login IS the answer ("logged
 *     out"), and following it would turn a session check into a login page.
 *   - Cookies are kept as bare `name=value` pairs. The devices set Domain to
 *     their own IP, which a spec-compliant jar would refuse.
 *   - A multipart upload sends a PRECOMPUTED Content-Length and streams the
 *     file. The FortiSwitch upload handler rejects chunked bodies.
 *   - The upload has an IDLE cap, not a total cap: a switch at 100% CPU
 *     accepted 0.2 MB/s and would have blown any sane total budget while
 *     still making progress.
 *   - Response bodies are capped; a device UI page is small and a runaway
 *     read is the wrong way to find out something went sideways.
 */

import { request as httpsRequest, type RequestOptions } from "node:https";
import { request as httpRequest } from "node:http";
import { createReadStream } from "node:fs";
import { Transform, type Readable, type TransformCallback } from "node:stream";
import { constants as cryptoConstants } from "node:crypto";
import { randomBytes } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";

export interface DeviceHttpClientOptions {
  host: string;
  port?: number;
  scheme?: "https" | "http";
  /** Per-request timeout (headers + body) for ordinary calls. */
  commandMs: number;
  /** Idle cap on an upload — bytes must keep being accepted. */
  uploadIdleMs: number;
  /** Cap on a response body. */
  maxBodyBytes?: number;
  /**
   * Verify the device's certificate. Default false (self-signed devices);
   * true only when the integration a FortiGate token came from verifies.
   */
  verifyTls?: boolean;
}

export interface DeviceHttpResponse {
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
  /** The Location header on a redirect, if any. */
  location: string | null;
}

export interface MultipartField {
  name: string;
  value: string;
}

export interface MultipartFile {
  field: string;
  filename: string;
  path: string;
  size: number;
  contentType?: string;
}

/** Thrown when the socket died without a status line — the callers decide what that means at each stage. */
export class DeviceConnectionError extends Error {
  constructor(message: string, readonly code?: string, readonly bytesSent = 0, readonly bodyFullySent = false) {
    super(message);
    this.name = "DeviceConnectionError";
  }
}

const DEFAULT_MAX_BODY = 2 * 1024 * 1024;
const LEGACY_RENEGOTIATION = /unsafe legacy renegotiation|SSL_OP_LEGACY_SERVER_CONNECT|unsafe_legacy_renegotiation/i;

export class DeviceHttpClient {
  private readonly cookies = new Map<string, string>();
  private legacyTls = false;
  readonly base: string;

  constructor(private readonly opts: DeviceHttpClientOptions) {
    const scheme = opts.scheme ?? "https";
    const port = opts.port ?? (scheme === "https" ? 443 : 80);
    this.base = `${scheme}://${opts.host}:${port}`;
  }

  /** A header value the engine wants echoed on every request (the FortiAP CSRF token). */
  private readonly extraHeaders = new Map<string, string>();
  setHeader(name: string, value: string | null): void {
    if (value === null) this.extraHeaders.delete(name);
    else this.extraHeaders.set(name, value);
  }

  clearSession(): void {
    this.cookies.clear();
    this.extraHeaders.clear();
  }

  /** How many cookies the device has handed us since the last clearSession(). */
  cookieCount(): number {
    return this.cookies.size;
  }

  hasCookie(name: string): boolean {
    return this.cookies.has(name);
  }

  /** The value of the first cookie whose NAME matches — FortiOS suffixes its CSRF cookie per port. */
  cookieMatching(name: RegExp): string | null {
    for (const [k, v] of this.cookies) if (name.test(k)) return v;
    return null;
  }

  get(path: string, timeoutMs = this.opts.commandMs): Promise<DeviceHttpResponse> {
    return this.send("GET", path, null, {}, timeoutMs);
  }

  /** `application/x-www-form-urlencoded`, fields in the order given. */
  postForm(path: string, fields: MultipartField[], timeoutMs = this.opts.commandMs): Promise<DeviceHttpResponse> {
    const body = fields.map((f) => `${encodeURIComponent(f.name)}=${encodeURIComponent(f.value)}`).join("&");
    return this.send("POST", path, Buffer.from(body, "utf8"), { "content-type": "application/x-www-form-urlencoded" }, timeoutMs);
  }

  /** A JSON POST (FortiOS REST). */
  postJson(path: string, payload: unknown, timeoutMs = this.opts.commandMs): Promise<DeviceHttpResponse> {
    return this.send("POST", path, Buffer.from(JSON.stringify(payload), "utf8"), { "content-type": "application/json" }, timeoutMs);
  }

  /**
   * A JSON POST whose one string field is a FILE, base64-encoded on the fly:
   * `{ ...fields, [fileField]: "<base64 of the file>" }` — the FortiOS REST
   * upload shape (`file_content`). The body is ~4/3 of the image — 330 MB for
   * a 250 MB FortiGate image — so it is streamed with a precomputed
   * Content-Length and never held in memory.
   */
  async postJsonBase64File(
    path: string,
    fields: Record<string, string | boolean | number>,
    fileField: string,
    file: { path: string; size: number },
    onProgress?: (sent: number, total: number) => void,
  ): Promise<DeviceHttpResponse> {
    const prefix = JSON.stringify(fields).slice(0, -1); // "{...fields" without the closing brace
    const head = Buffer.from(`${prefix}${prefix.length > 1 ? "," : ""}${JSON.stringify(fileField)}:"`, "utf8");
    const tail = Buffer.from(`"}`, "utf8");
    const total = head.length + base64Length(file.size) + tail.length;
    return this.sendStreamed(path, { "content-type": "application/json" }, total, head, () => createReadStream(file.path).pipe(new Base64Encode()), tail, onProgress);
  }

  /** A bodiless POST — the FortiAP UI probe. */
  postEmpty(path: string, timeoutMs = this.opts.commandMs): Promise<DeviceHttpResponse> {
    return this.send("POST", path, Buffer.alloc(0), {}, timeoutMs);
  }

  /**
   * Streamed multipart upload. `fields` go out FIRST in the order given, then
   * the file — the FortiSwitch handler reads them positionally. Content-Length
   * is computed up front from the field bytes + the file size on disk.
   */
  async postMultipart(
    path: string,
    fields: MultipartField[],
    file: MultipartFile,
    onProgress?: (sent: number, total: number) => void,
  ): Promise<DeviceHttpResponse> {
    const boundary = "----PolarisFirmware" + randomBytes(12).toString("hex");
    const head = Buffer.from(
      fields.map((f) => `--${boundary}\r\nContent-Disposition: form-data; name="${f.name}"\r\n\r\n${f.value}\r\n`).join("") +
      `--${boundary}\r\nContent-Disposition: form-data; name="${file.field}"; filename="${file.filename}"\r\n` +
      `Content-Type: ${file.contentType ?? "application/octet-stream"}\r\n\r\n`,
      "utf8",
    );
    const tail = Buffer.from(`\r\n--${boundary}--\r\n`, "utf8");
    const total = head.length + file.size + tail.length;
    return this.sendStreamed(path, { "content-type": `multipart/form-data; boundary=${boundary}` }, total, head, () => createReadStream(file.path), tail, onProgress);
  }

  // ─── transport ─────────────────────────────────────────────────────────────

  private requestOptions(method: string, path: string, headers: Record<string, string>): RequestOptions & { protocol: string } {
    const url = new URL(path, this.base);
    const h: Record<string, string> = {
      "accept": "*/*",
      "user-agent": "Polaris-Firmware/1.0",
      ...headers,
    };
    const cookie = Array.from(this.cookies.entries()).map(([k, v]) => `${k}=${v}`).join("; ");
    if (cookie) h["cookie"] = cookie;
    for (const [k, v] of this.extraHeaders) h[k] = v;
    const o: RequestOptions & { protocol: string } = {
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method,
      headers: h,
      rejectUnauthorized: this.opts.verifyTls === true,
      // Never reuse a socket: the devices close them unpredictably and a
      // stale keep-alive turns into an ECONNRESET on the next call.
      agent: false,
    };
    if (this.legacyTls) o.secureOptions = cryptoConstants.SSL_OP_LEGACY_SERVER_CONNECT;
    return o;
  }

  private takeCookies(headers: IncomingHttpHeaders): void {
    const set = headers["set-cookie"];
    if (!set) return;
    for (const line of set) {
      const pair = line.split(";")[0] ?? "";
      const eq = pair.indexOf("=");
      if (eq <= 0) continue;
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      // An emptied cookie is the device logging us out.
      if (value === "" || value === '""') this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }

  private async send(
    method: string,
    path: string,
    body: Buffer | null,
    headers: Record<string, string>,
    timeoutMs: number,
    retried = false,
  ): Promise<DeviceHttpResponse> {
    const opts = this.requestOptions(method, path, headers);
    if (body) opts.headers = { ...(opts.headers as Record<string, string>), "content-length": String(body.length) };
    const reqFn = opts.protocol === "https:" ? httpsRequest : httpRequest;
    const maxBody = this.opts.maxBodyBytes ?? DEFAULT_MAX_BODY;
    try {
      return await new Promise<DeviceHttpResponse>((resolve, reject) => {
        const req = reqFn(opts, (res) => {
          this.takeCookies(res.headers);
          const chunks: Buffer[] = [];
          let size = 0;
          res.on("data", (c: Buffer) => {
            size += c.length;
            if (size <= maxBody) chunks.push(c);
          });
          res.on("end", () => resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString("utf8"),
            location: typeof res.headers.location === "string" ? res.headers.location : null,
          }));
          res.on("error", (err) => reject(new DeviceConnectionError(err.message, (err as NodeJS.ErrnoException).code)));
        });
        req.setTimeout(timeoutMs, () => req.destroy(new Error(`timed out after ${timeoutMs} ms`)));
        req.on("error", (err) => reject(new DeviceConnectionError(err.message, (err as NodeJS.ErrnoException).code)));
        if (body) req.end(body); else req.end();
      });
    } catch (err) {
      if (!retried && !this.legacyTls && err instanceof Error && LEGACY_RENEGOTIATION.test(err.message)) {
        this.legacyTls = true;
        return this.send(method, path, body, headers, timeoutMs, true);
      }
      throw err;
    }
  }

  private sendStreamed(
    path: string,
    headers: Record<string, string>,
    total: number,
    head: Buffer,
    openBody: () => Readable,
    tail: Buffer,
    onProgress?: (sent: number, total: number) => void,
  ): Promise<DeviceHttpResponse> {
    const opts = this.requestOptions("POST", path, { ...headers, "content-length": String(total) });
    const reqFn = opts.protocol === "https:" ? httpsRequest : httpRequest;
    const maxBody = this.opts.maxBodyBytes ?? DEFAULT_MAX_BODY;
    const idleMs = this.opts.uploadIdleMs;
    return new Promise<DeviceHttpResponse>((resolve, reject) => {
      let sent = 0;
      let fullySent = false;
      let settled = false;
      let idleTimer: NodeJS.Timeout | null = null;
      const fail = (message: string, code?: string) => {
        if (settled) return;
        settled = true;
        if (idleTimer) clearTimeout(idleTimer);
        reject(new DeviceConnectionError(message, code, sent, fullySent));
      };
      const armIdle = () => {
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(() => {
          req.destroy(new Error(`upload stalled: no bytes accepted for ${Math.round(idleMs / 1000)} s (${sent} of ${total} sent)`));
        }, idleMs);
      };
      const req = reqFn(opts, (res) => {
        this.takeCookies(res.headers);
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (c: Buffer) => {
          size += c.length;
          if (size <= maxBody) chunks.push(c);
        });
        res.on("end", () => {
          if (settled) return;
          settled = true;
          if (idleTimer) clearTimeout(idleTimer);
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString("utf8"),
            location: typeof res.headers.location === "string" ? res.headers.location : null,
          });
        });
        res.on("error", (err) => fail(err.message, (err as NodeJS.ErrnoException).code));
      });
      req.on("error", (err) => fail(err.message, (err as NodeJS.ErrnoException).code));
      armIdle();
      req.write(head);
      sent += head.length;
      const stream = openBody();
      stream.on("error", (err) => { req.destroy(err); });
      stream.on("data", (chunk: Buffer | string) => {
        const buf = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
        const ok = req.write(buf);
        sent += buf.length;
        armIdle();
        onProgress?.(sent, total);
        if (!ok) {
          stream.pause();
          req.once("drain", () => stream.resume());
        }
      });
      stream.on("end", () => {
        req.end(tail, () => {
          sent += tail.length;
          fullySent = true;
          onProgress?.(sent, total);
          // The device may take minutes to answer after the last byte (it is
          // checksumming a 60 MB image); the idle cap becomes a response cap.
          armIdle();
        });
      });
    });
  }
}

/** Length of the padded base64 encoding of `n` bytes. Pure. */
export function base64Length(n: number): number {
  return 4 * Math.ceil(n / 3);
}

/**
 * Streaming base64: carries the 0–2 bytes that do not fill a 3-byte group to
 * the next chunk, so the output is byte-identical to encoding the whole file
 * at once, whatever the chunk boundaries.
 */
export class Base64Encode extends Transform {
  private carry: Buffer = Buffer.alloc(0);
  override _transform(chunk: Buffer, _enc: BufferEncoding, cb: TransformCallback): void {
    const buf = this.carry.length ? Buffer.concat([this.carry, chunk]) : chunk;
    const whole = buf.length - (buf.length % 3);
    this.carry = Buffer.from(buf.subarray(whole));
    if (whole > 0) this.push(buf.subarray(0, whole).toString("base64"));
    cb();
  }
  override _flush(cb: TransformCallback): void {
    if (this.carry.length) this.push(this.carry.toString("base64"));
    cb();
  }
}

/** Parse a JSON body, or null. */
export function jsonOrNull(body: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(body);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function asString(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : typeof v === "number" ? String(v) : null;
}

export function asNumber(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return null;
}
