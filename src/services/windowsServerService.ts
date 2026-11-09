/**
 * src/services/windowsServerService.ts — Windows Server DHCP via WinRM
 *
 * Connects to Windows Server using WinRM (PowerShell remoting) to query
 * DHCP scopes and discover subnets.
 */

import { Netmask } from "netmask";
import { AppError } from "../utils/errors.js";

export interface WindowsServerConfig {
  host: string;
  port?: number;             // Default 5985 (HTTP) or 5986 (HTTPS)
  username: string;
  password: string;
  useSsl?: boolean;          // Default false
  domain?: string;           // Optional AD domain for auth
  dhcpInclude?: string[];
  dhcpExclude?: string[];
}

export interface DiscoveredDhcpScope {
  cidr: string;
  name: string;
  fortigateDevice: string;   // Reusing field — holds the DHCP server hostname
  dhcpServerId: string;      // The ScopeId
}

/**
 * Test connectivity to a Windows Server via WinRM.
 * Runs Get-Service DHCPServer to verify the DHCP role is installed.
 */
export async function testConnection(config: WindowsServerConfig): Promise<{
  ok: boolean;
  message: string;
}> {
  const port = config.port || (config.useSsl ? 5986 : 5985);
  const scheme = config.useSsl ? "https" : "http";
  const url = `${scheme}://${config.host}:${port}/wsman`;

  try {
    const result = await winrmExec(
      url,
      config.username,
      config.password,
      config.domain,
      'Get-Service DHCPServer | Select-Object Status, DisplayName | ConvertTo-Json',
      config.useSsl,
    );

    if (!result) {
      return { ok: false, message: "No response from WinRM — check credentials and service" };
    }

    const parsed = JSON.parse(result);
    const status = parsed.Status ?? parsed.status;
    if (status === 4 || status === "Running") {
      return { ok: true, message: `Connected — DHCP Server is running on ${config.host}` };
    }
    return { ok: false, message: `DHCP Server service status: ${parsed.DisplayName || "DHCPServer"} is ${status === 1 ? "Stopped" : "not running"}` };
  } catch (err: any) {
    if (err.cause?.code === "ECONNREFUSED") {
      return { ok: false, message: `Connection refused — ${config.host}:${port}` };
    }
    if (err.cause?.code === "ENOTFOUND") {
      return { ok: false, message: `Host not found — ${config.host}` };
    }
    if (err.cause?.code === "ETIMEDOUT" || err.name === "TimeoutError") {
      return { ok: false, message: `Connection timed out — ${config.host}:${port}` };
    }
    if (err.message?.includes("401")) {
      return { ok: false, message: "Authentication failed — check username, password, and domain" };
    }
    return { ok: false, message: err.message || "Unknown error" };
  }
}

/**
 * Query Windows DHCP Server for all IPv4 scopes via WinRM.
 * Returns discovered subnets filtered by include/exclude lists.
 */
export async function discoverDhcpScopes(
  config: WindowsServerConfig,
  signal?: AbortSignal,
): Promise<DiscoveredDhcpScope[]> {
  const port = config.port || (config.useSsl ? 5986 : 5985);
  const scheme = config.useSsl ? "https" : "http";
  const url = `${scheme}://${config.host}:${port}/wsman`;

  const result = await winrmExec(
    url,
    config.username,
    config.password,
    config.domain,
    'Get-DhcpServerv4Scope | Select-Object ScopeId, SubnetMask, Name, State, Description | ConvertTo-Json',
    config.useSsl,
    signal,
  );

  if (!result) return [];

  let scopes = JSON.parse(result);
  if (!Array.isArray(scopes)) scopes = [scopes];

  const discovered: DiscoveredDhcpScope[] = [];

  for (const scope of scopes) {
    const scopeId = scope.ScopeId || scope.scopeId;
    const subnetMask = scope.SubnetMask || scope.subnetMask;
    const name = scope.Name || scope.name || "";

    if (!scopeId || !subnetMask) continue;

    try {
      const block = new Netmask(`${scopeId}/${subnetMask}`);
      const cidr = `${block.base}/${block.bitmask}`;

      discovered.push({
        cidr,
        name: name || `Scope ${scopeId}`,
        fortigateDevice: config.host,
        dhcpServerId: scopeId,
      });
    } catch {
      // Skip scopes with invalid IP/mask
    }
  }

  return filterDhcpResults(discovered, config.dhcpInclude, config.dhcpExclude);
}

