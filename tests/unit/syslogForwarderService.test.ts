/**
 * tests/unit/syslogForwarderService.test.ts — business rule 187: Events are
 * forwarded to syslog through a bounded, non-blocking hand-off; formatting
 * (RFC 5424 / 3164), framing, the severity floor, UDP and the persistent
 * TCP / TLS connection with reconnect. No real socket is opened.
 */
import { EventEmitter } from "node:events";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const h = vi.hoisted(() => ({
  createSocket: vi.fn(),
  createConnection: vi.fn(),
  tlsConnect: vi.fn(),
  readFileSync: vi.fn((p: string) => Buffer.from(`contents of ${p}`)),
  listCertificates: vi.fn(async () => ({ trustedCAs: [] as Array<{ type: string; pem: string }>, serverCerts: [] })),
  warn: vi.fn(),
}));

vi.mock("node:dgram", () => ({ createSocket: h.createSocket }));
vi.mock("node:net", async (orig) => ({ ...(await orig<object>()), createConnection: h.createConnection }));
vi.mock("node:tls", async (orig) => ({ ...(await orig<object>()), connect: h.tlsConnect }));
vi.mock("node:fs", async (orig) => ({ ...(await orig<object>()), readFileSync: h.readFileSync }));
vi.mock("node:os", async (orig) => ({ ...(await orig<object>()), hostname: () => "polaris-01" }));
vi.mock("../../src/services/serverSettingsService.js", () => ({ listCertificates: h.listCertificates }));
vi.mock("../../src/utils/logger.js", () => {
  const logger: Record<string, unknown> = { info: vi.fn(), warn: h.warn, error: vi.fn(), debug: vi.fn() };
  logger.child = () => logger;
  return { logger };
});

import {
  formatSyslogMessage, frameForStream, syslogPri, passesSeverity, truncateUtf8, buildTlsOptions,
  forwardEvents, invalidateSyslogSettingsCache, _resetSyslogForwarderForTests, _flushSyslogForwarderForTests,
  MAX_QUEUE, type ForwardedEvent,
} from "../../src/services/syslogForwarderService.js";
import type { SyslogSettings } from "../../src/services/eventArchiveService.js";

const BASE: SyslogSettings = {
  enabled: true, protocol: "udp", host: "syslog.corp", port: 514, facility: "local0",
  severity: "info", format: "rfc5424", tlsCaPath: "", tlsCertPath: "", tlsKeyPath: "",
};

const AT = new Date("2026-11-14T09:05:07.123Z");
const ev = (over: Partial<ForwardedEvent> = {}): ForwardedEvent => ({
  at: AT, action: "asset.updated", level: "info", message: "Asset web-01 updated", ...over,
});

class FakeSock extends EventEmitter {
  written: string[] = [];
  writeOk = true;
  write = vi.fn((s: string) => { this.written.push(s); return this.writeOk; });
  end = vi.fn();
  destroy = vi.fn();
  setKeepAlive = vi.fn();
  unref = vi.fn();
}

function udpClient() {
  const client = Object.assign(new EventEmitter(), {
    send: vi.fn((_b: Buffer, _o: number, _l: number, _p: number, _h: string, cb?: (e?: Error) => void) => cb?.()),
    close: vi.fn(),
    unref: vi.fn(),
  });
  h.createSocket.mockReturnValue(client);
  return client;
}

let settings: SyslogSettings;
const loader = vi.fn(async () => settings);

beforeEach(() => {
  vi.clearAllMocks();
  settings = { ...BASE };
  _resetSyslogForwarderForTests(loader);
});
afterEach(() => {
  vi.useRealTimers();
  _resetSyslogForwarderForTests(loader);
});

describe("syslogPri / passesSeverity", () => {
  it("is facility × 8 + severity, error 3 / warning 4 / info 6", () => {
    expect(syslogPri("local0", "info")).toBe(134);
    expect(syslogPri("local0", "warning")).toBe(132);
    expect(syslogPri("local7", "error")).toBe(23 * 8 + 3);
    expect(syslogPri("auth", "info")).toBe(4 * 8 + 6);
  });
  it("an unknown facility or level falls back to local0 / info", () => {
    expect(syslogPri("nonsense", "nonsense")).toBe(134);
  });
  it("passes a level at or above the minimum", () => {
    expect(passesSeverity("info", "info")).toBe(true);
    expect(passesSeverity("info", "warning")).toBe(false);
    expect(passesSeverity("warning", "warning")).toBe(true);
    expect(passesSeverity("error", "warning")).toBe(true);
    expect(passesSeverity("warning", "error")).toBe(false);
  });
});

