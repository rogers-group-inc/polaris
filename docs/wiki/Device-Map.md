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

### Full screen, Refresh and Export

Three buttons sit in the map's top-right corner, to the right of the
[Regions](#regions) button:

- **Full screen** fills the screen with the map. Click it again, or press
  Esc, to come back. A FortiGate's topology and the asset details still open
  over it.
- **Refresh** reloads the FortiGates and their status without moving the map:
  your zoom and position stay where they are.
- **Export** exports **what is in view**, exactly as the map shows it: the
  area on screen at the current zoom, with the pins, clusters, any regions you
  are showing, the status legend and the map credit. Anything you have panned
  or zoomed out of view is not in it. **Copy screenshot** puts a PNG on the
  clipboard (or downloads it, where the browser will not allow the clipboard);
  **Export PDF** saves it on a letter page with the time it was taken.

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

**Each row has an eye.** Click it to hide that region (the row dims and the
eye is struck through); click again to show it. Hiding a region:

- **hides every region nested inside it** — hide an L2 and its L1s go with it.
  Their rows dim too, with a greyed eye that says which region they are hidden
  with; showing the container brings them back;
- **takes the FortiGates inside it off the map** — every pin that lies within
  the hidden region, including ones in none of its L1s. This holds whether or
  not the Regions panel is open, and the status line says how many FortiGates
  hidden regions are holding back;
- **re-fits the map** to the FortiGates still shown, as it does on first load.

**Search still reaches a hidden FortiGate.** Picking one from the global
search opens its topology as usual; the map stays where it is and the status
line says the FortiGate is in a hidden region.

Anyone who can open the Device Map can do this, read-only roles included: it
changes only what **your** maps draw, never what you can see elsewhere. The
choice is saved to **your account**, so it follows you to any browser you sign
in on and to the [phone app](Mobile-and-Dash)'s map, which leaves out the same
FortiGates. Edit mode draws every region regardless, since you have to see
what you are reshaping.

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

Needs `mapRegions` at Read-Write: the **pencil** left of the Regions panel's
title, shown only to roles that hold it. Draw,
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

---

## The topology graph

Opens from a site. A Cytoscape graph of the gates, switches and APs at that
site, with a column solver for layout and a dagre fallback. The gate sits at
the left and each switch one column further right than its uplink; a
switch's APs stack beneath it in the column to its right. A link that leaves
a switch for a child switch on another row turns up or down right next to the
switch and runs along the child's row, so it never shares a line with the
switch's straight link to the next switch along, and lines travel the gutters
instead of cutting across other devices. Drag anything to override the
layout; the positions are saved per site.

Decommissioned and disabled devices are never drawn, including as the far end
of a link that another device still reports (an LLDP neighbor, or an interface
named after it).

Port labels always name **physical ports**. An aggregate (the FortiGate's
`fortilink` interface, a FortiSwitch trunk, an LACP bundle) is a virtual
interface, so each end of a link shows the member port the cable lands on: the
aggregate's only member, otherwise the port LLDP saw on that link. A side
neither can resolve reads `unknown`. A switch whose trunk members Polaris
cannot read shows `unknown` on its side until LLDP reports the port. A
FortiGate-to-switch link with no confirmed cable is labelled `fortilink`
and drawn dashed: that is the management relationship, not a port.

Port labels (`port8 ↔ port1`) on a link with bends sit near its ends: with
one bend, halfway along the part after the bend; with two or more, halfway
along the first part and again halfway along the last. A label is never put
where several links run along the same line, since it could belong to any of
them: it moves to a stretch only its own link uses, and a link that shares
its whole route shows no label.

On the light themes (morning and noon) the links and location boxes are drawn
in darker shades of the same colours, so they stay readable on the pale
background; the legend matches the theme you are using.

When devices carry location codes, the details pane lists the switches and APs in the same
nesting as the location boxes (area › building › floor › room › junction box),
under a heading per group, with devices that have no location last.

Right-click a device to edit its description in place: that is the quick way
to put it into a location box. The codes are `a:` area, `b:` building, `f:`
floor, `r:` room and `jb:` junction box, written anywhere in the description
(`a:Mine b:Shop f:2 r:North Closet jb:112-305`); each value runs until the
next code. Each level is a box inside the one above it, and the editor shows
that nesting as a small diagram in the map's own box colours. Skip any level
you don't need: `b:Shop f:2` puts a device in floor 2 of Shop with no area.
The asset **Edit** form's Description field shows the same diagram.

**Editing the layout.** The topology opens **view-only**: you can click,
select, pan, zoom, switch location views and export, but nothing moves. Press
**Edit** (the pencil at the map's top right, as on the dashboard) to move
devices and location boxes, draw lines, and use **Save layout**, **Reset
layout** and the editing tools, which only show while editing. The check mark
ends editing; closing the topology ends it too.

The tools sit in a row at the map's top right. From the right: **Edit**,
**Export**, then, while editing, **Grid**, **Snap devices** and **Snap line
points**. Each one remembers its setting in this browser; the grid only ever shows while you are editing, and comes back
the next time you edit if you left it on.

- **Grid** draws two weights of line behind the map. The thick lines are
  where devices sit in the automatic layout; the thin lines split each cell
  in four, and in eight once you zoom in far enough for the finer lines to
  be readable (about 135%). The thick lines stay where they are.
- **Snap devices** lands a dragged device on the thick lines, and lines up
  every device on the map when you turn it on.
- **Snap line points** lands a dragged bend point on any line, thick or thin,
  so zooming in gives you the finer eight-way spacing to place points on.

**Drawing your own connection lines** (while editing). Drag any part of a line and a bend
point appears where you pressed, selected and following the pointer. Click a
line to show its points: a dot for each bend and a ring where it meets each
device. Drag a ring around the device's edge to attach the line at that spot;
it stays on the device's outline, so the line never comes loose. A bend stays
where you put it when you move one of the line's devices, and moves with the
line when you move both devices together. Select a point and press
**Delete** to remove a bend, or to put an end back on automatic. A line with
no points left goes back to its automatic shape. A click selects just the
device, line or location box you clicked; hold **Shift** to add to the
selection, or Shift-drag to box-select. Drawn lines are part of the
layout: **Save layout** and **Reset layout** cover them, and each location
view keeps its own. Lines are always straight between their points.

**Undo and redo** (while editing). **Ctrl+Z** undoes the last layout
change: a device or box moved, a bend added, moved or deleted, an end point
moved, or everything snapped. **Ctrl+Shift+Z** (or **Ctrl+Y**) redoes it.
The undo and redo arrows under the Edit button do the same and grey out when
there is nothing to step to. History lasts until you press the check mark,
and an undone change is saved like any other edit.

| Control | |
|---|---|
| **Search** | find a node |
| **Show full** | the whole graph rather than the narrowed view |
| **Refresh** | re-read |
| **Edit** | top right of the map, left of Export: the pencil turns layout editing on, the check mark turns it off |
| **Save layout** | while editing, under the Edit button. `deviceMap:write` — **shared across operators**; readers fall back to browser storage |
| **Undo / Redo** | while editing, under Reset; also Ctrl+Z and Ctrl+Shift+Z (or Ctrl+Y) |
| **Reset layout** | while editing, under Save. A menu: **Reset to last save** (where a restore point exists) or **Reset to baseline** — the column solver's layout |
| **Grid** | while editing; per user; show or hide the two-weight grid (it hides whenever editing ends) |
| **Snap devices** | while editing; per user; lands device drags on the grid's thick lines and re-snaps everything on enable |
| **Snap line points** | while editing; per user; lands dragged bend points on any grid line |
| **Base / area / building / floor chips** | top left, only when a device carries a `b:` or `f:` location code. **Base** is the whole site; under it are the areas (plus any building with no area), or the buildings when no area is tagged. Picking a chip shows its devices and lists the next level beneath it: an area's buildings, then a building's floors. The FortiGate shows only in **Base** and in the views its own codes place it in; elsewhere a dashed **→ Base** stub stands in for it, and tapping the stub takes you there. Each view keeps its own saved layout |
| **Fullscreen** | |
| **Export** | top right of the map: screenshots, PDF or Visio — see below |

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

The **Export** button in the top-right corner of the map opens a menu.
Each choice exports **only what is in the viewer**: the part of the graph on
screen at your current zoom and position, in its current layout, including a
narrowed endpoint-search view. Zoom in, and whatever leaves the view leaves the
export too; a device cut by the edge of the view is cut at the same place on
the PDF, and the device and link count above it counts only what is in view.
To export the whole site, zoom out until all of it is in view first.

- **Copy map as image**: the graph in view alone.
- **Copy screenshot (map + details)**: the graph and the right-hand details
  panel as one image. Clipboard first, download as fallback.

  Neither screenshot shows a selected line's drag points.
- **Export PDF**: the graph drawn as vectors on white paper whatever theme you
  are using, so it prints sharp and its text is searchable. Choose the paper
  size, orientation and **minimum text size** (7 pt by default): **nothing on
  the printed graph is smaller than that**. A site that fits one sheet at that
  size prints on one; a bigger one is split into overlapping sections after an
  overview page with the section grid, and empty sections are skipped. Every
  page carries the legend (health colours, link types, location groups) in a
  box at the bottom left.
  Characters the PDF fonts cannot print are simplified: `↔` prints as `<->`.
- **Export to Visio (.vsdx)**: one Visio page sized to the view, every device,
  location box and link a separate editable shape, health colours and link
  styles kept. Links are drawn lines, **not glued connectors** (moving a device
  in Visio does not drag its links), and text uses Visio's default font. A
  device the edge of the view cuts through comes across whole. The title and summary line sit above the graph, and
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

Two switches that report each other over LLDP are joined by a line even when
neither one's interface names identify the other — a plain fiber link between
them, for example. The neighbor report must be from the last hour, so a link
you have unplugged disappears once the switches stop advertising it. Hover the
line to see which ports LLDP reported.

### Endpoints under a switch

Each switch's info panel lists the endpoints learned on its ports (a count and
the 25 most recently seen), and the search box finds an endpoint and pulses
its switch. A device is placed under the switch the dependency tree resolved
for it — so when several sites name a switch "IDF-1", each site's panel shows
only its own devices ([rule 91](Business-Rules#rule-91)). A device whose
switch name is shared and that nothing could settle is left off the panel
rather than shown under the wrong site.

The header search works the same way from any page. Search for a server,
workstation or printer and its Device Map entry opens the topology of the
FortiGate its **dependency tree** ends at — the same chain its asset page
shows. A device built at one site and shipped to another opens the site it
sits at now, even when its last DHCP lease came from the site it was built at.
Only a device with no dependency path to a gate falls back to the gate that
last gave it a DHCP lease. If the tree's gate is not pinned on the map, the
search opens the device's asset page instead.

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
