---
name: polaris-design-sync
description: "Push the Polaris UI kit to the Claude Design design-system project (claude.ai/design) so future apps inherit the Polaris look: the off-script CSS-kit bundle layout, the build-verify-upload procedure, the DesignSync authorization gate, what triggers a re-sync and what does not, and the preview-card validation pass. Run /polaris-design-sync after the external kit is lifted into design/, when the Claude Design project looks stale or wrong, or when adding a preview card."
disable-model-invocation: true
---

# Claude Design sync — shipping the kit outward

`design/` was originally pulled *out* of Claude Design; this is the return trip. The
Polaris UI kit is published as a **design-system project** at claude.ai/design so that
future apps designed there inherit the Polaris look.

**This is a manual, one-shot push.** Nothing re-runs it — no npm script, no CI job, no
hook. The published copy is a snapshot and goes stale silently. That is why this skill is
user-invocable only: uploading is an outward-facing publish you decide to make.

Target project: **`Polaris UI`**, id recorded in `.design-sync/config.json`.

## Read this first — three things that have already cost time

**1. `design/` tracks the EXTERNAL kit, never `public/`.** `design/js|css|email/` are
drop-in snapshots re-synced wholesale from the external kit, and are *never edited to
chase `public/`* — a fix made in `public/` travels back only when the kit is next lifted.
So `design/css/polaris-ui.css` and `public/css/styles.css` diverging is the expected
kit-vs-app gap, not rot (they were ~1250 lines apart at the first upload). **Never copy
`public/css/` over `design/css/` to "fix" the drift.** The bundle ships the *kit* on
purpose: the portable contract, without `public/`'s app-specific accretions. An earlier
version of `.design-sync/NOTES.md` stated this backwards and nearly caused exactly that
mistake.

**2. `DesignSync` needs an authorization the VS Code extension session cannot grant.** It
reports as non-interactive there, and `/design-login` typed into the VS Code chat does
nothing — it is not a command in that surface. It must be run **once from the standalone
terminal `claude` CLI** on this machine; every other session then reuses it. This blocked
the first upload for a day. Re-test with `DesignSync(list_projects)` before assuming it
is still blocked.

**3. The `/design-sync` converter does not apply to this repo.** Both its shapes
(storybook and package) need a built JS package exporting renderable components with
`.d.ts` types. Polaris has none: no Storybook, no React/Vue/Svelte/Lit, `dist/` is the
compiled Express backend, and the frontend is vanilla JS served from `public/` with no
build step. This repo uses the **off-script path** the base skill allows —
`.design-sync/build.mjs` assembles the upload layout by other means. `.design-sync/config.json`
is NOT converter config; running the converter's `package-build.mjs` against it fails on
unknown keys. That is intentional — do not "fix" it by inventing a `pkg` key.

## What ships

A CSS design system, not a component library. Fourteen files:

| Path in the project | Source |
|---|---|
| `styles.css` | generated entry point — the `@import` closure is *all* a rendered design receives |
| `css/polaris-ui.css`, `css/polaris-mobile.css` | verbatim copies of `design/css/` |
| `README.md` | `.design-sync/conventions.md` + a generated card index |
| `components/<Group>/<Name>/<Name>.html` | the 10 authored preview cards in `.design-sync/cards/` |

There is **no `_ds_bundle.js`** and nothing importable. The conventions header says so
explicitly, because an agent that assumes a component library writes imports that resolve
to nothing.

## The procedure

1. **Decide it is actually a re-sync.** See the trigger table below. A `public/css/`
   change alone is *not* a trigger.
2. **Check the kit moved.** `git log --oneline -- design/css/` — a re-sync is warranted
   when there is a new `docs(design): sync the kit` commit since the last upload.
3. **Build.** `node .design-sync/build.mjs` from the repo root. It wipes and rebuilds
   `ds-bundle/`, which is gitignored and never a source — edit the inputs, never the
   output.
4. **Validate** (see the checklist below). Do this *before* uploading; the published copy
   is what other people design against.
5. **Authorize.** `DesignSync(list_projects)`. If it refuses, stop and ask for
   `/design-login` from a standalone terminal — you cannot grant it from here.
6. **Confirm the target type.** `DesignSync(get_project)` must report
   `type: PROJECT_TYPE_DESIGN_SYSTEM`. That type is immutable at creation, so pushing to
   a regular project never makes it a design system.