function filterDhcpResults(
  scopes: DiscoveredDhcpScope[],
  include?: string[],
  exclude?: string[],
): DiscoveredDhcpScope[] {
  let result = scopes;

  if (include && include.length > 0) {
    result = result.filter((s) =>
      include.some((p) =>
        s.name.toLowerCase().includes(p.toLowerCase()) ||
        s.dhcpServerId.toLowerCase().includes(p.toLowerCase())
      )
    );
  }

  if (exclude && exclude.length > 0) {
    result = result.filter((s) =>
      !exclude.some((p) =>
        s.name.toLowerCase().includes(p.toLowerCase()) ||
        s.dhcpServerId.toLowerCase().includes(p.toLowerCase())
      )
    );
  }

  return result;
}

// ─── WinRM Execution ────────────────────────────────────────────────────────

/**
 * Execute a PowerShell command on a remote Windows Server via WinRM.
 * Uses Basic auth over HTTP/HTTPS with the WS-Management SOAP protocol.
 */
async function winrmExec(
  url: string,
  username: string,
  password: string,
  domain: string | undefined,
  command: string,
  useSsl?: boolean,
  externalSignal?: AbortSignal,
): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  const onExternalAbort = () => controller.abort();
  externalSignal?.addEventListener("abort", onExternalAbort, { once: true });

  const authUser = domain ? `${domain}\\${username}` : username;
  const authHeader = "Basic " + Buffer.from(`${authUser}:${password}`).toString("base64");

  // WinRM SOAP envelope to create shell, run command, receive output, delete shell.
  // The timer and the abort listener are released whatever fails — including
  // the shell create itself (a 401, a refused connection), which used to sit
  // OUTSIDE the try and leave both behind on every failed connection test.
  let shellId: string | null = null;
  try {
    shellId = await winrmCreateShell(url, authHeader, controller.signal);
    const commandId = await winrmRunCommand(url, authHeader, shellId, command, controller.signal);
    const output = await winrmReceive(url, authHeader, shellId, commandId, controller.signal);
    return output;
  } finally {
    clearTimeout(timeout);
    externalSignal?.removeEventListener("abort", onExternalAbort);
    if (shellId !== null) await winrmDeleteShell(url, authHeader, shellId).catch(() => {});
  }
}

async function winrmSoap(
  url: string,
  authHeader: string,
  body: string,
  signal: AbortSignal,
): Promise<string> {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/soap+xml;charset=UTF-8",
      "Authorization": authHeader,
    },
    body,
    signal,
  });

  if (res.status === 401) {
    throw new AppError(502, "WinRM authentication failed (401)");
  }
  if (!res.ok) {
    throw new AppError(502, `WinRM returned HTTP ${res.status}`);
  }

  return await res.text();
}

const WINRM_NS = 'xmlns:s="http://www.w3.org/2003/05/soap-envelope" xmlns:wsa="http://schemas.xmlsoap.org/ws/2004/08/addressing" xmlns:wsman="http://schemas.dmtf.org/wbem/wsman/1/wsman.xsd"';
const WINRM_RESOURCE = "http://schemas.microsoft.com/wbem/wsman/1/windows/shell/cmd";
const WINRM_SHELL_NS = 'xmlns:rsp="http://schemas.microsoft.com/wbem/wsman/1/windows/shell"';

async function winrmCreateShell(url: string, auth: string, signal: AbortSignal): Promise<string> {
  const envelope = `<s:Envelope ${WINRM_NS} ${WINRM_SHELL_NS}>
    <s:Header>
      <wsa:To>${url}</wsa:To>
      <wsman:ResourceURI s:mustUnderstand="true">${WINRM_RESOURCE}</wsman:ResourceURI>
      <wsa:Action s:mustUnderstand="true">http://schemas.xmlsoap.org/ws/2004/09/transfer/Create</wsa:Action>
      <wsman:OptionSet><wsman:Option Name="WINRS_NOPROFILE">TRUE</wsman:Option></wsman:OptionSet>
    </s:Header>
    <s:Body>
      <rsp:Shell><rsp:InputStreams>stdin</rsp:InputStreams><rsp:OutputStreams>stdout stderr</rsp:OutputStreams></rsp:Shell>
    </s:Body>
  </s:Envelope>`;

  const text = await winrmSoap(url, auth, envelope, signal);
  const match = text.match(/<wsman:Selector Name="ShellId">([^<]+)<\/wsman:Selector>/);
  if (!match) throw new AppError(502, "Failed to create WinRM shell");
  return match[1];
}

