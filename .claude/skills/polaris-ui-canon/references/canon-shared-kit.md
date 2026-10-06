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
- **`tagFieldHTML(selected, opts)` / `getTagFieldValue()` / `wireTagPicker()`** — the registry tag picker in [public/js/app.js](public/js/app.js), rendered by every form that can tag something (asset edit, blocks, subnets, the IPAM block panel). Call `_ensureTagCache()` before rendering. **Its catalogue read must sit at a gate every consuming form holds** — it reads the auth-only `GET /server-settings/tags/catalog`, NOT the registry's own `GET /server-settings/tags` + `/tags/settings`, which sit behind the blanket `serverSettingsSystem:read` floor that every non-admin built-in role is seeded `none` on. Reading the gated pair meant the picker 403'd for `user` / `assetsadmin` / `networkadmin` / `readonly`, and because `_ensureTagCache` swallows the failure it rendered "No tags defined yet" at an install with a full registry — the failure looks like empty data, not like a permission problem, which is why nobody saw it. Same class of bug as the schema-route note under Nested condition tree, and the same fix: a lean, low-gate read of just what the control needs. Two corollaries the picker now holds: the **"+ Add Tag" row is gated on `serverSettingsSystem:write`** (the gate `POST /tags` actually carries — everyone else got a button whose only outcome was a 403 toast), and a **failed read says so** (`_tagCache.failed`) rather than claiming the registry is empty. **Every selected tag renders as a chip**: one with no registry row (discovery's `azurearc` / `auto-discovered` / `arc-*` / `fortiswitch`…, or anything when the catalogue read failed) goes ticked under a "Not in tag list" group — `getTagFieldValue` reads only rendered checkboxes and the edit form's PUT replaces `tags` wholesale, so a tag with no chip was silently stripped on every save (2026-10). `azure:` chips (`_tagChipHTML`) are `disabled` — Arc-owned — and a ticked disabled box still counts in `:checked`, so they survive the save. Pinned by `tests/unit/tagPickerUnlistedTags.test.ts`.
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
- **Surfaces that draw it:** the Assets list Name column, the search dropdown, and each row of the asset-details Dependency Tree (`_depTreeNodeRow` in `public/js/assets.js`, beside the monitor-state pip, which it never replaces — the pip is STATE, the dot is ALERTS; pinned by `tests/unit/assetDepTreeAlertDotDom.test.ts`). The tree row is a flex row, so `.dep-tree-row .alert-strobe-dot` zeroes the dot's own left margin.
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
- **A verb gated on another surface's key — the firmware card is the example.** The Repository's own key (`firmware`) is read / write: `read` renders the tab, `write` renders upload / delete / make-primary / purge / Set login. The asset card's ONE verb, "Upgrade firmware to …", is NOT on that key: it checks `permAtLeast("assets", "write")` (operator decision 2026-09-26 — whoever may edit an asset may upgrade it), its facts render at `assets:read` like the rest of the slide-over, and `firmware:read` only decides whether the card links to the Repository. The hint names the rung it withholds ("needs Read-Write on Assets"). Business rules 43(g), 87.
- **The client gate is UX, never enforcement.** Every one of these has a route-layer twin (`requirePermission` / `requireOwnership` + `assertOwnership`), and the pair must be edited together — the same rule `NAV_ITEMS` and `pageRequiredPermission` follow.
- **Never gate on the role NAME.** `isAdmin()` and friends survive for the few places that genuinely display a role identity; a capability check on a name is wrong for every custom role and silently wrong after a rename.

## Floating-surface tokens (glass, elevation)

**What it is:** The one vocabulary every surface that floats above the page paints itself
with — modal, slide-over, context menu, button dropdown — plus the elevation shadows for
chrome that merely sits ON the page. Added 2026-09 when those surfaces went translucent;
before that each rule picked its own background and shadow.

**Canonical implementation:** the token block at the top of
[public/css/styles.css](public/css/styles.css). `--panel-glass-bg` (modal + slide-over body; 78%, 70% on the daylight base),
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
- **The page ground carries a glow; nothing full-width may paint over it opaquely.** Since
  2026-10-04 `body` paints `--page-glow` (a radial wash from the top centre of the viewport,
  `background-attachment: fixed`) over `--color-bg-secondary`. The glow is `--page-glow-color`
  (the theme's accent, except nightfall — whose glow is the sliding night layer below, in moonlight blue `#6d97ff` — and noon, which takes sunlight yellow `#ffc928` because a terracotta
  wash on its near-white ground reads as rust) at `--page-glow-strength` (17.6% dark family, 12.3% nightfall, 11.2%
  daylight base, 24% noon; a wide horizontal ellipse, 140% × 60% of the viewport). **The glow is
  built from eleven `@property`-registered parts** (`--page-glow-y` / `-w` / `-h`, colours
  `-c0`..`-c3`, stops `-p1`..`-p3`, `-end`; registered at the top of styles.css AND mobile.css),
  because a gradient cuts on a theme change while typed custom properties interpolate.
  `:root` derives the four colour stops from `--page-glow-color` / `--page-glow-strength` on the
  straight line to transparent, so a theme that sets only those two paints the same two-stop
  wash as before. **`html[data-glow-turn]` transitions the parts, on its own 2 s clock** — keyed on the attribute
  only a theme change sets (`_markGlowTurn`), NEVER on bare `html`: the app pages apply the saved
  theme from app.js at the end of `<body>`, after a first style pass with no `data-theme`, so an
  always-on transition played the dark base's glow into the real one on every page load (sky blue
  fading to noon's yellow; the night glow sliding in on nightfall) — user-reported, then measured
  live with a page-load sampler. The noon / morning / afternoon rules only narrow the list or set a
  duration, which does nothing without it (ease-in-out,
  no phase easing), NOT `html[data-theme-fading]` and not the 800 ms crossfade: at 800 ms the
  light moved while the whole page swung from white to indigo and could not be seen, and the
  fading attribute comes off at 880 ms, which would CANCEL a longer transition (a property
  leaving `transition-property` jumps to its end). So the palette and the band land together and
  the light drifts on after them. Verified live in the dev app over CDP, not only in a frozen
  mock. **Morning
  sets the parts, never a whole `--page-glow`: a sunrise rising from the BOTTOM centre**
  (y 100%, 140% × 75%, a warm-white core through gold into an orange haze that is gone by
  mid-screen; lightness is what reads on its mid-tone parchment, and the accent, a vivid orange
  alone and pale gold all vanished into it). So the turn to noon climbs the sun from the bottom
  edge to noon's top wash over the glow's 2 s, and ROUNDS on the way: morning's oval → a
  circle by 12.5% (0.25 s), HELD round to 75% (1.5 s), at CONSTANT width — only `--page-glow-h`
  moves, up to the oval's own width (`140vw`; a `65vmin` circle read as the glow narrowing) — → noon's oval, as the `page-glow-round` keyframe animation on
  `html[data-glow-turn="morning-noon"]`. A transition only runs start → end, so a mid-point shape
  needs keyframes. The theme script (`_markGlowTurn`, both app.js files) holds `data-glow-turn`
  (`"<from>-<to>"`) for `GLOW_MS` = 2000, because `data-theme-fading` comes off at 880 ms and
  would cut the animation short; the noon rule leaves `--page-glow-w` / `-h` out of its
  transition list, because a running transition outranks an animation and would flatten the
  circle. **The main glow's size is in viewport units (`140vw 75vh` etc.), registered as
  `<length>`, never percentages**, though both paint the same oval: Chromium rejects a
  `radial-gradient` ellipse size that mixes percent and length (`calc(70% + 230px)`), which is
  what a %-to-vmin animation passes through, and it drops the WHOLE background to `none`, both
  glows gone for the turn. Caught live over CDP; a frozen-mock check never sees it. A theme that overrides `--page-glow` whole goes back to cutting.
  **Nightfall's glow is a second, SLIDING layer** (`--night-glow`, moonlight blue `#6d97ff` at
  12.3% at rest, with four registered parts: `--night-glow-x`, its size `--night-glow-w` /
  `--night-glow-h`, and `--night-glow-c`, ONE `<color>`: WHITE at 35% parked on noon
  (`rgba(255,255,255,.35)`, the entry; the `:root` default), and the moonlight blue on nightfall
  AND parked on morning, so the exit never changes colour (by the user's call; it whitened to 50%
  before). Morning → noon swaps blue for white unseen, the glow off-screen and the noon rule not
  transitioning it. That blue is the old electric `#2f6bff` with 30% white mixed in (`#6d97ff`,
  still 12.3%), duller and closer to moonlight, at the user's call.
  Parked it is also HALF size (70% × 30% desktop, 90% × 33% phone, against 140% × 60% /
  180% × 66%): the white light slides in small and grows to the full wash as it cools to blue,
  and shrinks, still blue, as it leaves. A stronger blue was tried first and still
  read as nothing over the grounds crossed mid-turn. Size and colour take a gentle sine curve
  (`cubic-bezier(0.37, 0, 0.63, 1)`) so they change evenly across the whole 2 s both ways (a
  late/early colour curve was tried and replaced at the user's call); position keeps the
  ease-in-out on the way in and takes its exact REVERSE on the way out
  (`cubic-bezier(0.8, 0, 0.6, 1)`, in the morning rule), so the exit is the entrance played
  backwards. On the same curve both ways the exit looked ~40% faster — big and already on screen,
  so you saw the fast middle, gone in 1.05 s against the entrance's 1.46 s on screen; mirrored,
  both are on screen 1.46 s. The curves are per-property lists in `transition-property` order with the night
  glow's size and colour LAST, because a rule with a shorter property list (noon's) cuts the
  inherited list to fit); nightfall turns the main glow off
  (`--page-glow-strength: 0%`) and centres it. It is parked just past an edge everywhere else:
  left on noon (−100% desktop / −130% phone) and right on morning (200% / 230%). **The afternoon
  waypoint carries NIGHTFALL's glow values** (main strength 0%, y −45% / −50%, night x 50%,
  strength 12.3%), never half-way ones: the turn from noon starts ONE 2 s glow transition on its
  first leg, and the second leg changes nothing, so it runs on unbroken. That one transition is 2.5 s, not 2 (`html[data-theme="afternoon"] { transition-duration: 2500ms }`, by the user's call: the 1.6 s palette was right, the glow wanted half a second more). A half-way value
  restarts the glow at 800 ms and lurches. "Just past"
  matters: the visible radius is 70% of the ellipse's horizontal radius (~98% of the width
  on desktop, ~126% on the phone), and parking further out spends the fast first half of the
  ease off-screen. The afternoon waypoint keeps noon's sunlight HUE (`#ffc928`), not its clay
  accent, so the fade never turns into a colour change — and noon's glow RISES UP AND AWAY while
  it fades: nightfall (and afternoon) park the transparent main glow above the top edge
  (`--page-glow-y` −45% desktop / −50% phone, just clear of a visible half-height of 42% / 46%). The night glow's HUE never changes during
  any of this; its position and strength move, and the ground under it is crossfading too. Two destination rules say
  what must NOT move, each a jump made while the jumping thing is invisible:
  `html[data-theme="noon"]` drops `--night-glow-x` (back from the right edge to the left; animated it
  would sweep the page), `html[data-theme="morning"]` keeps only the four colours and the
  night glow's two parts (keyed on the destination theme alone, since the transition outlives the
  fading attribute; a transition takes its property list from the after-change style) (the transparent main glow takes the sunrise's shape at once and fades up in
  place while the blue slides out right). Because the glow is two layers, `body` sets
  `background-repeat` / `background-attachment` as LONGHANDS — in the shorthand, `no-repeat fixed`
  binds to the layer it follows and the other would scroll and tile. A sticky band pinned at the top of the page sits exactly where the
  glow is brightest, so `.page-header-sticky` is BLURRED and UNFILLED — a bare `blur(20px)`, no
  tint. A 70% `--color-bg-secondary` tint was tried and rejected on 2026-10-04: it read as a
  dark box sitting on the glow. With no tint the blur can't be seen at rest (blurring a smooth
  gradient changes nothing) and only smears a widget once it scrolls under the bar. It must NOT
  borrow `--panel-glass-blur`'s `saturate()`: saturation deepens the glow's colour under the bar
  and the box reappears with no fill at all. The blur is on its `::before`, never on the element:
  a `backdrop-filter` makes its element the backdrop root of everything inside it, and the
  frosted "Dashboards ▾" menu that drops out of that header would then blur only the header and
  go clear over the widgets. Any new sticky bar follows the same `::before` pattern. The phone
  carries the same recipe (canon-mobile.md § Elevation and the page glow).
