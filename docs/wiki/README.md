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
a copy plus a commit:

```bash
SRC=/path/to/polaris                       # this checkout
WIKI=$(mktemp -d)

git clone https://github.com/rogers-group-inc/polaris.wiki.git "$WIKI"
cp "$SRC"/docs/wiki/*.md "$WIKI"/
rm -f "$WIKI"/README.md                    # repo-only, never published

git -C "$WIKI" add -A
git -C "$WIKI" commit -m "wiki: sync from polaris@$(git -C "$SRC" rev-parse --short HEAD)"
git -C "$WIKI" push origin master
```

Four things that bite an unattended publisher:

- **The wiki's default branch is `master`, not `main`.** GitHub has never
  changed it for wikis. A script that pushes `main` creates a second branch
  nobody reads, and the wiki keeps serving the old content with no error
  anywhere.
- **The wiki must be initialised once through the GitHub UI** — create a page,
  titled `Home` — before `.wiki.git` exists to clone at all. Until then the
  clone fails with a plain "repository not found".
- **`commit` exits non-zero when nothing changed.** That is the normal state
  between doc changes, so treat "nothing to commit" as success, not as a
  failure worth alerting on.
- **This copies in; it never deletes.** A page removed from `docs/wiki/`, or one
  somebody hand-created in the web UI, stays on the wiki forever. Renaming a
  page therefore leaves the old title behind as a stale duplicate — delete it in
  the wiki UI, or have the publisher `git rm` what the source no longer has.

Anything edited in the GitHub wiki UI is **overwritten by the next sync, with
no warning and no conflict** — this is a one-way publish. Corrections belong in
`docs/wiki/` as an ordinary commit.

## Keeping it true

A wiki that documents behaviour the app no longer has is worse than no wiki:
it is read as current. `/polaris-docs-sync` carries a routing row for this
directory — when a change lands that alters a page, a screen, a permission
key, an integration field, an automation control or an API endpoint, the
matching page here is updated in the **same commit** as the code.

The pages are written from the project skills under `.claude/skills/`, which
are themselves kept in sync by `/polaris-docs-sync`. When the two disagree, the
skills are right and the wiki is stale.
