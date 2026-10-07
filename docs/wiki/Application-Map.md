# Application Map

A connectivity graph of **observed traffic between processes and services** on
your monitored hosts. It answers "what actually talks to what".

| Gate | |
|---|---|
| `applicationMap:read` | view the map |
| `applicationMap:write` | save or reset the **shared** layout |
| plus `assets:write` | **chained**, to change discovery rules — they write per-asset pin arrays |

---

## What is on it

| Node | |
|---|---|
| **Asset box** | a compound parent, one per host |
| **Process** child (purple) | a pinned process |
| **Service** child (teal) | a pinned systemd unit or Windows service |
| **Grey node** | an unknown IP, grouped by /24 — named from the IP registry, or by reverse DNS for public addresses |

**Both child kinds render even with zero connections.** A service that listens
but has no observed peers reads as *collected*, not as *empty* — its listening
ports show as a second label line.

**Only `monitored: true` hosts appear as compound parents.** A stop-monitored,
decommissioned or disabled asset drops off the map **without clearing its pins**
(removing the agent additionally clears them).

Edges are labelled per port and carry the observed IPs. Same-asset sibling edges
get a `via <ip>` label and a wider child stack, with connected siblings ordered
adjacent, so an intra-asset edge is actually readable.

**An edge's colour is its protocol/port** — the most-seen port on that
connection, which is also the first one in its label. The **Ports** key in the
bottom-left corner names each colour (`tcp/443 https`) and how many drawn
connections carry it. The eight most common ports in view get a colour; the
rest draw in neutral grey as **Other**. A port keeps its colour across refreshes
and filter changes for as long as it stays in that top eight. The edge *kind* is
carried by the stroke instead: heavier for process → process, dashed for
external. Collapse the key with its `−` button; the choice is remembered per user.

**Click a row in the Ports key to hide that port's connections**, and click it
again to bring them back. A hidden row stays in the key, faded and struck
through, and **Show all** in the key's header turns every port back on. Hiding
**Other** hides the whole uncoloured tail. Colours and counts never move while
you click: they are worked out before anything is hidden. A port you hid that
falls out of the coloured eight keeps a row of its own, so it can always be
switched back on. The hidden set is remembered per user like the pills, and is
**saved with a saved filter** (see below).

Listening ports are consolidated into ranges — a run of three or more collapses
to `tcp/9000-9004`, a pair stays listed because "9000, 9001" reads better, and
protocols never merge.

---

## Getting data onto it

Two routes, and they are the same mechanism:

### Per asset

The asset's **Services** tab has a **Map** checkbox beside **Monitor**. Ticking
it mints a single-item **auto rule** targeting just that asset.

### Discovery rules

**Integrations → Polaris Agent → Service & Process Discovery Rules.** Named
rules that pin items on the assets they select — now **and** on assets discovered
later.

Each rule has a **mode**:

| Mode | |
|---|---|
| **Monitor + map** | Application Map **and** telemetry |
| **Monitor only** | per-program CPU/RAM and logs, per-unit log collection (journal / Event Log) — **never touches map pins** |

A four-step wizard: name → devices → items → summary. The **item step is
scope-driven** — it lists only what the selected devices report, which keeps a
rule from pinning a unit on every host that happens to run it.

Rules only target workstations and servers, since nothing else reports an
inventory. Several rules' pins **union** per asset.

**Auto rules** consolidate: pinning the same item on another asset folds into the
existing auto rule; un-ticking removes that asset; an auto rule losing its last
asset is deleted. Manual rules are never consolidated, and editing an auto rule
in the wizard converts it to manual.

> **Mapping implies monitoring, one way.** Every item a map-mode rule maps is
> also pinned for monitoring — note the log volume that implies. Monitoring never
> implies mapping, so nothing writes a map pin from a monitor pin.

Removing an item or disabling a rule stops **future** auto-pinning. A separate
**Unmap everywhere** action does the actual strip.

### Linux needs the `ptrace` tier

Connection attribution reads other users' `/proc/<pid>/fd`, which the default
unprivileged agent cannot do.

