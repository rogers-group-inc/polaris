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
| `getTheme` / `setTheme` / `getCurrentTheme` / `advanceTheme` | `_getTheme` / `_setTheme` / `_getCurrentTheme` / `advanceTheme` (same `THEMES` / `TRANSIT_THEMES` / `THEME_BAND_POS` / `DEFAULT_THEME` / `isLightTheme`; `openThemeMenu` and `toggleTheme` survive only as aliases of `advanceTheme` — there is no theme menu to open) | `public/js/app.js` |
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
- **`escapeHtml(s)`** + **`mobileFormatDate(iso)`** — both live in [public/js/api.js](public/js/api.js), which is loaded first on every page (desktop **and** mobile, via `<script src="/js/api.js">`) and exports them onto `window`. Use these everywhere a dynamic value lands in an HTML string or a timestamp needs the short human form — never hand-roll a local copy. **Exception:** [public/js/setup.js](public/js/setup.js) keeps its own self-contained `escapeHtml` (with a comment marking why) because `setup.html` does **not** load `api.js` — the first-run wizard is a standalone bundle. That's the only sanctioned duplicate. **`api` is a reserved name in `public/`:** [tests/unit/apiClientReferences.test.ts](tests/unit/apiClientReferences.test.ts) reads every `api.<name>` in these files as a call on the REST client and fails on the ones that do not exist, so a local `var api = window.SomethingElse` breaks the full suite (and only the full suite — the page's own tests pass). Name the local anything else.
- **`debounce(fn, ms)`** — the generic debounce lives in [public/js/table-sf.js](public/js/table-sf.js). It's available wherever `table-sf.js` is loaded (the desktop list pages). **Mobile is not covered:** `mobile.html` loads `api.js` but **not** `table-sf.js`, so the mobile SPA has its own local **`debounceSearch`** in [public/js/mobile/tabs.js](public/js/mobile/tabs.js) for the search box. Don't reach for `table-sf.js`'s `debounce` from mobile code — it isn't on the page.
- **`window.PolarisPlaceholderMac`** — the placeholder-MAC generator in [public/js/placeholder-mac.js](public/js/placeholder-mac.js), loaded by `ipam.html`, `subnets.html` and `mobile.html`. Every "Generate" button on a reservation MAC field goes through it. This one exists BECAUSE it was duplicated: `ip-panel.js` and `mobile/subnet-detail.js` each carried a byte-for-byte copy, and the drift showed up as the mobile EDIT sheet having no Generate button at all. It also mirrors `normalizePlaceholderPrefix` from [src/utils/mac.ts](src/utils/mac.ts) — if you change the prefix rules server-side, change them here too.
- **`window.PolarisReservationNotes`** — the FortiGate reservation-notes budget in [public/js/reservation-notes.js](public/js/reservation-notes.js), loaded by `ipam.html`, `subnets.html` and `mobile.html`. `budgetFor(hostname, createdBy)` and `hintFor(notes, hostname, createdBy)` answer how much of a note fits in the device's 255-character `reserved-address` description once Polaris's `Polaris/<user>: … [<hostname>]` wrapper is paid for (business rule 74), and every reservation form with a Notes field renders the live counter from them — the four IP-panel modals and both mobile sheets. It mirrors `reservationNotesBudget` in [src/services/reservationPushService.ts](src/services/reservationPushService.ts), which is the half that actually REFUSES an over-length save; [tests/unit/reservationNotesBudgetDom.test.ts](tests/unit/reservationNotesBudgetDom.test.ts) asserts the two agree. Show the counter only where `subnet.pushEligible` is true — off a pushing network the field has no device behind it and a budget would be a limit Polaris invented.
- **`tagFieldHTML(selected, opts)` / `getTagFieldValue()` / `wireTagPicker()`** — the registry tag picker in [public/js/app.js](public/js/app.js), rendered by every form that can tag something (asset edit, blocks, subnets, the IPAM block panel). Call `_ensureTagCache()` before rendering. **Its catalogue read must sit at a gate every consuming form holds** — it reads the auth-only `GET /server-settings/tags/catalog`, NOT the registry's own `GET /server-settings/tags` + `/tags/settings`, which sit behind the blanket `serverSettingsSystem:read` floor that every non-admin built-in role is seeded `none` on. Reading the gated pair meant the picker 403'd for `user` / `assetsadmin` / `networkadmin` / `readonly`, and because `_ensureTagCache` swallows the failure it rendered "No tags defined yet" at an install with a full registry — the failure looks like empty data, not like a permission problem, which is why nobody saw it. Same class of bug as the schema-route note under Nested condition tree, and the same fix: a lean, low-gate read of just what the control needs. Two corollaries the picker now holds: the **"+ Add Tag" row is gated on `serverSettingsSystem:write`** (the gate `POST /tags` actually carries — everyone else got a button whose only outcome was a 403 toast), and a **failed read says so** (`_tagCache.failed`) rather than claiming the registry is empty.
- **Status / health color palettes** — the monitor-state pill palette is **`MONITOR_STATE_COLORS`** (`up` / `down` / `warning`) in [public/js/assets.js](public/js/assets.js); the topology-node palette is **`HEALTH_NODE_COLORS`** in [public/js/topology-render.js](public/js/topology-render.js). These are intentionally two palettes — the topology palette adds node-specific states (unmonitored, dependency-suppressed/unknown) the flat status pill doesn't model. Reuse the matching one for the surface you're building; don't introduce a third.