describe("formatSyslogMessage", () => {
  it("RFC 5424: header, structured data with only the present fields, then the message", () => {
    const m = formatSyslogMessage(ev({ resourceType: "asset", resourceId: "a1", resourceName: "web-01", actor: "alice" }), BASE, "polaris-01");
    expect(m).toBe(
      `<134>1 2026-11-14T09:05:07.123Z polaris-01 polaris ${process.pid} asset.updated ` +
      `[polaris@32473 action="asset.updated" level="info" resourceType="asset" resourceId="a1" resourceName="web-01" actor="alice"] Asset web-01 updated`,
    );
  });

  it("RFC 5424: escapes \" \\ and ] in a parameter value, and keeps the message on one line", () => {
    const m = formatSyslogMessage(ev({ resourceName: 'a"b\\c]d', message: "line one\r\nline two" }), BASE, "h");
    expect(m).toContain('resourceName="a\\"b\\\\c\\]d"');
    expect(m.endsWith("] line one line two")).toBe(true);
  });

  it("RFC 5424: MSGID is printable ASCII, at most 32 characters; an empty host is '-'", () => {
    const m = formatSyslogMessage(ev({ action: "a very long action name with spaces in it.x" }), BASE, "");
    const parts = m.split(" ");
    expect(parts[2]).toBe("-");
    expect(parts[5]).toBe("averylongactionnamewithspacesini");
    expect(parts[5].length).toBe(32);
  });

  it("RFC 3164: local-time BSD timestamp with a space-padded day, tag with the pid", () => {
    const at = new Date(2026, 2, 5, 7, 8, 9); // local 5 March 07:08:09
    const m = formatSyslogMessage(ev({ at, level: "warning" }), { facility: "local1", format: "rfc3164" }, "polaris-01");
    expect(m).toBe(`<${17 * 8 + 4}>Mar  5 07:08:09 polaris-01 polaris[${process.pid}]: asset.updated: Asset web-01 updated`);
  });
});

describe("frameForStream / truncateUtf8", () => {
  it("RFC 5424 is octet-counted in BYTES; RFC 3164 newline-terminated", () => {
    expect(frameForStream("héllo", "rfc5424")).toBe("6 héllo");
    expect(frameForStream("hello", "rfc3164")).toBe("hello\n");
  });
  it("never splits a multi-byte character", () => {
    expect(truncateUtf8("abcé", 4)).toBe("abc");
    expect(truncateUtf8("abcé", 5)).toBe("abcé");
    expect(truncateUtf8("short", 100)).toBe("short");
  });
});

describe("buildTlsOptions", () => {
  it("with no CA file: verifies against the system store plus uploaded CAs, by server name", () => {
    const o = buildTlsOptions({ ...BASE, protocol: "tls", port: 6514 }, ["UPLOADED-PEM"]);
    expect(o.rejectUnauthorized).toBe(true);
    expect(o.servername).toBe("syslog.corp");
    expect((o.ca as string[]).at(-1)).toBe("UPLOADED-PEM");
    expect((o.ca as string[]).length).toBeGreaterThan(1);
    expect(h.readFileSync).not.toHaveBeenCalled();
  });
  it("with a CA file: that CA alone, plus the client cert and key", () => {
    const o = buildTlsOptions({ ...BASE, protocol: "tls", tlsCaPath: "/ca.pem", tlsCertPath: "/c.pem", tlsKeyPath: "/k.pem" }, ["IGNORED"]);
    expect((o.ca as Buffer[]).map(String)).toEqual(["contents of /ca.pem"]);
    expect(String(o.cert)).toBe("contents of /c.pem");
    expect(String(o.key)).toBe("contents of /k.pem");
  });
  it("an IP-literal host sends no SNI server name", () => {
    expect(buildTlsOptions({ ...BASE, host: "fd00::5" }, []).servername).toBeUndefined();
  });
});