7. **Plan, then write.** `finalize_plan` with `localDir` set to the absolute `ds-bundle/`
   path and every file listed in `writes` (`deletes` is required even when empty), then
   `write_files` with a `localPath` per file so contents never pass through context.
8. **Verify.** `DesignSync(list_files)` and count what landed.
9. **Record.** A *new* project's id goes into `.design-sync/config.json` and the Status
   section of `.design-sync/NOTES.md` in the same commit. A re-sync overwrites in place
   against the existing `projectId` and changes neither.

## What triggers a re-sync

| Change | Re-sync? |
|---|---|
| the external kit lifted into `design/css/` (a `docs(design): sync the kit` commit) | **yes** — this is the trigger |
| a card added or edited in `.design-sync/cards/` | yes |
| `.design-sync/conventions.md` edited | yes |
| `public/css/styles.css` changed and `design/` did not | **no** — see invariant 1 |
| a new theme id, or a token renamed in the kit | yes, and re-validate every name in the conventions header |

## Validation checklist (run on every re-sync)

- **Every class and token named in `.design-sync/conventions.md` exists in the shipped
  CSS.** The header is hand-written and enumerates ~74 class names and 30 tokens, so it
  rots. The first pass caught one invented name (`.search-state`). Never rewrite the file
  wholesale — it is human-editable and its content belongs to its authors; fix or cut only
  the names that no longer resolve.
- **Every `class="…"` in every card resolves**, plus the `@dsCard` first-line marker that
  the Design System pane builds its card index from.
- **Re-render the cards and look at them.** They are static: they notice a *removed class
  name*, never a layout change. Headless Chrome at
  `C:/Program Files/Google/Chrome/Application/chrome.exe` (Edge works too); keep the
  throwaway render script in the session scratchpad, not the repo.

## Card-authoring gotchas

These are the traps that made cards render wrong the first time — the full list, with the
reasoning, is in `.design-sync/NOTES.md`:

- **`data-theme` is mandatory.** `:root` is the dark base that `nightfall` refines, and
  nothing renders on `:root` alone. The three ids are `morning`, `noon`, `nightfall`.
- **Themes work on any element**, not just `<html>` — which is what lets one card show all
  three side by side.
- **Tables carry no class.** `<table>` is styled by element selector inside
  `.table-wrapper`; an invented name like `.data-table` gets you an unstyled table.
- **`.modal-overlay` and `.slideover` are invisible without `.open`.** Cards hard-code it.
- **`.btn-secondary` is `--color-bg-primary`-filled**, so it vanishes on a `.card` or a
  table row and only reads on the page ground. Authentic, not a bug — demo buttons on the
  page ground or the variant looks broken.

## Where the detail lives

| You need | Read |
|---|---|
| the gotchas, the verification log, the re-sync risks, the Status section with the project id | `.design-sync/NOTES.md` — the durable in-repo record; keep it current in the same commit as any change here |
| the class and token vocabulary shipped to the design agent | `.design-sync/conventions.md` |
| how the bundle is assembled, and what is generated vs copied | `.design-sync/build.mjs` |
| the portable UI contract itself (tokens, themes, shell, tables, modals, badges, z-index) | `design/POLARIS-UI-GUIDE.md` — a drop-in zone, never edited in this repo |
| which file in *this* repo implements a UI pattern | `polaris-ui-canon` |

## Known gaps

- **Nothing has been rendered inside Claude Design.** The 10/10 visual pass was headless
  Chrome locally, so the Google-Fonts `@import` (an external stylesheet fetch at render
  time, in someone else's environment) and the Design System pane's own card rendering are
  both unverified there. If the brand faces come out as `-apple-system` / Consolas, vendor
  the `.woff2` files into `fonts/` and replace the `@import` with local `@font-face` rules.
- **Staleness is silent.** No check compares the published copy against `design/css/`.
  The `polaris-docs-sync` routing table has a row pointing here, but that is a tripwire for
  whoever runs the docs review, not enforcement.
- **Stage 2 is deferred, not rejected**: a thin React wrapper package over these CSS
  classes, to live in `design-kit/` in this repo, so the design agent composes real Polaris
  parts instead of only inheriting the look. Location approved 2026-09-09.