**When adding a new instance:**
- Reuse `escapeHtml` / `mobileFormatDate` from `api.js` directly — they're global. Only fork a copy if your page genuinely doesn't load `api.js` (today only the setup wizard), and leave a comment saying why.
- **"A dynamic value" includes attribute values, and includes ids you wrote yourself and read back.** The renderer that builds a `data-*` attribute, then a handler that pulls it out with `getAttribute` and feeds it to the next render, is a round trip that looks internal and isn't — CodeQL calls it `js/xss-through-dom`, and it caught exactly that in the chassis-diff panel in [public/js/events.js](public/js/events.js), where every cell was escaped and the `data-chassis-migrate` id on the button was not. Escaping the write side is enough and does not double-escape: the parser decodes the attribute, so `getAttribute` still returns the original value.
- Need a debounce on a desktop list page? Use `table-sf.js`'s `debounce`. On mobile, follow `debounceSearch` in `mobile/tabs.js`.
- Coloring a status surface? Pick the existing palette (`MONITOR_STATE_COLORS` for flat pills, `HEALTH_NODE_COLORS` for graph nodes) instead of minting new hex values.
- Putting a Notes field on a reservation form? Render the counter from `window.PolarisReservationNotes.hintFor(...)` and re-render it on hostname keystrokes as well as notes ones — both spend from the same 255. Never a fixed `maxlength`: the budget moves with the username and the hostname.
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
- **A SHORTENED ladder moves the client gate too, and forgetting is silent.** When a key loses its top rung, every `permAtLeast(key, "fullwrite")` in `public/` becomes a test no role can ever pass — the control simply stops rendering for everybody, including admin, with no 403 to notice. The 2026-09-22 catalogue sweep (rule 43d) moved 13 such calls across `app.js`, `assets.js`, `automations.js` and `automations-wizard.js` for `automationManagement`, `automationScripts` and `maintenanceManagement`. Grep `public/` for the key's name beside `"fullwrite"` as part of the same change, never after it.
- **A gate that names ANOTHER page's key is the same bug pointing the other way, and it is silent.** Too-loose gating announces itself — the operator clicks and gets a 403 toast. Too-strict gating, or gating on an orthogonal key, produces no error at all: the control simply is not rendered, and the role that *should* hold it never learns the feature exists. The MAC column's remove **×** in `macCellHTML` (`public/js/assets.js`) shipped gated on `canManageNetworks()` (`subnets:fullwrite`) against a route gated `assets:write`, so the built-in **assetsadmin** — the one role whose job is correcting a wrong MAC association — could call `DELETE /assets/:id/macs/:mac` all day and never saw the button, while the fix looked like a missing feature rather than a gate. When you write a `canX()` into a template, open the route it calls and read its `requirePermission` line; when a control is reported missing for a role, suspect the client gate before the route.
- **Disable and explain; don't silently vanish a row's verb.** A whole control an operator will never have goes away (the attribute gates hide). A verb they hold on OTHER rows stays visible and `disabled` with a `title` saying whose row it is — a button that disappears on some rows of one table reads as a rendering bug.
- **A read-only viewer still sees the state.** The credentials list renders for anyone at `read`; the agent panel's diagnostic rows render at `assets=read` and only the action strip is withheld. Seeing what is configured is not the same grant as changing it.
- **The client gate is UX, never enforcement.** Every one of these has a route-layer twin (`requirePermission` / `requireOwnership` + `assertOwnership`), and the pair must be edited together — the same rule `NAV_ITEMS` and `pageRequiredPermission` follow.
- **Never gate on the role NAME.** `isAdmin()` and friends survive for the few places that genuinely display a role identity; a capability check on a name is wrong for every custom role and silently wrong after a rename.