describe("forwardEvents — the hand-off", () => {
  it("is synchronous and never throws, even when the settings cannot be read", async () => {
    loader.mockRejectedValueOnce(new Error("db down"));
    expect(() => forwardEvents([ev()])).not.toThrow();
    await _flushSyslogForwarderForTests();
    expect(h.createSocket).not.toHaveBeenCalled();
  });

  it("forwarding off, or no host: nothing is opened", async () => {
    settings = { ...BASE, enabled: false };
    forwardEvents([ev()]);
    await _flushSyslogForwarderForTests();
    settings = { ...BASE, host: "" };
    invalidateSyslogSettingsCache();
    forwardEvents([ev()]);
    await _flushSyslogForwarderForTests();
    expect(h.createSocket).not.toHaveBeenCalled();
    expect(h.createConnection).not.toHaveBeenCalled();
  });

  it("flushes on the next tick without being asked", async () => {
    const client = udpClient();
    forwardEvents([ev()]);
    expect(client.send).not.toHaveBeenCalled();
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    expect(client.send).toHaveBeenCalledTimes(1);
  });
});

describe("UDP", () => {
  it("one datagram per Event above the floor, on ONE reused socket", async () => {
    const client = udpClient();
    settings = { ...BASE, severity: "warning" };
    forwardEvents([ev({ level: "info" }), ev({ level: "warning" }), ev({ level: "error" })]);
    await _flushSyslogForwarderForTests();
    forwardEvents([ev({ level: "error", message: "second" })]);
    await _flushSyslogForwarderForTests();
    expect(h.createSocket).toHaveBeenCalledTimes(1);
    expect(h.createSocket).toHaveBeenCalledWith("udp4");
    expect(client.send).toHaveBeenCalledTimes(3);
    const [buf, , , port, host] = client.send.mock.calls[0];
    expect(String(buf)).toMatch(/^<132>1 /);
    expect([port, host]).toEqual([514, "syslog.corp"]);
  });

  it("an IPv6 server gets a udp6 socket (rule 128)", async () => {
    udpClient();
    settings = { ...BASE, host: "fd00::5" };
    forwardEvents([ev()]);
    await _flushSyslogForwarderForTests();
    expect(h.createSocket).toHaveBeenCalledWith("udp6");
  });

  it("a datagram is capped at 2048 bytes", async () => {
    const client = udpClient();
    forwardEvents([ev({ message: "x".repeat(5000) })]);
    await _flushSyslogForwarderForTests();
    expect((client.send.mock.calls[0][0] as Buffer).length).toBe(2048);
  });

  it("a destination change closes the old socket and opens a new one", async () => {
    const first = udpClient();
    forwardEvents([ev()]);
    await _flushSyslogForwarderForTests();
    udpClient();
    settings = { ...BASE, host: "syslog2.corp" };
    invalidateSyslogSettingsCache();
    forwardEvents([ev()]);
    await _flushSyslogForwarderForTests();
    expect(first.close).toHaveBeenCalled();
    expect(h.createSocket).toHaveBeenCalledTimes(2);
  });

  it("settings are cached: a second batch does not re-read them", async () => {
    udpClient();
    forwardEvents([ev()]);
    await _flushSyslogForwarderForTests();
    forwardEvents([ev()]);
    await _flushSyslogForwarderForTests();
    expect(loader).toHaveBeenCalledTimes(1);
  });
});

