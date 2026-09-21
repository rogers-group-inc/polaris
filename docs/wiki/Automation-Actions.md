# Automation actions and recipients

Step 5 of the wizard. What happens when the automation fires, and who hears
about it.

---

## The in-app alert is not an action

The step is led by a mandatory card: **"Create an in-app alert (always
happens)"**. It cannot be removed, because every delivery row hangs off the
alert's id, as do the escalation sweep, acknowledge, clear and the rule state
machine.

The card hosts the **alert / event message template** and nothing else.

> The **audit Event** is separate and *is* removable — a "Create an Event"
> action row, present by default, with no config. It is a no-op on event and
> change triggers, and flagged as such: an automation that wrote an Event on an
> event trigger would feed its own trigger.

---

## Action types

| Type | Does |
|---|---|
| **notify** | send through one or more delivery channels to a recipient list |
| **api_call** | HTTP request to a URL you supply |
| **script** | run a [registry script](Automation-Scripts) on the server or on the triggering asset |
| **event** | write the `notification.triggered` audit Event |

### `api_call`

| Field | Limits |
|---|---|
| Method | GET / POST / PUT / PATCH / DELETE (default POST) |
| URL | http(s) only, ≤ 2000 chars |
| Headers | ≤ 20, names 1–100 chars, values ≤ 1000 |
| Body template | ≤ 10 000 chars, `{token}` vocabulary |
| Timeout | 1–60 s, default 15 |

> **Headers are stored unmasked by design** — a bearer token you put here is
> readable in the code editor. It is also why **export drops `api_call` actions
> entirely**: an exported file is something operators email and commit.

### `script`

| Field | |
|---|---|
| Script | from the registry |
| Run on | `server` or `agent` |
| Args template | ≤ 2000 chars, `{token}` vocabulary |
| Timeout | 1–600 s, overrides the script's own default |

Attaching one needs `automationScripts:fullwrite`. See
[Automation scripts](Automation-Scripts) — it is an RCE-equivalent surface and
the page says what that means.

---

## Notify: choosing channels

An action's `channelIds` can carry **several channels behind one recipient
list** — "page this person by email *and* push" is one action.