## Floating-surface tokens (glass, elevation)

**What it is:** The one vocabulary every surface that floats above the page paints itself
with — modal, slide-over, context menu, button dropdown — plus the elevation shadows for
chrome that merely sits ON the page. Added 2026-09 when those surfaces went translucent;
before that each rule picked its own background and shadow.

**Canonical implementation:** the token block at the top of
[public/css/styles.css](public/css/styles.css). `--panel-glass-bg` (modal + slide-over body),
`--panel-glass-chrome` (their header/footer bands), `--menu-glass-bg` (every menu),
`--panel-glass-blur` (the `backdrop-filter` value all of them share), `--shadow-panel` (a
frosted surface floating free of a screen edge), `--shadow-control` (buttons, page search
and filter fields, anything small resting on the page), `--shadow-card` (the big opaque
content surfaces resting on the page — every card, the dashboard widgets, the map and graph
canvases, and `.chart-box`, the plot surface every SVG chart in the asset slide-over is drawn
into) and `--shadow-pill` (badges and widget pills, nothing else).

**Key conventions:**
- **Five elevation tokens, one per kind of surface — pick by what the surface IS.**
  `--shadow-panel` floats free over a scrim; `--shadow-md` floats over the page (menus,
  dropdowns, `.table-wrapper`); `--shadow-control` is small chrome resting on it;
  `--shadow-card` is a big opaque box resting on it; `--shadow-pill` is the tightest of
  them, for `.badge` and `.widget-pill` only. A pill is not a control — it takes far less
  lift than `--shadow-control`, because at 0.72rem in a dense table anything blurrier
  reads as a smudge. It is also the one elevation defined per FAMILY rather than per
  theme (`:root` and the daylight base), since separating a tinted chip from the surface
  under it is the same job in every theme. `--shadow-sm` is retired — nothing in
  `public/` paints it, and it survives in the token block only because the portable kit
  declares it. A new card takes `--shadow-card`; reaching for `--shadow-sm` reproduces
  exactly the bug that retired it (a 4px blur at .10 alpha under a 300px-wide box is
  invisible on the daylight pair, so every card read as a flat cutout beside buttons and
  tables that clearly floated).
- **A wide surface needs two drop layers.** Across a card the 32px halo alone only tints the
  ground; the tight second layer is what draws the edge. `--shadow-panel` and `--shadow-card`
  both carry the pair for this reason, `--shadow-control` does not because at 20-36px tall a
  wide halo just muddies the ground.
- **Derive, never hardcode a new background.** The glass tokens are `color-mix()` declared
  ONCE on `:root`; a custom property substitutes `var()` at the element it is declared on, and
  every theme block also targets the root element, so each theme's own `--color-bg-*` values
  are what get mixed. A new theme inherits the glass for free — and a new surface takes
  `--menu-glass-bg` + `--panel-glass-blur` + `--shadow-panel` rather than inventing a mix.
  `.widget-export-menu` mixed its own `--color-bg-elevated` for exactly one commit, which was
  enough for it to silently ignore the next change to the shared token.
- **The daylight pair overrides the glass, and only the glass** (panels 40%, menus 30%, in the
  `:is([data-theme="morning"],[data-theme="noon"])` base block). A light panel over a light
  page has far less to hide behind, so the dark family's mix reads as nearly solid there.
- **An overlay wrapping a frosted surface must reach opacity EXACTLY 1.** Any value below it
  makes the overlay a backdrop root, and the child's `backdrop-filter` then samples nothing but
  the scrim. This binds every standalone overlay a stacking surface builds for itself, not just
  the shared `#modal-overlay`.
- **`backdrop-filter` makes an element a containing block for `position: fixed` descendants.**
  It was free to add to `.modal` and `.slideover` only because both already carry a transform
  for their reveal animation, so the fixed popovers mounted inside them
  (`.sf-multi-popover` in a TableSF header, `.monitor-confirm-popover`) were already resolving
  against the panel. Dropping either transform now moves those popovers.
