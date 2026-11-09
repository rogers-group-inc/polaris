# Business rule 145 — full narrative

> Written 2026-11-09 as its own file (one file per rule from 78 on). Rule numbers are a
> stable citation key — never renumber. 81 is a deliberate gap.

Each rule records the decision *and the incident or constraint that forced it*. The invariant is in `invariants-30-43.md`; rule numbers are a stable citation key — never renumber.

- [Rule 145](#rule-145) — A reset answers for the action that raised it, and an escalation reset reaches only the tiers that sent

<a id="rule-145"></a>

## Rule 145 — A reset answers for the action that raised it, and an escalation reset reaches only the tiers that sent

**The request (2026-11-09).** On Automations → Actions, an operator asked for three things:

1. A reset Notify added beside a trigger Notify should default to **matching the trigger
   action's configuration**, with the channels, To / Cc / Bcc and the checkboxes under them
   hidden, and a **Customize** switch that shows them, pre-filled with what the trigger action
   has. With several trigger Notify actions, the operator picks which one the reset is for.
2. When the trigger's notification escalates, the reset should offer to **reset the escalation
   too** — matching the escalation's own Notify or customized — but only send it **if the alert
   actually reached the escalation**.
3. An alert that crosses into an escalation tier should **create an Event**, and the alert on the
   widgets should carry an **escalation pill**.

**What was there.** The reset list already "mirrored" the trigger's Notify actions, but only in
the browser: `mirroredResetActions` copied each trigger Notify into the reset list as the trigger
list was built, marked the copy `_mirrorOf` (the channel-list key), and stripped the mark at save.
The server stored a plain copy. So "matching" lasted only as long as the wizard was open: an edit
to the trigger Notify's recipients after the save never reached its reset, and a re-opened
automation had to guess which reset rows were still copies (`reattachResetMirrors`, comparing JSON)
and keep a draft-only opt-out list so the first change on the trigger list did not mirror every
Notify in again (an earlier bug saved one more duplicate per edit). The escalation sweep wrote
ONE aggregate Event per tick — "Escalation: N tier run(s) executed for M unhandled
notification(s)" — attached to no alert and no device, and nothing on any alert surface said an
alert had escalated.

**Decisions.**

- **A link, not a copy.** A trigger Notify carries a stable client-generated `id` (actions are
  positional — removing one shifts the rest — so an index cannot name one across edits). A reset
  Notify names it by `matchActionId`. The SERVER resolves the link at reset time
  (`expandResetActions`), so the reset follows the trigger action as it stands then, and the
  wizard needs no bookkeeping to stay honest. The stored channel / recipient fields remain on the
  row as a snapshot, refreshed at every save (`refreshMatchedResetSnapshots`), because several
  readers never resolve links — the Automations list's Addresses column, Test delivery, export —
  and because a link whose target is gone must still send something sensible (the copy). A
  dangling link is dropped at save, keeping the copy.
- **Customize keeps the link.** A customized row sends its own fields, but still says which
  trigger action it answers for, because that is what the escalation reset hangs off.
- **Rows come only from + Add Action** (the operator's choice when asked, over keeping the
  auto-copy as a matched row): adding a trigger Notify no longer adds anything to the reset list.
  A new reset Notify defaults to the first trigger Notify no other reset row answers for.
  Stored rows that are still exact copies of a trigger Notify are adopted as links once per
  draft; anything else is the operator's and opens customized.
- **Escalation is per severity, not per action** (since 2026-08), so "the trigger action includes
  an escalation" means "the severity this action runs at has a chain". A base action runs at the
  base severity and at every band with no actions of its own; a band action at its band. The
  toggle covers that whole chain (the operator's choice, over per-tier checkboxes), sends only to
  the tiers that sent for this alert, and each tier can be customized on its own, pre-filled from
  the tier's Notify actions.
- **"Reached" is a recorded fact, not an inference.** `escalationState` cannot answer it: the
  engine resets it on every band change, and a grouped alert re-opening resets it too. So the
  sweep records each tier's FIRST send in `Notification.escalationFired` (severity, chain key,
  tier index, time) and never clears it — the reset owes the people a tier told, whichever
  severity told them. Two severities that share one chain (a band without its own chain
  escalates on the base's) share its tiers: the override key and the de-duplication use the
  chain's OWNER severity (`levelChainOwner`), so tier 1 that sent at warning and again after a
  band change at critical gets one reset, not two.
- **One reset per tier.** Two reset actions that both ask for the escalation reset (two trigger
  Notify actions in one severity share its chain) send each tier once.
- **The Event is per alert.** `notification.escalated`, on the alert and its device, once per tier
  the first time it sends — the Events tab, the asset's history and an event automation can now see
  which alert went over whose head. A tier's repeat runs are reminders and write nothing. The
  action string is shared with the engine's per-alert severity-band increase; `details.kind:
  "tier"` tells them apart. Written in one batch per sweep, so 2000 escalating alerts are one
  insert.
- **The pill reads the highest tier reached** (`escalationTier`, 1-based), orange (the serious
  colour), "ESCALATED" with " T2"… beyond tier 1 — in the text, not just the hover, because the
  Active Alerts widget runs on wallboards that are never hovered. Same pill on the asset's Alerts
  tab, the phone's alert list and the acknowledge page (the operator asked for every alert
  surface).

**Rejected.**

- *Resolve the link in the browser and keep storing copies.* That is the mirror, and it is what
  made "matching" stop at the save.
- *A new action type (`notify_match`).* Every reader that branches on action type would need to
  learn it (the automation-action-types checklist); keeping `type: "notify"` with a snapshot lets
  every non-resolving reader keep working unchanged.
- *Inferring "the alert reached tier N" from `escalationState` or the alert's age.* The state is
  reset by design; the age says a tier was due, not that it sent (a tier whose recipients
  resolved empty retries and never counts).
- *Keeping the aggregate Event beside the per-alert one.* It named nothing and doubled the count.

### Rule 145 — the invariant as stated in full when written

See `invariants-30-43.md` § 145; it is the whole contract.
