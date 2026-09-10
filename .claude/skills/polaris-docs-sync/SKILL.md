---
name: polaris-docs-sync
description: "Pre-commit documentation review for Polaris: which skill reference file each kind of change must update (new Prisma model, service, job, route, permission key, env var, metric, agent stream, business rule, UI canonical, integration type), the lockstep checklists, the skill-authoring constraints, and how to run and fix npm run check:docs. Run /polaris-docs-sync before every commit and after check-docs fails."
disable-model-invocation: true
---

# Docs sync — the commit-time review

The project memory lives in `CLAUDE.md` (always loaded, ≤15 KB) and eleven skills under
`.claude/skills/` (loaded on demand). They only stay trustworthy if every commit refreshes
what the change moved, broke or invalidated. A pre-commit hook and a CI job
(`npm run check:docs`, `scripts/check-docs.mjs`) enforce the *structural* half — every
model / service / job / route / util named, no `file:line` refs, every service has a touches
entry, every referenced path exists, every reference file linked and under size — but they
cannot judge whether prose is still accurate. That is what this review is for.

## The procedure (before the end-of-work commit)

1. **List what the change touched**: models, services, jobs, routes, utils, public/ files,
   env vars, metrics, agent code, deploy artifacts, rules cited in the diff.
2. **Open the owning entries** with the routing table below and re-read them against the
   diff. Update anything the change moved, broke or invalidated — in the same commit.
   Business-rule text is quoted, never paraphrased; a changed invariant changes both the
   `invariants-*.md` line and the `narrative-*.md` section.
3. **New things get new entries**: a model → its Definitions bullet + Schema block; a service
   → a `## services/<name>.ts` touches entry + a file-map line; a job → the jobs table + file
   map; a route → the endpoints file + `routes-overview.md` if it is a new group; a canonical
   UI pattern → `polaris-ui-canon`; a new rule → next free number in `polaris-business-rules`.
4. Run `npm run check:docs`; fix every failure (see
   [references/check-docs-reference.md](references/check-docs-reference.md)).
5. Then `npm run typecheck` and the unit suite, then commit (the worktree end-of-work commit
   per `polaris-worktree-workflow`).

## Routing table — change kind → what to update

[references/change-routing.md](references/change-routing.md) carries the full table with
the pre-skills task list verbatim. The short form:

| Change | Update |
|---|---|
| Prisma model / column / enum | `polaris-domain-model/references/<domain>.md` (Definitions + Schema + Notes); migration; Zod schema in the route file |
| new or changed service | `polaris-change-impact/references/services/<group>.md` (`## services/<name>.ts`), `file-map/src-services-*.md`; cross-cutting file(s) whose Writers/Readers changed |
| new or changed job | `polaris-monitoring-discovery/references/background-jobs.md`, `file-map/src-jobs.md` |
| new or changed route / gate | `polaris-api-rbac/references/endpoints-*.md`, `routes-overview.md`; `cross-cutting/dynamic-roles-permission-matrix.md` for a new key (+ migration seeding it on every Role) |
| new util | `file-map/src-utils-*.md`; `tests/unit/<name>.test.ts` (check-docs warns) |
| env var | `.env.example`, `polaris-deploy/references/env-vars.md`, `docs/INSTALL.md`, `deploy/setup-*` |
| `polaris_*` metric | `src/metrics.ts`, `polaris-monitoring-discovery/references/observability.md`, `cross-cutting/observability-metrics.md`, `docs/grafana/*.json` + README |
| agent code / sample stream | `agent/VERSION`; `polaris-agent/references/cross-cutting-polaris-agent.md`; `SamplesBodySchema` |
| polling method / collector | `utils/pollingCapability.ts` + `_collectorExists` in `public/js/integrations.js`; `polling-methods-streams.md`; `cross-cutting/polling-method-resolver.md` |
| integration type | `cross-cutting/integration-type-onboarding.md` checklist; `discovery-*.md`; `routes-overview.md`; the modal in `polaris-ui-canon` |
| UI pattern or shared module | `polaris-ui-canon/references/canon-*.md`, the pages/modules tables in its SKILL.md; `design/POLARIS-UI-GUIDE.md` is never edited (drop-in zone) |
| business rule | `polaris-business-rules` (SKILL.md for 1–11; `invariants-*.md` + `narrative-*.md` for 12+); cite the number from code |
| `public/api.html` (the external API contract) | regenerate the `polaris-api-conventions` plugin. The clone lives beside this checkout at `../polaris-api-conventions` (do not re-clone; origin https://github.com/rogers-group-inc/polaris-api-conventions). From the folder holding both clones: `node polaris-api-conventions/scripts/import-api-html.mjs polaris/public/api.html`, then in the plugin repo bump `plugin.json` version, commit, push. `check:docs` compares its `sourceApiHtmlSha256` against the current page and warns (never fails) when they have drifted — silence means current, or that the clone was not found |
| Fortinet API behaviour learned the hard way (an FMG JSON-RPC or FortiOS REST call, or a FortiSwitch/FortiAP MIB, that did not do what the docs say — usually a change under `services/fortimanagerService.ts`, `services/fortigateService.ts`, `services/forti*`, `utils/forti*`) | record it in the `fortinet-api-conventions` plugin, beside this checkout at `../fortinet-api-conventions` (origin https://github.com/davidmoore-rogers/fortinet-api-conventions). Add or amend the entry in its `skills/fortinet-api-conventions/references/*.md` (a new rule goes in its SKILL.md too), bump `plugin.json` version, commit, push. Vendor behaviour only — no Polaris names, fields or hostnames. Both plugin repos are separate git repos: their commits are their own, never part of the Polaris commit |
| `design/css/` re-synced from the external kit (a `docs(design): sync the kit` commit) | re-sync the Claude Design design system so future apps inherit the current look: `node .design-sync/build.mjs`, then `DesignSync` `finalize_plan` + `write_files` against the `projectId` in `.design-sync/config.json` (project `Polaris UI`). Re-validate every class and token named in `.design-sync/conventions.md` against the new CSS, and re-render the preview cards — they are static and will not notice a layout change, only a removed class name. `.design-sync/NOTES.md` is the full procedure. `design/` tracks the external kit and is never edited to chase `public/`, so a `public/css/` change alone is NOT a trigger |
| deploy artifact, Dockerfile, unit, nginx | `polaris-deploy/references/*`, `docs/INSTALL.md`, `README.md` |
| a version pin, a dependency major, an EOL date | `polaris-tech-lifecycle/references/version-pin-inventory.md` (every declaration site for that family) + the matching upgrade playbook; run `npm run check:versions`; a changed date also updates `src/data/platformEol.json` per `references/eol-dataset.md` |
| the session workflow itself | `polaris-worktree-workflow`, the CLAUDE.md "Session workflow" paragraph, the hook script |

## Skill-authoring constraints (check-docs enforces the structural ones)

- `name:` in frontmatter equals the directory; `description:` is the ONLY auto-load signal — write it with explicit trigger phrases.
- `SKILL.md` body ≤ ~200 lines: routing and invariants, not the reference material.
- Reference files: ≤ 1500 lines (fail) and ≈ 80 KB target (warn at 100 KB); split by heading, never mid-section.
- Every `references/**/*.md` is linked from its skill's `SKILL.md` (orphans fail).
- Code references are `path/file.ts → symbol()`; never a file plus a line number, in any phrasing.
- Prose moves verbatim between files; only routing text is rewritten.
- `CLAUDE.md` stays under 15 KB (warn) / 25 KB (fail): it holds conventions and the skills index, never reference material.
