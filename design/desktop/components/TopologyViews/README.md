# Topology views

Saved views of a Device Map site's topology (business rules 147-149). A site has a default view
and may have more; views are shared, and creating or changing one needs Device Map write.

## The rules

- **A view has exactly one mode**, chosen from a dropdown in New view / View settings:
  **Layer 2** (the automatic graph), **Topology** (a map or floor plan you place devices on, with
  area / building / floor polygons) or **Room** (one room's racks and junction boxes side by side;
  a wall is a big junction box, and a rack never goes in one — rule 156). There is no in-view mode
  toggle.
- **Changing the mode resets the view** after a warning (a danger button, on its own overlay above
  the settings dialog) that lists what it removes.
- **The header** carries the view picker (`View <name> ▾`, the view menu) and a read-only
  `badge-readonly` pill naming the mode.
- **The details pane starts with Device types**: a wrapping row of 36px icon toggles, one per asset
  type on the site, the count on the corner and the name in the tooltip. On = accent outline; off =
  dimmed and struck through. Firewall is the root and locked on; firewalls, routers, switches and
  access points are on by default. A switched-on type is drawn in the graph.
- **Topology and Room add a Device List** (`topology-device-list.js`) under the types: every shown
  device in one list with a filter box, about 5½ rows tall then scrolling; a device on the canvas is
  highlighted (accent tint and a left bar) and carries an × in edit mode; the switch / AP lists lower
  down name only what is on the canvas.
- **The info card follows the selection** in every mode: a clicked node, marker, rack block or list
  row fills it (with an × back to the FortiGate); a click on the canvas background clears it.
- **Every mode wears the same corner tools**, as icon buttons: Mouse controls, Export,
  Edit (pencil) / Done editing (check mark), Save (disk), Load (folder), Undo, Redo, and the Legend
  button, whose legend opens to its right and closes on a second click. Topology adds Background
  (map icon) and Draw polygon in edit mode.
- **Room**: racks first, then junction boxes, in one scrolling strip, each with its own Add button and
  a × on every header; one Device List says where each device is (a rack and U, or a box), and a
  device is in one place. **Racks**: U1 at the bottom of each rail, 20px per U. A device is a solid block bordered in its
  health colour; Cable management is a striped placeholder; a Third party box (equipment Polaris does not monitor, named by the operator) is solid with a neutral border; a full-depth item seen from its other
  face is a dashed outline. **Junction boxes** are pegboard in inches, items whole-inch polygons that
  never overlap.

The live implementation is `public/js/map.js` (picker, toggles, dialogs), `public/js/topology-physical.js`
(Topology) and `public/js/topology-room.js` (Room, joining `topology-rack.js` and `topology-wall.js`);
their styles live in `public/css/map.css`, so the
preview redraws them with its own helpers.
