/**
 * src/utils/winrm.ts — Minimal WS-Management / WinRS client for running
 * remote PowerShell commands on Windows hosts.
 *
 * Used by `agentInstallService` to install / uninstall the Polaris
 * Agent on Windows hosts. The existing `probeWinRm` helper in
 * monitoringService.ts only does a SOAP `Identify` round-trip (auth
 * check); this file adds the four WinRS shell verbs the install path
 * needs:
 *
 *   1. CreateShell  — open a WinRS shell, returns a ShellId GUID
 *   2. RunCommand   — invoke a command inside that shell, returns a CommandId
 *   3. Receive      — poll for stdout/stderr/exit; loop until exit
 *   4. DeleteShell  — clean up
 *
 * We deliberately do NOT implement the WS-Management `Send` verb (the
 * one needed to stream stdin / file uploads). The Windows install path
 * uses HTTPS pull instead: the PowerShell installer running on the host
 * fetches the agent binary via Invoke-WebRequest from Polaris's public
 * `/api/v1/agents/binary/:filename` endpoint with a cert-pin validation
 * callback. That avoids the chunked-Send dance entirely and keeps this
 * file small.
 *
 * WS-Management protocol references:
 *   - MS-WSMV: https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-wsmv/
 *   - WinRS shell semantics: WinRS shells live on the host until DeleteShell
 *     OR the shell idle timeout (default ~3 min). Always call DeleteShell
 *     in a `finally` so a thrown error doesn't leak a shell.
 */

import { request as httpsRequest, RequestOptions as HttpsRequestOptions } from "node:https";
import { request as httpRequest } from "node:http";
import { randomUUID } from "node:crypto";
import { sleep } from "./sleep.js";
import { pinnedAgentFor } from "./pinnedTlsAgent.js";

export interface WinRmConnection {
  host:     string;
  port?:    number;        // default 5986 https / 5985 http
  useHttps?: boolean;      // default true
  username: string;
  password: string;
  /**
   * Verify the server's TLS certificate on HTTPS connections. Defaults to OFF
   * when omitted to preserve behavior for callers (and stored credentials) that
   * predate this flag — see the 2026-06-03 security review (H1). Set true to
   * reject untrusted certs; WinRM Basic-auth sends credentials on the wire, so
   * an unverified session is MITM-exposed.
   */
  verifyTls?: boolean;
  /** Per-request timeout in ms; default 60_000 */
  timeoutMs?: number;
}

export interface CommandResult {
  exitCode: number | null;
  stdout:   string;
  stderr:   string;
}

/**
 * Open a shell, run one command, collect output, close shell. Convenience
 * wrapper around the four shell verbs.
 */
export async function winrmRunOne(
  conn: WinRmConnection,
  commandLine: string,
  arguments_: string[] = [],
): Promise<CommandResult> {
  const shellId = await createShell(conn);
  try {
    const commandId = await runCommand(conn, shellId, commandLine, arguments_);
    return await receiveAll(conn, shellId, commandId);
  } finally {
    // Always tear the shell down — leaks cost resources on the host and
    // can lead to MaxShellsPerUser exhaustion (default 30) over time.
    await deleteShell(conn, shellId).catch(() => { /* best-effort */ });
  }
}

// ─── Per-verb implementations ─────────────────────────────────────────

const NS = {
  s:   "http://www.w3.org/2003/05/soap-envelope",
  a:   "http://schemas.xmlsoap.org/ws/2004/08/addressing",
  w:   "http://schemas.dmtf.org/wbem/wsman/1/wsman.xsd",
  rsp: "http://schemas.microsoft.com/wbem/wsman/1/windows/shell",
};

const SHELL_RESOURCE_URI = "http://schemas.microsoft.com/wbem/wsman/1/windows/shell/cmd";

