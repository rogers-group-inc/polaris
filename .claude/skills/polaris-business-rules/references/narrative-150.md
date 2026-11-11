# Business rule 150 — full narrative

> Written 2026-11-10 as its own file (one file per rule from 78 on). Rule numbers are a
> stable citation key — never renumber. 81 is a deliberate gap.

Each rule records the decision *and the incident or constraint that forced it*. The invariant is in `invariants-30-43.md`; rule numbers are a stable citation key — never renumber.

- [Rule 150](#rule-150) — A Rack or Wall view may stand for one location region; it is a pointer to codes, never their owner

## Rule 150 — A Rack or Wall view may stand for one location region; it is a pointer to codes, never their owner

The operator asked (2026-11-10) that a Wall or Rack view can be "for" a junction box, rack or room, and that saving an asset's description should offer to make a view for any new region it names. They then narrowed it the same day: only Rack and Wall views take a region; a Topology or Layer 2 view draws the site's regions itself, so grouping one under a region says nothing. A region may be any chain of codes (area, building, floor, room, rack, junction box).

The deciding constraint was production: the install already has regions in device descriptions, and nothing in this feature may delete or orphan them. So a region is NOT a new stored object. It stays what it always was, a set of codes read from descriptions, and a view only points at one. Clearing a view's region, deleting the view or changing its mode leaves every description as it was. The only path that writes codes is the reviewed Save summary of rule 148, now also used when a device is placed on a region-mapped view.

**(a) Filling a view from the codes devices already carry (2026-11-11).** The operator: "if assets are already assigned to groups, like jb or racks, but those views aren't created yet, then when that view is created and when it's linked to those pre-existing groups, then it should auto add/place the assets into those groups". Production already names racks and junction boxes in descriptions, so a new Rack view for `ra:R1` that opened empty made the operator re-drag what the codes already said.

The fill runs on the server, so the New view dialog, View settings, the description-save prompt and the API all behave the same way. It runs only at the moments the operator named: on create, when the region changes to a different place (compared after the region tree resolves both, so re-saving `jb:7` over `b:Plant … jb:7` is not a change), and on a mode-change reset that keeps the region. It does not run on every open: a device the operator took out of the rack would otherwise come back. A patch that also sends placements is the operator's own layout, so it is never filled.

Grouping is by the container's code: a Rack view standing for a room gets one rack per rack name in that room, and a Wall view one wall per junction box. A fresh view's placeholder ("Rack 1", "Wall 1", or a wall named after its view) is renamed for the first group while it is still empty. A device written with a short code the tree could not expand (`ra:R1` alone) joins the one same-named rack it doesn't contradict; when two racks of that name could own it, it gets its own rack rather than a guess. Placement takes the editor's own defaults (a 1U half-depth block from the bottom, front then rear; a 12 × 8 in box in reading order), and anything that finds no room is reported, never forced.

It writes no description: every device it places already carries the codes. That keeps it inside rule 150's promise that nothing in this feature changes or orphans production's regions.

Rejected: filling on every open (brings back removed devices); placing devices with no rack or junction box code on a room-level view (the operator named racks and junction boxes as the groups).

Rejected: a separate Region table synced from descriptions (a second source of truth that could drift from, or overwrite, the codes); letting Topology / Layer 2 views carry a region (the operator's call).
