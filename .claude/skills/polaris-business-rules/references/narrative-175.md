# Business rule 175 — full narrative

> Written 2026-11-12 as its own file (one file per rule from 78 on). Rule numbers are a
> stable citation key — never renumber. 81 is a deliberate gap.

Each rule records the decision *and the incident or constraint that forced it*. The invariant is in `invariants-30-43.md`; rule numbers are a stable citation key — never renumber.

- [Rule 175](#rule-175) — A reservation that expires ends the way a released one does

## Rule 175 — A reservation that expires ends the way a released one does

**How it was found.** The 2026-11-11 orphan audit (E.10, E.11). A reservation can end two ways: an operator releases it, or its `expiresAt` passes and the 15-minute `expireReservations` job flips it to `expired`. `releaseReservation` does a good deal on the way out. The expiry was one `updateMany`. Two things a release does were therefore never done for a reservation that simply ran out:

- **The network stayed reserved** (E.11). Reserving a whole network (a reservation with no address) sets `Subnet.status = "reserved"`; releasing it sets the network back to `available`. When the reservation lapsed instead, the network stayed `reserved` with nothing holding it — out of allocation until someone noticed and edited its status by hand.
- **The device entry stayed on the gate** (E.10). A reservation pushed to a FortiGate is a reserved-address in that gate's DHCP scope. A release deletes it. An expiry left it: the gate went on pinning the address to the MAC, and the next discovery read the entry back as a `dhcp_reservation` — a reservation nobody had made, standing where the operator's expired one had been.

**The decision.** An expiry is the reservation ending; the operator who set an expiry date asked, in advance, for exactly what a release does. So the expiry does those two things too.

**What it does.**

- In `expireStaleReservations`' transaction, the networks held by lapsing whole-network reservations are read before the flip and set back to `available` after it, guarded twice: only where the status is still `reserved`, and only where no other active whole-network reservation remains.
- `unpushExpiredReservations`, called by the job after the flip, works from the rows themselves rather than from the batch that just lapsed: every `expired` row that still carries pinned push ids. That is what makes it retryable with no extra state — a gate that was down when the row lapsed is tried again on the next tick. A success clears the pointers; a failure counts on `pushAttempts` (reset to zero at the moment of expiry, because the push's own history is about a different operation). After `EXPIRED_UNPUSH_MAX_ATTEMPTS` (12, about three hours) Polaris stops, writes one warning Event naming the gate, scope and entry, and leaves the pointers on the row as the record of what is still there.

**What it does not do.** It removes only what Polaris pushed (pinned ids) — the line a release draws for "clean up what Polaris created", which holds whatever the DHCP Push toggle says now. A discovered `dhcp_reservation` does not expire through this path at all. It does not revoke the client's lease, which a release does: an operator releasing an address means "free it now", a date passing does not, and knocking a live client off its address on a timer is not something an expiry date asked for. A row whose integration has since been deleted (`pushedToId` set null) drops out of the retry by itself.

**Scale.** The transaction gains one small read and at most two set-based writes. The un-push is bounded per tick (50 rows, five device calls in flight) and reads through the `status` index; on an install that pushes nothing it is one query returning no rows.

Pinned by `tests/integration/reservationExpiry.test.ts`.

### Rule 175(a) — the networks already stranded are listed, not changed

**Operator decision, 2026-11-13.** Rule 175 stops a lapsed whole-network reservation from leaving its network `reserved`. Networks it had already stranded before that shipped could not simply be set back to `available`, because the same state — `reserved`, with no whole-network reservation — is also what an operator gets by marking a network reserved by hand on purpose. Asked whether to list them, the operator said to list them.

**What it does.** The daily history prune finds every network marked `reserved` that no active whole-network reservation holds and writes one warning Event per network, worded so that "reserved on purpose" needs no action. It keeps the ids it has named in a Setting, so the list is not repeated every day; a network that stops qualifying (a reservation holds it again, or its status changed) is dropped from that memory, and is named again if it is ever stranded again.

Pinned by the "rule 175(a)" case in `tests/integration/historyRetention.test.ts`.