async function winrmRunCommand(url: string, auth: string, shellId: string, command: string, signal: AbortSignal): Promise<string> {
  const psEncoded = Buffer.from(command, "utf16le").toString("base64");
  const envelope = `<s:Envelope ${WINRM_NS} ${WINRM_SHELL_NS}>
    <s:Header>
      <wsa:To>${url}</wsa:To>
      <wsman:ResourceURI s:mustUnderstand="true">${WINRM_RESOURCE}</wsman:ResourceURI>
      <wsa:Action s:mustUnderstand="true">http://schemas.microsoft.com/wbem/wsman/1/windows/shell/Command</wsa:Action>
      <wsman:SelectorSet><wsman:Selector Name="ShellId">${shellId}</wsman:Selector></wsman:SelectorSet>
    </s:Header>
    <s:Body>
      <rsp:CommandLine><rsp:Command>powershell</rsp:Command><rsp:Arguments>-EncodedCommand ${psEncoded}</rsp:Arguments></rsp:CommandLine>
    </s:Body>
  </s:Envelope>`;

  const text = await winrmSoap(url, auth, envelope, signal);
  const match = text.match(/<rsp:CommandId>([^<]+)<\/rsp:CommandId>/);
  if (!match) throw new AppError(502, "Failed to run WinRM command");
  return match[1];
}

async function winrmReceive(url: string, auth: string, shellId: string, commandId: string, signal: AbortSignal): Promise<string> {
  const envelope = `<s:Envelope ${WINRM_NS} ${WINRM_SHELL_NS}>
    <s:Header>
      <wsa:To>${url}</wsa:To>
      <wsman:ResourceURI s:mustUnderstand="true">${WINRM_RESOURCE}</wsman:ResourceURI>
      <wsa:Action s:mustUnderstand="true">http://schemas.microsoft.com/wbem/wsman/1/windows/shell/Receive</wsa:Action>
      <wsman:SelectorSet><wsman:Selector Name="ShellId">${shellId}</wsman:Selector></wsman:SelectorSet>
    </s:Header>
    <s:Body>
      <rsp:Receive><rsp:DesiredStream CommandId="${commandId}">stdout stderr</rsp:DesiredStream></rsp:Receive>
    </s:Body>
  </s:Envelope>`;

  const text = await winrmSoap(url, auth, envelope, signal);
  // Extract stdout stream content (base64-encoded)
  const chunks: string[] = [];
  const regex = /<rsp:Stream Name="stdout"[^>]*>([^<]*)<\/rsp:Stream>/g;
  let m;
  while ((m = regex.exec(text)) !== null) {
    if (m[1]) chunks.push(Buffer.from(m[1], "base64").toString("utf8"));
  }
  return chunks.join("");
}

async function winrmDeleteShell(url: string, auth: string, shellId: string): Promise<void> {
  const envelope = `<s:Envelope ${WINRM_NS}>
    <s:Header>
      <wsa:To>${url}</wsa:To>
      <wsman:ResourceURI s:mustUnderstand="true">${WINRM_RESOURCE}</wsman:ResourceURI>
      <wsa:Action s:mustUnderstand="true">http://schemas.xmlsoap.org/ws/2004/09/transfer/Delete</wsa:Action>
      <wsman:SelectorSet><wsman:Selector Name="ShellId">${shellId}</wsman:Selector></wsman:SelectorSet>
    </s:Header>
    <s:Body/>
  </s:Envelope>`;

  await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/soap+xml;charset=UTF-8",
      "Authorization": auth,
    },
    body: envelope,
  }).catch(() => {});
}
