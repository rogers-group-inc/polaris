# Business rule 153 — full narrative

> Written 2026-11-10 as its own file (one file per rule from 78 on). Rule numbers are a
> stable citation key — never renumber. 81 is a deliberate gap.

Each rule records the decision *and the incident or constraint that forced it*. The invariant is in `invariants-30-43.md`; rule numbers are a stable citation key — never renumber.

- [Rule 153](#rule-153) — A site's region tree names each place once, so a short code is enough; it never rewrites a description on its own

## Rule 153 — A site's region tree names each place once, so a short code is enough; it never rewrites a description on its own

The operator observed (2026-11-10) that a junction box or a wall is in one room, a room on one floor, a floor in one building, a building in one area, so a description should not have to spell the whole chain: `ra:rack1` alone ought to say where a device is. Names, though, repeat: floor "1" is in every building. The operator's decision: names are unique per site at each level, except floors, which are unique within their building; and the chain lives in a STORED region tree that is generated from the existing codes and edited directly.

The constraint that shaped everything: production already has regions in its descriptions and none may be deleted or orphaned. So the tree is additive and starts empty; until an operator builds it, every location reads exactly as before. Building only adds regions. A description that disagrees with the tree is never moved; it is shown as written and listed for cleanup ("Devices to check"). Renaming or moving a region lists the descriptions that name its old place in full and offers to update them, through the same reviewed summary as a Topology save (rule 148); declining leaves them as written, flagged `unknown`. A short code follows the tree on its own, which is the point.

Rejected: enforcing uniqueness by refusing description saves (the operator preferred a tree they can edit); rewriting descriptions automatically on a tree edit (the operator chose the confirmed summary); storing a resolved chain on each asset (a second copy of the codes that could drift).

The panel is called **Location regions** because the Device Map already has a **Regions** feature, the geographic map regions of rule 54.
