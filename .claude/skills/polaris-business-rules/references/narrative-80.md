# Business rule 80 — full narrative

> Split out of `narrative-60-64.md` on 2026-09-21, which was back at the 1500-line
> reference-file ceiling. Same reasoning as `narrative-78.md`: rule numbers are a stable
> citation key and did not change; only the file holding this one did.

Verbatim from BUSINESS-RULES.md: each rule records the decision *and the incident or constraint that forced it*. The invariant is in `invariants-30-43.md`; rule numbers are a stable citation key — never renumber.

- [Rule 80](#rule-80) — Downtime Polaris itself causes is not an incident, and a silence it grants expires on its own

<a id="rule-80"></a>

## Rule 80 — Downtime Polaris itself causes is not an incident, and a silence it grants expires on its own

An operator upgrades the Polaris Agent across a fleet and gets paged by their own
maintenance. The chain is short and every link was working as designed: the installer stops the
agent service, the service stop drops the WebSocket, `detach()` writes `agent.disconnected` at
**warning** level, and the seeded baseline automation fires on exactly that action at exactly
that level. Nothing was broken. Polaris was alerting on work it had been told to do.

Nothing in the notification path could have known better. `startUpgrade` had already moved
`installStatus` to `"upgrading"` before any of it happened — but no trigger gate has ever read
that column, and there is no reason one should: "is this device mid-operation" is not a fact
about a notification rule.

**The lever that does exist is maintenance.** Event automations honour the same gate as
threshold ones — `assetCanTrigger` is `monitored && !maintenance && !dependencySuppressed`, and
event and change triggers stopped being the exception to it when the monitored gate widened
(business rule 37). An asset in maintenance is silent about everything, which is both why this
works and why it is scoped as tightly as it is below.

### A hold is a holder, not a window

The obvious implementation is the one that breaks in thirty seconds. `AssetMaintenanceWindow`
already allows a null `scheduleId`, so a hand-made open row looks like it would do — but open
windows are the reconcile's OUTPUT, and it closes any it cannot re-derive from a live holder
(`endReason: "deleted"`). The next tick would tear the hold down and the operator would be paged
anyway, now with a maintenance flap in the audit log as well.

So a hold is a `MaintenanceHold` row: the same kind of thing a schedule is, an INPUT the diff
runs against. That is not a technicality. Entering through the diff is what parks the status in
`maintenanceReturnStatus`, writes `maintenance.entered`, and sweeps the live alerts that a
window must not open on top of (business rule 16) — three behaviours that a bespoke path would
have had to reimplement and would have reimplemented differently.

### Which operations hold, and which deliberately do not

| Operation | Holds | Why |
|---|---|---|
| upgrade | yes | stops a running agent |
| reinstall | yes | stops a running agent |
| uninstall | yes | stops a running agent, permanently |
| first install | **no** | there is no agent to disconnect |
| `/retry` of a failed install | **no** | likewise — the host has no agent running |

The two exclusions matter as much as the inclusions. An install that is failing on a host is
telling the operator something true about that host, and a hold there would silence it.

### Release is on reattach, not on the installer returning

The obvious release point — the upgrade script exited, `installStatus` is back to `active` — is
too early by seconds. `detach()` runs when the socket dies, and the socket may not be noticed as
dead until a heartbeat cycle has passed: a 30-second ping and one missed pong. A hold released
when the script returned lets the disconnect land just outside its own window. So the release is
in `attach()`: the agent coming back is the first moment the asset is genuinely being watched
again, which is the only honest end for a silence.

An uninstall is the exception, because nothing is coming back from one — it ends when the
uninstall does. And every failure path releases immediately: an agent that is down because its
upgrade failed is a real problem, and the alert about it is the entire point.

### The expiry is the part that is not optional

A held asset is not monitored. If the release never runs — the process died between the binary
swap and the release, the host never came back — the asset stops being watched, indefinitely,
and nothing anywhere says so. That failure is strictly worse than the alert this rule exists to
suppress.

So the hold carries `expiresAt` (20 minutes for an upgrade or uninstall, 30 for a reinstall) and
the **reconcile** enforces it, not the code that took it. An expired hold is deleted on the next
tick whatever else happened, its window closes with `endReason: "expired"`, and a warning is
logged naming how many. The alert that was being suppressed then fires late rather than never.

The same reasoning puts the operator and the decommission sweep above a hold: both delete the
holder as well as closing the window, because a live hold would re-open it on the next tick and
make the operator's action look ignored.

### What a hold does not do

It does not appear on the Active Maintenance widget, which lists schedules — a fleet upgrade
would otherwise put every agent host on the wallboard for ninety seconds each. It shows where it
is actionable: the asset's own Maintenance tab names the operation and the cap it ends at, the
`maintenance.entered` / `maintenance.exited` events carry it, and the chart band draws it like
any other window.

And it does not narrow the silence to the disconnect. For the length of the operation the asset
is in maintenance, so a genuine failure that starts in that window is suppressed too, and a live
alert on the way in is retired by the rule 16 sweep. That is the cost of using the mechanism
that already exists, paid deliberately: the alternative — a per-event carve-out that only knows
about `agent.disconnected` — silences less, but only suppresses the one symptom somebody
happened to think of, and says nothing on the asset about why the device was quiet.
