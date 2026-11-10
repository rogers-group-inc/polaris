# Business rule 152 — full narrative

> Written 2026-11-10 as its own file (one file per rule from 78 on). Rule numbers are a
> stable citation key — never renumber. 81 is a deliberate gap.

Each rule records the decision *and the incident or constraint that forced it*. The invariant is in `invariants-30-43.md`; rule numbers are a stable citation key — never renumber.

- [Rule 152](#rule-152) — Floors are layers of a Topology view: layer 0 is the flat view, and a layer gives its devices their floor

## Rule 152 — Floors are layers of a Topology view: layer 0 is the flat view, and a layer gives its devices their floor

The operator pointed out (2026-11-10) that a floor is a z axis while every other region is x / y, so drawing a floor polygon treats height as ground area. Floors became layers: every Topology view keeps its flat view as layer 0, the default that ignores floors, and + / − step through numbered layers above and below (basements are negative). Each layer has its own background, polygons and placements.

The floor code comes from the layer. A device placed on layer 2 gets `f:<layer 2's name>`; inside a polygon on that layer it also takes the polygon's codes. Outside every polygon only the floor changes, never the device's other codes, because removing a building code because a device was dropped on a floor would destroy production data.

Placements per layer use their own TopologyLayout rows (`…topo|L<n>`), so a layer-0 layout saved before this change is untouched.
