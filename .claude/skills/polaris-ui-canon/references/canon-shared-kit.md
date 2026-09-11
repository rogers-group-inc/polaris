# UI canon — kit mapping, shared utils, theme-paired assets, gated controls, alert indicator

Verbatim from UI-CANON.md. Each pattern: **What it is** / **Canonical implementation** (`path/file.js → symbol()`, no line numbers) / **Key conventions** / **When adding a new instance**. Read `design/POLARIS-UI-GUIDE.md` first for the portable contract these implement.

## Kit API → Polaris equivalent

Polaris predates parts of the kit runtime, so where Part I names a kit API,
this repo's equivalent is:

| Part I names | Polaris has | Where |
|---|---|---|
| `polaris-ui.js` (the runtime) | `app.js` (+ `api.js` for fetch/escapeHtml) | `public/js/` |
| `renderSidebar()` | `renderNav()` | `public/js/app.js` |
| `renderStatusPanel()` / `setSidebarUpdate()` | `renderQueryStatus()` + the per-concern `.query-status` panels | `public/js/app.js` |
| `getTheme` / `setTheme` / `getCurrentTheme` | `_getTheme` / `_setTheme` / `_getCurrentTheme` (same `THEMES` / `DEFAULT_THEME` / `isLightTheme` / `openThemeMenu` / `toggleTheme`) | `public/js/app.js` |
| `brandLogoSrc` / `applyBrandLogo` / `watchBrandLogo` | `PolarisBrandLogo.resolve` / `.applyTo` / `.onThemeChange` (adds custom logos, the accent composite, favicons) | `public/js/brand-logo.js` |
| `createWizard()` | hand-rolled steppers — the Automations 6-step builder is the canonical (see "Wizard (stepper modal)" below) | `public/js/automations-wizard.js` |
| `polaris-ui.css` | `styles.css` | `public/css/` |

Everything else in Part I (`openModal`, `showConfirm`, `showFormModal`,
`openIntegrationModal`, `tabbedBodyHTML`/`wireModalTabs`, the form parts,
`renderPageControls`, `showRowMenu`, `revealOverlay`, `syncSelectedRows`,
`TableSF` + `setupColumnLayout`, `initPanelLock`, toasts) exists in Polaris
under the same names.

---

## Shared frontend utils

**What it is:** A handful of small helpers that every page is expected to reuse rather than re-declare. Re-rolling these locally is the most common source of subtle frontend drift (an un-escaped value, a date that formats differently on one page, two color palettes for the same status).

**Canonical helpers:**
- **`escapeHtml(s)`** + **`mobileFormatDate(iso)`** — both live in [public/js/api.js](public/js/api.js), which is loaded first on every page (desktop **and** mobile, via `<script src="/js/api.js">`) and exports them onto `window`. Use these everywhere a dynamic value lands in an HTML string or a timestamp needs the short human form — never hand-roll a local copy. **Exception:** [public/js/setup.js](public/js/setup.js) keeps its own self-contained `escapeHtml` (with a comment marking why) because `setup.html` does **not** load `api.js` — the first-run wizard is a standalone bundle. That's the only sanctioned duplicate.
- **`debounce(fn, ms)`** — the generic debounce lives in [public/js/table-sf.js](public/js/table-sf.js). It's available wherever `table-sf.js` is loaded (the desktop list pages). **Mobile is not covered:** `mobile.html` loads `api.js` but **not** `table-sf.js`, so the mobile SPA has its own local **`debounceSearch`** in [public/js/mobile/tabs.js](public/js/mobile/tabs.js) for the search box. Don't reach for `table-sf.js`'s `debounce` from mobile code — it isn't on the page.
- **`window.PolarisPlaceholderMac`** — the placeholder-MAC generator in [public/js/placeholder-mac.js](public/js/placeholder-mac.js), loaded by `ipam.html`, `subnets.html` and `mobile.html`. Every "Generate" button on a reservation MAC field goes through it. This one exists BECAUSE it was duplicated: `ip-panel.js` and `mobile/subnet-detail.js` each carried a byte-for-byte copy, and the drift showed up as the mobile EDIT sheet having no Generate button at all. It also mirrors `normalizePlaceholderPrefix` from [src/utils/mac.ts](src/utils/mac.ts) — if you change the prefix rules server-side, change them here too.
- **`tagFieldHTML(selected, opts)` / `getTagFieldValue()` / `wireTagPicker()`** — the registry tag picker in [public/js/app.js](public/js/app.js), rendered by every form that can tag something (asset edit, blocks, subnets, the IPAM block panel). Call `_ensureTagCache()` before rendering. **Its catalogue read must sit at a gate every consuming form holds** — it reads the auth-only `GET /server-settings/tags/catalog`, NOT the registry's own `GET /server-settings/tags` + `/tags/settings`, which sit behind the blanket `serverSettingsSystem:read` floor that every non-admin built-in role is seeded `none` on. Reading the gated pair meant the picker 403'd for `user` / `assetsadmin` / `networkadmin` / `readonly`, and because `_ensureTagCache` swallows the failure it rendered "No tags defined yet" at an install with a full registry — the failure looks like empty data, not like a permission problem, which is why nobody saw it. Same class of bug as the schema-route note under Nested condition tree, and the same fix: a lean, low-gate read of just what the control needs. Two corollaries the picker now holds: the **"+ Add Tag" row is gated on `serverSettingsSystem:fullwrite`** (the gate `POST /tags` actually carries — everyone else got a button whose only outcome was a 403 toast), and a **failed read says so** (`_tagCache.failed`) rather than claiming the registry is empty.
- **Status / health color palettes** — the monitor-state pill palette is **`MONITOR_STATE_COLORS`** (`up` / `down` / `warning`) in [public/js/assets.js](public/js/assets.js); the topology-node palette is **`HEALTH_NODE_COLORS`** in [public/js/topology-render.js](public/js/topology-render.js). These are intentionally two palettes — the topology palette adds node-specific states (unmonitored, dependency-suppressed/unknown) the flat status pill doesn't model. Reuse the matching one for the surface you're building; don't introduce a third.

