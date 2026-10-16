# Device Map

A geographic map of your FortiGates, and the topology graph behind each site.

Gated by **`deviceMap:read`** — the whole mount, not just the page.

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

**Clusters.** Hover a numbered circle to list the FortiGates inside it,
worst status first. Click a name in that list to open its topology. Click the
circle itself to zoom in until the gates separate. Gates that share a location,
or sit so close together that no zoom can separate them, fan out in a ring
instead. Each one gets a line back to a dot that marks the real location. Click
the map or zoom to fold them back. From zoom 11 a cluster forms only where pins
would overlap.

The sun / moon button in the map's top-left corner, above the zoom buttons, switches the **basemap** between
light and dark tiles independently of the app theme. It is remembered per user in
this browser; until you touch it, the map follows the app theme's family
(Morning and Noon light, Nightfall dark).

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

The **Regions** button in the map's top-right corner, **ungated beyond viewing
the map** — how an install's regions nest is not privileged information.
Clicking it opens the **Regions** panel, which lists the regions **as their
nesting tree** — each region indented under the region that contains it, with
its colour and level; the panel's **×** folds it back into the button.

Open, it paints the polygons read-only, with a permanent label only on the outermost
ring of a nested set (fill opacity is held low because nesting stacks it), and
**hovering renders the containment tree**, each row badged with its derived
level. **Smaller regions always draw on top of the regions around them** (in
edit mode too), so an L1 inside an L2 is the one you click.

### Nesting a region by dragging

