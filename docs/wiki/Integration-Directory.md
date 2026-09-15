# Entra ID / Intune and Active Directory

The two directory integrations. Both discover **devices only** — the one
people-facing query in either is the optional address-book search, and it is a
separate, opt-in decision.

---

## Entra ID / Intune

Reads Microsoft Graph: `/devices`, plus `/deviceManagement/managedDevices` when
Intune is enabled.

### Configuration

| Field | Default | |
|---|---|---|
| Tenant ID | — | |
| Client ID | — | |
| Client secret | — | secret |
| **Enable Intune** | off | adds the managed-device read |
| `deviceInclude` / `deviceExclude` | — | wildcards against the device name |
| **Verify presence** | **on** | the post-sync presence pass |
| **Enable directory search** | off | live GAL typeahead, stores nothing |
| **Enable directory sync** | off | stores the roster as contacts |
| Directory sync filter | — | see [below](#the-directory-sync-filter) |
| **Publish to Intune** | off | see [below](#publishing-scripts-to-intune) |
| Workstation / Server monitor blocks | — | per-class polling + auto-monitor |
| Verbose logging | off | |

### Azure side

The app registration needs Graph **application** permissions for device
read, and admin consent. Directory search and sync need **additional**
directory-read permissions that device discovery has never required — which is
exactly why they are off by default: without the grant, every keystroke would
403.

---

## Active Directory

Reads LDAP or LDAPS, hard-filtered to `objectClass=computer`.

### Configuration

| Field | Default | |
|---|---|---|
| Host | — | domain controller |
| Port | **636** | |
| Use LDAPS | **on** | |
| Verify TLS | **on** for new integrations | existing rows keep their stored value |
| Bind DN | — | |
| Bind password | — | secret |
| Base DN | — | |
| Search scope | `sub` | `sub` or `one` |
| `ouInclude` / `ouExclude` | — | OU filters |
| **Include disabled** | **on** | a disabled computer object is still a record |
| Verify presence | on | |
| Enable directory search / sync | off | |
| Workstation / Server monitor blocks | — | |

> The bind credential doubles as the **integration-tier fallback** for
> AD-discovered hosts' agentless polling. That is convenient and worth being
> deliberate about: a stream that re-fires every tick against a bad credential
> is an **AD-lockout risk**, which is why the agentless collectors stamp their
> cadence anchor **even on failure**.

---

## Hybrid join

A device in both directories is linked by its **on-prem SID** — AD's
`objectSid` matched against Entra's `onPremisesSecurityIdentifier`. That is the
second rung of the re-discovery ladder, above a MAC match and above a hostname
collision.

Projection priority between them: **AD FQDN > Intune > Entra** for hostname;
for OS and OS version, whichever of them is not lagging — see below.

---

## The Windows version problem

`ProductName` still reads **"Windows 10 Pro" on every Windows 11 client**. AD,
Intune and the agent are all equally wrong, so **no projection priority can fix
it** ([rule 28](Business-Rules#rule-28)).

Polaris derives the family **from the build number via a threshold** — build
≥ 22000 is Windows 11, which never goes stale — and the release from a table. An
**unlisted build keeps its raw version** rather than being guessed at.

**Windows Server is excluded entirely**: build 26100 is both Windows 11 24H2 and
Server 2025.

It is applied at **write** time, because filters, sorts, exports and automation
scope conditions all read the stored columns. It is idempotent, and it is **not
retroactive**.

---

## The per-class blocks

Both integrations carry **Workstations** and **Servers** blocks, each with:

| Control | Default |
|---|---|
| Enabled | on |
| **Add as monitored** | off |
| Per-stream polling methods and credentials | source defaults |
| **Agent auto-deploy** | **off** |
| **Interface auto-monitor** | off |
| **Storage auto-monitor** | off — **AD / Entra only** |

### Agent auto-deploy

Pushes the Polaris Agent to newly discovered, agent-less devices over SSH or
WinRM **during discovery**. Bounded, paced and idempotent.

Turn it on only once you have a working credential and have tested a deployment
by hand — this installs software on your estate on a schedule. See
[Polaris Agent](Polaris-Agent).

### Auto-monitor

Pins interfaces and storage mounts for alerting. **Additive only** — it never
un-pins. The subtractive counterpart is
[Mass Pinning](Assets#mass-pinning).

Because these devices only report interfaces and mounts **via the agent**,
auto-monitor pins land the cycle *after* the agent first reports. That is
self-healing, not a bug.

---

## Presence verification

A post-sync pass, **on by default**, that establishes `Asset.lastSeen` for
directory-sourced assets — because a directory timestamp is not network
presence and no longer writes that field.

Cheapest signal first:

```
already-fresh lastSeen → agent heartbeat → an answering monitor probe
  → a single ICMP against the DNS name
```

**A failed ping writes nothing.**

---

## The address book: search vs sync

Two **separate, independently opt-in** forms of directory access, on the same
**Directory** tab. Same grants, different decision — because one reads and one
stores.

### Search (`enableDirectorySearch`, off)

A live typeahead fanned out to Graph (`/users`, mail-enabled `/groups`, org
`/contacts`) and an LDAP user/group/contact search, merged and deduplicated by
address.

**It persists nothing.** Results live for one request, and only an address
someone picks becomes a rule recipient or a saved contact. Failures degrade
per-integration rather than erroring the typeahead, and query strings are never
written to Events.

### Sync (`enableDirectorySync`, off)

Materialises the roster as `Contact` rows, as the **fourth** post-sync pass of
the owning integration's discovery run — last, so a directory outage cannot
affect the asset passes, and never its own scheduler job.

> **Before you enable it:** this puts employee names, addresses, titles,
> departments and phone numbers **in your database and in every backup**.

Read in bulk — Graph paged with `$select` / `$filter` / `$top` and deliberately
**no `$search`**; LDAP via the paged-results control with an `objectGUID`
identity.

Its five guarantees are on the [Address Book](Address-Book#what-sync-guarantees)
page. A steady-state run issues **zero writes**, and the run Event carries
**counts only** — no directory PII reaches Events or the logs, because Events
are readable by anyone with events access and are shipped off-host by the
archivers.

Switching the toggle off, or disabling or deleting the integration, **purges
what it created**.

### The directory sync filter

Shared verbatim between the two integrations — the directories differ in what
they can *answer*, not in what you want to exclude.

| Field | |
|---|---|
| Exclude disabled | |
| Exclude shared mailboxes | |
| Include groups | mail-enabled groups as entries |
| Include org contacts | |
| `ouInclude` / `ouExclude` | up to 100 each |
| `groupExclude` | up to 50 |
| `domainInclude` / `domainExclude` | up to 50 each |
| `nameExclude` | up to 100 |
| `maxEntries` | up to 50 000 |

---

## Publishing scripts to Intune

**`publishToIntune`**, off by default, with its own **Script Publishing** tab.

It lets Polaris publish the generated [SSH onboarding scripts](Polaris-Agent#ssh-deployment)
to Intune as a **Remediation**, instead of you downloading and uploading them.

Two things to understand before enabling it:

- It needs the Graph **`DeviceManagementScripts.ReadWrite.All`** application
  permission — upgrading the credential from *"reads device inventory"* to
  *"creates device-management policy tenant-wide"*. The tab renders the setup
  steps and the cost of the grant inline.
- **Polaris never calls `/assign`.** Assignment is the human review gate for a
  script that grants fleet-wide administrative SSH, and that is test-pinned.
  A human assigns the policy in Intune after reviewing the script.

The Graph API version is probed (v1.0 then beta), since this endpoint has
historically been beta-only: a 404 means the wrong version, a 403 means the
endpoint exists and permission is missing.

**Windows only.** Intune does not manage traditional Windows Server, so the
Servers class needs GPO, SCCM or [Azure Arc](Integration-Azure-Arc) regardless.

---

## Decommissioning

Neither integration has a fleet-absence pass. The **only** `decommissioned`
write comes from the directory object's own **disabled** flag.

So a machine deleted from AD does not disappear from Polaris on its own. That is
deliberate — a device is not gone because a directory record is.

---

## Troubleshooting

| Symptom | Look at |
|---|---|
| Every address-book keystroke 403s | directory search is on without the directory-read grant |
| Windows 11 clients show as Windows 10 | you are on a build predating the build-threshold normalisation, which is **not retroactive** — the fix applies at the next write |
| A device appears twice, once from AD and once from Entra | the SID match failed. Check `objectSid` / `onPremisesSecurityIdentifier` and look for a hostname-collision conflict |
| Auto-monitor pinned nothing | the agent had not reported yet at that cycle; check again after the next one |
| Agentless polling locks out the bind account | the anchors stamp on failure specifically to bound this — confirm the credential, and prefer a dedicated one over the bind DN |
| `lastSeen` never advances on directory assets | presence verification is off, or nothing answered — note a failed ping writes nothing |
