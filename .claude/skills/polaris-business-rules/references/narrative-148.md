# Business rule 148 — full narrative

> Written 2026-11-10 as its own file (one file per rule from 78 on). Rule numbers are a
> stable citation key — never renumber. 81 is a deliberate gap.

Each rule records the decision *and the incident or constraint that forced it*. The invariant is in `invariants-30-43.md`; rule numbers are a stable citation key — never renumber.

- [Rule 148](#rule-148) — A device placed inside a group polygon takes that group's location codes, on Save; placed anywhere else, its codes are untouched

<a id="rule-148"></a>

## Rule 148 — A device placed inside a group polygon takes that group's location codes, on Save; placed anywhere else, its codes are untouched

**The request (2026-11-10).** In Topology mode the operator draws polygons on the map or floor
plan, each for one location group, picked before drawing. "If placed in a polygon then that
effectively edits their description with the new a:, b:, f:, r:, jb:, depending on how the user
has placed their polygons."

**Decisions taken with the operator.**
- *When*: staged in the edit session and committed on Save / the tick, after a summary listing
  each description's old and new codes — not on drop. Closing the map discards it, like every
  other edit-session change.
- *Outside every polygon*: "if an asset is moved onto a topology view map and not placed into any
  group polygon, then don't update the codes at all. only when the user places it within polgon
  groups are the codes updated." Removing a placement does not strip codes either.

**Why the free text goes in front.** A code's value runs to the next code or the end of the
string (rule 15's grammar): "b:Plant Line 3 core" is building "Plant Line 3 core". The writer
keeps only the text before the first code and appends the codes after it; text that followed a
code was already part of that code's value.

**Why polygons store codes, not group keys.** The client's group keys are lowercased (`locKey`),
so writing a key back would rewrite "North Closet" as "north closet". A polygon keeps the group's
codes in their display casing.

**Why `assets=write`, not `deviceMap=write`.** A description is an asset field; a Device Map
editor who could not open the Edit Asset form must not be able to rewrite descriptions through
the map. The route takes `assets=write` and judges each asset against the caller's assets write
scope (rule 141(e)), reporting refusals per asset so one out-of-scope device does not sink a
save. The view itself still saves at `deviceMap=write`; the client warns when the codes will be
skipped. The same `asset.updated` Event and device description sync an Edit-form save triggers run
here, so the audit trail and the device copy stay consistent.

### (a) Only the levels a placement sets (2026-11-11)

The first build replaced every code on Save. Dropping `JEFF-108E-SH-WR` (`b:Scale House r:Weigh Room`) into the Scale House polygon left it `b:Scale House`, and `JEFF-234F-HOIST-TOP` lost `f:Surface` the same way: the Save summary listed four devices whose only change was losing a room or floor. The operator's direction: on the Topology view, polygons are only areas, buildings and floors, "and when saving those edits it will only update the part of the device descriptions that those affect"; on the Rack / Wall views, "only update the part of the asset descriptions that affect those".

So a staged change now names the levels it sets (`levels`): a Topology polygon its area / building / floor values (`polyCodes`), a floor layer its floor, a Rack / Wall view the levels its region names. The server merges those over the device's current effective codes (its description, else the device-side one, as the map reads them) with `mergeLocationLevels`, and everything else stays. A device whose building is already right is no longer staged at all. The group picker offers areas, buildings and floors only; an older polygon that still names a room keeps drawing, but only its outer levels are written.

A region-tree rewrite (rule 153) still sends no `levels`: a rename or move replaces the chain on purpose.

Rejected: clearing the levels below the polygon's deepest one when its building changes (it is exactly the loss the operator reported); refusing old room polygons on save (an existing view would stop saving).

**2026-11-17 — no floors in the polygon picker.** The operator saw floors offered in "Draw polygon for which group?". A device's floor comes from the floor layer it is placed on (rule 168), which overrides any floor a polygon carries (`stageCodesFor`), so a floor group decided nothing. The picker now offers areas and buildings only (`pickGroup` clears `floor`), and New group has no Floor kind. Older polygons that carry a floor keep working; their floor is ignored as before.

**2026-11-17 — rooms are polygons again.** A device with a room code gets an automatic outline (`roomHulls`), and the operator wanted a drawn shape to replace it: "if I then create a new polygon for that area or room, I want the polygon that I drew to override the circle". Rooms had been left out of polygons on 2026-11-11 as the Room views' business; offered a room polygon that writes `r:`, one that only draws, or automatic outlines for areas too, the operator chose the first. `POLY_FIELDS` takes the room back; a Room polygon on a floor naming the same area, building and room (case- and space-blind; the floor is the layer's) suppresses that room's outline. A building polygon still leaves the room alone (rule 148(a)'s levels), and racks and junction boxes stay the Room views'.
