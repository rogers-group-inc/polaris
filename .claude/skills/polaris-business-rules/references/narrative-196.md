# Business rule 196 — full narrative

<a id="rule-196"></a>

## Rule 196 — A dial-up template's In / Out is a running total of its sessions, and its Up is its longest-connected session

**The ask (2026-11-23, owner).** The IPsec tab's dial-up template rows (`IPsecRA_VPN`, `Overlay-1`, `Overlay-3`…) showed a dash under Up, In and Out. "Could the uptime column for these just use the longest uptime of a connected session? Could the in bytes and out bytes just be the aggregate data of the connected sessions? When a session ends, don't remove that data aggregation from the total though."

**Why the row was empty.** FortiOS reports a dial-up template as a phase-1 with no phase-2 selectors of its own; the counters and `creation_time` live on the children it spawns per connected peer (`Overlay-1_0`…). Those children are `AssetIpsecConnection` rows, delete-replaced per full pass, so a child's bytes vanish with the child.

**Up.** The earliest `connectedSince` among the template's current connections, FortiClient users included (they count in the row's "N connected" too). Computed at read time from rows already loaded; nothing stored.

**In / Out: a running total, not a sum of what is connected now.** A plain sum would drop every time a peer disconnected, which the owner ruled out. So the total is grown, never recomputed: on each full pass, each session adds what it moved since the previous pass. Continuity is the name-and-peer test `firstSeen` already uses (FortiOS reuses `<template>_<n>` slots, so a different peer in a slot is a new session). A new session counts its whole counter, as does one whose counter went backwards (its SA was re-established). An ended session adds nothing more, which is what keeps its bytes in.

**Where the total lives.** Its own current-state table, `AssetIpsecTemplateTotal`, keyed (asset, tunnel name). Folding it into `asset_ipsec_tunnel_samples` was rejected: the fast pinned pass writes the template's sample every minute from the device's own (empty) counters, so the template's history would alternate between two meanings, and sample rows live in compressed chunks that are never updated. A template renamed on the gate starts again from zero under its new name; the old row lingers until the asset is deleted (a handful of rows per gate).

**Limits, stated on the tab.** A session that comes and goes between two full passes (the system-info cadence, 10 minutes by default) is never seen. The cell's tooltip says when the total started counting and that it includes ended sessions. The first pass after the change seeds the total with what the connected sessions hold at that moment.

**Scale.** One upsert per template per gate per full pass, inside the transaction that already runs; one extra indexed read when the tab opens. Flat at 100 or 2000 assets.

**Rejected.**
- *Sum the connected sessions only.* Drops on every disconnect; the owner asked for the opposite.
- *Store the total in the tunnel sample stream.* The mixed-meaning chart above.
- *Recompute from the connection sample history.* Connections are current-state; there is no history to sum.