**When adding a new instance:**
- Reuse `escapeHtml` / `mobileFormatDate` from `api.js` directly — they're global. Only fork a copy if your page genuinely doesn't load `api.js` (today only the setup wizard), and leave a comment saying why.
- **"A dynamic value" includes attribute values, and includes ids you wrote yourself and read back.** The renderer that builds a `data-*` attribute, then a handler that pulls it out with `getAttribute` and feeds it to the next render, is a round trip that looks internal and isn't — CodeQL calls it `js/xss-through-dom`, and it caught exactly that in the chassis-diff panel in [public/js/events.js](public/js/events.js), where every cell was escaped and the `data-chassis-migrate` id on the button was not. Escaping the write side is enough and does not double-escape: the parser decodes the attribute, so `getAttribute` still returns the original value.
- Need a debounce on a desktop list page? Use `table-sf.js`'s `debounce`. On mobile, follow `debounceSearch` in `mobile/tabs.js`.
- Coloring a status surface? Pick the existing palette (`MONITOR_STATE_COLORS` for flat pills, `HEALTH_NODE_COLORS` for graph nodes) instead of minting new hex values.
- Generating a MAC for a reservation? Call `window.PolarisPlaceholderMac.generate(prefix)` and pass the prefix off the IP-panel payload (`subnet.macPlaceholderPrefix`). Never hand-roll one — a MAC outside the configured prefix is invisible to discovery's adoption pass, which is the whole point of generating it.

---

## Active-alert indicator

