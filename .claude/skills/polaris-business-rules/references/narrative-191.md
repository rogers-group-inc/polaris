# Business rule 191 — full narrative

> Written 2026-11-16 as its own file (one file per rule from 78 on). Rule numbers are a
> stable citation key — never renumber. 81 is a deliberate gap.

Each rule records the decision *and the incident or constraint that forced it*. The invariant is in `invariants-30-43.md`; rule numbers are a stable citation key — never renumber.

- [Rule 191](#rule-191) — A site that moves resets its map-based Topology views

## Rule 191 — A site that moves resets its map-based Topology views

**The incident (2026-11-16).** On a dev stack the operator changed a gate's latitude / longitude and opened the Device Map: the site's Topology view still opened at the old spot. A view saves its own camera (centre, zoom, map or satellite), and nothing moved it. Everything placed on a view sits at real map positions too — floor plans, placed devices, polygons — so after a move they are all somewhere else.

**The decision (operator, 2026-11-16).** "I need the view to update if the longitude/latitude changes. Any layers need to be reset and the user will have to replace the layers." Asked what "reset" covers, the operator chose everything on the map: the floor plans (image or CAD drawing, and their placement), placed devices and drawn polygons on every floor. The floors themselves (their numbers and names) and the views stay, and descriptions / location codes are never touched. The operator also chose a warning before an edit-form save that would clear anything.

**What counts as a move.** Both the old and the new coordinates set and more than 1e-6° apart. A first location (none → some) is not a move: a view made before the site had coordinates was framed by hand. Clearing the coordinates is not a move either. The 1e-6° threshold ignores a float echo.

**Who triggers it.** The asset edit form (`coordChanged` on a firewall) and FortiManager / FortiGate discovery when the gate's configured location changes and the operator has not pinned coordinates by hand. Discovery gets no warning — it records the Event — because a gate's configured location changing IS a real move. Other writers of Asset coordinates (the Generic API feed) are not sites in practice and do not trigger it.

**What it leaves alone.** A Topology view whose ground is an uploaded site plan (not geographic), Layer 2 and Room views, and the site's descriptions. A failure is logged and never fails the asset save that caused it.

**Rejected.** Shifting everything by the move's offset (keeping the floor plans) was offered and declined: a gate that moved was usually wrong before, so the old placements were wrong too.
