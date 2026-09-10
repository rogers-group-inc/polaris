/**
 * src/services/nginxRenderer.ts — renders the operator's proxyConfig +
 * env-derived values into a complete nginx server config that lives at
 * /etc/nginx/conf.d/polaris.conf.
 *
 * Source template: deploy/nginx/polaris.conf.template, with {{TOKEN}}
 * placeholders. The renderer owns the "how does this directive look" logic
 * so togglable directives (QUIC listener, HSTS header, ssl_early_data) are
 * emitted as whole-line replacements — never half-commented.
 *
 * Determinism: given the same RenderInput, the rendered bytes (and sha256)
 * are identical across calls. updateService.ts and nginxApplyService.ts both
 * compare against `lastAppliedHash` to detect drift.
 */

import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ProxyConfig } from "../types/proxyConfig.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// The template ships under deploy/nginx/ at the repo root. This module lives
// at src/services/ in dev (tsx/esm) and dist/services/ in prod (compiled tsc
// output). Both are two dir levels deep, so resolving "../../deploy/nginx/"
// finds the template in both layouts.
function resolveTemplatePath(): string {
  return path.resolve(__dirname, "..", "..", "deploy", "nginx", "polaris.conf.template");
}

export interface RenderInput {
  config: ProxyConfig;
  /** Hostname for the `server_name` directive — derived from POLARIS_PUBLIC_URL. */
  serverName: string;
  /** Polaris web upstream port — derived from PORT env var (default 3000). */
  polarisPort: number;
  /** Dash wallboard upstream port — derived from POLARIS_DASH_PORT (default 3001). */
  dashPort: number;
  /**
   * Allow-lines for the /api docs location block, derived from the
   * `apiDocsConfig` Setting via apiDocsAccessService.deriveApiDocsNginxAllow —
   * deliberately NOT part of ProxyConfig, because the docs scope must exist on
   * installs that have no managed nginx at all (the app gate in src/app.ts is
   * the authoritative enforcement; this block is defense in depth). Required
   * so the compiler finds every render call site when the seam changes.
   */
  apiDocsAllow: { enabled: boolean; allow: string[] };
}

export interface RenderResult {
  contents: string;
  sha256: string;
}

export function renderNginxConfig(input: RenderInput, templateOverride?: string): RenderResult {
  // Normalize CRLF -> LF at read time. Windows checkouts can introduce CRLF
  // via git's autocrlf; the rendered nginx config must always be LF since it
  // lands on Linux, and the deterministic-sha256 invariant breaks if line
  // endings drift across platforms.
  const template = (templateOverride ?? readFileSync(resolveTemplatePath(), "utf8"))
    .replace(/\r\n/g, "\n");

  const substitutions: Record<string, string> = {
    HTTPS_PORT: String(input.config.httpsPort),
    SERVER_NAME: input.serverName,
    POLARIS_PORT: String(input.polarisPort),
    DASH_PORT: String(input.dashPort),
    SSL_PROTOCOLS_LIST: input.config.tlsProtocols.join(" "),
    QUIC_LISTENER: renderQuicListener(input.config),
    SSL_EARLY_DATA: renderSslEarlyData(input.config),
    HSTS_HEADER: renderHstsHeader(input.config),
    METRICS_ALLOW_BLOCK: renderMetricsAllowBlock(input.config),
    API_DOCS_ALLOW_BLOCK: renderApiDocsAllowBlock(input.apiDocsAllow),
  };

  let contents = template;
  for (const [token, value] of Object.entries(substitutions)) {
    contents = contents.split(`{{${token}}}`).join(value);
  }

  const sha256 = createHash("sha256").update(contents).digest("hex");
  return { contents, sha256 };
}

function renderQuicListener(cfg: ProxyConfig): string {
  if (!cfg.http3Enabled) return "";
  return [
    "",
    "",
    "  # UDP listener — HTTP/3 over QUIC. Requires nginx 1.25+.",
    `  listen ${cfg.httpsPort} quic reuseport;`,
    "  http3 on;",
    "",
    "  # Advertise HTTP/3 to clients connecting over TCP. ma=86400 = 24h client cache.",
    `  add_header Alt-Svc 'h3=":${cfg.httpsPort}"; ma=86400' always;`,
  ].join("\n");
}

function renderSslEarlyData(cfg: ProxyConfig): string {
  // 0-RTT only emitted when QUIC is enabled. On TCP-TLS-1.3 it also has replay
  // risk for non-idempotent requests; defense in depth — only ship the
  // directive when the QUIC payoff justifies the surface.
  if (!cfg.http3Enabled) return "";
  return "\n  ssl_early_data on;   # 0-RTT on QUIC for resumed sessions (TLS 1.3 only)";
}

function renderHstsHeader(cfg: ProxyConfig): string {
  if (!cfg.hsts.enabled) return "";
  const directives = [`max-age=${cfg.hsts.maxAgeSeconds}`];
  if (cfg.hsts.includeSubDomains) directives.push("includeSubDomains");
  if (cfg.hsts.preload) directives.push("preload");
  return [
    "",
    "",
    "  # HSTS at the edge, and the upstream's copy stripped so the response",
    "  # carries exactly one. Polaris also sets this header via helmet (which is",
    "  # what protects an install running Node's own TLS with no proxy in front),",
    "  # so without the hide a proxied response carried it TWICE, and RFC 6797",
    "  # §8.1 says a UA that receives more than one processes only the first",
    "  # and the response is non-compliant — browsers do not take the",
    "  # strongest seen. The hide is paired with the add_header deliberately:",
    "  # with HSTS disabled here the edge strips nothing, so the app's own",
    "  # header still reaches the client.",
    `  add_header Strict-Transport-Security "${directives.join("; ")}" always;`,
    "  proxy_hide_header Strict-Transport-Security;",
  ].join("\n");
}

function renderMetricsAllowBlock(cfg: ProxyConfig): string {
  const lines = cfg.prometheusAllowIps.map((ip) => `    allow ${ip};`);
  lines.push("    deny all;");
  return lines.join("\n") + "\n";
}

function renderApiDocsAllowBlock(apiDocs: RenderInput["apiDocsAllow"]): string {
  // Disabled renders as `deny all;` alone — off means off, matching the app
  // gate's posture (docsSourceAllowed denies everyone, loopback included).
  const lines = apiDocs.enabled ? apiDocs.allow.map((a) => `    allow ${a};`) : [];
  lines.push("    deny all;");
  return lines.join("\n") + "\n";
}
