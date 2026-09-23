/**
 * src/api/routes/pwa.ts — web app manifest + home-screen icons for the mobile SPA.
 *
 * Mounted OUTSIDE /api/v1 (in src/app.ts, before express.static) because a
 * manifest and its icons are browser-fetched document resources, not API. The
 * mount must precede express.static so these routes win over any same-named file.
 *
 * Scope note: the INSTALL IDENTITY is mobile-only — start_url is /mobile.html
 * and the desktop pages deliberately carry no <link rel="manifest">. The
 * desktop UI is not responsive below 700px, so installing it as an app would
 * be a worse experience than a browser tab.
 *
 * AUTHENTICATION: none, deliberately.
 *   1. A <link rel="manifest"> WITHOUT a crossorigin attribute is fetched with
 *      credentials OMITTED, so a session-gated manifest would 401 for everyone.
 *   2. /mobile.html is itself unauthenticated (not in protectedPages) — gating
 *      its manifest protects nothing.
 *   3. The manifest exposes only appName/subtitle/logo, which is byte-for-byte
 *      what GET /api/v1/server-settings/branding already serves unauthenticated
 *      so login.html can render custom branding.
 * The moment a first-time user most wants to install is while looking at the
 * login screen; a gated manifest makes the app un-installable exactly then.
 */

import { Router } from "express";
import { createHash } from "node:crypto";
import { displayAppName, getBranding } from "../../services/brandingService.js";
import { renderAppIcon, getIconSetVersion, findIconSpec } from "../../services/appIconService.js";

export const pwaRouter = Router();

/**
 * The theme color must equal the <meta name="theme-color"> in mobile.html, or
 * Android's task-switcher chrome flickers against the app bar.
 * Background is --md-surface (nightfall) — the actual first-paint color, so the
 * launch splash doesn't pop when it hands off to the app.
 */
const THEME_COLOR = "#1d2244";
const BACKGROUND_COLOR = "#141427";

/** Android home-screen labels clip around here. */
const SHORT_NAME_MAX = 12;

export function shortNameFor(appName: string): string {
  // Trim BEFORE the fallback: a whitespace-only appName is truthy but would
  // otherwise yield an empty home-screen label.
  const name = (appName || "").trim() || "Polaris";
  if (name.length <= SHORT_NAME_MAX) return name;
  const firstWord = name.split(/\s+/)[0];
  if (firstWord && firstWord.length <= SHORT_NAME_MAX) return firstWord;
  return name.slice(0, SHORT_NAME_MAX);
}

/**
 * Pure manifest builder — kept separate from the route so it unit-tests
 * without HTTP.
 */
export function buildManifest(
  branding: { appName: string; subtitle: string },
  iconVersion: string,
): Record<string, unknown> {
  const v = encodeURIComponent(iconVersion);
  const icon = (name: string, size: number, purpose: "any" | "maskable") => ({
    src: `/icons/${name}.png?v=${v}`,
    sizes: `${size}x${size}`,
    type: "image/png",
    purpose,
  });
  const shortcutIcon = [{ src: `/icons/app-192.png?v=${v}`, sizes: "192x192", type: "image/png" }];

  return {
    // The install-identity key. Defaults to start_url, so declaring it is a
    // no-op TODAY — but it pins identity so a future start_url change can't
    // fork every existing install into a second app. NEVER CHANGE THIS VALUE.
    id: "/mobile.html",
    // An operator may leave appName blank when their logo carries the wordmark
    // (see brandingService) — a manifest with an empty `name` is invalid, so
    // the install label falls back the same way shortNameFor already did.
    name: displayAppName(branding),
    short_name: shortNameFor(branding.appName),
    description: branding.subtitle,
    // Not "/": the phone-UA redirect in app.ts fires only for "/" and
    // "/index.html", so pointing straight at /mobile.html means a cold launch
    // is one request with no 302 — and no "opened outside the app window" flash.
    start_url: "/mobile.html",
    // Deliberately "/" and not "/mobile.html". Every out-of-scope navigation
    // ejects the user out of the installed window; a narrow scope would eject
    // on the More tab's "Desktop view" link, on any /login.html redirect, and
    // on a push click that deep-links to /automations.html.
    scope: "/",
    display: "standalone",
    // Android honors this natively, and it also makes the screen.orientation
    // .lock("portrait") call in mobile/app.js start succeeding once installed.
    orientation: "portrait",
    theme_color: THEME_COLOR,
    background_color: BACKGROUND_COLOR,
    lang: "en",
    dir: "ltr",
    categories: ["business", "productivity", "utilities"],
    // Both purposes at both sizes: "any" alone gets shrunk into a white circle
    // badge on Android 8+, "maskable" alone is letterboxed by browsers that
    // don't mask. 192 + 512 are Chrome's installability and splash minimums.
    icons: [
      icon("app-192", 192, "any"),
      icon("app-512", 512, "any"),
      icon("app-maskable-192", 192, "maskable"),
      icon("app-maskable-512", 512, "maskable"),
    ],
    shortcuts: [
      { name: "Assets", url: "/mobile.html#assets", icons: shortcutIcon },
      { name: "Device Map", url: "/mobile.html#map", icons: shortcutIcon },
      { name: "Networks", url: "/mobile.html#networks", icons: shortcutIcon },
    ],
  };
}

pwaRouter.get("/manifest.webmanifest", async (req, res, next) => {
  try {
    const [branding, version] = await Promise.all([getBranding(), getIconSetVersion()]);
    const body = JSON.stringify(buildManifest(branding, version));
    const etag = `W/"${createHash("sha256").update(body).digest("hex").slice(0, 16)}"`;

    res.set("Content-Type", "application/manifest+json; charset=utf-8");
    // no-cache, not no-store: the browser re-fetches the manifest on install
    // and periodically after, and a 304 is the cheap path. Branding changes
    // still propagate on the next revalidation.
    res.set("Cache-Control", "no-cache");
    res.set("ETag", etag);
    if (req.headers["if-none-match"] === etag) return res.status(304).end();
    return res.send(body);
  } catch (err) {
    return next(err);
  }
});

// Single plain :file param with the extension stripped in the handler, rather
// than ":name.png". Express 5 (path-to-regexp 8) changed path syntax enough
// that clever patterns are a boot-time crash risk in this codebase — see the
// routerBoots test. A plain param behaves identically across versions.
pwaRouter.get("/icons/:file", async (req, res, next) => {
  try {
    const file = String(req.params.file);
    if (!file.endsWith(".png")) return res.status(404).end();
    // Strict allowlist. Not decoration: a caller-supplied size would let resvg
    // allocate an arbitrarily large canvas — a trivial memory DoS.
    const spec = findIconSpec(file.slice(0, -4));
    if (!spec) return res.status(404).end();

    const [png, version] = await Promise.all([renderAppIcon(spec.variant, spec.size), getIconSetVersion()]);
    const etag = `W/"${version}-${spec.name}"`;

    res.set("Content-Type", "image/png");
    res.set("ETag", etag);
    // The manifest requests ?v=<version> URLs, but sw.js must reference the
    // BARE path (a service worker can't know the current version). So the
    // versioned URL is content-addressed and cacheable forever, while the bare
    // one revalidates often enough that a branding change reaches notification
    // icons quickly.
    res.set("Cache-Control", req.query.v === version ? "public, max-age=31536000, immutable" : "public, max-age=300");
    if (req.headers["if-none-match"] === etag) return res.status(304).end();
    return res.send(png);
  } catch (err) {
    return next(err);
  }
});

export default pwaRouter;