- **The sidebar is frosted glass** (since 2026-10-04): `--rail-glass-bg` (its own
  `--color-bg-tertiary` at 40%, 30% daylight — ten points under `--panel-glass-chrome`, a token of its own so the modal header bands are not moved with it) + `--panel-glass-blur`, so the page glow shows through
  the rail. The blur is on `.sidebar` ITSELF, the one exception to the `::before` rule, because
  the rail scrolls (`overflow-y: auto`) and an absolute pseudo-element would scroll away with the
  nav. That is safe only while nothing frosted or `position: fixed` mounts inside the sidebar —
  every menu, popover and tooltip appends to `body` today. A flyout added INSIDE the rail would be
  backdrop-rooted to it (its glass goes clear over the page) and positioned against it; mount it
  on `body` instead.
- **Cards wear the sidebar's glass** (since 2026-10-04): `.card`, `.kpi-card`,
  `.integration-card`, `.empty-state-card`, `.settings-card` and `.dashboard-widget` paint
  `--card-bg`, which is `var(--rail-glass-bg)`, so a change to the rail's tint moves the cards with it. The user asked for the cards to match the
  navigation rail, not the other way round. A one-commit attempt to paint the rail in the cards'
  `--color-bg-primary` was reverted. Cards take the TINT WITHOUT THE BLUR: behind them is only
  the page ground and the glow, and blurring a smooth gradient changes nothing. A
  `backdrop-filter` on a card would also make it the containing block and backdrop root for its
  widget menus and Leaflet panes. A new page-level card takes `--card-bg`. `.chart-box` does NOT,
  because it lives inside the frosted asset slide-over, where a translucent plot is a window onto
  the page (the `.tag-picker` / `.topology-info` lesson above).
