# Services — settings, branding, backup/update, events, nginx, dash, icons

Per-service touches (What it owns / Public API / Cross-service deps / Used by / Invariants / When changing this), verbatim from TOUCHES.md. Code references are `path/file.ts → symbolName()` — grep the symbol.

## services/appIconService.ts

**What it owns:** The PWA home-screen icon set, rasterized from the branding logo with `@resvg/resvg-js` (an SVG canvas of the target size embeds the source bitmap as a `data:` URI). Also owns `ICON_SPECS` — the allowlist `routes/pwa.ts` matches request paths against — and the icon-set version stamp used as the manifest's `?v=` cache-buster and the icon ETag.

**Public API:** `ICON_SPECS`, `findIconSpec`, `renderAppIcon`, `getIconSetVersion`, `resolveBrandingLogoFile`, `__resetIconCacheForTests`

**Cross-service deps:** `brandingService.getBranding` (source logo + defaults), `utils/imageMagic.detectImageMagic` (re-sniff on read), `utils/paths` (`UPLOADS_DIR`, `PUBLIC_DIR`), lazy `@resvg/resvg-js`.

**Used by:** `src/api/routes/pwa.ts` only (`GET /manifest.webmanifest` for the version, `GET /icons/:file` for the bytes).

**Invariants:**
- **Nothing here throws.** Every failure rung — unresolvable `logoUrl`, path outside `UPLOADS_DIR`, missing file, non-image bytes, WebP, resvg failure — degrades to the shipped `public/img/brand/polaris-symbol-dark.png` (the light-inked mark — the icon canvas is dark). A branding mistake must not break the manifest or the icon a push notification renders with.
- The cache key includes the logo file's **mtime**. The upload route writes a FIXED filename (`custom-logo.png`), so `logoUrl` never changes on re-upload — mtime is the only invalidation signal and is load-bearing.
- `resolveBrandingLogoFile` takes the **basename** and then asserts the resolved path is still inside `UPLOADS_DIR`. The `branding` Setting row is operator-writable and is the only untrusted input in this service.
- The `@resvg/resvg-js` import is **lazy** (inside `renderAppIcon`) so a missing per-platform native binding degrades to the raw logo instead of failing module load and taking every route in the process with it.
- resvg cannot decode an embedded **WebP**, and the branding upload route accepts WebP — that fallback is expected behavior, not an error.

**When changing this:**
- Adding a variant/size means adding to `ICON_SPECS` (the route allowlist) AND to the manifest's `icons` array in `routes/pwa.ts`. Never let the route accept a caller-supplied size — resvg would allocate an unbounded canvas.
- The cache is process-local and assumes `POLARIS_ROLE=web` stays single-instance (`deploy/polaris-web.service` is not a templated unit). If web ever becomes multi-replica, this is still correct — just N caches instead of one.

---

## services/brandLogoService.ts

**What it owns:** The composite of the operator's logo with the Polaris symbol on its bottom-right corner (`branding.logoAccent`) — the geometry, the rasterization, and the in-process cache. Same `@resvg/resvg-js` embed-a-bitmap-in-an-SVG technique as `appIconService`.

**Public API:** `accentGeometry` (pure), `normalizeBrandTheme` (pure), `renderAccentedLogo(theme)`, `ACCENT_SYMBOL_PATHS`, `ACCENT_FRACTION`, `MAX_RENDER_PX`, `BrandTheme`, `__resetBrandLogoCacheForTests`

**Cross-service deps:** `brandingService` (`getBranding`, `hasCustomLogo`), `appIconService.resolveBrandingLogoFile` (the basename + inside-UPLOADS_DIR assertion — one definition of "which file is the logo"), `utils/imageMagic.detectImageMagic`, `utils/imageSize.imageSize`, `utils/paths.PUBLIC_DIR`, lazy `@resvg/resvg-js`.

**Used by:** `src/api/router.ts` only — the PUBLIC `GET /server-settings/branding/logo-accent.png`, declared above `requireAuth` because the login page renders the mark with no session. The frontends reach it through `public/js/brand-logo.js`, never by building the path themselves.

**Invariants:**
- **Nothing here throws.** Accent off, default logo, missing/unreadable file, WebP, resvg failure, dimensions unparseable → `null`, and the route 302s to the plain `logoUrl`. This feeds an `<img>` on an unauthenticated login page; an accent is decoration and must never be why a login page renders without a mark.
- **Compositing is server-side on purpose.** A CSS overlay would need its own absolute positioning and its own fraction-of-what arithmetic on the desktop login, the mobile login, the sidebar and the settings preview — four chances to disagree. One PNG, one URL.
- The cache key is the logo's **and** the symbol's mtime **and the theme** — the upload route writes a FIXED filename, so mtime is the only invalidation signal (the `appIconService` rule, for the same reason), and the ETag is derived from that same key so the two theme variants can never revalidate into each other.
- **The symbol is theme-paired, so the render takes a theme — a FAMILY, not a theme id.** `normalizeBrandTheme` narrows to `light` | `dark`, and `public/js/brand-logo.js:currentTheme()` sends the current theme's family, which is what keeps the three browser themes (`morning` / `noon` / `nightfall`) mapping onto the two shipped art sets with no third asset and no server change. Its wedges are white on `polaris-symbol-dark.png` and navy on `polaris-symbol-light.png`; against the wrong background half the mark vanishes and the star reads as four loose arms. `normalizeBrandTheme` narrows the query value to the two known keys before it indexes `ACCENT_SYMBOL_PATHS` — this is an unauthenticated route selecting a filesystem path.
- `accentGeometry` clamps to half the SHORTEST side. Without it a wide banner logo would get an accent taller than the logo itself, since `ACCENT_FRACTION` (0.5) is measured on the longest side.
- Rendering caps at `MAX_RENDER_PX`. The route is unauthenticated, so the canvas size must not be a function of what an operator uploaded.

