# Business rule 153 — full narrative

> Written 2026-11-10 as its own file (one file per rule from 78 on). Rule numbers are a
> stable citation key — never renumber. 81 is a deliberate gap.

Each rule records the decision *and the incident or constraint that forced it*. The invariant is in `invariants-30-43.md`; rule numbers are a stable citation key — never renumber.

- [Rule 153](#rule-153) — A site's region tree names each place once, so a short code is enough; it never rewrites a description on its own

## Rule 153 — A site's region tree names each place once, so a short code is enough; it never rewrites a description on its own

The operator observed (2026-11-10) that a junction box or a wall is in one room, a room on one floor, a floor in one building, a building in one area, so a description should not have to spell the whole chain: `ra:rack1` alone ought to say where a device is. Names, though, repeat: floor "1" is in every building. The operator's decision: names are unique per site at each level, except floors, which are unique within their building; and the chain lives in a STORED region tree that is generated from the existing codes and edited directly.

The constraint that shaped everything: production already has regions in its descriptions and none may be deleted or orphaned. So the tree is additive and starts empty; until an operator builds it, every location reads exactly as before. Building only adds regions. A description that disagrees with the tree is never moved; it is shown as written and listed for cleanup ("Devices to check"). Renaming or moving a region lists the descriptions that name its old place in full and offers to update them, through the same reviewed summary as a Topology save (rule 148); declining leaves them as written, flagged `unknown`. A short code follows the tree on its own, which is the point.

Rejected: enforcing uniqueness by refusing description saves (the operator preferred a tree they can edit); rewriting descriptions automatically on a tree edit (the operator chose the confirmed summary); storing a resolved chain on each asset (a second copy of the codes that could drift).

**Every reader, not just the map (2026-11-10, same day).** The first build resolved codes only in the topology payload; the alert email's dependency-path diagram and the description-save region prompt still parsed descriptions as written, so `ra:rack1` alone drew a bare rack box in an alert and the prompt could ask about a region a view already stood for. The operator's direction was "every place needs to use the tree". So:

- the alert path resolves each drawn device through ITS site's tree (`siteForAsset`, now in `regionTreeService` and extended to endpoints through the switch they hang off, the Device Map's own attribution); a device no site places, or a failed read, keeps its codes as written;
- the region prompt asks the server to resolve both descriptions (`POST /map/sites/:id/regions/resolve`) before comparing, and so works for any device a site places, not only FortiGates, FortiSwitches and FortiAPs;
- a saved view's `region` and its polygons' codes come back resolved, so a view saved as `r:MDF` compares equal to devices resolved to the full chain.

**Nothing Polaris stored may be orphaned by a tree edit.** A view region, a polygon's codes and the TopologyLayout keys of floor drill-down views and group boxes (`locgroup:<key>`) all hold region NAMES. A rename, move or merge now carries them to the new chain in the same transaction (`carryStoredChains`, pure `remapLocationCodes` / `remapLocationKey` / `remapLayoutViewKey` / `remapPositionKeys`). Stored view data takes the new chain in full, since it is Polaris's own canonical copy; a description still keeps its short codes short. A re-keyed layout never replaces one already saved under the new key, and a key that does not round-trip (a value containing `|`) is left alone rather than guessed. A merge also returns `rewrites` now, as a rename does; before, it silently left every description naming the merged region `unknown`.

The panel is called **Location regions** because the Device Map already has a **Regions** feature, the geographic map regions of rule 54.