- **List tables wear it too** (since 2026-10-04): `.table-wrapper` and `thead th` paint
  `--rail-glass-bg` (the two tints stack, so the header still reads a step denser than the
  rows). The wrapper takes the tint without a blur, for the same reasons as the cards. A sticky
  header needs a blur to hide the rows scrolling under it, and that blur lives on `thead::before`
  (canon-tables-lists.md § frozen header). Inside `.modal` / `.slideover` a table keeps its
  opaque `--color-bg-primary` / `--color-bg-tertiary` grounds.
- **So do the table's tabs and bulk bar.** The idle `.bulk-bar` and the `.table-tab:hover` /
  `.table-tab-add:hover` states take `--rail-glass-bg`. The active `.table-tab` and the selected
  `.bulk-bar` take `--chip-glass-bg` (`--color-bg-elevated` at 70% in the dark family; `--color-surface` at 55% on the daylight base, because the surface mix all but vanished on nightfall's near-black), so they still stand out. Active tabs add a `--color-border` hairline and an inset top rim, with `--panel-glass-blur`
  on top. The bulk bar is sticky and the table scrolls under it, so its blur is real; it lives
  on `.bulk-bar::before`, because the bar's Type / State / Monitoring menus are frosted and a
  `backdrop-filter` on the bar would backdrop-root them. A tab holds nothing frosted or fixed,
  so its blur is on the tab itself. A page's `.page-tabs` strip opts into the same look with
  the `.page-tabs-glass` modifier: rounded-top chips, glass on hover, and the frosted
  surface chip with the accent underline when active. The strip scrolls instead of wrapping.
  Every page-level strip wears it: Automations (`#auto-tabs`), Server Settings
  (`#settings-tabs`), IPAM (`#ipam-tabs`) and Integrations (`#integration-tabs`). The
  Dashboard's own `.dashboard-tab` strip (rendered by `dashboard.js`) copies the same rules
  rather than the modifier, because its tabs carry a grip, rename input and remove button. It
  is a modifier, not a change to `.page-tab`, because that class is also every modal's tab
  strip.

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
