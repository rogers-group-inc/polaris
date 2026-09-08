---
name: polaris-ui-canon
description: "Polaris frontend (vanilla JS, no build step, public/): which file is the reference implementation of each UI pattern (SVG charts, modals, stacked modals, slide-overs, wizards, sortable/filterable tables, column layout, row context menus, condition builder, widgets, mobile sheets), the page → permission-gate table, the shared modules never to re-derive, the three themes, list-page and modal conventions, and the kit contract in design/POLARIS-UI-GUIDE.md. Load for any change under public/, any HTML/CSS/JS/UI/UX/theme/dashboard/widget/chart/mobile PWA/Dash wallboard request, or 'make it look like the X page'."
---

# Polaris UI canon

When there are several ways to build the same thing (chart, modal, slide-over, sortable
table, wizard, row menu), this skill names the reference implementation new work must
match. **Read `design/POLARIS-UI-GUIDE.md` first** for the portable contract (tokens,
themes, shell, tables, modals, badges, z-index, the phone SPA, the alert email) — that
file is a drop-in snapshot of the external kit and is never edited to chase `public/`.
Read the canon files here for *which file in THIS repo* to copy. Inside this repo
`public/` is the living source; `design/js|css|email/` are snapshots.

## Which file

| You are building or changing… | Read |
|---|---|
| a list page, table, column chooser, pagination, row verbs, a filter box | [references/canon-tables-lists.md](references/canon-tables-lists.md) |
| a modal, a dialog over a modal, an integration dialog, a wizard, the condition builder, a slide-over, a blocking overlay, a standalone page | [references/canon-modals-wizards.md](references/canon-modals-wizards.md) |
| a chart, a dashboard widget, the polling-method subtabs | [references/canon-charts-widgets.md](references/canon-charts-widgets.md) |
| anything on the phone SPA (bottom sheet, pull-to-refresh, keyboard fit) | [references/canon-mobile.md](references/canon-mobile.md) |
| shared helpers, theme-paired assets, gated controls, the active-alert dot, kit API names | [references/canon-shared-kit.md](references/canon-shared-kit.md) |
| the SPA shell, navigation, the assets page and its slide-over tabs | [references/frontend-shell.md](references/frontend-shell.md) |
| Discovery-rules card, SSH Deployment, script publishing, export/import, Dash wallboard, mobile PWA + push | [references/frontend-surfaces.md](references/frontend-surfaces.md) |
| the Automations page or its 6-step wizard | [references/frontend-automations-wizard.md](references/frontend-automations-wizard.md) |
| html-to-image screenshots or the Device Map topology layout solver | [references/tech-stack-frontend.md](references/tech-stack-frontend.md) |

Every pattern section carries **What it is** / **Canonical implementation**
(`path/file.js → symbol()` — no line numbers, grep the symbol) / **Key conventions** /
**When adding a new instance**. If your change replaces a canonical, moves its file, or
invalidates a convention, fix the canon file in the same commit (`/polaris-docs-sync`).
The portable UI contract, and the backend counterpart of this index, live in
`design/POLARIS-UI-GUIDE.md` and `polaris-change-impact` → patterns.

## Frontend conventions (always apply)

Vanilla JavaScript SPA served from `/public/`. **No build step** — plain ES modules, multi-page layout with client-side navigation in `app.js`, **three themes in two families** (`morning` / `noon` daylight, `nightfall` dark — the retired `dark`/`light` ids are recognized nowhere; branch on `isLightTheme()`, never on an id), per-user panel lock on every modal and slide-over.

**Pages** (nav entry → page → gate). Every sidebar entry whose page can 403 carries a permission gate (`perm: [key, level]`, or `anyPerm: [[key, level], …]` for a multi-key page like IPAM) — **kept in lockstep with `pageRequiredPermission` in `src/app.ts`**, which bounces a typed URL for the same page. An ungated entry advertises a page whose first list fetch is the only thing telling the operator they can't be there.

| Page | File | Gate |
|---|---|---|
| Dashboard | `index.html` | per-widget (`PolarisWidgets.getAllowed()`) |
| Assets | `assets.html` | `assets:read` |
| IPAM | `ipam.html` (+ `blocks.html` / `subnets.html`) | `anyOf` `ipBlocks:read` / `subnets:read` |
| Integrations | `integrations.html` | `integrations:read` |
| Automations | `automations.html` | `automationManagement:read` |
| Device Map | `map.html` | `deviceMap:read` |
| Application Map | `appmap.html` | `applicationMap:read` |
| Events | `events.html` | `events:read` |
| Users | `users.html` | `users:read` |
| Server Settings | `server-settings.html` | `serverSettingsSystem:read` floor |
| Dash wallboard | `dash.html` | unauthenticated, source-IP scoped |
| Acknowledge alert | `alert-ack.html` | `alerts:read` |
| Signed out | `signed-out.html` | unauthenticated (the desktop logout landing — no form; its Sign in button opens the bare `/login.html`) |
| API documentation | `api.html` (served at `/api`) | unauthenticated, source-IP scoped (`apiDocsConfig`) |
| Mobile PWA | `mobile.html` | in-app mobile login |
| First-run wizard | `setup.html` | unauthenticated (pre-provision) |

