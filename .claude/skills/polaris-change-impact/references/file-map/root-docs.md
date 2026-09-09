# File map — repo root, prisma/, docs/, scripts/, deploy/, design/

Everything above `public/` and `src/`.

A slice of the repository tree (`polaris/` is the root; `│` continuation bars are relative to it). Per-file purpose notes follow each entry.
```
polaris/
├── CLAUDE.md
├── .claude/skills/                # The eleven project skills (domain model, business rules, API + RBAC, change impact, UI canon, monitoring + discovery, agent, deploy, docs sync, worktree workflow, tech lifecycle). Each SKILL.md routes to its references/; the four retired root reference docs (architecture, touches, business rules, UI canon) were split into these skills on 2026-09-06. Tracked (the rest of .claude/ is per-developer and gitignored).
├── polaris-business-rules               # Business rules 12-35 in full: the decision AND the incident that forced it. CLAUDE.md keeps each rule's invariant + a pointer.
├── polaris-change-impact                       # Lookup index: per-service writers/readers/invariants + 6 cross-cutting concerns. Reviewed alongside CLAUDE.md on every commit per "Before any commit, review CLAUDE.md, polaris-change-impact, and design/POLARIS-UI-GUIDE.md for updates" — keeps regression-prone relationships visible without rereading every consumer.
├── polaris-ui-canon                      # The Polaris UI canon: the canonical-implementation index for UI patterns — when there are several ways to build the same thing (chart, modal, slide-over, sortable table, …), which file in THIS repo is the reference. Was Part II of design/POLARIS-UI-GUIDE.md until 2026-08-26; split out so a kit re-sync of design/ cannot delete it. Reviewed alongside CLAUDE.md and polaris-change-impact on every commit.
├── design/                          # Drop-in snapshot of the portable UI kit — POLARIS-UI-GUIDE.md (the contract: tokens, themes, shell, tables, modals, the phone SPA, the alert email), plus css/ js/ email/ specimens. A sync may also drop in an `APPLY-*.md` work order naming the divergences to port that round (APPLY-TO-POLARIS.md for the 2026-08 kit port, APPLY-WIDGETS.md for the widget pass); those are consumed and deleted once applied, so don't cite one from elsewhere. Re-synced WHOLESALE from the kit and never edited to chase public/, which is the living source. Nothing Polaris-only belongs here — that is polaris-ui-canon.
├── README.md
├── .env.example
├── package.json
├── tsconfig.json
├── prisma.config.ts                 # Prisma 7 config (datasource URL, seed command)
├── prisma/
│   ├── schema.prisma                # Database schema
│   └── seed.ts
├── docs/
│   ├── INSTALL.md                   # Fresh-install guide (RHEL/Rocky/AlmaLinux 9, Ubuntu/Debian, Windows Server). Includes disk-sizing requirements per volume (DB ≥50 GB, app/state ≥5 GB, /var/log ≥5 GB on STIG layouts) and recovery steps for the "/var is full and Postgres is crash-looping" case. Don't follow this for upgrades — those use the in-app updater under Server Settings → Maintenance → Updates.
│   └── fmg-discovery.md             # FortiManager discovery decision tree (operator-facing): transport mode (proxy vs direct), roster filtering, per-class stamping for FortiGates / FortiSwitches / FortiAPs, push toggles, projection apply. Companion to the phase-by-phase narrative in CLAUDE.md's "FMG Discovery Workflow" section.
├── scripts/
│   ├── test-fmg.mjs                 # FortiManager integration test harness
│   ├── audit-multi-mac-assets.ts    # One-off: unstitch assets cross-stapled by old IP-fallback bug
│   ├── check-fmg-tokens.ts          # One-off: print stored FMG/FortiGate token length/prefix to diagnose token corruption
│   ├── fetch-std-mibs.mjs           # Repopulate src/services/stdMibs/<MODULE>.txt by fetching the eleven canonical standard MIB modules that back the twelve browse-tree keys (SNMPv2-MIB / IF-MIB / HOST-RESOURCES-MIB / ENTITY-MIB / ENTITY-SENSOR-MIB / LLDP-MIB / POWER-ETHERNET-MIB / BRIDGE-MIB / Q-BRIDGE-MIB / RSTP-MIB / IP-MIB — IF-MIB serves both `std:interfaces` and `std:if-ext`). Per-module `mirror` field selects the source: pysnmp.com for all but four, the netdisco-mibs `rfc/` tree for the four switch physical-layer modules (pysnmp was returning HTTP 522 when they were added; each was verified against its published RFC and by canonical-OID resolution). Writes SHA-256 + the actual source URL into SOURCES.md alongside the files, LF-normalizing each module first so the recorded hash matches the bundled artifact on any checkout (`.gitattributes` has `* text=auto`, and pysnmp serves IP-MIB CRLF). SOURCES.md is fully GENERATED — its hand-written sections (cross-module anchors, the known cosmetic gap, licensing) live in this script, because editing them in the output file alone means the next refresh deletes them. Run when refreshing the bundle; existing files are overwritten in place.
│   ├── copy-build-assets.mjs        # BUILD STEP (not ad-hoc): second half of `npm run build` (tsc && node scripts/copy-build-assets.mjs). Mirrors non-.ts runtime assets that tsc won't emit — today the stdMibs/*.txt files — into dist/services/stdMibs/. Without it, every std SNMP-walk (LLDP-MIB etc.) on a built install fails with "Standard MIB ... is not installed on the server", because stdMibLibrary.ts reads the files relative to its compiled location (dist/). Fails the build if it copies 0 files. Every build site invokes `npm run build` so the copy is guaranteed; see polaris-deploy → cross-cutting-deployment.md.
│   └── smoke-std-mibs.ts            # Spot-check that each bundled std MIB parses + resolves to its canonical OIDs (sysDescr=1.3.6.1.2.1.1.1, lldpRemTable=1.0.8802.1.1.2.1.4.1, etc.). Backstop for the resolver + parser; vitest unit tests in tests/unit/stdMibLibrary.test.ts cover the same ground formally.
```

---

---

<a id="core-entities"></a>
