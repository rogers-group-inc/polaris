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
instead of cutting across other devices. Once devices have moved (a saved
layout, a drag), that turn can land across the switch's own AP lines or another
straight link; the turn then slides along the link to the nearest spot that
crosses nothing. Drag anything to override the
layout; the positions are saved per site.

Decommissioned and disabled devices are never drawn, including as the far end
of a link that another device still reports (an LLDP neighbor, or an interface
named after it).

Port labels always name **physical ports**. An aggregate (the FortiGate's
`fortilink` interface, a FortiSwitch trunk, an LACP bundle) is a virtual
interface, so each end of a link shows the member port the cable lands on: the
aggregate's only member, otherwise the port LLDP saw on that link. A side
neither can resolve reads `unknown`. A switch whose trunk members Polaris
cannot read shows `unknown` on its side until LLDP reports the port.

**Only cables are drawn — the topology is a layer-2 map.** A FortiGate-to-switch
FortiLink uplink with no physical cable confirmed (by interface naming or
LLDP) is not drawn, and neither is a FortiGate-to-FortiAP link, which Polaris
only has when it does not know which switch port the AP is on. Such a device
stands unconnected in its location until its cable is found. A confirmed
firewall-to-switch uplink whose ports cannot be resolved reads `fortilink`.

**Link colors show speed and signal.** Every link starts as one neutral gray
line, whatever kind of link it is and however it was found. Then:

- **A cable takes the color of its speed**, and faster links are drawn
  thicker: violet 10 Gb (or faster), blue 5 Gb, cyan 2.5 Gb, teal 1 Gb, slate
  100 Mb, and a dotted slate line for 10 Mb. The speed is the slower of the
  two ports' reported speeds. When neither port reports a speed (Polaris does
  not know the port at one end, or its reading is more than an hour old) the
  line stays gray.
- **A wireless mesh link between two APs is dashed.** It is green while the
  signal is good (−65 dBm or better), then turns yellow (−66 to −72), orange
  (−73 to −80) and red (below −80) as the signal weakens. Signal strength comes
  from the firewall's REST API; a site polled over SNMP only has no reading, so
  its mesh links stay gray ("Signal not reported" in the legend).

Green, yellow, orange and red are only ever used for signal, so a slow cable never
looks like a failing radio. An MCLAG inter-chassis link is dashed, in its
speed's color, and a link that is part of a switch ring gets a white halo
(near-black on the light themes).

**Hover a link to see the details.** A cable's tooltip shows its ports, how it
was found ("found by interface naming", "found by LLDP"), its speed, and each
port's speed, status and error counts. Where a port holds an SFP transceiver
that reports its diagnostics (see the Interfaces table on [Assets](Assets)), a line
under that port adds its receive and transmit power, temperature, voltage and
laser bias current. A receive power of −20 dBm or lower is shown in red, and
the tooltip names the end that is receiving too little light. A copper SFP
reports no diagnostics, so it gets no line. A cable slower than 1 Gb also says
that this is usually a cable or speed-negotiation fault. A mesh link's tooltip shows
the signal in dBm and in words, the channel, band and channel width, the noise
and signal-to-noise ratio, the SSID, and when it was last seen. A link that is
part of a switch ring also lists the ring's other links under **Part of a ring**,
read around the ring from the link you are on: both devices, the port pair and
the speed of each, the same links the hover lights up. A large ring lists the
first eight and counts the rest. The legend has
a section for each: **Wired link speed**, **Wireless mesh signal**, and
**Also** (MCLAG, ring and last-known links). Devices are listed by asset type (Firewall,
Switch, Access Point).

**Last-known links.** A switch-to-switch link stays on the map while one of its
switches is dependency-down, down or recovering, drawn with long faded dashes. Polaris
stops fully polling such a switch, so nothing refreshes the evidence for its links; the
map keeps them where they were last seen, for up to seven days, and the link's tooltip
says when. Before this, those links disappeared about an hour after the switch went
dark and the site redrew as if every switch hung straight off the FortiGate. A link
between two switches Polaris still polls fully disappears an hour after its evidence
goes, as before.

