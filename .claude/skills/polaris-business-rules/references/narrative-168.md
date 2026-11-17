# Business rule 168 — full narrative

> Written 2026-11-12 as its own file (one file per rule from 78 on). Rule numbers are a
> stable citation key — never renumber. 81 is a deliberate gap.

Each rule records the decision *and the incident or constraint that forced it*. The invariant is in `invariants-30-43.md`; rule numbers are a stable citation key — never renumber.

- [Rule 168](#rule-168) — A floor is a number; its name is only a label

## Rule 168 — A floor is a number; its name is only a label

Stacking a Topology view's floors (rule 152(a)) needs to know which floor is above which. With free-text floors (`f:Surface`, `f:B1`, `f:Mezzanine`) Polaris cannot order them. The operator's direction (2026-11-12): "the floor description for assets need to be an integer. not accept text", and, for the floors that already have text names, "perhaps floors are integers, but names can be mapped to the different floors?". Floor 0 is the ground (the map or satellite), with floors −1 and −2 below it; a device placed on floor 0 gets no `f:` code.

So a floor's code is its number and its name is a label kept in the region tree, per building (`RegionNode.level` + `name`). New saves accept only a number: the asset Edit form and the map's description editor (both `PUT /assets/:id`), polygons and floor layers. Nothing existing is rewritten. An old `f:Surface` keeps working: it resolves to the floor named Surface in its building, is drawn on that floor's number, and is listed under Devices to check with the number to use. An asset save that leaves such a floor exactly as it was still saves, or editing a device's hostname would be blocked by a description nobody touched.

Device-side descriptions synced by discovery are never refused: Polaris does not own them, and refusing them would only make the asset record disagree with the device.

The migration numbers any existing floor node whose name is already a whole number, so a tree built from `f:1`-style descriptions needs no work; a text-named floor waits for its number (⋯ → Rename, which now asks for the number and the name).

Rejected: rewriting text floors automatically (the operator chose names mapping to numbers, not a bulk rewrite); refusing any save of a device that still carries a text floor (blocks unrelated edits).

**2026-11-17 — the ground is floor 1; there is no floor 0.** "Make the ground floor numbered as 1. There is no 0 floor, so it goes −2, −1, 1, 2." Asked how codes should follow, the operator chose: the ground writes `f:1` only when the view has other floors (a single-floor site keeps writing no floor code), and devices already carrying the old numbering are rewritten on the next save. Stored levels did not move — the ground is still level 0 and the floor above level 1 in `TopologyView.layers` and the `topo|L<n>` layout keys — so no migration was needed; the canvas maps level L ≥ 0 to L + 1 for display and for the code (`floorNumber`, `floorCodeFor`). Entering edit mode, and adding or deleting a floor, stages a floor-only change for each placed device whose `f:` no longer matches (`restageFloorCodes`), which the save's confirmation lists. Rejected: renumbering the stored levels (a migration of every view's layers, layouts and polygons for no visible gain); restaging every code in full at edit start (it would re-apply polygon codes over descriptions edited by hand since). `f:0` in older descriptions is still accepted.
