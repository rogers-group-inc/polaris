# Business rule 122 — full narrative

> Written 2026-10-16 as its own file (one file per rule from 78 on). Rule numbers are a
> stable citation key — never renumber. 81 is a deliberate gap.

Each rule records the decision *and the incident or constraint that forced it*. The invariant is in `invariants-30-43.md`; rule numbers are a stable citation key — never renumber.

- [Rule 122](#rule-122) — A group firmware upgrade is one controlling FortiGate's fleet, flashed deepest first, and a parent is flashed only after everything behind it ended clean — a failure holds back only what is upstream of it, an unhealthy device is skipped and never holds anything back

<a id="rule-122"></a>

## Rule 122 — A group firmware upgrade is one controlling FortiGate's fleet, flashed deepest first, and a parent is flashed only after everything behind it ended clean — a failure holds back only what is upstream of it, an unhealthy device is skipped and never holds anything back

**The ask.** Rules 87 and 93 flash one device at a time, now or booked. The operator
wanted to tick a site's FortiGate, switches and APs on the Assets page, press
**Upgrade** once, book it for the maintenance window, and have Polaris do what the
operator's own CLI tool (`fortinet-updater`, a separate repo) already does: upgrade in
dependency order. Four further requirements came with it: only devices from the same
source together; one group per source at a time; warn that booking a group cancels a
device's own pending booking; and a device that is already current or has no image is
simply dropped from the schedule.

**What "same source" means.** Asked directly, the operator chose **one controlling
FortiGate** over "one integration" or "FortiGates only": a group is a gate and the
FortiSwitches / FortiAPs behind it. That makes "one group per source" one per gate —
the unit a maintenance window is booked for, and the unit whose ordering is
well-defined (two gates share no dependency chain). A switch / AP resolves to its gate
through `utils/fortinetParentKey.ts → controllerGateIdOf` (the controller stamp), then
the dependency tree's first firewall — never a hostname match (the parent-key
convention in CLAUDE.md). A device discovered by a different integration than its gate
is not placed: two integrations describing one fleet is a configuration the plan cannot
reason about safely.

**The ordering, taken from fortinet-updater.** Its topology and scheduler modules,
re-derived here as pure functions (`pickNext`, `subtreeState`, `conflicts`):

- **Deepest first** — depth is the longest path to the gate, so a dual-homed device
  sorts below both its uplinks; ties by name.
- **Never beside a relative** — not while an ancestor, a descendant or an MCLAG peer is
  flashing. Parallelism (the operator's `concurrency`, 1–10, default 1) only ever
  happens across independent branches.
- **A parent only after clean children** — every planned member behind it ended
  `upgraded`, `already-current`, `dropped`, or skipped for health. Anything else
  behind it — failed, unverified, skipped as upstream, timed out, cancelled — skips it
  as `subtree`, and nothing is sent to it. A failed AP leaves its switch and gate on the
  old firmware rather than rebooting the path to a device that may need hands.
- **A failure is local** — the group does not abort; independent branches carry on. The
  operator chose this over "stop the whole group".

**Health: skip and move on, and never hold the uplink back.** A follow-up from the
operator: "if the health of the asset doesn't look good, then skip that device and move
to the next". `healthBlockers` (the rule-87 health gate: down / warning / recovering /
dependency-suppressed / unmonitorable / no address) is taken live just before each
device starts; an unhealthy device is `skipped` / `health`, the same pass starts the next
one, and — deliberately, matching fortinet-updater's `excludeHealth` — a health skip does
NOT hold back its ancestors. An AP that has been down for a week must not keep its
switch and gate on old firmware forever; it was never touched, so there is nothing
upstream to protect.

**Why health is a warning at booking, not a drop.** Same reasoning as rule 93: a switch
that is down at 3 pm may be fine at 2 am. Dropping is reserved for what cannot change by
the booked time without someone acting — already current, no image, HA member, no
address, no login bound.

**Approved by name, at booking.** Each included member stores the image it was planned
with. When it starts, `assessGroupCandidate` runs again: a device upgraded since is
recorded `already-current`; a different primary now (someone uploaded a newer image)
DROPS the member with the reason rather than flashing an image nobody approved for this
booking (rule 87's "never an unapproved image"). A group never offers the backup image.

**Supersession, confirmed.** A member with its own pending booking would race the
group's ordering. The dialog lists those bookings with their own acknowledgement box;
the server refuses with 409 unless `cancelIndividual: true`, then cancels them in the
same transaction that creates the group (each with a `firmware.upgrade_schedule_cancelled`
Event saying "superseded"). While the group stands, `assertNotInGroup` refuses a
single-device booking or change on a member; while it RUNS, `startFirmwareUpgrade`
refuses a click on a member (a pending group still allows Upgrade Now — the group's own
re-check then records it already current).

**Execution is state in the database.** `advanceGroup` is one pass: record runs that
ended, skip parents whose subtree did not end clean, start what may start. It runs from
the 60 s `startScheduledFirmwareUpgrades` job (web role, beside the image on disk) and
immediately after each member's run ends (`runUpgrade`'s `finally`, lazily imported),
guarded per group so two passes never overlap. A restart loses nothing: the boot sweep
fails an orphaned run, the next pass reads it. Each flash is an ordinary rule-87
`FirmwareUpgradeRun` via `startFirmwareUpgrade` with `groupMemberId`, so every gate,
the maintenance hold (rule 80) and every per-device Event still apply. A
`FirmwareRunConflictError` (a related flash outside the group) makes the member
`waiting`, for up to `CONFLICT_WAIT_MS` from when it first became eligible, then
`skipped` / `timeout`.

**The summary email.** One per group (`notifiedAt` claimed first), to the booking's
recipients, each in their own zone — when it completes, when it is missed (more than
`LATE_GRACE_MS` late), or when it is stopped after it started. Problems first: failed
with the stage it stopped at, unverified, skipped for health with what was wrong, skipped
upstream naming the device behind that did not end clean; then upgraded with from → to,
already current and dropped with why. Per-member runs send no email of their own.

**The red button.** The bulk bar's Upgrade button asks `POST /assets/firmware-groups/sources`
(assets:read, one asset read + one infra read + the level-by-level parent walk, no image
or credential work) whenever the selection changes, debounced. More than one source, or
a device it cannot place, turns it red; a red click explains instead of booking and
offers **Keep only these** per gate. It is guidance — `planGroup` refuses the same
selections with 400.

**Scale.** The parent walk is one `asset_dependency_parents` query per LEVEL (≤ 16), not
`resolveConnectionPath` per device; the infra read is one tight select; assessment runs
in parallel chunks of 10; a selection is capped at 500 (the bulk cap maintenance uses).
A pass reads the group's members once and starts at most `concurrency` runs.

**Known limit.** A FortiGate-managed FortiAP usually has its local web UI turned off, so
the direct `fortiap-https` engine fails on it (rule 87's engine note) — and a failed AP
skips its switch and gate. The plan warns on every AP no run has ever flashed.

**Rejected.** Group scope by integration (several gates' fleets in one group — ordering
across gates is meaningless and one maintenance window rarely covers them);
FortiGates-only groups (the operator wanted the fleet); stopping the whole group on the
first failure; dropping unhealthy devices at booking.
