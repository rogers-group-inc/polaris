# Unraid

Discovers an **Unraid server**, its **virtual machines** and its **Docker
containers**, and monitors all three through the server's own API, with no
credential inside any guest or container.

One integration per Unraid host. Add it from **Integrations → + Add
Integration → Unraid**. Its counterpart for TrueNAS is
[TrueNAS SCALE](Integration-TrueNAS), and the two behave the same way except
where this page says otherwise.

---

## What it discovers

| Object | Becomes |
|---|---|
| **The Unraid server** | an Asset of type **Hypervisor** |
| **Virtual machine** | an Asset of type **Server** |
| **Docker container** | an Asset of type **Container** (a built-in type) |
| **The array and cache pools** | storage on the host asset (see [Monitoring](#monitoring-through-the-unraid-api)) |

Every VM and container is **parented by its host** in the dependency tree. When
the host goes down, its workloads are
[dependency-suppressed](Dependency-Suppression) instead of each one raising its
own alert.

### How Polaris knows it is the same workload

| Asset | Identity |
|---|---|
| Host | one per integration |
| VM | its **UUID** when Unraid reports one, otherwise the integration plus the VM's name |
| Container | the integration plus the container's **name** |

A container is identified by **name, never by its container id**. Unraid gives a
container a new id every time it is recreated or updated, so an id-keyed asset
would be replaced, and lose its history, on every update. Containers are also
**never matched by MAC address**.

When an existing asset that no integration links yet already has the name a new
VM or container would take, Polaris does not merge them. It raises a pending
[conflict](Conflict-Resolution) (Events → Conflicts) for you to decide.

---

## Before you add it: set up Unraid

Written against **Unraid 7.3**. Menu paths can move between releases.

1. **Check the version.** It is shown at the top right of the web UI. The
   integration needs **Unraid 7.2 or later**, where the API is built in at
   `/graphql`. Older releases only have it through the Unraid Connect plugin.
2. **Create the API key.** Go to **Settings → Management Access → API Keys**
   and create a key with a recognisable name, such as `polaris`.
   - For discovery and monitoring, give it the **VIEWER** role (read-only).
   - For [workload actions](#workload-actions) (start, stop, restart, update),
     also grant the permissions **DOCKER: UPDATE_ANY** and **VMS: UPDATE_ANY**,
     or use the **ADMIN** role, which grants everything. These are the
     permissions Unraid's API checks on those calls. Without them Polaris still
     monitors; Unraid refuses the actions and the refusal is recorded.
   - The CLI equivalent is `unraid-api apikey --create`.
3. **Copy the key** and keep it for the Polaris form.
4. **Decide HTTPS.** **Settings → Management Access → Use SSL/TLS** sets what
   the server speaks:
   - **Strict** (a `myunraid.net` certificate): enter the `myunraid.net`
     hostname as the Polaris *Host* so the certificate verifies.
   - **Yes** (self-signed): leave *Use HTTPS* on and untick *Verify TLS
     certificate*.
   - **No**: untick *Use HTTPS*. Polaris then uses port 80.
5. **Make sure Docker and the VM manager are running** (**Settings → Docker**,
   **Settings → VM Manager**). When either is stopped, Polaris reads that part
   of the host as *unreadable*, not as empty.
6. In Polaris, add the integration and press **Test Connection**. It should
   report the hostname, the Unraid version, and the container and VM counts.
   *Containers unreadable* means Docker is stopped or the key cannot read it.
   The same goes for VMs.

To explore the API yourself, turn on **Settings → Management Access →
Developer Options → GraphQL Sandbox** and open `https://<server>/graphql`. The
integration card's [Query API](#query-api) button runs read-only queries with
the stored key.

---

## Configuration

### General

| Field | Default | |
|---|---|---|
| Name | — | |
| Host / IP | — | the Unraid server's address. A hostname is resolved through Server Settings → DNS (then the system resolver); the host asset gets the resolved IP as its IP Address and the name as its DNS Name |
| Port | blank | blank means **443** with HTTPS, **80** without |
| Use HTTPS | **on** | |
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
| **Containers** include / exclude | wildcards against the container name, one per line |

**Include wins** when a name matches both lists. **The host is never filtered**:
it is the integration's own subject.

> **Narrowing a filter does not decommission anything.** A VM or container a new
> filter drops is simply no longer refreshed. Decommissioning follows from a
> workload actually leaving the host (see
> [below](#when-a-workload-disappears)), not from a filter change.

### Monitoring

The Monitoring tab has one subtab per class:

| Class | Auto-Monitor | |
|---|---|---|
| **Host** | **on** | |
| **Virtual Machines** | off | |
| **Containers** | off | |

Each subtab carries its **Auto-Monitor** toggle and its per-stream polling
settings. There is **no agent auto-deploy and no auto-monitor pinning** for
these classes.

> **Turning on Auto-Monitor for containers can add a lot of monitored assets at
> once** on a busy Unraid server. Look at what the class contains first.

---

## Monitoring through the Unraid API

The **Unraid** [polling method](Polling-Methods#the-unraid-and-truenas-methods)
is the source default for this integration's assets. It covers:

| Stream | Host | VM | Container |
|---|---|---|---|
| **Response Time** | yes | yes | yes |
| **CPU / Memory** | yes | **no** (see below) | yes |
| **Interfaces** | yes | — | — |
| **Storage** | yes: the array and cache pools | — | — |
| **Hardware Sensors** | yes: disk temperatures | — | — |
| **LLDP** | — | — | — |

**One cached read** of the host's API per integration every 30 seconds answers
every asset on that host. A large container count costs no more API calls than a
small one.

### What "response time" means here

For a VM or container, up and down is **Unraid's own running state**: running is
up, stopped is down. A state that is in transition is skipped, with no verdict
either way. The response time shown is the **round trip of the API call to the
host**, not a ping of the workload.

If the host's API cannot be reached, **the host is reported down and its VMs
and containers are skipped** rather than all declared down. Combined with
dependency suppression, a powered-off Unraid server produces one alert, not one
per container.

### Container CPU and memory

Per-container CPU and memory come from the API's `dockerContainerStats`
subscription, sampled over a **short WebSocket window (4 seconds by default)**
on each pass.

### VMs have up/down only

**Unraid publishes no vCPU, memory or guest IP for its VMs.** Polaris therefore
monitors a VM's running state and nothing else through this integration. For
CPU and memory inside a VM, install the [Polaris Agent](Polaris-Agent) in it, or
poll it over SNMP, SSH or WinRM.

---

## What you see on the asset

The asset's **General** tab has a section titled **Unraid**.

On the **host**:

- platform and version, CPU threads, memory, and workload counts;
- a **Pools** table: name, kind, health, capacity, used, and a usage bar;
- a **Workloads** table: each VM and container (linked to its own asset), its
  kind, state, an update badge, and its monitor status.

On a **VM or container**:

- a link to its host, and its state;
- its image (containers);
- **Updates**: an *Update available* badge, *Up to date*, or *Not checked*;
- its ports and whether it starts automatically.

**Discover Now** is disabled on a VM or container. The integration's own
**Discover** refreshes the whole host in one read, so a single-workload run
would cost the same and do less.

The [Polaris Agent](Polaris-Agent) **cannot be installed on the host or on a
container**; Polaris refuses the install. A VM can take the agent like any other
server.

---

## Workload actions

Users with **Assets Read-Write** see an action bar on a VM or container:

| Action | Applies to | |
|---|---|---|
| **Start** | VMs, containers | |
| **Stop** | VMs, containers | with a **Keep monitoring while stopped** checkbox next to it |
| **Restart** | VMs, containers | |
| **Update** | containers, only when an update is available | re-pulls the container's image |
| **Check for updates** | containers | |

Reading the live state needs only Assets Read-Only. The host itself cannot be
started or stopped from Polaris.

What Polaris does around each action is [rule 94](Business-Rules#rule-94):

- **Restart and Update put the workload in maintenance** for their duration,
  so the restart does not page you. The hold ends when Unraid reports the
  action finished, or on its own after **10 minutes** (restart) or **30
  minutes** (update). See
  [Windows Polaris opens for itself](Maintenance-Windows#windows-polaris-opens-for-itself).
- **Stop pauses monitoring** of the workload instead, unless you tick *Keep
  monitoring while stopped*. A **Start from Polaris** resumes it, but only if it
  was Polaris that paused it.
- **Every attempt is recorded** as an Event named `asset.workload.<verb>` —
  successes, failures and refusals alike.

**Update never chooses a version.** It pulls the image tag the container is
already configured with.

---

## When a workload disappears

**A VM or container that vanishes from the host is decommissioned**, unless
another integration also claims the same asset.

The sweep is careful about when absence counts:

- **Skipped** when part of the inventory could not be read, for example when
  the Docker service is stopped. A container list that could not be read is not
  an empty one.
- **Refused** when a single read lost more than **50 workloads or 20% of the
  host's workloads**, whichever is larger. That is far more likely to be a fault
  than a real mass removal.

---

## Query API

The integration card's **Query API** button sends a read to the Unraid API, for
answering "why didn't this get discovered?" yourself. It accepts **GraphQL
queries only**; mutations and subscriptions are refused. Saved presets cover the
common reads.

---

## Troubleshooting

| Symptom | Look at |
|---|---|
| Test Connection fails with an authentication error | the API key. Check it was copied whole and still exists under Settings → Management Access → API Keys |
| Test Connection cannot find the API | the Unraid version. The GraphQL API needs Unraid 7.2 or later |
| A VM has no CPU or memory chart | expected. Unraid does not publish VM CPU or memory; use the agent or SNMP / SSH / WinRM in the guest |
| Start / Stop / Restart / Update fails with a permission error | the key's role. Viewer can read but cannot manage containers and VMs. The `asset.workload.*` Event names the refusal |
| Every container went quiet at once, and the host is down | correct: the host's API is unreachable, so its workloads are skipped and suppressed |
| A container came back as a new asset after an update | it should not; containers are keyed on name. Check whether it was renamed |
| A container that was removed was not decommissioned | check the run's Events for a skipped or refused sweep (Docker service stopped, or too many workloads lost in one read) |
| A new container shows up as a Conflict | an unlinked asset already has that name. Resolve it in Events → Conflicts |
| Container CPU is missing or flat | the stats window is short (4 s). Verify on your host that the API's container stats are populated |