**Shared modules — reuse these, never re-derive them.** Each exists because several surfaces were deciding the same thing independently and drifted:

| Module | Global | Owns |
|---|---|---|
| `public/js/condition-builder.js` | `PolarisConditionBuilder` | the nested AND/OR device-filter builder (automations wizard, address book, mass pinning, tag auto-assign) |
| `public/js/automations-wizard.js` | `openAutomationWizard` | the 6-step automation wizard; loads on every page that loads `assets.js` |
| `public/js/automations-portability.js` | `PolarisAutomationPortability` | automation export / import / view code |
| `public/js/automations-wizard.js` | `PolarisAutomationSentences` | trigger/reset prose — one phrasing for the list AND the editor |
| `public/js/alert-ack-view.js` | `PolarisAlertAckView` | the presentation of ONE alert about to be acknowledged — shared by `/alert-ack.html` and the in-app modal so the two cards cannot drift |
| `public/js/alert-ack-modal.js` | `PolarisAlertAckModal` | that card in a modal: the in-app acknowledge dialog, opened from the Down Assets widget's row menu |
| `public/js/recurrence-editor.js` | `PolarisRecurrence` | a RECURRENCE shape — the JSON `MaintenanceSchedule.schedule` and an automation's `repeat.quiet.windows[]` both carry: its one-line summary, and the day/hours editor (seven day rows, each off, all day, or carrying one or more hour ranges, with per-day `+ Add hours`). Shared by the Maintenance modal and the automations wizard's quiet time (business rule 44); two editors of one shape drift into saving two different things, and two summarisers into describing the same window two ways on two pages |
| `public/js/brand-logo.js` | `PolarisBrandLogo` | which logo variant a theme gets (business rule 27) |
| `public/js/dashboard-saved.js` | `PolarisSavedDashboards` | the "Dashboards ▾" menu on BOTH the Dashboard page and the Dash wallboard — save / publish / load a named canvas, and (wallboard only) pin a published one. Its counterpart seam is `window.PolarisDashboard` in `dashboard.js` |
| `public/js/mobile/alerts.js` | `PolarisMobileAlerts` | the phone's alert severity vocabulary (the third mirror of `ALERT_SEVERITY_RANK`), the Assets-list alert flag, the per-asset alerts sheet (acknowledge / clear), and the sheet-based acknowledge-note prompt the More tab shares |
| `public/js/region-pills.js` | `PolarisRegionPills` | the only browser-side reader of the region catalogue |
| `public/js/region-tree.js` | `PolarisRegionTree` | region containment tree + overlay styling |
| `public/js/totp-self.js` | `PolarisTotpSelf` | self-service TOTP enroll/confirm/disable modals |
| `public/js/temp-unit.js` | — | render-time °C/°F conversion, gated on each reading's stored unit |
| `public/js/chart-severity.js` | `PolarisChartSeverity` | severity gradient math for charts |
| `public/js/monitor-states.js` | `PolarisMonitorStates` | the monitor state machine replayed over a probe stream — the ONE decider of which probe reads up / warning / down / recovering, shared by the Last-30-min strip, the desktop response-time chart and the phone's (mirrored server-side by `probeOutageService.replayProbeStates` for the alert email, parity-tested) |
| `public/js/monitor-down-after.js` | `PolarisMonitorDownAfter` | the "Declare Down after" arithmetic **and its counterpart, how many answers reach Up** (both counts from the covering down automation, cadence from monitor settings — business rule 36) |
| `public/js/assets-ipcontext.js` | `PolarisIpContext` | the Add-Asset IP cross-reference panel |
| `public/js/pwa-install.js` | `PolarisInstall` | install prompt — **must load first** (`beforeinstallprompt` can fire before boot) |
| `public/js/push.js` + `public/sw.js` | — | Web Push enrollment + service worker (no fetch handler, no Cache Storage) |
| `public/js/api.js` | — | fetch wrapper, CSRF handling, stale-Secure-cookie pre-check |
| `public/js/app.js` | `THEMES` / `isLightTheme` / `_setTheme` | the theme list, the daylight-family test every palette switch reads, and the `themechange` event cached palettes repaint on |
| `public/js/app.js` | `alertSummaryDotHTML` / `assetAlertDotHTML` / `assetAlertStrobeColor` | the active-alert indicator — the strobing severity-coloured dot on the Assets list, the search dropdown and (as a word) the phone. Here rather than in `assets.js` because the search dropdown renders on every page |
| `public/js/app.js` | `tabbedBodyHTML` / `wireModalTabs` | the ONE modal tab-strip pair (assets.js and integrations.js each carried a byte-identical private copy) |
| `public/js/app.js` | `openIntegrationModal` | the one shape all seven integration dialogs are built from — title, tab order, footer order, Test gating |
| `public/js/app.js` | `sectionHeading` / `formDivider` / `infoBox` / `checkboxRow` / `calloutHTML` | config-modal form parts |
| `public/js/app.js` | `revealOverlay` / `syncSelectedRows` | hidden-tab-safe overlay reveal; `tr.selected` in step with the row checkboxes |