A link between two location boxes runs in the gutters between boxes and never
through another device: when a switch sits in the target's column, the line
comes down a lane beside the target and enters from the side. Any other
straight link that would cross a device it does not connect (two APs meshed
across a switch between them, for example) steps sideways around it.

Port labels (`port8 ↔ port1`) on a link with bends sit near its ends: with
one bend, halfway along the part after the bend; with two or more, halfway
along the first part and again halfway along the last. A label is never put
where several links run along the same line, since it could belong to any of
them: it moves to a stretch only its own link uses, and a link that shares
its whole route shows no label.

On the light themes (morning and noon) the links and location boxes are drawn
in darker shades of the same colors, so they stay readable on the pale
background; the legend matches the theme you are using.

When devices carry location codes, the details pane lists the switches and APs in the same
nesting as the location boxes (area › building › floor › room › junction box),
under a heading per group, with devices that have no location last.

While editing the map (**Edit Map**), right-click a device to edit its
description in place; viewing the map never changes an asset. That is the quick way
to put it into a location box. The codes are `a:` area, `b:` building, `f:`
floor, `r:` room, `ra:` rack and `jb:` junction box, written anywhere in the
description (`a:Mine b:Shop f:2 r:North Closet ra:R2 jb:112-305`); each value
runs until the next code. A rack sits inside a room, and a junction box can sit
inside a rack. Each level is a box inside the one above it, and the editor shows
that nesting as a small diagram in the map's own box colours. Skip any level
you don't need: `b:Shop f:2` puts a device in floor 2 of Shop with no area.
The asset **Edit** form's Description field shows the same diagram.

Boxes are kept as small as their contents allow. When a box holds exactly the
same devices as the one box inside it (a building with one floor that has one
room, say), only the innermost box is drawn, under its own name; hover it to
see the whole path (Building › Floor › Room). A box with no box inside it sits
close around its devices, and a device's name always stays inside its box.

**How the map places devices and boxes.** Every device has a level, which is
how many hops it is from the FortiGate. Every location box has the level of
the closest-to-the-FortiGate device inside it. Boxes and devices are laid out
at every depth of nesting (the areas on the map, the buildings inside each
area, and so on down), each one starting a cell per level to the right of the
device it connects to and on that device's row. When that spot is taken, it
goes to the nearest free spot beside, below or above whatever is in the way,
so it stays close to its uplink. A wide area pushes aside only what shares its
rows: a building fed from the same switch sits next to that switch, not past
the far side of the area. A chain of switches stays on one straight row, an
access point beside it moves off that row so that no link runs through a
device, and devices with no links at all sit in a row under the map.

The map is laid out to the shape of the window it opens in. On a wide screen,
a box that has to move out of the way moves sideways rather than down, so a
deep site spreads across the screen instead of stacking into a tall column; on
a phone held upright the same site comes out taller, and the dashboard widget
fits its own tile. The shape is decided when the layout is made, so it does not
change when you resize the window afterwards; **Load automatic layout** lays it
out again for the window as it is.

A link that leaves a location box goes out through whichever side is nearest
its target, including the top or bottom, so a building just below a wide area
is reached by a short drop, not a trip around the area.

**Links that travel together share one line, and only in the middle.** The
links leaving one box in the same direction run up (or across) as a single
trunk, then each turns off on its own lane near its target, the nearest
target first, so the branches never cross. Where a line meets a device it is
always on its own: several links leaving one switch fan out of it side by
side, and several links into one device come in side by side, so you can
hover each one right at the icon. A link from a different box never joins
another box's trunk; it gets its own channel, clearly apart. No device is
placed on the straight line between two other linked devices, so a chain of
links always reads as the chain it is.

Because each box is placed by its level and its uplink, not by its row in a
map-wide column, adding a location code to a device moves only the box that
device joins or leaves, plus what is placed after it nearby. If the map has a saved
layout, a code change never moves a device you placed: the new box is drawn
around the devices where they already are, even if two boxes then overlap.
A device the saved layout has no spot for is placed next to the device it
connects to. **Load layout** › **Load automatic layout** lays the whole map
out again from levels.

