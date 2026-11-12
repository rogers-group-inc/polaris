/**
 * tests/unit/remoteExec.test.ts
 *
 * The shared SSH / WinRM primitives, with ssh2's Client, winrm and the host-key
 * service replaced by fakes — no connection is ever opened. sshHostKey
 * .test.ts covers the pinning service end to end; this pins the client
 * plumbing: credential checks, connect options (password vs key, passphrase,
 * port), business rule 113's default-on host verification failing closed,
 * always closing the client, exec timeouts, SFTP writes and the
 * -EncodedCommand wrapper.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";

const h = vi.hoisted(() => ({
  clients: [] as any[],
  connectImpl: null as null | ((self: any, opts: any) => void),
  winrmRunOne: vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" })),
  verifyOrPin: vi.fn(async () => ({ ok: true })),
}));

vi.mock("ssh2", async () => {
  const { EventEmitter: EE } = await import("node:events");
  class Client extends EE {
    connectOpts: any = null;
    end = vi.fn();
    constructor() { super(); h.clients.push(this); }
    connect(opts: any) { this.connectOpts = opts; h.connectImpl?.(this, opts); }
  }
  return { Client };
});
vi.mock("../../src/utils/winrm.js", () => ({ winrmRunOne: h.winrmRunOne }));
vi.mock("../../src/services/sshHostKeyService.js", () => ({ verifyOrPin: h.verifyOrPin }));

import { withSshClient, buildHostVerifier, sshExec, sftpPut, winrmRunPowershell } from "../../src/utils/remoteExec.js";

beforeEach(() => {
  h.clients.length = 0;
  h.connectImpl = (self) => queueMicrotask(() => self.emit("ready"));
  h.verifyOrPin.mockReset();
  h.verifyOrPin.mockResolvedValue({ ok: true });
  h.winrmRunOne.mockClear();
});
afterEach(() => vi.useRealTimers());

describe("withSshClient", () => {
  it("refuses a credential without a username or a secret, before connecting", async () => {
    await expect(withSshClient("h", { password: "x" }, async () => 1)).rejects.toThrow(/missing username/);
    await expect(withSshClient("h", { username: "u" }, async () => 1)).rejects.toThrow(/password\/privateKey/);
    expect(h.clients).toHaveLength(0);
  });

  it("connects with a password on port 22 by default, runs fn and closes the client", async () => {
    const out = await withSshClient("h", { username: "u", password: "p" }, async () => "done");
    expect(out).toBe("done");
    const c = h.clients[0];
    expect(c.connectOpts).toMatchObject({ host: "h", port: 22, username: "u", password: "p", readyTimeout: 30_000 });
    expect(typeof c.connectOpts.hostVerifier).toBe("function");
    expect(c.end).toHaveBeenCalled();
  });

  it("prefers a private key (with its passphrase) over a password and honours the port", async () => {
    await withSshClient("h", { username: "u", password: "p", privateKey: "KEY", passphrase: "pp", port: "2222" }, async () => 0);
    const o = h.clients[0].connectOpts;
    expect(o.privateKey).toBe("KEY");
    expect(o.passphrase).toBe("pp");
    expect(o.password).toBeUndefined();
    expect(o.port).toBe(2222);
  });

  it("omits the passphrase for an unencrypted key and falls back to 22 for a junk port", async () => {
    await withSshClient("h", { username: "u", privateKey: "KEY", port: "abc" }, async () => 0);
    expect(h.clients[0].connectOpts.passphrase).toBeUndefined();
    expect(h.clients[0].connectOpts.port).toBe(22);
  });

  it("skips host verification only when the credential says verifyHostKey: false", async () => {
    await withSshClient("h", { username: "u", password: "p", verifyHostKey: false }, async () => 0);
    expect(h.clients[0].connectOpts.hostVerifier).toBeUndefined();
  });

  it("rejects with fn's error (wrapping a non-Error) and still closes", async () => {
    await expect(withSshClient("h", { username: "u", password: "p" }, async () => { throw "plain"; })).rejects.toThrow("plain");
    expect(h.clients[0].end).toHaveBeenCalled();
  });

  it("rejects on a client error event and settles only once", async () => {
    h.connectImpl = (self) => queueMicrotask(() => { self.emit("error", new Error("auth failed")); self.emit("error", new Error("again")); });
    await expect(withSshClient("h", { username: "u", password: "p" }, async () => 1)).rejects.toThrow("auth failed");
    expect(h.clients[0].end).toHaveBeenCalledTimes(1);
  });

  it("rejects when connect throws synchronously", async () => {
    h.connectImpl = () => { throw new Error("bad opts"); };
    await expect(withSshClient("h", { username: "u", password: "p" }, async () => 1)).rejects.toThrow("bad opts");
  });
});

describe("buildHostVerifier", () => {
  const key = Buffer.from("blob");
  const verdict = (v: ReturnType<typeof buildHostVerifier>) => new Promise<boolean>((res) => v!(key, res));

  it("is null only for an explicit opt-out", () => {
    expect(buildHostVerifier("h", 22, { verifyHostKey: false })).toBeNull();
    expect(buildHostVerifier("h", 22, {})).not.toBeNull();
    expect(buildHostVerifier("h", 22, { verifyHostKey: "false" })).not.toBeNull();
  });

  it("passes host, port and the raw key to verifyOrPin and reports its verdict", async () => {
    h.verifyOrPin.mockResolvedValueOnce({ ok: false });
    expect(await verdict(buildHostVerifier("10.0.0.9", 2222, {}))).toBe(false);
    expect(h.verifyOrPin).toHaveBeenCalledWith("10.0.0.9", 2222, key);
    expect(await verdict(buildHostVerifier("h", 22, {}))).toBe(true);
  });

  it("fails CLOSED when the pinning service throws", async () => {
    h.verifyOrPin.mockRejectedValueOnce(new Error("db down"));
    expect(await verdict(buildHostVerifier("h", 22, {}))).toBe(false);
  });
});

function fakeStream() {
  const s: any = new EventEmitter();
  s.stderr = new EventEmitter();
  s.signal = vi.fn();
  return s;
}

describe("sshExec", () => {
  it("collects stdout / stderr and resolves with the exit code on close", async () => {
    const stream = fakeStream();
    const client: any = { exec: vi.fn((_cmd, cb) => cb(undefined, stream)) };
    const p = sshExec(client, "uname -a", 5000);
    stream.emit("data", Buffer.from("Linux "));
    stream.emit("data", Buffer.from("box"));
    stream.stderr.emit("data", Buffer.from("warn"));
    stream.emit("close", 3);
    await expect(p).resolves.toEqual({ exitCode: 3, stdout: "Linux box", stderr: "warn" });
    expect(client.exec.mock.calls[0][0]).toBe("uname -a");
  });

  it("reports a null exit code when the channel closes without one", async () => {
    const stream = fakeStream();
    const p = sshExec({ exec: (_c: string, cb: any) => cb(undefined, stream) } as any, "x", 5000);
    stream.emit("close", undefined);
    await expect(p).resolves.toMatchObject({ exitCode: null });
  });

  it("rejects an exec error", async () => {
    await expect(sshExec({ exec: (_c: string, cb: any) => cb(new Error("no channel")) } as any, "x", 5000)).rejects.toThrow("no channel");
  });

  it("KILLs the channel and rejects on timeout", async () => {
    vi.useFakeTimers();
    const stream = fakeStream();
    const p = sshExec({ exec: (_c: string, cb: any) => cb(undefined, stream) } as any, "sleep 99", 1000);
    const assertion = expect(p).rejects.toThrow("Remote command timed out after 1000ms");
    vi.advanceTimersByTime(1000);
    await assertion;
    expect(stream.signal).toHaveBeenCalledWith("KILL");
  });
});

describe("sftpPut", () => {
  it("writes the body with the given mode and resolves on close", async () => {
    const ws: any = new EventEmitter();
    ws.end = vi.fn(() => queueMicrotask(() => ws.emit("close")));
    const sftp = { createWriteStream: vi.fn(() => ws) };
    const client: any = { sftp: (cb: any) => cb(undefined, sftp) };
    await sftpPut(client, "/tmp/x", Buffer.from("hi"), 0o755);
    expect(sftp.createWriteStream).toHaveBeenCalledWith("/tmp/x", { mode: 0o755 });
    expect(ws.end).toHaveBeenCalledWith(Buffer.from("hi"));
  });

  it("rejects an sftp subsystem error and a stream error", async () => {
    await expect(sftpPut({ sftp: (cb: any) => cb(new Error("no sftp")) } as any, "/x", Buffer.alloc(0), 0o600)).rejects.toThrow("no sftp");
    const ws: any = new EventEmitter();
    ws.end = vi.fn(() => queueMicrotask(() => ws.emit("error", new Error("EACCES"))));
    await expect(sftpPut({ sftp: (cb: any) => cb(undefined, { createWriteStream: () => ws }) } as any, "/x", Buffer.alloc(0), 0o600)).rejects.toThrow("EACCES");
  });
});

describe("winrmRunPowershell", () => {
  it("sends the script as UTF-16-LE base64 via -EncodedCommand", async () => {
    const conn = { host: "w" } as any;
    const script = "Write-Host 'héllo \"quoted\"' & | %";
    await winrmRunPowershell(conn, script);
    const [c, exe, args] = h.winrmRunOne.mock.calls[0] as unknown as [unknown, string, string[]];
    expect(c).toBe(conn);
    expect(exe).toBe("powershell.exe");
    expect(args.slice(0, 5)).toEqual(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand"]);
    expect(Buffer.from(args[5], "base64").toString("utf16le")).toBe(script);
  });
});
