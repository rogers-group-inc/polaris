# Troubleshooting

Symptoms, grouped by where you noticed them. Each entry names the page with the
real explanation.

---

## Install and upgrade

| Symptom | Cause |
|---|---|
| **"Database backup failed — see the server log"** | Two different things hide here. Either `pg_dump` is **older than the server**, or the `sslmode` in `DATABASE_URL` was passed through untranslated. [Backup and restore](Backup-and-Restore#the-two-failure-modes) |
| Backups work on your RHEL box and fail in a container | Structural. The scripted installs dump over a unix socket and build **no URL at all**, so they never exercise the `sslmode` path |
| **"Another host holds a fresh active-instance heartbeat"** after an image upgrade | The instance was identified by the container id, which is regenerated on every recreate. [Updates](Updates#another-host-holds-a-fresh-active-instance-heartbeat) |
| `npm install` fails on a corporate network | TLS inspection. Read *Networks that inspect TLS* in the install guide **before** installing — it is the one environment problem that can leave an install unable to update |
| The install came up without TimescaleDB | That is a **broken install from the first byte**, not a tuning gap. [rule 52](Business-Rules#rule-52) |
| The update-source override appears ignored | The URL contained a disallowed character. The updater keeps the existing origin and **logs an error naming it** |

---

## Login and access

| Symptom | Cause |
|---|---|
| A 403 on the next save after changing your password | Fixed by carrying the CSRF token across session rotation ([rule 61](Business-Rules#rule-61)). On an older build, reload the page |
| Login works, then immediately fails, on a site that used to be HTTPS | A `Secure` cookie from the old origin is blocking the new one — browsers silently reject a non-secure `Set-Cookie` where a same-name `Secure` cookie exists, **including its deletion**. Polaris detects this and tells you to clear cookies for the site. That is the only reliable recovery |
| An admin cannot be demoted | The **last-admin guard**. Promote someone else first |
| A 403 creating a role or a user | The **no-escalation guard** — you cannot mint admin-equivalence you do not hold ([rule 48](Business-Rules#rule-48)) |
| An API token can create rows but not edit them | **A token has no username**, so ownership-scoped `write` reaches nothing. Bind it to a role with `fullwrite` on those keys. [API](API#the-ownership-trap) |
| Header SSO does not log anyone in | The connector IP is not allowlisted. An **empty allowlist disables header login, failing closed**. The Test button reports the IP as Polaris sees it |
| An SSO user landed on `readonly` | No group mapping matched. New users get `readonly` plus a review flag |
| Azure group mapping matches nothing | Azure AD emits group **object IDs**. Map the GUIDs unless the IdP is configured to emit names |
| "Too many login attempts" when clicking **Sign in with Microsoft**, before typing anything | Fixed in 0.9. The SAML redirect used to share the password form's budget of 10 attempts per 15 minutes per source address, so a site behind one NAT address could exhaust it and lose SSO as well. SSO sign-in now has its own allowance. On an older build, wait 15 minutes |

### Passkeys

Four shapes, two real and two misconfigurations. Polaris returns a **reason**
rather than an opaque browser error ([rule 64](Business-Rules#rule-64)):

| Reason | Fix |
|---|---|
| Plain HTTP off localhost | Not fixable — WebAuthn requires a secure context |
| Reached by IP address | Use a hostname |
| **TLS terminates at a proxy and `req.secure` is false** | **Set `TRUST_PROXY`.** Polaris names it in the reason, and deliberately never honours the proxy's own header on its own — a spoofable header must not grant what `req.secure` withheld |
| **A proxy rewrote `Host`** | The derived relying-party id covers no browser's origin. Only the client can see this, so the browser half compares and reports it |

---

## Monitoring

| Symptom | Cause |
|---|---|
| A device reads **`passive`** | **No down automation covers it**, so Polaris renders no verdict ([rule 36](Business-Rules#rule-36)). Check your down rule's Devices step and [precedence](Automations#precedence--the-single-most-important-behaviour) |
| A device went `down` when you **disabled** its polling | A build before 2026-08-28: `disabled` fell through to an unknown-method error and was recorded as a miss |
| Two readings per cycle, misses counted twice | A build before 2026-09-10: batched ICMP chunks re-ran |
| A device owed hours of answered polls before reading `up` | A build before the bucket ceiling. Recovery now costs **exactly the cap**, however long the outage ran |
| The chart drew red → **green** → blue → green for one outage | Same vintage — an answered probe below the threshold read `down`, which the chart could not paint |
| A switch reads `up` but passes no traffic | Check **`fortilinkStatus`** — the gate's view of its own FortiLink session. A dead session still answers every ping ([rule 59](Business-Rules#rule-59)) |
| A whole site went `down` at once | [Dependency suppression](Dependency-Suppression) should have prevented that. Check whether the children resolve a parent at all — a child resolving **no** parent never suppresses, and fails silently |
| A subtree came back mid-outage and re-alerted device by device | The `warning` release leak — a parent flapping through `warning` used to release its subtree. Fixed 2026-09-14 ([rule 38a](Business-Rules#rule-38)) |
| The whole virtual fleet went `down` | vCenter unreachable must produce **skips**, not misses |
| A "High packet loss" alert lands minutes **after** a recovery | The outage's own failures are excluded from the metric ([rule 29h](Business-Rules#rule-29)). On an older build, lower the rule's `ignoreAtOrAbove` ceiling |
| The loss chart says *avg 40%* under an alert that fired at 8% | **Correct, and deliberate.** They answer different questions — only the caption's is reconstructible from the picture |
| A stream is configured and collects nothing, while the tick reports success | **Compatibility vs capability** — the method is meaningful for the source but the collector does not exist. The validators now warn and the dropdowns stop offering it |
| Every FortiOS stream reports "API token not configured" | FortiManager **proxy mode with no FortiGate API token**. [Polling methods](Polling-Methods#the-fortimanager-proxy-gotcha) |
| A per-asset REST credential was selected and nothing changed | On builds before 2026-09 the collector never read it — it persisted, resolved, rendered, and collected nothing forever |
| An agentless stream locks out the AD bind account | The anchors stamp **even on failure** precisely to bound this. Prefer a dedicated credential over the bind DN |

---

## Alerting

| Symptom | Cause |
|---|---|
| An automation never fires | The **monitored gate** ([rule 37](Business-Rules#rule-37)), or a **more specific automation carved the devices out** ([rule 18](Business-Rules#rule-18)). Step 6 shows both |
| A per-dimension automation fires about nothing | Nothing is **pinned**. The pin is the gate, and the picker lists the pin set, not the inventory ([rule 57](Business-Rules#rule-57)) |
| An alert cleared itself when a window opened | Correct — a maintenance window **retires** live alerts rather than freezing them ([rule 16](Business-Rules#rule-16)) |
| Alerts from two automations about one outage | Same-rank ties **both fire**. That is also why Clone and Import create **disabled** |
| A recipient gets nothing, and the automation looks right | Check the **Addresses** column's hover breakdown. Then check whether they have an email address at all, or (for push) an enrolled browser — the builder warns about both |
| Push delivers to nobody | Push is opt-in **per browser**, and the boot-time reconcile **never prompts**. The account must pick the preference **on that browser** once |
| An escalation paged the division instead of the site | An **orphaned region tag**. Level routing abstains entirely rather than promoting the container ([rule 58](Business-Rules#rule-58)), and it is invisible from every UI surface |
| Reminders arrived overnight despite quiet time | A **half-typed day contributes no window**. The step names the day and the overlapping hours |
| Reminders never resumed | An all-day-every-day quiet window holds them indefinitely. The live note warns about this pairing |
| A banded automation announced recovery twice | The band-level Resolved control was retired for exactly this; re-save the automation |
| A typo in a dimension pattern saved and never matched | The **match cue** beside the field now says so — *"matches none … would never fire"* |

---

## Discovery

| Symptom | Cause |
|---|---|
| A gate shows pre-upgrade firmware while FortiManager shows the right version | The run **could not read it**. Check the **unread** count and the `devices_unread` Event. **"It is being monitored fine" is not evidence that anything has read it** ([rule 53](Business-Rules#rule-53)) |
| A `chassis-replaced` card about a box nobody swapped | Address space shared across sites. Add a [network exclusion](IPAM#exclusions), do not reject the card |
| A managed switch has no parent, and suppression never fires | Something matched `controllerFortigate` against a **hostname**. That field holds FortiManager's *device name* |
| A VM was decommissioned that still exists | It left the vCenter inventory **and had no other source**. An incomplete read should skip the pass entirely |
| VMs disappeared after editing `vmInclude` | They should not — pre-filter retention exists for this. Check the run's Events |
| A device appears twice, once from AD and once from Entra | The **SID match** failed. Look for a hostname-collision conflict |
| Windows 11 clients show as Windows 10 | The build-threshold normalisation is **not retroactive** — it applies at the next write ([rule 28](Business-Rules#rule-28)) |
| An address-book keystroke 403s | Directory **search** is on without the directory-read grant |
| Auto-monitor pinned nothing | The agent had not reported at that cycle. Self-healing — check after the next one |
| Coordinates did not change after enabling `pullSnmpLocation` | `useSnmpLocationCoords` is the **separate** toggle that lets it drive coordinates |
| RPC `-11` "no valid session" churn | Something called `/sys/logout`, or two processes share one api-key session |

---

## Agent

| Symptom | Cause |
|---|---|
| Stuck at "enrolling", host crash-looping | The Linux `agent.conf` **ownership** trap. Reinstall. [Polaris Agent](Polaris-Agent#what-the-installer-does) |
| Agent healthy, Application Map empty | The Linux **privilege tier**. Check the Privilege column for **"reinstall"** — a SYS_PTRACE-only unit collects nothing while looking fine |
| TLS handshake fails after a certificate rotation | The pin. **Stage the new pin before rotating** |
| Samples stopped, heartbeat continues | A hung filesystem or NIC in a collector — bounded by a 30-second guard on current builds |
| An upgrade silently skipped a host | Look for `agent.upgrade_skipped`. On older builds this was completely silent |
| `agent.disconnected` alerts never clear | Use the **counterpart Event** reset — `agent.connected`, scoped to the same subject |

---

## Maps and UI

| Symptom | Cause |
|---|---|
| Every map tile says **"Access blocked"** | A reverse proxy is adding its own **`Referrer-Policy`**. OpenStreetMap blocks referer-less tile requests |
| A region rename appeared to revoke people's scope | It carries the columns with it now. A **delete** deliberately does not, and writes a warning Event naming who holds a dangling assignment |
| A tag stayed on thousands of assets under a dead region name | Retired-name sweeping is **not retroactive**. [rule 54](Business-Rules#rule-54) |
| A nav entry is missing | Your role lacks the key. A typed URL for the same page bounces — the two gates are kept in lockstep |
| The Conflict Queue widget looks empty | It is **role-scoped**. Check whether your role can resolve that conflict kind |

---

## When you are stuck

1. **Read the Events tab** filtered to `warning` and `error`. Polaris is written
   to *name* what it could not do rather than to be quiet about it.
2. **Turn on verbose logging** for the integration in question — bottom of its
   General tab. It also covers every monitor job for that integration's assets.
   Turn it off afterwards; the volume is high.
3. **Use the Query API** button on the integration to ask the upstream system
   directly. It exists to answer *"why didn't device X get discovered?"*.
4. **Check the resolved values, not the configured ones.** The asset's Monitoring
   tab shows per-field **provenance** — which tier each setting actually came
   from.
5. **Read the rule.** If the behaviour looks deliberate, it probably is:
   [Business rules](Business-Rules) carries the reason, and most of them exist
   because the obvious simpler version failed **silently**.