async function createShell(conn: WinRmConnection): Promise<string> {
  const messageId = "uuid:" + randomUUID();
  const env =
    `<s:Envelope xmlns:s="${NS.s}" xmlns:a="${NS.a}" xmlns:w="${NS.w}" xmlns:rsp="${NS.rsp}">` +
      `<s:Header>` +
        addressingHeaders(conn, messageId, "http://schemas.xmlsoap.org/ws/2004/09/transfer/Create") +
        `<w:ResourceURI s:mustUnderstand="true">${SHELL_RESOURCE_URI}</w:ResourceURI>` +
        `<w:OptionSet>` +
          // Don't load the user's PowerShell profile — install scripts
          // must not depend on the operator's $PROFILE state.
          `<w:Option Name="WINRS_NOPROFILE">TRUE</w:Option>` +
          `<w:Option Name="WINRS_CODEPAGE">65001</w:Option>` + // UTF-8
        `</w:OptionSet>` +
      `</s:Header>` +
      `<s:Body>` +
        `<rsp:Shell>` +
          `<rsp:InputStreams>stdin</rsp:InputStreams>` +
          `<rsp:OutputStreams>stdout stderr</rsp:OutputStreams>` +
        `</rsp:Shell>` +
      `</s:Body>` +
    `</s:Envelope>`;
  const xml = await soapPost(conn, env);
  // Pull ShellId out of the response. The response wraps a Shell element
  // whose ShellId is the new shell's GUID — alternately, the addressing
  // header carries the same GUID via wsa:RelatesTo on subsequent calls.
  const m = xml.match(/<(?:\w+:)?ShellId[^>]*>([^<]+)<\/(?:\w+:)?ShellId>/);
  if (!m) throw new Error("CreateShell response missing ShellId");
  return m[1];
}

async function runCommand(
  conn: WinRmConnection,
  shellId: string,
  commandLine: string,
  args: string[],
): Promise<string> {
  const messageId = "uuid:" + randomUUID();
  const escapedCmd = xmlEscape(commandLine);
  const argsXml = args.map((a) => `<rsp:Arguments>${xmlEscape(a)}</rsp:Arguments>`).join("");
  const env =
    `<s:Envelope xmlns:s="${NS.s}" xmlns:a="${NS.a}" xmlns:w="${NS.w}" xmlns:rsp="${NS.rsp}">` +
      `<s:Header>` +
        addressingHeaders(conn, messageId, `${NS.rsp}/Command`, shellId) +
        `<w:OptionSet>` +
          `<w:Option Name="WINRS_CONSOLEMODE_STDIN">TRUE</w:Option>` +
          `<w:Option Name="WINRS_SKIP_CMD_SHELL">FALSE</w:Option>` +
        `</w:OptionSet>` +
      `</s:Header>` +
      `<s:Body>` +
        `<rsp:CommandLine>` +
          `<rsp:Command>${escapedCmd}</rsp:Command>` +
          argsXml +
        `</rsp:CommandLine>` +
      `</s:Body>` +
    `</s:Envelope>`;
  const xml = await soapPost(conn, env);
  const m = xml.match(/<(?:\w+:)?CommandId[^>]*>([^<]+)<\/(?:\w+:)?CommandId>/);
  if (!m) throw new Error("RunCommand response missing CommandId");
  return m[1];
}

async function receiveAll(
  conn: WinRmConnection,
  shellId: string,
  commandId: string,
): Promise<CommandResult> {
  let stdout = "";
  let stderr = "";
  // Receive is polled — each call returns whatever the host has buffered
  // since the last one. We loop until the response signals CommandState
  // = "Done" (which carries the exit code).
  for (;;) {
    const messageId = "uuid:" + randomUUID();
    const env =
      `<s:Envelope xmlns:s="${NS.s}" xmlns:a="${NS.a}" xmlns:w="${NS.w}" xmlns:rsp="${NS.rsp}">` +
        `<s:Header>` +
          addressingHeaders(conn, messageId, `${NS.rsp}/Receive`, shellId) +
        `</s:Header>` +
        `<s:Body>` +
          `<rsp:Receive>` +
            `<rsp:DesiredStream CommandId="${commandId}">stdout stderr</rsp:DesiredStream>` +
          `</rsp:Receive>` +
        `</s:Body>` +
      `</s:Envelope>`;
    const xml = await soapPost(conn, env);

    // Pull every <rsp:Stream Name="stdout|stderr">...</rsp:Stream> chunk
    // — content is base64 of the raw bytes the host wrote.
    const streamRe = /<(?:\w+:)?Stream\b[^>]*Name="(stdout|stderr)"[^>]*(?:CommandId="[^"]*")?[^>]*>([^<]*)<\/(?:\w+:)?Stream>/g;
    let m: RegExpExecArray | null;
    while ((m = streamRe.exec(xml))) {
      const decoded = Buffer.from(m[2], "base64").toString("utf8");
      if (m[1] === "stdout") stdout += decoded;
      else                    stderr += decoded;
    }

    // Look for the exit signal. CommandState="...Done" + ExitCode element.
    const doneMatch = xml.match(/<(?:\w+:)?CommandState[^>]*State="[^"]*Done"[\s\S]*?<\/(?:\w+:)?CommandState>/);
    if (doneMatch) {
      const ec = doneMatch[0].match(/<(?:\w+:)?ExitCode>(-?\d+)<\/(?:\w+:)?ExitCode>/);
      const exitCode = ec ? parseInt(ec[1], 10) : null;
      return { exitCode, stdout, stderr };
    }
    // Not done — keep polling. Brief delay so we don't tight-loop on a
    // command that prints nothing for seconds at a time.
    await sleep(250);
  }
}

