# Proxmox VE

Discovers a **Proxmox VE** cluster — or a standalone node — with every
**node**, every **QEMU virtual machine** and every **LXC container**, and
monitors all three through the Proxmox API, with no credential inside any guest.

One integration per cluster. Add it from **Integrations → + Add Integration →
Proxmox VE**. It works like the [Unraid](Integration-Unraid) and
[TrueNAS SCALE](Integration-TrueNAS) integrations, with two big differences: it
reads **several hosts** (the cluster's nodes), and it is **read-only** — Polaris
never starts, stops or changes anything on Proxmox.

---

## What it discovers

| Object | Becomes |
|---|---|
| **Node** | an Asset of type **Hypervisor** |
| **QEMU virtual machine** | an Asset of type **Server** |
| **LXC container** | an Asset of type **Container** (a built-in type) |
| **Storage** | storage on the node asset: its ZFS pools and its other active storage (see [Storage](#storage)) |

**Templates are always skipped.** A VM or container template is not a running
workload, so it never becomes an asset.

Every VM and container is **parented by the node it runs on** in the dependency
tree. When a node goes down, its guests are
[dependency-suppressed](Dependency-Suppression) instead of each one raising its
own alert.

**A guest that migrates moves with it.** When a VM or container turns up on a
different node, Polaris moves its parent to the new node and records an Event —
`asset.proxmox.moved`, reading for example *VM "web01" moved from Proxmox VE host
pve1 to pve2*. A live migration does not interrupt the guest's monitoring.

### How Polaris knows it is the same workload

| Asset | Identity |
|---|---|
| Node | the integration plus the **node name** |
| VM | its **SMBIOS UUID** (the `smbios1` setting every Proxmox VM carries) |
| LXC container | the integration plus its **VMID** |

Containers are identified by **VMID, not hostname**, because Proxmox does not
require container hostnames to be unique.

A node's asset carries its node name as the hostname, the node's cluster address
as its IP, the Proxmox VE version, and its CPU model as the model. Proxmox
publishes **no serial number or manufacturer**, so those stay empty unless
another source supplies them.

When an existing asset that no integration links yet already has the name a new
node, VM or container would take, Polaris does not merge them. It raises a
pending [conflict](Conflict-Resolution) (Events → Conflicts) for you to decide.

### Guest addresses

| Guest | Where the IP comes from |
|---|---|
| VM | the **QEMU guest agent** while the VM is running and the agent is enabled; otherwise a static address in its **cloud-init** settings |
| LXC container | the container's live interfaces while it is running; otherwise a static `ip=` in its network settings |

The first usable IPv4 address wins (loopback and link-local are skipped). A
guest set to **DHCP** has no address in its configuration, so when it is not
running Polaris has none to record. MAC addresses come from the guest's network
devices.

---

## Requirements

- **Proxmox VE 9.x.** The integration was built and verified against **9.2**.
  Proxmox VE 8.x has not been tested.
- **A standalone node or a cluster.** Point Polaris at any one node; it reads
  the whole cluster through it.
- **HTTPS to port 8006** on the node (or nodes) you configure.

---

## Before you add it: set up Proxmox VE

Written against **Proxmox VE 9.2**. Menu paths can move between releases.

Polaris signs in with an **API token** belonging to a user that holds the
built-in **PVEAuditor** role. PVEAuditor can read every node, guest and storage
and can change nothing.

1. **Create a user.** **Datacenter → Permissions → Users → Add**:
   - **User name**: `polaris`.
   - **Realm**: **Proxmox VE authentication server** (`pve`).
   - No password is needed. Polaris signs in with a token, not a password.
2. **Grant read-only access.** **Datacenter → Permissions → Add → User
   Permission**:
   - **Path**: `/`
   - **User**: `polaris@pve`
   - **Role**: **PVEAuditor**
   - **Propagate**: ticked.
3. **Create the API token.** **Datacenter → Permissions → API Tokens → Add**:
   - **User**: `polaris@pve`
   - **Token ID**: for example `monitor`.
   - **Untick Privilege Separation**, so the token inherits the user's
     PVEAuditor role. If you prefer to keep privilege separation on, grant
     PVEAuditor on `/` to the **token itself** as well (step 2 again, choosing
     **API Token Permission**).
4. **Copy the secret immediately.** Proxmox shows it only once.
5. **Note the full token ID.** It is `user@realm!tokenname` — with the example
   names, `polaris@pve!monitor`. Polaris needs the full form.
6. **Decide on TLS.** Proxmox ships a **self-signed certificate on port 8006**.
   Either install a trusted certificate (**System → Certificates** on each
   node) or untick *Verify TLS certificate* in Polaris.
7. In Polaris, add the integration and press **Test Connection** (see
   [below](#test-connection)).

The same from a node's shell:

```bash
pveum user add polaris@pve
pveum acl modify / --users polaris@pve --roles PVEAuditor
pveum user token add polaris@pve monitor --privsep 0
```

The last command prints the token secret. Copy it then.

Treat the secret like a password. Rotate it by creating a new token, updating
Polaris, and deleting the old token.

---

## Configuration

### General

| Field | Default | |
|---|---|---|
| Name | — | |
| Node Address | — | any node's address or hostname |
| Port | **8006** | |
| Fallback Node Addresses | blank | other nodes, one per line. **Any node answers for the whole cluster**, so these are tried in order when the address above does not answer. The integration keeps working while that node is down, and reports it offline |
| Verify TLS certificate | **on** | turn off only while the nodes still use Proxmox's self-signed certificate. With it off, a network attacker could capture the token |
| API Token ID | — | the **full** ID, `user@realm!tokenname` — for example `polaris@pve!monitor` |
| API Token Secret | — | stored encrypted. Leave blank when editing to keep the current secret |
| Enabled | on | |
| Enable auto-discovery | on | |
| Auto-Discovery Interval | **1** hour | 1–24 hours. How often to look for new, removed or migrated guests. Their state, usage and the node they run on are read on every monitor poll regardless |
| Verbose logging | off | |

Polaris tries the addresses in order, starting with the one that last answered.
Only a connection failure (refused, unreachable, timed out, name not found)
moves it on to the next address. Any answer from Proxmox — including an
authentication failure — is final, because every node would give the same
answer. When the first address dies, the first read after that takes about ten
seconds while it times out; later reads go straight to the node that answered.

### Filters

On the General tab, below the connection fields.

| Field | |
|---|---|
| **VMs** — Include or Exclude | wildcards against the **VM name**, one per line |
| **Containers** — Include or Exclude | wildcards against the **container hostname**, one per line |

Leave a list empty to sync everything. Wildcards look like `web*` or `*db*`.
**Nodes are never filtered**: they are the integration's own subject.
Templates are always skipped, whatever the filters say.

> **Narrowing a filter does not decommission anything.** A VM or container a
> new filter drops is simply no longer refreshed. Decommissioning follows from a
> guest actually leaving the cluster (see
> [below](#when-a-guest-or-node-disappears)), not from a filter change.

### Test Connection

Use it before saving, and again after changing the token. A good answer reads:

> Connected to cluster "lab" (Proxmox VE 9.2.2) — 3 node(s) (0 offline), 12 VM(s), 5 container(s)

| Addition to the message | Meaning |
|---|---|
| **(K offline)** with K above 0 | that many nodes are reported offline by their peers |
| **— cluster has NO quorum** | the cluster has lost quorum. Polaris still reads what the answering node knows, but fix the cluster first |
| **— no nodes visible: the token needs the PVEAuditor role on /** | the token signed in but can see nothing. The role is missing on `/`, or privilege separation is on and the token itself was given no role |

### Monitoring

The Monitoring tab has one subtab per class:

| Class | Auto-Monitor | |
|---|---|---|
| **Nodes** | **on** | |
| **Virtual Machines** | off | |
| **Containers** | off | |

Each subtab carries its **Auto-Monitor** toggle and its per-stream polling
settings.

---

## Monitoring through the Proxmox API

The **Proxmox** [polling method](Polling-Methods#the-proxmox-method) is the
source default for this integration's assets. It covers:

| Stream | Node | VM | Container |
|---|---|---|---|
| **Response Time** | ICMP by default | ICMP when it has an IP, otherwise the Proxmox state check | same as a VM |
| **CPU / Memory** | yes | yes, while running | yes, while running |
| **Interfaces** | yes: one node-wide row | yes: one row | yes: one row |
| **Storage** | yes: ZFS pools and other active storage | — | — |
| **Hardware Sensors** | **no** | — | — |
| **LLDP** | — | — | — |

**One cached read** of the cluster per integration every 30 seconds answers
every node and guest. Per-guest details (addresses, configuration) are read at
discovery and kept between runs, so a large guest count costs no more API calls
on each poll than a small one.

### What "response time" means here

Response time **defaults to ICMP** for every asset with an address: every node,
and every guest whose IP Polaris knows. Those get a real ping latency.

A guest with **no known address** cannot be pinged, so its response time stays
on the **Proxmox** method: up and down is **Proxmox's own state** (running is
up, stopped is down), and it is charted at **0 ms**, because a state read has no
latency to report. You can switch any asset to the other method on its
Monitoring tab.

A node **its peers report offline** probes **down** on the Proxmox method, with
the reason *Proxmox VE reports this node offline*. A node the cluster no longer
lists at all also probes down, as removed from the cluster.

If **no configured address answers**, nodes on the Proxmox method are reported
down, and **guests on the method are skipped** rather than all declared down.
On the ICMP default a node's up/down is its ping.

### CPU and memory

**Node CPU** is one figure for the whole node. Proxmox publishes no per-core
figures, so the CPU chart draws a single line.

**Node memory is split three ways**: **Used**, **ZFS ARC** and free. Proxmox's
own "used" figure includes the ZFS ARC; Polaris separates the ARC out, because
ZFS gives that memory back when processes need it.

**A guest's CPU is a share of its own vCPUs**, not of the node: a VM with two
vCPUs reading 50% is using one vCPU's worth. A guest reports CPU and memory only
while it is running.

### Interfaces

**A node's traffic is one row, *all interfaces*.** Proxmox publishes no
per-NIC counters, only a node-wide rate, so the Interfaces table on a node has
a single row covering every NIC.

**A guest's traffic is one row as well.** When a guest has several network
devices, their traffic is summed into that row. A guest reports traffic only
while it is running.

Polaris adds Proxmox's rates up into running totals between polls. A gap of more
than five minutes between polls, such as a monitor restart, starts the totals
over; the chart shows a missing point, not a spike.

### Storage

Each node's **Storage** table lists:

- **every ZFS pool** on the node, once, with its health, its last scrub or
  resilver, and its vdev layout (data, log, cache and spare groups; mirror,
  RAIDZ or a single-disk stripe) with each disk's state and read / write /
  checksum error counts;
- **every other active storage** the node mounts — directory, LVM-thin, NFS,
  Ceph RBD, CephFS and so on — as a capacity row. **Shared storage appears on
  every node that mounts it.**
- **Ceph health** (`HEALTH_OK`, `HEALTH_WARN` or `HEALTH_ERR`, with the first
  few health checks) on Ceph RBD and CephFS rows.

Storage usage is re-read at most every five minutes, not on every poll.

### No temperature

Proxmox publishes no hardware sensors, so the **Hardware Sensors** stream is not
collected on any Proxmox asset. For node temperatures, poll the node over SNMP
or install a hardware-monitoring source of your own.

---

## Cluster behaviour

- **A node its peers report offline** probes down (above). Its VMs and
  containers are then **dependency-suppressed**, so a powered-off node produces
  one alert, not one per guest.
- **If the configured node address is down**, Polaris uses the next fallback
  address. The node that went down is recorded as offline and still alerts.
- **An offline node keeps its last pool layout.** While it is down Proxmox
  reports no storage for it, and Polaris keeps what it last read rather than
  emptying the table.
- **A node removed from the cluster is decommissioned** by the next discovery
  run, under the same safety guard as guests ([below](#when-a-guest-or-node-disappears)).

---

## What you see on the asset

The asset's **General** tab has a section titled **Proxmox VE**.

On a **node**:

- platform and version, CPU threads, memory, and VM and container counts;
- a **Cluster** row: *Node online* or *Node offline*, **at last discovery**.
  The live up/down is the asset's monitor status, which refreshes on every poll.

The node's **VMs & Containers** tab lists each VM and container (linked to its
own asset), its kind, state, network and monitor status.

The pools are on the **System** tab's **Storage** table, with each pool's type
and health beside its usage. Below the table, **Pool devices** has one block per
ZFS pool; a block opens by itself when something in it is unhealthy. These
details are as of the **last discovery run**, not the last poll.

On a **VM or container**:

- a link to its node, and its state;
- its vCPUs and memory (VMs), its network (containers), and whether it starts
  at boot;
- the note **Read-only — Polaris monitors Proxmox guests but does not start or
  stop them.**

**Discover Now** is disabled on Proxmox assets. The integration's own
**Discover** reads the whole cluster in one pass, so a single-asset run would
cost the same and do less.

The [Polaris Agent](Polaris-Agent) **cannot be installed on a node or in a
container**; Polaris refuses the install. A VM can take the agent like any other
server, which also gives it per-core CPU, processes and disks from inside the
guest.

---

## Read-only by design

Polaris **never starts, stops, restarts or migrates** a Proxmox guest, and never
changes the cluster. The token is meant to be read-only (PVEAuditor), and the
integration issues reads only.

---

## When a guest or node disappears

**A VM or container that leaves the cluster is decommissioned**, unless another
integration also claims the same asset. **A node removed from the cluster** is
decommissioned the same way.

The sweep is careful about when absence counts:

- **Skipped** when part of the inventory could not be read — for example, a
  guest whose configuration Proxmox would not return. An unread guest is not a
  missing one.
- **Refused** when a single read lost more than **50 workloads or 20% of the
  cluster's workloads**, whichever is larger. Nodes are checked against the same
  guard separately. That is far more likely to be a fault than a real mass
  removal.

A guest that **migrated** is not missing: it is moved to its new node (see
[What it discovers](#what-it-discovers)).

---

## Query API

The integration card's **Query API** button sends a read to the Proxmox API,
for answering "why didn't this get discovered?" yourself. It accepts **GET
paths only**, and only those that describe the cluster, its nodes and its
guests: `/version`, `/cluster/status`, `/cluster/resources`,
`/cluster/ha/status/current`, `/cluster/ceph/status`, and under
`/nodes/<node>/` the node's status, network, storage, disks, ZFS pools, RRD data
and its guests' configuration, status, interfaces and guest-agent reads. User
and permission paths (`/access`) and every action are refused.

Saved presets cover the common reads: cluster resources, cluster status, Ceph
health, a node's status, storage and ZFS pools, a VM's configuration and
guest-agent addresses, and a container's addresses. Edit the node name and
VMID in a preset before running it.

---

## Known limits

These have **not been validated on real hardware**:

- **Ceph.** The Ceph health reading follows the Proxmox API documentation and
  has not been tested against a live Ceph cluster.
- **Guests with several NICs.** Their traffic is summed into one row; the sum
  itself has not been checked against a multi-NIC guest.
- **Clusters of more than two nodes.**
- **Proxmox VE 8.x.** Built against 9.2.
- **HA-managed guests.** A guest that the Proxmox HA manager relocates should be
  followed like any migration, but this has not been tested.

**A graceful node shutdown can page before suppression starts.** When a node is
shut down cleanly, Proxmox stops its guests about a minute before the node
itself goes away. During that minute the guests can raise **packet-loss** or
down alerts, because dependency suppression applies only once their parent node
counts as down. A hard power-off does not have this gap. For a planned
shutdown, put the node and its guests in a
[maintenance window](Maintenance-Windows) first.

---

## Troubleshooting

| Symptom | Look at |
|---|---|
| Test Connection fails with **401** | the token ID or secret is wrong. The ID must be the full `user@realm!tokenname`, and the secret is the one Proxmox showed once at creation |
| Test Connection fails with a **certificate** error | the node uses a self-signed certificate. Install a trusted one, or untick **Verify TLS certificate** |
| Test Connection says **no nodes visible** | the PVEAuditor role is missing on `/` — or Privilege Separation is on and the token itself has no role |
| *No configured Proxmox address answered* | none of the node addresses is reachable on the configured port. Check the address, port 8006 and any firewall between Polaris and the nodes |
| A VM has no IP address | the QEMU guest agent is not installed or not enabled in the VM's Options, and it has no static cloud-init address. Install and enable the guest agent |
| An LXC container has no IP address | it uses DHCP and is stopped. Its address is read only while it runs |
| A node reads down but is running | its peers report it offline (check the cluster's own view), or it is no longer in the cluster |
| Node memory looks lower than in Proxmox | Proxmox counts the ZFS ARC as used; Polaris shows it as its own **ZFS ARC** band |
| No temperature on any Proxmox asset | correct. Proxmox publishes no sensors |
| A new guest shows up as a Conflict | an unlinked asset already has that name. Resolve it in Events → Conflicts |
| A removed guest was not decommissioned | check the run's Events for a skipped or refused sweep (a guest configuration that could not be read, or too many workloads lost in one read) |
