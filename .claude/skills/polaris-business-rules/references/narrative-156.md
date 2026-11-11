# Business rule 156 — full narrative

> Written 2026-11-11 as its own file (one file per rule from 78 on). Rule numbers are a
> stable citation key — never renumber. 81 is a deliberate gap.

Each rule records the decision *and the incident or constraint that forced it*. The invariant is in `invariants-30-43.md`; rule numbers are a stable citation key — never renumber.

- [Rule 156](#rule-156) — A Room view is one room's racks and junction boxes, and a device is in one place in it

## Rule 156 — A Room view is one room's racks and junction boxes, and a device is in one place in it

Rack views and Wall views shipped on 2026-11-11 as two modes (rules 147–151). The same day the operator asked: "could rack and wall be combined? change rack view to room view. then you can add a rack to the room and add a wall to the same room?" A room is where the gear actually is; splitting its racks and its walls into two views made a wall-mounted rack a link from one view to another, and made a room with both need two views and two prompts.

The design was mocked first (the Room view canvas, three artboards) and the operator settled four questions on it:

- **Layout:** racks and walls side by side in one strip.
- **Codes:** a device in a rack takes the room plus `ra:<rack>`; on a wall, the room plus the wall's name as `jb:`. Only those levels change (rule 148(a)).
- **A wall is a junction box.** "A wall is essentially a junction box, just a different size and doesn't have a door." So there is no wall kind and no "is this a junction box" switch: a Room view holds racks and junction boxes, each box with a size in inches.
- **A rack can't be mounted in a junction box.** The Wall view's Rack item (a rack-sized space linking a Rack view) is gone; a junction box holds devices, cable management and third-party boxes only.
- **Existing views convert, folded per room:** "rack view and wall view should convert to room view". Every Rack and Wall view of one room becomes one Room view.

**How it is built.** The Room canvas (`topology-room.js`) mounts the existing rack and junction-box canvases side by side and joins them: one Device List saying where each device is, one undo order across both (`ctx.historyPushed`), and `ctx.placedElsewhere` so a device already in a box cannot also be racked. The data model did not change — a Room view stores what a Rack view and a Wall view stored (`racks`, `rackPlacements`, `walls`, `wallPlacements`) — so the conversion moves rows rather than reshaping them.

**The conversion** (`20261111120000_room_views`) groups Rack and Wall views by site and room chain (case- and spacing-blind) and keeps the oldest row and its name. Racks come first: every view's racks, then each wall's Rack item as a rack of the same size. Then the junction boxes (every wall). A Rack view that stood for one rack and held exactly one rack gives that rack the region's name, and a Wall view standing for one junction box with one wall does the same, so a device in it keeps writing the code it wrote before (a placeholder "Rack 1" would otherwise have become `ra:Rack 1`). A device placed twice keeps its rack spot; the other placement is dropped and named in the `map.topology.views_converted` Event (warning when anything was dropped). Descriptions are untouched. A view with no room converts alone.

**A device is in one place** because its description can only say one: `ra:` and `jb:` together would read as a junction box inside that rack, which is not what either placement meant. A rack placement clears `jb:`, a box placement clears `ra:`.

**A tree rename follows** (`renameRoomContainers`): the rack or box carries the code, so renaming `ra:R1` to `R10` in the Location regions panel renames the rack in its room's view, as rule 153 requires of every place that stores a region name. A move to another room renames nothing; the rack stays where it was drawn.

Rejected: a new table or columns for rooms (the fields already existed); a separate wall kind beside junction boxes (the operator's call); merging the two canvases' code into one file (two well-tested canvases, joined by a few hooks, were the smaller change); leaving converted views of one room separate with a Merge command (the operator chose the fold).
