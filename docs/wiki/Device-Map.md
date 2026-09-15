# Device Map

A geographic map of your FortiGates, and the topology graph behind each site.

Gated by **`deviceMap:read`** — the whole mount, not just the page. Before that
gate was added, any authenticated session or token could enumerate every gate's
hostname, coordinates and full topology regardless of role.

Drawing regions needs `mapRegions`.

---

## The map

OpenStreetMap tiles with Leaflet. Pins are FortiGates, coloured by monitor
health and clustered at low zoom.

| Colour | |
|---|---|
| the automation's own severity | `down` — red is what `critical` looks like, not what Down means |
| amber | `warning` |
| **slate blue** | **dependency-suppressed** — suppression **outranks** the device's own state |
| purple | maintenance |
| green | up |

A cluster counts suppressed children as dep-down; a non-suppressed down or
degraded child still rolls the cluster up red or amber.

Click a pin for the site; click through for its **topology**.

### Where coordinates come from

Three tiers, highest first — see
[Fortinet discovery](Integration-Fortinet#geographic-coordinates). A manual
coordinate source **pins** them against discovery.

Coordinates are validated **as a pair**; a half-valid tier falls through rather
than mixing values.

### Tiles

> **A reverse proxy in front of Polaris must not add its own `Referrer-Policy`.**
> OpenStreetMap blocks referer-less tile requests, so a stripped `Referer` turns
> every tile into "Access blocked". This is the single most common map problem.

Tiles come from one host, and the OSM usage policy applies to your install.

---

## Regions

Polygons drawn on the map that **auto-tag the gates they enclose**. A region is
also a registry tag — `region:<name>` in a locked category.

**Regions nest, and the nesting is load-bearing.** Alert routing can address
"the device's own innermost region" (L1) or "the division containing it" (L2) —
see [Actions](Automation-Actions#level-scoped-region-routing).

### Show regions

A read-only toggle, **ungated beyond viewing the map** — how an install's
regions nest is not privileged information.

It paints the polygons read-only, with a permanent label only on the outermost
ring of a nested set (fill opacity is held low because nesting stacks it), and
**hovering renders the containment tree**, each row badged with its derived
level.

### Edit regions

Needs `mapRegions`. Draw, edit and delete polygons.

The two region layers **hand off rather than stack**: entering edit mode hides
the read-only overlay and disables its button; leaving restores it and **drops
the memoised payload**, since an edit can have changed every level in the tree.

### What a rename or delete does to scopes

The columns holding region assignments on users, roles and group mappings hold
**bare names with no foreign key**. So:

- **A rename carries them with it.** A rename that left them behind revoked every
  scoped operator's region **in silence** — tag present, matching no region, and
  every name-resolving consumer quietly reaching nobody.
- **A delete never strips them.** There is no new name to move an assignment to,
  so the assignment survives and a **warning Event names who now holds a dangling
  one**.

### Retired names and orphaned tags

Renaming or deleting a region records the retired name, and a sweep strips
`region:<name>` from every asset and network still carrying it — **both halves
required** ([rule 54](Business-Rules#rule-54)).

Both halves are needed because the two existing strip paths are blind to this
case by design: the reconcile removes only pairs it recorded, keyed by **region
id**, which a rename does not change and a delete drops outright.

The obvious fix — strip every `region:` tag matching no region — is the one thing
this must **not** do, because manual attachments survive every reconciler forever
and an operator could hand-apply `region:Narnia` to a printer.

**A name that is live again is reclaimed, not stripped.** New orphans can no
longer be created, but neither guard is retroactive.

> Why this matters beyond tidiness: an orphaned region tag makes an automation's
> **level-scoped routing abstain entirely** ([rule 58](Business-Rules#rule-58)),
> rather than promote the container. One production install carried thousands of
> switches tagged with a **misspelled** retired name, so every down alert
> resolved L1 to the *division* and mailed the division pair while the two people
> scoped to the site were never reached. The automation was "working" by every
> check the UI could offer.

### My regions

A read-only strip in the toolbar: your own effective region scope as coloured
pills, each tooltipped with **where that scope comes from** — your account, your
role, or an IdP group. An empty scope is stated as **"all regions"**, since
empty means unrestricted.

It answers *"which regions am I assigned to?"* — which the Users page could only
tell whoever administers users — and is deliberately **not a filter**: the map
already shows exactly the sites you may read.

---

## The topology graph

Opens from a site. A Cytoscape graph of the gates, switches and APs at that
site, with a column solver for layout and a dagre fallback.

| Control | |
|---|---|
| **Search** | find a node |
| **Show full** | the whole graph rather than the narrowed view |
| **Refresh** | re-read |
| **Save layout** | `deviceMap:write` — **shared across operators**; readers fall back to browser storage |
| **Reset to baseline** | keeps a restore point where one exists |
| **Snap to grid** | per user; lands drags on the solver's lattice and re-snaps everything on enable |
| **Fullscreen** | |
| **Legend** | |

**Save** is an explicit checkpoint that writes the live layout **and** the
restore point in one statement, so a checkpoint can never be of a layout the
server has not stored.

### HA clusters show one box

A standby member is **dropped from the graph**. It would otherwise hang off the
same switches as the primary and duplicate the cluster. The active member
represents it; the asset's own dependency panel shows the second box as a tagged
sibling row.

### Edges reflect physical cabling where possible

The dependency graph prefers the most physical signal available — mesh >
interface > LLDP > controller — and each kept edge records which put it there.

Two overrides worth knowing: a **mesh-leaf AP** depends on its root AP rather
than its controller, and a **FortiLink switch bridged behind a FortiAP** depends
on the AP.

---

## The Site Map widget

A different surface: the **Site Map** dashboard widget is a geographic map of
monitored **sites** with status dots and **live weather radar** (proxied
server-side, with a direct-CDN fallback).

The **Device Map** widget is the gate-level map with click-through to topology.
