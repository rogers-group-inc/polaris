# check-docs reference — what each check enforces and how to fix it

`npm run check:docs` (`scripts/check-docs.mjs`) runs as a pre-commit hook (`.githooks/pre-commit`,
activated by `postinstall` via `core.hooksPath`) and as the CI job `.github/workflows/check-docs.yml`.
It reads `CLAUDE.md` plus every `.md` under `.claude/skills/**` — the "doc set" — and checks
structure and reference hygiene only. It cannot judge whether prose is accurate; that is the
review in `SKILL.md`. Bypass one commit with `git commit --no-verify` and say so in the hand-off.

| Check | Fails when | Fix |
|---|---|---|
| `docs-present` | any of the eleven `.claude/skills/<name>/SKILL.md` files is missing, or `CLAUDE.md` is | restore the file; the eleven names are listed in the script's `SKILLS` array |
| `no-line-numbers` | any doc cites a source location by line number — a `file.ts` followed by a colon and digits, or prose such as "around line" + a number | cite `path/file.ts → symbolName()` instead; line numbers drift |
| `models-documented` | a `model X {` in `prisma/schema.prisma` (except `*Hourly` / `*Daily` rollups) is named in no doc | add a Definitions bullet + Schema block to the right `polaris-domain-model/references/<domain>.md` |
| `files-documented` | a `src/services|jobs|api/routes|utils/*.ts` file (not `_`-prefixed, not `.d.ts`) is named in no doc | add it to the matching `polaris-change-impact/references/file-map/*.md` slice (and the jobs table for a job) |
| `paths-exist` | a concrete `src/ public/ prisma/ scripts/ deploy/ docs/ .claude/skills/` path named in a doc does not exist on disk | fix the path or delete the dead pointer; templated paths with `<>` or `*` are ignored |
| `index-casing` / `retired-doc` | a doc names the lowercase variants of the old index files, the retired templates index, or one of the four retired root docs (ARCHITECTURE, TOUCHES, BUSINESS-RULES, UI-CANON) as a pointer — a provenance phrase ("verbatim from …") is allowed | point at the skill file that now holds the content (this file is allow-listed so it can describe the retirement) |
| `touches-service-coverage` | a `src/services/*.ts` is not mentioned anywhere under `polaris-change-impact/references/services/` (a mention without a `## services/<name>.ts` heading of its own only warns) | add the per-service entry (What it owns / Public API / Cross-service deps / Used by / Invariants / When changing this) or list it in `TOUCHES_EXEMPT` with a reason |
| `skill-frontmatter` | a `SKILL.md` lacks frontmatter, its `name:` differs from its directory, its `description:` is empty, or it uses an unknown key | keys allowed: `name`, `description`, `user-invocable`, `disable-model-invocation`, `allowed-tools`, `argument-hint` |
| `reference-size` | a reference `.md` exceeds 1500 lines (fail) — 100 KB is a warning | split by heading into a sibling file and link both from the SKILL.md |
| `orphan-reference` | a `references/**/*.md` (or `scripts/*`) is not linked from its skill's `SKILL.md` | add a `[name](references/…)` link in the routing table |
| `claude-md-size` | `CLAUDE.md` is over 25 KB (fail); over 15 KB warns | move reference material into a skill; CLAUDE.md holds conventions and the index only |
| util-test coverage (warn) | a `src/utils/*.ts` with runtime exports has no `tests/unit/<name>.test.ts` | add the test when you next touch the util |
| `api-plugin-fresh` (warn) | `public/api.html` no longer hashes to the `sourceApiHtmlSha256` that the `polaris-api-conventions` plugin recorded when it was generated — i.e. the published client guide has fallen behind this repo's API page | regenerate the plugin in its own clone and push it there (the routing row in `SKILL.md` has the command). Warn-only and **skipped entirely when the clone is not found**, because the plugin lives in a separate repo and is not a build input: CI and a fresh clone must not be failed by its absence |

## Typical failure → cause

- **A commit that adds a service fails `files-documented` AND `touches-service-coverage`**: both the file-map line and the touches entry are required; they answer different questions ("what is it" vs "what depends on it").
- **`paths-exist` after a rename**: grep the doc set for the old path; the skills cite files by path in dozens of places.
- **`orphan-reference` after splitting a big file**: the new sibling needs its own link in the SKILL.md table.
- **The hook did not run**: `git config core.hooksPath` should print `.githooks`; `npm install` sets it.
- **`api-plugin-fresh` says nothing at all**: it is silent both when the plugin is current and when the clone was not found. It looks for `polaris-api-conventions/` by walking UP from the repo root, so it works from the main checkout and from a worktree under `.claude/worktrees/<slug>` alike — a plain `../` lookup would resolve inside the worktrees folder and skip silently in every tree where work actually happens.
- **`api-plugin-fresh` must not fire on line endings alone**: the plugin stamps the hash of api.html's RAW bytes, so a checkout with different endings than the machine that ran the generator would mismatch on whitespace. The check hashes the file as-is, as LF and as CRLF, and accepts any match — the question it asks is whether the CONTENT moved.

## History

The five-file era (CLAUDE.md + ARCHITECTURE.md + BUSINESS-RULES.md + TOUCHES.md + UI-CANON.md)
ended 2026-09-06 when the reference tiers were split into `.claude/skills/`. The pre-2026-09
convention read: *"Before any commit, review CLAUDE.md, ARCHITECTURE.md, BUSINESS-RULES.md,
TOUCHES.md, and UI-CANON.md for updates … anything the change moved, broke, or invalidated gets
refreshed in the same commit. The indexes only stay trustworthy if they're reviewed every commit."*
The obligation is unchanged; only the files moved.
