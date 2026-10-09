# Whole-wiki accuracy audit

The per-commit wiki row in the routing table only refreshes the pages a change touches.
That keeps the busy pages current and leaves the quiet ones to rot. Run this audit about
once a month, or when someone asks whether the wiki is still right.

## Why it exists

The first full audit (2026-10-07, 46 pages) found per-commit docs-sync had kept the busy
pages (Automations, Assets, Server Settings) accurate. The drift was all on pages nothing
had touched in weeks:
- Windows Server claimed a reservation and lease import that never existed.
- The Server Settings tab table named tabs that had moved.
- Three business rules (66, 67, 81) had no `### Rule N` heading, so the inbound
  `Business-Rules#rule-N` links led nowhere.

`npm run check:wiki` now catches that last kind. Only reading the page against the code
catches the first two.

## Procedure

1. **Start from a worktree** like any other change. Run `npm run check:wiki` first and fix
   its failures, so the read-through spends no time on links.
2. **Split the pages into about six groups by subject**, not alphabetically, so one reader
   holds one area of the code in mind. The routing table's page map works as the grouping:
   screens / automations / monitoring / discovery + integrations / reference (Business-Rules,
   API, Backup-and-Restore, Updates, High-Availability, Troubleshooting) / setup (Home,
   Concepts, Installation, First-Run-Setup, Navigation-and-Account).
3. **Give each group to a parallel agent.** Its brief: for every factual claim on the page
   (a control, a field, a default, a permission key, a limit, a behaviour), find the code
   that implements it and report each claim as *true*, *false (with what the code does)*
   or *unverifiable*. Point each agent at the skills that own the area, since the skills
   are the faster index. Ask for findings only, with no edits, so the fixes land in one
   reviewable diff.
4. **Apply the fixes yourself** against the code, not against the agent's summary. Where a
   page and a skill disagree, the skill wins only if the code agrees with it. Otherwise fix
   both.
5. **Rule headings**: every rule listed in `polaris-business-rules` SKILL.md that has operator-visible
   behaviour has a `### Rule N` heading in `Business-Rules.md`. Retired rules keep their
   heading with a retirement note, because old inbound links still point at it.
6. Run `npm run check:wiki`, commit, and ship through `/polaris-deploy`. Its last step offers
   the wiki publish.

## Recording it

Update the "last audited" line below in the same commit, so the next session can tell
when one is due.

Last audited: 2026-10-07 (46 pages; worktree `wiki-refresh`).
