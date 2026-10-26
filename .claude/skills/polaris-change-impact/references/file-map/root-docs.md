# File map — repo root, prisma/, docs/, scripts/, deploy/, design/

Everything above `public/` and `src/`.

A slice of the repository tree (`polaris/` is the root; `│` continuation bars are relative to it). Per-file purpose notes follow each entry.
```
polaris/
├── CLAUDE.md
├── .claude/skills/                # The eleven project skills (domain model, business rules, API + RBAC, change impact, UI canon, monitoring + discovery, agent, deploy, docs sync, worktree workflow, tech lifecycle). A twelfth, design sync, was retired 2026-09-11 — the bundled /design-sync reads .design-sync/ directly. Each SKILL.md routes to its references/; the four retired root reference docs (architecture, touches, business rules, UI canon) were split into these skills on 2026-09-06. Tracked (the rest of .claude/ is per-developer and gitignored).
├── polaris-business-rules               # Business rules 12-35 in full: the decision AND the incident that forced it. CLAUDE.md keeps each rule's invariant + a pointer.
├── polaris-change-impact                       # Lookup index: per-service writers/readers/invariants + 6 cross-cutting concerns. Reviewed alongside CLAUDE.md on every commit per "Before any commit, review CLAUDE.md, polaris-change-impact, and design/POLARIS-UI-GUIDE.md for updates" — keeps regression-prone relationships visible without rereading every consumer.
├── polaris-ui-canon                      # The Polaris UI canon: the canonical-implementation index for UI patterns — when there are several ways to build the same thing (chart, modal, slide-over, sortable table, …), which file in THIS repo is the reference. Was Part II of design/POLARIS-UI-GUIDE.md until 2026-08-26; split out so a kit re-sync of design/ cannot delete it. Reviewed alongside CLAUDE.md and polaris-change-impact on every commit.
├── design/                          # Sources of the two design systems published as claude.ai artifacts (the repo is the standard; the artifacts are read-only copies). `desktop/` = Polaris UI and `mobile/` = Polaris Mobile, each a README.md brand book, a tokens.json of token NAMES + usage notes + type styles (values are generated from the app CSS, never stored here) and components/<Name>/{preview.html,README.md} example pages; `img/brand/` the logos; `POLARIS-UI-GUIDE.md` the long-form desktop guide, maintained here. The kit copies that used to live here (css/ js/ email/ and the starter templates) were retired 2026-10-26 — they had drifted ~1,250 lines from public/.
├── .design-sync/                    # Builds and publishes the design systems. `build.mjs` (+ `config.json`: artifact urls, source dirs, the app stylesheet per system, theme selector chains) assembles the gitignored `ds-bundle/<system>/project/` from design/<system>/ + public/css/styles.css or mobile.css (published verbatim as bundle.css), generates tokens.json VALUES from that CSS, renders the AlertEmail page from the real template via `render-email.ts` (tsx), and fails on a page class the stylesheet does not define. `NOTES.md` is the durable record AND the procedure — trigger table, the Artifact-tool publish steps, the design-first workflow, the history — and /design-sync reads it before acting. Tracked.
├── README.md
├── .env.example
├── package.json
├── tsconfig.json
├── prisma.config.ts                 # Prisma 7 config (datasource URL, seed command)
├── prisma/
│   ├── schema.prisma                # Database schema
│   └── seed.ts
├── docs/
│   ├── INSTALL.md                   # Fresh-install guide (RHEL/Rocky/AlmaLinux 9, Ubuntu/Debian, container). Includes disk-sizing requirements per volume (DB ≥50 GB, app/state ≥5 GB, /var/log ≥5 GB on STIG layouts) and recovery steps for the "/var is full and Postgres is crash-looping" case. Fresh installs ONLY since 2026-09-15 — an existing install goes to the in-app updater, or to UPGRADING.md below.
│   ├── UPGRADING.md                 # Every runbook for a host that already exists: a Node or signing-JDK major, PostgreSQL 15 → 17 (with the Docker/Unraid dump-and-restore variant), RHEL AppStream → PGDG, the legacy single-process polaris.service → split-role, the pre-nginx → nginx cutover, and recovering an update that died on a TLS-intercepting network. Split out of INSTALL.md so a first-time installer is not reading 760 lines addressed to someone else. Deliberately NOT a check:versions site — it names the version you are leaving beside the one you are going to (see polaris-tech-lifecycle → pin-consistency-check.md).
│   └── fmg-discovery.md             # FortiManager discovery decision tree (operator-facing): transport mode (proxy vs direct), roster filtering, per-class stamping for FortiGates / FortiSwitches / FortiAPs, push toggles, projection apply. Companion to the phase-by-phase narrative in CLAUDE.md's "FMG Discovery Workflow" section.
├── scripts/
│   ├── test-fmg.mjs                 # FortiManager integration test harness
│   ├── next-rule-number.mjs         # `npm run rules:next`: the next free business-rule number, derived by scanning main AND every worktree-* branch (invariant lines, `## Rule N` narrative headings, SKILL.md index rows) — never stated in a doc, because a stated number is stale the moment another branch merges (polaris-business-rules → Numbering)
│   ├── check-wiki.mjs               # `npm run check:wiki`: structural guard over docs/wiki/ (every page in _Sidebar.md, bare page-name links that resolve, Page#anchor matching a real GitHub heading slug, no relative images). Pre-commit hook + Check docs CI job. Cannot judge accuracy — polaris-docs-sync → wiki-audit.md
│   ├── wiki-publish.mjs             # `npm run wiki:publish`: one-way MIRROR of docs/wiki/ at origin/main into <origin>.wiki.git `master` — plan by default, `--apply` commits in a temp clone, `--push` publishes. Refuses on a check:wiki failure, deletes pages the source dropped, skips README.md, writes LF and verifies the committed blobs (Windows CRLF trap). Run by /polaris-deploy step 7, which publishes without asking when the plan shows the live wiki is behind
│   ├── wiki-lib.mjs                 # Pure helpers both of the above share (GitHub slugger, link/anchor extraction, checkWikiPages, planPublish, the polaris@<sha> marker); tests/unit/wikiLib.test.ts
│   ├── audit-multi-mac-assets.ts    # One-off: unstitch assets cross-stapled by old IP-fallback bug
│   ├── check-fmg-tokens.ts          # One-off: print stored FMG/FortiGate token length/prefix to diagnose token corruption
│   ├── fetch-std-mibs.mjs           # Repopulate src/services/stdMibs/<MODULE>.txt by fetching the eleven canonical standard MIB modules that back the twelve browse-tree keys (SNMPv2-MIB / IF-MIB / HOST-RESOURCES-MIB / ENTITY-MIB / ENTITY-SENSOR-MIB / LLDP-MIB / POWER-ETHERNET-MIB / BRIDGE-MIB / Q-BRIDGE-MIB / RSTP-MIB / IP-MIB — IF-MIB serves both `std:interfaces` and `std:if-ext`). Per-module `mirror` field selects the source: pysnmp.com for all but four, the netdisco-mibs `rfc/` tree for the four switch physical-layer modules (pysnmp was returning HTTP 522 when they were added; each was verified against its published RFC and by canonical-OID resolution). Writes SHA-256 + the actual source URL into SOURCES.md alongside the files, LF-normalizing each module first so the recorded hash matches the bundled artifact on any checkout (`.gitattributes` has `* text=auto`, and pysnmp serves IP-MIB CRLF). SOURCES.md is fully GENERATED — its hand-written sections (cross-module anchors, the known cosmetic gap, licensing) live in this script, because editing them in the output file alone means the next refresh deletes them. Run when refreshing the bundle; existing files are overwritten in place.
│   ├── copy-build-assets.mjs        # BUILD STEP (not ad-hoc): second half of `npm run build` (tsc && node scripts/copy-build-assets.mjs). Mirrors non-.ts runtime assets that tsc won't emit — today the stdMibs/*.txt files — into dist/services/stdMibs/. Without it, every std SNMP-walk (LLDP-MIB etc.) on a built install fails with "Standard MIB ... is not installed on the server", because stdMibLibrary.ts reads the files relative to its compiled location (dist/). Fails the build if it copies 0 files. Every build site invokes `npm run build` so the copy is guaranteed; see polaris-deploy → cross-cutting-deployment.md.
│   └── smoke-std-mibs.ts            # Spot-check that each bundled std MIB parses + resolves to its canonical OIDs (sysDescr=1.3.6.1.2.1.1.1, lldpRemTable=1.0.8802.1.1.2.1.4.1, etc.). Backstop for the resolver + parser; vitest unit tests in tests/unit/stdMibLibrary.test.ts cover the same ground formally.
```

---

---

<a id="core-entities"></a>
