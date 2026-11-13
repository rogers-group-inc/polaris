# Business rule 177 — full narrative

> Written 2026-11-13 as its own file (one file per rule from 78 on). Rule numbers are a
> stable citation key — never renumber. 81 is a deliberate gap.

Each rule records the decision *and the incident or constraint that forced it*. The invariant is in `invariants-30-43.md`; rule numbers are a stable citation key — never renumber.

- [Rule 177](#rule-177) — An automation that names something deleted says so, wherever it is shown

## Rule 177 — An automation that names something deleted says so, wherever it is shown

**How it was found.** Rules 167 and 167(a) (the 2026-11-11 orphan audit, batch E) refuse to delete a delivery channel, automation script, path check, custom widget or state probe that an automation still names. That stops NEW broken references. It does nothing for the ones already there: an automation whose channel was deleted before those guards shipped stays enabled, keeps evaluating, and sends nothing — and so does one broken by a backup restore, a row edited in SQL, or an import that names an id this install never had. The audit ledger carried it as "references that already dangle".

**The decision (operator, 2026-11-13).** Point them out; change nothing. Asked to choose between a one-time list in Events and a marker on the automation, the operator chose the marker, because it stays visible until the automation is fixed. On reviewing the design canvas, they asked that the list show **only the marker** — a warning triangle before the name — with what is wrong as its **hover text**, and approved the editor's warning as drawn.

**What it does.**

- `GET /automations` decorates every row with `brokenReferences`, computed by `actionReferenceService.brokenReferencesByRule` — the reverse of rule 167's referrer walk, over the same `allRuleActionRefs`, so every place an action can live is covered and the message names it ("Action 1 escalation tier 2 sends to a delivery channel that was deleted…"). Conditions are walked as raw JSON for the three narrowed-to ids. Only what the rows reference is looked up: one `IN` read per kind of object for the whole list.
- The Automations list draws the marker and puts the messages in its `title` and `aria-label`.
- The automation editor (edit, view and clone; not import, which has its own report) shows the messages in the app's warning callout above the steps, and a Notify action whose stored channel no longer exists says so under its channel boxes instead of just showing nothing ticked.

**What it does not do.** It repairs nothing — removing the reference would change what the automation does on the say-so of whoever deleted the other thing (rule 167's reasoning). It does not cover alert groups, which carry actions of their own; the list only marks automations. `brokenReferences` is computed, never stored, and is stripped from export and view code so an imported file never carries it.

**Scale.** The list is read when the Automations page opens. The decoration adds at most four indexed `IN` reads, and none when nothing references a given kind.

Pinned by `tests/unit/brokenReferences.test.ts`.