**What it is:** "This device has something firing on it", in the colour of the worst active alert, on every surface that lists devices. Two shapes, one vocabulary: a **dot** where a row is tight (the desktop Assets list's Name column, the desktop search dropdown, the phone's search results) and a **word** where there is room to be explicit (the phone's asset cards and its asset-detail hero, both reading `Alerts` with a count). The desktop asset slide-over strobes its whole **Alerts tab** instead, which is the same statement in the shape that surface had available.

**Canonical implementations:** `alertSummaryDotHTML(summary)` in [public/js/app.js](public/js/app.js) — with `assetAlertDotHTML(asset)` delegating to it for callers holding a row, and `assetAlertStrobeColor` / `_alertSevRank` beside them. On the phone: `flagHTML` / `dotHTML` in [public/js/mobile/alerts.js](public/js/mobile/alerts.js). CSS is `.alert-strobe-dot` + `.page-tab.alert-strobe` in [public/css/styles.css](public/css/styles.css) and `.alert-flag` + `.alert-dot` in [public/css/mobile.css](public/css/mobile.css).

**Key conventions:**
- **It lives in `app.js`, not `assets.js`.** The search dropdown draws it and renders on every page, half of which never load `assets.js`. Anything new that needs it should call the `app.js` copy rather than guarding on `typeof`.
- **It strobes only while something is UNACKNOWLEDGED.** An acknowledged alert is still active and still marked — `.is-handled` — it has just stopped asking. A wallboard of pulsing dots nobody can quiet is a wallboard people stop looking at.
- **The colour is one vocabulary in three copies**, and they are pinned to each other: `ALERT_SEVERITY_RANK` in [src/utils/alertSeverity.ts](src/utils/alertSeverity.ts) (which also picks WHICH alert a multi-alert device is marked for, via `activeAlertSummaryByAsset`), `_alertSevRank` + the `--color-sev-*` tokens on the desktop, and `sevRank` + the `--md-sev-*` tokens on the phone. Changing the ladder is a three-file change; [tests/unit/assetAlertIndicator.test.ts](tests/unit/assetAlertIndicator.test.ts) and [tests/unit/mobileAssetAlerts.test.ts](tests/unit/mobileAssetAlerts.test.ts) exist to catch a device that reads amber on one surface and red on another.
- **An unknown severity falls back to the DANGER colour, never to none.** Polaris is still asserting something is wrong, and a colourless indicator understates it — the posture business rule 36 takes on an unresolved severity.
- **`prefers-reduced-motion` drops the animation on every copy** and keeps the colour, which carries the whole meaning. Both the desktop and mobile stylesheets do this; a new copy must too.
- **The dot is never a tap target.** In a search row or a table cell it sits inside something already clickable, and a second target a few pixels from the first is a mis-tap. Only the phone's `Alerts` WORD is interactive, because it is placed with room around it and it opens the alerts sheet.

## Capability-gated control (a verb the caller's role can't reach)

**What it is:** Withholding a control from an operator whose click could only 403 — and, for the ownership-dimensioned keys, withholding it PER ROW. Three shapes, one vocabulary: a `canX()` helper for a JS branch, a `data-*` attribute for markup that is gated wholesale, and a `canEditX(row)` predicate for a table whose rows have different answers.

**Canonical implementations:** `permAtLeast(key, level)` in [public/js/app.js](public/js/app.js) is the base check; every `canX()` shim beside it derives from it (`canManageAssets`, `canDeployAgent`, `canQuarantineAssets`, …). The attribute gates are applied in one loop in the same file (`[data-manage-assets]`, `[data-quarantine-assets]`, `[data-deploy-agent]`, `[data-perm-any="key:level,…"]` for the multi-key case). Per-row: `canEditSubnet(subnet)` / `canEditReservation(reservation)` / `canEditCredential(cred)` — all three the same three lines (fullwrite → true, below write → false, else `createdBy === currentUsername`). Row-level rendering reference: the Stored Credentials table in [public/js/server-settings.js](public/js/server-settings.js) (`_credsWritable` / `_credEditable` → per-row `disabled` + a `title` naming the owner).

**Key conventions:**
- **One key per act, not one key per page.** A control that pushes a MAC block reads `canQuarantineAssets()`, one that deploys the agent reads `canDeployAgent()` — never `canManageAssets()`, even though all three live on the assets page. When a route's gate moves (agent deploy → `assets=fullwrite`, business rule 43), the client helper is the single place that follows it.
- **Disable and explain; don't silently vanish a row's verb.** A whole control an operator will never have goes away (the attribute gates hide). A verb they hold on OTHER rows stays visible and `disabled` with a `title` saying whose row it is — a button that disappears on some rows of one table reads as a rendering bug.
- **A read-only viewer still sees the state.** The credentials list renders for anyone at `read`; the agent panel's diagnostic rows render at `assets=read` and only the action strip is withheld. Seeing what is configured is not the same grant as changing it.
- **The client gate is UX, never enforcement.** Every one of these has a route-layer twin (`requirePermission` / `requireOwnership` + `assertOwnership`), and the pair must be edited together — the same rule `NAV_ITEMS` and `pageRequiredPermission` follow.
- **Never gate on the role NAME.** `isAdmin()` and friends survive for the few places that genuinely display a role identity; a capability check on a name is wrong for every custom role and silently wrong after a rename.

## Theme-paired image asset with one resolver
