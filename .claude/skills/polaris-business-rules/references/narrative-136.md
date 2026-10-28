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

<a id="rule-136-invariant"></a>

### Rule 136 — the invariant as first stated

See `invariants-30-43.md` § 136; nothing longer was ever published.
