/**
 * src/utils/securityHeaders.ts — the shared helmet options (CSP, HSTS,
 * referrer policy) used by BOTH the main web listener (src/app.ts) and the
 * Dash wallboard listener (src/dash/dashServer.ts).
 *
 * Extracted verbatim from the inline block that lived in app.ts so the two
 * surfaces can never drift: the Site Map widget's tile/img hosts and the
 * RainViewer/Open-Meteo/Google-Fonts connect-src entries must stay identical
 * wherever the dashboard widgets render.
 */

import type { HelmetOptions } from "helmet";

export function buildHelmetOptions(): HelmetOptions {
  return {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        // Inline <script> blocks are DISALLOWED — all page JS is served
        // from external files under /js. This blocks the most dangerous
        // XSS vector (injected <script> tags that can define new functions,
        // fetch remote code, etc).
        scriptSrc: ["'self'"],
        // Inline on* handler attributes are still permitted via scriptSrcAttr
        // because many pages generate HTML with onclick="foo(...)" via
        // innerHTML. Migrating these to addEventListener delegation is a
        // larger follow-up; until then this keeps the feature working while
        // still closing the bigger <script>-tag hole above.
        scriptSrcAttr: ["'unsafe-inline'"],
        styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
        fontSrc: ["'self'", "https://fonts.gstatic.com"],
        // The OpenStreetMap tile server is whitelisted here so the Device Map
        // page, the mobile map tab and the two map widgets can render a real
        // geographic basemap. OSM serves BOTH themes — dark is a CSS filter
        // over the tile pane, not a second tile source (CARTO's Dark Matter
        // was the dark half until CARTO began requiring an API key on its
        // basemap CDN, which is why *.basemaps.cartocdn.com is gone from this
        // list). Tiles load as <img>, not fetch, so they don't appear in
        // connectSrc. ONE host, not a wildcard: the tile usage policy permits
        // only tile.openstreetmap.org, so a wildcard here would just let a
        // future edit reintroduce the {s} a/b/c form that gets tiles blocked.
        imgSrc: [
          "'self'",
          "data:",
          "blob:",
          "https://tile.openstreetmap.org",
          // RainViewer precipitation-radar tiles for the Site Map widget's
          // weather overlay (loaded as <img>, served from tilecache.rainviewer.com).
          // The widget is proxy-first (/api/v1/weather radar tiles = 'self');
          // this host stays whitelisted for the direct-CDN fallback path.
          "https://*.rainviewer.com",
        ],
        // The Google Fonts hosts are fetch()ed (not just <link>-loaded) by the
        // asset-details Screenshot button: html-to-image inlines the page's
        // webfonts (CSS from fonts.googleapis.com, woff2 from fonts.gstatic.com)
        // into its DOM snapshot as data: URLs so the captured PNG renders in
        // Inter/Roboto Mono. Capture degrades gracefully to fallback fonts when
        // these hosts are unreachable (e.g. no-internet deployments).
        connectSrc: [
          "'self'",
          "https://fonts.googleapis.com",
          "https://fonts.gstatic.com",
          // Site Map widget weather overlay: RainViewer radar frame index +
          // Open-Meteo current-temperature lookups (both fetch()ed). Sends
          // only approximate site lat/long; degrades gracefully when offline.
          // The widget tries the Polaris weather proxy ('self') first — these
          // hosts remain whitelisted for the direct-CDN fallback path.
          "https://api.rainviewer.com",
          "https://api.open-meteo.com",
        ],
        frameSrc: ["'none'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'", "https://login.microsoftonline.com"],
        upgradeInsecureRequests: null,
      },
    },
    // preload: true signals browser preload-list maintainers that we're OK
    // being included. The header alone is harmless; actual inclusion still
    // requires a separate submission to https://hstspreload.org/. Safe to
    // leave on as long as every subdomain served from this origin is also
    // HTTPS-only (includeSubDomains above makes that a hard requirement).
    hsts: { maxAge: 31536000, includeSubDomains: true, preload: true },
    referrerPolicy: { policy: "strict-origin-when-cross-origin" },
  };
}