If the group offers **both** email and push, you can additionally tick
**"deliver through each recipient's own preference"**. Polaris then routes each
recipient through the channel *they* chose ([rule 39](Business-Rules#rule-39)).

Three limits on that, each with a reason:

- It is consulted **only when the group actually offers both methods**. In a
  single-method group the preference would *delete* the alert rather than route
  it, so the checkbox greys out.
- **Only accounts are filtered.** A typed address or an address-book contact
  expressed no preference — unknown means deliver.
- **A preference never deletes an alert.** Someone who prefers push but has no
  enrolled device still gets the email. Reachability means *the subscription
  exists* — a 201 from a push service is not delivery, and a dead endpoint only
  surfaces at send time, where it is re-routed to the action's own email
  channel.

---

## Notify: recipients

On an **email** channel: **To / Cc / Bcc** token fields. On **Web Push**: one To
box of the same pills, and no Cc/Bcc — a push is delivered per endpoint, so a
"copy" is just another recipient.

Type to search. The typeahead merges two halves: **dynamic entries, roles and
map regions resolve locally** and paint on the first keystroke, then users,
contacts and directory hits are appended from a debounced search. So the local
half still works for someone without `contacts:read`, and never waits on a round
trip.

Enter or comma commits a pill, Backspace on an empty input removes the last one,
and a pill **drags between the three fields**.

### The pill kinds

| Kind | Reaches | Fields |
|---|---|---|
| **Address** | that mailbox | To / Cc / Bcc — **email only** |
| **User** | that account | any |
| **Contact** | that address-book entry | any |
| **Role** | every user holding that role | any — *stored as role **IDs**, so a rename never silently reroutes an alert* |
| **Region** | every user tagged with that map region | any |
| **Asset's Region Users** | the triggering device's regions, any level | **To only** |
| **Asset's L\<n\> Region Users** | the device's region at that **asset-relative level** | To only |
| **Asset's Responsible Contacts** | the contacts whose device filter matches | To only, **email only** |

The two dynamic kinds name no address but a **rule for finding one from the
triggering device**. They are To-only because the wire shape has no per-field
slot for them, and a Cc drop would look like it worked and send to nobody — the
drag shows no drop cue for a field that would refuse it.

A deleted role or an unknown level survives as a **flagged unknown pill** rather
than vanishing on the next save.

### Level-scoped region routing

`Asset's L1 Region Users` reaches the device's own **innermost** region; L2 the
division containing it, walked outward along the containment edges. This is what
lets one automation notify the local team on the trigger and the division on the
escalation.

Level entries are offered **only once something is actually nested** — on a flat
catalogue "L1" is a synonym for the all-levels entry, and offering it would
invite a rule that quietly changes meaning the day someone draws a containing
polygon.

> **An orphaned region tag makes level routing abstain entirely**
> ([rule 58](Business-Rules#rule-58)). A `region:` tag naming no current region
> cannot be placed in the containment forest — and dropping it from the seed
> would *promote its container to L1*, so the automation pages the division
> while the site's own people hear nothing. It is undetectable from every
> surface an operator has: the stale tag still renders, the automation stays
> enabled, the email still sends, only the tier is wrong. So Polaris returns
> **no levels at all** and logs which tag stranded it. Abstention is scoped to
> the level arm alone — every other recipient arm on the same action still
> resolves, so the alert is never lost.

### Broadcast toggles (Web Push only)

**Send to All Users** and **Send to All User Regions**, both checked by default
on a *new* action. A **stored** action reflects what was saved, so an old rule
listing three people cannot silently become fleet-wide on the next edit.

Both are rejected at save on any other channel type — they are broadcasts, and
the builder offers them nowhere else.

### What the field tells you

- Each suggested account is **badged with its push device count**, and the
  warning under the field names the unreachable ones, recomputed on every edit.
  Push is opt-in per browser, so a named user with no enrolled device is a
  recipient that silently receives nothing.
- A typed address not already in the book gets a **"save to address book"**
  affordance.
- **A Cc/Bcc-only action is rejected** — an action whose resolved To list is
  empty is skipped at delivery, so it would look configured and never send.

---

## Customising the email

**"Customize the email"** is a **checkbox, not a disclosure**. The question is
whether this action sends the default alert email or a bespoke one.

Unchecked stores **no templates at all**, so the action keeps tracking the
shared default *including later changes to it*, instead of freezing a copy. The
fields stay prefilled from that default so ticking the box shows the real text
to edit; un-ticking clears nothing, it just stops collecting.

**Body is one editor with a Plain text / HTML view switch.** Both bodies are
stored and both are sent — a mail client picks the part it renders — so the
toggle only chooses what is on screen.

### Template tokens

Available in the message template, the email subject and body, the `api_call`
body, and a script's args:

**The alert**
`{asset}` `{metric}` `{value}` `{threshold}` `{dimension}` `{dimension.label}`
`{dimension.suffix}` `{conditions}` `{message}` `{severity}` `{severity.upper}`
`{severity.color}` `{time}` `{time.local}` `{time.zone}` `{link}`

`{dimension}` is the part of the device the alert is about — the port, the
sensor, the mount, the tunnel. `{dimension.label}` is what that part is CALLED
("Interface", "Sensor", "IPsec tunnel"), so a template can label it rather than
printing a bare port name, and `{dimension.suffix}` is the same value carrying
its own separator (" · port12") for appending to a subject line. All three are
blank on an alert about a whole device, and the default email prunes the row and
the subject fragment away when they are.

**The automation**
`{rule}` `{rule.description}` `{trigger.summary}`

**The event** (event triggers)
`{event.action}` `{event.level}` `{event.resource}` `{event.resourceType}`
`{event.actor}` `{event.message}`

**The device**
`{asset.ip}` `{asset.mac}` `{asset.type}` `{asset.status}` `{asset.location}`
`{asset.description}` `{asset.manufacturer}` `{asset.model}` `{asset.serial}`
`{asset.os}` `{asset.osVersion}` `{asset.department}` `{asset.assignedTo}`
`{asset.tags}` `{asset.connectedSwitch}` `{asset.connectedAp}` `{asset.link}`

**Follow-up**
`{escalation.tier}` `{escalation.elapsed}` `{escalation.policy}`
`{repeat.attempt}` `{repeat.elapsed}` `{repeat.quiet}` `{repeat.policy}`

**Who else knows**
`{push.recipients}` `{email.recipients}`

A token palette is visible in both view modes.

> **One email, one To line, one clock.** Everyone a notify action names
> receives the *same* message, with each other's addresses visible on it — an
> alert is a thing a team handles together, and a private copy hides who else
> is already on it. Two consequences follow. Times are rendered in the
> **Polaris server's** timezone rather than each reader's, so `{time.zone}`
> ("CDT (America/Chicago)") rides the default footer and every timestamp
> carries its abbreviation. And the **Acknowledge** button goes to everyone,
> including a reader whose role cannot acknowledge — they are told so on the
> acknowledge page rather than by quietly receiving a different email.
>
> A user's own timezone setting (account menu → Timezone) still governs every
> time *in the Polaris UI*; it no longer changes what an alert email says.

> **`{email.recipients}` never names a Bcc** ([rule 60](Business-Rules#rule-60)).
> A blind copy that appears in a footer every recipient reads has stopped being
> blind. It is safe only because the delivery row's `target` field carries the
> To line and only the To line. Cc *is* named, being visible to everyone on that
> copy already.
>
> Both recipient tokens scope to the **send**, not to the whole alert. A send is
> one dispatch of the automation's actions — the first alert, one reminder, or
> one escalation tier — so a reminder's footer names that reminder's recipients
> and never the people on a tier that has fired. That send is still wider than
> any one copy of it, which is why the tokens earn their place: a second notify
> action in the same dispatch mails its own list, a Cc rider is a reader the To
> line does not name, and the push half names people the email never reached at
> all.
>
> They were alert-wide until September 2026. A footer that named everyone the
> alert had *ever* reached was read — reasonably — as naming everyone on the
> message in front of you, so a reminder that arrived after an escalation
> looked as though it had gone to the escalation's recipients.

---

## Acknowledgement

An alert can be acknowledged from all three places you might read it: in-app,
from the email, and from a push notification ([rule 25](Business-Rules#rule-25)).

Email and push carry the **same URL** — `/alert-ack.html?id=<notificationId>` —
naming the alert and nothing else. The page behind it is an ordinary logged-in
Polaris page, so an unauthenticated reader signs in first and is returned to the
alert. **Identity comes from that session**, not from the link.

What follows from that:

- **The email is one message, and nothing splits it.** A shared body carries a
  link that works for whoever reads it, so everyone a notify action names is on
  one To line — not their timezone and not their permissions.
- **Everyone gets the button**, whether or not Polaris knows them. An
  address-book contact or a typed address has no account behind it; a reader
  whose role holds `alerts` below `write` does. Both click through, and
  permission is decided at the page — which tells a reader who cannot
  acknowledge exactly that, rather than quietly mailing them a different email.
- **Web push is the exception**, and only because a push is addressed to one
  browser: a role that cannot acknowledge gets no Acknowledge tray action, which
  costs nobody a shared To line.
- **Loading is a GET and acknowledging is a POST**, so a mail gateway
  prefetching every link — Safe Links, Proofpoint — cannot acknowledge
  anything.
- **A push Acknowledge action opens the page** rather than acting from the tray.
  That is where the note is typed, and the session is what records who did it.
- **An alert that is over carries no button at all.** Every all-clear — reset
  actions, a band's resolved actions, an operator clear — blanks it. It is the
  one question the reader cannot answer.

### Requiring a note

**"Require a note when acknowledging"** lives at the foot of each **severity
section**, not on the rule ([rule 56](Business-Rules#rule-56)). What closing an
alert out costs is a property of the alert record, and a `notice` and a
`critical` do not deserve the same answer.

The base section's block is the rule-level flag; each band's is that band's own,
seeded from the rule's so ticking "use different actions per severity" changes
nothing by itself.

The requirement is enforced **in the service, not in any dialog**, so every
surface obeys it — and a batch acknowledge is refused whole.

### Push notification tray actions

A push carries **at most two** action buttons (the platform limit), listed in
priority order and sliced from the end:

1. **Acknowledge** — the only one that changes state.
2. **Open device** — the alert's own device page; absent on an alert with no
   asset. Deliberately *not* the body tap's destination, which is the alerts
   list.
3. **Ignore** — offered only on an alert that requires interaction. It closes
   the toast and **sends nothing**: a tray button carries no session, so it
   cannot mean "handled". The alert keeps repeating and escalating.

iOS and Safari render no action buttons at all, so the body tap remains the path
there.

---

## Per-severity actions

With severity bands, per-tier actions are **opt-in** behind a *"Use different
actions for each severity level"* checkbox.

- **Off** (the default, and what a stored rule shows unless some band actually
  carries its own): one action list runs at every severity.
- **On**: one accent-coloured actions section per tier, base included.

Toggling re-renders from the draft and the draft keeps per-tier rows either
way, so an accidental un-tick does not destroy typed actions before save.

### Recovery is announced once

The band-level **Resolved** control was retired. Recovery is announced by the
rule's **reset actions** — which every automation has, banded or not — and
running both told people twice.

What the old policy announced is adopted into the reset actions **when they are
empty**; an operator who already wrote reset actions is left alone.

---

## Reading the collapsed step

A per-severity ladder is three or four action lists deep, each row carrying a
channel picker, To/Cc/Bcc, an email body and an escalation footer. So:

- **Action rows fold, closed by default.** The row's summary line already says
  what it does, which makes it the collapsed state. A row you *add* opens — you
  do not create an action to read its summary.
- **Every severity section folds**, and a folded block keeps a summary line, so
  "no actions of its own" (which falls back to the base actions) is visible
  without unfolding.
- A collapsed Notify row **names who it reaches** — *"Notify via Email — L2
  region users"* — because the pairing this feature exists for is two notify
  actions on the same channel, and they read identically otherwise.