async function deleteShell(conn: WinRmConnection, shellId: string): Promise<void> {
  const messageId = "uuid:" + randomUUID();
  const env =
    `<s:Envelope xmlns:s="${NS.s}" xmlns:a="${NS.a}" xmlns:w="${NS.w}" xmlns:rsp="${NS.rsp}">` +
      `<s:Header>` +
        addressingHeaders(conn, messageId, "http://schemas.xmlsoap.org/ws/2004/09/transfer/Delete", shellId) +
      `</s:Header>` +
      `<s:Body/>` +
    `</s:Envelope>`;
  await soapPost(conn, env);
}

// ─── Helpers ──────────────────────────────────────────────────────────

function addressingHeaders(
  conn: WinRmConnection,
  messageId: string,
  action: string,
  shellId?: string,
): string {
  const useHttps = conn.useHttps !== false;
  const port = conn.port ?? (useHttps ? 5986 : 5985);
  const to = `${useHttps ? "https" : "http"}://${conn.host}:${port}/wsman`;
  let h =
    `<a:To>${to}</a:To>` +
    `<w:ResourceURI s:mustUnderstand="true">${SHELL_RESOURCE_URI}</w:ResourceURI>` +
    `<a:ReplyTo><a:Address s:mustUnderstand="true">http://schemas.xmlsoap.org/ws/2004/08/addressing/role/anonymous</a:Address></a:ReplyTo>` +
    `<a:Action s:mustUnderstand="true">${action}</a:Action>` +
    `<w:MaxEnvelopeSize s:mustUnderstand="true">512000</w:MaxEnvelopeSize>` +
    `<a:MessageID>${messageId}</a:MessageID>` +
    `<w:Locale xml:lang="en-US" s:mustUnderstand="false"/>` +
    `<w:OperationTimeout>PT60.000S</w:OperationTimeout>`;
  if (shellId) {
    h += `<w:SelectorSet><w:Selector Name="ShellId">${shellId}</w:Selector></w:SelectorSet>`;
  }
  return h;
}

// Exported: the vCenter SOAP transport shares this escaper (it carried a
// byte-identical private copy until the 2026-08 audit).
export function xmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}


function soapPost(conn: WinRmConnection, envelope: string): Promise<string> {
  const useHttps = conn.useHttps !== false;
  const port = conn.port ?? (useHttps ? 5986 : 5985);
  const auth = "Basic " + Buffer.from(`${conn.username}:${conn.password}`).toString("base64");
  const reqFn = useHttps ? httpsRequest : httpRequest;
  const opts: HttpsRequestOptions = {
    hostname: conn.host,
    port,
    path: "/wsman",
    method: "POST",
    headers: {
      Authorization:  auth,
      "Content-Type": "application/soap+xml;charset=UTF-8",
      "Content-Length": Buffer.byteLength(envelope).toString(),
    },
    // verifyTls: true verifies the CA chain. Otherwise (the norm: WinRM
    // listeners present self-signed certificates) the certificate is pinned on
    // first use and checked before the Basic-auth header is written (business
    // rule 113) — never sent to an unchecked server.
    rejectUnauthorized: conn.verifyTls === true,
    ...(useHttps && conn.verifyTls !== true ? { agent: pinnedAgentFor(conn.host, port) } : {}),
    timeout: conn.timeoutMs ?? 60_000,
  };
  return new Promise<string>((resolve, reject) => {
    const req = reqFn(opts, (res) => {
      let body = "";
      res.on("data", (chunk) => { body += chunk.toString("utf8"); });
      res.on("end", () => {
        if (res.statusCode === 200) return resolve(body);
        if (res.statusCode === 401) return reject(new Error("WinRM authentication failed"));
        // 500 is the default on WS-Management faults; surface the fault
        // body so the operator can see e.g. "ShellId not found" or
        // "Access is denied" instead of an opaque 500.
        const reason = (body.match(/<(?:\w+:)?Reason>[\s\S]*?<(?:\w+:)?Text[^>]*>([\s\S]*?)<\/(?:\w+:)?Text>/) || [])[1];
        reject(new Error(`WinRM HTTP ${res.statusCode}${reason ? ": " + reason.trim().slice(0, 200) : ""}`));
      });
    });
    req.on("timeout", () => { try { req.destroy(); } catch { /* ignore */ } reject(new Error("WinRM request timed out")); });
    req.on("error", (err) => reject(err));
    req.write(envelope);
    req.end();
  });
}
