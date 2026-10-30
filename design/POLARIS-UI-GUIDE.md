# Polaris UI Kit — hand this to Claude Code

Paste this file (or point Claude Code at it) at the start of any new app that
should look like Polaris. It is the **visual and interaction contract**: shell,
tables, modals, slide-ins, badges, forms, z-index. It contains none of Polaris's
domain logic (asset discovery, IPAM, topology, monitoring) — build whatever the
new app does, but render it with exactly these parts.

> **Maintained in the Polaris repo** (2026-10-26). The look itself is published as two
> design systems built from the repo: **Polaris UI** (desktop, plus the alert email) and
> **Polaris Mobile** (the phone), whose READMEs and example pages under `design/desktop/` and
> `design/mobile/` are the short form of this guide. Where this guide and the Polaris app
> disagree, the app wins; some sections below predate its latest changes.

## What to copy into the new app

The separate kit copies (`css/`, `js/`, `email/`, the page templates) were retired on
2026-10-26; they had drifted from the app. Copy from the Polaris app itself:

| From the Polaris repo | To the new app | Change it? |
|---|---|---|
| `public/css/styles.css` (the Polaris UI system's `bundle.css`) | `public/css/styles.css` | **No.** Verbatim. Add new rules in a separate `app.css` loaded after it. It carries Polaris-only rules too; they are harmless unused. |
| `public/js/theme-init.js` | `public/js/theme-init.js` | No |
| `public/js/table-sf.js` | `public/js/table-sf.js` | **No.** Verbatim. |
| the modal, slide-over and toast helpers in `public/js/app.js` (`openModal`, `closeModal`, `PolarisPanels`, `showToast`) | your own small helper file | Port them; `app.js` itself is Polaris-specific |
| a page from the Polaris UI system (PageShell) | each page | Yes — that's the point |
| `design/img/brand/` | your app's images | Replace with the new app's mark |
| `public/css/mobile.css` (the Polaris Mobile system's `bundle.css`) | `public/css/mobile.css` | **No.** Verbatim. Only if the app ships a phone surface. |
| `src/utils/alertEmailTemplate.ts` (the AlertEmail page shows it rendered) | the notification service's default templates | Yes — the tokens are yours to choose |

Rule: **never restyle a component that already exists here.** If a surface
doesn't seem to fit, reach for the closest existing pattern rather than
inventing a new container, palette entry, or z-index.

---

## 1. Design tokens

Every color, radius, shadow, and font goes through a CSS variable. **Never write
a raw hex value in app code** except inside the `rgba()` tints listed below.

```
--color-bg-primary   #151528   panels, cards, tables, modals, slide-overs
--color-bg-secondary #0d0d1a   page background (body)
--color-bg-tertiary  #111122   sidebar, table thead, modal/slideover header+footer
--color-surface      #1e1e36   raised surface / secondary-button hover
--color-bg-elevated  #26264a   popovers, dropdowns, row-hover highlight
--color-border       #252540   default 1px border
--color-border-light #1e1e36   table row separators
--color-text-primary   #e6e6e6
--color-text-secondary #a0a0b3
--color-text-tertiary  #7d7d93  labels, hints, placeholders
--color-accent       #4fc3f7   the ONE brand color (links, focus, active nav, primary btn)
--color-accent-hover #29b6f6
--color-success #00c853   --color-warning #ffd600
--color-danger  #ff1744   --color-danger-hover #d50000   --color-deprecated #757575
--font-sans "Inter", system stack     --font-mono "Roboto Mono", Consolas
--radius-sm 4px  --radius-md 8px  --radius-lg 12px
--shadow-sm 0 1px 4px rgba(0,0,0,.3)   --shadow-md 0 8px 32px rgba(0,0,0,.5)
--sidebar-width 220px
```

`html { font-size: 14px }` — every `rem` in the kit is relative to 14px, so a
`0.85rem` button label is ~12px. Keep the same scale.

The token values above are the dark base (`:root`), which `nightfall` refines.
`morning`/`noon` replace them wholesale from the daylight base. See **1b.
Themes** for the full list and the rules for adding one; theme is stored in
`localStorage["polaris-theme"]` and applied by `theme-init.js` **in `<head>`
before the stylesheet** to avoid a flash.

Tint convention: `background: rgba(<color>,0.12)` + `border: 1px solid
rgba(<color>,0.25)` + `color: var(--color-<semantic>)`.

---

## 1b. Themes

Three themes on `<html data-theme>`, in two families:

| id | family | character |
|---|---|---|
| `morning` | light | warm parchment, burnished-gold accent, softest contrast |
| `noon` | light | near-white, terracotta accent, highest contrast |
| `nightfall` | dark | **default**; indigo ground, sky-blue accent, hot-red danger |

Listed in day order, which is the order the picker shows. Display order and the
default are separate: `DEFAULT_THEME` names the fallback, so reordering the list
never changes what a new or unrecognized install lands on.

There is no plain `light` or `dark` any more. The CSS keeps two *bases* that
are not themes: `:root` (dark, refined by `nightfall`) and the daylight base
`:is([data-theme="morning"],[data-theme="noon"])`, which undoes the
component CSS's light-on-dark assumptions once for both.

Rules:

- **Never hardcode a color.** Every value comes from a token
  (`--color-bg-*`, `--color-surface`, `--color-bg-elevated`, `--color-border*`,
  `--color-text-*`, `--color-accent`/`--color-primary`, `--color-success`,
  `--color-warning`, `--color-danger`, `--shadow-*`). A literal hex is a bug in
  four of the five themes.
- **Tint with `color-mix`**, not a second hardcoded rgba:
  `color-mix(in srgb, var(--color-danger) 12%, transparent)`.
- **Branch on family, not id.** Use `isLightTheme()` when a page picks an image
  or chart palette by brightness — never compare against a theme id. The CSS
  does the same with `:is([data-theme="morning"],[data-theme="noon"])`; match
  that pattern for any new daylight override.
- **Adding a theme** = one `THEMES` entry in `public/js/app.js`, one token block in
  the CSS, one id in `theme-init.js`'s `KNOWN` list. Nothing else.
- `setTheme(id)` persists to `localStorage["polaris-theme"]` and fires a
  `themechange` event on `document` (`detail: {theme, family}`) — listen for it
  to repaint canvases, maps, and charts that cached their colors.
- The sidebar footer control opens the full list via `openThemeMenu()`; past two
  themes a toggle buries the rest. `toggleTheme()` still steps to the next one.
- Unrecognized saved values fall back to `DEFAULT_THEME` (`nightfall`), so a
  user carrying the retired `dark`/`light` id lands somewhere sane rather than
  on an unstyled page.
- With nothing saved, `theme-init.js` follows the OS: `morning` for a light
  preference, `nightfall` otherwise.

---

## 2. Page shell

```html
<div class="layout">              <!-- flex, max-width: calc(100vh * 16/9), centered -->
  <aside class="sidebar" id="sidebar"></aside>
  <main class="main">            <!-- flex:1, padding: 2rem 2.5rem -->
    <div class="page-header">
      <h2>Page Title</h2>        <!-- 1.35rem, 700, UPPERCASE, letter-spacing .5px -->
      <div class="page-header-actions">…buttons…</div>
    </div>
    …content…
  </main>
</div>
```

- **Centering**: the whole app is centered by `.layout`'s
  `max-width: var(--layout-max-width); margin: 0 auto` — a 16:9 column by
  default, 16:10 or Auto by the per-browser Layout setting (`data-layout` on
  `<html>`), never full-bleed on ultrawide. Slide-overs respect it:
  `right: max(0px, calc((100vw - var(--layout-max-width)) / 2))`. Don't add your
  own page-level max-width or centering wrapper.
- **Sidebar**: 220px, sticky, full height, `--color-bg-tertiary`, right border.
  Order: brand block → `.sidebar-nav` → (spacer `margin-top:auto`) → bottom
  links + theme toggle.
- **Logo**: the shipped art is THEME-PAIRED — the wordmark is light blue on the
  dark files and near-black on the light ones, so the wrong file on the wrong
  ground makes the logo disappear. `img/brand/polaris-{horiz,vert,symbol}-{dark,light}.png`:
  **horiz** for a login card, **vert** for the sidebar column, **symbol** (star
  alone) for favicons. `renderSidebar()` paints and maintains it for you; pass
  `logo:` only to override with an operator upload. Elsewhere use
  `watchBrandLogo(img, "login"|"sidebar")` — it picks by theme FAMILY, so
  morning and noon both get the light art with no extra asset, and it repaints
  on `themechange`. Shipped art carries `.brand-mark` (fixed-aspect wordmark,
  no radius, 120px in the sidebar); an operator upload never does, because any
  shape at all has to be sized differently. Asset paths resolve from the
  script's own URL, so the kit works in a subdirectory unchanged.
- `.sidebar-brand` is `text-align: center` with a bottom border;
  `.sidebar-logo` is `width:100%; max-width:70px; margin: 0 auto 6px;
  border-radius:8px`. Logo is always centered and capped at 70px — never
  left-aligned, never a hardcoded pixel size on the `<img>`. An optional
  `<p>` tagline under it renders 0.7rem uppercase, letter-spacing 1px,
  `--color-text-tertiary`.
- **Nav items**: `<a>` with `display:flex; gap:10px; padding:.5rem .75rem;
  border-radius:var(--radius-md)`, 18px stroke SVG at `opacity:.7`.
  Hover `rgba(79,195,247,.08)`; `.active` gets `rgba(79,195,247,.12)`, accent
  text, weight 550, full-opacity icon. Use `renderSidebar()` from
  `public/js/app.js` and let it stamp `.active` from the URL.
- Sticky header variant: add `.page-header-sticky` (z-index 1050, background
  must be `--color-bg-secondary`).

### Sidebar footer (bottom-left)

Fixed vertical order, bottom of the sidebar, pushed down by `margin-top:auto`:

1. **Status panels** — `<div class="query-status">`, one per concern (running
   operations, failed integrations, update state), hidden until they have
   content. Header row = 12px `.query-spinner` + `.query-status-label`
   (`N thing(s) running`, accent, 600). Below it a `.query-status-list`; each
   `<li>` is a flex row of a text block + a red `.query-abort-btn` (`✕`).
   Inside the block: `.query-status-name` (what is running), an optional
   `.query-status-progress` line (`93/200 complete · 2 skipped`), then
   `.query-status-device` lines for the in-flight items — all truncating,
   never wrapping. Panel is `rgba(79,195,247,.06)` on a 1px accent-tinted
   border, `--radius-md`, `margin: 0 .5rem`. Use
   `renderStatusPanel({label, subtitle, progress, items, onAbort})` — e.g.
   label `1 discovery running`, subtitle `Discovering FortiManager`, items
   `FortiGate1`, `FortiGate2`;
   `.query-abort-all-btn` is the full-width variant when several are running.
2. **Divider** — `border-top: 1px solid var(--color-border-light)`.
3. **Bottom links** — `.sidebar-bottom-link` (same geometry as nav items):
   Server Settings (permission-gated), then `.theme-toggle` — labelled with the
   CURRENT theme name and opening the theme menu, not a two-way switch — then
   Logout as
   `.sidebar-bottom-link .sidebar-bottom-link-logout` (red hover).
   Logout is always last and always the only red item.
4. **Version** — `#sidebar-version`, centered, 0.7rem, tertiary,
   `v0.9.1867`.
5. **Update line** — only when an update exists: `#sidebar-update-badge`
   holding `.sidebar-update-link` (accent, centered, pulsing
   `.sidebar-update-dot`) reading `Update available: v0.9.1870`, linking to
   the settings tab that performs the update. Call
   `setSidebarUpdate(version, href)`; pass a falsy version to clear it.

`renderSidebar()` builds 1–4 for you; pass `version`, `updateAvailable`,
`updateHref`, and `onLogout`/`logoutHref`.

### Header actions + user badge (top-right)

`.page-header-actions` is a right-aligned flex row, gap .5rem:
secondary buttons first, the single `.btn-primary` last, then the user badge.

- `.user-badge` — sits after the buttons with `padding-left: .75rem;
  border-left: 1px solid var(--color-border)` so it reads as a separate zone.
- Contents: 30px circular `.user-badge-avatar` with 2 initials on a
  deterministic per-username color, `.user-badge-name` (0.82rem secondary,
  hidden under 768px), and the role as a `.badge` at 0.7rem/1px 6px.
- Never a dropdown menu or caret — the badge is display only; account actions
  live in the sidebar footer.
- Use `renderUserBadge({username, role, roleColor})`; it's idempotent, so it's
  safe to call again after the user fetch resolves.

Icons: 24×24 viewBox, `fill="none" stroke="currentColor" stroke-width="2"`
(Feather-style), rendered at 16px in buttons / 18px in nav. No emoji, no icon
fonts, no filled icon sets.

---

## 3. Buttons

```html
<button class="btn btn-primary">+ Add Thing</button>
<button class="btn btn-secondary">Secondary</button>
<button class="btn btn-danger">Delete</button>
<button class="btn btn-sm btn-secondary">Small</button>
<button class="btn-icon">…</button>
```

- `.btn` — inline-flex, gap 6px, `.45rem .9rem`, 0.85rem/500, `--radius-md`.
- `.btn-primary` — accent fill, **dark** text (`#0d0d1a`), weight 600. One per
  header, at the far right of `.page-header-actions`.
- `.btn-secondary` — `--color-bg-primary` fill, border `--color-border`, hover
  turns border accent. The default for everything else.
- `.btn-danger` / `.btn-warning` / `.btn-success` — tinted, not solid (danger is
  `rgba(255,23,68,.15)` on accent-red text).
- `.btn-sm` for anything inside a table row, bulk bar, or pagination.
- Copy: `+ Add Thing`, `Save`, `Cancel`, `Delete selected`, `Import / Export ▾`.
- Menu entries never end in "…" — `Edit`, `Tags`, `Acknowledge alert` — even when
  they open a dialog. Only a progress state (`Saving…`) keeps one.
  Sentence case, no ALL CAPS, no exclamation marks.
- Dropdown: `.btn-dropdown-wrap > button + .btn-dropdown-menu`, with
  `.dropdown-heading` and `.dropdown-divider` inside for grouped items.

---

## 4. Tables — the centerpiece

Markup (see the Polaris UI PageShell page):

```html
<div class="table-wrapper table-wrapper-sticky" id="x-table-wrapper">
  <table id="x-table">
    <thead><tr>
      <th class="cb-col"><input type="checkbox" id="x-select-all"></th>
      <th data-col-id="name" data-col-required="true"
          data-sf-key="name" data-sf-type="string">Name</th>
      <th data-col-id="status" style="width:130px"
          data-sf-key="status" data-sf-type="string"
          data-sf-options="active|maintenance=Maintenance|disabled">Status</th>
      <th data-col-id="count" data-sf-key="count" data-sf-type="number" data-sf-nofilter>Count</th>
      <th data-col-id="notes" data-sf-key="notes" data-sf-type="string" data-col-default-hidden="true">Notes</th>
      <th data-col-id="updatedAt" data-sf-key="updatedAt" data-sf-type="date">Updated</th>
    </tr></thead>
    <tbody id="x-tbody"><tr><td colspan="6" class="empty-state">Loading...</td></tr></tbody>
  </table>
</div>
```

Wire-up — **order matters**:

```js
var sf     = new TableSF("x-tbody", render);              // 1. sort + filter UI
var layout = setupColumnLayout(table, { onChange: savePrefs }); // 2. resize + gear
```

`TableSF` rewrites each `<th>`'s innerHTML, which wipes the resize handles if
you call `setupColumnLayout` first. Symptom: sorting works, resizing silently
doesn't.

**Re-apply the layout after every wholesale `tbody` re-render.** New `<td>`s know
nothing about hidden/resized columns, so a `data-col-default-hidden` column comes
back as a 0px-wide cell that still holds text — one character per line, rows
hundreds of pixels tall. At the end of your render function:

```js
applyTableLayout(table, "things");                 // tables rebuilt on refresh
// or, when you own the widget instance:
layout.setPrefs(layout.getPrefs());
```

For dynamic tables inside a modal or panel, always prefer
`applyTableLayout(table, "<stable-type-key>")` — key it by table *type*, never by
record id.

### Header attributes

| Attribute | Effect |
|---|---|
| `data-sf-key="dotted.path"` | sortable + filterable; supports `block.name`, `_count.items` |
| `data-sf-type` | `string` (default) · `number` · `date` · `ip` · `array` |
| `data-sf-options="a\|b=Label B\|c"` | multi-select checkbox popover instead of a text box — use for every enum column |
| `data-sf-nofilter` | sortable, no filter control (numeric columns where a box is noise) |
| `data-col-id="name"` | stable column id for resize/visibility prefs — always set it |
| `data-col-required="true"` | can't be hidden (identity + actions columns) |
| `data-col-default-hidden="true"` | ships off; operator can enable in the gear |

### Behavior you get for free

- Per-column sort (caret in the header, accent when active).
- Text filters with an operator chooser: contains / not-contains / empty /
  not-empty. Date columns get a from→to range popover.
- Column resize by dragging the divider on a header's right edge — affects only
  the two adjacent columns; the rightmost resizable column auto-fills.
- Show/hide chooser behind a **gear that floats at the table's top-right corner
  on hover** — this replaced the old "Columns ▾" toolbar button; never add one
  back. Pass `onScreenshot` to get a camera button beside it.
- Cell content truncates with an ellipsis (`table-layout: fixed`). Opt a
  long-prose column back into wrapping with `<td class="cell-wrap">`.
- Frozen header: the `.table-wrapper-sticky` class + `renderPageControls`
  (which calls `sizeStickyTableWrappers()`) bound the wrapper to the viewport so
  it scrolls internally. Inside a slide-over use `.table-wrapper-panel-sticky`
  and your own panel-relative sizer instead — never the viewport one. A table
  that is its whole tab can instead fill the panel with CSS flex and stop the
  panel body scrolling (the asset Events tab).

### Client vs server mode

- **Client-side** (default, up to a few thousand rows): pipe rows through
  `sf.apply(rawData)` before rendering, and never mutate `rawData`.
- **Server-side** (large datasets): keep `TableSF` for the header UI but
  **never call `sf.apply()`**. In `onChange`, read `sf._sortKey`, `sf._sortDir`,
  `sf._filters`, reset the offset, and re-fetch. Multi-select arrays → CSV
  params; text filters → `<field>` + `<field>Op`; date → `since`/`until`; sort →
  `sortBy`/`sortDir`, **whitelisted server-side** (never pass a user string to
  an ORM `orderBy`). Call `sf.setColumnOptions(key, values)` after each fetch
  for operator-extensible enums.

### Table visuals

- `thead th`: 0.72rem, 600, UPPERCASE, letter-spacing 1px, tertiary text,
  `--color-bg-tertiary` background.
- `tbody td`: 0.6rem/1rem padding, bottom border `--color-border-light`.
  Row hover `rgba(79,195,247,.04)`. `.mono` class for IDs/IPs/serials.
- Row tied to an open slide-over: `tr.row-panel-active` (accent inset bar).
- Empty/loading: one row with `<td colspan="N" class="empty-state">`.
- Cell actions go in `<td class="actions">` with `.btn.btn-sm` buttons.

### Pagination + selection

- One row above the table and one below: `<div id="pagination-top"></div>` /
  `<div id="pagination"></div>`, filled by
  `renderPageControls("pagination", total, size, page, onPage, onSize, opts)` —
  grid `1fr auto 1fr`: centered page nav, right-aligned action buttons + the
  "Show N" selector (top row only). No separate "Show" filter bar above the
  table.
- Bulk bar sits between the header and the table and is **always visible**:
  `.bulk-bar.bulk-bar-idle` with a `.bulk-bar-count` label ("No things
  selected"); on selection drop `-idle` (accent outline, buttons enable). Push
  the destructive button right with `margin-left:auto`. The Assets list is the
  exception: its bar is hidden and the selection's verbs are the row's
  right-click menu (right-click anywhere on a row; a selected row of several
  gets the whole selection's verbs).

### Row verbs — a menu on the name, not an Actions column

**The standard row gestures — every table in Polaris whose rows can be opened
or acted on:**

| Gesture | Does |
|---|---|
| Left click on the row | selects it (Ctrl/⌘ toggles, Shift extends, drag selects a range) |
| Left click on the name (the row's primary column) | opens the row |
| Double click anywhere on the row | opens the row, as clicking the name does |
| Right click anywhere on the row | selects it and shows the row's context menu |

All four come from one marker: `<tr data-row-menu-row>` on a row whose name
cell holds the `.row-menu-trigger`. Selection keeps its state on `tr.selected`
(or, on a table with bulk verbs, on the hidden `td.cb-col` checkbox). A new
table adopts all four, never a subset.

Per-row verbs (Open / Edit / Clone / Delete) hang off the row's **name cell**,
never a column of buttons: one affordance, no column competing with the data,
and a verb can be added without re-cutting the layout.

- Trigger: `rowMenuTriggerHTML(name)` → `.row-menu-trigger` — accent text,
  underlined on hover, so it reads as the name until touched. Keep it as the
  first cell's only content.
- **Left click opens, right click is the menu.** Open with
  `showRowMenu(anchor, items, {align, label, menuAt})`; items are
  `{label, onSelect, icon?, danger?, disabled?, title?, primary?}`,
  `{separator:true}`, or `{heading:"…"}`. The `primary` item (the row's Open,
  listed first) is what a plain click does; a right click, the Menu key or
  Shift+F10 on a `.row-menu-trigger` / `[data-row-menu]` shows the whole menu
  at the pointer. A menu with no primary shows on either click. Destructive
  verbs get `danger: true`, go last, and are never primary.
- The menu is `.row-context-menu` — `position: fixed`, body-mounted, z-index
  900. That's deliberate: list tables scroll inside `.table-wrapper-sticky`,
  which clips an absolutely positioned menu. It flips above the anchor near the
  viewport bottom, closes on Escape/Tab/outside-click and on a scroll that
  moved its anchor, does arrow-key navigation, and returns focus on close —
  all handled for you.
- `align: "end"` right-aligns it; use that for a trigger in the page header.

### View tabs above a table

Per-user saved views, each carrying its own filter + sort state: `.table-tabs`
strip (a lighter sibling of `.page-tabs`) directly above the bulk bar, with
`.table-tab` children, `.table-tab-dot` when the view has filters, an inline
`.table-tab-close`, `.table-tab-input` for rename-in-place, and a trailing
`.table-tab-add` `+`. The strip scrolls horizontally — it never wraps to a
second row. Use this instead of a filter-preset dropdown when operators keep
several working sets open at once.

### Saved filter presets

`.saved-filters-menu` is a `.btn-dropdown-menu` whose rows are flex pairs:
`.sfl-load` (name + optional `.sfl-badge` + `.sfl-owner`) plus a trailing
`.sfl-newtab` and `.sfl-del`. Empty state is a single `.sfl-empty` line. The
save dialog uses `.sfl-vis` radio rows (private / shared) and a `.sfl-preview`
block that states exactly what will be saved.

---

## 5. Modals

```js
openModal(title, bodyHTML, footerHTML, options);   // options: {wide|large|xl}
closeModal();
if (await showConfirm("Delete 3 things?")) …       // never window.confirm()
await showFormModal("Add Thing", formHTML, "Create");
```

- Shape: `.modal-overlay > .modal > [.modal-header, .modal-body, .modal-footer]`.
  One shared `#modal-overlay`, reused.
- Widths: default 480px · `wide` 672 · `large` ≤1200 (form + table) ·
  `xl` ≤1360 with zero body padding (full-bleed).
- Header (`--color-bg-tertiary`, h3 1rem/600) is the **drag handle**.
- **Backdrop click does not dismiss** — it flashes the close X. Explicit close
  only, so in-progress edits survive a stray click.
- Escape closes, Tab is trapped, focus returns to the trigger; `role="dialog"`
  + `aria-modal` + `aria-labelledby` are built in.
- Footer buttons right-aligned, gap 8px: Cancel (`btn-secondary`) then the
  primary action.
- Re-bind listeners after every open — the body HTML is replaced wholesale.
- Tabs inside a modal: `.settings-tabs > .settings-tab(.active)` +
  `.settings-tab-panel(.active)`; a `.page-tabs` strip that is a **direct child**
  of `.modal-body` auto-pins sticky.
- Multi-step flows: `.stepper > .stepper-step(.active|.done|.clickable) >
  .stepper-num` + `.stepper-line`, one `.step-panel(.visible)` per step, inside
  a `{large:true}` modal. Validate on Next only; allow jumping back to visited
  steps.

### Integration modals — one shape for all of them

Every "connect us to another system" dialog is the SAME dialog. Build it with
`openIntegrationModal({product, action, tabs, requires, onTest, onSave})` rather
than by hand — hand-built ones drift (Polaris grew seven and ended up with two
tab implementations and three footer orders).

- **Title** is `"<Action> <Product> Integration"` — `Add FortiManager
  Integration`, not a bare `Add Integration`. The operator already chose a
  product to get here; the title should confirm it.
- **Tabs**: General first (identity + connection), Monitoring second where it
  exists, then feature tabs. One tab per concern; a concern with three fields is
  a section inside General, not a tab of its own.
- **Field ids are unique across tabs** (`f-host`, `f-apiToken`) so one pass
  collects the whole form. A per-tab read silently drops anything the operator
  never opened.
- **Footer**: `Test Connection` · `Cancel` · `Create`/`Save Changes`. Test is a
  secondary on the LEFT — it is the rehearsal, not the commitment.
- **Test is gated** on the fields the request actually needs (`requires:
  [["f-host","host"], …]`), and the toast NAMES what is missing. Never fire a
  request you know will fail and report the server's error as if it were news.
- **Saving is never blocked on a passing test.** An operator configuring ahead
  of a firewall change has a legitimate reason to save something that cannot
  connect yet; `onSave` receives `{tested}` if you want to warn.
- Both buttons disable and relabel while in flight (`Testing…`, `Creating…`) —
  these calls reach a remote system and can take seconds.
- `onSave` throwing keeps the modal open with the error in a toast; returning
  `false` keeps it open silently.

---

### Wizards (stepper modal)

Use a wizard ONLY when the task has real sequence — each step narrowing what
the next can offer (the automation builder: basics → scope → trigger →
actions → review). A long but flat form stays one modal with tabs; splitting it
into steps just hides fields behind clicks.

- `createWizard({prefix, steps, onEnter, collect, validate, editing})` →
  `bodyHtml(panels)`, `footerHtml(saveLabel)`, `wire({onSave, onCancel})`,
  `goToStep(n)`, `markAllVisited()`. Feed the body to `openModal(…, {wide:true})`,
  then call `wire()`.
- The `.stepper` strip is the modal-body's FIRST child so the CSS pins it while
  a long step scrolls. Steps are `.stepper-step` (`.active`, `.done`,
  `.clickable`) joined by `.stepper-line` (`.done`); panels are `.step-panel`
  with one `.visible`.
- **Visited steps are clickable.** An operator who typed step 4 wrong should not
  have to walk back through 3 and 2 to fix it. `editing: true` marks every step
  visited and shows Save from any step.
- Footer order: `Cancel`, `← Back`, then `Next →` / the single primary Save.
  Next validates the current step and toasts the problem; it never advances past
  an invalid step silently.
- Steps whose content depends on earlier answers render on ENTRY via `onEnter(n)`,
  not up front — otherwise they show stale options from a scope the operator
  has since changed.
- Each step change resets `.modal-body` scroll to the top.

---

### Off-click, lock, and the bloom hint

A backdrop click is never allowed to silently discard a half-filled form. Two
mechanisms, both already in `public/js/app.js`:

- **Panel lock** — a lock toggle sits immediately left of the X on every modal
  and slide-over header (`.panel-lock-btn`, injected automatically by a
  MutationObserver, accent-colored when engaged). It is global **per type**:
  one switch governs all modals, another all slide-overs, saved per user in
  `localStorage["polaris.panellock.<user>"]`. Locked, a backdrop click keeps
  the panel open; unlocked, it dismisses. The X and Escape always close,
  regardless. Call `initPanelLock({user})` once per page; read the state with
  `isPanelLocked("modal"|"slideover")` anywhere a flow would otherwise close a
  panel the operator pinned open. Call it from the SAME ready path that waits
  for the rest of the runtime (`renderSidebar`/`TableSF`) — calling it before
  the scripts resolve leaves the observer unwired and the preference keyed to
  `anon`. It is safe to call repeatedly and safe to call late; state lives on
  `window.__polarisPanelLock` so a re-evaluated script keeps the lock.
- **Escalating flash + bloom** — when a click is refused, the close button
  answers instead of nothing happening: `flashModalCloseBtn(closeBtn)` flashes
  it brighter on each successive off-click and grows a radial red bloom behind
  it in quarter-size steps (nothing on the 1st click — one stray click is an
  accident — full size by the 5th). A 1s pause resets the escalation. Timing is
  set inline at 0.45s ease-out so the glow and bloom fade together; the bloom is
  a single body-level element at z-index 100000 that re-homes into
  `document.fullscreenElement` when one exists, since the top layer paints over
  fixed elements.

Wire any new overlay's backdrop handler to `flashModalCloseBtn` rather than a
bare `close()` — never leave an off-click doing nothing at all.

---

### Modal form anatomy (the long config modal)

A tall settings form stays ONE modal with tabs — never a wizard, never a new
page. Reading order inside `.modal-body`:

1. **Tab strip** — `.page-tabs` as the body's *first child* so the CSS pins it
   (sticky, horizontally scrollable, flush under the header) with
   `.page-tab` buttons; panels are `.page-tab-panel`, `.active` on one.
   Use `tabbedBodyHTML(prefix, tabs)` + `wireModalTabs(prefix)`. Keep field
   ids unique across tabs so one read pass collects the whole form.
2. **Identity field first** — `Name *` at the top of the General tab.
3. **Info box** — `infoBox(html)`: accent-tinted block stating compatibility /
   scope constraints up front (versions, on-prem vs cloud). Bold the specific
   values inside it.
4. **Section rule + heading** — `formDivider()` then
   `sectionHeading("Connection Settings")` (0.75rem uppercase, 1px tracking,
   tertiary). Sections group 3–8 fields; more than that, add a tab.
5. **Fields** — `.form-group > label + input + p.hint`. Required fields carry a
   literal ` *` in the label. Placeholders are always examples
   (`e.g. fmg.example.com`), never restatements of the label. Hints are one
   sentence, sentence case, no period-stacking; they say where to get the value
   or what the default means.
6. **Paired fields** — a grid, not two form-groups in flow:
   `display:grid;grid-template-columns:1fr auto;gap:8px` (host + port). Narrow
   numerics get an explicit `width:80–90px`.
7. **Checkboxes** — `checkboxRow(id, label, checked)`: `width:auto` box, label
   with `margin:0`, 8px gap. A consequential toggle gets a warning hint
   directly beneath (`p.hint` in `--color-warning`) that names the risk in
   plain language. Use `calloutHTML("warning"|"tip"|"note", title, body)` when
   the note needs a title.
8. **Sub-value of a toggle** — indented number + unit on one flex row
   (`12` + `hours`) with its own hint.
9. **Last section** — low-traffic diagnostics (`DEBUG`) at the very bottom,
   behind its own heading, described honestly (log volume, auto-off).
10. **Footer** — `.modal-footer`, right-aligned: destructive-adjacent /
    utility actions first (`Test Connection`), then `Cancel`, then the single
    `.btn-primary` (`Create` / `Save`). Never two primaries.

---

## 6. Slide-ins (slide-over panels)

Use for entity detail views; a modal is for forms and confirmations. The panel
can stay open while the user works the page underneath.

```
.slideover-overlay > .slideover >
   .slideover-resize-handle
   .slideover-header > [.slideover-header-top (h3 + close btn), .slideover-meta]
   .slideover-body
   .slideover-footer
```

- Enters from the right, `width: clamp(520px, 42vw, 1100px)`, 0.25s transform.
  Build the DOM, then add `.open` on the **next animation frame** or there's no
  animation (`openSlideover()` does this).
- User-resizable from the left edge; persist per surface:
  `initSlideoverResize(panel, "app.panel.width.thing")`.
- Backdrop click closes (check `e.target === overlay`). Escape closes only when
  the panel is topmost. Deliberately **not** `aria-modal` and no hard focus
  trap — it coexists with the page.
- `.slideover-body` is `padding: 0`. **Every** state you render — loading,
  empty, error, populated — supplies its own gutter, and the canonical value is
  `padding: 1rem 1.25rem 1rem 2.5rem` (the extra left matches the header's
  indent past the resize handle). Wrap the whole body content in one padded div.
- Nested panels layer on top; only the topmost closes on its X.
- Cancel every timer in the panel's close function, and gate async writes on
  "is this overlay still open and still the same entity" before touching the DOM.
- Silent refreshes capture/restore `body.scrollTop` around the swap.
- Header/footer are `--color-bg-tertiary`; `.slideover-meta` is a wrapping flex
  row of 0.78rem secondary-text facts.

---

## 7. Badges, pills, small parts

- `.badge` — pill (`radius: 99px`), 0.72rem/600, capitalized, 2px 8px.
  Semantic variants already defined: `badge-active`, `badge-available`,
  `badge-reserved`, `badge-expired`, `badge-conflict`, `badge-deprecated`,
  `badge-released`, `badge-disabled`, `badge-maintenance`, `badge-admin`,
  `badge-readonly`, `badge-level-info|warning|error|critical`, `badge-v4/v6`.
  Reuse the closest one; **don't mint new colors**. New states get a new
  variant following the `rgba(x,.12)` / `rgba(x,.25)` / semantic-text recipe.
- `.badge-clickable` when a pill triggers an action (hover brighten, active
  scale, focus ring).
- Cards: `.card` (`--color-bg-primary`, `--radius-lg`, 1rem 1.25rem,
  `shadow-sm`) with `.card-title` (0.75rem, 600, UPPERCASE, letter-spacing 1px).
- KPIs: `.kpi-grid` (`repeat(auto-fit, minmax(180px,1fr))`, gap 10px) of
  `.kpi-card > .kpi-label + .kpi-value` — value is **mono**, 1.75rem, 700.
- Utilization: `.util-row > .util-bar-track > .util-bar-fill` (6px, pill).
- Toasts: `showToast(msg, "success"|"error")` — bottom-right stack, tinted,
  auto-dismiss 3.5s, with a copy button. Use for every mutation result.
- Blocking overlay (app is briefly unusable, e.g. restart):
  `.blocking-overlay > .blocking-overlay-card` with a `.spinner`. Not
  dismissible — nothing else should use it.
- Spinners: `.spinner` (or `.query-spinner` at 12px in a sidebar panel).

---

## 8. Forms

- `.form-group > label + control (+ .hint)`. Labels 0.8rem/500 secondary;
  hints 0.72rem tertiary.
- Inputs/selects/textareas are full-width by default, `--color-bg-secondary`
  fill, `--radius-md`, 0.85rem, focus = accent border + 2px accent ring. Don't
  restyle them per page.
- Read-only display value: `.form-group .form-value`. Locked field:
  `.field-locked`.
- Filter/toolbar clusters: `.filter-bar` (sticky flex row, uppercase 0.72rem
  labels).
- Grid multi-column forms with a plain inline
  `display:grid; grid-template-columns: 1fr 1fr; gap: 12px` inside the modal
  body — no new classes.

---

## 9. Z-index scheme — extend it, never invent

```
table sticky thead    10
filter bar            20
gear / col wrap       30
global search drop   900
modal-overlay       1000   (1075 when opened from inside a slide-over)
slideover-overlay   1050
monitor popover     1100
sf popovers/chooser 1200
confirm dialog      1300
toast               2000
blocking overlay    2100
```

Never hand-pick `9999`. If something must sit higher, add it to this list.

---

## 10. Copy + content rules

- Page titles: one or two words, uppercase via CSS (write them normally).
- Column headers: short nouns, uppercase via CSS.
- Empty states: plain sentence, no illustration — `"No things yet."` /
  `"No results match these filters."`
- Confirms name the count and consequence: `"Delete 3 things? This cannot be
  undone."`
- Toasts are terse past tense: `"Thing saved"`, `"2 things deleted"`.
- Tooltips (`title=`) explain *why*, not *what* — every non-obvious button has
  one.
- No emoji anywhere in the UI.

---

## 11. Checklist for any new page

1. Copy the Polaris UI PageShell page; set the title and the `<th>` set.
2. `renderSidebar({ logo, tagline, items, bottomItems })` on DOMContentLoaded.
3. `new TableSF(...)` → then `setupColumnLayout(...)`.
4. Persist filters + sort + column layout in one
   `localStorage["<app>-prefs-<scope>-<username>"]` blob; restore before the
   first fetch (`sf._filters = …; sf.restoreFilterUI();`).
5. `renderPageControls(...)` after every render; `clearPageControls` on empty.
6. Row click → slide-over; header button → modal; every mutation → `showToast`;
   every destructive action → `await showConfirm`.
7. `escapeHtml()` around **every** dynamic value that lands in an HTML string.
8. Check both themes before calling it done.

---

## 12. Mobile — a separate app, not a responsive desktop

The phone surface is its **own SPA** (`mobile.html` + `public/css/mobile.css` +
`js/mobile/*`), not the desktop stylesheet at a narrow breakpoint. That is a
deliberate split: the desktop is a dense multi-column table tool and the phone
is a Material 3 list-and-sheet app. They share the server, the auth flow, the
theme *key*, and nothing else.

Copy `public/css/mobile.css` verbatim and start from the Polaris Mobile AppShell page.

### Design language

**Material 3**, not the desktop's Polaris chrome — tonal surfaces, pill
buttons, a bottom navigation bar with an active pill indicator. Roboto +
Roboto Mono, loaded from Google Fonts.

Every colour is an `--md-*` token in the `:root` block at the top of the
stylesheet. Never write a raw hex in mobile app code; the one exception the
stylesheet itself makes is **status colour** (monitor pills, map markers,
topology nodes), which stays literal on purpose — a health colour must not
change hue with the basemap.

Token families: key colours (`--md-primary` … `--md-on-tertiary-container`),
neutral surfaces (`--md-surface`, five `--md-surface-cont-*` steps,
`--md-on-surface`, `--md-outline`), semantic (`--md-success`, `--md-warning`,
`--md-error*`), shape (`--shape-xs` 4 → `--shape-xl` 28 → `--shape-full`),
elevation (`--elev-1..3`), layout (`--topbar-h` 64, `--navbar-h` 80).

### Themes

Mobile ships **two** themes where the desktop ships three. The desktop's
morning/noon split is a warmth difference this token set has no room for, so
the light palette is selected by *family*:
`:is([data-theme="morning"],[data-theme="noon"])`. The toggle in More →
Appearance stays a two-way Dark/Light and writes the same shared
`polaris-theme` key, which is what keeps the two apps coherent when a user
moves between them.

### Shell

```
.app[data-tab]                    height:100% flex column
  .m3-topbar                      64px, .leading / .title / .trailing
  .m3-searchbar                   56px pill, --md-surface-cont-high, elev-1
  .app-body                       flex:1, THE only scroller
  .m3-navbar                      80px, grid repeat(5, 1fr)
```

- `body` is `overflow:hidden`. Scrolling happens inside `.app-body`, never on
  the body — otherwise iOS bounces past the navbar.
- `.app-body` is `overscroll-behavior-y: contain` so the pull-to-refresh puck
  gets unambiguous touchmove deltas.
- `data-tab=""` hides the navbar (boot / login). `data-tab="__fullbleed"`
  hides the topbar slot and search slot — for a full-screen canvas surface
  that renders its own chrome. The navbar stays; the surface ends on it.
- **Five tabs.** The navbar grid is `repeat(5, 1fr)`; a sixth breaks it and a
  fourth looks broken. Overflow goes behind a **More** tab with sub-pages.

### Installed-PWA insets

`viewport-fit=cover` + `black-translucent` means the app paints edge to edge,
so the shell reserves the notch itself:
`@media all and (display-mode: standalone)` puts `env(safe-area-inset-*)`
padding on `.app`. Padding on the flex column shrinks the box, so `.app-body`
and the fixed-height navbar both land inside the safe area — which is exactly
what the overlay anchors already assume
(`calc(var(--navbar-h) + env(safe-area-inset-bottom))`). Scoped to
display-mode so a normal browser tab is byte-identical.

### Keyboard (iOS)

iOS Safari does not shrink the layout viewport when the keyboard opens, so a
flex-centred login form ends up behind the keyboard with nothing to scroll.
Watch `window.visualViewport`, and while the keyboard is up put `.kb-open` on
`.app` with `--vv-height` / `--vv-offset-top`. That pins `.app` to the visible
rect, which makes the content taller than its container and turns `.app-body`
back into a real scroller. Top-align at the same time — overflow *above* a
`justify-content:center` flex item is unreachable, since scrollTop can't go
negative. Android shrinks the layout viewport natively, so the delta check
must leave it alone.

### Component vocabulary

| Need | Use |
|---|---|
| Row in a list | `.list-item` (`.two-line` / `.three-line`), `.leading` avatar + `.content` + `.trailing` |
| Entity summary | `.asset-card` — `.top` (`.ico` avatar, `.name`, status `.dot`) + `.meta` row of facts |
| Grouping label | `.section-head` — 11px uppercase, primary, with a `.count` |
| Filters | `.chip-row` of `.chip` / `.chip.selected` (horizontal scroll) |
| Action | `.btn` + `.btn-filled` / `-tonal` / `-outlined` / `-text` / `-error`; `.fab` / `.fab-ext` |
| Input | `.tf-outlined` (`.field` + floating `.lbl` + `.support`) |
| Feedback | `.snackbar` (z 1100, above every sheet) |
| Detail | `.sheet` + `.scrim` (1001 / 1000), or the three-state `.asset-sheet` (901 / 900) |
| Status | `.dot.up|warn|down|unk|dep-down|passive|maint`, `.status-pill.*` |
| Nothing to show | `.empty-state` (icon circle + `.ttl` + `.desc`) |
| Loading | `.spinner` inside `.loading-screen` |
| Key/value facts | `.kv-row` (`.k` / `.v`) |

### Touch rules

- Hit targets **never below 44px** — `.icon-btn` is 48, `.btn` is 40 tall with
  24px side padding, `.list-item` min-height 56.
- `touch-action: manipulation` on every interactive element (already applied to
  `button`, `.list-item`, `.chip`) to kill the double-tap zoom delay.
- **No orientation lock, no rotate prompts.** The app turns with the phone on
  every screen, the topology included, and the manifest declares no
  `orientation` (locks and prompts removed 2026-10-27). Every screen must work
  sideways (about 390px tall), and fixed full-width surfaces pad
  `env(safe-area-inset-left/right)` for the side notch.
- Honour `prefers-reduced-motion` on anything that loops.

### How it scales across phone sizes

**There are no width breakpoints.** The stylesheet has exactly two media\nqueries and neither is a layout breakpoint: `display-mode: standalone` (safe-area\ninsets) and `prefers-reduced-motion`. Don't add one —\nif something breaks at a size, the fix is almost always fluid, not a\nbreakpoint.

Everything adapts by being fluid instead:

- **Shell.** `.app` is a `height:100%` flex column. Topbar (64px) and navbar\n  (80px) are fixed; `.app-body` is `flex:1` and takes whatever is left. A\n  taller phone simply shows more list.
- **Navbar.** `grid: repeat(5, 1fr)` — the tabs divide the width evenly at any\n  size. This is the real reason the five-tab cap matters.
- **Full-width components.** `.m3-searchbar`, `.asset-card`, `.list-item`,\n  `.sheet`, `.snackbar` sit on a fixed 16px side margin and stretch. Nothing\n  is a fixed pixel width.
- **Overflow rows scroll, they don't wrap.** `.chip-row` is `overflow-x: auto`\n  with the scrollbar hidden.
- **Text truncates rather than reflows.** `.headline`, `.asset-card .name` and\n  the topbar `.title` are ellipsis-clipped, so a narrow screen loses\n  characters instead of gaining lines and shifting everything below.
- **Sheets are viewport-bounded**, not content-bounded: `max-height: 90vh`\n  (`.sheet`) / a fixed `height: 80vh` (`.asset-sheet`, so paging it never
  resizes it), anchored at\n  `calc(var(--navbar-h) + env(safe-area-inset-bottom))`.
- **Device chrome** is the only true per-device variation handled explicitly,\n  via `env(safe-area-inset-*)` on `.app` in standalone.

Practical range is ~320px to tablet width, either way up. The tightest point is\nthe navbar at 320px — 64px pills in 64px columns with labels like "Reserved"\nat 12px. If a tab label doesn't fit there, shorten the label; don't shrink the\npill or drop to four columns.

### Sheet layering

The z-index scheme is its own, and tighter than the desktop's:

```
  900   asset scrim
  901   asset sheet          (peek / expanded / dismissed)
  950   bottom navbar        — above the asset sheet, below the generic sheet
 1000   generic scrim
 1001   generic sheet        — drilldowns take the full screen
 1100   snackbar             — fires from inside sheets, must outrank them
```

The navbar sitting *between* the two sheet layers is the whole trick: the
asset sheet can peek with the nav still tappable, while a deeper drilldown
covers everything.

---

## 13. Email notifications

Start from `src/utils/alertEmailTemplate.ts` (`DEFAULT_ALERT_HTML` and its plain-text sibling `DEFAULT_ALERT_TEXT`; the Polaris UI AlertEmail page shows it rendered). Both are
templates in a `{token}` vocabulary — **not** server-side string building, and
not rendered samples.

### The one rule that shapes everything else

**What the app sends and what the operator can edit are the same text.** The
automation wizard prefills a new Notify action with exactly these strings, so
the email in the inbox is always the template on the screen: edit it, reorder
it, drop the charts, and that is what ships. A stored rule that carries no
custom composition renders through the default, so changing the default needs
no migration.

### HTML rules

- **Tables, not flexbox or grid.** Outlook renders through Word.
- **Inline styles only.** No `<style>` block, no classes, no variables.
- **No remote images.** Images ride as inline `cid:` attachments.
- **Always a real plain-text alternative** — pager gateways show only that, and
  it spells links out instead of hiding them behind anchors.
- Buttons are bulletproof table buttons (`<td>` background + block-level `<a>`),
  not styled anchors.
- Card is `width="600"` with `max-width:100%`, on a `#f5f6f8` page.
- Fixed-width label column (`width="140"` on the `<td>` **and** in its style —
  Outlook sizes from the attribute) plus `word-break:break-word` on the value.
  Auto layout gives the labels most of the card the moment the fact list gets
  short.

### Fixed palette

An email has no theme. `#f5f6f8` page · `#ffffff` card · `#e5e7eb` border ·
`#1f2430` heading · `#374151` body · `#6b7280` label · `#9ca3af` footnote ·
`#d1d5db` secondary-button border.

Severity colour — one map shared by email, chat cards, and the public
acknowledge page:

| Severity | Hex |
|---|---|
| notice | `#6b7280` |
| informational / info | `#2563eb` |
| warning | `#d97706` |
| serious | `#ea580c` |
| critical / error | `#dc2626` |
| resolved | `#16a34a` |
| *(unknown)* | `#808080` |

Keep it in one pure module with no ORM import, so the unauthenticated
acknowledge page can share it.

### Structure

1. **Severity bar** — 5px of `{severity.color}` across the top.
2. **Headline + letterhead** — two cells. Left: severity eyebrow, subject,
   then the *trigger sentence* in the builder's own words with the reading in
   it. Right: the install's logo/name/subtitle, filled at delivery.
3. **Facts** — label/value rows, asset rows first (free-text description last
   so it can't push IP and location out of the first glance), then event rows.
4. **Context block** — what was on the port, for an interface alert.
5. **Charts** — last hour of the metrics that explain the alert, as inline CID
   images, under one `data-section="charts"` row. **They are section 15's charts,
   rasterized.** A missed poll dives to the baseline in red here exactly as it
   does on the device page; the surface may diverge on size, palette and the
   absence of hover, never on the shape of an outage.
6. **Actions** — primary button in the severity colour, secondary outlined.
7. **Footnote** — who sent it and which automation.

Don't print the rule's `{message}` under the trigger sentence: the two say the
same thing, and the duplicate reads as a bug. `{message}` keeps its real homes
— the in-app alert card and every chat/push body, which have no trigger
sentence.

Use a local-time token, not ISO. `2026-08-12T18:46:01.561Z` is a 24-character
unbreakable string that wraps mid-token in a table cell.

### Prune passes — run on the RENDERED body

Every token can render empty, and empty rows read as broken rather than as
"not applicable". Four passes, in order:

| Pass | Drops |
|---|---|
| `pruneEmptyRows` | any two-cell `<tr>` whose **value** cell is empty |
| `pruneEmptyDivs` | exactly-empty `<div>`s (the header lines aren't rows) |
| `pruneDeadLinks` | a button whose `href` rendered `""`, plus its spacer cell |
| `pruneEmptyChartSection` | the `data-section="charts"` row when no `<img>`/`<p>` landed in it |

`pruneEmptyRows` must **fail its match** on a row containing a nested
`<table>` or a second `<tr>`. Without those exclusions it starts at a layout
row and runs to the first `</tr>` *inside* it — which looks exactly like an
empty label/value pair, so the drop takes the facts table's opening tag with
it and the unmatched `</table>` closes the card early, spilling the charts and
buttons outside the box. That is also why the letterhead cell wraps its
contents in a one-cell table: a row containing a `<table>` can never be
mistaken for a fact row.

The text body gets the same treatment: drop `Label:` lines with nothing after
the colon, then collapse the blank-line runs.

### Deferred tokens

`{brand.header}`, `{interface.lldp}` and `{chart.*}` are filled at **delivery**
time, not compose time — they carry attachments or need a live query. Attach a
CID image only when the substituted HTML actually references it, or every
message drags a logo nobody displays.

---

## 14. Dashboard widgets

A widget is a **self-registering module**, not a page section. One file per
widget under `js/widgets/`, each ending in a single
`PolarisWidgets.register({...})` call. The registry (`js/widgets/index.js`)
holds the catalog and the shared helpers; the orchestrator reads `getAll()` for
the picker and `getByType()` to mount an instance. Nothing else knows a
widget exists — adding one is adding a file and a `<script>` tag.

### The contract

```js
PolarisWidgets.register({
  type:               "downNodes",        // stable id — saved layouts key on it
  category:           "Monitoring",       // picker Group-By bucket
  label:              "Down Assets",      // display name
  description:        "…",                // one line, for the library card
  defaultSize:        { width: 6, height: 1 },
  minSize:            { width: 4, height: 1 },
  defaultConfig:      { rowLimit: 10, regionScope: "mine" },
  requiredPermission: { key: "assets", level: "read" },
  fetchData:          (config) => Promise,
  renderInstance:     (el, config, data, ctx) => {},
  renderPreview:      (el) => {},          // mock data, no network
  renderConfig:       (el, config, onChange) => {},
  onMount / onUnmount: (el, ctx) => {},
});
```

Rules that hold for every widget:

- **`type` is forever.** It is the key in saved layouts. Rename the `label`
  freely; never the `type`. (`downNodes` still ships as "Down Assets".)
- **`defaultSize.width` ∈ 3 | 4 | 6 | 12**, `height` ∈ 1 | 2. Always declare a
  `minSize` — a list widget squeezed to 3 columns wraps into mush.
- **Every widget declares a `requiredPermission`** unless its data is genuinely
  public to all roles. It gates the library card *and* the instance render, so
  it can't be bypassed by a saved layout.
- **`renderPreview` never touches the network.** It takes hardcoded mock rows
  through the same `render()` the instance uses, so the library card can't
  drift from the real thing and opening the picker costs nothing.
- **`fetchData` fetches only that widget's feed** (`?feeds=topCpu`), so a widget
  paints as soon as *its* data lands rather than waiting on the slowest feed
  in a monolithic payload. Shared accessors memoize per (feed, filter, limit)
  with in-flight dedupe, so two widgets on one feed still make one request.
- **Anything a widget starts, it stops.** Timers, listeners and map instances
  register teardown through `ctx.onUnmount`. A widget that leaks a timer takes
  a kiosk wall down overnight.

### Chrome the widget does not own

The shell draws the card, title, grip, gear, height toggle and remove button.
A widget only ever writes into its **body element**. It reaches the header
through helpers, never by walking the DOM:

| Want | Call |
|---|---|
| A count on the title | `setHeaderCount(el, n, severity?)` |
| A severity breakdown | `setHeaderSeverityCounts(el, rows, opts)` |
| A non-alert tier breakdown | `setHeaderTierCounts(el, rows, opts)` |
| CSV export (⤓) | `setHeaderExport(el, { filename, columns, rows })` |
| Arbitrary pills | `setHeaderPills(el, [{ text, className, title }])` |

Header pills count **the rows about to render** — post-filter, post-row-limit.
The CSV export provider is the opposite: it takes the **full fetched set**, and
its menu states the per-tier counts. Those two disagreeing is intentional and
should stay documented wherever it surprises someone.

### Shared config controls

A gear popover is assembled from shared parts, in this order — widget-specific
controls, then severity, then scope:

```js
renderConfig(el, config, onChange) {
  el.innerHTML = /* this widget's own <label> + <select data-k="…"> */;
  PolarisWidgets.renderMinSeverityConfig(el, config, onChange, hint);
  PolarisWidgets.renderNocFilterConfig(el, config, onChange, includeAssetTypes /*, { fortigates: true } */);
}
```

Never hand-roll a row-limit dropdown: `rowLimitOptionsHTML()` /
`parseRowLimit()` / `clip()` are the one set of options (5/10/20/50/100/1000)
and the one clipping rule. Same for the severity ladder — `SEVERITY_TIERS`
feeds both the export menu and the minimum-severity filter, so the two can
never disagree about what "Serious and up" means.

Widgets with nothing to configure ship **no gear at all** rather than an empty
popover.

### Two severity vocabularies, kept apart

The automation-alert ladder (`notice < informational < warning < serious <
critical`) has a rank map and drives filtering, export tiers and pill color.
A widget whose rows carry their *own* tiers (capacity `ok/watch/amber/red`)
uses `setHeaderTierCounts` with its own order and class mapping. **Do not merge
them** — a capacity "red" must never rank against an automation "critical" in
the minimum-severity filter.

Pill classes: `.widget-pill-ok | -watch | -amber | -orange | -neutral | -red`.

### Refresh cadence

Pick from a fixed set, by how fast the underlying thing actually moves:

| Tier | Interval | For |
|---|---|---|
| fast | 10s | in-flight progress (a running discovery) |
| normal | 30s | outage state — down assets, down interfaces, active alerts |
| slow | 60s | ranked metrics, forecasts, maps, reboot history |

Two constraints that are easy to miss: the shared accessors memoize for **15s**,
so a 10s widget gets cached data two ticks out of three; and a widget with **no
timer at all** is frozen forever on a kiosk wall, which is where these live.
Everything with a live feed gets a timer.

### An acknowledged alert says who, and why

Acknowledging is not clearing. The alert is still active, so it **stays in
the list** — removing it on ack would train operators to ack things to tidy
the board. The row instead dims to `opacity: .6`, which is what pushes the
unhandled alerts forward on a wallboard.

What dims is the **alert**: severity pill, automation name, hostname,
dimension, message. What does **not** dim is the **acknowledgement**:

- The pill reads **`ack <user>`**, never a bare `ack`. Who owns it is the
  reason the pill exists, and a wallboard cannot hover a `title` attribute.
- The acknowledgement note, when there is one, renders on **its own line
  under the message** — indented behind a 2px border, secondary text,
  italic, wrapping freely. It is the one piece of a handled alert someone
  still needs to read: "generator running, crew at first light" is the
  difference between a dispatch and a wasted callout.
- Both render at **full strength inside the dimmed row.**

That last rule is not a preference. `.6` multiplied onto the tertiary grey
these started in composites to 2.43:1 against the card — under the 4.5:1 AA
floor and under even the 3:1 large-text floor, at 12.8px italic — and it
lands on exactly the rows that have a note. Dim the alert, never the
annotation on it.

A row acked with no note shows the pill alone; no empty line, no placeholder.

### Empty and failure states

One shape: `el.innerHTML = '<p class="empty-state">…</p>'`. The text says what
is *actually* empty. When a severity filter did the emptying, say so
(`minSeverityEmptyText`) — otherwise "No assets down" reads as good news when
it really means "nothing at this severity". A failed fetch resolves to an empty
shape rather than rejecting; a widget must not take the dashboard with it.

### Checklist for a new widget

1. One file, one `register()` call, script tag added.
2. `type` you can live with forever; `category` from the existing set.
3. `defaultSize` + `minSize`; `requiredPermission` unless truly public.
4. `fetchData` requests only its own feed, and catches into an empty shape.
5. `renderInstance` and `renderPreview` call the **same** `render()`.
6. Header count/export via helpers; nothing reaches outside the body element.
7. Row limit, minimum severity and scope from the shared controls.
8. Every timer and listener torn down in `ctx.onUnmount`.
9. Check it at 3 columns wide and at height 1.

---

## 15. Time-series charts

Hand-rolled SVG, one render function per chart, no charting library. Shared
scale/clip/tooltip helpers live at the top of the assets module; the phone app
ports the same rules into its own tiny helper.

**Three surfaces, one set of rules.** The in-app charts, the phone app, and the
charts rasterized into alert emails (section 13) all obey this section. They
differ in size, in palette weight, and in whether a tooltip exists at all — but
never in what a missed poll looks like. An operator who learns to read an
outage on the device page must not have to learn it again from an email about
the same outage.

### A missed poll is a red dive to the baseline

One treatment, every chart, all three surfaces:

- Failed polls plot **at the chart baseline** (`y = padT + innerH`) with no
  value of their own — they never widen the y-axis.
- Consecutive failures connect **in red** (`#d32f2f`, the danger hue the
  tooltips use) along that baseline.
- Each OK↔fail transition segment gets its own `userSpaceOnUse`
  `linearGradient` so the stroke **fades** between the series color and red
  instead of jumping. Gradient ids are prefixed per render (the chart's clip id
  works) so they can't collide between charts on one panel.
- Every failure also carries a **2.5px red dot** — bigger than the 1.5px series
  dots — so a lone miss is visible and not a hairline notch. On the phone the
  dot is a near-zero-length round-capped stroke, not a `<circle>`: the plot uses
  `preserveAspectRatio="none"`, which squashes circles into ellipses.
- Tooltip on a failure point: **"Missed poll — no data collected"** in
  `var(--color-danger)`.

The point of the dive is that an outage reads as the line **going to zero**.
Bridging over the gap hides it; a marker beside an unbroken line understates it.

Two ways a stream reports a failure, and both must be handled:

| Stream | Signal |
| --- | --- |
| Monitor / response time | explicit per-sample flag — `success: false`, or `successCount === 0` on the rollup tiers |
| Telemetry, storage, interface counters | **no flag** — a failed poll leaves no row, because these cadences are not RUN while a device is down. Their failures come from the monitor stream instead: the endpoint serves an `outages` list (`[{from, to}]`) built from that device's failed probes, and the chart plots one marker at each end of each window |

### A missed poll is evidence, never a shape

The flagless streams do not guess. A hole in a CPU series is not itself a
missed poll — it is equally the signature of a disk that was unmounted, a
metric this device never reported, an operator widening the cadence, or a
maintenance window. Only one stream is still measuring while a device is down:
the response-time probe, which runs in every state and writes a real failure
row per interval. That record is what the other charts read.

The consequence worth stating plainly: **a gap with no failed probe behind it
bridges.** Silence is not an outage until something says it was one.

This also means maintenance needs no special case. Polling stops entirely
inside a window, so the window holds no failed probes and draws no dive — the
band explains the gap, which is the whole point of the band.

Markers are derived **once per device** from the union of the co-plotted
series' good timestamps: CPU and memory ride the same row, so an outage is an
outage for both, and one shared marker set keeps them diving at the same x
instead of drawing two offset red notches. On a chart that co-plots **several
devices** — the comparison view — that union is per asset and never chart-wide,
or one device going dark would pull every other line to the baseline.

A marker landing on top of a real sample is **dropped**. An agent pushes on its
own schedule and is not gated on device state, so an agent host can keep
reporting CPU straight through an outage of the server-side probe transport;
diving a line that has data would misreport what is actually held.

A counter reset is not a missed poll. Neither is a partial-loss rollup bucket —
it still plots its average.

### The reachability chart speaks verdicts, so it carries more than two colours

Every chart above is about a READING, and a reading has two states: it arrived
or it didn't. One chart is about a VERDICT instead — response time, the series
that decides whether the device is up — and it reads as the status pill reads,
sample by sample:

| Colour | Meaning |
| --- | --- |
| green (`--color-success`) | answered, nothing outstanding |
| amber `#ffc107` | a miss, but the count has not reached the threshold that declares Down |
| red `#d32f2f` | the miss that IS the verdict, and every one after it |
| blue `#0288d1` | answered, but the misses are not paid off yet |
| grey `#9aa0a6` | a miss the upstream explains — overrides amber and red both |

Amber earns its place by what red claims. Red asserts "this device is down", so
spending it on the first dropped packet of a three-miss threshold says the
outage began two polls before the product agreed it had. Amber is the honest
reading of a miss that is still only a miss.

**Do not compute these in the renderer.** One replay module colours the sample
strip, the chart beneath it, and the phone's copy of that chart — because the
strip sits directly above the chart, and the phone is showing the same device to
the same person, and any two of them describing one probe differently is the
exact confusion this vocabulary exists to prevent. Give the amber the strip's
own value, not a deeper one chosen for contrast: two yellows a shade apart read
as two meanings. That replay is also
what puts the recovery rule in the picture: when the config says "down after 3
missed, up after 5 received", the climb stays blue for all five answers, not
just the three it takes to drain the counter.

The counts ride the history payload alongside the samples. A chart that fetches
them separately paints an outage and then repaints it a moment later, in front
of the operator.

Every OTHER chart keeps its own series colour and its two states. Recolouring
them would make green and blue mean two different things apiece.

### Bands are maintenance, not failure

A translucent band across the plot means **the asset was in a maintenance
window** — polling was paused on purpose, so the gap has an explanation.
Purple, `rgba(149,117,205,0.14)` fill with a dashed `rgba(149,117,205,0.45)`
outline, drawn **before** the series group so the data line stays on top, named
inline when the band is wider than 46px, native `<title>` for the tooltip.

Never band a missed poll. Red-tinted shading would read as a second kind of
scheduled window, and the two states are opposites: one is expected, one is the
thing the operator is looking for.

This is the rule the alert-email charts used to break — they shaded the failed
window red and broke the line across it, which is the treatment for a gap you
are explaining, not one you are reporting. They dive now, like everything else.
The one band that survives on an email chart is the **hardware sensor's own
alarm bit**, which is a different claim: the reading is still arriving, and the
device is telling you it doesn't like it.

### What the email surface may and may not diverge on

May: physical size, the raster palette (flat hex, no CSS variables — a mail
client has no theme to read; pick each colour's value for a WHITE card, since
that is what the message renders on), no tooltips or hover targets, runs of
same-state points collapsed into one polyline rather than a `<line>` per segment
(a FortiGate can land thousands of points in an hour, and per-segment elements
balloon the PNG — the phone port collapses them for the same reason).

May not: the shape of an outage, **or which colour any part of it is**. Same
baseline dive, same fade at each transition, same rule about what counts as a
missed poll — and the same five-colour verdict palette on the reachability
chart, including the amber that says a miss is not yet a verdict and the blue
that says a device is answering but not yet trusted. An operator who learns to
read a recovery on the device page must not have to learn it again from the
email about the same outage.

That is a claim about a state machine, not about a stylesheet, so it cannot be
kept by copying colours: the server needs its own replay of the same rules, and
a test has to run both copies over the same probe sequences and fail when they
part.