**Editing the layout.** The topology opens **view-only**: you can click,
select, pan, zoom, switch location views and export, but nothing moves.
Dragging anywhere pans the map, including on a device or a location box. While
editing, dragging moves the device or box instead; hold **Ctrl** to pan. Press
**Edit** (the pencil at the map's top right, as on the dashboard) to move
devices and location boxes, draw lines, and use **Save layout**, **Reset
layout** and the editing tools, which only show while editing. The check mark
ends editing; closing the topology ends it too.

The tools sit in a row at the map's top right. From the right: **Edit**,
**Export**, then, while editing, **Grid**, **Snap devices** and **Snap line
points**. Each one remembers its setting in this browser; the grid only ever shows while you are editing, and comes back
the next time you edit if you left it on.

- **Grid** draws two weights of line behind the map. The thick lines are
  where devices snap. They form squares, twice as close together as the
  automatic layout's spacing, so every automatically placed device sits on
  one, with a free line between any two neighbours. The thin lines split each cell in
  two, and in four once you zoom in to 100% or more. The thick lines stay
  where they are.
- **Snap devices** lands a dragged device on the thick lines, and lines up
  every device on the map when you turn it on.

No two devices can sit on the same spot. Drop a device on another one, or
snap two onto the same grid cell, and the one you moved steps to the nearest
free spot while the other stays where it was. With **Snap devices** on, it
moves to the nearest free grid cell. With it off, it moves just far enough to
clear the other device. When the map opens, a device added since the layout
was saved also steps aside if its automatic spot is now taken.
- **Snap line points** lands a dragged bend point on any line, thick or thin,
  so zooming in gives you the finer eight-way spacing to place points on.

**Drawing your own connection lines** (while editing). Drag any part of a line and a bend
point appears where you pressed, selected and following the pointer. Click a
line to show its points: a dot for each bend and a ring where it meets each
device. A line the map routed itself shows a dot on each of its corners straight
away; moving or deleting one makes the line yours, keeping its other corners. Drag a ring around the device's edge to attach the line at that spot;
it stays on the device's outline, so the line never comes loose. A bend stays
where you put it when you move one of the line's devices, and moves with the
line when you move both devices together. Select a point and press
**Delete** to remove a bend, or to put an end back on automatic. A line with
no points left goes back to its automatic shape. A click selects just the
device, line or location box you clicked; hold **Shift** to add to the
selection, or Shift-drag to box-select. Drawn lines are part of the
layout: **Save layout** and **Load layout** cover them, and each location
view keeps its own. Lines are always straight between their points.

**Moving with the arrow keys** (while editing). The arrow keys move the
selected devices. With no device selected, they move the selected bend
points instead. With **Snap devices** on, each press moves a device one grid
cell, and if that cell is taken it carries on to the next free one in the
same direction. With **Snap line points** on, a bend point moves to the next
line of the grid as it is drawn at your zoom. With snapping off, each press
moves 1 pixel, or 10 with **Shift** held. Each press is one undo step.

**Undo and redo** (while editing). **Ctrl+Z** undoes the last layout
change: a device or box moved, a bend added, moved or deleted, an end point
moved, or everything snapped. **Ctrl+Shift+Z** (or **Ctrl+Y**) redoes it.
The undo and redo arrows under the Edit button do the same and grey out when
there is nothing to step to. History lasts until you press the check mark,
and an undone change is saved like any other edit.

**Keeping or discarding changes.** Nothing you change while editing is saved
until you press the **check mark** (Done Editing) or **Save layout**. Close
the map while still editing and every change since the last check mark or
Save is discarded — reopening it shows the layout as it was. That covers
moved devices and boxes, drawn lines, snapping, and a **Load layout** pick.

| Control | |
|---|---|
| **Search** | find a node |
| **Show full** | the whole graph rather than the narrowed view |
| **Refresh** | re-read |
| **Edit** | top right of the map, left of Export: the pencil turns layout editing on, the check mark keeps your changes and turns it off. Closing the map while editing discards them |
| **Save layout** | while editing, under the Edit button (the disk). Keeps your changes so far and makes them the restore point. `deviceMap:write` — **shared across operators**; readers fall back to browser storage |
| **Undo / Redo** | while editing, under Load; also Ctrl+Z and Ctrl+Shift+Z (or Ctrl+Y) |
| **Load layout** | while editing, under Save (the open folder). A menu: **Load last save** (where a restore point exists) or **Load automatic layout** — the column solver's layout. Like any edit, it is kept only by the check mark or Save |
| **Grid** | while editing; per user; show or hide the two-weight grid (it hides whenever editing ends) |
| **Snap devices** | while editing; per user; lands device drags on the grid's thick lines and re-snaps everything on enable |
| **Snap line points** | while editing; per user; lands dragged bend points on any grid line |
| **Base / area / building / floor / room / junction box chips** | top left, only when a device carries a location code below area (`b:`, `f:`, `r:`, `ra:` or `jb:`). **Base** is the whole site; under it are the areas (plus anything tagged with no area), or the buildings when no area is tagged. Picking a chip shows its devices and lists the next level beneath it, whatever that is for each device: an area's buildings, a building's floors, a floor's rooms, a room's junction boxes. A device that skips a level shows up at the next level it has, so a room tagged straight into an area (`a:Mine r:North Closet`) is listed beside that area's buildings, and a junction box tagged straight into a building beside its floors. The FortiGate shows only in **Base** and in the views its own codes place it in. Elsewhere, a dashed **→ Base** stub stands in for it only when a device in that view links to it directly; tapping the stub takes you there. A view whose devices reach the FortiGate through other switches shows no firewall stub. Instead, every view shows a dashed stub for each neighbouring group: **← Scale House** for a group the view is fed from (drawn on the left, a line from each device that links to it) and **→ Mine** for a group it feeds (on the right). A neighbour with no location code at the view's level shows as its nearest coded group (a building with no area, in an area view), and one with no code at all as **Base**. Tap a stub to open that group's view. In a view with a saved layout, a stub the layout has no saved spot for is placed beside the devices it links to; **Reset to baseline** on that view lays everything out afresh. Each view keeps its own saved layout |
| **Fullscreen** | |
| **Export** | top right of the map: screenshots, PDF or Visio — see below |
| **Mouse controls** | the mouse button beside Export: how to pan, select and open devices. While editing it becomes a mouse with a pencil, listing the editing gestures instead (moving devices, bending lines, undo, grid and snap, right-click to edit a description). The panel stays open while you work the map, swaps its list when you start or finish editing, and closes only when you click the button again |

The **legend** button sits at the graph's bottom left; click it and the legend
opens to the right of the button, and click the button again (or the legend's
**×**) to close it. Hover a row of the legend to
light up what it stands for on the map: every switch, every device in a
health state, every link of that kind (each glowing in its own colour), or
every box of that location level. The edge between the graph and
the details pane hides the pane: hover the edge and click the arrow, and the
arrow at the right edge brings the pane back. Both remember your choice in
this browser. The Device Map's own status legend, the Application Map's and
the Status Map widget's fold into their button instead.

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

- **Copy map as image**: the graph in view, with the legend (monitor health,
  link types, location groups) in its bottom-left corner.
- **Copy screenshot (map + details)**: the graph, with the same legend, and the
  right-hand details panel as one image. Clipboard first, download as fallback.

  Neither screenshot shows a selected line's drag points.
- **Export PDF**: the graph drawn as vectors on white paper whatever theme you
  are using, so it prints sharp and its text is searchable. Choose the paper
  size, orientation and **minimum text size** (7 pt by default): **nothing on
  the printed graph is smaller than that**. A site that fits one sheet at that
  size prints on one. A bigger one prints **a page per location group**
  after an overview page that names the floors (or buildings) and outlines
  each group with its page number: the
  largest group (a floor, say) that fits one sheet at that size is one page; a
  group too big for a sheet is split into its rooms or racks, and small
  neighbouring groups share a sheet when they fit on it together. A room or
  rack that is still too big on its own is cut into overlapping sections. A
  device in no group prints with the device it links to. A link to a device on
  another page is drawn as a short stub ending in a tag that names the port
  pair, the device at the other end and its page, for example
  `port27 <-> port49 · to METRO-1801F-1 (p. 8)`. Every
  page carries the legend (health colours, link types, location groups) in a
  box at the bottom left.
  Characters the PDF fonts cannot print are simplified: `↔` prints as `<->`.
- **Export to Visio (.vsdx)**: one Visio page sized to the view, every device,
  location box and link a separate editable shape, health colours and link
  styles kept. Links are drawn lines, **not glued connectors** (moving a device
  in Visio does not drag its links), and text uses Visio's default font. A
  device the edge of the view cuts through comes across whole. The title and summary line sit above the graph, and
  the legend sits in a box at its bottom left, as on the PDF.
- **Export layout data (anonymised)**: a JSON file of the topology as drawn,
  for sharing a layout problem (with Polaris's developers, for example) without
  naming your site. Every device, location box and link is in it with its
  on-screen position, size, outline and routed bends, plus each link's kind,
  speed or mesh signal and port pair. Devices are renamed by type
  (`SW-3f9a2`, `AP-07c1e`) and location boxes by level (`AREA-…`, `BLDG-…`,
  `FLOOR-…`, `ROOM-…`, `JB-…`). A device or box keeps the same name in every
  view and every export from the same site, so several files can be read
  together, and the names mean nothing outside it. Hostnames, location names, IP and
  MAC addresses, serial numbers, asset ids and SSIDs are left out. Port names
  (`port49`, `lan1`) are kept. Look the file over before you share it.

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

**Hovering any link** shows its two devices, their ports and the kind of link,
and lights it up: both devices get a blue ring, and the link glows in its own
colour (yellow when it carries a loop halo). A link on a **physical
loop** (drawn with a yellow halo) lights the **whole loop** instead: every
looped link reachable from it through the devices they share, and those
devices, so you can see which switches a ring runs through.

### Device types

**Device types** at the top of the details pane is a row of icons, one for
each kind of device at the site, with its count on the corner; hover an icon
to see its name. A shown type is outlined in the accent colour, a hidden one is
dimmed and struck through. Firewalls, routers, switches and access points are
shown by default; the firewall is the root of the map and is always shown.
Click the **Servers**, **Workstations**, **Printers** or any other icon to draw
those devices on the graph, each hung off the switch it was seen on with a link
labelled with the port; click it again to hide them. While you are only viewing the map, a toggle lasts until
you close it. While you are editing, it is saved with the view when you click
the tick or **Save**. A site with more than 2000 endpoints draws the 2000 most
recently seen.

### Views

Every site has a default view, and you can save more. A view is a name, one
**mode** and the device types it shows:

- **Layer 2** — this graph, laid out automatically, with your own positions
  once you move things.
- **Topology** — a map or floor plan you place devices on, with polygons for
  your location groups.
- **Rack** — rack elevations you put devices into.

The view button beside the site's name opens the view menu: pick a view to
switch to it, or choose **New view**, **View settings** (its name and mode) or
**Delete view** (the default view can't be deleted). Views are shared: everyone
who can open the Device Map sees the same views, and creating or changing them
needs Device Map Read-Write. Each view keeps its own layout, so moving devices
in one view never moves them in another.

**A Topology view** starts empty. In edit mode, two extra buttons appear in
the column under the tick:

- **Background** (the map icon): **OpenStreetMap** or **Upload image** (PNG,
  JPEG or WebP, up to 15 MB). On OpenStreetMap the map opens zoomed in on the
  site; pan and zoom to frame it, and the view you leave edit mode on is saved
  with the view. An image is shown at any resolution, scaled to fit. Switching
  between the two clears the polygons and placements drawn on the old one.
- **Map | Satellite** (under the zoom buttons, OpenStreetMap only): shown when
  an administrator has set up [Satellite imagery](Server-Settings#satellite-imagery).
  While you are viewing, switching is just a look; in edit mode the choice is
  saved with the view. Polygons and placements stay where they are, since both
  layers use the same coordinates.
- **Draw polygon**: pick the location group the polygon is for (a group the
  site's descriptions already name, or a new group inside one), then click to
  add points and click the first point to close it. Click a polygon to
  reshape it, change its group or delete it.

The details pane's **Device List** names every device of a shown type, with a
filter box; it shows about five rows and scrolls past that. A device on the
map is highlighted, and in edit mode it has an **×** that takes it off the map
again (its codes stay). The FortiSwitch and FortiAP lists further down the pane
name only the devices on the map.

Drag a device from the **Device List** onto the map. A device
dropped inside a group polygon takes that group's `a:` / `b:` / `f:` / `r:` /
`ra:` / `jb:` codes in its description when you save; the innermost polygon wins, so
a device on a floor inside a building gets both. A device placed outside every
polygon keeps its codes ([rule 148](Business-Rules#rule-148)). Links between
placed devices draw themselves, in the same colours as the Layer 2 graph.
Right-click a placed device to remove it from the map (its codes stay), or
click it and press **Delete**: it goes back to the Device List.

**Click a device** — a node in Layer 2, a placed device in Topology, a racked
device in Rack, or a row in the Device List — and the details pane's info card
(serial, model, address, status, location…) shows that device instead of the
FortiGate. Click the canvas background, or the card's **×**, to go back to the
FortiGate.

When you click the tick or **Save**, Polaris lists the descriptions that will
change (codes now, codes after) before writing them. Writing descriptions
needs Assets Read-Write; without it the view saves and the code changes are
skipped. On a FortiSwitch or FortiAP the new description is also sent to the
device when description sync is on. **Load** offers **Discard changes since
the last save**, and **Export** copies a picture of the map.

**A Rack view** opens with one empty 42U rack, its U numbers up the rail
(U1 at the bottom). In edit mode:

- Drag a device from the **Device List** onto a rack (a racked device is
  highlighted there, with an **×** to take it out of the rack): it lands as a 1U block at the
  U under the pointer, or the nearest free U. Drag **Cable management** from
  **Rack items** to add a placeholder; you can add as many as you need.
  Drag **Third party** for equipment Polaris does not monitor (an ISP router,
  a patch panel): name it when you drop it, and double-click it (or
  right-click → **Rename**) to change the name.
- Drag a block's top or bottom edge to change its height, and its body to
  move it within a rack or to another rack. Both move a U at a time and stop
  at the next item or the end of the rack.
- Everything you rack is **half depth** at first: it takes its U on the face
  you dropped it on only, so you can turn the rack round and rack another
  device in the same U on the back. Right-click a block to make it **full
  depth** (it then takes the U on both faces and shows as a dashed outline on
  the other one), move it to the other face, or remove it. Or click a racked
  device and press **Delete** to take it out of the rack.
- The **Front** button in a rack's header turns the rack round and then reads
  **Back** (while you are only viewing, that is just a look). Double-click the
  rack's name to rename it and its **42U** to change its size; a rack can't
  shrink below something racked in it. **Add rack** adds a 42U rack to the
  right, drag a rack by its header to move it, and the **×** on every rack
  after the first deletes it.

Racking a device never changes its description.

**A Wall view** is for gear mounted flat: a closet backboard, a pegboard, a
junction box's backplate. It opens with one wall of the size you gave when you
created it (96 × 48 in by default), drawn as pegboard with a hole every inch.
In edit mode:

- Drag a device from the **Device List** onto a wall: it lands as a 12 × 8 in
  shape at the pointer, or in the nearest free space. **Wall items** adds
  **Cable management**, a named **Third party** box, and a **Rack**: a Rack asks
  for its size in U and whether it opens a saved Rack view, a new one, or none.
  Double-click a linked rack (when you're not editing) to open its Rack view.
- Every item is a shape you edit like a map region: drag it to move it, drag a
  corner to reshape it, drag the **+** on an edge to add a corner, and
  right-click a corner to remove it. Corners snap to whole inches.
- Items can't overlap, because they're mounted flat: a move or reshape that
  would cover another item is put back, and Polaris names what it hit. Items
  may touch along an edge.
- Double-click a wall's name to rename it and its size to change it; **Add
  wall** adds another to the right, and the **×** deletes any wall after the
  first. **Zoom in** / **Zoom out** draw the walls larger or smaller.

A device's icon (Server Settings → Customization) is drawn on its shape here,
and beside its name in a rack.

**Floors are layers of a Topology view.** Every Topology view opens on **Layer
0**, the flat view, which ignores floors and writes no floor code. The **Layer**
control at the left edge steps up (**+**) and down (**−**) through the view's
floors; **Layer 0** jumps back. While editing, pressing **+** or **−** past the
last layer adds one and asks its floor name (the number, or B1, B2… below
ground); right-click the layer number to rename or delete it. Each layer has its
own background (usually that floor's plan, chosen with the map button), its own
polygons and its own devices, and a device is on one layer at a time: the Device
List says which, and clicking it takes you there. A device placed on a floor
layer gets that floor's `f:` code when you save; it keeps its other codes unless
you drop it inside a polygon on that layer ([rule 152](Business-Rules#rule-152)).

**A Rack or Wall view can stand for a region.** When you create the view, or
in **View settings**, choose the area, building, floor, room, rack or junction
box it is for: any region the site's descriptions already name, or a custom
one. Placing a device on that view then gives it the region's codes when you
save, after the same summary a Topology view shows. Choosing a region never
changes a description by itself, and existing regions are never removed —
a region is still just the codes in device descriptions
([rule 150](Business-Rules#rule-150)). Topology and Layer 2 views don't take a
region; they draw the regions themselves.

**Location regions: one name, one place.** **Location regions** in the view
menu shows the site's areas, buildings, floors, rooms, racks and junction boxes
as a tree. Each name is used once per site (a floor once per building), so a
description can say just `r:Closet` or `ra:rack1` and the map knows it is in
Mine › Shop › 1 › Closet. **Build from descriptions** fills the tree from the
codes the site's descriptions already carry; it only adds, never removes or
renames anything. Use **Add region**, and each region's **⋯** menu (Rename,
Move, Merge into, Delete), to keep the tree right. Renaming or moving a region
lists the descriptions that name it the old way and offers to update them; you
can leave them as they are. Devices whose codes disagree with the tree, name a
floor without its building, or name a region the tree doesn't have are listed
under **Devices to check** and drawn as their description says. Until a tree
is built, nothing about the map changes ([rule 153](Business-Rules#rule-153)).

**Saving a description that names a new region offers a view for it.** When
you save a device's description (in its Edit form, or with right-click on the
map) and it names a room, rack or junction box that no Wall or Rack view stands
for yet, Polaris asks, for each one, whether to create a Wall view, create a
Rack view, map it to one of the site's existing Wall or Rack views, or leave it
unmapped. **Don't map** is remembered in that browser. The description is saved
either way. This needs Read-Write on the Device Map, and in the Edit form it
works for FortiGates, FortiSwitches and FortiAPs (the map's own editor covers
every device).

**Changing a view's mode resets it.** Polaris first shows what the change
removes: placed devices, group polygons, the uploaded background and racks. If
you accept, the view starts again in the new mode with the default device
types (a Rack view with one empty 42U rack). The name is kept, and location
codes already written to device descriptions stay
([rule 149](Business-Rules#rule-149)). Finish editing first: the change is
refused while the view has unsaved edits.

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

The **Device Map** widget is the gate-level map: double-click a gate for its
read-only topology, or pick a single gate in the widget's gear to show only
that gate's topology ([Dashboard → Device Map widget](Dashboard#device-map-widget)).

On both widgets the sun / moon basemap button sits in the map's top-left
corner, above the zoom buttons, as on this page. The Site Map's **°F**,
**Radar** and **Loop** buttons, and fullscreen, are at the top right; a button
that is on looks pressed. Like the rest of the map's buttons and its legend,
they follow the app theme.
