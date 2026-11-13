# Business rule 179 — full narrative

> Written 2026-11-13 as its own file (one file per rule from 78 on). Rule numbers are a
> stable citation key — never renumber. 81 is a deliberate gap.

Each rule records the decision *and the incident or constraint that forced it*. The invariant is in `invariants-30-43.md`; rule numbers are a stable citation key — never renumber.

- [Rule 179](#rule-179) — A rack in a Room view has cable managers and a trough, things may stand beside it, and its devices' links are drawn as cables

## Rule 179 — A rack in a Room view has cable managers and a trough unless turned off, things may stand beside it, and its devices' links are drawn as cables

**The request (2026-11-13).** The operator sketched a rack with a vertical cable manager down each side, a trough across the top and a PDU standing outside each manager, and asked for three things: those managers and the trough on every rack by default; the links Polaris already knows between racked devices drawn as cables that run sideways into the managers, along the trough and into the other device; and the same editing a Layer 2 link has. A device dragged beside a rack (a vertical PDU) stands beside the cable manager, on either side. The design was approved on a canvas before any code.

**Decisions.**

- **On by default, off per rack.** Every rack — new, and every rack saved before this rule — has both managers and the trough. The rack header's right-click menu turns each off. Defaults are read in, not migrated: a stored rack without `cableManagers` reads as all on, so no data migration was needed.
- **Beside the rack uses no U.** A side item is a `rackPlacements` row with `mount: "side"`, so the one-place-per-room rule (156), the Device List, the `ra:` code and every reader of rack placements keep working; it keeps `startU 1 / heightU 1`, which nothing reads, rather than a nullable shape every reader would have to handle. Two slots per side, slot 0 next to the manager. Cable management cannot stand beside a rack (it is a rack item by definition). Sides are named as seen from the front; the back face mirrors them.
- **Cables come from Layer 2's links.** No new link source: the rack canvas takes the edges `buildTopologyElements` builds, so a cable exists exactly when Layer 2 draws that link, carries its colour and dash, and shows Layer 2's hover card. Only devices visible on the face shown get cables.
- **The automatic route** leaves a device on the side facing its manager (toward the other rack, or the right one within a rack), runs in its own lane in the manager, goes up to the trough (a lane of its own there) and down the other rack's manager. Within one rack it stays in the manager. With a manager off it uses the other one, and with neither it runs just outside the rack. With a trough off on either rack it runs over the headers.
- **Hand routing** works like Layer 2: drag a cable to add a corner, click to show its ends and corners, drag them, Delete removes a corner (an end goes back to automatic), right-click → Reset route; the rack menu resets every route in that rack. Routes are a new `cableRoutes` column keyed by Layer 2's edge path key (`PolarisTopologyEdgeEditor.assignPathKeys`), so they follow the same identity Layer 2's bends do.
- **Pixels plus a signature.** A Room view has no coordinate system other than its strip, so bends are strip pixels. To keep a hand route from pointing at empty space after a device moves, each route stores a `sig` of where both ends stood; a route whose ends have moved (another U, another rack, racks reordered) is drawn automatically and dropped on the next change. To make that signature stable, **a part that is off keeps its space** and both side slots are always laid out (blank when viewing): the first build moved every rack sideways between viewing and editing (the edit-mode drop slots) and down when a trough went off, which reset every saved route the moment it was saved — caught by the browser check before shipping.

**Rejected.** Storing bends relative to a rack was considered and dropped: a cable between racks has bends belonging to neither, and a signature is simpler and honest about what moved. A dedicated PDU kind was not added: a vertical PDU is a device (or a Third party box) that happens to stand beside the rack.
