# TrueNAS SCALE

Discovers a **TrueNAS SCALE** server, its **virtual machines** and its
**Apps**, and monitors all three through the server's own API, with no
credential inside any guest or App.

One integration per TrueNAS host. Add it from **Integrations → + Add
Integration → TrueNAS SCALE**. Its counterpart for Unraid is
[Unraid](Integration-Unraid), and the two behave the same way except where this
page says otherwise.

---

## What it discovers

| Object | Becomes |
|---|---|
| **The TrueNAS server** | an Asset of type **Hypervisor** |
| **Virtual machine** | an Asset of type **Server** |
| **App** | an Asset of type **Container** (a built-in type) |
| **ZFS pools** | storage on the host asset (see [Monitoring](#monitoring-through-the-truenas-api)) |

**One App is one asset**, even when the App runs several Docker containers.
The App is what you install, update and restart in TrueNAS, so it is what
Polaris tracks.

Every VM and App is **parented by its host** in the dependency tree. When the
host goes down, its workloads are
[dependency-suppressed](Dependency-Suppression) instead of each one raising its
own alert.

### How Polaris knows it is the same workload

| Asset | Identity |
|---|---|
| Host | one per integration |
| VM | its **UUID** when TrueNAS reports one, otherwise the integration plus the VM's name |
| App | the integration plus the App's **name** |

Apps are identified by **name, never by a container id**, which changes every
time a container is recreated or updated. Apps are also **never matched by MAC
address**.

When an existing asset that no integration links yet already has the name a new
VM or App would take, Polaris does not merge them. It raises a pending
[conflict](Conflict-Resolution) (Events → Conflicts) for you to decide.

---

## Before you add it: set up TrueNAS

Written against **TrueNAS SCALE 25.10**. Menu paths can move between releases.

1. **Check the version** on the dashboard's System Information card. The
   integration needs **25.04 or later**. It uses the JSON-RPC 2.0 WebSocket API
   at `wss://<host>/api/current` and logs in with `auth.login_with_api_key`.
   The older REST API is deprecated in 25.10 and removed in 26.04; Polaris does
   not use it.
2. **Create a dedicated user.** A TrueNAS API key carries exactly the
   permissions of the user it belongs to; the key has no permissions of its own.
   Go to **Credentials → Users → Add**:
   - **Username**: for example `polaris`.
   - **Allow Access**: **TrueNAS Access**.
   - **Administration Role**: **Readonly Admin** for discovery and monitoring.
     For [workload actions](#workload-actions) (start, stop, restart, update
     Apps and VMs), use **Full Admin** instead. With Readonly Admin Polaris
     still monitors; TrueNAS refuses the actions and the refusal is recorded.
   - No shell, SMB or sudo access is needed.
3. **Create the API key.** Open the top-right user menu → **My API Keys** →
   **Add**. Alternatively go to **Credentials → Users**, select the user and
   choose **View API Keys**. Give the key a name, choose the user under
   **Username**, and either leave it **Non-expiring** or set **Expires On**.
4. **Copy the key immediately.** TrueNAS shows it only once, in the
   confirmation dialog.
5. **Keep HTTPS on.** TrueNAS **automatically revokes a user-linked API key the
   first time it is sent over plain HTTP**, so one test against port 80 costs
   you the key. If the web UI still uses TrueNAS's default self-signed
   certificate, either untick *Verify TLS certificate* in Polaris or install a
   trusted certificate under **Credentials → Certificates** and select it in
   **System → General Settings → GUI**.
6. **Make sure Apps are configured** (**Apps**, with a pool chosen). When they
   are not, Polaris reads the Apps as *unreadable*, not as empty.
7. In Polaris, add the integration and press **Test Connection**. It should
   report the hostname, the TrueNAS version, and how many Apps, VMs and pools it
   can see.

API keys are not subject to the user's two-factor authentication, so treat the
key like a password. Rotate it by creating a new key, updating Polaris, and
deleting the old key.

---

## Configuration

### General

| Field | Default | |
|---|---|---|
| Name | — | |
| Host / IP | — | the TrueNAS server's address |
| Port | blank | blank means **443** with HTTPS, **80** without |
| Use HTTPS | **on** | leave it on (see above) |
| Verify TLS certificate | **on** | turn off only for a self-signed certificate you cannot replace |
| API Key | — | stored encrypted. Leave blank when editing to keep the current key |
| Enabled | on | |
| Enable auto-discovery | on | |
| Auto-Discovery Interval | **1** hour | 1–24 hours |
| Verbose logging | off | |

Use **Test Connection** before saving, and again after changing the key.

### Filters

On the General tab, below the connection fields.


| Field | |
|---|---|
| **VMs** include / exclude | wildcards against the VM name, one per line |
| **Apps** include / exclude | wildcards against the App name, one per line |

**Include wins** when a name matches both lists. **The host is never filtered**:
it is the integration's own subject.

> **Narrowing a filter does not decommission anything.** A VM or App a new
> filter drops is simply no longer refreshed. Decommissioning follows from a
> workload actually leaving the host (see
> [below](#when-a-workload-disappears)), not from a filter change.

### Monitoring

The Monitoring tab has one subtab per class:

| Class | Auto-Monitor | |
|---|---|---|
| **Host** | **on** | |
| **Virtual Machines** | off | |
| **Apps** | off | |

Each subtab carries its **Auto-Monitor** toggle and its per-stream polling
settings. There is **no agent auto-deploy and no auto-monitor pinning** for
these classes.

---

## Monitoring through the TrueNAS API

The **TrueNAS** [polling method](Polling-Methods#the-unraid-and-truenas-methods)
is the source default for this integration's assets. It covers:

| Stream | Host | VM | App |
|---|---|---|---|
| **Response Time** | yes | yes | yes |
| **CPU / Memory** | yes, from the `reporting.realtime` event | **no** (see below) | yes, from `app.stats` |
| **Interfaces** | yes | — | — |
| **Storage** | yes: the ZFS pools | — | — |
| **Hardware Sensors** | yes: disk temperatures | — | — |
| **LLDP** | — | — | — |

**One cached read** of the host's API per integration every 30 seconds answers
every asset on that host. A large App count costs no more API calls than a small
one.

### What "response time" means here

For a VM or App, up and down is **TrueNAS's own state**: running is up, stopped
is down. A state that is in transition (DEPLOYING, for example) is skipped, with
no verdict either way. The response time shown is the **round trip of the API
call to the host**, not a ping of the workload.

If the host's API cannot be reached, **the host is reported down and its VMs
and Apps are skipped** rather than all declared down. Combined with dependency
suppression, a powered-off TrueNAS server produces one alert, not one per App.

### VMs have up/down only

Polaris reads no CPU or memory usage for TrueNAS VMs, only their running state.
For CPU and memory inside a VM, install the [Polaris Agent](Polaris-Agent) in
it, or poll it over SNMP, SSH or WinRM.

---

## What you see on the asset

The asset's **General** tab has a section titled **TrueNAS SCALE**.

On the **host**:

- platform and version, CPU threads, memory, and workload counts;
- a **Pools** table: name, kind, health, capacity, used, and a usage bar;
- a **Workloads** table: each VM and App (linked to its own asset), its kind,
  state, an update badge, and its monitor status.

On a **VM or App**:

- a link to its host, and its state;
- its image and its **version**;
- **Updates**: an *Update available* badge, *Up to date*, or *Not checked*;
- its ports and whether it starts automatically.

**Discover Now** is disabled on a VM or App. The integration's own **Discover**
refreshes the whole host in one read, so a single-workload run would cost the
same and do less.

The [Polaris Agent](Polaris-Agent) **cannot be installed on the host or on an
App**; Polaris refuses the install. A VM can take the agent like any other
server.

---

## Workload actions

Users with **Assets Read-Write** see an action bar on a VM or App:

| Action | Applies to | |
|---|---|---|
| **Start** | VMs, Apps | |
| **Stop** | VMs, Apps | with a **Keep monitoring while stopped** checkbox next to it |
| **Restart** | VMs, Apps | |
| **Update** | Apps, only when an update is available | see below |
| **Check for updates** | Apps | |

Reading the live state needs only Assets Read-Only. The host itself cannot be
started or stopped from Polaris.

**Update** upgrades a catalog App to the **latest version in the catalog**. For
a custom App, it pulls the App's images and redeploys it. **Polaris never
chooses a version**: it is always the catalog's latest, or the images the custom
App already names.

What Polaris does around each action is [rule 94](Business-Rules#rule-94):

- **Restart and Update put the workload in maintenance** for their duration,
  so the restart does not page you. The hold ends when TrueNAS reports the job
  finished, or on its own after **10 minutes** (restart) or **30 minutes**
  (update). See
  [Windows Polaris opens for itself](Maintenance-Windows#windows-polaris-opens-for-itself).
- **Stop pauses monitoring** of the workload instead, unless you tick *Keep
  monitoring while stopped*. A **Start from Polaris** resumes it, but only if it
  was Polaris that paused it.
- **Every attempt is recorded** as an Event named `asset.workload.<verb>` —
  successes, failures and refusals alike.

---

## When a workload disappears

**A VM or App that vanishes from the host is decommissioned**, unless another
integration also claims the same asset.

The sweep is careful about when absence counts:

- **Skipped** when part of the inventory could not be read, for example when
  Apps are not configured on the server. An App list that could not be read is
  not an empty one.
- **Refused** when a single read lost more than **50 workloads or 20% of the
  host's workloads**, whichever is larger. That is far more likely to be a fault
  than a real mass removal.

---

## Query API

The integration card's **Query API** button sends a read to the TrueNAS API, for
answering "why didn't this get discovered?" yourself. It accepts **read methods
only**: `*.query`, `*.get_instance`, `*.config`, `system.info`,
`disk.temperatures` and similar. Anything that changes state is refused. Saved
presets cover the common reads.

---

## Troubleshooting

| Symptom | Look at |
|---|---|
| The API key stopped working right after a test | it was sent over plain HTTP and TrueNAS revoked it. Create a new key and keep **Use HTTPS** on |
| Test Connection cannot reach the API | the TrueNAS version. The `/api/current` WebSocket API needs TrueNAS 25.04 or later |
| Start / Stop / Restart / Update fails with a permission error | the role of the user the key belongs to. **Readonly Admin** can only read; actions need **Full Admin** (or a custom role carrying APPS_WRITE for Apps and VM_WRITE for VMs). The `asset.workload.*` Event names the refusal |
| An App with several containers is one asset | correct. Polaris tracks the App, not its containers |
| An App reads neither up nor down for a while | it is in a transition state such as DEPLOYING, which is skipped |
| Every App went quiet at once, and the host is down | correct: the host's API is unreachable, so its workloads are skipped and suppressed |
| A removed App was not decommissioned | check the run's Events for a skipped or refused sweep (Apps not configured, or too many workloads lost in one read) |
| A new App shows up as a Conflict | an unlinked asset already has that name. Resolve it in Events → Conflicts |
