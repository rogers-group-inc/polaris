Polaris Mobile is the phone application of Polaris — a **Material 3 app, not a narrow
version of the desktop.** Tonal surfaces, pill buttons, a bottom navigation bar with an
active pill indicator. Like its desktop sibling it is a **CSS design system**: nothing is
exported from JavaScript; you build with semantic markup and the class vocabulary below,
and `components/bundle.css` does the rest. Never invent a class, and never write a raw
hex value for anything a token covers.

The desktop kit is a separate system,
[Polaris UI](https://claude.ai/artifact/2Haqgf2NSW7KUuc9JuTKgz). The two share a theme key
and an accent seed and nothing else — never pair an `md-*` token with a desktop `color-*`
one, or put a desktop class inside this shell.

## Required setup

Set a theme on the root element: `<html data-theme="nightfall">`. The ids are the
desktop's own — `nightfall` for dark, `morning` or `noon` for light — because both apps
read the same stored `polaris-theme` preference and must agree on it.

The stylesheet locks `html` and `body` to the viewport with `overflow: hidden`; all
scrolling happens inside `.app-body`. The app has no orientation lock and
no rotate prompts: every screen, the topology included, turns with the phone. `.app`, `.sheet`,
`.snackbar` and `.topo-screen` pad the side safe-area insets a sideways notch needs. Installed to a home screen
(`display-mode: standalone`), `.app` pads itself by the device's safe-area insets.

Three custom properties are **runtime state, not tokens** — the app's JavaScript sets them
and the sheet falls back sensibly without them: `--vv-height` and `--vv-offset-top` (the
visual viewport while the keyboard is open, read by `.app.kb-open`) and `--asset-peek-y`
(how far a peeking `.asset-sheet` is pulled down).

## Themes

Three palettes behind three ids, each a Material palette re-seeded from that theme's
desktop colours so the phone and the desktop agree on what a theme looks like.
`nightfall` is the dark palette: its container ladder takes its hues from the desktop's
surface tokens, and its text, accent and status colours are the desktop's as they stand.
`morning` is amber parchment: yellow-brown grounds, an orange accent, the softest contrast.
`noon` is neutral near-white with a terracotta accent, the highest contrast of any palette.
The dark base sits on `:root`, so it is what renders when no theme is set; a shared
daylight block under `morning` and `noon` supplies anything their own blocks leave out.
`afternoon` also exists in the stylesheet: a transit palette the theme strip fades
through between noon and nightfall, never a stored theme. Put a new token in all three.

## Colour

Every `md-*` colour is half of a fill/ink pair; use them as pairs:

| Fill | Ink on it |
|---|---|
| `md-primary` | `md-on-primary` |
| `md-primary-container` | `md-on-primary-container` |
| `md-secondary-container` | `md-on-secondary-container` |
| `md-tertiary-container` | `md-on-tertiary-container` |
| `md-error` / `md-error-container` | `md-on-error` / `md-on-error-container` |
| `md-inverse-surface` | `md-inverse-on-surface` |
| `md-surface` and every `md-surface-cont-*` step | `md-on-surface` (body), `md-on-surface-variant` (supporting) |

The container ramp climbs `md-surface-cont-lowest` → `-low` → `md-surface-cont` →
`-high` → `-highest`. Choose the step by how far the element sits off the ground: cards and
sheets on `-low`, the navigation bar on `md-surface-cont`, the search bar on `-high`,
filled cards and icon wells on `-highest`. Edges are `md-outline` for a control's border
and `md-outline-variant` for a separator. Each theme's palette is hand-derived from that
theme's desktop colours; change a desktop theme and re-derive its phone palette with it.

The severity steps `md-sev-*` (critical, serious, warning, notice, info) mirror the
desktop's severity colours for the alert pills.

The colour values in `tokens.json` are generated from `public/css/mobile.css` on every
sync, so they always match the app; check a pairing's contrast against the published
values, not against this text.

**Status colours are deliberately literal**, written into their component rules rather
than tokenised, because a status keeps its hue whatever the basemap: the dependency-down,
maintenance and passive pills and dots (`#607d8b`, `#9575cd`, `#5c6bc0` and their lighter
inks), the map markers and clusters, `.btn-success` (`#2e7d32`), and the firewall glyph
(`#ffc78a`). They were tuned for the dark palette and the light palette never overrides
them. In `morning` and `noon` the dependency-down pill reads at 1.5:1, maintenance at
1.9:1, passive at 2.2:1, the degraded pill at 3.6:1, and the firewall glyph at 1.3:1 —
nearly invisible. Those are carried from the source unchanged. Every status also carries
its word, so the meaning survives; don't add a status that relies on the colour alone.

## Type

Roboto first, then Inter, then the platform sans (`sans`); Roboto Mono for identifiers
(`mono`, via `.mono`). The stylesheet fetches only Inter and Roboto Mono from Google
Fonts: **Roboto is expected from the device** — native on Android — and Inter stands in
everywhere else, including these previews.

Set text with the Material ramp classes, which `tokens.json` records as type styles of
the same names without the prefix: `ty-display-s` 36/44, `ty-headline-s` 24/32,
`ty-title-l` 22/28, `ty-title-m` 16/24 medium, `ty-title-s` 14/20 medium, `ty-body-l`
16/24, `ty-body-m` 14/20, `ty-body-s` 12/16, `ty-label-l` 14/20 medium, `ty-label-m`
12/16 medium. Components carry their own sizes; reach for a ramp class only for text you
place yourself.

## Shape, elevation and chrome

Corners come from the shape scale, never the desktop radii: `shape-xs` 4px for text
fields and the snackbar, `shape-sm` 8px for chips, `shape-md` 12px for cards, `shape-lg`
16px for FABs, `shape-xl` 28px for the top of a sheet, and `shape-full` for every pill —
buttons, icon buttons, the search bar, status pills, the active navigation indicator.
Elevation is `elev-1` (resting cards, the search bar), `elev-2` (the login mark) and
`elev-3` (FABs, the snackbar). The chrome is fixed: `topbar-h` 64px, `navbar-h` 80px, and
anything anchored to the bottom — a sheet, a snackbar — clears the bar at
`calc(var(--navbar-h) + env(safe-area-inset-bottom))`.

## Motion

Sheets slide up (`sheet-in`), the scrim fades (`scrim-in`), snackbars rise
(`snack-in`), and a peeking asset sheet eases with a 0.25s transform. The pull-to-refresh
glyph spins while a refresh runs. The walking map pin's animation stops under
`prefers-reduced-motion`; follow that rule for any looping motion you add.

## Iconography

Icons are **inline SVG with `fill: currentColor`**, sized by their host: 24px in
`.icon-btn`, the navigation pill, list leading slots, asset glyphs and FABs; 22px in the
topology bar and the pull-to-refresh circle; 18px in `.btn` and `.chip`. The glyph takes
the text colour, so set the parent's ink, never a fill. No emoji in the UI.

**The app's own icon glyphs did not come across.** They are drawn in its JavaScript, not
its stylesheet, and the source for this system holds none of them. Every preview here
uses plain stand-in glyphs — a plus, a magnifier, a chevron — drawn only to show size and
placement. Replace them with the app's real set before copying a preview into product
code. The walking user pin on the map is a JavaScript illustration for the same reason,
and is described rather than shown.

## Copy

Sentence case. Section heads (`.section-head`) are uppercased by the stylesheet — type
them in sentence case. Navigation labels are one word. Status words are short and fixed:
Up, Degraded, Down, Unknown, Dependency down, Maintenance, Passive. Addresses, MACs and serials go in `.mono`.

## Component vocabulary

- **Shell** — `.app > .m3-topbar + .app-body + .m3-navbar`. The top bar holds `.leading`,
  `.title` and `.trailing`; the navigation bar is a five-column grid of `.nav-item`, each
  with `.nav-icon-pill` and `.nav-label`, `.active` on the current one, and an optional
  `.nav-badge`. `.app[data-tab="__fullbleed"]` drops the top bar for a full-screen view; the navigation bar stays.
- **Actions** — `.btn` plus exactly one of `.btn-filled` (the screen's primary
  action), `.btn-tonal`, `.btn-outlined`, `.btn-text`, `.btn-error`, `.btn-success`;
  `.btn-block` for full width. `.icon-btn` for a bare glyph, `.fab` / `.fab-ext` for the
  screen's floating action. `.chip` inside `.chip-row` for filters, `.selected` when on.
  `.seg > .seg-item` for a segmented control, `.on` for the chosen segment.
- **Input** — `.tf-outlined > .field + .lbl + .support`, `.error` on the wrapper.
  `.m3-searchbar` with `.input`, and the `.search-hint-*` panel beneath it.
- **Containers** — `.card-elevated`, `.card-filled`, `.card-outlined`, none of which pads
  its content. Lists are `.list-item` (`.two-line` / `.three-line`) with `.leading`,
  `.content > .headline + .supporting` and `.trailing`, separated by `.list-divider` and
  headed by `.section-head`. `.avatar` for a person. Key–value detail is `.kv-row`.
- **Transient** — `.scrim` + `.sheet` (`.sheet-handle`, `.sheet-title`); `.snackbar`
  (`.error`, `.action`); `.spinner`, `.loading-screen`, `.ptr-indicator`; `.empty-state`.
- **Status** — `.status-pill` and `.dot`, each in `.up`, `.warn`, `.down`, `.unk`,
  `.dep-down`, `.maint`, `.passive`.
- **Assets** — `.asset-list > .asset-card` with a device glyph (`.ico-fw`, `-sw`, `-srv`,
  `-prn`, `-ap`, `-rtr`, `-wks`, `-other`); the `.asset-sheet` detail with `.asset-hero`,
  collapsible `.asset-sect-header` + `.sect-body` sections and `.chart-wrap`.
- **Screens** — `.login-shell`, `.map-screen` with `.fg-marker` / `.fg-cluster`, and the
  `.topo-screen` topology view.

## Z-index

Top bar 5 · map controls 600 · asset scrim 900 · asset sheet 901 · navigation bar 950 ·
scrim 1000 · sheet 1001 · snackbar 1100. The navigation bar deliberately sits above the
asset sheet, so a peeking sheet tucks under it; an ordinary sheet covers everything but a
snackbar. Extend the ladder
rather than picking a number.

## Reading the source

This system is published from the Polaris repository and is read-only here: change the
repo and re-sync. `components/bundle.css` is `public/css/mobile.css`, the stylesheet the
phone app itself loads, published verbatim behind the Google Fonts import, so it carries
its own token declarations and always matches the app. `tokens.json` lists the same values
with usage notes, generated from that file. The previews under
`components/<Name>/preview.html` (sources in the repo's `design/mobile/`) are rendered
markup against that sheet; copy their structure, and swap the stand-in glyphs for real ones.
