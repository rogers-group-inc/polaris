# Automation actions and recipients

Step 5 of the wizard, laid out as a stack of cards: the **In-app Alert** every
fire creates, the two rows that describe that alert (**Require Acknowledgement**
and, on a down automation, **Dependency-Down Bypass**), then per severity the
**Trigger Action** list with its **+ Escalation Action** chain, and last the
**Reset Action** list. The two rows sit above the action list because they are
facts about the alert being raised rather than about what is sent, and they stay
visible when a severity's actions are folded away.

What happens when the automation fires, and who hears
about it.

---

## The in-app alert is not an action

The step is led by a mandatory card: **"Create an in-app alert (always
happens)"**. It cannot be removed, because every delivery row hangs off the
alert's id, as do the escalation sweep, acknowledge, clear and the rule state
machine.

The card hosts the **alert / event message template** and nothing else.

Under the template, an **Example** line shows the alert as the Alerts tab
would show it for one of the devices you selected — Polaris picks one at
random. Pick another from the drop-down beside it, or press **Random**. The
example follows your typing, and uses the device's current reading as
`{value}` (it shows `n/a` when the device has no reading for the trigger).
Hover over a chip under **Insert variable…** to see what that variable would
be for the example device. Variables marked "Filled in when the alert is
sent" — the acknowledge link, charts, recipients — only exist once a real
alert is delivered.

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

Attaching one needs `automationScripts:write`. See
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

### What the default email shows for an interface alert

An alert on an interface (oper status, admin status, IP address, PoE status,
error rate or throughput) is about **one port, not the device**. The device is
still answering, which is how Polaris knows the port is down, so its facts
describe a healthy device. The default email therefore leaves out the device
facts: IP address, connected switch and AP, location, model and description.

It keeps the device name, the **Interface** row, the **Managed by** row, the
automation and timing rows, and the LLDP neighbour that was last seen on the
port. **If the port has
an IP address configured, an Interface IP row shows it.** An access port, or
one at 0.0.0.0, shows nothing.

**Graphs depend on the kind of alert:**

- **Status alerts** (oper status, admin status, interface IP, PoE) drop the
  device graphs (CPU, memory, response time and packet loss). A WAN port that
  is an SD-WAN member gets the SD-WAN graphs instead: the last hour of
  latency, jitter and packet loss for that member, from the health checks
  probing through it, with the FortiGate's own SLA targets drawn as dashed
  lines. Any other port gets no graphs.
- **Error-rate and throughput alerts** keep the device graphs, because a port
  erroring or saturating can go with load on the device itself.

This applies to the **default** email only. If you tick **Customize the
email**, your body is sent exactly as written. A `{asset.ip}` you put in it
still prints.

### What the default email shows for a storage alert

A storage alert (used %, used bytes, or days until full) is about **one
filesystem**, so the email graphs that filesystem instead of the device's CPU,
memory, response time and packet loss. The device facts (IP address, location,
model and so on) stay, because which server is filling up is usually the
first thing you need.

- **Used % and used bytes** show the last hour of that filesystem's usage,
  with the automation's threshold as a dashed red line.
- **Days until full** shows a **forecast**:
  - Left of "now": the daily usage the forecast was worked out from, up to
    30 days of it.
  - Right of "now": that trend carried forward as a dashed line, to the
    grey **full** line. A red dot marks the projected full date.
  - How far forward it draws is **the automation's own number of days**. A
    "days until full is less than 7" automation draws 7 days ahead. The
    alert only fires when the full date falls inside that window, so the line
    normally reaches **full** on the graph.
  - The caption gives the current usage, the growth per day, and how many
    days until full. It is the same number the alert fired on.
  - If the filesystem has stopped growing by the time the email is sent (for
    example, on a reminder after someone cleaned it up), the graph shows the
    history and says it is no longer growing.

A test email from the automation wizard draws an example filesystem, and
always forecasts 7 days ahead.

### What the default email shows for a CPU or memory alert

A high-CPU or high-memory alert is about the host's **load**. The host is
answering, which is how its CPU was read, so its response-time and
packet-loss graphs say nothing about the fault. Those are dropped.

- **Graphs.** The last hour of **CPU and memory**, both of them whichever one
  fired, since a runaway process usually moves the two together. The one
  that fired comes first.
- **Top 5 processes.** The five programs using the most of that resource:
  ranked by **CPU** on a CPU alert, by **memory** on a memory alert, with the
  other figure beside each. A program running as several processes is one row
  with its count (`chrome.exe ×14`). CPU is summed across a program's
  processes and across cores, so **100% means one full core** and a busy
  program on a multi-core host can read higher.
- **How old the list is.** The list comes from the host's process inventory,
  which is refreshed every few minutes, not at alert time, so the email says
  how long before it was sent the list was reported.

The list appears only on a host that reports processes: one with the Polaris
Agent, or one whose processes are collected over SSH or WinRM. An
SNMP-polled device or a firewall gets the two graphs and no list. On an agent
host the CPU figures need agent **0.22.1** or later. Older agents report each
process's average since it started, which ranks a long-running process that
has just started spinning near the bottom.

Unlike the interface changes above, dropping the connectivity graphs applies to
a **customized** email too: a `{chart.responseTime}` or `{chart.probeLoss}` in
your body renders nothing on a CPU or memory alert. The process list is the
`{processes.top}` token, which is in the default email. An automation whose
email you customized before this existed does not have it, so add it where you
want the list.

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
`{asset.tags}` `{asset.connectedSwitch}` `{asset.connectedAp}`
`{asset.managedBy}` `{asset.link}`

> `{asset.managedBy}` is the device page's **Managed by** row: the integration
> that owns the device, such as `FortiManager: FMG-01`. A managed FortiSwitch or
> FortiAP also names its FortiGate (`FortiManager: FMG-01 → FGT-SITE-01`). A
> device no integration owns says `Manual`. The default email prints it on
> every alert about a device, interface alerts included.

> `{asset.link}` — the default email's **Open device** button — is one address
> for every reader. Opened on a phone it lands on the mobile app's device
> screen; anywhere else, on the desktop assets page. It is empty when
> `POLARIS_PUBLIC_URL` is unset, because an email cannot resolve a relative
> link.

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

## One alert per device

An automation that watches something **per component** — per interface, per
PoE port, per storage mount, per sensor — raises one alert per component by
default. Tick **Raise one alert per device, not one per interface** (the noun
follows the trigger) on the Actions step and it raises **one alert per device**
instead ([rule 75](Business-Rules#rule-75)):

- every affected component is named on the alert — `{dimension}` renders the
  list, `{dimension.count}` how many, `{dimension.first}` the lead one;
- **one acknowledgement** covers all of them;
- the alert **stays up until the last one recovers** — the first port to come
  back does not send "Resolved" while the rest are still down;
- a component that goes wrong later **joins** the alert and sends one more
  message naming the whole set, and that **re-opens** an acknowledged alert;
- the alert carries the **worst** severity among the components still affected.

The checkbox appears only on a trigger that reports per component. Turning it
on or off ends the automation's live alerts, and the next check raises them in
the new shape. To fold alerts from **several** automations into one, use an
[alert group](Automations#alert-groups).

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

**"Require Acknowledgement"** is a row at the head of each **severity section**,
not a setting on the rule ([rule 56](Business-Rules#rule-56)). What closing an
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
