Polaris UI is a **CSS design system, not a component library.** `components/bundle.js`
exports nothing — build with plain semantic markup and the class vocabulary below, and
`components/bundle.css` does the rest. Never invent a class name, and never write a raw
hex value: every colour, radius and shadow goes through a token.

This is the **desktop kit**. The phone app is a separate Material 3 application with its
own system, [Polaris Mobile](https://claude.ai/artifact/U1moTSRwvzveB4xQpmLLed) — not a responsive version of this one. The two share a
stored theme preference and an accent seed and nothing else, so never mix their classes
or tokens on one screen.

## Required setup

Set a theme on the root element — the kit never renders unthemed, and nothing is styled
on `:root` alone:

```html
<html data-theme="nightfall">
```

`bundle.css` answers to three theme ids: `morning` (warm parchment), `noon` (near-white,
highest contrast) and `nightfall` (the dark default). Fonts are **Inter** for UI text and
**Roboto Mono** for identifiers; `bundle.css` fetches both from Google Fonts in its first
line, so there are no font files to host. The root font size is **14px** — every `rem`
below is measured at that size.

## Themes

Three themes in `tokens.json`, the three application markup sets: `nightfall` (the dark
default), `morning` (amber parchment, the softest contrast) and `noon` (neutral
near-white, the highest contrast). In the stylesheet the dark base sits on `:root` and
`nightfall` refines it; `morning` and `noon` share a daylight block and each refine that.
`tokens.json` lists each theme's resolved values, generated from the stylesheet on every
sync. The stylesheet also declares `afternoon`, a transit palette the theme band fades
through between noon and nightfall. It is never a stored theme, so it is not listed.

## Colour

Surfaces stack in four steps, and the step decides the text token, not the other way
round:

| Ground | Use it for | Text on it |
|---|---|---|
| `color-bg-secondary` | the page itself, sticky headers | `color-text-primary` |
| `color-bg-primary` | panels, cards, tables, `.btn-secondary` | `color-text-primary`, `color-text-secondary` |
| `color-bg-tertiary` | sidebar, `thead`, modal and slide-over chrome, `code` | `color-text-secondary`, `color-text-tertiary` |
| `color-surface` | menus, tooltips, the active tab and bulk bar | `color-text-primary` |
| `color-bg-elevated` | dashboard popovers and row hover | `color-text-primary` |

Edges are `color-border` by default and `color-border-light` only for separators *inside*
a surface (table rows, pagination rules). Tints are two and only two:
`color-hover-tint` for pointer feedback and `color-fill-subtle` for static faint fills.

`color-accent` and `color-primary` hold the same value and must stay in step — the sheet
uses `accent` for links, the active nav item and the `.btn-primary` fill, and `primary`
for spinners, tab dots and focus outlines. Status is `color-success`,
`color-warning`, `color-danger` (with `color-danger-hover`), `color-deprecated` for
retired states, and `color-sev-serious` / `color-sev-notice` for the two severity steps
below danger. Reuse the closest one; do not mint a colour.

Status colours are told apart by hue, and the success/danger pair does not separate on
lightness in any theme — every status in this system therefore carries a word, a badge
label or an icon as well. Keep that rule when you add one.

Several pairings fall below 4.5:1 and are kept exactly as the app has them rather than
re-tinted here: `color-text-tertiary` on `color-bg-primary`, `color-accent` as link text
on the daylight themes, `color-warning` as text on the daylight themes, and
`color-deprecated` everywhere. Put nothing a reader must actually read in
`color-text-tertiary` or `color-deprecated`, and check any other pairing against the
published values rather than this text.

Severity has its own ladder, `color-sev-notice`, `-informational`, `-warning`, `-serious`
and `-critical`, used by severity badges, widget pills and severity selects. It is a
separate set from the status colours because on the daylight themes the accent is amber
or rust, and an informational pill in the accent read as a fourth orange.
`color-brand-red` is the brand mark's red (the active sidebar icon), never a status.

## Type

One family for everything (`font-sans`, Inter), one for identifiers (`font-mono`, Roboto
Mono). `font-mono` is not decorative: it marks IPs, MACs, serials and IDs, through
`.mono` on a cell or `code` inline. The sheet's own sizes, none of which is a token:

- Body — `font-sans`, inherited size, `color-text-primary`
- `.card-title` — 0.75rem, 600, uppercase, 1px letter-spacing, `color-text-secondary`
- `.kpi-value` — `font-mono`, 1.75rem, 700, line-height 1
- `.kpi-label` — 0.68rem, uppercase, 1px letter-spacing, `color-text-tertiary`
- `.badge` — 0.72rem, 600, capitalize, 2px 8px, 99px radius
- `.mono` / `td.mono` — `font-mono`, 0.82rem
- `.hint` — 0.72rem, `color-text-tertiary`
- `.empty-state` — 0.9rem, `color-text-tertiary`

Ten of these are now registered as type styles in `tokens.json` — `body-copy`,
`card-heading`, `column-head`, `metric-value`, `metric-label`, `pill-label`,
`field-label`, `identifier`, `hint-text` and `empty-message` — alongside the original
`code`. Each is named so it collides with no class in `bundle.css`, and its size is the
sheet's rem value converted at the 14px root.

## Shape, elevation and spacing

Three desktop radii: `radius-sm` (4px) for small controls, `radius-md` (8px) as the
default, `radius-lg` (12px) for large panels — `.card`, `.table-wrapper`, `.modal`.
Shadows by what the surface is: `shadow-card` for a big opaque box that rests on the page
(every card, dashboard widget, table, canvas and `.chart-box`), `shadow-control` for small
chrome (buttons, inputs, tabs), `shadow-pill` for badges and widget pills, and `shadow-md`
for anything that floats over the page (menus, dropdowns, modals, toasts). `shadow-sm` is
retired; it was invisible under a wide card on the daylight themes. A panel gets a border
*and* its shadow, never a shadow alone.

Padding is set by the component, not by a scale — `.main` supplies 2rem 2.5rem, `.card`
1rem 1.25rem, `.badge` 2px 8px. The only layout token is `sidebar-width`
(220px).

## Page shell

```html
<div class="layout">
  <aside class="sidebar"><nav class="sidebar-nav">…</nav></aside>
  <main class="main">
    <div class="page-header">
      <h2>Page Title</h2>
      <div class="page-header-actions">…buttons…</div>
    </div>
  </main>
</div>
```

`.layout` centres the app in a column whose width is one token, `--layout-max-width`: a
16:9 column by default, so it is never full-bleed on an ultrawide monitor. Each browser can
switch it to 16:10 or Auto (`data-layout` on `<html>`), and slide-overs align to the same
column. **Do not add your own page-level max-width or centring wrapper.** The sidebar is `sidebar-width`, sticky and full height. `.main` brings its own
padding. Sticky variant of the header: `.page-header-sticky`.

## Component vocabulary

- **Buttons** — `.btn` plus one of `.btn-primary` (accent fill, dark text; one per header,
  at the far right of `.page-header-actions`), `.btn-secondary` (the default),
  `.btn-danger`, `.btn-warning`, `.btn-success`. Add `.btn-sm` inside table rows, bulk
  bars and pagination. `.btn-icon` for a bare glyph. Dropdown:
  `.btn-dropdown-wrap > button + .btn-dropdown-menu`, with `.dropdown-heading` and
  `.dropdown-divider` inside. `.btn-secondary` is filled with `color-bg-primary`, so it
  recedes inside a `.card` of the same colour — demonstrate and use it on the page ground.
- **Tables** — the centrepiece, and **the `<table>` itself carries no class**: it is styled
  by element selector inside `.table-wrapper.table-wrapper-sticky > table > thead/tbody`.
  Checkbox column `th.cb-col`; identifiers get `.mono`; the row tied to an open panel is
  `tr.row-panel-active`; cell buttons live in `td.actions`. Empty and loading states are
  one row of `<td colspan="N" class="empty-state">`. The selection bar above the table is
  always present — `.bulk-bar.bulk-bar-idle > .bulk-bar-count`, dropping `-idle` once rows
  are selected. View tabs: `.table-tabs > .table-tab`.
- **Badges** — `.badge` plus a semantic variant: `badge-active`, `badge-available`,
  `badge-reserved`, `badge-expired`, `badge-conflict`, `badge-deprecated`,
  `badge-released`, `badge-decommissioned`, `badge-disabled`, `badge-maintenance`,
  `badge-admin`, `badge-readonly`, `badge-v4`, `badge-v6`,
  `badge-level-info|warning|error|critical`. Reuse the closest; don't mint colours. Add
  `.badge-clickable` when the pill is a control.
- **Cards & metrics** — `.card > .card-title`; `.kpi-grid > .kpi-card > .kpi-label +
  .kpi-value`, the grid being `repeat(auto-fit, minmax(180px,1fr))` at 10px. Utilisation
  bars are `.util-row > .util-bar-track > .util-bar-fill`.
- **Forms** — `.form-group > label + control + .hint`. Controls are full-width by default;
  don't restyle them per page. Read-only value `.form-value`, locked field
  `.field-locked`, toolbar cluster `.filter-bar`, inline pair `.form-row`. Multi-column
  forms use an inline `display:grid`, not new classes.
- **Modals** (forms and confirmations) — `.modal-overlay > .modal > [.modal-header,
  .modal-body, .modal-footer]`. The header is `color-bg-tertiary` with an `h3`. Footer
  buttons are right-aligned: Cancel (`.btn-secondary`) then the primary action; a third
  action (Test Connection, Back) goes at the far left. Widths: `.modal` 480px,
  `.modal-wide` 672px, `.modal-large`, `.modal-xl`. Four shapes, all on the Modal page: a
  form; a tabbed dialog (`.modal-body > .page-tabs > .page-tab` + `.page-tab-panel`, the tab
  strip pinned to the top of the body); a wizard (`.modal-body > .stepper >
  .stepper-step > .stepper-num` joined by `.stepper-line`, then one `.step-panel.visible`;
  steps take `.active`, `.done`, `.clickable`); and a confirmation on its OWN overlay at
  z-index 1300 over the dialog that asked.
- **Slide-overs** (entity detail, page stays usable) — `.slideover-overlay > .slideover >
  .slideover-header > .slideover-header-top` (h3 + close) `+ .slideover-meta`, then
  `.slideover-body`, `.slideover-footer`. The panel deliberately is not `aria-modal` and
  has no focus trap. **`.slideover-body` has zero padding** — wrap its content in one
  padded div (`padding: 1rem 1.25rem 1rem 2.5rem`). Tabs live IN the header, so they stay
  put while the body scrolls: `.slideover-header > .slideover-tabs > .page-tabs >
  .page-tab`. Each tab is a stack of sections whose heading names the polling source (a
  `.badge-readonly`), the freshness ("updated 40s ago", `color-warning` once a cadence is
  missed), and right-aligned range buttons when the section holds a chart.
- **Dashboard widgets** — `article.dashboard-widget > .dashboard-widget-header >
  .dashboard-widget-title` (one ellipsized line, severity count pills at its head) `+
  .dashboard-widget-action` buttons, then `.dashboard-widget-body`. Two body shapes: a
  ranking of `.recent-item` rows (name, a `.util-bar-track` bar, the value) and a list of
  `.dash-alert-item > .dash-alert-row > .dash-alert-body > .dash-alert-title +
  .dash-alert-sub`, with `.dash-alert-time` on the right and optional
  `.dash-alert-group-header` groups. Severity pills: `.widget-pill` plus
  `widget-pill-neutral` (notice), `-watch` (informational), `-amber` (warning), `-orange`
  (serious), `-red` (critical), `-ok`. Widgets sit 3, 4, 6 or 12 columns wide on a
  12-column canvas, 280 / 576 / 872px tall.
- **Charts** — hand-drawn inline SVG inside a `.chart-box`, under a section heading with
  `.btn-sm` range buttons (the active range is `.btn-primary`) and a stats line ("**N**
  samples · **Avg:** …"). **The chart palette is the one place raw hex is correct:** the
  phone charts and the alert emails draw the same marks, and a mail client has no theme. A
  missed poll is `#d32f2f` (red), dependency-down `#9aa0a6` (grey), a not-yet-verdict miss
  `#ffc107`, recovering `#0288d1`, maintenance a `#9575cd` band, packet loss a dashed
  `#ab47bc` line on a right-hand axis. Every other series uses tokens, and no data series
  may ever be red or grey. Colour the SVG inline, never through a class: the screenshot
  button sees no stylesheet.
- **Alert email** — the third surface, on its own page: a 600px table layout, a fixed light
  palette and inline styles only, because a mail client has no theme and strips
  stylesheets. The page is rendered at every sync from the template the app sends, so it
  is always the real email; none of this kit's classes apply inside it.
- **Small parts** — `.spinner`, `.toast`, `.empty-state`.

Choose between the two overlays by intent: a modal for a form or a confirmation, a
slide-over for a detail view the user reads while working the page underneath.

## Z-index — extend the ladder, never hand-pick

sticky `thead` 10 · filter bar 20 · column gear 30 · global search 900 ·
`.modal-overlay` 1000 · `.slideover-overlay` 1050 · popovers 1100–1200 · confirm 1300 ·
toast 2000 · blocking overlay 2100. Never `9999`. Two rules in `bundle.css` break this —
`.mac-tooltip` at 9999 and `body::before` at 99999 — and are the exceptions, not the
pattern.

## Iconography

Icons are **inline SVG**; no icon font and no sprite ship with the system, so the
consumer supplies the marks. The host sets the size and opacity: 18px in `.sidebar-nav`,
`.sidebar-bottom-link` and `.theme-toggle`, held at 0.7 opacity until the item is active;
16px in dropdown rows (`.btn-dropdown-menu button.has-icon`, 0.65 until hover) and in
`.cert-icon`. The sheet sets no fill, and `.cert-icon` colours its glyph through `color`,
so draw icons in `currentColor` and set the parent's colour token — never hardcode a
fill. Nothing sizes a glyph inside `.btn` or `.btn-icon`; the showcase pages use text
glyphs there, `×` to close and `▾` for a dropdown. No emoji anywhere in the UI.

## Copy

Sentence case. No ALL CAPS in body copy (the uppercase in `.card-title` and `.kpi-label`
is applied by CSS, not typed), and no exclamation marks. Buttons read `+ Add Thing`,
`Save`, `Cancel`, `Delete selected`. Badge labels are one or two words. Hints are a
sentence: "Must be unique across the site."

## The phone app

The phone app is documented in its own system, [Polaris Mobile](https://claude.ai/artifact/U1moTSRwvzveB4xQpmLLed): the Material 3
palette, shape scale, type ramp and components. Six class names exist in both —
`.btn`, `.btn-success`, `.empty-state`, `.spinner`, `.fg-cluster` and `.fg-marker` — and
mean different things in each; the class here is the desktop one. If the accent
`color-accent` is ever re-seeded, the phone palette was derived from it and must be
re-derived with it.

## Reading the source

This system is published from the Polaris repository and is read-only here: change the
repo and re-sync. `components/bundle.css` is `public/css/styles.css`, the stylesheet the
desktop app itself serves, published verbatim behind the Google Fonts import. It is
authoritative and carries its own token declarations, so it always matches the app; read
it before styling anything unusual. `tokens.json` lists the same values with usage notes,
generated from that file. The pages under `components/<Name>/preview.html` (sources in the
repo's `design/desktop/`) are real rendered markup against that sheet: copy from them
directly rather than retyping the classes.
