# Business rule 120 — full narrative

> Written 2026-10-14 as its own file (one file per rule from 78 on). Rule numbers are a
> stable citation key — never renumber. 81 is a deliberate gap.

Each rule records the decision *and the incident or constraint that forced it*. The invariant is in `invariants-30-43.md`; rule numbers are a stable citation key — never renumber.

- [Rule 120](#rule-120) — A quiet time can name the readers it does not apply to; who is held is decided per address, and nobody is told less than the quiet time promised them

<a id="rule-120"></a>

## Rule 120 — A quiet time can name the readers it does not apply to; who is held is decided per address, and nobody is told less than the quiet time promised them

### The request

Quiet time (rule 92) is decided per ALERT: `resolveQuietHold` answers once, `executeActions`
writes every notify row `held`, and the escalation sweep skips whole reminder and tier
passes. The operator asked (2026-10-14) for named addresses that ignore a quiet time — the
on-call phone that must page at 03:00 while the rest of the team sleeps — configured from a
button that opens a modal, on BOTH surfaces that edit a policy: the global quiet-time
wizard and an automation's **Override Global Quiet Time**. Both render the shared
`public/js/quiet-time-editor.js`, so the button lives there once.

### The decisions (asked 2026-10-14)

1. **A recipient's settings are its own per-severity held kinds** (alerts / alertReminders /
   escalations / escalationReminders) under the POLICY's windows and summary time. All
   unticked = ignores the quiet time entirely, the default for a new row. An exception may
   also be STRICTER than the policy — which is why the window opens a hold when ANYONE is
   held (`quietHoldsSendAny`) and who is actually held is per address (`QuietHold.isHeldFor`
   → `quietHoldsSendFor`).
2. **Stored per policy**, inside the existing quiet JSON (`recipients` on
   `quietTimeConfigSchema`, ≤ 50, unique after trim + lower-case) — no migration. A
   global schedule's list and an automation's own list never combine, because an automation
   with its own quiet time is exempt from every global one (rule 92).
3. **The summary lists only what was held for that reader**; a fully exempt address gets no
   summary and no all-quiet email. The outstanding list already worked that way —
   `recipientsFromHeldRows` reads `held` rows, and an exempt reader has none — so only the
   all-quiet audience needed the `quietRecipientFullyExempt` filter.
4. **A split reminder / escalation pass**: the excepted readers get it live; the held
   readers get a catch-up copy when the window ends.

### Why the send splits — and why that is not a rule 25 violation

Rule 25 says nothing about a reader splits a send. Its reason is that two messages to one
audience read as Polaris mailing each reader separately and break the shared To line and
the `{email.recipients}` footer. Quiet time is a different axis: it decides WHETHER and
WHEN a reader is told, not what their copy says. So the partition is the one split rule 25
leaves standing — and it is bounded the same way: everyone who receives the email at a given
moment receives ONE message together. The held half is either never sent (a fire, which the
summary reports) or sent at a different moment (a deferred reminder). The footer
(`alertPushRecipientsService.buildRecipientBlocks`) reads only rows that reached someone —
`held` / `deferred` / `superseded` are excluded — so a live reader is never shown the names
the window kept the alert from.

### The new delivery states

A held FIRE row stays `held`: it is the record the summary reads. A held REMINDER or TIER
copy could not be `held` too — the summary would then list follow-ups as alerts, and the
fallback / footer logic treats `held` as "the record of who was kept from the alert". So
those are `deferred`: a send OWED at `meta.quietHold.windowEnd`.
`quietTimeSummaryService.releaseHeldFollowUps` (run at the top of every summary tick)
releases them — per (notification, channel, transport, target) only the NEWEST goes back to
`pending`, the older copies become `superseded`, and every copy of an alert that cleared or
was acknowledged meanwhile is `superseded`. Rule 44's "held, never dropped" therefore holds
per reader: a reader owed eight overnight reminders gets one, the latest, not eight.

The released copy's body was composed when it was deferred, so its age ("ACTIVE 7h") is the
age at that pass, not at release. Recomposing at release would need the full fan-out context
the sweep had; the newest copy is at most one reminder interval stale.

### The pass still counts

In a split pass the sweep does not `continue`: it runs `executeActions` with
`exec.quietHold`, and because the excepted readers were told on time the pass advances
`escalationState` like any sent pass. No `quietHeldSince` is stamped and no
`notification.reminders_paused` Event is written for it. If the exceptions are not in this
automation's audience at all, every row of the pass is `deferred` — the readers still get
the newest copy at the window's end, the same outcome as the unsplit hold.

### The fire and the all-clear

`executeActions` defers the `quietHeldAt` stamp for a split hold until the fan-out reports
(`expandDeliveries` `stats`) whether any row was held: an alert that reached every reader
live owes no summary and must not wear the QUIET pill. The `notification.quiet_held` Event
names the live count. The all-clear of a held, unsummarised alert is dropped (rule 92) only
when NO row of it ever went out; otherwise `heldFireAudience` builds the readers a held fire
row named who no live row has reached since, and the all-clear goes to everyone else
(`excludeRecipients`). Chat rows have no reader: a chat send held at fire and never live is
skipped.

A policy with no `recipients` is not split (`QuietHold.split` false): every path above is the
rule-92 path, byte for byte.

Pinned by `tests/unit/quietTimeRecipientExceptions.test.ts` (schema, per-address answer,
stricter exception, release), `tests/unit/quietTimeHoldAtFire.test.ts` (partitioned To line,
stamping, all-clear audience), `tests/unit/notificationRepeat.test.ts` (split pass advances
and defers), `tests/unit/alertFooterSendScope.test.ts` (footer excludes held readers) and
`tests/unit/quietTimeRecipientsDom.test.ts` (the modal round trip).
