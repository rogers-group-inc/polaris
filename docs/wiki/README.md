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
git clone https://github.com/rogers-group-inc/polaris.wiki.git /tmp/polaris-wiki
cp docs/wiki/*.md /tmp/polaris-wiki/
rm -f /tmp/polaris-wiki/README.md          # repo-only, never published
cd /tmp/polaris-wiki
git add -A && git commit -m "wiki: sync from polaris@$(git -C /path/to/polaris rev-parse --short HEAD)"
git push
```

The wiki must be initialised once through the GitHub UI (create any page)
before `.wiki.git` exists to clone.

## Keeping it true

A wiki that documents behaviour the app no longer has is worse than no wiki:
it is read as current. `/polaris-docs-sync` carries a routing row for this
directory — when a change lands that alters a page, a screen, a permission
key, an integration field, an automation control or an API endpoint, the
matching page here is updated in the **same commit** as the code.

The pages are written from the project skills under `.claude/skills/`, which
are themselves kept in sync by `/polaris-docs-sync`. When the two disagree, the
skills are right and the wiki is stale.