**When changing this:**
- Changing the geometry changes what operators already saved — `accentGeometry` is pure and unit-tested (`tests/unit/brandLogoService.test.ts`) precisely so the placement promise ("bottom-right, roughly half the logo") is a test, not a comment. The Customization tab's checkbox hint states the same number; move both together.
- The frontend's `logoAccent` → URL mapping lives in `public/js/brand-logo.js` (which appends `?theme=`), plus the Customization tab's preview `src` in `public/js/server-settings.js`; a path or query change is a three-file change.
- WebP is deliberately unsupported (resvg can't decode it in an embedded `<image>`) — a WebP-branded install shows its logo un-accented, which is the same fallback `appIconService` already makes.

---

## services/brandingService.ts

**What it owns:** The `branding` Setting row — `appName` / `subtitle` / `logoUrl` / `logoAccent` / `logoOnLogin` / `logoOnSidebar` / `temperatureUnit` — plus `BRANDING_DEFAULTS`, `normalizeTemperatureUnit`, `normalizeBrandingFlag`, `hasCustomLogo` and `displayAppName`. Read-side only; the writers stay in the serverSettings routes.

**Public API:** `getBranding`, `BRANDING_DEFAULTS`, `normalizeTemperatureUnit`, `normalizeBrandingFlag`, `hasCustomLogo`, `displayAppName`, the `BrandingSettings` + `TemperatureUnit` types

**Cross-service deps:** `prisma` (the `Setting` table), `utils/version.getAppVersion` (the `version` field on the response).

**Used by:** `src/api/routes/serverSettings.ts` (`GET|PUT /branding`, `POST|DELETE /branding/logo` — it also **re-exports `getBranding`** so the public `/branding` alias in `src/api/router.ts` keeps working via its dynamic import), `src/api/routes/pwa.ts`, `src/services/appIconService.ts`, `src/services/brandLogoService.ts`. Browser-side, `public/js/brand-logo.js` is the only reader of the logo/placement fields — surfaces call it rather than branching on the payload themselves.

**Invariants:**
- Extracted from `routes/serverSettings.ts` precisely so services can read branding without importing a route module — do not reintroduce the reverse dependency.
- `getBranding` never throws on a missing row; it returns defaults.
- Writers (logo upload/delete, name/subtitle PUT) still live in the route and each **replaces the whole row**, so a writer that omits a field silently resets it — the logo upload/delete routes carry `temperatureUnit` AND the three logo flags forward for exactly that reason (the typechecker caught it when each field was added; keep every `BrandingSettings` field non-optional so it keeps catching it).
- **`appName` may be empty.** Read with `!== undefined`, written without a `|| BRANDING_DEFAULTS.appName`: blanking it is how an operator whose uploaded logo already carries their wordmark says "no text beside the logo". Anything that must PRINT a name — page titles, the PWA manifest's `name`, the acknowledge page — goes through `displayAppName`, never `.appName` raw. `shortNameFor` in `routes/pwa.ts` already had its own fallback and keeps it.
- **The three logo flags are read through `normalizeBrandingFlag`, not `||`.** `logoOnLogin`/`logoOnSidebar` default ON, so a `||` would resurrect a stored `false` on every read and quietly re-enable a logo the operator had switched off for that surface. Only `undefined`/`null` take the default.
- `hasCustomLogo` is the single definition of "the operator uploaded something", surfaced on the GET payload as the derived `customLogo` so no frontend has to compare against a default path. It judges against `DEFAULT_LOGO_URLS` — the current default AND the retired `/logo.png`, which pre-cutover installs still have stored; comparing against the current default alone would read those rows as an operator upload and paint a 404 on every surface. The three write routes include it in their responses too — the Customization tab renders straight off the PUT/POST result.
- The placement + accent flags are **inert without a custom logo** and are deliberately NOT reset by `DELETE /branding/logo`: an operator who re-uploads gets their choices back verbatim.
- **`temperatureUnit` is DISPLAY-ONLY and rides this row deliberately.** Hardware-sensor samples are always stored, rolled up, and alerted on in Celsius (`SENSOR_CLASS_UNITS`); the frontends convert at render through `public/js/temp-unit.js` (`window.PolarisTempUnit`, unit-tested in `tests/unit/tempUnit.test.ts`). Branding is the only presentation channel every surface already has: the `/branding` alias is unauthenticated, `applyBranding` in app.js mirrors the payload into `localStorage["polaris-branding"]` (which is what lets the converter be SYNCHRONOUS for the sync string-building renderers), `PolarisAuthFlow.fetchBranding` primes the same cache for the mobile SPA, and the Dash wallboard — no user identity, so a per-user preference could never reach it — serves the same route. Readers that must convert TOGETHER or a chart contradicts itself: `_hwReadingText` (the Hardware Sensors table), `_loadSensorHistoryFor` (series + stats + the °C automation thresholds behind the severity shading), the mobile asset sheet's sensor list, and `widgets/temperature.js` (rows AND its 80/65 °C color breakpoints). Conversion is gated on each reading's OWN stored unit, never its class, so fan RPM and voltage rails pass through untouched. Never plumb it into the automation builder or any threshold input — those stay °C.

**When changing this:**
- Adding a branding field means updating the route's PUT schema too — and consider whether it belongs in the PWA manifest (`buildManifest` in `routes/pwa.ts`).
- Changing `logoUrl` semantics (e.g. non-fixed filenames) breaks `appIconService`'s AND `brandLogoService`'s mtime-based cache keys — read those invariants first.
- Which mark each surface paints is `public/js/brand-logo.js`'s call, not the surface's: desktop login (`js/login.js`), mobile login (`js/mobile/auth.js`), the sidebar (`applyBranding` in `js/app.js`) and the Customization tab preview (`js/server-settings.js`) all go through `PolarisBrandLogo.resolve/applyTo`. Adding a fifth surface means calling it too, not re-deriving the rule.
- The shipped art lives in `public/img/brand/` as one file per (orientation, theme) — those names are in `brand-logo.js`'s `ASSETS` map and nowhere else.

---

## services/certInfo.ts

**What it owns:** Single source of truth for the leaf cert nginx serves (`POLARIS_PROXY_CERT_PATH`). Layered cache (keyed on raw-file SHA-256) + last-known-good fallback tolerates the atomic-rename window during rotation. Exposes the SHA-256 fingerprint (agent pin), cert hostnames (URL inference), and expiry.

**Public API:** `getServerCertFingerprint`, `getServerCertHostnames`, `getServerCertExpiry`, `invalidateCache`, `__resetCertInfoCacheForTests`

**Cross-service deps:** none (node:fs, node:crypto, logger).

**Used by:** `src/api/routes/proxySettings.ts` + `src/api/routes/serverSettings.ts` (fingerprint/expiry display), `src/api/routes/assets.ts`, `src/services/agentInstallService.ts` + `src/services/agentAutoDeployService.ts` (stamp the pin into `agent.conf`), `src/services/nginxApplyService.ts` (post-rotate cache invalidation).

**Invariants:**
- All accessors are synchronous — 20+ callers rely on sync reads; never make them async.
- Read failures retry briefly and fall back to last-good so a transient read during rotation doesn't break agents mid-connection; repeat-failure warn logs are suppressed until success resumes.
- Fingerprint is `sha256:<hex>` of the cert DER, stable for agent pinning.

**When changing this:**
- If `POLARIS_PROXY_CERT_PATH` ever becomes mutable at runtime, the setter must call `invalidateCache`.
- `__resetCertInfoCacheForTests` is test-only — never call it from production code.

---

## services/deviceIconService.ts

**What it owns:** Operator-uploaded device icons (PNG/JPEG/WebP/SVG; 256KB cap raster, 32KB cap SVG; magic-byte check for raster, pattern-reject validation for SVG); bytes-in-DB storage. Every icon is keyed to (manufacturer, type-or-model); resolution priority is `manufacturer-model: <mfr>/<model>` → `manufacturer-type: <mfr>/<assetType>`. Manufacturer values canonicalized through `manufacturerAlias` map at both upload and resolution time.

**Public API:** `uploadIcon(), listIcons(), getIconImage(), deleteIcon(), loadIconResolutionCache(), resolveIconUrl(), validateUpload()`

**Cross-service deps:** `utils/manufacturerNormalize.normalizeManufacturer()` for alias-canonicalization of manufacturer values (both the standalone manufacturer scope and the manufacturer half of model:<mfr>/<model> keys).

**Used by:** `src/api/routes/deviceIcons.ts,56,83,105 — upload/list/delete CRUD + image serve`, `src/services/topologyGraphService.ts — icon resolution for topology switches/APs/firewalls/remote nodes (icon cache preloaded once per buildSiteTopology call)`

**Invariants:**
- Scope: "manufacturer-type" (asset type key, enum: server/switch/router/firewall/workstation/printer/access_point/other) or "manufacturer-model" (vendor-specific chassis/model). Both require a manufacturer; standalone type/model/manufacturer uploads are not supported.
- Canonical key form: `"<canonicalManufacturer>/<typeOrModel>"`. Manufacturer half always runs through normalizeManufacturer (alias map). Type tail lowercased; model tail preserved as typed.
- Upload validation: mimeType must be PNG/JPEG/WebP/SVG; raster size ≤256KB, SVG size ≤32KB; raster requires magic-byte prefix matching declared mimeType; SVG is reject-on-pattern (refused if it contains <script>, <foreignObject>, <iframe>, <object>, <embed>, <!DOCTYPE>, <!ENTITY>, <?xml-stylesheet>, on*= event handlers, javascript: URLs, any non-#fragment href/xlink:href/src, @import, or external url()).
- SVG uploads that pass validation are **rasterized to a 512×512 PNG via `@resvg/resvg-js` (`rasterizeSvgToPng`)** before storage, and the row is written with mimeType `image/png` + a `.png` filename suffix. Background: Cytoscape's `background-image` pipeline loads SVGs via `new Image()` and design-tool exports (Adobe Illustrator etc.) typically omit `width`/`height` and declare only `viewBox`, so the browser falls back to a tiny default natural size and the topology icon visually anchors upper-left at a fixed pixel size at every zoom. Server-side rasterization gives the renderer a bitmap with intrinsic dimensions and side-steps the whole class of bug. The one-shot `rasterizeStoredSvgIcons` startup job migrates pre-existing `image/svg+xml` rows the same way; idempotent via the mimeType filter.
- Resolution is most-specific-wins: manufacturer-model → manufacturer-type → null (frontend leaves node as a plain status circle). Assets with no manufacturer resolve to null directly — no fallback to "any vendor".
- `resolveIconUrl()` is synchronous (used in hot topology path); operates against pre-loaded cache from `loadIconResolutionCache()`. Both call sites share `buildResolutionCandidates()` so the priority order can't drift between sync and async paths.
- Topology renderer overlays the icon at ~70% of the visual diameter centered. The recipe is `background-fit: contain` with NO `background-width`/`background-height` override (so Cytoscape scales the image to fill the model-space node bounds, maintaining aspect ratio AND scaling with zoom), and a per-role thick `border-width` so the colored ring eats the outer ~15% of the visual diameter on each side. Both percentage and pixel `background-width` were tried in earlier attempts and both have Cytoscape 3.30 quirks: percentage causes zoom-dependent overflow; pixel is treated as render pixels (icon stops scaling with zoom) and breaks centering. Letting contain do the work alone is the predictable recipe. See `public/js/topology-render.js` `node[hasIcon=1]` style + the per-role border-width selectors directly below it.
- Bytes stored as Uint8Array in DeviceIcon.data column; `/api/v1/device-icons/:id/image` serves raw bytes with Content-Type + Cache-Control. (Defense-in-depth: any `image/svg+xml` row — only legacy rows predating the rasterize-on-upload change, since new SVG uploads are stored as PNG — is served with X-Content-Type-Options: nosniff + a strict CSP `default-src 'none'; style-src 'unsafe-inline'; img-src data:; sandbox`.)

**When changing this:**
- Check magic-byte prefixes (PNG/JPEG/WebP) if adding new raster formats; ensure length matches actual file signatures.
- SVG_REJECT_PATTERNS is the security boundary — adding a new tag/attribute reject pattern is fine, but loosening one needs careful review (every entry maps to a known XSS / XXE / SSRF vector).
- Sync VALID_TYPE_KEYS set against `BUILT_IN_ASSET_TYPES` in `src/utils/assetTypes.ts` if new built-ins are added. Custom operator-added AssetTypeDef rows don't automatically get icon-resolution coverage — device icons keyed by manufacturer-type only resolve for built-in type names.
- Verify Prisma DeviceIcon schema: unique constraint on (scope, key), Bytes column type for data. Scope is a String column — no DB migration needed when adding new scope values.
- Review topologyGraphService.ts topology rendering (resolveIconUrl call sites) if icon resolution priority changes — but priority is built once in `buildResolutionCandidates()`, so updates land in both sync and async paths together.
- Ensure upload route multer fileSize limit (256KB) stays at or above the raster MAX_ICON_BYTES constant. SVG's tighter MAX_SVG_BYTES is enforced inside validateUpload after multer accepts.
- Image-serve route: any new mimeType added to ALLOWED_MIME_TYPES that could execute (script-bearing text formats) needs the same CSP/nosniff treatment as SVG.
- Topology renderer style for `node[hasIcon=1]` in `public/js/topology-render.js` fills the node interior with white (`background-color: #ffffff`) so vendor logos pop against any basemap, and carries the status signal via a 5px `border-color: data(nodeColor)` ring instead of the fill. If you change the icon to full-bleed, drop the white fill and restore `background-color: data(nodeColor)` so the status hue isn't lost.
- Per-role `border-width` for `node[hasIcon=1]` must stay roughly 15% of the role's node `width` so the visible image lands at ~70% of the overall visual diameter. Today: fortigate 10/64, fortiswitch+remote-asset 7/44, fortiap 6/36. Change one without the other and the colored ring is either invisibly thin or so thick the logo disappears.

---

## services/eventArchiveService.ts

**What it owns:** All outbound Event flows (syslog/SFTP archival), event retention/prune configuration, and asset auto-decommission settings. Events created anywhere flow through here via job (pruneEvents) + optional real-time forwarders.

**Public API:** `getArchiveSettings`, `updateArchiveSettings`, `testConnection`, `archiveAndExport`, `getSyslogSettings`, `updateSyslogSettings`, `testSyslogConnection`, `getRetentionSettings`, `getCachedRetentionSettings`, `updateRetentionSettings`, `getAssetDecommissionSettings`, `updateAssetDecommissionSettings`.

**Cross-service deps:** none (reads Settings, spawns sftp/scp/nc, uses prisma Event table).

**Used by:** `src/jobs/pruneEvents.ts,25 — scheduled archive/export`; `src/jobs/decommissionStaleAssets.ts — inactivity threshold`; `src/api/routes/events.ts — admin CRUD endpoints`; `capacityService.ts — capacity transition Event creation`. ~8 call sites.

**Invariants:**
- All successful Events are written to `prisma.event.create()` by callers (routes, services, jobs); eventArchiveService does not write Events, only manages their export/retention. The canonical helper is `logEvent` in [src/services/eventLogService.ts](src/services/eventLogService.ts) (re-exported from `src/api/routes/events.ts` for legacy importers) — it consults `getCachedRetentionSettings().minLevel` to drop sub-threshold events, and stamps the numeric `levelRank` (0=info, 1=warning, 2=error) at write time so the Events list endpoint's `sortBy=level` can dispatch to `orderBy: { levelRank }` for severity-ordered sort. Direct `prisma.event.create()` callers must stamp `levelRank` themselves; nothing in-tree bypasses `logEvent` today.
- Archive export (SFTP/SCP) reads Events older than cutoff, writes JSON file, transfers via ssh/sftp spawn, then deletes from DB (via pruneEvents job).
- Retention cache (1 min TTL) avoids DB read on every Event write; callers using `getCachedRetentionSettings()` must accept stale data.
- Asset decommission threshold (0 = disabled) is in months; lastSeen older than that triggers `decommissioned` status in a separate 24h job.
- Syslog (UDP/TCP/TLS) sends test messages synchronously; real event forwarding NOT in this service (would be added as a background job).
- SFTP batch-file injection prevention: paths with quotes/newlines rejected before spawn.

**When changing this:**
- Test archiveAndExport with large Event payloads (>10k rows); verify SFTP/SCP progress.
- Verify retention cache doesn't mask rapid setting changes; 60s may be too long for some ops.
- Check asset decommission query doesn't accidentally mark live assets as stale (lastSeen >= cutoff).
- Confirm syslog test messages arrive with the right facility/severity/format.
- Validate SFTP injection prevention doesn't reject legitimate Windows paths with backslashes.

---

## services/eventLogService.ts

**What it owns:** The shared audit-event writer. `logEvent` (never throws; drops rows below the operator-configured min level; stamps `levelRank` at write time), `buildChanges` (before/after diff for `.updated` events), `LogEventInput`. Plus the discovery per-asset audit helpers: `snapshotMaterialAssetFields` (capture material fields before a discovery branch mutates the in-memory asset), `computeMaterialAssetChanges` (pure diff over the material-field whitelist), `logDiscoveryAssetCreated` (`asset.discovered`), `logDiscoveryAssetUpdated` (`asset.discovery_updated` — fires only when a material field changed), `DiscoveryAuditContext`.

Plus the per-asset **change-event builders** (`computeFirmwareChange`, `buildFirmwareChangedEvent`, `buildConnectionChangedEvent`, `buildFirewallChangedEvent`, `AssetChangeEventContext`) behind `asset.firmware.changed` / `asset.switch_port.changed` / `asset.wireless_ap.changed` / `asset.gateway_firewall.changed`.

**Public API:** `logEvent`, `logEventsBatch`, `buildChanges`, `LogEventInput`, `snapshotMaterialAssetFields`, `computeMaterialAssetChanges`, `logDiscoveryAssetCreated`, `logDiscoveryAssetUpdated`, `DiscoveryAuditContext`, `computeFirmwareChange`, `buildFirmwareChangedEvent`, `buildConnectionChangedEvent`, `buildFirewallChangedEvent`, `AssetChangeEventContext`.

**Cross-service deps:** `eventArchiveService.getCachedRetentionSettings` (cached min-level read).

**Used by:** ~42 modules across routes / services / jobs. Most import via the back-compat re-export in `src/api/routes/events.ts`; new code should import from here directly so services never depend on the route layer. The discovery audit helpers are called from every asset create/update site in `discoveryEngine.ts` (firewall / FortiSwitch / FortiAP / Entra / AD update + create, plus FortiGate device-inventory endpoint create).

**Invariants:**
- `logEvent` must never throw — event logging can't be allowed to break the operation it audits. Failures are swallowed.
- `levelRank` is stamped here (0=info, 1=warning, 2=error); the Events list endpoint's `sortBy=level` depends on it.
- Sub-`minLevel` events are dropped silently (cached settings read, 60s TTL — accept staleness).
- The discovery audit MATERIAL_ASSET_FIELDS whitelist is the flood guard: discovery bumps `lastSeen` / fetched-at / monitor stamp every cycle on nearly every asset, so diffing those would write an event per asset per cycle (catastrophic at 2000 assets vs. 7-day Event retention). Only identity/classification/location fields are diffed; an unchanged pass emits nothing. The endpoint **update** path is intentionally NOT instrumented (it reassigns `macAddress` to the most-recently-sorted MAC each cycle → spurious diffs); only endpoint **create** is.

**When changing this:**
- The events.ts re-export must stay in lockstep (same symbol names) until the legacy importers are migrated. (It deliberately does NOT re-export the change-event builders — new code imports them from here.)
- Anything that makes `logEvent` throw or block breaks every mutating route in the app — keep it best-effort.

---

## services/platformLifecycleService.ts

**What it owns:** Observing what this Polaris host is actually running (Node, PostgreSQL, TimescaleDB, Go, Java, nginx, the OS, PgBouncer, Prisma) and assembling that against the committed end-of-life dataset into the Platform Lifecycle card's answer. Also the transition record that decides when a lifecycle change is worth an Event.

**Public API:** `getPlatformLifecycle`, `observePlatformStack`, `loadPlatformEolDataset`, `lifecycleCapacityReasons`, `LIFECYCLE_REASON_FAMILY`, `recordPlatformLifecycleTransition`, `lifecycleFingerprint`, `lifecycleStateIsFresh`, `LIFECYCLE_STATE_SETTING_KEY`, `LIFECYCLE_CHANGED_ACTION`, `LIFECYCLE_RECOVERED_ACTION`, `LIFECYCLE_WATCH_MIN_AGE_MS`, `_resetDatasetCache`, `_resetLifecycleMemo` (test seams), plus the `ObservedComponent` / `LifecycleComponent` / `PlatformLifecycleResult` types.

**Cross-service deps:** `timescaleService.getDetectionState()` (cached boot state — no query), `agentBuildService.goAvailable()`, `utils/platformVersions` (all parsing), `utils/platformLifecycleGrade` (all grading), `utils/deploymentContext.runtimeIsContainer`, `utils/dbConnections.isPgbouncerMode`, `utils/version` for the informational rows. Spawns `java -version` and `nginx -v`; runs one `SHOW server_version`.

**Used by:** `src/api/routes/serverSettings.ts — GET /platform-lifecycle` and the card it feeds; `src/services/capacityService.ts — computeReasons()` via the lazy `lifecycleReasonsSafe()` import; `src/jobs/platformLifecycleWatch.ts — the daily transition check`.

**Invariants:**
- **`observePlatformStack()` never throws.** Every probe owns its try/catch and reports `probeStatus` (`ok` / `absent` / `error` / `undetectable`) instead. `getPlatformLifecycle()` additionally swallows a missing or malformed dataset into `datasetError` with an empty component list — the capacity snapshot and the whole Maintenance tab must keep rendering when the lifecycle data is the only broken thing.
- **`absent` is not `error`.** nginx, Go, Java and PgBouncer are legitimately missing on a supported install (Docker has Go but no nginx; a `-nodb` host may have neither). Treating absence as failure would put a permanent error on a healthy card.
- **No per-asset queries, ever.** The only new database work is one `SHOW server_version` — a GUC read, not the banner-building `SELECT version()`. The 2000-asset case must cost exactly what the 100-asset case costs.
- The whole assembly is memoized for six hours; `{force: true}` bypasses it. A 10-minute caller therefore pays the exec cost at most four times a day.
- **The nginx probe is gated on the managed config existing**, so an install that is not fronted by nginx never spawns a process. It reads STDERR (where `nginx -v` writes) and is deliberately NOT routed through the `polaris-nginx-apply` sudo wrapper — that wrapper's argument surface is the entire granted privilege and must not widen for a version read.
- **The OS row is relabelled inside a container.** Without that, the container's Debian os-release gets reported as the operator's RHEL host.
- **PgBouncer's version is `undetectable`, not unknown-by-accident.** It needs `SHOW VERSION` on the admin console with credentials Polaris does not hold; the card asks the operator to confirm the floor by hand.
- The service reads the dataset and never writes it. Refreshing `src/data/platformEol.json` is a human-reviewed task owned by `polaris-tech-lifecycle`.
- The grader sets `capacitySeverityCap: "warning"` on upstream EOL so it can never hold the non-dismissible sidebar alert open for months; `below_minimum` is uncapped and does reach it.
- **"Below our target" is not "nearing end of life", and the card must not say it is.** `aging` means the EOL clock is inside 180 days; `behind_target` means supported, not near its end, but below `polarisTarget`. Same `watch` severity, so alerting is identical — but the labels differ ("Aging" vs "Behind target") because an operator read "Aging" on a Java 17 with 386 days left as work that was due. Related dataset rule: do NOT set `polarisTarget` above the minimum without an operational reason. Java briefly targeted 21 for no reason beyond 21 being newer, which made every healthy install report a behind-target Java forever.
- **Every lifecycle reason shares `family: "platform_lifecycle"`.** `collapseReasonsByFamily()` therefore yields ONE capacity row, with the suppressed rows' suggestions merged onto it, and the per-component breakdown stays on the card. The cost is that one row understates breadth, which is why the winning message appends "+N other platform components need attention" — the collapse pass merges suggestions but not messages.
- **`watch`-severity rows never reach the capacity snapshot at all.** "Node 20 goes end-of-life in five months" is real but not yet actionable, and a capacity row would fire a severity-transition Event on every restart. That is the noise that teaches operators to ignore the channel.
- `lifecycleReasonsSafe()` in capacityService wraps the whole thing: a lifecycle failure must never take the capacity snapshot with it, because the snapshot drives the sidebar disk alert, which is the more urgent of the two signals.
- **No table, and that is deliberate.** The observed stack is derived on every read and the dataset is a committed file, so a table would cache something already free. The only state that must survive a restart is "what did we last tell the operator", which is one `Setting` row (`platformLifecycle.lastState`) holding `{severity, fingerprint, recordedAt}` — the same solution `recordCapacityTransition` uses. Every history question a samples table would answer is already answered better by the Event stream, which carries the full component list and already archives to syslog/SFTP.
- **Transitions fire on a change of severity OR fingerprint.** Severity alone would let an install already at `warning` for one component silently absorb a second component going EOL — same severity, no Event, nobody told.
- **Two Event actions, not one.** `resetEventSchema` accepts only `actionPattern` and `resourceType` (no `detailsMatch`), so a single-action design would have the seeded automation's event-mode reset match its own escalation and self-clear immediately — which is exactly why the capacity rule settled for a timed reset. Emitting `platform.lifecycle_recovered` costs nothing and lets the automation genuinely clear when the operator finishes the upgrade.
- **`recordPlatformLifecycleTransition` is called ONLY by the daily job**, never by the route. See the route's own note.

**When changing this:**
- Adding a probe: give it its own try/catch, decide honestly between `absent` and `error`, and confirm the whole thing still resolves with that probe throwing.
- Adding a technology: it needs a dataset entry, a probe reporting under the same `id`, an inventory row and a checker family — see `polaris-tech-lifecycle` → eol-dataset.md.
- Anything that adds a query here needs the 2000-asset check; this runs on a schedule.
- Changing a severity or the cap changes what an operator gets woken for. Re-read the reasoning in `utils/platformLifecycleGrade.ts` before moving `capacitySeverityCap`.
- Real-host validation is not optional for the exec probes: the systemd unit's hardening, SELinux, `/etc/os-release` in-container versus on-host, and Windows all behave differently from a dev box.

## services/nginxApplyService.ts

**What it owns:** Orchestrator that combines config persistence, rendering, the privileged sysadmin wrapper, and cert-info invalidation into the operator-facing operations: apply config, rotate cert, bootstrap, and report drift.

**Public API:** `applyProxyConfig`, `rotateCertAndKey`, `preflightCertRotation`, `bootstrapProxyConfig`, `getDriftStatus`

**Cross-service deps:** `nginxRenderer.renderNginxConfig`, `nginxConfigParser.parseNginxConfig`, `privilegedSysadmin` (stage + apply + wrapper-available), `proxyConfigService` (get/save/row-exists), `certInfo` (invalidate + fingerprint), `apiDocsAccessService` (`getApiDocsSettings` + `deriveApiDocsNginxAllow` — the /api docs allow block renders from that Setting, not proxyConfig).

**Used by:** `src/api/routes/proxySettings.ts` (apply / rotate-cert), `src/jobs/bootstrapProxyConfig.ts` (startup bootstrap), `src/api/routes/serverSettings.ts` (`PUT /server-settings/api-docs` best-effort re-apply — guarded on proxy mode + wrapper + managedMode + no drift, never failing the docs-scope save).

**Invariants:**
- Cert-pair validation is SPKI-only and happens before any graceful-reload attempt; the privileged wrapper owns the atomic rename + `nginx -t` + reload.
- The rendered config's SHA-256 is matched against `lastAppliedHash` for drift; `preflightCertRotation` is validation-only (touches no disk).
- `managedMode=false` blocks apply and surfaces the adopt-required flow.

**When changing this:**
- Hash computation must be byte-for-byte identical across platforms (CRLF normalization in the renderer).

---

## services/nginxConfigParser.ts

**What it owns:** Best-effort regex parse of the six operator-settable directives from a live nginx config; used at bootstrap to seed `proxyConfig` and to detect customization beyond those six (drift markers). Deliberately does NOT parse the /api docs block's allow-list — `apiDocsConfig` is app-authoritative and never seeded from nginx.

**Public API:** `parseNginxConfig`, `parseNginxConfigText`

**Cross-service deps:** none (proxyConfig types only).

**Used by:** `src/services/nginxApplyService.ts` (bootstrap + drift status), `tests/unit/nginxConfigParser.test.ts`.

**Invariants:**
- Whole-line comments are stripped before matching so comment text doesn't trip drift detection; drift reports unknown `proxy_pass` targets, unknown `add_header` keys, or a location-block count ≠ `EXPECTED_LOCATION_BLOCKS` (9).
- Missing file returns defaults with `managedMode=false`; `KNOWN_PROXY_PASS_PATTERNS` + `KNOWN_ADD_HEADERS` define the template's expected schema.
- `allow` lines are collected ONLY from `/metrics*` location blocks (`extractLocationBlocks`, brace-matched) — a file-global scan would merge the /api block's RFC1918 allows into `prometheusAllowIps` at bootstrap, silently widening the metrics allow-list. `tests/unit/nginxConfigParser.test.ts` pins this.

**When changing this:**
- Update the KNOWN_* sets in lockstep with the nginx template, and keep regexes tight to avoid false-positive drift.
- Any new location block carrying its own `allow` lines must keep the metrics-scoped collection honest — see cross-cutting/deployment's location-count rule.

---

## services/nginxRenderer.ts

**What it owns:** Renders `proxyConfig` + env-derived values + the API-docs allow posture into a complete nginx server config (from `deploy/nginx/polaris.conf.template`), with a deterministic SHA-256 so the updater and apply service can detect drift.

**Public API:** `renderNginxConfig`, `RenderInput`

**Cross-service deps:** none (reads the on-disk template at runtime; the `apiDocsAllow` input is COMPUTED BY CALLERS via `apiDocsAccessService.deriveApiDocsNginxAllow` so the renderer stays I/O-free and deterministic).

**Used by:** `src/services/nginxApplyService.ts` (apply + drift status), `src/services/updateService.ts` (restart-time re-render), `tests/unit/nginxRenderer.test.ts`.

**Invariants:**
- Rendered bytes are identical for a given input (deterministic hash — no timestamps/random); CRLF is normalized at read time so Windows checkouts match Linux renders.
- Placeholders are `{{TOKEN}}` substituted by split/join (never regex); togglable directives are whole-line replacements.
- `RenderInput.apiDocsAllow` is REQUIRED so the compiler finds every call site — a new render caller that forgets it would ship a template with an unsubstituted `{{API_DOCS_ALLOW_BLOCK}}`. Disabled renders as `deny all;` alone (off means off at the edge too).

**When changing this:**
- Verify the template path resolves in both `src/` (tsx dev) and `dist/` (tsc prod) layouts; substitution token names must match the template exactly.

---

## services/haService.ts

**What it owns:** the `ha.config` Setting and everything the High Availability tab reads — the three nodes and their cluster addresses, the witness placement, the etcd certificate authority, Patroni's four credentials plus the etcd cluster token, the two file-sync keypairs, and the load-balancer figures used to estimate downtime. Also assembles the guidance card (`computeAdvisories`) and reads live cluster state from the local Patroni.

**Public API:** `getHaConfig`, `invalidateHaConfigCache`, `redactHaConfig`, `enableHa`, `disableHa`, `computeAdvisories`, `getClusterStatus`, `issueEtcdCert`, `detectLocalAddresses`, `measureRtt`, `HA_CONFIG_KEY`, `DEFAULT_TTL_SEC`, `SYNC_KEYGEN_ATTEMPTS`, and the `HaConfig` / `HaNode` / `HaRole` / `HaClusterStatus` / `HaAdvisories` types.

**Cross-service deps:** `settingsStore` (10s TTL), `haHeartbeatService` (`WAL_SAMPLES_KEY`), `utils/haAdvisories` (all the arithmetic), `utils/dbConnections`, `utils/proxyMode`, `utils/publicUrl`, `prisma` for `pg_database_size` / `pg_stat_replication` / `current_setting`. Shells out to `openssl` for the CA and member certificates, and to `id` / `rpm` / `chronyc` for host facts. Read by `haEnrollmentService`.

**Used by:** `src/api/routes/ha.ts` (every operator route), `haEnrollmentService` (config + `issueEtcdCert` when building a bundle).

**Invariants:**
- **The secret leaf names are the contract, not decoration.** `Setting.value` sealing walks the blob recursively and matches on the KEY name, so credentials are stored as `{ password }`, keys as `{ privateKey }` and the etcd token as `{ token }`. Renaming any of those to something more descriptive silently stores it in plaintext. This is why nothing was added to `SECRET_CONFIG_KEYS`.
- **`redactHaConfig` is the only shape that may reach a response.** It reports presence flags, never values. An integration test asserts no `privateKey` and no PEM header appears in `GET /ha/status`.
- **Re-enabling never rotates anything.** `enableHa` keeps existing credentials, CA and sync keys, because a node already holds certificates signed by them; re-running Enable to fix a typo in an address must not invalidate the cluster.
- **`getClusterStatus` is tolerant by design.** Before adoption there is no Patroni at all, and the tab has to render its build instructions in exactly that state — so an unreachable API is `available: false` with a reason, never a thrown error. It accepts both `master` (Patroni 3.x) and `primary` (4.x) as the leader role rather than pinning a version.
- **`automaticFailover` is only true when no replica carries `nofailover`.** That tag is how the standby ships, and removing it is the deliberate act that arms failover after a rehearsal.
- **Advisories answer "unknown" rather than guessing.** Every probe is best-effort (the DB role may lack `pg_read_all_settings`, `rpm` may be absent), and a figure that could not be measured must read as unmeasured — a confident green tick that quietly meant "probably" is worse than a blank.
- **`generateSyncKeypair` retries.** ssh2's ed25519 generator intermittently emits a private key its own parser rejects (about one attempt in three on Node 20+); without the loop, one Enable in three would 500 after having already created the CA. The same bug is why `windowsSshOnboardingService.generateKeypair` retries — fix them together.

**When changing this:** adding a config field means deciding first whether it is a secret, and if so naming its leaf `password` / `privateKey` / `token`; then `redactHaConfig`, the rendered output in `haEnrollmentService`, and the `ha.config` entry in `polaris-domain-model` → platform.md. Changing `DEFAULT_TTL_SEC` changes both the downtime estimate and the Patroni template — they must move together, and docs/HA.md quotes the number to operators.

---

## services/haEnrollmentService.ts

**What it owns:** how a node joins the cluster — token minting, the pending/approve/deliver ladder, the node bundle, the bootstrap script and the teardown script. The only service reachable (in part) without a session.

**Public API:** `mintNodeToken`, `registerEnrollment`, `pollEnrollment`, `listEnrollments`, `approveEnrollment`, `rejectEnrollment`, `claimBundle`, `buildNodeBundle`, `renderNodeScript`, `renderTeardownScript`, `TOKEN_TTL_MS`, `APPROVAL_WINDOW_MS`.

**Cross-service deps:** `haService` (config + `issueEtcdCert`), `certInfo` (`getServerCertFingerprint` for the script's pin), `utils/password` (argon2id), `utils/bearerToken` (the `polaris_<32>` format), `utils/tarWriter`, `utils/paths` (`ENV_FILE`), `utils/publicUrl`, `node:zlib`.

**Used by:** `src/api/routes/ha.ts` — `haRouter` for minting and approval, `haEnrollRouter` for the three unauthenticated node calls.

**Invariants:**
- **A token buys the right to ASK, never the bundle.** Registration records the source address and the SSH host keys presented and stops at `pending`; only an operator moves it to `approved`. This is the entire security model: a bundle contains `.env` (the key that decrypts every credential), the nginx private key and the database passwords, so a leaked script must surface as a request a human can reject.
- **The token is spent at registration, before approval.** A second attempt with the same token is refused, and the attempt is itself visible. Claiming is a conditional `updateMany` on `status`, so two simultaneous registrations cannot both win.
- **The bundle downloads exactly once.** `claimBundle` flips `approved` → `delivered` with a conditional update BEFORE building the archive. A build failure therefore burns the approval and the operator re-approves — the right way round, since a second copy of a bundle full of private keys is worse than a repeated click.
- **The witness bundle carries etcd material only.** No `.env`, no nginx key, no database credentials. A vote does not need to be able to impersonate the application.
- **Every rejection on the unauthenticated surface returns identical text.** A caller must not be able to tell "no such token" from "expired" from "already used".
- **The script carries the token and nothing else sensitive.** Asserted in `tests/unit/haEnrollmentService.test.ts` against every credential in the config. It pins the nginx leaf (`--pinnedpubkey`) and forces the route (`--resolve`) so a private-address install needs no second certificate and DNS is not trusted.
- **A database node's bundle refuses to build without `POLARIS_PROXY_CERT_PATH`.** The standby must serve the identical leaf agents pin, so a bundle without it would build a node the whole fleet rejects.

**When changing this:** anything added to a bundle needs the witness exclusion re-checked (does a vote need it?) and `renderBundleReadme` updated, since that file is what the operator reads on the node. Changing the script's flow means changing the poll strings it greps for (`"ready":true`, `rejected`, `expired`, `delivered`) in lockstep with `pollEnrollment`. New file paths in a bundle must stay under 99 bytes — `tarWriter` refuses longer names rather than truncating them.

---

## services/haHeartbeatService.ts

**What it owns:** The active-instance heartbeat and the WAL-rate ring behind the active/standby HA deployment (docs/HA.md). Two Setting rows: `ha.activeInstance` = `{hostname, pid, at}`, re-stamped every 30s by the scheduler role, and `ha.walSamples` = a 288-entry (24h, one per 5 min) ring of `pg_current_wal_lsn()` readings used to size the WAN link, `max_slot_wal_keep_size` and `maximum_lag_on_failover` BEFORE anyone enables HA.

**Public API:** `evaluateHeartbeat` (pure), `checkActiveInstanceConflict`, `stampActiveInstance`, `readActiveInstance`, `appendWalSample`, `isHeartbeatEnabled`, `ACTIVE_INSTANCE_KEY`, `WAL_SAMPLES_KEY`, `HEARTBEAT_INTERVAL_MS`, `CONFLICT_WINDOW_MS`, `WAL_SAMPLE_EVERY_TICKS`, `WAL_SAMPLE_RING_SIZE`, `ActiveInstanceStamp`, `WalSample`, `HeartbeatVerdict`.

**Cross-service deps:** `prisma` (settings), `src/utils/dbConnections.ts` (`getDirectDatabaseUrl` gates the WAL read), `node:os`. No other service.

**Used by:** `src/jobs/activeInstanceHeartbeat.ts` (the 30s tick, scheduler role only), `src/app.ts` (boot guard before `listen()`, gated on `cfg.runsSchedulers`; increments `polaris_ha_active_instance_conflict_total` and exits 1 on a conflict).

**Invariants:**
- **The asymmetry is the whole design.** A FOREIGN stamp younger than `CONFLICT_WINDOW_MS` blocks a boot; this host's OWN stamp never does, whatever its age. Without that exception a systemd restart mid-tick would leave the app permanently refusing to start.
- **Not a lock.** A stale stamp expires (90s = three missed writes), so a legitimate failover is delayed by at most one systemd restart, never blocked. Do not add waiting, retrying-until-clear, or a longer window without re-reading why: this is the LAST guard, behind the Patroni lease, the systemd `ExecStartPre` role check, and `DATABASE_URL=localhost` on both nodes. It exists only for two hosts pointed at ONE database.
- **Falls open on anything it cannot parse.** A malformed stamp, an unparseable timestamp or a read error are all "no conflict" — a corrupt bookkeeping row must never be able to wedge the app, and the schema sanity check already fails loudly on a genuinely unusable database.
- A future-dated foreign stamp (peer clock skew) counts as LIVE. Erring toward "someone else is running" is the safe direction.
- Production only (`isHeartbeatEnabled`), so dev and the test suite never trip on it; `POLARIS_HA_HEARTBEAT=off` is the documented escape hatch.
- `appendWalSample` is advisory: it logs at debug and returns null when the role lacks WAL introspection or the query fails. Nothing depends on it to run.

**When changing this:** the window arithmetic is asserted in `tests/unit/haHeartbeatService.test.ts` (`CONFLICT_WINDOW_MS / HEARTBEAT_INTERVAL_MS === 3`, ring = 24h) — change the constants and those assertions together, and update docs/HA.md §5, which states the 30s/90s numbers to operators. If the stamp ever gains a reader beyond the boot guard (an HA status card, for example), state whether that reader tolerates a stale row before relying on it.

---

## services/settingsStore.ts

**What it owns:** The generic TTL-cached accessor for JSON-blob Setting rows — `createSettingStore<T>({key, ttlMs, parse})` returning `{get, peek, save, invalidate}`. The store owns the read cache, the row I/O, and cache priming on save; callers keep their parse (defaults merge) and write-side validation/merge rules.

**Public API:** `createSettingStore`, `SettingStore<T>`.

**Cross-service deps:** `prisma` (settings) only.

**Used by:** `azureAuthService` (key `sso`; `peek` backs the synchronous `isAzureSsoConfigured` fast path), `entraProxyAuthService` (key `entraProxy`), `dashSettingsService` (key `dashConfig`, 10s TTL = the cross-process propagation delay to the dash listener). Other Setting-blob sites still hand-roll the pattern — migrate them onto this as they're touched.

**Invariants:**
- The cache is per-process, exactly like the hand-rolled copies it replaced — a write in one role propagates to other roles only after their ttlMs expires. Don't shorten a TTL without checking what read frequency it implies (dash consults its store on every request).
- `save` primes the cache with the written value (it does not invalidate) — callers that need a post-save DB re-read must call `invalidate()` themselves.
- `parse` runs on every cache miss and must be total (handle `undefined` = missing row).

**When changing this:** anything altering cache semantics changes every adopter at once — check each adopter's TTL expectation (auth gates, the dash listener's per-request read) before touching expiry behavior.

---

## services/dashSettingsService.ts

**What it owns:** Persistence of the Dash wallboard operator config — the `dashConfig` Setting row `{ enabled (default false), ipScope ("rfc1918"|"all"|"custom", default "rfc1918"), allowedCidrs (canonical IPv4 CIDRs for the custom scope) }` — with a ~10s TTL in-process cache. The TTL is the **cross-process propagation delay**: the web process writes the row (Server Settings → Web Server → Dash Wallboard), the dash process (`POLARIS_ROLE=dash`) reads it on every request through the cache, so a toggle lands within ~10s with no restart.

**Public API:** `getDashSettings`, `saveDashSettings`, `invalidateDashSettingsCache`, `defaultDashSettings`, `DASH_SETTING_KEY`, `DashSettings`, `DashIpScope`

**Cross-service deps:** `src/utils/cidr.ts` (`normalizeAllowlistCidr`), `AppError` (prisma otherwise).

**Used by:** `src/dash/dashServer.ts` (per-request kill-switch + `isSourceAllowed` scope decision), `src/api/routes/serverSettings.ts` (`GET/PUT /server-settings/dash`).

**Invariants:**
- `enabled` defaults FALSE — a new unauthenticated surface must never silently appear on upgrade; the operator flips it on once.
- Parsing is tolerant: a garbage/wrong-typed row falls back per-field to the safe defaults (never throws on read); a legacy `rfc1918Only` boolean migrates to `ipScope` (true→rfc1918, false→all). Invalid stored CIDRs are dropped on parse.
- `saveDashSettings` validates + normalizes custom CIDRs (throws 400 on an invalid entry) and REJECTS an enabled+custom+empty list (would lock every viewer out). Disabling is the way to turn the surface off.
- Writes invalidate the cache synchronously in the writing process; the OTHER process converges via TTL expiry — don't assume immediate cross-process visibility.

**When changing this:**
- New fields need a default + tolerant parse + merge handling, AND the Web-Server-tab card (`public/js/server-settings.js` `dashCardHtml`/`handleDashSave`) + the `PUT /server-settings/dash` Zod schema updated in lockstep.
- Don't lengthen the TTL casually — it's the operator-visible latency of the kill-switch.
- The gate DROPS unauthorized sources (socket destroy in dashServer, not a 403) — keep that stealth posture in mind when touching the scope decision.

---

## services/dashRoleSnapshotService.ts

**What it owns:** The Dash wallboard's permission identity: loads the seeded built-in `readonly` Role and materializes it via `snapshotFromRole()` (60s TTL cache) so `dashServer` can stamp `req.roleSnapshot` and every existing `requirePermission` / `hasPermission` / `ensureRoleSnapshot` gate resolves the anonymous caller as a readonly user with zero changes to `permissions.ts`.

**Public API:** `getReadonlyRoleIdentity` (→ `{ snapshot, regionTags }`), `invalidateDashRoleSnapshotCache`, `DashRoleIdentity`

**Cross-service deps:** `src/api/middleware/permissions.ts` (`snapshotFromRole`, `SessionRoleSnapshot`).

**Used by:** `src/dash/dashServer.ts` (snapshot injector middleware + the synthetic `GET /dash/api/v1/auth/me`).

**Invariants:**
- The `readonly` role is `isProtected` (uneditable), so the 60s TTL is defense-in-depth, not a freshness requirement.
- Missing `readonly` row ⇒ AppError 500 ("mis-seeded") — never a silent empty-permission fallback.
- `resolveSnapshot()` in permissions.ts returns `req.roleSnapshot` when already set — that contract is what makes injection work; if permissions.ts ever stops short-circuiting on a pre-set `req.roleSnapshot`, the whole Dash permission model breaks.

**When changing this:**
- If Dash ever becomes role-configurable (not hardcoded `readonly`), route the choice through dashSettingsService and keep the snapshot provider injectable (dashServer's `identityProvider` test seam).

---

## services/proxyConfigService.ts

**What it owns:** Persistence + validation of the operator-settable `proxyConfig` (single Setting row) with a short-TTL in-process cache — httpsPort, TLS protocols, HTTP/3 toggle, HSTS, Prometheus allow-list, and `managedMode`.

**Public API:** `getProxyConfig`, `proxyConfigRowExists`, `saveProxyConfig`, `invalidateProxyConfigCache`

**Cross-service deps:** none (prisma, proxyConfig types, AppError).

**Used by:** `src/services/nginxApplyService.ts` (apply / bootstrap / drift), `src/api/routes/proxySettings.ts`.

**Invariants:**
- Single cached row per process with a short TTL; `invalidateProxyConfigCache()` clears it synchronously and writes always invalidate.
- Validation: httpsPort 1–65535, TLS protocols a non-empty subset of {TLSv1.2, TLSv1.3}, HTTP/3 requires TLSv1.3, allow-list entries parse as IPs; partial updates merge into current state.

**When changing this:**
- Port/IP/protocol validation is security-relevant; new fields need defaults + merge/validate handling. Don't change the Setting key without a migration.

---

## services/privilegedSysadmin.ts

**What it owns:** Thin TypeScript wrapper around the `sudo /usr/local/sbin/polaris-nginx-apply` shell script — stages files into the run dir and spawns the privileged wrapper with bounded output capture. The wrapper (not this module) is the entire privileged surface.

**Public API:** `NginxApplySubcommand`, `WrapperResult`, `runNginxApply`, `stageNginxConfig`, `stageCertAndKey`, `isWrapperAvailable`

**Cross-service deps:** none (node spawn/fs, AppError, logger).

**Used by:** `src/services/nginxApplyService.ts` (config apply + cert rotation).

**Invariants:**
- All subcommand/arg validation lives in the shell script — this module only stages files + spawns; captured output is size-capped with a truncation flag.
- Stage dir/files are written with restrictive modes; `ensureStageDir` is a defensive fallback when systemd-tmpfiles didn't run.

**When changing this:**
- `isWrapperAvailable()` lets route handlers short-circuit on dev boxes that lack the wrapper.

---

## services/queueService.ts

**What it owns:** Monitor work queue mode dispatch (cursor vs. pg-boss) and pg-boss runtime lifecycle. Boot-time mode capture ensures the running process's queue strategy is frozen at startup despite subsequent Setting writes.

**Public API:** `detectPgboss`, `isPgbossInstalled`, `getQueueMode`, `setQueueMode`, `getBootTimeMode`, `initializeQueue`, `startPgbossWorkers`, `stopPgbossWorkers`, `isPgbossRunning`, `publishMonitorJob`, `QUEUE_NAMES`, `QueueMode`.

**Cross-service deps:** `monitoringService.ts`.

**Used by:** `src/app.ts` — queue initialization and pg-boss worker lifecycle; `src/jobs/monitorAssets.ts` — queue mode dispatch and job publishing; `src/api/routes/serverSettings.ts` — queue mode write; `src/services/capacityService.ts` — capacity snapshot input (queue mode + pg-boss status).

**Invariants:**
- **Boot-time mode capture:** mode read once at startup into `bootTimeMode`; `setQueueMode()` updates Setting + cache but never affects running process. New mode takes effect on next restart only.
- **Six queue names (Phase 2):** `polaris-monitor-probe`, `polaris-monitor-fastfiltered`, `polaris-monitor-telemetry`, `polaris-monitor-systeminfo`, `polaris-monitor-lldp`, `polaris-monitor-storage` (jobs prefixed `polaris-monitor-*`). LLDP and Storage each get their own dedicated worker pool (default 12 workers, env `POLARIS_MONITOR_LLDP_WORKERS` / `POLARIS_MONITOR_STORAGE_WORKERS`) running `runLldpFor` / `runStorageFor` from monitoringService. Floating priority order: probe > fastFiltered > lldp > storage > telemetry > systemInfo. The publisher in `monitorAssets.ts` gates LLDP/Storage on `Asset.lastLldpAt + lldpIntervalSeconds` / `Asset.lastStorageAt + storageIntervalSeconds`; the legacy `collectSystemInfo` still walks both as session-coalesced side effects on the same SNMP session and the persist paths are idempotent against double-walks.
- **Stalled-worker watchdog:** monitors pgboss.job for >50 created jobs with 0 active; auto-recovers up to 3 times per hour; logs every minute after cap hit.
- **Singleton job policy:** queues are created with `policy: "singleton"` + `singletonKey: ${assetId}:${cadence}` on publish so duplicate `(assetId, cadence)` sends are absorbed while a job is queued or active. `publishDueWork()` can fire every tick without piling stale work, and distinct assetIds run in parallel up to `localConcurrency`. (An earlier iteration passed `policy: "exclusive"` here, which is not a documented pg-boss policy and silently capped each queue to ~1 active job globally regardless of `localConcurrency` — turning a 16-worker pool into a serial consumer and diluting effective probe/telemetry cadence by 10×+ on large fleets. If you see queue depth sustained in the hundreds with active count stuck at 1-2, check this value first.)
- **Two pools per queue:** dedicated `boss.work()` subscriptions own a flat 24 slots per queue (env `POLARIS_MONITOR_PROBE_WORKERS` / `_FAST_WORKERS` / `_HEAVY_WORKERS`); a single floating loop (`startFloatingWorkers`, default 32 via `POLARIS_MONITOR_FLOATING_WORKERS`) polls all four queues in `FLOAT_PRIORITY` order via `boss.fetch()` and dispatches manually with `boss.complete(name, id)` / `boss.fail(name, id, ...)`. Floating capacity flows to whichever queue has backlog. Singleton-key dedup at the publish layer prevents floating ↔ dedicated collisions on the same `(assetId, cadence)`. The loop is shut down via `floatingLoopRunning = false` in both `stopPgbossWorkers` and the auto-recovery path BEFORE calling `boss.stop()` so it doesn't try to fetch against a dead boss instance.
- **Per-queue handler timeout (`EXPIRE_BY_QUEUE`):** pg-boss kills handlers that exceed `expireInSeconds` with `handler execution exceeded Ns` and marks them failed before the in-handler try/catch can stamp an error. The values are sized per cadence to the worst-case real work — probe 30s (single network call), fastFiltered 60s (one collector round-trip), telemetry 180s (SNMP CPU/mem/sensor walks), systemInfo 300s (full interface + storage + IPsec + LLDP walk). A uniform 60s cap was killing telemetry/systemInfo jobs mid-walk on slow SNMP devices, producing queue backlog that workers couldn't drain (every kill re-published the job on the next tick, looking like worker shortage when actually each slot was burning 60s per zombie). Raising the cap doesn't add parallelism — it reduces it by letting slow jobs finish on the first attempt instead of cycling through worker slots.
- **Discovery queue payload:** `DiscoveryJobPayload` is `{ integrationId, actor, scopeDeviceName? }` — the optional third field is the single-FortiGate scoped re-discovery (threaded `publishDiscoveryJob(id, actor, scope?)` → consumer → `DiscoveryJobHandler(id, actor, scope?)` → `runDiscovery`). `singletonKey` stays `integrationId` regardless of scope: a scoped run and a full run for the same integration must coalesce, never run concurrently (they'd double-write the same device's rows).

**When changing this:**
- Verify boot initialization runs before monitor ticks fire (happens in `app.ts` startup order).
- If tuning worker counts, check `POLARIS_MONITOR_*_WORKERS` env vars align with concurrency in `monitorAssets.ts`.
- Test pg-boss fallback to cursor when extension/role permissions fail silently.
- Ensure graceful pg-boss shutdown on SIGTERM drains in-flight jobs before process exit.

---

## services/serverSettingsService.ts

**What it owns:** Server-wide configuration: NTP (servers, timezone) and CA certificate management (upload, list, delete). Server-leaf certs are managed externally (nginx reads `POLARIS_PROXY_CERT_PATH`).

**Public API:** `getNtpSettings`, `updateNtpSettings`, `testNtpSync`, `listCertificates`, `addCertificate`, `deleteCertificate`.

**Cross-service deps:** none.

**Used by:** `src/api/routes/serverSettings.ts — CA upload/list/delete + NTP settings`. Server-cert mutation routes (`POST /certificates` category=server, `DELETE` of a server cert) return 409 unconditionally — handled directly in the route handler, doesn't reach the service.

**Invariants:**
- NTP and certificate lists persist in Settings table under `key: "ntp"` and `"certificates"`.
- Certificate store is a single JSON array in the "certificates" Setting; each cert carries id, category (ca/server), type (cert/key), PEM, and metadata. The route surface only handles `category="ca"`; the cleanup migration `20260608000000_drop_legacy_server_certs` strips any legacy `category="server"` entries on upgrade.
- Backup/restore flows NOT in this service (they live in updateService).

**When changing this:**
- Test CA upload validation (PEM parsing, magic-byte checks if added).
- Confirm cert list dedup handles UUID collisions.

---

## services/updateService.ts

**What it owns:** In-app software update check, availability detection (Docker vs git checkout), update application pipeline (backup→pull→npm ci→prisma generate→tsc→migrate→restart), and progress tracking.

**Public API:** `initUpdateStatus`, `getUpdateStatus`, `isUpdateMechanismAvailable`, `clearUpdateStatus`, `checkForUpdates`, `applyUpdate`, `getRecentCommits`, `restartService`, plus the two pure shell-safety predicates `isSafeGitRef` / `isSafeRepoUrl` (exported for tests/unit/updateTrain.test.ts) and the test seams `_setExecRunnerForTests` / `_resetApplyingForTests` / `_setRunningCommitForTests` (tests/unit/updatePipeline.test.ts).

**Cross-service deps:** `services/backupService.ts` (`createBackup` for the pre-update dump), `services/eventLogService.ts` (the `server.update.*` audit trail). Spawns git / npm / the project's own Prisma CLI by path (`PRISMA_CLI`, never `npx`), reads/writes `.update-status.json`.

**Used by:** `src/api/routes/serverSettings.ts,1143,1151,1159 — Application Updates card endpoints`; `src/api/routes/serverSettings.ts — POST /restart` (Capacity Advisor "Restart Polaris to apply" button uses `restartService` standalone, without the update pipeline); `src/jobs/updateCheck.ts,31 — hourly check job`. ~7 call sites.

**Invariants:**
- **Everything in this file shells out through `execAsync`, which runs a SHELL — so any value interpolated into a command is an injection site, and the refs here are NOT ours.** `latestReleaseTag()` reads tag names out of the update repository, and `POLARIS_UPDATE_REPO` exists so that repository can be a fork or an internal mirror; `resolveDefaultBranch()` reads a branch name the remote chose via `origin/HEAD`. Git's own `check-ref-format` permits `;`, `&`, `|`, `$`, a backtick and both quote characters in a ref, so a tag named ``v1.0.0`id` `` was legal, and it reached `git checkout --detach <tag>` on the highest-blast-radius path in the repo. **Quoting is not the fix** — `$(…)` and backticks expand inside double quotes on /bin/sh, which is what the `"${desired}"` around the repo URL made look safe. `isSafeGitRef()` (allowlisted charset, no `..`, which would also re-point the `HEAD..<ref>` range reads) and `isSafeRepoUrl()` gate the three sources: an unsafe tag is skipped for the next-highest, an unsafe default branch falls back to main/master, an unsafe `POLARIS_UPDATE_REPO` is ignored in favour of the existing origin. All three log an error — silently returning null reads to an operator as "no releases yet". **Validate at the source, so every downstream interpolation is safe by construction**; adding a new git shell-out means asking where its ref came from.
- **`checkForUpdates()` measures against the RUNNING build, not the checkout's HEAD.** `computeTargetInfo()` takes "current" from `utils/version.ts → getRunningCommit()` (HEAD's SHA captured when the process booted; falls back to HEAD when unknown, e.g. Docker) and reports the checkout's own HEAD separately as `checkoutCommit`. The pipeline pulls BEFORE it installs, builds and restarts, so an update that fails after the pull leaves HEAD ahead of the process serving requests — compared to HEAD that host read "up to date" with no Apply button while the old build kept running (prod, 2026-09-10, after the TLS-inspection failure at step 3). When `checkoutCommit !== currentCommit` the status carries a `note` saying the code is already on disk and Apply finishes the work; `renderUpdateAvailable` shows it. The boot SHA is interpolated into `git rev-list <sha>..<ref>`, so `runningCommit()` only returns a plain hex string — same posture as `isSafeGitRef`. Pinned by `tests/unit/updatePipeline.test.ts` ("measures against the RUNNING commit").
- Update mechanism disabled in Docker (`/.dockerenv` present, `.git/` absent) or when no `.git/` checkout exists; `getUpdateStatus()` returns `state: "disabled"` with a human-readable reason.
- Status persists in `.update-status.json` at APP_DIR root; survives restarts.
- applyUpdate() runs background; only one apply in flight at a time (`_applying` flag).
- **The pipeline writes an audit trail (since 2026-09-09).** `server.update.started` (actor, train, from/to version + commit, whether proceed-without-backup was confirmed) → either `server.update.failed` (level error; the step name and index, the step's MEASURED duration, the pipeline duration, every step's status + duration) or `server.update.applied` (awaited before the restart timer — the process exits 1.5 s later) → `server.update.completed` from `initUpdateStatus()` on the other side of the restart. `POST /updates/dismiss` writes `server.update.dismissed` with what it cleared. Before this the updater wrote NO Event rows; `.update-status.json` was the only record and Dismiss deleted it, so a prod failure left nothing to answer "how long did the step take" or "has this happened before". The actor comes in as `applyUpdate(password, allowWithoutBackup, actor)` from `requestActor(req)`; the hourly job never applies, only checks.
- **Every step is timed.** `setStep("running")` stamps `startedAt`; done/failed stamp `durationMs`; `elapsed(idx)` feeds `stepFailureDetail(err, { timeoutMs, elapsedMs })`, so a timeout message reads "timed out after 47s (limit 45s)" — the clock, with the constant beside it — instead of asserting the constant. Both fields are additive on the `steps[]` items; the UI readers (`renderSteps`, `renderUpdateFailed`, the sidebar panel) use name/status/message only.
- Backup is optional (skippable via Setting "update.skip_backup"); pre-update backups registered in "backup_history" Setting.
- Encryption: backup password → AES-256-GCM ciphertext wrapped in `[POLARIS\0][salt][iv][authTag][ct]` envelope.
- **Seven-step pipeline (order is load-bearing):** (1) backup, (2) git pull, (3) **`npm ping` then `npm ci --include=dev`**, (4) **explicit `prisma generate` through the project's own CLI by path (`PRISMA_CLI` = `node node_modules/prisma/build/index.js`, never `npx prisma` — see `cross-cutting/schema-migrations-and-prisma-client-lifecycle`)**, (5) **clean `dist/` then `npm run build`** (= `tsc` + the post-tsc asset copy in `scripts/copy-build-assets.mjs`; never bare `npx tsc`, or the bundled std MIB `.txt` files never reach `dist/` and std SNMP-walks break), (6) `npx prisma migrate deploy`, (7) restart (NSSM on Windows, systemd exit(1) on Linux). Steps 4 + 5's `rm -rf dist` are defenses against the failure mode in `cross-cutting/schema-migrations-and-prisma-client-lifecycle` — never collapse them back into "trust npm ci postinstall."
- **Step 3 pings the registry BEFORE `npm ci`, and that ordering is a fix rather than a nicety.** `npm ci` deletes `node_modules` and only then discovers it cannot reach the registry, so an unreachable registry turns a healthy host into one that must not be restarted — which is exactly what a TLS-inspecting proxy did on 2026-09-09 (`UNABLE_TO_GET_ISSUER_CERT_LOCALLY`, because Node ignores the OS trust store; see `polaris-deploy` → env-vars.md `NODE_EXTRA_CA_CERTS`). On preflight failure the step fails with `node_modules` untouched and says the host is safe to restart, which is the operator's most important question. `npm ping` and not a fetch from this process: it goes through npm's own config, so it exercises the same registry URL, proxy and cafile that `npm ci` is about to use. Known trade-off, recorded in the code: an install whose cache already satisfies the whole lockfile could have completed offline and is now refused — whether the cache can satisfy the lockfile is not knowable cheaply, so this trades an occasional refused update for never leaving a host that cannot boot. **The ping is `npm ping --fetch-retries=0 --fetch-timeout=15000`, tried twice 3 s apart, and a 404 counts as reachable.** npm's defaults (5-minute fetch-timeout, 2 retries) are longer than the 45 s ceiling, so on a connection that DROPS the preflight could only ever report "timed out" with nothing of npm's own — which is what prod showed the day the preflight shipped (2026-09-09), on a host whose registry was fine and one connection stalled. Two fast attempts tell a stall from a block; the second attempt is what keeps a blip from failing an update. A 404 means the registry answered (Nexus/Artifactory/Verdaccio mirrors do not all serve `/-/ping`) and must not block an install `npm ci` would complete. The failure message branches on `isTimeoutKill`: a hang gets "a hang, not a refusal" and the firewall/proxy/DNS causes with the exact command to reproduce; a fast error gets the TLS/NODE_EXTRA_CA_CERTS list. Neither gets `npm ci`'s warm-cache re-run advice — `stepFailureDetail(err, { retryAdvice })` exists so a step with different economics can say its own.
- **`--include=dev`, not `--production=false`.** Production sets `NODE_ENV=production`, which makes npm omit devDependencies, and the build needs TypeScript; both flags clear `omit`, but npm 11 emits a deprecation notice for the second one that lands in the operator's error output and reads like part of the failure.
- **Update source repo is configurable.** `ensureUpdateRemote()` runs before the fetch in `checkForUpdates()` AND before the pull in `applyUpdate()`. When `POLARIS_UPDATE_REPO` (env) is SET it repoints the `origin` remote at that URL (idempotent — only rewrites when the URL differs; `git remote add`s if origin is missing; non-fatal). When UNSET it's a no-op — the install's existing `origin` is left as-is (updates come from wherever it was cloned). `getUpdateRepoInfo()` reports the active repo + source (`"env"` vs `"origin"`) and is exposed at `GET /server-settings/updates/repo` for the Application Updates card's "Update source" row. The two fallback scripts (`deploy/update-linux.sh`, `deploy/update-windows.ps1`) read the same `.env` var and repoint origin only when set, in lockstep — keep all three in sync when changing the env-var name or the set/unset semantics.
- Generate-then-build-then-migrate order matters: client must be generated against the NEW schema BEFORE tsc compiles consumers, and migrations apply LAST so the client and DB are in sync at restart. Reversing any of these breaks the next start of the process.

**When changing this:**
- Test update path on both git-backed and Docker installs; verify "disabled" message is clear.
- Check backup encryption round-trip: verify restored backup is valid SQL.
- The per-step ceilings are named constants (`NPM_CI_TIMEOUT_MS` 15 min — 5 min SIGTERMed a cold-cache install on prod 2026-09-08; `NPM_PING_TIMEOUT_MS` 45 s; generate 2 min; build 5 min; migrate 5 min). A step that overruns is reported as a timeout with its measured duration, never as a command failure. Raise a ceiling rather than removing it.
- If you add a step, give it a `setStep(idx, "running")` before the work (that is what stamps its clock) and a `failUpdate` that names it — the Event trail and the timing are only as complete as the steps that go through those two functions.
- Test git pull fallback chain (origin/HEAD → origin/main → origin/master).
- Verify restart doesn't kill in-flight requests; 1.5s delay before exit(1) should be enough.
- **Do not reorder steps 3–6** without re-reading `cross-cutting/schema-migrations-and-prisma-client-lifecycle`. A reorder that puts migrate before generate-then-tsc reintroduces the failure mode where dropped columns crash the running client.
- The `rm -rf dist` between steps 4 and 5 is non-negotiable when Prisma client file layout could have changed between versions. Without it, stale `dist/generated/prisma/*.js` files can shadow the regenerated client and the running process selects columns the schema no longer has.

---

## services/backupService.ts

**What it owns:** The whole database backup + restore mechanism. Extracted from `src/api/routes/serverSettings.ts` (2026-08) so the routes are thin and the pipeline is testable.

**Public API:** `createBackup({password, kind, actor}) -> {record, path}`, `restoreBackup({filePath, password})`, `listBackups`, `getBackupRecord`, `deleteBackup`, `backupFilePath`, `isEncryptedBackupFile`, `timescaleInstalled`, `resolvePgTool(tool) -> PgToolResolution` (the chosen binary, its major vs the server's, and the operator sentence when it cannot work), `getBackupToolingStatus()` (both tools, for `GET /database/backup-tooling`), plus the format constants `BACKUP_MAGIC` / `ENCRYPTED_HEADER_LEN`.

**Cross-service deps:** `utils/pgEnv.ts` (libpq PG* env), `utils/pgClientTools.ts` (candidate paths by server major, `--version` parsing, the compatibility rule — rule 47), `utils/dbConnections.ts` (`getDirectDatabaseUrl`), `utils/paths.ts` (`BACKUP_DIR`), `utils/version.ts`, `services/eventLogService.ts`. Spawns `pg_dump` / `psql` by the RESOLVED path, never by bare name.

**Used by:** `src/api/routes/serverSettings.ts — POST /database/backup, POST /database/restore, GET /database/backups, DELETE /database/backups/:id, GET /database/backups/:id/download`; `src/services/updateService.ts — the pre-update backup step`; `src/jobs/scheduledBackup.ts — the automatic-backup cadence`. Three writers of `backup_history`, all through this service.

**Invariants:**
- **Nothing is buffered.** `pg_dump` stdout streams through gzip (and the cipher when encrypting) straight to disk, and the route streams the finished file to the client. Peak memory is a few stream watermarks regardless of database size. The pre-2026-08 version did `execSync` + `readFileSync` + `gzipSync` + in-memory cipher + `res.end(payload)` — three copies of a multi-GB dump in the heap, with the event loop blocked for the whole dump.
- **No wall-clock cap.** The old fixed 120 s `execSync` timeout failed a healthy dump the moment the database outgrew two minutes. A dump still emitting bytes is making progress; the watchdog (`NO_OUTPUT_TIMEOUT_MS`, 10 min) kills only a SILENT child.
- **The client is chosen by the server's major and verified before it is spawned (rule 47).** `resolvePgTool(tool)` reads `SHOW server_version_num`, resolves a per-major install dir through `utils/pgClientTools.ts` (newer major accepted, PATH last), runs `--version` on the result and compares. `createBackup` refuses a `pg_dump` older than the server and throws the SPECIFIC sentence — versions, path, fix — as the AppError; `restoreBackup` uses the resolved `psql` and only treats "cannot run it" as fatal (psql restores across majors). `getBackupToolingStatus()` exposes both resolutions for the Maintenance tab. Never reintroduce `spawn("pg_dump")` / `spawn("psql")` by bare name: on 2026-09-09 that resolved to RHEL's AppStream PostgreSQL 13 client in front of a PGDG 15 server, `command -v` and `alternatives --display` both said it was fine, and every backup on prod failed for months behind "see the server log".
- **The connection never appears in argv.** `pg_dump`/`psql` get PGHOST/PGPORT/PGUSER/PGPASSWORD/PGDATABASE from the environment via `pgChildEnv`. Putting the URL on the command line exposed the DB password to `ps aux`, and (because the command was an interpolated shell string) Node's `Command failed: <command>` message was being returned in the HTTP response body. Child-process stderr is logged, never echoed to the caller.
- **Restore is TimescaleDB-aware.** On a database with the extension, restore runs `SELECT timescaledb_pre_restore();` → the dump → `SELECT timescaledb_post_restore();` in THREE SEPARATE psql sessions (pre_restore sets the flag at database level and only affects sessions started afterwards). `post_restore` is in a `finally`: a database left in restoring mode rejects normal hypertable writes, which is worse than the failed restore that caused it. `timescaleInstalled()` fails toward TRUE — running the gates on a non-Timescale DB is a benign, detectable error; skipping them on a Timescale DB corrupts the restore.
- **Every connection is stale after a restore.** `--clean --if-exists` DROPs and recreates every table, so any connection opened before the restore holds cached relation OIDs that no longer exist and fails its next query with `XX000 could not open relation with OID <n>`. `restoreBackup` therefore recycles the pool (`prisma.$disconnect()`) in its `finally` — in the finally, not the success path, because a failure after the inner commit leaves the same situation. That is a MITIGATION, not a cure: a dump from a different schema version also leaves the process with a generated Prisma client that no longer matches the database, which reconnecting cannot fix, and the monitor/discovery roles have their own pools this call cannot touch. Hence `restartRequired: true` on the route response and the restart banner in the UI. Found by actually running the round trip against a real database — the pre-2026-08 code had the same defect and the route reported plain success.
- **File format is a compatibility contract.** `"POLARIS\0" | salt(32) | iv(16) | authTag(16) | AES-256-GCM(gzip(sql))`, unchanged across the rewrite so operators' existing `.enc.gz` files still restore. Pinned by `tests/unit/backupEnvelope.test.ts`.
- A failed backup deletes its partial file — never leave a truncated file masquerading as a usable backup.
- Backup ids are server-generated (`bk-` / `bk-pre-update-` / `bk-scheduled-` + timestamp) but the delete/download routes accept them from the URL, so `backupFilePath` requires containment under `BACKUP_DIR` before any filesystem access.
- History lives in the `backup_history` Setting row, capped at 50 entries. A history-write failure is logged but does NOT fail the backup — the file on disk is valid, only the index entry is missing.

**When changing this:**
- Run `tests/integration/backupRestore.test.ts` on a host with `pg_dump`/`psql` AND the timescaledb extension installed. It skips silently otherwise, so a green local run is not coverage of the Timescale gates — the test logs which branch it took.
- Never reintroduce `readFileSync` / `gzipSync` / `execSync` on this path, and never size a backup with `readFileSync(f).length` (use `statSync(f).size`).
- Every `runPgTool` call passes `binPath` from `resolvePgTool()`. If you add a new client invocation, resolve it the same way and extend `tests/unit/pgClientTools.test.ts` for any new layout; the shell twin is `resolve_pg_tool` in `deploy/update-linux.sh` (pinned by `tests/unit/updateScriptsContract.test.ts`) and must keep the same candidate order. Both twins scan the versioned dirs NEWEST-first when the server major is unknown (`pgToolCandidatesUnknownMajor` / `pg_versioned_dirs`), and the shell probe `pg_server_major` borrows each versioned `psql` when PATH's is missing — on 2026-09-10 a host that had removed AppStream 13 without `alternatives --auto` had no `psql` on PATH, the probe returned nothing, and the script stopped at "pg_dump not found" with `/usr/pgsql-15/bin/pg_dump` present.
- If you change the envelope layout, bump the magic header — do not silently reinterpret bytes, or every existing encrypted backup becomes unrestorable with no error the operator can act on.
- Keep `post_restore` in a `finally`. Any early return between `pre_restore` and it strands the database in restoring mode.

---

## services/backupScheduleService.ts

**What it owns:** The operator-configured automatic-backup cadence — the `backupSchedule` Setting row, its validation/merge rules, the pure due-check, and the off-host copy helper.

**Public API:** `getBackupSchedule` (full, INCLUDING the passphrase — internal callers only), `getBackupScheduleMasked` (API shape), `saveBackupSchedule`, `recordScheduledBackupOutcome`, `isScheduledBackupDue(schedule, now)` (pure), `copyBackupOffHost`, `invalidateBackupScheduleCache`, `defaultBackupSchedule`, plus the bounds constants.

**Cross-service deps:** `services/settingsStore.ts` (TTL-cached Setting accessor), `utils/secretMask.ts`, `utils/backupPassword.ts`.

**Used by:** `src/jobs/scheduledBackup.ts — the 5-minute tick`; `src/api/routes/serverSettings.ts — GET|PUT /database/backup-schedule`.

**Invariants:**
- **Default `enabled: false`.** Many sites already back this Postgres up with an enterprise product, and an in-app update must not start writing gigabytes unasked. Turning it on is an operator action.
- **Never-run means due immediately.** Enabling the feature must produce a recovery point now, not `intervalHours` later.
- **A missed pinned hour is not skipped forever.** `hourUtc` holds an otherwise-due run until that hour, but past 2× the interval it runs anyway — a host that is down through 03:00 every night would otherwise never back up.
- `lastRunAt` advances only on SUCCESS, so a failing schedule keeps retrying rather than silently marking itself done. `lastError` carries the most recent failure for the settings card.
- Run bookkeeping (`lastRunAt`, `lastError`) is owned by the job, never by operator input — `saveBackupSchedule` preserves both.
- Passphrase handling follows the shared secret convention: masked on read, a masked echo preserves the stored value, an empty string clears it, a new value is strength-checked by `validateBackupPassword`.
- `copyToDir` must be ABSOLUTE. A relative path would resolve against the service's cwd, which is not something an operator can reason about.
- The off-host copy is best-effort: the local backup already succeeded, and a full or unmounted share must not mark the run failed (it writes a warning Event instead).
- Retention prunes ONLY `kind === "scheduled"` backups. A cadence must never delete the manual backup an operator took deliberately, or a pre-update recovery point.

**When changing this:**
- `isScheduledBackupDue` is pure precisely so the cadence is testable without a clock — keep it that way and extend `tests/unit/backupSchedule.test.ts`.
- The passphrase lives in a Setting row, so it is covered by the secret-at-rest sealing in `db.ts` (`Setting.value`, key `passphrase`). Do not rename the field without adding the new name to `SECRET_CONFIG_KEYS`.
- If you add a cadence dimension, decide explicitly what it does when the host was down through the window — silently skipping is the failure mode this service is designed against.

---

## services/weatherProxyService.ts

**What it owns:** Server-side proxy + cache for the Status Map widget's weather overlay: RainViewer radar frame index (5 min TTL, serve-stale ≤30 min on upstream failure), radar tile PNGs (immutable per frame-id content hash → size-bounded FIFO cache, ~48 MB / 4000 entries, no TTL), and Open-Meteo current temperature (20 min TTL per 1.5° grid cell).

**Public API:** `getRadarFrames()`, `getRadarTile(frameId, z, x, y)`, `getTemperature(lat, lng)`, `__resetWeatherProxyCachesForTests()`.

**Cross-service deps:** None (global fetch to api.rainviewer.com / tilecache / api.open-meteo.com; `getAppVersion()` for the User-Agent). No DB, no Events — public weather data only.

**Used by:** src/api/routes/weather.ts (mounted on the main router at `/weather` under requireAuth AND on the Dash listener via its `/weather/` prefix allowlist + `dashWeatherLimiter`). The consumer is public/js/widgets/siteMap.js (proxy-first, direct-CDN fallback).

**Invariants:**
- Tile requests validate the frame id against the union of the last TWO index generations — grace so an animation started just before an index rotation keeps resolving, and a hard gate so the endpoint can't be used as an open proxy to arbitrary upstream paths.
- Frame ids are content hashes → a cached tile can never go stale; the route serves `Cache-Control: public, max-age=86400, immutable` (deliberately overriding the Dash listener's blanket no-store).
- Temperature grid rounding (1.5°) must match siteMap.js loadTemps' grid key, or every viewer becomes a cache miss.
- Transport failures throw AppError 502 and never poison any cache (geocoderService precedent); the widget interprets non-200 as "fall back to the CDN for this cycle/cell".
- Tile render options (256px, color scheme 6, "1_1") are hardcoded to match the widget's direct-CDN URL template — a mismatch would make proxy and fallback look different.
- In-flight dedupe on the index and per-tile fetches — a 14-frame layer add must not stampede upstream.

**When changing this:**
- Keep the CSP fallback hosts (api.rainviewer.com / *.rainviewer.com / api.open-meteo.com in securityHeaders.ts) as long as the widget's CDN fallback exists.
- If tile URL options change, change siteMap.js's fallback template in the same commit.
- The dash rate limiter (`dashWeatherLimiter`, 4000/5min) is sized to radar bursts (~14 frames × viewport tiles); revisit if frame count or tile size assumptions change.
- Scale check: cache is per-process; in the split-role layout only the web + dash processes serve this (no monitor/discovery involvement).

---
