---
name: polaris-docs-sync
description: "Pre-commit documentation review for Polaris: which skill reference file — and which page of the operator wiki under docs/wiki/ — each kind of change must update (new Prisma model, service, job, route, permission key, env var, metric, agent stream, business rule, UI canonical, integration type, and anything an operator sees or configures), the lockstep checklists, the skill-authoring constraints, and how to run and fix npm run check:docs. Also covers the wiki itself — operator docs, help page, docs/wiki, the GitHub wiki the Help entry opens, the authoring rules a flat wiki imposes, npm run check:wiki and a broken wiki link or anchor, and the monthly whole-wiki accuracy audit (is the wiki still right / stale wiki pages). Run /polaris-docs-sync before every commit and after check-docs fails; /polaris-deploy runs this review itself as its first step, so a task shipped through it never needs a separate invocation."
disable-model-invocation: true
---

# Docs sync — the commit-time review

The project memory lives in `CLAUDE.md` (always loaded, ≤15 KB) and twelve skills under
`.claude/skills/` (loaded on demand). They only stay trustworthy if every commit refreshes
what the change moved, broke or invalidated. A pre-commit hook and a CI job
(`npm run check:docs`, `scripts/check-docs.mjs`) enforce the *structural* half — every
model / service / job / route / util named, no `file:line` refs, every service has a touches
entry, every referenced path exists, every reference file linked and under size — but they
cannot judge whether prose is still accurate. That is what this review is for.

## The procedure (before the end-of-work commit)