describe("TCP / TLS — one persistent connection", () => {
  it("queues until connected, then writes octet-counted frames on the same socket", async () => {
    const sock = new FakeSock();
    let onConnect: () => void = () => {};
    h.createConnection.mockImplementation((_o: unknown, cb: () => void) => { onConnect = cb; return sock; });
    settings = { ...BASE, protocol: "tcp", port: 601 };
    forwardEvents([ev({ message: "one" })]);
    await _flushSyslogForwarderForTests();
    expect(sock.written).toEqual([]);
    onConnect();
    forwardEvents([ev({ message: "two" })]);
    await _flushSyslogForwarderForTests();
    expect(h.createConnection).toHaveBeenCalledTimes(1);
    expect(h.createConnection.mock.calls[0][0]).toEqual({ host: "syslog.corp", port: 601 });
    expect(sock.written).toHaveLength(2);
    for (const w of sock.written) {
      const m = /^(\d+) (.*)$/s.exec(w)!;
      expect(Number(m[1])).toBe(Buffer.byteLength(m[2]));
    }
    expect(sock.written[1].endsWith(" two")).toBe(true);
  });

  it("reconnects with backoff after the connection closes, and sends what queued meanwhile", async () => {
    vi.useFakeTimers();
    const socks: FakeSock[] = [];
    h.createConnection.mockImplementation((_o: unknown, cb: () => void) => { const s = new FakeSock(); socks.push(s); setTimeout(cb, 0); return s; });
    settings = { ...BASE, protocol: "tcp" };
    forwardEvents([ev({ message: "before" })]);
    await _flushSyslogForwarderForTests();
    await vi.advanceTimersByTimeAsync(1);
    expect(socks[0].written).toHaveLength(1);
    socks[0].emit("close");
    forwardEvents([ev({ message: "during" })]);
    await _flushSyslogForwarderForTests();
    expect(socks).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(1);
    expect(socks).toHaveLength(2);
    expect(socks[1].written.map((w) => w.endsWith(" during"))).toEqual([true]);
  });

  it("waits for 'drain' when the socket pushes back", async () => {
    const sock = new FakeSock();
    h.createConnection.mockImplementation((_o: unknown, cb: () => void) => { setImmediate(cb); return sock; });
    settings = { ...BASE, protocol: "tcp" };
    sock.writeOk = false;
    forwardEvents([ev({ message: "a" }), ev({ message: "b" })]);
    await _flushSyslogForwarderForTests();
    await new Promise((r) => setImmediate(r));
    expect(sock.written).toHaveLength(1);
    sock.writeOk = true;
    sock.emit("drain");
    expect(sock.written).toHaveLength(2);
  });

  it("a server that never answers holds at most MAX_QUEUE messages, dropping the oldest", async () => {
    const sock = new FakeSock();
    h.createConnection.mockImplementation(() => sock);
    settings = { ...BASE, protocol: "tcp" };
    forwardEvents(Array.from({ length: MAX_QUEUE }, (_, i) => ev({ message: `m${i}` })));
    await _flushSyslogForwarderForTests();
    expect(h.warn).not.toHaveBeenCalled();
    forwardEvents(Array.from({ length: 5 }, (_, i) => ev({ message: `late${i}` })));
    await _flushSyslogForwarderForTests();
    expect(h.warn).toHaveBeenCalledWith(expect.objectContaining({ dropped: 5 }), expect.stringContaining("dropped"));
    expect(sock.written).toEqual([]);
  });

  it("TLS uses the uploaded Trusted CAs when no CA file is set", async () => {
    h.listCertificates.mockResolvedValueOnce({ trustedCAs: [{ type: "cert", pem: "UPLOADED" }, { type: "key", pem: "NOT-A-CA" }], serverCerts: [] });
    const sock = new FakeSock();
    h.tlsConnect.mockImplementation(() => sock);
    settings = { ...BASE, protocol: "tls", port: 6514 };
    forwardEvents([ev()]);
    await _flushSyslogForwarderForTests();
    const opts = h.tlsConnect.mock.calls[0][0];
    expect(opts.ca).toContain("UPLOADED");
    expect(opts.ca).not.toContain("NOT-A-CA");
    expect(opts.rejectUnauthorized).toBe(true);
  });

  it("an unreadable CA file is logged and retried, never thrown into the Event write", async () => {
    vi.useFakeTimers();
    h.readFileSync.mockImplementation(() => { throw new Error("ENOENT"); });
    settings = { ...BASE, protocol: "tls", tlsCaPath: "/missing.pem" };
    forwardEvents([ev()]);
    await _flushSyslogForwarderForTests();
    expect(h.tlsConnect).not.toHaveBeenCalled();
    expect(h.warn).toHaveBeenCalled();
    h.readFileSync.mockImplementation((p: string) => Buffer.from(`contents of ${p}`));
  });

  it("turning forwarding off closes the connection", async () => {
    const sock = new FakeSock();
    h.createConnection.mockImplementation((_o: unknown, cb: () => void) => { setImmediate(cb); return sock; });
    settings = { ...BASE, protocol: "tcp" };
    forwardEvents([ev()]);
    await _flushSyslogForwarderForTests();
    settings = { ...BASE, protocol: "tcp", enabled: false };
    invalidateSyslogSettingsCache();
    forwardEvents([ev()]);
    await _flushSyslogForwarderForTests();
    expect(sock.end).toHaveBeenCalled();
  });
});
