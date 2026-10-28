# Business rule 136 — full narrative

> Written 2026-10-28 as its own file (one file per rule from 78 on). Rule numbers are a
> stable citation key — never renumber. 81 is a deliberate gap.

Each rule records the decision *and the incident or constraint that forced it*. The invariant is in `invariants-30-43.md`; rule numbers are a stable citation key — never renumber.

- [Rule 136](#rule-136) — The five Priority tags are built in: nobody renames, recolours, moves or deletes them, and a device filter on one only adds

<a id="rule-136"></a>

## Rule 136 — The five Priority tags are built in: nobody renames, recolours, moves or deletes them, and a device filter on one only adds

### What happened

2026-10-28, from the operator, while asking for automations whose severity follows a device's
Priority tag: "priority tags are default out of the box, right? they also cannot have their name
edited by ANYONE and NO ONE can delete them. the only editing is to configure a device filter on
them. if a device filter is configured on them then that is additive. users can still manually add
those tags to assets or interfaces."

They were default, but not locked. `20261011200000_priority_severity_tags` seeded them as ordinary
manual tags and said so: the operator could rename, recolour or delete them, and
`ON CONFLICT (name) DO NOTHING` left an install's pre-existing same-named tag as it was, in any
category. That was fine while the tags were only a vocabulary. Once automations read them to decide
how loudly a device pages, a rename or a delete silently changes the severity of every alert in the
fleet, so the names became part of the alerting contract and had to stop being editable.

### Decisions

- **A column, not a name list in the route.** `Tag.builtIn` says which rows are locked, so the guard
  never has to decide whether a lower-case "critical" an operator typed is the built-in one. The
  registry is case-sensitive; only the seeded spelling is built in (`builtInPriorityTag`).
- **No permission unlocks them.** The guard is not a grant check. An admin gets the same 409.
- **Repeating a locked value is not a change.** The tag editor posts every field on save; refusing
  any body that mentions `name` would break the filter edit. Only a CHANGED value is refused, so a
  stale client cannot half-apply an edit either.
- **Restore and lock on upgrade (operator's choice).** A same-named row is adopted: its category
  and colour are forced back, but its id, filter and every asset / interface carrying it are kept, so
  nothing loses a tag. A missing one is re-created. A default the operator RENAMED cannot be told
  apart from any other tag afterwards, so it stays the ordinary tag it became, and a fresh built-in
  is created beside it.
- **"Additive" is the existing managed sync.** A tag filter already adds to matching assets and
  strips only the copies it applied itself (`TagAutoAssignment` provenance; port rows by
  `source = "auto"`), so a hand-applied Priority tag survives any filter change. Nothing new was
  needed for that half of the request.

### Rejected alternatives

- **Hard-coded names in the PUT / DELETE handlers.** Works until an install has a tag that only
  differs by case, and then it locks the wrong one or both.
- **Lock only what exists (no restore).** Offered; the operator chose restore. An install missing
  "Critical" would otherwise have no way to tag a critical device for severity-following automations.

### (e) An automation's severity may follow the Priority tag (2026-10-28)

The reason the tags had to be locked. The operator's words: "right now severity band condition
can only be set with a single condition. e.g. memory utilization 80% is warning, 90% is serious,
etc. i want to include monitor status to the severity bands, but when device status is chosen it
has to be paired with a priority tag. that way i don't need 3 or 4 automations for alerting when a
device is down based on which priority tag it has."

**Operator choices (asked, 2026-10-28).** Severity *follows* the tag rather than being mapped band
by band ("Critical" tag → critical; the names ARE the severities, so a per-band mapping would only
let them disagree). A device with **no** Priority tag does **not** alert from such an automation.
The same mechanism applies to "interface oper status is down" with the PORT's tag, building on
rule 133's port tags. With several Priority tags the **highest** wins: a device tagged Warning and
Critical is a critical device, and taking the lower would silently demote it.

**Why not severity bands.** Bands are thresholds on a NUMBER (`severityForValue`, the tier ladder,
per-tier runs). Monitor status is a state; there is no value to climb. The engine reuses the band
machinery only where it is shape-agnostic: `fireOpts.severity` on the first fire, and
`applyBandTransition` when the tag changes under a live alert (one alert, severity rewritten,
escalation clock restarted, re-notified per `bandNotify`). `tierForSeverity` returns the requested
severity with the BASE actions for such a rule, rather than falling back to `rule.severity`.

**Untagged = no reading, and the freeze it would cause.** Dropping an untagged reading is how "does
not alert" is expressed, the unpinned-interface contract. But a device that produces no readings
for a rule is FROZEN by `clearVanishedStates` (a collection gap is not recovery), so a device whose
tag came off while it was down would have kept its alert forever. `tagGateGone` is the carve-out,
the twin of the unpin carve-out: over the frozen candidates only, it asks whether the subject still
passes the rule's tag gates and clears it ("no longer reported or monitored") when it does not. The
same gap existed in rule 133(g)'s `ifTag` filter for a switch whose only matching port lost the tag;
the carve-out covers both.

**Found on the way: the list toggle cleared boolean columns.** `updateRule` stores
`groupByAsset` (and now `severityFromPriorityTag`) as `input.x === true`, and the list row's
enable switch PUTs the whole record through `_ruleToInput`, which never carried `groupByAsset`. So
flipping an automation off and on silently turned rule 75's "one alert per device" off. Fixed by
resending both, pinned in `tests/unit/automationsRuleToInput.test.ts`.

Rejected: a composite "monitor status is down AND tag is Critical" per band. Composite leaves fold
per device and a band needs a number; it would also have needed the 3-4 automations the operator
was trying not to write.

<a id="rule-136-invariant"></a>

### Rule 136 — the invariant as first stated

See `invariants-30-43.md` § 136; nothing longer was ever published.
