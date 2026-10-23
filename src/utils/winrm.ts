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
import { urlHost } from "./cidr.js";
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
  const shellId = xmlElement(xml, "ShellId")?.content.trim();
  if (!shellId) throw new Error("CreateShell response missing ShellId");
  return shellId;
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
  const commandId = xmlElement(xml, "CommandId")?.content.trim();
  if (!commandId) throw new Error("RunCommand response missing CommandId");
  return commandId;
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
    const chunk = parseReceive(xml);
    stdout += chunk.stdout;
    stderr += chunk.stderr;
    if (chunk.done) return { exitCode: chunk.exitCode, stdout, stderr };
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

// ─── Response parsing (re-scan F84) ───────────────────────────────────
//
// The response body is the remote host's. It used to be matched with
// backtracking regexes — the fault pattern nested two lazy `[\s\S]*?` scans
// and the Stream pattern ran three adjacent `[^>]*`, so a body of many
// `<Text` openers with no `</Text>` cost O(openers × length) on the event
// loop that also runs every collector. These scans are indexOf-based and
// linear: each element search moves forward only, and a missing close tag
// ends the search instead of retrying from the next opener. Bodies are also
// capped (MAX_WINRM_BODY_BYTES).

export const MAX_WINRM_BODY_BYTES = 4 * 1024 * 1024;

const isXmlNameChar = (c: string) =>
  (c >= "a" && c <= "z") || (c >= "A" && c <= "Z") || (c >= "0" && c <= "9") || c === "_" || c === ":" || c === "-" || c === ".";

const localName = (name: string) => name.slice(name.lastIndexOf(":") + 1);

export interface XmlElement { attrs: string; content: string; end: number }

/** The next element named `local` (any namespace prefix) at or after `from`, or null. */
export function xmlElement(xml: string, local: string, from = 0): XmlElement | null {
  let i = from;
  for (;;) {
    const lt = xml.indexOf("<", i);
    if (lt < 0) return null;
    let j = lt + 1;
    while (j < xml.length && isXmlNameChar(xml[j])) j++;
    if (j === lt + 1 || localName(xml.slice(lt + 1, j)) !== local) { i = lt + 1; continue; }
    const gt = xml.indexOf(">", j);
    if (gt < 0) return null;
    const attrs = xml.slice(j, gt);
    if (attrs.endsWith("/")) return { attrs: attrs.slice(0, -1), content: "", end: gt + 1 };
    let k = gt + 1;
    for (;;) {
      const close = xml.indexOf("</", k);
      if (close < 0) return null;
      let e = close + 2;
      while (e < xml.length && isXmlNameChar(xml[e])) e++;
      if (localName(xml.slice(close + 2, e)) === local) {
        const cgt = xml.indexOf(">", e);
        if (cgt < 0) return null;
        return { attrs, content: xml.slice(gt + 1, close), end: cgt + 1 };
      }
      k = close + 2;
    }
  }
}

/** The value of attribute `name` in an element's attribute text, or null. */
export function xmlAttr(attrs: string, name: string): string | null {
  const needle = `${name}="`;
  let i = 0;
  for (;;) {
    const at = attrs.indexOf(needle, i);
    if (at < 0) return null;
    const before = at === 0 ? " " : attrs[at - 1];
    if (before === " " || before === "\t" || before === "\n" || before === "\r") {
      const start = at + needle.length;
      const end = attrs.indexOf('"', start);
      return end < 0 ? null : attrs.slice(start, end);
    }
    i = at + 1;
  }
}

/** One Receive response: its decoded stdout / stderr, and whether the command is Done. */
export function parseReceive(xml: string): { stdout: string; stderr: string; done: boolean; exitCode: number | null } {
  let stdout = "";
  let stderr = "";
  // <rsp:Stream Name="stdout|stderr">base64</rsp:Stream>
  for (let el = xmlElement(xml, "Stream"); el; el = xmlElement(xml, "Stream", el.end)) {
    const name = xmlAttr(el.attrs, "Name");
    if (name !== "stdout" && name !== "stderr") continue;
    const decoded = Buffer.from(el.content.trim(), "base64").toString("utf8");
    if (name === "stdout") stdout += decoded;
    else                   stderr += decoded;
  }
  // The exit signal: CommandState State="…Done" carrying an ExitCode.
  for (let el = xmlElement(xml, "CommandState"); el; el = xmlElement(xml, "CommandState", el.end)) {
    if (!(xmlAttr(el.attrs, "State") ?? "").endsWith("Done")) continue;
    const ec = xmlElement(el.content, "ExitCode")?.content.trim() ?? "";
    const exitCode = /^-?\d{1,10}$/.test(ec) ? parseInt(ec, 10) : null;
    return { stdout, stderr, done: true, exitCode };
  }
  return { stdout, stderr, done: false, exitCode: null };
}

/** The text of a WS-Management fault (`<Reason><Text>…</Text></Reason>`), or null. */
export function faultReason(body: string): string | null {
  const reason = xmlElement(body, "Reason");
  if (!reason) return null;
  return xmlElement(reason.content, "Text")?.content ?? null;
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
  const to = `${useHttps ? "https" : "http"}://${urlHost(conn.host)}:${port}/wsman`; // IPv6 bracketed (rule 128)
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
      const chunks: Buffer[] = [];
      let bytes = 0;
      let tooBig = false;
      res.on("data", (chunk: Buffer) => {
        if (tooBig) return;
        bytes += chunk.length;
        if (bytes > MAX_WINRM_BODY_BYTES) {
          tooBig = true;
          try { req.destroy(); } catch { /* ignore */ }
          reject(new Error(`WinRM response exceeded ${MAX_WINRM_BODY_BYTES} bytes; refused`));
          return;
        }
        chunks.push(chunk);
      });
      res.on("end", () => {
        if (tooBig) return;
        const body = Buffer.concat(chunks).toString("utf8");
        if (res.statusCode === 200) return resolve(body);
        if (res.statusCode === 401) return reject(new Error("WinRM authentication failed"));
        // 500 is the default on WS-Management faults; surface the fault
        // body so the operator can see e.g. "ShellId not found" or
        // "Access is denied" instead of an opaque 500.
        const reason = faultReason(body);
        reject(new Error(`WinRM HTTP ${res.statusCode}${reason ? ": " + reason.trim().slice(0, 200) : ""}`));
      });
    });
    req.on("timeout", () => { try { req.destroy(); } catch { /* ignore */ } reject(new Error("WinRM request timed out")); });
    req.on("error", (err) => reject(err));
    req.write(envelope);
    req.end();
  });
}
