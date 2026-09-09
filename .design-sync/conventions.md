# Polaris UI — how to build with it

This is a **CSS design system, not a component library.** There is no JS bundle and
nothing to import. You build with plain semantic markup and the class vocabulary
below; `styles.css` does the rest. Never invent a class name, and never write a raw
hex value — every colour, radius and shadow goes through a token.

## Required setup

Set a theme on the root element. **The kit never renders unthemed** — pick one of
`morning` (warm parchment), `noon` (near-white, highest contrast) or `nightfall`
(the dark default):

```html
<html data-theme="nightfall">
```

Fonts are Inter (UI) and Roboto Mono (identifiers), both pulled in by `styles.css`.

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

`.layout` centres the app in a 16:9 column (`max-width: calc(100vh*16/9)`). **Do not
add your own page-level max-width or centring wrapper.** Sidebar is 220px
(`--sidebar-width`). Sticky variant: `.page-header-sticky`.

## Tokens

| Family | Names |
|---|---|
| Surfaces | `--color-bg-primary` (panels/cards/tables), `--color-bg-secondary` (page ground), `--color-bg-tertiary` (sidebar, thead, modal chrome), `--color-surface`, `--color-bg-elevated` (popovers, row hover) |
| Tints | `--color-hover-tint` (pointer feedback), `--color-fill-subtle` (static faint fills) |
| Borders | `--color-border`, `--color-border-light` |
| Text | `--color-text-primary`, `--color-text-secondary`, `--color-text-tertiary` |
| Accent | `--color-accent` (= `--color-primary`), `--color-accent-hover` |
| Status | `--color-success`, `--color-warning`, `--color-danger`, `--color-danger-hover`, `--color-deprecated`, `--color-sev-serious`, `--color-sev-notice` |
| Shape | `--radius-sm` 4px, `--radius-md` 8px, `--radius-lg` 12px, `--shadow-sm`, `--shadow-md` |
| Type | `--font-sans`, `--font-mono` |

## Component vocabulary

- **Buttons** — `.btn` plus one of `.btn-primary` (accent fill, dark text; one per
  header, far right), `.btn-secondary` (the default), `.btn-danger`, `.btn-warning`,
  `.btn-success`. Add `.btn-sm` inside table rows, bulk bars and pagination.
  `.btn-icon` for a bare glyph. Dropdown: `.btn-dropdown-wrap > button +
  .btn-dropdown-menu`, with `.dropdown-heading` / `.dropdown-divider` inside.
- **Tables** — the centrepiece, and **the `<table>` itself carries no class**; it is
  styled by element selector inside a wrapper:
  `.table-wrapper.table-wrapper-sticky > table > thead/tbody`. Checkbox column
  `th.cb-col`; empty and loading states are one row of
  `<td colspan="N" class="empty-state">`; identifiers get `.mono`; row tied to an
  open panel is `tr.row-panel-active`; cell buttons live in `td.actions`.
  Selection bar above the table is always present: `.bulk-bar.bulk-bar-idle >
  .bulk-bar-count`, dropping `-idle` once rows are selected. View tabs:
  `.table-tabs > .table-tab`.
- **Badges** — `.badge` (pill, uppercase-ish, 0.72rem/600) plus a semantic variant:
  `badge-active`, `badge-available`, `badge-reserved`, `badge-expired`,
  `badge-conflict`, `badge-deprecated`, `badge-released`, `badge-disabled`,
  `badge-maintenance`, `badge-admin`, `badge-readonly`, `badge-v4`, `badge-v6`,
  `badge-level-info|warning|error|critical`. Reuse the closest; don't mint colours.
  `.badge-clickable` when the pill is a control.
- **Cards & metrics** — `.card > .card-title`; `.kpi-grid > .kpi-card >
  .kpi-label + .kpi-value` (value is mono, 1.75rem, 700); utilisation bars are
  `.util-row > .util-bar-track > .util-bar-fill`.
- **Forms** — `.form-group > label + control + .hint`. Controls are full-width by
  default; don't restyle them per page. Read-only value `.form-value`, locked field
  `.field-locked`, toolbar cluster `.filter-bar`, inline pair `.form-row`.
  Multi-column forms use an inline `display:grid`, not new classes.
- **Modals** (forms + confirmations) — `.modal-overlay > .modal >
  [.modal-header, .modal-body, .modal-footer]`. Header is `--color-bg-tertiary`
  with an `h3`. Footer buttons right-aligned, Cancel (`.btn-secondary`) then the
  primary action.
- **Slide-overs** (entity detail, page stays usable) — `.slideover-overlay >
  .slideover > .slideover-header > .slideover-header-top` (h3 + close) `+
  .slideover-meta`, then `.slideover-body`, `.slideover-footer`. **`.slideover-body`
  has zero padding** — wrap its content in one padded div
  (`padding: 1rem 1.25rem 1rem 2.5rem`).
- **Small parts** — `.spinner`, `.toast`, `.empty-state`.

## Z-index — extend the ladder, never hand-pick

sticky thead 10 · filter bar 20 · column gear 30 · global search 900 ·
`.modal-overlay` 1000 · `.slideover-overlay` 1050 · popovers 1100–1200 ·
confirm 1300 · toast 2000 · blocking overlay 2100. Never `9999`.

## Copy

Sentence case. No ALL CAPS in body copy, no exclamation marks. Buttons read
`+ Add Thing`, `Save`, `Cancel`, `Delete selected`.

## Read the source

`styles.css` and its imports (`css/polaris-ui.css`) are authoritative — read them
before styling anything unusual. The preview cards under `components/` are real
rendered markup you can copy directly.
