# Business rule 147 — full narrative

> Written 2026-11-10 as its own file (one file per rule from 78 on). Rule numbers are a
> stable citation key — never renumber. 81 is a deliberate gap.

Each rule records the decision *and the incident or constraint that forced it*. The invariant is in `invariants-30-43.md`; rule numbers are a stable citation key — never renumber.

- [Rule 147](#rule-147) — A topology view is a shared, named way of looking at one site, and it has exactly one mode

<a id="rule-147"></a>

## Rule 147 — A topology view is a shared, named way of looking at one site, and it has exactly one mode

**The request (2026-11-10).** The Device Map's topology modal drew only firewalls, switches and
access points, as a layer-2 graph, while its right-hand sidebar already listed each switch's
endpoints. The operator asked for (1) a toggle per device type in the sidebar — firewalls,
routers, switches and APs on by default, every other type off until switched on — (2) named
views they can save and create, (3) a second mode, Topology: a physical canvas over an
OpenStreetMap basemap or an uploaded floor plan, with operator-drawn polygons standing for the
layer-2 group boxes, and then (4) a third, Rack: rack elevations, edge-resizable devices and a
cable-management placeholder.

**One mode per view.** The first design canvas offered a Layer 2 / Topology toggle inside a
view. The operator corrected it in review: "each view should only be 1 mode. it's not really a
toggle between modes per view." A view is therefore name + mode + shown types + that mode's
content, and the mode is chosen from a dropdown when the view is created (or changed later, at a
cost — rule 149).

**Shared, not personal.** Asked whether a view belongs to a site or to a user, the operator chose
shared per site, editable at `deviceMap=write` — the reach the existing shared layouts
(`TopologyLayout`) already had. A per-user preference (the `userMapViewService` shape) was
rejected: a floor plan with placed devices is site documentation, not a viewing preference.

**Why `shownTypes` and not a hidden set.** The plan first stored the hidden types. Asset types are
an operator-extensible registry; a hidden set would show every custom type added after the view
was saved — the opposite of "only the infrastructure types until you switch more on". Storing
the shown set makes a new type start hidden everywhere.

**Why a lazily materialised default.** Existing installs have saved layouts under the legacy
keys ("flat", floor keys) and no view rows. The default view keeps those keys and is created on
first read, so nothing migrates and a site nobody opens never gets a row. Two concurrent first
reads race on the partial unique index; the loser re-reads.

**Endpoints in the payload.** The sidebar's 25-per-switch sample could not draw a type someone
switched on, so `buildSiteTopology` returns every attributed endpoint (rule 91's attribution, the
same single query, newest first), capped at 2000 with a truncation flag, plus `assetType` on
every node. Routers were already endpoints in this payload (anything not firewall / switch / AP),
which is why they need no special case to be shown by default.
