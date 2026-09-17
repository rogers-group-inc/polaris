# Events

The audit log. **Every audit-worthy action writes an Event** — creates, updates,
deletes, discovery results, alert lifecycle, login outcomes, agent activity,
script runs.

![The Events page: a filterable, time-ordered audit log of configuration changes and discovery activity.](https://raw.githubusercontent.com/rogers-group-inc/polaris/main/docs/img/screenshots/desktop-noon-events.png)

Gated by `events`.

---

## The list

| Column | |
|---|---|
| **Timestamp** | |
| **Level** | `info` · `warning` · `error` |
| **Action** | a dotted verb — `reservation.created`, `asset.firmware.changed`, `monitor.status_changed` |
| **Resource** | the entity type |
| **Resource Name** | |
| **Message** | |
| **User** | the actor |

Sortable, inline-filterable, resizable, with saved layouts like every other list
page.

### Actors

| Actor | Means |
|---|---|
| a username | a person, via the UI |
| `api:<token name>` | a bearer token |
| `system:<what>` | Polaris itself — `system:dns-resolved`, `system:maintenance`, `system:automation`, `system:upstream-chain`, `system:auto-resolved` |

The `system:` prefix is worth knowing: it tells you a change was made by a rule
rather than by a person, and which rule.

---

## Conflicts

The **Conflicts** button opens the resolution queue in a slide-over, with a
count badge. See [Conflict resolution](Conflict-Resolution).

The **Conflict Queue** dashboard widget shows the same thing, **role-scoped** —
you see only the ones your role can resolve. If it looks empty and you expected
rows, check that before assuming there are none.

---

## Retention and archival

**Events older than 7 days are pruned** by default
([rule 8](Business-Rules#rule-8)). Configure retention at
[Server Settings → Retention](Server-Settings#retention).

Two archival paths, both configurable:

- **syslog (CEF)**
- **SFTP / SCP**

> **Anything archived leaves the host.** That is why several rules are careful
> about what reaches an Event in the first place — most visibly, directory sync
> writes **counts only**, never names ([rule 35e](Business-Rules#rule-35)), and
> address-book search query strings are never written at all.

---

## Events you will want to know about

### Discovery

| Action | Level | Means |
|---|---|---|
| `integration.discover.error` | error | the run failed |
| `integration.discover.devices_unread` | **warning** | devices the run **could not read** — named individually ([rule 53](Business-Rules#rule-53)) |
| `discover.device.complete` | info | retracts an earlier error for that device |
| `integration.coords.push_failed` | warning | coordinate write-back failed; the asset writes still landed |

### Monitoring

| Action | Means |
|---|---|
| `monitor.status_changed` | the pill moved. **Not written for entering or leaving `passive`** — that is a configuration edge, not a state change |
| `monitor.dependency_suppressed` / `_resumed` | a subtree went behind a dark parent, or came back |
| `monitor.down_detection_absent` | **one-shot** — the fleet has **no down automation at all**, so nothing is being judged |

### Asset change

The `asset.*.changed` family: `asset.firmware.changed`,
`asset.switch_port.changed`, `asset.wireless_ap.changed`,
`asset.fortilink.changed`, `asset.ha.standby_down` / `_restored`,
`asset.mac.adopted`, `asset.ip_override.released`.

> These are diffed against a **run baseline**, not emitted at each write. Two
> sequences legitimately ping-pong *within* one discovery run — a coarse cached
> OS version replaced by the projected one, and two spellings of the same switch
> port — and emitting inline would report both halves as changes **every run,
> forever**. Diffing against the cycle boundary nets them to zero, so a steady
> fleet produces an empty batch.

### Alerting

`notification.triggered` is written by the removable **"Create an Event"**
action. It is present on every automation by default, and event- and
change-triggered automations are carved out — one that wrote an Event would feed
its own trigger.

`notification.superseded` records an alert cleared by a carve-out, a
device-down supersession or a saturated reading.

### Security and audit

| Action | Level | |
|---|---|---|
| `auth.login.blocked_source` | | login refused by the source-IP restriction |
| `user.password_changed` | info | **self-service** — the caller proved the current password |
| `user.password_reset` | **warning** | **admin-side** — that proof could not be made |
| `api_token.admin_equivalent` | warning | a token was bound to an admin-equivalent role |
| a group mapping to an admin role | warning | IdP group membership is now a path to Polaris admin |
| **script created** | **warning** | |
| **script body changed** | **warning** | carries the **old and new sha256** |
| `automation.script.run` | | one execution |
| `ssh.host_key.mismatch` | | a host key **changed** and the connection was refused |
| `agent.upgrade_skipped` | | a host the fan-out could not upgrade |
| `asset.pins.bulk_updated` | | one mass-pin apply |

The two password Events being **different actions at different levels** is
deliberate: the self-service change proves knowledge of the current password and
the admin reset cannot, so they are not the same act.

---

## Events drive automations

An **event** trigger fires when a matching Event is written, filtered by action
pattern, minimum level and resource type. A **change** trigger is sugar over the
`asset.*.changed` family.

Both are device-scoped ([rule 46](Business-Rules#rule-46)), and both are
**exempt from carve-out precedence** — they neither carve out nor are carved
out.

Twelve event automations ship seeded, unconstrained. An event automation clears
on its **counterpart Event** rather than on a timer:
`agent.disconnected` → `agent.connected`, scoped to the same subject.
