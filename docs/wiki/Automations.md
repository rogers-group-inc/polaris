# Automations

An **automation** is the whole unit: which devices, what to watch, at what
severity, what to do about it, and when it resets. Automations are what make
Polaris a monitoring tool rather than an inventory.

| Gate | Grants |
|---|---|
| `automationManagement:read` | see the page, preview, export, view code |
| `automationManagement:fullwrite` | create, edit, clone, delete, run test deliveries |
| `automationScripts:read` / `:fullwrite` | the Scripts tab; attaching a script action needs **fullwrite** |
| `contacts:read` | the Address Book tab |
| `alerts:read` / `:write` / `:fullwrite` | see alerts / acknowledge / clear |

**Read these in order:** this page, then
[Triggers and conditions](Automation-Triggers), then
[Actions and recipients](Automation-Actions), then
[Escalation, reminders and quiet time](Automation-Escalation).

---

## The page

Four tabs:

| Tab | Holds |
|---|---|
| **Automations** | the list, with an enable toggle per row |
| **Delivery** | the [delivery-channel registry](Delivery-Channels) |
| **Scripts** | the [script registry](Automation-Scripts) |
| **Address Book** | [contacts and the directory](Address-Book) |

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

Clicking an automation's **name** opens a menu: **Edit**, **Clone**, **Delete**.
Below `automationManagement:fullwrite` the name renders as plain text.

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
untouched and `automationScripts:fullwrite` is never involved.

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

Step 6 carries a **Test delivery** block (`automationManagement:fullwrite`;
omitted entirely otherwise), with one button per distinct delivery the draft
would perform: *Send Test Web Push*, *Send Test Email*, *Send Test <channel>*,
*Write a Test Event*. Deduplicated by channel across base actions, band actions,
escalation tiers, resolved and reset actions.

- Each press creates a **real** `[TEST]` alert and dispatches that one action
  immediately.
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
