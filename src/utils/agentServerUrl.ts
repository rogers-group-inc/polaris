/**
 * src/utils/agentServerUrl.ts — the one definition of an acceptable agent
 * server URL.
 *
 * The URL an agent is told to call back to is written into agent.conf and
 * pasted, as text, into the PowerShell installer and upgrader that Polaris runs
 * on Windows hosts over WinRM or SSH. `new URL()` accepts a quote, a space and
 * a backtick in a path, so the old check (`^https?://` plus "parses") let a
 * value such as `https://example.com/';Start-Process calc;'` close the script's
 * string literal and run the rest as PowerShell (scan finding F163).
 *
 * So the URL is rebuilt from parts that each match an allowlist: scheme, host
 * (a DNS name, IPv4 address or bracketed IPv6 literal), optional port, and an
 * optional path of unreserved characters. No userinfo, query or fragment: an
 * agent has no use for them and each is a place for something else to hide.
 *
 * No I/O, so the settings route, the resolver and the script builders can
 * all ask the same question. Business rule 107.
 */

import { trimTrailing } from "./trimTrailing.js";
import { AppError } from "./errors.js";

const HOST_RE = /^(?:[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?|\[[0-9A-Fa-f:.]{2,45}\])$/;
const PATH_RE = /^[A-Za-z0-9._~/-]*$/;
const URL_RE = /^(https?):\/\/([^/:?#@\s]+|\[[^\]\s]+\])(?::(\d{1,5}))?(\/[^?#\s]*)?$/i;

/**
 * The canonical form of `raw`, or null when it is not an acceptable agent
 * server URL. A trailing slash is dropped, matching how the URL is stored.
 */
export function normalizeAgentServerUrl(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = trimTrailing(raw.trim(), "/");
  if (!trimmed || trimmed.length > 512) return null;
  const m = URL_RE.exec(trimmed);
  if (!m) return null;
  const [, scheme, host, port, path = ""] = m;
  if (!HOST_RE.test(host)) return null;
  if (port !== undefined) {
    const n = Number(port);
    if (n < 1 || n > 65535) return null;
  }
  if (!PATH_RE.test(path)) return null;
  return `${scheme.toLowerCase()}://${host}${port !== undefined ? `:${Number(port)}` : ""}${path}`;
}

/**
 * Guard for the places the URL becomes script text. Returns the canonical form
 * or throws — a script is never built from a URL that fails the allowlist, even
 * one that reached here by a route that skipped validation.
 */
export function assertScriptSafeServerUrl(url: string): string {
  const n = normalizeAgentServerUrl(url);
  if (n === null) {
    throw new AppError(
      400,
      "The agent server URL contains characters that are not allowed in a generated script; " +
        "set a plain http(s) URL under Server Settings → Agents.",
    );
  }
  return n;
}