- **`box-shadow` replaces, it does not compose.** Every `:focus` rule on an element carrying
  `--shadow-control` re-states the shadow after the focus ring, or the field visibly flattens
  the moment it is focused.
- **In the dark family the drop shadow is the inset rim.** The nightfall ground is `#0d0d1c`,
  so a black shadow has almost nothing to darken and stays invisible however far its alpha is
  pushed; `--shadow-control`'s and `--shadow-card`'s third layer is a 1px inset top highlight,
  and that is what actually reads as raised. Any future elevation token for the dark themes
  needs the same. It is worth saying plainly that a card in the dark family reads as raised
  only just — that is the ceiling, not a tuning miss, and the answer to "make it stronger" is
  a brighter rim, never a blacker drop.
- **A transparent box inside a frosted panel becomes a window.** `.tag-picker` declared a
  border and no background, which was invisible while modals were opaque and showed the
  blurred page through the tag chips the moment they were not. When adding a container inside
  a panel, name a background token even when the panel's own colour looks right.
  The Device Map topology modal's details aside (`.topology-info`) was the second case and
  the more visible one: a whole 320px column of detail rows read through the glass while the
  graph half beside it painted an opaque `--color-bg-secondary`, so the two halves of one
  modal looked like different materials. It now mixes `--color-bg-primary` at 90% — a pane
  that holds text wants a near-solid ground, not the panel's own 50/40% glass. The same
  modal's header band followed for the same reason (`#topology-overlay .modal-header`, 90%
  of `--color-bg-tertiary`): `--panel-glass-chrome` is the shared header value and it is fine
  over a modal's own scrolling body, but this header stands in front of a full-bleed graph, so
  the title, the endpoint search box and the icon row read through it. Both rules lift only the
  opacity of the theme's own token — never a literal colour — so a new theme keeps its palette.

## Settings-card layout (one card, a fixed row, or a reflowing deck)

**What it is:** how the cards on a Server Settings tab are arranged. `.settings-card` is the
box itself (the `--shadow-card` surface above); three container classes decide whether cards
stack, sit in a fixed row, or reflow with the window.

**Canonical implementation:** the three containers in
[public/css/styles.css](public/css/styles.css), each built by a tab renderer in
[public/js/server-settings.js](public/js/server-settings.js):

| Container | Layout | Use it when |
|---|---|---|
| *(none — bare `.settings-card`)* | full-width, stacked | one card, or a card holding a wide table |
| `.settings-cards-row` | grid, exactly 2 columns, no reflow | two cards that belong side by side at every width |
| `.settings-cards-row-3` | grid, 3 columns → 2 under 1000px viewport | a fixed set of three short cards of similar height |
| `.settings-cards-flow` | `columns: 360px 3` — up to 3 columns, min 360px each, count chosen by the browser | a deck of independent cards of differing height (the Web Server tab) |

**Key conventions:**
- **A tab with more than three cards wants `.settings-cards-flow`, not a `-row` class.** The
  `-row` grids assign a card to a fixed slot, so a fourth card means another hand-written
  container and another breakpoint. `columns: <width> <count>` states the two things that
  actually matter — the narrowest a card may be, and the most columns worth having — and the
  browser derives the count from the space it has. That is one declaration instead of a
  media query per screen size, and it degrades to a single column on a phone for free.
- **Column flow, not grid, when the cards differ in height.** A grid row is as tall as its
  tallest member, so on the Web Server tab (nginx Proxy is roughly twice HTTPS Certificate)
  every short card in that row would trail a column of dead space. Multi-column flow packs
  vertically instead. The cost is reading order: cards fill down each column, not across, so
  only use it where the cards are genuinely independent — a deck of settings cards is, a
  numbered sequence is not.
- **Every card in a flow container needs `break-inside: avoid`** (and the `-webkit-` prefixed
  form, which Safari still reads). Without it a card taller than the balanced column height is
  sliced down the middle across two columns, header in one and buttons in the other.
- **A full-width banner stays outside the container.** The Web Server tab's
  not-Polaris-managed drift banner is concatenated ahead of the deck, not inside it, so it
  spans the tab instead of becoming a fourth card.
- `.settings-card`'s own `margin-bottom: 1rem` is the vertical gutter in a flow container and
  is zeroed inside the `-row` grids, which use `gap` instead. A new container class must pick
  one of the two, not both.

## Theme-paired image asset with one resolver