**List-page conventions.** A list table is TableSF (per-column sort + inline filters) + `setupColumnLayout` (resizable/hideable columns) + a frozen header with the body scrolling inside `.table-wrapper-sticky` + `renderPageControls` (centered pagination, right-aligned "Show N"). Sort, filters, column widths/visibility and page size persist per user under a `PolarisPrefs` key and are **restored before the first render**, so the initial paint carries the operator's setup instead of flashing defaults. Row verbs are a **context menu on the row's name** (`showRowMenu` in `app.js`), not an Actions column. Column widths are decided in `table-sf.js`, never in CSS — under `table-layout: fixed` the `<col>` beats a stylesheet rule and the pin loop overwrites `widths[]` anyway; a page opts a utility column out of the 34px `FIXED_COL_W` track with an inline `style="width:…"` on its `th`. The **auto-fill (last resizable) column is floored** at `max(AUTOFILL_MIN_W, its declared width)`: starved below its label's min-content it wraps one letter per line and stretches the whole `thead`, so overflow goes to the wrapper's horizontal scroll instead — that floor is applied AFTER the crushed-table saved-width fallback, or that fallback becomes dead code. Selection state rides `tr.selected` alongside the checkbox (`syncSelectedRows`).

**Modal conventions.** `openModal` reuses ONE shared `#modal-overlay`. A surface that must stack *over* an open modal (the address-book picker at z-index 1300, its editor at 1320) therefore **builds its own overlay** — calling `openModal` would destroy the form DOM underneath. A standalone overlay still has to restore focus, trap Tab, and call `_ensureLockButton` itself, because that injector's MutationObserver only watches the shared overlay. Reveal through `revealOverlay` (or the same rAF-plus-`setTimeout` pair): **rAF does not fire in a hidden tab**, so a dialog opened in the background would be built and never shown. Panel-lock state lives on `window.__polarisPanelLock` and `initPanelLock({user})` is idempotent + late-safe — app.js can be evaluated twice, and a fresh file-scope object would reset the lock while the injected buttons kept claiming the old state. Wizard stepper CSS is shared in `styles.css`.

**Integration modals are one shape, not seven.** Build every "connect us to another system" dialog with `openIntegrationModal({product, action, tabs, requires, onWire, onTest, onSave})`: title `"<Action> <Product> Integration"`, General tab first then Monitoring then feature tabs, footer `Test Connection · Cancel · Create/Save Changes`, field ids unique ACROSS tabs so one pass collects the whole form. Test is gated on `requires` and the toast NAMES the missing fields; **saving is never blocked on a passing test**. The tab set and the required-field list are declared ONCE per type (`_integrationTabs` / `_INTEGRATION_REQUIRED_FIELDS` in `integrations.js`) and both the Add and Edit flows walk them — they used to be two hand-maintained arrays, so a tab added to one silently missed the other. Secrets are dropped from `requires` on the Edit flow, where a stored one renders blank.

**Charts** are hand-rolled SVG. They render labeled translucent maintenance bands over window gaps (`_maintenanceBandLayer`), dive to the baseline in red across a failed poll and in **grey** across one the upstream explains (`_CHART_DEP_COLOR`; the same value lives in `public/js/mobile/charts.js` and `src/utils/sparklineSvg.ts` — change one, change all three), and may shade the line by automation severity — the ladder comes from `GET /assets/:id/metric-thresholds` (server-side, off the engine's own `resolveTierLadder`) so shading can never disagree with what actually fires.

> Per-surface detail — the assets page and its slide-over tabs, the Network Discovery wizard (`assets-discovery.js` + `discovery-portability.js`), the Automations page + 6-step wizard, Service/Process Discovery Rules, SSH Deployment, Script publishing, the Dash wallboard, and the Mobile PWA — lives in polaris-ui-canon → frontend-shell.md / frontend-surfaces.md.

Canonical UI implementations to model new work after live in polaris-ui-canon (charts, modals, slide-overs, sortable tables, wizards, row menus); the portable contract they are built on is [design/POLARIS-UI-GUIDE.md](design/POLARIS-UI-GUIDE.md).

Related skills: `polaris-api-rbac` (the gate each page and control checks),
`polaris-change-impact` → `cross-cutting/csp-inline-script-policy.md` and
`cross-cutting/server-side-list-tables.md`, `polaris-business-rules` rule 27 (logo by theme).
