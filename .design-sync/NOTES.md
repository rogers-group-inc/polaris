# Polaris design systems — repo notes

**The repo is the standard.** Two design systems are published from it as claude.ai
artifacts, and both are marked synced-from-code, so their pages are read-only: a change is
made in the repo and re-synced, never typed into the artifact.

| System | Artifact | Covers | Built from |
|---|---|---|---|
| **Polaris UI** | https://claude.ai/artifact/2Haqgf2NSW7KUuc9JuTKgz | the desktop web app, plus the alert email as one page | `design/desktop/` + `public/css/styles.css` + `src/utils/alertEmailTemplate.ts` |
| **Polaris Mobile** | https://claude.ai/artifact/U1moTSRwvzveB4xQpmLLed | the phone PWA (`mobile.html`) | `design/mobile/` + `public/css/mobile.css` |

Both are the user's own design systems for the apps they build. They are not
organization-wide standards, whatever the artifact listing labels them.

## What lives where

- `design/<system>/README.md` — the system's brand book, hand-written. What a designer or a
  design agent reads first.
- `design/<system>/tokens.json` — token NAMES, usage notes and type styles, hand-written.
  No values: colour, radius and shadow values are generated from the app stylesheet at
  build time, so they cannot drift from the app.
- `design/<system>/components/<Name>/preview.html` + `README.md` — the example pages. Line 1
  of every preview is `<!-- @dsCard group="…" … -->`. A page may only use classes the app
  stylesheet defines, or helpers its own `<style>` defines; the build fails otherwise.
- `design/img/brand/` — the logos (published to Polaris UI's Logos asset group).
- `design/POLARIS-UI-GUIDE.md` — the long-form desktop guide, maintained in this repo.
- `.design-sync/build.mjs` + `config.json` — assemble `ds-bundle/<system>/project/…`
  (gitignored). `render-email.ts` renders the AlertEmail page from the real template.

The published `components/bundle.css` IS the app stylesheet, verbatim, behind the Google
Fonts the app loads. There is no separate kit stylesheet any more: `design/css`,
`design/js`, `design/email` and the starter templates were retired on 2026-10-26 because
they were copies that had drifted ~1,250 lines from the app.

## When to sync

Re-sync after a commit that changes any of:

| Change | System |
|---|---|
| `public/css/styles.css` | Polaris UI |
| `public/css/mobile.css` | Polaris Mobile |
| `design/desktop/**`, `design/img/**` | Polaris UI |
| `design/mobile/**` | Polaris Mobile |
| `src/utils/alertEmailTemplate.ts`, `src/services/alertBrandService.ts` | Polaris UI (the email page) |
| `.design-sync/**` | both |

`/polaris-deploy` runs the sync after its push when one of these moved; a commit made
outside it syncs by hand with the procedure below.

## The publish procedure

From the repo root, in a Claude Code session (the Artifact tool does the publishing; no
other authorization is needed).

1. **Build.** `node .design-sync/build.mjs`. It exits 1 and names each problem when a page
   uses an undefined class, a preview lacks its `@dsCard` line, or a token does not resolve.
   Fix the source, never `ds-bundle/`. A `note:` line means the app declared a colour that
   `design/<system>/tokens.json` has no usage note for: it is published anyway; add the note.
   `ERR_MODULE_NOT_FOUND` for `src/generated/prisma/client.js` means a fresh worktree with no
   client (the alert email page imports it): `DATABASE_URL=postgresql://x:x@localhost:5432/x
   npx prisma generate`, then build again.
2. **Per system, read the live artifact — three calls, in this order.** The Artifact tool
   refuses step 3's publish unless all three happened in this session:
   (a) `Artifact read` on its url with **no `path`** — a read by path does not count as
   viewing the artifact ("You haven't viewed the latest version");
   (b) `Artifact list` with `scope: "files"` on the url — every file the publish overwrites
   must have been read or listed ("published content is not what you last saw"), and the
   listing also names the stale `project/components/` paths step 3 removes;
   (c) `Artifact read` with `path: "project/design-system.json"`. Someone may have edited it
   in the page despite the read-only mark; if its `lastChange` is newer than the last sync
   and not from this repo, stop and ask before overwriting. A version bump with an
   unchanged index can be the Design System type's own release, not an edit.
3. **Publish the files.** One `Artifact publish` with `url` = the artifact, `root` =
   `ds-bundle/<system>`, `file_path` = one of its files, `files` = every other path under
   `project/` mapped to itself. Paths the artifact holds under `project/components/` that
   the build no longer produces are removed with `"project/…": null`. Never send
   `tokens.css`, `api/…` or `manifest.json`: the page generates them.
4. **Logos (Polaris UI, only when `design/img/brand/` changed).** Upload each PNG as an
   asset (`asset: true`), and record it in the index under `assetGroups.Logos.files`.
5. **The index, last.** Re-read `project/design-system.json` and publish it with
   `"editing": "code"`, `lastChange` = `{"by": "<the user>", "at": <now>, "via":
   "Polaris repo @<short sha>", "note": "<what changed>"}`, and every other key kept.
   Remove a leftover `source` key once (it makes the page offer a migration clean-up).

## Design first, then build

A new chart, slide-over, modal, widget or phone sheet starts as a **design canvas built on
the matching system**: `Artifact quickstart` with intent `design`, Polaris UI for desktop,
Polaris Mobile for the phone, an artboard per screen or state. The user reviews and
comments on the canvas; the code is written to match the approved canvas; the new pattern
becomes a page under `design/<system>/components/` in the same branch; the sync publishes
it. Canvases are throwaway reviews, not a second source.

## History

- 2026-09-10 — first published to a standalone Claude Design project
  (`ac6a54e0-a141-4754-967c-6fb9eb604d0a`) by `DesignSync`, from the external kit then
  copied into `design/css`.
- 2026-09-16 — that project was migrated into the Polaris UI artifact; 2026-09-21 the
  phone half was split out into Polaris Mobile. Both were then edited in the browser, so
  the repo and the artifacts drifted (65 phone colours, 25 desktop daylight colours).
- 2026-10-26 — the artifacts' pages and notes were pulled into `design/desktop/` and
  `design/mobile/`, the kit copies retired, and the artifacts re-published from the repo as
  read-only. The original standalone design project ("Polaris", `3136dc76-…`, with its
  React kit, guideline pages and UI kits) is exported to the user's `Polaris.zip`; standalone
  Claude Design closes 2026-12-14, after which that zip is the only copy.
