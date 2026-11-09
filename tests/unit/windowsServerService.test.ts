/**
 * tests/unit/windowsServerService.test.ts
 *
 * Windows Server DHCP over WinRM: the scope → subnet translation, the
 * include / exclude filter, the operator-facing connection-test verdicts, and
 * the WS-Management exchange itself (create shell → command → receive →
 * delete shell, Basic auth with the optional DOMAIN\user form, the PowerShell
 * sent as UTF-16LE base64, the shell deleted even when the command fails).
 *
 * The WinRM endpoint is a fake `fetch` that answers by SOAP Action.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { testConnection, discoverDhcpScopes, type WindowsServerConfig } from "../../src/services/windowsServerService.js";

type Call = { url: string; auth: string; action: string; body: string };
let calls: Call[] = [];
let stdout = "";
let failAction: string | null = null;
let failStatus = 500;
let fetchError: unknown = null;

function actionOf(body: string): string {
  const m = /<wsa:Action[^>]*>([^<]+)<\/wsa:Action>/.exec(body);
  return m ? m[1].split("/").pop()! : "?";
}

function fakeFetch(url: string, init: { headers: Record<string, string>; body: string }) {
  const action = actionOf(init.body);
  calls.push({ url, auth: init.headers.Authorization, action, body: init.body });
  if (fetchError) return Promise.reject(fetchError);
  if (failAction === action) return Promise.resolve(new Response("", { status: failStatus }));
  const text =
    action === "Create" ? `<x><wsman:Selector Name="ShellId">SHELL-1</wsman:Selector></x>`
    : action === "Command" ? `<x><rsp:CommandId>CMD-1</rsp:CommandId></x>`
    : action === "Receive"
      ? // stdout arrives in base64 chunks; split to prove they are concatenated
        [stdout.slice(0, 5), stdout.slice(5)].map((c) =>
          `<rsp:Stream Name="stdout" CommandId="CMD-1">${Buffer.from(c, "utf8").toString("base64")}</rsp:Stream>`).join("") +
        `<rsp:Stream Name="stderr" CommandId="CMD-1">${Buffer.from("noise").toString("base64")}</rsp:Stream>`
    : "";
  return Promise.resolve(new Response(text, { status: 200 }));
}

const cfg = (over: Partial<WindowsServerConfig> = {}): WindowsServerConfig =>
  ({ host: "dhcp01.corp.example", username: "svc", password: "pw", ...over });

beforeEach(() => {
  calls = [];
  stdout = "";
  failAction = null;
  failStatus = 500;
  fetchError = null;
  vi.stubGlobal("fetch", vi.fn(fakeFetch));
});
afterEach(() => vi.unstubAllGlobals());

// ─── The WinRM exchange ──────────────────────────────────────────────────────

describe("WinRM exchange", () => {
  it("creates a shell, runs one command, receives, then deletes the shell — on :5985 over http by default", async () => {
    stdout = JSON.stringify({ Status: 4, DisplayName: "DHCP Server" });
    await testConnection(cfg());
    expect(calls.map((c) => c.action)).toEqual(["Create", "Command", "Receive", "Delete"]);
    expect(calls[0].url).toBe("http://dhcp01.corp.example:5985/wsman");
    expect(calls[3].body).toContain("SHELL-1");
  });

  it("uses https on :5986 with useSsl, and an explicit port when given", async () => {
    stdout = "{}";
    await testConnection(cfg({ useSsl: true }));
    expect(calls[0].url).toBe("https://dhcp01.corp.example:5986/wsman");
    calls = [];
    await testConnection(cfg({ port: 15985 }));
    expect(calls[0].url).toBe("http://dhcp01.corp.example:15985/wsman");
  });

  it("authenticates as DOMAIN\\user when a domain is configured", async () => {
    stdout = "{}";
    await testConnection(cfg({ domain: "CORP" }));
    const decoded = Buffer.from(calls[0].auth.replace(/^Basic /, ""), "base64").toString("utf8");
    expect(decoded).toBe("CORP\\svc:pw");
  });

  it("sends the PowerShell as -EncodedCommand (UTF-16LE base64)", async () => {
    stdout = "[]";
    await discoverDhcpScopes(cfg());
    const m = /-EncodedCommand ([A-Za-z0-9+/=]+)/.exec(calls[1].body)!;
    expect(Buffer.from(m[1], "base64").toString("utf16le")).toContain("Get-DhcpServerv4Scope");
  });

  // BUG (not fixed — tests-only change, see CQ-T010 in the ledger): winrmExec
  // arms its 15 s timeout and the caller-signal abort listener BEFORE
  // winrmCreateShell, but clears them only in the finally that wraps the
  // later steps. A failed shell create (401, refused, bad response) leaves
  // the timer pending and the listener attached to the discovery signal.
  // Flip to `it` once the create step sits inside the try.
  it.fails("leaves no pending timer behind when the shell create fails", async () => {
    vi.useFakeTimers();
    try {
      failAction = "Create";
      failStatus = 401;
      await testConnection(cfg());
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("still deletes the shell when the command step fails", async () => {
    failAction = "Command";
    await expect(discoverDhcpScopes(cfg())).rejects.toMatchObject({ httpStatus: 502 });
    expect(calls.map((c) => c.action)).toEqual(["Create", "Command", "Delete"]);
  });
});

// ─── Connection test verdicts ────────────────────────────────────────────────

describe("testConnection", () => {
  it("is ok when the DHCPServer service is Running (numeric 4 or the string)", async () => {
    stdout = JSON.stringify({ Status: 4 });
    await expect(testConnection(cfg())).resolves.toMatchObject({ ok: true });
    stdout = JSON.stringify({ status: "Running" });
    await expect(testConnection(cfg())).resolves.toMatchObject({ ok: true });
  });

  it("names a stopped service", async () => {
    stdout = JSON.stringify({ Status: 1, DisplayName: "DHCP Server" });
    await expect(testConnection(cfg())).resolves.toEqual({ ok: false, message: "DHCP Server service status: DHCP Server is Stopped" });
  });

  it("reports empty output as no response", async () => {
    stdout = "";
    await expect(testConnection(cfg())).resolves.toMatchObject({ ok: false, message: expect.stringContaining("No response") });
  });

  it("turns a 401 into an authentication message", async () => {
    failAction = "Create";
    failStatus = 401;
    await expect(testConnection(cfg())).resolves.toMatchObject({ ok: false, message: expect.stringContaining("Authentication failed") });
  });

  it("names refused, unknown-host and timed-out connections", async () => {
    fetchError = Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
    await expect(testConnection(cfg())).resolves.toMatchObject({ message: "Connection refused — dhcp01.corp.example:5985" });
    fetchError = Object.assign(new TypeError("fetch failed"), { cause: { code: "ENOTFOUND" } });
    await expect(testConnection(cfg())).resolves.toMatchObject({ message: "Host not found — dhcp01.corp.example" });
    fetchError = Object.assign(new Error("aborted"), { name: "TimeoutError" });
    await expect(testConnection(cfg())).resolves.toMatchObject({ message: expect.stringContaining("timed out") });
  });
});

// ─── Scope discovery ─────────────────────────────────────────────────────────

describe("discoverDhcpScopes", () => {
  it("turns ScopeId + SubnetMask into a CIDR, accepts a single-object response, and tags the server", async () => {
    stdout = JSON.stringify({ ScopeId: "10.20.0.0", SubnetMask: "255.255.252.0", Name: "HQ" });
    await expect(discoverDhcpScopes(cfg())).resolves.toEqual([
      { cidr: "10.20.0.0/22", name: "HQ", fortigateDevice: "dhcp01.corp.example", dhcpServerId: "10.20.0.0" },
    ]);
  });

  it("names an unnamed scope after its id and skips rows with no id, no mask or an invalid mask", async () => {
    stdout = JSON.stringify([
      { ScopeId: "10.1.0.0", SubnetMask: "255.255.255.0", Name: "" },
      { ScopeId: "10.2.0.0" },
      { SubnetMask: "255.255.255.0" },
      { ScopeId: "10.3.0.0", SubnetMask: "not-a-mask" },
    ]);
    const r = await discoverDhcpScopes(cfg());
    expect(r.map((s) => [s.cidr, s.name])).toEqual([["10.1.0.0/24", "Scope 10.1.0.0"]]);
  });

  it("returns nothing for an empty response", async () => {
    stdout = "";
    await expect(discoverDhcpScopes(cfg())).resolves.toEqual([]);
  });

  it("applies include then exclude, matching name or scope id case-insensitively", async () => {
    stdout = JSON.stringify([
      { ScopeId: "10.1.0.0", SubnetMask: "255.255.255.0", Name: "Branch Voice" },
      { ScopeId: "10.2.0.0", SubnetMask: "255.255.255.0", Name: "Branch Data" },
      { ScopeId: "10.9.0.0", SubnetMask: "255.255.255.0", Name: "Lab" },
    ]);
    const inc = await discoverDhcpScopes(cfg({ dhcpInclude: ["branch", "10.9."] }));
    expect(inc.map((s) => s.name)).toEqual(["Branch Voice", "Branch Data", "Lab"]);
    const both = await discoverDhcpScopes(cfg({ dhcpInclude: ["BRANCH"], dhcpExclude: ["voice"] }));
    expect(both.map((s) => s.name)).toEqual(["Branch Data"]);
  });

  it("aborts when the caller's signal fires", async () => {
    const ac = new AbortController();
    vi.stubGlobal("fetch", vi.fn((url: string, init: { signal: AbortSignal; headers: Record<string, string>; body: string }) => {
      if (actionOf(init.body) === "Command") {
        ac.abort();
        expect(init.signal.aborted).toBe(true);
        return Promise.reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
      }
      return fakeFetch(url, init);
    }));
    await expect(discoverDhcpScopes(cfg(), ac.signal)).rejects.toThrow("aborted");
  });
});
