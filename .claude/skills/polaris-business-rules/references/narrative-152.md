# Business rule 152 — full narrative

> Written 2026-11-10 as its own file (one file per rule from 78 on). Rule numbers are a
> stable citation key — never renumber. 81 is a deliberate gap.

Each rule records the decision *and the incident or constraint that forced it*. The invariant is in `invariants-30-43.md`; rule numbers are a stable citation key — never renumber.

- [Rule 152](#rule-152) — Floors are layers of a Topology view: layer 0 is the flat view, and a layer gives its devices their floor

## Rule 152 — Floors are layers of a Topology view: layer 0 is the flat view, and a layer gives its devices their floor

The operator pointed out (2026-11-10) that a floor is a z axis while every other region is x / y, so drawing a floor polygon treats height as ground area. Floors became layers: every Topology view keeps its flat view as layer 0, the default that ignores floors, and + / − step through numbered layers above and below (basements are negative). Each layer has its own background, polygons and placements.

The floor code comes from the layer. A device placed on layer 2 gets `f:<layer 2's name>`; inside a polygon on that layer it also takes the polygon's codes. Outside every polygon only the floor changes, never the device's other codes, because removing a building code because a device was dropped on a floor would destroy production data.

Placements per layer use their own TopologyLayout rows (`…topo|L<n>`), so a layer-0 layout saved before this change is untouched.

### (a) Stacked floors (2026-11-12)

The operator asked for every floor to be visible at once: "whichever floor the user is looking at that floor background image, assets and connections are at 100% opacity", the floor above at 10 %, two above at 2 %, floors below hidden, with the opacity easing when floors change. Each floor's plan must "move and scale" — free stretch by a corner, Ctrl to keep the shape, Alt to rotate. Then: "higher floors are scaled up by 25% from center … floors below scale down by 25%. could each layer have parallax?", and "connections that go between floors, can the connection start at 100% opacity and fade to the opacity of the other floor?".

Before this, changing floors rebuilt the map with only that floor's background. Now floor 0's background is the ground and stays; every floor is a Leaflet pane holding its plan, polygons, devices and links, so one CSS opacity and transform fades and scales it as a unit. Scaling about the middle of the SCREEN (not a fixed map point) is what gives parallax: as the map pans, the bigger floors above slide faster than the ground. A crosshair marks that centre. The floor being viewed is always 1:1 with the ground, so placing and editing are unaffected.

A floor's devices and polygons are stored in its plan's units, as they always were for a floor with its own image, and drawn through the plan's placement (`layers[].plan`). Moving, stretching or rotating the plan therefore carries them, and old placements need no migration: a plan with no saved placement lands where the old per-floor image drew on an image ground, or centred on the site on the map. Uploading, replacing or removing a plan re-expresses the floor's devices and polygons so they stay where they are on the map.

Links between floors are drawn separately from each end's on-screen (scaled) position, in twelve segments fading from one floor's opacity to the other's.

Found on the way: the Map | Satellite switch called `setLayer("satellite")`, which the floor switcher of the same name had shadowed since floor layers shipped, so the switch never changed the basemap. The basemap function is now `setBaseMap`.

Rejected: a fixed map point as the scaling centre (no parallax, and the operator asked for it); fading floors below (the operator chose hidden); one pane for all floors with per-element opacity (the transitions and scaling would have to be animated element by element).
