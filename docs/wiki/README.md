# `docs/wiki/` — source for the Polaris GitHub wiki

Every file in this directory is one page of the **GitHub wiki** at
<https://github.com/rogers-group-inc/polaris/wiki>. The wiki is published *from
here*: this directory is the source of truth, the wiki is the rendering.

The **Help** entry in the account menu (click your username, top right) opens
that wiki. The URL is one constant, `WIKI_URL` in `public/js/app.js` — a fork
publishing its own documentation changes that line and nothing else.

## How the files map to wiki pages

GitHub wikis are flat. A file's name **is** its page name, with `-` read as a
space:

| File | Wiki page | URL |
|---|---|---|
| `Home.md` | Home | `/wiki` |
| `Automation-Scripts.md` | Automation Scripts | `/wiki/Automation-Scripts` |
| `_Sidebar.md` | the nav rail on every page | — |
| `_Footer.md` | the footer on every page | — |

Link between pages with the bare page name — `[Automations](Automations)`, not
a relative path and not a `.md` suffix. Those links resolve on the published
wiki; they do **not** resolve when reading the files in this repo, which is the
accepted trade — the wiki is the reading surface.

`README.md` (this file) is repo-only scaffolding and is **not** published.

## Publishing

A GitHub wiki is its own git repository — `<repo>.wiki.git` — so publishing is
a mirror plus a commit. `scripts/wiki-publish.mjs` does it:

```bash
npm run wiki:publish                         # plan: pages to add / update / DELETE vs the live wiki
npm run wiki:publish -- --apply              # commit in a temp clone, print the push command
npm run wiki:publish -- --apply --push       # …and publish
```

It publishes `origin/main` (fetched first; `--ref` overrides), never the working
tree, so a page goes live only once its images exist at their raw `main` URLs.
It runs `npm run check:wiki` over that ref and refuses on a failure, skips this
README, deletes wiki pages the source no longer has, writes LF and re-reads every
committed blob to prove it, and pushes `master`. Each publish commit is titled
`wiki: sync from polaris@<sha>`; the next run reports how far `docs/wiki/` has
moved since. A fork gets its own wiki for free — the URL is derived from
`origin` (`--wiki-url` overrides). `/polaris-deploy` offers the publish after
every push that changed `docs/wiki/`.

The traps it handles — worth knowing when it reports one:

- **The wiki's default branch is `master`, not `main`.** GitHub has never
  changed it for wikis. A script that pushes `main` creates a second branch
  nobody reads, and the wiki keeps serving the old content with no error
  anywhere.
- **The wiki must be initialised once through the GitHub UI** — create a page,
  titled `Home` — before `.wiki.git` exists to clone at all. Until then the
  clone fails with a plain "repository not found".
- **Nothing to publish is the steady state.** The script exits 0 with "the wiki
  is current" rather than letting `git commit` fail on an empty change.
- **A plain copy never deletes**, so a removed or renamed page would outlive its
  source as a stale duplicate. The script mirrors instead: the plan lists every
  page it will DELETE, including ones hand-created in the web UI. Read that line
  before `--push`.
- **On Windows, `text=auto` makes `git archive` and a CRLF checkout emit CRLF**,
  which turns every page into a whole-file rewrite. The script reads blobs with
  `git show`, writes LF into a clone with `core.autocrlf=false`, and fails before
  pushing if a committed blob differs from its source.

Anything edited in the GitHub wiki UI is **overwritten — or deleted — by the
next sync, with no warning and no conflict**: this is a one-way publish.
Corrections belong in `docs/wiki/` as an ordinary commit.

## Images

The publish step copies `docs/wiki/*.md` and nothing else, so **a relative path
to an image outside this directory resolves while you read the file in the repo
and 404s on the published wiki** — the one failure mode here that looks fine
right up until it is live (`npm run check:wiki` fails on one). Reference images
by absolute raw URL instead:

```markdown
![alt text](https://raw.githubusercontent.com/rogers-group-inc/polaris/main/docs/img/screenshots/desktop-noon-dashboard.png)
```

That pins to `main`, so an image is only as current as the last push — which is
the right trade for a wiki nobody clones. A fork publishing its own wiki changes
the org and repo in that URL, as it already changes `WIKI_URL`.

Plain Markdown, not the `<picture>` element the README uses for its light/dark
pair: the wiki's HTML support is narrower, so the pages carry the light
(`noon`) shot only. The images themselves are produced by
`scripts/capture-screenshots.mjs` from a dev instance seeded with invented data
— **never from a real install**, whose hostnames, serials, addresses and
(after GAL directory sync) employee names would be published with the picture.
Re-run it after a UI change: the filenames are stable, so the images are
overwritten in place.

## Keeping it true

A wiki that documents behaviour the app no longer has is worse than no wiki:
it is read as current. `/polaris-docs-sync` carries a routing row for this
directory — when a change lands that alters a page, a screen, a permission
key, an integration field, an automation control or an API endpoint, the
matching page here is updated in the **same commit** as the code.

Pages describe Polaris **as it is today**. The wiki teaches how to use the
application and how it works, so it carries no change history: no "before X
was added", no dated "since / until" notes, no retired features, no
troubleshooting rows that only apply to older builds. Where a past incident
explains a design, state the reason in the present tense ("without X, Y would
happen"). The incident narratives live in the skills.

Pages also describe what Polaris **does**, not what it lacks: no "there is no X
control", no out-of-scope lists. A negative stays only when it tells the
operator what an action does to their data or devices, is a security
guarantee, or points to where the thing is done instead.

`npm run check:wiki` (pre-commit hook and CI) enforces the structure a flat wiki
needs and GitHub never reports: every page linked from `_Sidebar.md`, links as
bare page names that exist, every `Page#anchor` matching a real heading, no
relative images. It cannot tell whether a page is still *true*: the per-commit
routing only refreshes pages a change touches, so a rarely touched page drifts.
The periodic whole-wiki audit for that is
`.claude/skills/polaris-docs-sync/references/wiki-audit.md`.

The pages are written from the project skills under `.claude/skills/`, which
are themselves kept in sync by `/polaris-docs-sync`. When the two disagree, the
skills are right and the wiki is stale.