`/polaris-deploy` runs this procedure as step 1 of its release pipeline, over the whole branch,
before its deploy audit, commit, merge and push. Invoke it on its own only for a commit made
outside that pipeline, or after `check:docs` fails.

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
   [references/check-docs-reference.md](references/check-docs-reference.md)). When
   `docs/wiki/` changed, also run `npm run check:wiki` (sidebar, bare page-name links, `#anchor`
   targets, no relative images; `scripts/check-wiki.mjs`).
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
| polling method / collector | `utils/pollingCapability.ts` + `_collectorExists` in `public/js/polling-methods.js`; `polling-methods-streams.md`; `cross-cutting/polling-method-resolver.md` |
| integration type | `cross-cutting/integration-type-onboarding.md` checklist; `discovery-*.md`; `routes-overview.md`; the modal in `polaris-ui-canon` |
| UI pattern or shared module | `polaris-ui-canon/references/canon-*.md`, the pages/modules tables in its SKILL.md; a NEW pattern also gets its page under `design/<system>/components/` (see the design-system row below) |
| business rule | `polaris-business-rules` — `npm run rules:next` for the number; a ~150-word invariant appended to `invariants-30-43.md`, a new `narrative-N.md` (one file per rule), an index row in its SKILL.md; cite the number from code and the pinning test. `check:docs` (`rule-anchors`) fails when the three layers disagree |
| **anything an operator sees or configures** — a page, tab, card, modal, widget, wizard step or control under `public/`; a permission key or a route gate; an integration config field or toggle; an automation trigger / action / recipient kind; a polling method or stream; a Server Settings surface; a business rule's operator-visible behaviour | the matching page under **`docs/wiki/`**, which is the source for the GitHub wiki the account menu's **Help** entry opens (`WIKI_URL` in `public/js/app.js`). `docs/wiki/README.md` carries the file→page mapping and the publish procedure. The page map is: screens → `Dashboard` / `IPAM` / `Assets` / `Device-Map` / `Application-Map` / `Events` / `Automations` / `Integrations` / `Users-Roles-and-Permissions` / `Server-Settings` / `Mobile-and-Dash`; automations → `Automation-Triggers` / `Automation-Actions` / `Automation-Escalation` / `Automation-Scripts` / `Delivery-Channels` / `Address-Book`; monitoring → `Monitoring` / `Polling-Methods` / `Monitor-States` / `Dependency-Suppression` / `Maintenance-Windows`; discovery → `Discovery` / `Integration-*` / `Polaris-Agent` / `Network-Discovery`; reference → `Conflict-Resolution` / `Business-Rules` / `API` / `Backup-and-Restore` / `Updates` / `High-Availability` / `Troubleshooting`. A **new rule** gets a `### Rule N` heading in `Business-Rules.md` (the heading text is exactly `Rule N` — it is the `#rule-N` anchor every other page cites). A **new page** is also added to `_Sidebar.md`, or it is unreachable. Links between pages are bare page names, never paths or `.md` suffixes. `npm run check:wiki` enforces those three, and so do the pre-commit hook and CI. **Publishing is not part of this review.** It happens after the push: `/polaris-deploy` runs `npm run wiki:publish` and publishes, without asking, only when the live wiki is behind. The monthly whole-wiki accuracy pass, which catches drift on pages no commit touches, is [references/wiki-audit.md](references/wiki-audit.md) |
| `public/api.html` (the external API contract) | **two places, both required.** (1) `docs/wiki/API.md`, which mirrors the same endpoint list and conventions for readers with no install in front of them — it is a mirror, so an endpoint added to the page and not to it is a wiki that documents a narrower API than Polaris has. (2) regenerate the `polaris-api` skill of the `polaris-toolbox` plugin. The clone lives beside this checkout at `../polaris-toolbox` (do not re-clone; origin https://github.com/rogers-group-inc/polaris-toolbox). From the folder holding both clones: `node polaris-toolbox/scripts/import-api-html.mjs polaris/public/api.html`, then in the toolbox repo bump `plugin.json` version, commit, push. `check:docs` compares its `sourceApiHtmlSha256` against the current page and warns (never fails) when they have drifted — silence means current, or that the clone was not found |
| Fortinet API behaviour learned the hard way (an FMG JSON-RPC or FortiOS REST call, or a FortiSwitch/FortiAP MIB, that did not do what the docs say — usually a change under `services/fortimanagerService.ts`, `services/fortigateService.ts`, `services/forti*`, `utils/forti*`) | record it in the `fortinet-api-conventions` plugin, beside this checkout at `../fortinet-api-conventions` (origin https://github.com/ApexAlphaHero/fortinet-api-conventions). Add or amend the entry in its `skills/fortinet-api-conventions/references/*.md` (a new rule goes in its SKILL.md too), bump `plugin.json` version, commit, push. Vendor behaviour only — no Polaris names, fields or hostnames. Both plugin repos are separate git repos: their commits are their own, never part of the Polaris commit |
| the automation SCRIPT surface (a new interpreter, a new `{token}`, a changed limit or `POLARIS_*` context var — `services/automationScriptRunner.ts`, `automationScriptService.ts`, `utils/notificationTemplate.ts`, `agent/internal/scriptexec/`) | mirror it in the `polaris-automation-scripts` skill of the `polaris-toolbox` plugin (`../polaris-toolbox`, origin https://github.com/rogers-group-inc/polaris-toolbox). It generates pasteable scripts from facts read out of those exact files, so a change there silently invalidates them: amend the reference, bump `plugin.json`, commit and push in that repo. The TRIGGER vocabulary is not its surface — it is about what a script may do once an automation fires |
| manufacturer profiles and MIB resolution (`services/manufacturerProfileService.ts`, `manufacturerProfilePortabilityService.ts` — the profile FILE format —, `profileResolver.ts`, `oidRegistry.ts`, `mibService.ts`, the SNMP collectors' use of a profile in `monitoringService.ts`, `customWidgetEnablementService.ts`, `utils/hardwareSensors.ts`, `utils/stateProbes.ts`, `utils/symbolTransforms.ts`, `utils/modelParse.ts`; business rules 116 / 130 / 131 / 132) | the `polaris-manufacturer-profiles` skill of `../polaris-toolbox`: its references state what each row does at collection, what saves and does nothing, and the file format its `profiles/` library and `scripts/apply-profile.py` / `export-profiles.py` speak. A changed field, validation, fallback order or file field silently makes its advice wrong: amend the reference (and the profile files when the format moved), bump `plugin.json`, commit and push in that repo |
| the automation RULE surface (`services/notificationTypes.ts` — every schema, enum and default —, `notificationRuleService.ts`, the engine's gates and carve-out in `notificationEngine.ts`, the wizard's step names, the `/automations` routes) | the `polaris-automations` skill of `../polaris-toolbox`: its references quote field names, enums, defaults and the wizard's on-screen names, and its recipes are bodies validated against a running Polaris — re-run them through `scripts/apply-automation.py --dry-run` on a dev stack when the schema moves. Amend, bump `plugin.json`, commit and push in that repo |
| `public/css/styles.css` or `mobile.css`, anything under `design/`, the alert email template (`utils/alertEmailTemplate.ts`, `services/alertBrandService.ts`), or `.design-sync/` | a NEW UI pattern also gets its page under `design/<system>/components/` in the same commit. Then re-sync the design-system artifacts (Polaris UI / Polaris Mobile): `node .design-sync/build.mjs` must pass, and the publish follows `.design-sync/NOTES.md` (its trigger table says which system). `/polaris-deploy` publishes after its push; a commit outside it publishes by hand. The artifacts are read-only copies of the repo, so a sync that does not run leaves them stale with nothing to say so |
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
