# Dependency suppression

When a FortiGate goes dark, everything behind it stops answering too. Without
suppression that is one outage reported as two hundred — and the two hundred
bury the one that matters.

Polaris builds a dependency graph, and a device whose upstream is confirmed down
is **not accused**.

---

## What you see

A suppressed device shows a **slate-blue "Dep. Down"** pill. Suppression
**outranks** the five-state label — including the device's own probe-down — and
the device's own state moves to the tooltip.

The same colour is used consistently: Device Map pins, cluster icons, topology
nodes and the mobile asset detail. A cluster counts suppressed children as
dep-down, while a non-suppressed down or degraded child still rolls the cluster
up red or amber.

On charts, a failure the upstream explains is drawn **grey rather than red**
([rule 38b](Business-Rules#rule-38)). Same dive, no accusation. It is
deliberately *not* a band — that vocabulary belongs to maintenance.

---

## The graph

Edges live on the asset and come from four sources:

| Source | Built by |
|---|---|
| `computed` | rebuilt at the end of every FortiManager / FortiGate discovery cycle, from interface adjacency, LLDP, mesh and controller signals |
| `endpoint` | a fleet-wide pass giving each endpoint **one** parent |
| `vcenter` | VM → ESXi host placement |
| `override` | operator-managed, never touched by recompute |

**Layer assignment is physical-first**: a breadth-first walk from any FortiGate
(layer 1), using interface, LLDP and mesh adjacency as the primary signal, with
controller edges as a fallback for assets the physical pass did not reach.

### Endpoints get exactly one parent

Since 2026-08 the tree covers endpoints too — before that, a server or camera
behind a dead gate alerted as plain Down while the switches behind the same gate
read "Dep. Down".

An endpoint's parent is the **most specific** of, in order:

1. its last-seen **switch port**
2. its last-seen **wireless AP**
3. the freshest resolving **FortiGate sighting**
4. the gate that **owns its address** per IPAM

**Never a union** ([rule 45](Business-Rules#rule-45)). All-down semantics exist
for redundancy, but a switch and its gate are in **series** — listing both would
let a dead switch under a healthy gate keep the endpoint alerting.

The fourth tier is an **inference, not an observation**
([rule 55](Business-Rules#rule-55)). It fires only for endpoints the three
observed tiers left unplaced, so it can only ever **add** suppression, never
move an edge: the failure mode is a missed alert, never a false one. It is gated
on the endpoint's address claim being current, because a recycled DHCP address
would otherwise suppress a departed device behind whoever serves that range now.

Each parent row in the asset's General tab carries a **`detectedVia` tag** —
*"last-seen switch port"* / *"last-seen access point"* / *"last-seen firewall"* —
because an edge that silences alerts should say which signal put it there. An
endpoint with no resolvable upstream gets an explicit *"dependency suppression
can't apply"* empty state rather than a missing block.

### Multi-parent: all-down

A device with N effective parents suppresses **only when every parent is down or
itself suppressed**. A switch with redundant uplinks keeps alerting while either
uplink is healthy.

**An empty parent set never suppresses.** That is why a broken parent lookup is
invisible-but-total: a child that resolves no parent does not fail loudly, it
just never suppresses — which is how one long-standing bug presented as *"a
FortiGate in maintenance leaves its switches reading Down"* rather than as an
error anywhere.

### Overrides

`PUT /assets/:id/dependencies/override` (admin). If **any** override row exists
for an asset, those are the effective parents and computed rows are ignored. An
**empty** override set is an explicit "no parents" pin — the asset opts out
entirely.

Cycles are rejected.

---

## Entering and leaving are asymmetric

This is the part most worth knowing ([rule 38a](Business-Rules#rule-38)).

**Entering** suppression needs every effective parent **confirmed `down`**.
Warning and recovering flapping must never drag a healthy subtree in.

**Leaving** needs the parent genuinely **back**. Only these states release:

```
up · unknown · passive
```

Everything else holds — **`down`, `recovering` and `warning` all hold the
subtree.**

`unknown` and `passive` release because neither is a claim about reachability,
and gating on them would strand a subtree with nothing able to clear it.
`warning` sat with them until 2026-09-14, and the argument never applied to it:
it is the one state in which the parent has just **missed a poll** — the least
plausible moment to call it recovered — and it can strand nothing, being
transient by construction.

What that leak produced was real: a parent flapping `down` → `recovering` →
`recovering` → `warning` put its whole subtree back on the air **mid-outage**
one reconciler tick later, every child re-alerting as plain Down. That is
precisely the storm suppression exists to prevent, reached through the one door
left open.

Release **cascades one layer per pass**, which is correct — a gate coming back
does not mean the switch under it has.

---

## What suppression actually does

| | |
|---|---|
| Heavy cadences | **paused** |
| Response-time probe | still runs, at **2× the interval** — the device may answer over a redundant path |
| Probe failures | stamped as dependency-explained, rendered **grey** |
| Alerts | the device is excluded from firing ([rule 37](Business-Rules#rule-37)) |
| Live alerts | retired |

A suppressed device is **still probed**. That is deliberate: a device with a
redundant path may well answer, and finding that out is worth one probe at half
rate.

---

## Timing

Two paths keep it current:

- **Event-driven** — a confirmed up/down transition propagates immediately.
  Warning and recovering churn logs an Event but **does not** propagate.
- **A 60-second reconciler** — the source of truth, catching anything the hook
  missed. It runs in **layer order**, so a parent's effective state is settled
  before its children evaluate; otherwise multi-tier suppression could
  oscillate.

Transitions write `monitor.dependency_suppressed` and
`monitor.dependency_resumed` Events.

---

## Rules that keep the graph honest

**A retired device is nobody's parent.** `decommissioned` and `disabled` infra
assets are dropped from the graph *and* kept in scope, so their own rows are
deleted rather than frozen.

Why that is not cosmetic: an unmonitored parent is **transparent** — the walk
recurses to grandparents and returns "ok" when there are none. A firewall is
layer 1 with no parents, so a retired gate is a **permanent ok vote** that
vetoes suppression for every child still bound to it, and it can never go down
again to lift the veto. A switch behind a replaced gate sat at plain Down
instead of Dep. Down.

**A stale LLDP row is not good enough to draw an edge from.** An LLDP neighbour
is kept for 48 hours so the System tab's Neighbor column does not flap on a
missed advertisement — but the dependency recompute filters those rows to
roughly 6 hours first.

The bound is tight because the failure directions are asymmetric: a **spurious**
parent breaks suppression outright under all-down semantics (an extra parent
that is up keeps the child alerting as plain Down when its real upstream dies),
while a **missing** LLDP parent is usually covered by the same asset's
controller and interface edges.

**The gate's own managed inventory bounds the graph.** Discovery asks each
FortiGate for the switches and APs it manages and stamps the answer on the gate;
any adjacency that roster contradicts is dropped, in both directions.

It is **tri-state**: absent means *unknown* and constrains nothing; an empty list
means *manages none*; a populated list constrains. The stamp is written **only
when the roster read answered** — blur that distinction and a failed read reads
as "manages nothing" and a gate silently loses its subtree.

Membership can only **reject** an edge, never assert one.

**Wireless attachments override the controller signal.** A mesh-leaf AP depends
on its root AP, not on its controller. A FortiLink switch bridged behind a
FortiAP depends on the AP.

**Parent resolution never matches a FortiGate by hostname.** It goes through the
shared parent-key resolver, because `controllerFortigate` holds FortiManager's
*device name* and "no parent" is a legitimate state — so the mismatch fails
silently, in exactly the invisible-but-total way described above.

---

## Seeing the tree

The asset's **General** tab renders the dependency tree for **every** asset
type. An endpoint sees its own dependency as the **parent row above it** — that
is the only surface where an endpoint edge is displayed.

The downward view (children and grandchildren) is deliberately **infra-only**
and capped. Endpoints *are* real children of the switch, AP or gate that last
saw them, but listing them buries the infra chain the tree exists to show — and
a site gate is the last-seen device for the entire site.

---

## Testing it

Pick a live FortiGate, drive its `monitorStatus` to `down`, and wait one
reconciler tick (≤ 60 s). The child switches and APs should flip to Dep. Down
and emit `monitor.dependency_suppressed`.

There is also an **outage simulation** for testing dependency behaviour without
a real outage. It is gated at `assetMonitorSettings:fullwrite` — the admin-only
level — because it stamps a field that **can mask a real outage**.