> **Grant `CAP_SYS_PTRACE` and `CAP_DAC_READ_SEARCH` together.** A
> SYS_PTRACE-only unit fails at the *open* — only `CAP_DAC_READ_SEARCH` passes
> that check — so every socket comes back unattributed and **the agent collects
> zero connection rows while looking perfectly healthy.**
>
> Check the installed-agents list's **Privilege** column: it reports the agent's
> *actual* capability mask, and says **"reinstall"** in red for a stale unit. See
> [Polaris Agent](Polaris-Agent#the-two-linux-privilege-tiers).

---

## The toolbar

Stacked, so a long filter set cannot squeeze the typing area:

**Top row** — the filter box and the **Saved** menu.
**Second row** — the applied pills (collapses when empty).
**Third row** — Seen within · Hide external · Hide workstations · Fade stale,
with the status and action icons right-aligned.

### The filter box

A typeahead over the **current payload**: protocol, port, host, device type,
process, service, external IP, plus free text. Enter turns a suggestion into a
pill.

**Pills combine OR within a kind and AND across kinds.** `×` or Backspace
removes.

### Seen within

Built from the server's **configured retention window**, so its widest option
states the real window rather than a hardcoded guess.

### Fade stale

Dims connections unseen for 15 minutes. **Render-only — the edge is never
removed.** On by default.

### Export

The **Export** button (the download icon) opens a menu with three choices. Each
exports the map **as it is on screen**: current filters, hidden ports and node
positions. The Device Map's site topology has the same menu
([Device Map](Device-Map#exporting-the-topology)).

- **Copy screenshot (map + info panel)**: composites the graph canvas with a
  capture of the info rail, so the listening-port list is **in** the image, with
  the Ports key drawn under the graph so the colours still mean something off
  the page. Clipboard first, download as fallback.
- **Export PDF…**: a PDF drawn as vectors, so it prints sharp and its text is
  searchable (details below).
- **Export to Visio (.vsdx)**: one Visio page sized to the map, where every box,
  external node and connection is a separate shape you can recolour, move or
  annotate. Text keeps its on-screen size. Connections are drawn lines, **not
  glued connectors**, so moving a box in Visio does not drag its lines with it.
  Text uses Visio's default font. The title and filter lines sit above the
  map, and the key sits in a box at its bottom left, as on the PDF. Each part
  of the box is its own shape, so you can move it.

**PDF.** Choose the **paper size**, the **orientation** (Automatic picks whichever needs
fewer pages) and the **minimum text size** (7 pt by default). **Nothing on the
printed map is smaller than that minimum.** A map that fits one sheet at that
size prints on one sheet. One that does not is split into **sections** that
overlap slightly so they can be taped together, after an **overview page**
showing the whole map with the section grid (A1, A2, B1 …) on it. The overview
has no map labels, because at that scale they would print below the minimum.
Sections with nothing in them are skipped. The dialog states the page count
before you export; past 30 pages it suggests narrowing the map with filters or
hidden ports first. Every page carries the filters in force and, in a box at
the bottom left, the key: the ports drawn (a hidden port is left out) and what
dashed and heavy lines mean.

### Saved

Named views, per user and per browser: the **pills plus the ports hidden in the
Ports key** (a filter can be only hidden ports, with no pills). Nothing else is
stored — recalling one must not move your time window — and it **replaces**
rather than merges, so recalling a filter saved with no hidden ports shows every
port again.


---

## Interaction

- **Tap any node → the info rail only.** The asset detail slide-in opens from
  the rail's *Open asset details* button alone. Tapping a box used to pop the
  panel, which buried the services and ports list you had just opened.
- **Hovering an edge** brings it to full opacity (stale edges render faded).
- **Drag** to rearrange; the layout is **shared** for `applicationMap` writers,
  with browser storage as the fallback for readers.
- **`#focus=asset:<id>`** deep-links to one asset, **adding a pill** so the
  narrowing is visible and clearable.
- Auto-refreshes every 60 seconds, preserving positions.

Layout is two-pass: a headless dagre run over the collapsed asset-level graph,
then process and service children stacked under their parent.

---

## If the map is empty

The empty state points at the two places data comes from: the **discovery rules**
card and the per-asset **Services** tab.

Work through these:

| Check | |
|---|---|
| Is the host **monitored**? | only monitored hosts appear as parents |
| Has an agent reported? | the inventory comes from the agent |
| On Linux, is the tier right? | see the capability note above — this is the most common cause |
| Are any items **pinned**? | a rule that pinned nothing shows nothing |
| Is the rule in **Monitor-only** mode? | that mode never writes map pins |
| Is **Seen within** too narrow? | |
