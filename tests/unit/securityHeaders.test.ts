/**
 * tests/unit/securityHeaders.test.ts — the shared helmet options both listeners
 * mount (src/app.ts and src/dash/dashServer.ts).
 *
 * Two of these directives are load-bearing for something that is invisible from
 * the server: whether OpenStreetMap serves us map tiles at all. Their usage
 * policy permits exactly one tile host and requires an identifiable Referer, and
 * a violation is answered with an "Access blocked" image in place of the map —
 * no error, no log line, nothing a test of ours would otherwise notice. So the
 * single host and the referrer policy are pinned here rather than left to the
 * comments beside them. See polaris-ui-canon → tech-stack-frontend.md § Mapping.
 */

import { describe, it, expect } from "vitest";
import { buildHelmetOptions } from "../../src/utils/securityHeaders.js";

/** The CSP directives, narrowed past helmet's union type. */
function directives(): Record<string, unknown> {
  const opts = buildHelmetOptions();
  const csp = opts.contentSecurityPolicy;
  if (typeof csp !== "object" || csp === null) throw new Error("no CSP configured");
  return (csp as { directives: Record<string, unknown> }).directives;
}

function imgSrc(): string[] {
  return directives().imgSrc as string[];
}

describe("buildHelmetOptions — OpenStreetMap tiles", () => {
  it("whitelists the one tile host the usage policy permits", () => {
    expect(imgSrc()).toContain("https://tile.openstreetmap.org");
  });

  it("carries no wildcard that would re-admit the blocked {s} subdomain form", () => {
    // a/b/c.tile.openstreetmap.org spreads one viewport over three hosts instead
    // of one multiplexed HTTP/2 connection. A wildcard here is what let that URL
    // shape live in four frontend files unnoticed until the tiles came back
    // blocked; without it the next attempt fails loudly at the CSP instead.
    for (const host of imgSrc()) {
      expect(host).not.toMatch(/\*\.tile\.openstreetmap\.org/);
    }
  });

  it("sends a Referer to the tile host — a missing one is OSM's first block reason", () => {
    // Only these five policies send an origin cross-origin. no-referrer and
    // same-origin look like reasonable hardening and silently strip it.
    expect(buildHelmetOptions().referrerPolicy).toEqual({
      policy: "strict-origin-when-cross-origin",
    });
  });
});

describe("buildHelmetOptions — the rest of the policy", () => {
  it("bans inline <script> while still allowing on* handler attributes", () => {
    expect(directives().scriptSrc).toEqual(["'self'"]);
    expect(directives().scriptSrcAttr).toEqual(["'unsafe-inline'"]);
  });

  it("keeps the Microsoft login host in form-action so SAML can POST back", () => {
    expect(directives().formAction).toEqual(["'self'", "https://login.microsoftonline.com"]);
  });

  it("forbids framing and plugin content outright", () => {
    expect(directives().frameSrc).toEqual(["'none'"]);
    expect(directives().objectSrc).toEqual(["'none'"]);
  });

  it("keeps the weather and font fallback hosts the widgets degrade to", () => {
    const connect = directives().connectSrc as string[];
    expect(connect).toContain("https://api.rainviewer.com");
    expect(connect).toContain("https://api.open-meteo.com");
    expect(connect).toContain("https://fonts.googleapis.com");
    expect(connect).toContain("https://fonts.gstatic.com");
  });

  it("sets a one-year HSTS max-age with subdomains and preload", () => {
    expect(buildHelmetOptions().hsts).toEqual({
      maxAge: 31536000,
      includeSubDomains: true,
      preload: true,
    });
  });
});
