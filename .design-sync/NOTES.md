# Claude Design sync — repo notes

## Read this first: the converter does not apply here

`/design-sync`'s converter (both the storybook and package shapes) needs a built JS
package that exports renderable components with `.d.ts` types, so the design agent can
render them from `window.<globalName>.*`. **Polaris has none of that:**

- no Storybook, no `*.stories.*`, no React/Vue/Svelte/Lit dependency
- `dist/` is the compiled Express/TypeScript backend — `package.json` `main` is the API server
- the frontend is vanilla JS + HTML served from `public/`, with no build step

So this repo uses the **off-script path** the base skill explicitly allows: we produce the
upload layout by other means. `node .design-sync/build.mjs` assembles `ds-bundle/`.
`config.json` here is NOT converter config — running `package-build.mjs` against it will
fail on unknown keys. That is intentional; don't "fix" it by inventing a `pkg`.

## What ships (stage 1 — styles only)

A CSS design system, not a component library. The design agent gets:

- `styles.css` — the entry; rendered designs receive only its `@import` closure
- `css/polaris-ui.css`, `css/polaris-mobile.css` — verbatim copies of the kit
- `README.md` — `conventions.md` prepended to a generated card index
- 10 hand-authored preview cards under `components/<Group>/<Name>/<Name>.html`

There is **no `_ds_bundle.js`** and nothing importable. The conventions header says so
explicitly, because an agent that assumes a component library will write imports that
resolve to nothing.

Stage 2 — a thin React wrapper package over these classes, to live in `design-kit/` in
this repo — was scoped and deferred, not rejected. Decision recorded 2026-09-09.

## Gotchas found while building this

- **`data-theme` is mandatory.** `:root` is the dark base that `nightfall` refines, and
  `theme-init.js` always stamps `data-theme` on `<html>`. Every card sets
  `data-theme="nightfall"`. The three ids are `morning`, `noon`, `nightfall`.
- **Themes work on any element**, not just `<html>` — the selectors are
  `[data-theme="…"]` / `:is([data-theme="morning"],[data-theme="noon"])`. That is what lets
  `Themes.html` show all three side by side in one page.
- **Tables carry no class.** `<table>` is styled by element selector inside
  `.table-wrapper`. Writing `class="data-table"` (or any invented name) gets you an
  unstyled table — that name does not exist.
- **`.modal-overlay` and `.slideover` are invisible without `.open`.** The cards hard-code
  `.open`; at runtime `openModal()` / `openSlideover()` add it.
- **`.btn-secondary` is `--color-bg-primary`-filled**, so it disappears on a `.card` or a
  table row (both the same colour) and only reads on the page ground
  (`--color-bg-secondary`). This is authentic, not a bug — but it means a reference card
  must demo buttons on the page ground or the variant looks broken. `Buttons.html` was
  rebuilt once for exactly this reason.
- **Fonts come from the Google Fonts CDN**, pulled in by an `@import` at the top of
  `styles.css`. There is no `@font-face` and no `.woff2` in the repo. If Claude Design
  blocks external stylesheet fetches, Inter and Roboto Mono silently fall back to
  `-apple-system` / `Consolas` and the look degrades without an error. **Unverified** —
  see Re-sync risks.

## Verification performed (2026-09-09)

- Every class and token named in `conventions.md` checked to exist in the shipped CSS —
  caught one invented name (`.search-state`, removed).
- Every `class="…"` in every card checked against the CSS, plus the `@dsCard` first-line
  marker. 10/10 clean.
- All 10 cards rendered headless via Chrome and reviewed as images. Chrome is at
  `C:/Program Files/Google/Chrome/Application/chrome.exe`; Edge also works. The throwaway
  scripts lived in the session scratchpad, not the repo — rewrite them if you need them.

## Status

- **Uploaded 2026-09-10** to design-system project `Polaris UI`,
  `ac6a54e0-a141-4754-967c-6fb9eb604d0a` (recorded in `config.json`) — 14 files, all 14
  confirmed present by `list_files`. A re-sync overwrites in place: rebuild, then
  `finalize_plan` against that same `projectId` before any write.
- **`DesignSync` needs a design-system authorization the VS Code extension session cannot
  grant** — it reports as non-interactive and `/design-login` is not a command there. It
  must be run once from the standalone terminal `claude` CLI on this machine; every other
  session then reuses it. That is what blocked the original upload for a day.

## Re-sync risks — what can silently go stale

- **`design/` tracks the external kit, NOT `public/`.** An earlier version of this note
  had the copy direction backwards. `polaris-ui-canon` and commit 72a6c3df are explicit:
  `design/` is a drop-in snapshot re-synced wholesale from the external kit and is *never
  edited to chase `public/`* — a fix made in `public/` travels back only when the kit is
  next lifted. So `design/css/` and `public/css/` diverging is expected, not rot (they were
  ~1250 lines apart at the first upload), and this bundle correctly ships the **kit**: the
  portable contract, without the app-specific accretions in `public/`. Do not "fix" the
  drift by copying `public/css/` over `design/css/`. What to check before a re-sync is
  whether the kit has been lifted since the last `docs(design): sync the kit` commit.
- **The conventions header is hand-written and will rot.** It enumerates ~74 class names
  and 30 tokens. Re-run the validation described above against a fresh build on every
  re-sync and fix or cut any name that no longer resolves. Never rewrite the file
  wholesale — it is human-editable and its content belongs to its authors.
- **Cards are static.** They will not notice a CSS change that alters layout, only one that
  removes a class name. Re-render and re-review the images when `polaris-ui.css` changes
  materially.
- **The Google Fonts `@import` is a network dependency** at render time in someone else's
  environment. If the brand faces look wrong in Claude Design, vendor the `.woff2` files
  into `fonts/` and replace the `@import` with local `@font-face` rules.
- **Cards were never rendered inside Claude Design.** The 10/10 visual pass was headless
  Chrome locally. The Google-Fonts `@import` and the Design System pane's own card
  rendering are still unverified in that environment — look at the pane before trusting
  the look.
