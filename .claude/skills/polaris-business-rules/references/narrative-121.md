# Business rule 121 — full narrative

> Written 2026-10-16 as its own file (one file per rule from 78 on). Rule numbers are a
> stable citation key — never renumber. 81 is a deliberate gap.

Each rule records the decision *and the incident or constraint that forced it*. The invariant is in `invariants-30-43.md`; rule numbers are a stable citation key — never renumber.

- [Rule 121](#rule-121) — A region's parent is chosen only among the regions that really contain it — drag-to-nest picks between containers, never invents a nesting

<a id="rule-121"></a>

## Rule 121 — A region's parent is chosen only among the regions that really contain it — drag-to-nest picks between containers, never invents a nesting

**The ask.** The Device Map's Regions panel listed every region flat, sorted by
depth, so an operator could not see how they nested. The request was threefold:
show the nesting, put L1 regions on top of L2 regions on the map so the inner
one takes the click, and let an operator drag a region under another and have
that change its L#.

**Why not a free-form parent.** Levels are derived from polygon containment on
purpose (`utils/regionHierarchy.ts` header): a stored level is a second source
of truth that a restore, a backup import or a hand-edited Setting can silently
desynchronize, and level routing (rule 58) pages people by it. A parent an
operator could set to ANY region would reintroduce exactly that drift — a state
"nested" under a division its polygon is nowhere near — and every surface that
reads geometry (region tags, the gate pass) would disagree with every surface
that reads the tree. Asked directly, the operator chose "only allow geometric
nests".

**What drag-to-nest therefore means.** Automatic nesting makes a region's parent
its SMALLEST container. When several regions contain it (Middle Eastern
Tennessee inside Eastern Tennessee inside Eastern Division) the operator may
pick a larger one, so the region sits directly under the division and
Eastern Tennessee's level drops. That is the whole of the freedom:

- the target must be in `RegionNode.containerIds` — the server re-checks and
  answers 400 with a message naming both regions, and the panel refuses the
  drop before it is sent (`PolarisRegionTree.canNestUnder`), saying why in the
  status line;
- picking the smallest container, or `null`, stores null — the blob records
  only a real override, and "drag it back onto its own sub-region" is how an
  operator returns to automatic;
- a pick that stops containing the region after a reshape is ignored with a
  `nest-ignored` warning but KEPT, so redrawing the polygon back restores the
  arrangement rather than silently forgetting it;
- deleting the chosen region clears the pick (a pick naming no region would be
  dead weight that never applies).

**Why it is audited like a polygon edit.** A parent choice changes levels, and
levels change who level-routed automations reach for regions the operator never
touched. So the route writes `region.nesting_changed` (from / to parent, the new
level) and the usual `region.levels_shifted` for every other region it moved.
It does NOT reconcile tags: region tags follow each polygon's own membership,
which a parent choice cannot move.

**Paint order.** Leaflet stacks paths in insertion order, so a division drawn
after its states covered them and swallowed the click that opens a state's
rename / delete popup. Both map surfaces now stack by polygon AREA, largest at
the back (`PolarisRegionTree.paintOrder` for the read-only overlay,
`restackRegionPolygons` in edit mode, re-run after load, a new polygon and every
reshape). Depth alone is not enough once parents can be chosen: a region
nested straight under its division shares a depth with the state polygon that
surrounds it, and a depth-then-name order could paint the state on top.
"Send to Bottom Layer" still exists for regions that overlap without nesting.

Pinned by `tests/unit/regionHierarchy.test.ts` (the pick, a non-containing pick,
a vanished pick), `tests/unit/mapRegionHierarchy.test.ts` (`setRegionNesting`:
accept, refuse, store-null, delete clears) and `tests/unit/regionTreeRender.test.ts`
(the panel tree, `canNestUnder`, area paint order).
