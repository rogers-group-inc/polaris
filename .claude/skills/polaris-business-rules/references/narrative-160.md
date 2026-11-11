# Business rule 160 — full narrative

> Written 2026-11-11 as its own file (one file per rule from 78 on). Rule numbers are a
> stable citation key — never renumber. 81 is a deliberate gap.

Each rule records the decision *and the incident or constraint that forced it*. The invariant is in `invariants-30-43.md`; rule numbers are a stable citation key — never renumber.

- [Rule 160](#rule-160) — A fibre-channel login is drawn on the Layer 2 map only from a shown FC switch, to the host it matched or to a ghost named for what it registered

## Rule 160 — A fibre-channel login is drawn on the Layer 2 map only from a shown FC switch, to the host it matched or to a ghost named for what it registered

**The request (2026-11-11).** With rule 159 tying a Cisco MDS's logins to servers, the operator asked for FC "on the Device Map". Offered a choice between drawing the links on the existing FortiGate site map and a separate SAN view, they chose the site map's Layer 2 view: "it's essentially layer 2". They noted that servers aren't shown there by default.

**Why the device-type toggles decide it.** The Layer 2 view already draws each endpoint whose type is switched on, hung off the Ethernet switch it was seen on (rule 147). The MDS is such an endpoint (its management port sits on a FortiSwitch), and so are most of the servers. FC links therefore follow the same switch: they draw only while the FC switch's type is shown. Turning the MDS's type on is the operator's way of saying "show me the SAN here", and hiding it takes every FC line with it, as hiding a type always has. Nothing is forced onto a view the operator kept clean.

**A matched host that is not under this site's switches still appears.** The FC fabric does not follow the Ethernet attribution. A server can be matched to an MDS port while its NICs hang off another site's switch, or no attributed switch at all. Each `fcLinks` entry therefore carries the host's own node summary (health, type, icon, location), and the renderer adds the host as a node when its type is shown. A host whose type is hidden is left out, with its line, exactly as a hidden endpoint would be.

**An unmatched login is a ghost, not dropped.** Storage arrays register a port label through FDMI (`PURE01-ct0`) and match no asset. Dropping them would hide the most important thing on a SAN, the storage. They draw as a small dashed pink round-rectangle (`role: "fcport"`, id `fc:<wwn>`), the FC counterpart of the LLDP ghost: no asset id, nothing to open, and never offered as a device to place in a Room or Wall view.

**Pink, and outside the Ethernet rules.** The link palette gives speed classes their hues and reserves green, yellow, orange and red for mesh signal. An FC login is neither, so it takes its own colour, pink (`#f472b6` / `#be185d`), solid at 2.2 px. It skips `markLinkClasses` (no speed class, so the "Speed not known" legend row never lights it) and the ring detector (a SAN login is not an Ethernet loop). The legend's Also section, the edge tooltip ("Fibre channel — SAN login", plus how the host was matched) and the anonymised layout export (`isFcLink` flag) all name it.

**The phone and the widget draw none.** They call `buildTopologyElements` without `shownTypes`, which draws only the backbone. FC links ride the same switch as every endpoint, so they inherit that.

**Rejected.** A separate SAN view mode: the operator preferred one Layer 2 picture. Auto-showing the MDS and its hosts whenever FC links exist: that would override the operator's device-type choices. Fabric-coloured links (A one hue, B another): the switches do not say which fabric they are, and the site map shows one switch's logins at a time anyway.
