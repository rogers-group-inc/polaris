/**
 * src/services/nginxConfigParser.ts — best-effort parse of the 6 user-settable
 * directives out of a live nginx server config. Used only by the bootstrap
 * pass in nginxApplyService.bootstrapProxyConfig() on first boot after this
 * feature ships, to seed a `proxyConfig` Setting row from whatever is already
 * on disk at /etc/nginx/conf.d/polaris.conf.
 *
 * This is NOT a full nginx parser — it's regex over the directives the
 * renderer writes. Anything beyond those (extra add_header lines, extra
 * proxy_pass targets, unrecognized location blocks) is reported in `drift`
 * so the bootstrap can keep managedMode=false and surface the refuse-and-
 * banner UX rather than auto-clobbering operator customizations.
 *
 * The /api docs block's allow-list is deliberately NOT parsed: it renders
 * from the separate `apiDocsConfig` Setting (apiDocsAccessService), which is
 * app-authoritative and never seeded from nginx — the allow collection below
 * is scoped to the /metrics* blocks so the two lists can't cross-contaminate.
 */

import { readFileSync, existsSync } from "node:fs";
import { defaultProxyConfig, type ProxyConfig, type TlsProtocol } from "../types/proxyConfig.js";

export interface ParseResult {
  /** Best-effort parse of the 6 controls. Untouched defaults if the file is missing. */
  config: ProxyConfig;
  /** Specific markers of customization beyond the 6 controls. Surfaced to the UI. */
  drift: string[];
}

const KNOWN_PROXY_PASS_PATTERNS: RegExp[] = [
  /^http:\/\/127\.0\.0\.1:\d+\/?$/,
  /^http:\/\/127\.0\.0\.1:\d+\/metrics$/,
];

const KNOWN_ADD_HEADERS = new Set(["Alt-Svc", "Strict-Transport-Security"]);

/** Location blocks deploy/nginx/polaris.conf.template ships. Keep in lockstep
 *  with that file — a mismatch reports drift on every managed install. */
const EXPECTED_LOCATION_BLOCKS = 10;

/**
 * Every `location` block in the (comment-stripped) text, as selector + body.
 * The shipped template nests no braces inside a location block, so a
 * non-greedy body match to the first closing brace is exact for our files;
 * a hand-edited file with nested braces mis-splits, which at worst loses
 * `allow` lines from the Prometheus seed — and such files carry other drift
 * markers anyway, so managedMode stays false and nothing is clobbered.
 */
function extractLocationBlocks(text: string): Array<{ selector: string; body: string }> {
  const blocks: Array<{ selector: string; body: string }> = [];
  for (const m of text.matchAll(/^\s*location\s+([^{]+)\{([^}]*)\}/gms)) {
    blocks.push({ selector: m[1].trim(), body: m[2] });
  }
  return blocks;
}

export function parseNginxConfig(filePath: string): ParseResult {
  if (!existsSync(filePath)) {
    return { config: defaultProxyConfig(), drift: ["file not found"] };
  }
  const text = readFileSync(filePath, "utf8");
  return parseNginxConfigText(text);
}

export function parseNginxConfigText(rawText: string): ParseResult {
  // Strip whole-line comments before pattern matching so commentary mentioning
  // directive names (proxy_pass, add_header, etc.) doesn't trip drift checks.
  // Inline comments after a directive are rare in our shipped template and
  // are tolerated.
  const text = rawText
    .split("\n")
    .filter((line) => !/^\s*#/.test(line))
    .join("\n");

  const drift: string[] = [];
  const cfg = defaultProxyConfig();
  cfg.managedMode = false;

  // Port — first `listen <N> ssl` we find.
  const portMatch = text.match(/\blisten\s+(\d+)\s+ssl\b/);
  if (portMatch) {
    cfg.httpsPort = Number(portMatch[1]);
  } else {
    drift.push("no `listen <port> ssl` directive found");
  }

  // HTTP/3 — both `listen <N> quic` and `http3 on;` must be present and uncommented.
  const quicListen = /^\s*listen\s+\d+\s+quic\b/m.test(text);
  const http3On = /^\s*http3\s+on\s*;/m.test(text);
  cfg.http3Enabled = quicListen && http3On;

  // TLS protocols — parse the ssl_protocols line if present.
  const protoMatch = text.match(/^\s*ssl_protocols\s+([^;]+);/m);
  if (protoMatch) {
    const found = protoMatch[1]
      .trim()
      .split(/\s+/)
      .filter((p): p is TlsProtocol => p === "TLSv1.2" || p === "TLSv1.3");
    if (found.length > 0) {
      cfg.tlsProtocols = found;
    } else {
      drift.push(`unrecognized ssl_protocols values: ${protoMatch[1].trim()}`);
    }
  }

  // HSTS — pulled from the Strict-Transport-Security add_header if present.
  const hstsMatch = text.match(/Strict-Transport-Security\s+"([^"]+)"/);
  if (hstsMatch) {
    const directives = hstsMatch[1].split(";").map((s) => s.trim());
    const maxAgeDirective = directives.find((d) => d.startsWith("max-age="));
    const maxAge = maxAgeDirective ? Number(maxAgeDirective.slice("max-age=".length)) : NaN;
    cfg.hsts = {
      enabled: true,
      maxAgeSeconds: Number.isFinite(maxAge) ? maxAge : 31536000,
      includeSubDomains: directives.includes("includeSubDomains"),
      preload: directives.includes("preload"),
    };
  } else {
    cfg.hsts.enabled = false;
  }

  // Prometheus allow-list — unique IPs from `allow <ip>;` lines, collected
  // ONLY from the /metrics* location blocks. The /api docs block carries its
  // own allow-list (rendered from the separate apiDocsConfig Setting), and a
  // file-global scan would merge those RFC1918 ranges into prometheusAllowIps
  // at bootstrap — silently widening the metrics allow-list.
  const allowIps = new Set<string>();
  for (const block of extractLocationBlocks(text)) {
    if (!block.selector.includes("/metrics")) continue;
    for (const m of block.body.matchAll(/^\s*allow\s+([^\s;]+)\s*;/gm)) {
      allowIps.add(m[1]);
    }
  }
  cfg.prometheusAllowIps = Array.from(allowIps);

  // Drift detection — unknown proxy_pass targets, unknown add_header keys,
  // unexpected location-block count.
  for (const m of text.matchAll(/\bproxy_pass\s+([^;]+);/g)) {
    const target = m[1].trim();
    if (!KNOWN_PROXY_PASS_PATTERNS.some((re) => re.test(target))) {
      drift.push(`unknown proxy_pass target: ${target}`);
    }
  }
  for (const m of text.matchAll(/\badd_header\s+(\S+)/g)) {
    if (!KNOWN_ADD_HEADERS.has(m[1])) {
      drift.push(`unknown add_header: ${m[1]}`);
    }
  }
  // We ship exactly 10 location blocks: / + the database-restore override +
  // the firmware-image upload override + 2 dash + 4 metrics + the /api docs
  // block. Anything else is custom. (A file rendered by an older template
  // reports drift here by design — a pre-dash one has 5, a pre-restore-override
  // one has 7, a pre-api-docs one has 8, a pre-firmware one has 9 — because
  // the refuse-and-banner UX makes the operator re-adopt so
  // the new blocks land explicitly rather than by silent clobber.)
  const locationCount = (text.match(/^\s*location\b/gm) ?? []).length;
  if (locationCount !== EXPECTED_LOCATION_BLOCKS) {
    drift.push(`location block count is ${locationCount} (expected ${EXPECTED_LOCATION_BLOCKS})`);
  }

  return { config: cfg, drift };
}
