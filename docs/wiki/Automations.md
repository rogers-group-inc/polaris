# Automations

An **automation** is the whole unit: which devices, what to watch, at what
severity, what to do about it, and when it resets. Automations are what make
Polaris a monitoring tool rather than an inventory.

![The Automations table: name, trigger type, severity, enabled toggle, device scope, trigger and reset conditions, actions and recipients.](https://raw.githubusercontent.com/rogers-group-inc/polaris/main/docs/img/screenshots/desktop-noon-automations.png)

| Gate | Grants |
|---|---|
| `automationManagement:read` | see the page, preview, export, view code |
| `automationManagement:write` | create, edit, clone, delete, run test deliveries |
| `automationScripts:read` / `:write` | the Scripts tab; attaching a script action needs **write** |
| `contacts:read` | the Address Book tab |
| `alerts:read` / `:write` / `:fullwrite` | see alerts / acknowledge / clear |

**Read these in order:** this page, then
[Triggers and conditions](Automation-Triggers), then
[Actions and recipients](Automation-Actions), then
[Escalation, reminders and quiet time](Automation-Escalation).

---

## The page

Five tabs:

| Tab | Holds |
|---|---|
| **Automations** | the list, with an enable toggle per row |
| **Delivery** | the [delivery-channel registry](Delivery-Channels) |
| **Alert Groups** | automations whose alerts about one device become one alert — [below](#alert-groups) |
| **Scripts** | the [script registry](Automation-Scripts) |
| **Address Book** | [contacts and the directory](Address-Book) |

### Settings

The **Settings** button beside **+ New automation** opens the automation
settings. Its one tab, **Global Quiet Times**, lists the quiet periods that
apply to every automation without a quiet time of its own: which devices, which
severities and kinds of alert, when, and how the summary email goes out. **+ New
quiet time** walks the same five steps the automation wizard does — Name,
Devices, Alerts, Schedule, Review. The list shows whether each one is quiet right
now and when it next will be, and below it the recent summary emails. Reading
needs `automationManagement:read`; creating, editing, toggling and deleting need
`write`. See [Quiet time](Automation-Escalation#quiet-time).

### The list

Columns: **Devices · Trigger · Reset · Actions · Addresses · Type**.

The first four each hold that part of the automation **in the builder's own
words**, so two automations can be told apart without opening either. Trigger
and Reset come from the same sentence factory the wizard renders its own steps
from — a second phrasing here is how the list and the editor would come to
describe one automation differently.

**Addresses** answers the question the other four cannot: *who does this
automation actually reach?* The cell is the flat deduplicated address list, so
filtering it answers "every automation that mails Jane". Hovering breaks it down
by **where** each recipient is declared — the base notification, each severity
band, each escalation tier, the all-clear, the reset — with the delivery channel
on each group.

A chat or webhook channel posts to its own destination, so its action shows the
channel rather than people who would never receive it.

**Type** is the narrow trigger-kind column. It stays because prose cannot be
filtered by kind.

**Severity** shows the automation's one severity — unless it has severity bands,
in which case the pill reads **Escalation**, coloured by the base severity (the
first tier it fires at). Hovering it lists the ladder, e.g. *Warning → Serious
(20) → Critical (30)*. The column's filter and sort use that base severity.

Clicking an automation's **name** opens a menu: **Edit**, **Clone**, **Delete**.
Below `automationManagement:write` the name renders as plain text.

**Clone** pre-fills the wizard, saves as a create, names it `<name> (copy)`, and
is **created disabled**. That is not politeness: two automations with the same
trigger signature at the same scope rank **both fire**
([rule 18](Business-Rules#rule-18)), so an identical enabled clone would
double-alert the matched fleet.

Sort, filters, column widths and visibility, and page size persist per user and
are restored **before** the first render, so the initial paint carries your
setup rather than flashing defaults.

---

## The six-step wizard

| Step | What it asks |
|---|---|
| **1 — Name** | name, description, and (when creating) **Import from file…** |
| **2 — Devices** | which devices this automation covers |
| **3 — Trigger** | severity, then what to watch |
| **4 — Reset** | what has to become true again |
| **5 — Actions** | the in-app alert, then notify / API call / script / event |
| **6 — Summary** | review, export, view code, **test delivery**, and the impact preview |

You can navigate freely to any step you have visited; in edit mode every step is
unlocked. An unsaved new automation stashes in memory with a restore prompt.

There is **no enabled control in the wizard** — enabling is the list's toggle.

### Step 1 — Import

**Import from file…** (create only — never offered while editing, where
replacing the open automation would be a data-loss trap). The file is read in
the browser; there is no upload route.

Two things always happen on import:

- **The file's name becomes the automation's name.**
- **It is created disabled**, whatever the file says — the same same-signature
  reasoning as Clone.

A banner lists the file's declared **dependencies** as present / missing /
can't-tell against this install, and names which later steps need attention.
Actions always need attention, because an exported file carries no delivery
wiring. See [Export and import](#export-import-and-view-code).

### Step 2 — Devices

A default-checked **"All assets"** checkbox. Unchecking it reveals the **nested
condition builder**: a root group with AND / OR / NONE / NOT-ALL combinators,
rows of field + operator + value with a click-to-suggest combobox, sub-groups up
to 5 deep, and drag-and-drop between groups by the grip handles.

Unchecked **and empty is a validation error** — never silently "all assets".

A debounced preview shows the devices currently matched.

**The step is per trigger.** A trigger type the catalogue marks *unscoped* has
its filter **discarded** at save. Today that is `host_metric` and a host-kind
composite — those are about the Polaris server, not about your devices. The
step's lead line says which case you are in. `event` automations **are** scoped
since 2026-09 ([rule 46](Business-Rules#rule-46)).

---

## Alert groups

An **alert group** is a named set of automations whose alerts about the same
device become **one** alert ([rule 75](Business-Rules#rule-75)). A switch whose
power supply fails can trip a PoE-fault automation on eight ports and an
uplink-down automation at the same moment; in a group that is one alert naming
everything wrong, one acknowledgement, and one page at 02:00 instead of three.

The split is the whole idea:

- **Each automation still decides what counts as a problem** — its devices,
  trigger, holds, severity bands and reset are unchanged.
- **The group decides who hears about it** — its recipients, escalation chain,
  reminders, acknowledge-note policy and email. While an automation is in a
  group, **its own recipients are not used** for alerts the group governs.

The editor holds a name, an **Active** switch, a **Which devices** filter, the
member list, the alert text, **Require a note when acknowledging** and
**Remind while unhandled**.

- **Members.** Every automation is listed; one that cannot join says why rather
  than being left out. An automation can be in one group at a time, and only
  one that watches something it can keep checking — a metric, a state, or a
  multi-condition device trigger. Event and change automations cannot join:
  they fire on a single moment, so Polaris could never tell when their part in
  a shared alert had ended.
- **Which devices.** Narrows where the folding applies, never what a member
  watches. On a device outside the filter, a member alerts on its own exactly
  as it would outside the group — which is how one set of automations can serve
  several groups routed to different people.
- **Recipients are copied once, from the first member that has any**, the first
  time the group is saved with none of its own — together with that
  automation's escalation chain, email layout and reset actions. Changing that
  automation afterwards does **not** change the group. This screen cannot edit
  recipients or escalation yet; change them through the [API](API).
- **Turning a group off** does not turn its automations off: they go back to
  alerting on their own. **Deleting** one does not delete them either, and the
  confirmation names any member that has no recipients of its own and would go
  quiet.

Adding or removing a member, changing the device filter, and turning off or
deleting a group all **end the affected live alerts**; the next check raises
them again under whoever now delivers them.

Separately from groups, a single automation that watches something per
component can raise **one alert per device** on its own — see
[Actions and recipients](Automation-Actions#one-alert-per-device).

## Precedence — the single most important behaviour

Two automations **watch the same thing** if their *trigger signature* matches.
Among those, the one with the **higher specificity rank carves out** the devices
it covers from every lower-ranked one ([rule 18](Business-Rules#rule-18)).

The ladder, least to most specific:

```
All assets < Device type < OS < Manufacturer < Model
          < Tag < Region < IP block < Subnet < Hostname
```

(An IP block *contains* subnets, so a block rule targets less precisely and
loses the carve-out to a subnet rule over the same trigger.)

When a higher-ranked automation carves a device out of a lower-ranked one, the
lower one's readings for that device are dropped, any active alert from it is
cleared as `notification.superseded`, and a pending debounce is reset.

**Same-rank ties both fire.** That is why Clone and Import create disabled.

`event` and `change` triggers are **exempt** — they neither carve out nor are
carved out.

### The `monitorStatus` special case

`monitorStatus` is keyed by **operator and value, not by device filter**. It is a
single per-asset column, so *every* `== down` automation lands in one group
whatever its device filter — they have to be able to carve each other out. This
is also the group that decides **whose `missedPolls` count governs each device**
([rule 36](Business-Rules#rule-36)), rather than inventing a second precedence
system.

The step-6 preview shows both directions: which lower-ranked automations this
one removes devices from, **and** which of its devices a more-specific
automation already covers. Carved-out devices are counted in the warning box and
**left out of the row list** — the list is what the automation *will* alert on.

---

## The gate every automation passes

**An automation only fires about a device Polaris is actually polling**
([rule 37](Business-Rules#rule-37)). One gate, applied by every trigger path:
the asset must be `monitored` **and** not suppressed by a maintenance window or
dependency suppression.

Three consequences:

- **Un-monitoring a device clears its live alerts** (`notification.out_of_scope`),
  the same way leaving the scope does. Without that, `monitorStatus` is not
  cleared when monitoring stops and a `== down` automation would keep firing
  forever about a shelved device.
- **A deleted asset still fires.** An `asset.deleted` event must not be
  swallowed by a gate about the row that no longer exists.
- **System-scoped events still fire** — they carry no asset id.

Event and change triggers were the deliberate exception to this and no longer
are: firing about a device nobody polls made "an automation covers it" and
"Polaris watches it" two different answers.

---

## Export, import and view code

Both on the Summary card and the list row menu.

**Export** produces a portable `.automation.json`. The **`dependencies` block
comes first**, because that is what a human opening the file reads: everything
install-specific is stripped from the rule and recorded there **by name**
instead — delivery channels, registry scripts, state probes, custom roles,
regions, tags, pinned devices.

That strip is also the security half. It carries no ids and **no secrets**:
dropping `api_call` actions is what keeps an `api_call` bearer token — stored
unmasked by design — out of a file operators email and commit. It also means an
imported file **can never name a script action**, so the RCE surface is
untouched and `automationScripts:write` is never involved.

**View code** is deliberately a *different* serialisation: full fidelity, ids and
headers included, because an edit there must round-trip losslessly onto the same
automation. The editor says so.

> **The code editor's PUT is a full replace.** An absent nullable column becomes
> null; `enabled`, `severity` and `reset` fall back to **schema defaults** — so
> deleting `enabled` takes a disabled automation live. The editor renders the
> complete body, strips the legacy mirror fields, says that removing a key
> removes the setting, and confirms a diff with the destructive fields called
> out.

---

## Testing an automation

Step 7 (the review) carries a **Test delivery** block (`automationManagement:write`;
omitted entirely otherwise), with one button per distinct delivery the draft
would perform: *Send Test Web Push*, *Send Test Email*, *Send Test <channel>*,
*Write a Test Event*. Deduplicated by channel across base actions, band actions,
escalation tiers, resolved and reset actions.

- Each press creates a **real** `[TEST]` alert and dispatches that one action
  immediately.
- **The alert is about a made-up device, not one of yours**
  ([rule 65](Business-Rules#rule-65)). Hostname, IP, MAC,
  location, model, description and the last-hour charts are all invented sample
  data (`EXAMPLE-SWITCH-01` at `192.0.2.51`, and so on), so a test email can be
  forwarded to a vendor or a colleague without carrying any of your inventory.
  It is attached to no asset, so it never appears on a real device's alert list.
- **It does appear in the Dashboard's Active Alerts widget, for up to an hour.**
  Nothing can recover a test, so Polaris clears it automatically an hour after
  it fired. Until then the row carries a grey **TEST** pill beside its severity,
  so a wallboard doesn't read it as an outage. Clear it by hand if you don't
  want to wait.
- **It says so in three places** — `[TEST]` in the subject, a banner at the head
  of the body, and a line in the plain-text alternative. The marking is added at
  send time, so customizing the email template cannot remove it.
- No reading is quoted. The headline states the **condition** you configured
  ("Response time (median over 5 minutes) is above 500 ms") rather than a number,
  because the only real number available would be some device's.
- **Every button sends to you and nobody else.** That is a server-side recipient
  rewrite, not a flag. There is no mode to choose, so this step cannot page
  anyone.
- The block names the address and push-device count the test will land on.
- `api_call` and `script` are **never offered** — the server refuses to run them
  from a button.
- Webhook kinds (Slack, Teams, Pushbullet) are **disabled here** with a pointer
  to the Delivery tab's per-channel Test button: one Slack post reaches the whole
  channel, so there is no private form of it.

---

## Deleting or disabling an automation

The confirmation reports **how many devices this would leave with no down
detection at all** — i.e. `passive`. It is the only thing that *can* warn about
a fleet going unjudged, since the automation being removed is what would
otherwise alert about it.

A fleet with zero down automations stamps a one-shot
`monitor.down_detection_absent` warning Event.

---

## Severities

`notice` · `informational` · `warning` · `serious` · `critical`.

Severity is chosen at the top of the trigger step, and the step heading and the
condition group border are accent-coloured to it, so the automation you are
editing looks like what it will raise.
