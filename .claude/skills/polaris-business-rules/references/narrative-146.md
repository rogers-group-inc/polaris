# Business rule 146 — full narrative

> Written 2026-11-09 as its own file (one file per rule from 78 on). Rule numbers are a
> stable citation key — never renumber. 81 is a deliberate gap.

Each rule records the decision *and the incident or constraint that forced it*. The invariant is in `invariants-30-43.md`; rule numbers are a stable citation key — never renumber.

- [Rule 146](#rule-146) — An automation's alerts are always on the record: every fire, escalation and end writes an Event, and no setting turns that off

<a id="rule-146"></a>

## Rule 146 — An automation's alerts are always on the record: every fire, escalation and end writes an Event, and no setting turns that off

**The request (2026-11-09).** Reviewing the Actions step on a dev stack after rule 145 landed,
the operator asked to "remove create an event action — let's just make this inherent to
automations instead of something that the user sets. So each action, escalation, reset creates
an event in the background."

**What was there.** Since 2026-08 the `notification.triggered` audit Event was an ACTION
(`{ type: "event" }`): present by default (migration `20260810120000_event_action` added it to
every rule, and both normalizers re-injected it when folding a legacy shape forward), removable
"for a deliberately noisy automation", and flagged as a no-op on event / change triggers. The
other two moments of an alert's life never had a switch: the end writes
`notification.auto_cleared` / `notification.cleared` unconditionally, and rule 145 had just made
escalation a per-alert `notification.escalated`. So one of three records was optional, and the
optional one was the beginning. An automation whose Event row someone removed produced
escalation and clear Events about an alert whose firing the Events tab never showed — and the
row sat in every action list, the Test step offered a "Write a Test Event" button for it, and
export had to special-case it so an imported automation did not go silent.

**Decisions.**

- **The Event is the engine's, not the automation's.** Every threshold-path fire writes
  `notification.triggered`, grouped and ungrouped alike. "Each action" in the request is read as
  the fire — the moment the automation's actions run; the per-email record (`notification.email_sent`,
  rule 106) and the delivery rows already cover individual sends.
- **Event- and change-triggered automations keep their carve-out.** Their alerts are created by
  the event tail, which writes no Events by design: an automation raised BY Events that wrote one
  would feed its own trigger. The Event that set the alert off is its record.
- **Retired, not removed, from the schema.** Stored rules, exported files and API clients carry
  `{ type: "event" }`; refusing it would break every one of them on its next save. It is accepted,
  stripped from the lists that fire and reset on input (an emptied reset list is `null`, "no reset
  behaviour"), never injected, not offered by the builder, and a no-op if a stored rule still holds
  it. An escalation tier keeps one — a tier needs at least one action, and there it never did
  anything.
- **The wizard converges stored rules.** It strips the action from every list on open, dropping a
  tier that had nothing else; a new automation starts with empty action and reset lists. The
  in-app card's help says the Event happens on its own.

**Rejected.**

- *A data migration deleting the stored actions.* Inert data needs no migration, and every save
  converges the row anyway; a migration would rewrite every rule's JSON for no behaviour change.
- *Refusing the member in the schema.* See above — every exported file and API script would 400.
- *Writing a fire Event for event-triggered automations too.* That is the self-feeding loop the
  carve-out exists for.

### Rule 146 — the invariant as stated in full when written

See `invariants-30-43.md` § 146; it is the whole contract.