In edit mode, drag a region's row in the panel onto another row to nest it
there. Only a region whose polygon **contains** it on the map accepts the drop
— this chooses between real containers, it does not override the map. The
case it exists for: a sub-region inside a state inside a division can be
nested **directly under the division**, and the levels re-compute (the state,
left with nothing inside it, drops to L1). A refused drop says why in the
status line. The change saves immediately, like a rename, and is recorded in
Events (`region.nesting_changed`, plus `region.levels_shifted` for the other
regions it moved). A region nested by hand shows its name in *italics*; drop it
back on its smallest container to return it to automatic nesting. If a later
reshape means the chosen region no longer contains it, it goes back under its
smallest container until the shape is restored. See
[Rule 121](Business-Rules#rule-121).

### Edit regions

Needs `mapRegions`: the **pencil** left of the Regions panel's title. Draw,
edit and delete polygons. While you edit, the panel's header holds the
controls:

| Control | |
|---|---|
| **✓** (where the pencil was) | save every reshaped region and leave edit mode |
| **Undo** / **Redo** (or Ctrl+Z / Ctrl+Y) | step back and forward through vertex drags, added points and deleted points |
| **×** | discard unsaved shape changes and leave edit mode; it asks first when there are any |

Undo covers only shape changes, which stay local until you save. Drawing,
renaming, recolouring and deleting a region are saved the moment you do
them, so undo cannot reverse them.

The two region layers **hand off rather than stack**: entering edit mode hides
the read-only overlay and disables the Regions button; leaving restores it and **drops
the memoised payload**, since an edit can have changed every level in the tree.

### What a rename or delete does to scopes

The columns holding region assignments on users, roles and group mappings hold
**bare names with no foreign key**. So:

- **A rename carries them with it.** Leaving them behind would revoke every
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

**A name that is live again is reclaimed, not stripped.**

> Why this matters beyond tidiness: an orphaned region tag makes an automation's
> **level-scoped routing abstain entirely** ([rule 58](Business-Rules#rule-58)),
> rather than promote the container. Switches tagged with a **misspelled**
> retired name resolve every down alert's L1 to the *division*, mailing the
> division's recipients while the people scoped to the site are never reached —
> and the automation looks "working" by every check the UI can offer.

### My regions

A read-only strip in the toolbar: your own effective region scope as coloured
pills, each tooltipped with **where that scope comes from** — your account, your
role, or an IdP group. An empty scope is stated as **"all regions"**, since
empty means unrestricted.

It answers *"which regions am I assigned to?"* — which the Users page shows only
to whoever administers users — and is deliberately **not a filter**: the map
already shows exactly the sites you may read.

---

## The topology graph

Opens from a site. A Cytoscape graph of the gates, switches and APs at that
site, with a column solver for layout and a dagre fallback. The gate sits at
the left and each switch one column further right than its uplink; a
switch's APs stack directly beneath it in the column to its right, and a
link that leaves a switch for a child switch on another row runs along the
switch's row, turns in the gap between columns and runs along the child's
row, so lines travel the gutters instead of cutting across other devices.
Drag anything to override the layout; the positions are saved per site.

| Control | |
|---|---|
| **Search** | find a node |
| **Show full** | the whole graph rather than the narrowed view |
| **Refresh** | re-read |
| **Save layout** | `deviceMap:write` — **shared across operators**; readers fall back to browser storage |
| **Reset layout** | a menu: **Reset to last save** (where a restore point exists) or **Reset to baseline** — the column solver's layout |
| **Snap to grid** | per user; lands drags on the solver's lattice and re-snaps everything on enable |
| **Fullscreen** | |
| **Export** | screenshot, PDF or Visio — see below |

The **legend** sits at the graph's bottom left as a small button; click it to
open the legend, and its **×** folds it back. The edge between the graph and
the details pane hides the pane: hover the edge and click the arrow, and the
arrow at the right edge brings the pane back. Both remember your choice in
this browser. The Device Map's own status legend, the Application Map's and
the Status Map widget's work the same way.

**Save** is an explicit checkpoint that writes the live layout **and** the
restore point in one statement, so a checkpoint can never be of a layout the
server has not stored.

### Exporting the topology

The **Export** button at the top right of the topology header opens a menu.
Each choice exports the graph **as it is on screen**, in its current layout,
including a narrowed endpoint-search view.

- **Copy screenshot (map + details)**: the graph and the right-hand details
  panel as one image. Clipboard first, download as fallback. The small camera
  inside the graph area still copies the graph alone.
- **Export PDF…**: the graph drawn as vectors on white paper whatever theme you
  are using, so it prints sharp and its text is searchable. Choose the paper
  size, orientation and **minimum text size** (7 pt by default): **nothing on
  the printed graph is smaller than that**. A site that fits one sheet at that
  size prints on one; a bigger one is split into overlapping sections after an
  overview page with the section grid, and empty sections are skipped. Every
  page carries the legend (health colours, link types, location groups) in a
  box at the bottom left.
  Characters the PDF fonts cannot print are simplified: `↔` prints as `<->`.
- **Export to Visio (.vsdx)**: one Visio page sized to the graph, every device,
  location box and link a separate editable shape, health colours and link
  styles kept. Links are drawn lines, **not glued connectors** (moving a device
  in Visio does not drag its links), and text uses Visio's default font. The title and summary line sit above the graph, and
  the legend sits in a box at its bottom left, as on the PDF.

The Application Map has the same menu ([Application Map](Application-Map#export)).

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

### Endpoints under a switch

Each switch's info panel lists the endpoints learned on its ports (a count and
the 25 most recently seen), and the search box finds an endpoint and pulses
its switch. A device is placed under the switch the dependency tree resolved
for it — so when several sites name a switch "IDF-1", each site's panel shows
only its own devices ([rule 91](Business-Rules#rule-91)). A device whose
switch name is shared and that nothing could settle is left off the panel
rather than shown under the wrong site.

---

## The Site Map widget

A different surface: the **Site Map** dashboard widget is a geographic map of
monitored **sites** with status dots and **live weather radar** (proxied
server-side, with a direct-CDN fallback).

The **Device Map** widget is the gate-level map with click-through to topology.

On both widgets the sun / moon basemap button sits in the map's top-left
corner, above the zoom buttons, as on this page. The Site Map's **°F**,
**Radar** and **Loop** buttons, and fullscreen, are at the top right; a button
that is on looks pressed. Like the rest of the map's buttons and its legend,
they follow the app theme.
