# Business rule 150 — full narrative

> Written 2026-11-10 as its own file (one file per rule from 78 on). Rule numbers are a
> stable citation key — never renumber. 81 is a deliberate gap.

Each rule records the decision *and the incident or constraint that forced it*. The invariant is in `invariants-30-43.md`; rule numbers are a stable citation key — never renumber.

- [Rule 150](#rule-150) — A Rack or Wall view may stand for one location region; it is a pointer to codes, never their owner

## Rule 150 — A Rack or Wall view may stand for one location region; it is a pointer to codes, never their owner

The operator asked (2026-11-10) that a Wall or Rack view can be "for" a junction box, rack or room, and that saving an asset's description should offer to make a view for any new region it names. They then narrowed it the same day: only Rack and Wall views take a region; a Topology or Layer 2 view draws the site's regions itself, so grouping one under a region says nothing. A region may be any chain of codes (area, building, floor, room, rack, junction box).

The deciding constraint was production: the install already has regions in device descriptions, and nothing in this feature may delete or orphan them. So a region is NOT a new stored object. It stays what it always was, a set of codes read from descriptions, and a view only points at one. Clearing a view's region, deleting the view or changing its mode leaves every description as it was. The only path that writes codes is the reviewed Save summary of rule 148, now also used when a device is placed on a region-mapped view.

Rejected: a separate Region table synced from descriptions (a second source of truth that could drift from, or overwrite, the codes); letting Topology / Layer 2 views carry a region (the operator's call).
