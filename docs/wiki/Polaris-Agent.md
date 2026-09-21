# Polaris Agent

A small Go binary installed on Windows, Linux and macOS hosts. It pushes
monitoring samples back to Polaris over HTTPS and holds a long-lived outbound
WebSocket for on-demand probes.

Managed from **Integrations → Polaris Agent**, and per-device from the asset
slide-over.

---

## The posture

**The agent is a satellite.** It never self-acts, and it **refuses unknown
actions**. The only queued action it accepts is `run_script` — see
[Automation scripts](Automation-Scripts#agent).

Process and service start / stop / restart control **was removed**, and full
root was retired with it.

| Platform | Runs as |
|---|---|
| **Linux** | a hardened systemd unit — `DynamicUser`, `NoNewPrivileges`, `ProtectSystem=strict` — at one of two tiers |
| **Windows** | LocalSystem, under the Service Control Manager |
| **macOS** | a LaunchDaemon, as root |

### The two Linux privilege tiers

| Tier | Grants | Enough for |
|---|---|---|
| **`unprivileged`** (default) | nothing extra | all monitoring |
| **`ptrace`** | `CAP_SYS_PTRACE` **and** `CAP_DAC_READ_SEARCH` | Application Map connection attribution |

> **The pair is load-bearing — do not grant one without the other.** A foreign
> `/proc/<pid>/fd` is an owner-only directory whose *open* is a plain DAC check
> that only `CAP_DAC_READ_SEARCH` passes; `CAP_SYS_PTRACE` is consulted only at
> the readlink step. A SYS_PTRACE-only unit fails at the open, every socket
> comes back unattributed, and **the agent collects zero connection rows while
> looking perfectly healthy.**
>
> An agent installed with the old SYS_PTRACE-only unit stays broken until
> reinstalled — the unit text is written only at install or reinstall.

The security cost is stated in every warning, and it is real:
`CAP_DAC_READ_SEARCH` bypasses read permission checks on **all** files, and
`CAP_SYS_PTRACE` reads any process's memory. Grant it deliberately.

Pick the tier on the per-asset install modal or the bulk Deploy Agent modal
(confirmation-gated). An **existing** Linux agent changes tier via **Reinstall**;
a legacy-root agent downgrades on reinstall.

### Requested vs verified

`privilegeTier` is only what was *requested at install*. Since agent 0.17.1 the
Linux agent **reports its actual capability mask on every heartbeat**, and the
installed-agents list renders the Privilege column three ways:

| Rendering | Means |
|---|---|
| pair-verified ✓ | the running unit really holds both capabilities |
| **"reinstall"** in red | a stale unit — the tier was requested but the unit does not deliver it |
| unverified, amber | no report yet |

So a reinstall visibly updates the column within one heartbeat.

---

## Installing

Three routes, all needing **`assets:fullwrite`**
([rule 43](Business-Rules#rule-43)) — deploying runs an installer on someone
else's host over a stored credential and leaves a service behind.

| Route | |
|---|---|
| **Per asset** | the asset slide-over's **System** tab carries a Polaris Agent card with an **Install Agent** button on every server and workstation that could take one — no need to pick "Polaris Agent" as a polling method first. Any other device type shows the card once an agent exists or a stream is set to the agent method. The edit modal's Monitoring tab has the same button. Neither appears on a FortiManager- or FortiGate-discovered asset or on an ESXi host: FortiOS and ESXi take no agent. On a Windows host the modal adds a **Transport** choice — **SSH** (preselected; needs OpenSSH Server running on the host) or **WinRM** — and shows the credential picker for whichever is chosen. Linux and macOS are SSH-only, and the row is hidden |
| **Bulk** | the Assets bulk bar's **Deploy Agent** — one modal collects SSH + WinRM credentials and arch; OS and transport are resolved server-side, and ineligible assets come back as **skips with reasons** |
| **Auto-deploy** | a per-class toggle on the AD / Entra / Arc integrations, off by default — pushes to newly discovered agent-less devices during discovery, bounded and paced |

Enabling an integration's auto-deploy checkbox is **the same grant, chained**
onto `integrations:write` — a capability with two doors has to be gated at both.
Only the *on* transition is gated; a role that inherits an enabled block can
still switch it off.

### What the installer does

Writes the binary, writes `agent.conf`, installs the service, starts it. The
agent then enrols on first boot, receives a bearer token, and persists it back
into `agent.conf`.

> **One Linux trap worth knowing**, because its failure mode is silent from
> Polaris's side: the installer must chown `agent.conf` to the **state
> directory's owner**, never to root. systemd chowns the *StateDirectory* to the
> dynamic UID at start but leaves files already inside it alone — so a
> root-owned conf is readable on a **first** install and **unreadable on every
> reinstall**. The installer exits 0, the row reaches "enrolling", and the host
> crash-loops on a permission error forever with nothing marked failed, until
> the enrollment token expires.

---

## SSH Deployment

**Integrations → Polaris Agent → SSH Deployment.** Polaris generates the
ed25519 keypair used to install the agent over OpenSSH, owns the credential
holding it, and emits the scripts that authorise the public half fleet-wide.

The private half is **sealed at rest and never returned by any read path**.
There is no escrow — recovery is regenerate and re-run the script, which is why
the scripts are idempotent. The public key is deliberately non-secret so the
script can be re-rendered without rotating the key.

Generating it carries a **chained** gate: `serverSettingsSystem:fullwrite`
**and** `credentials:write`, since it mints a fleet-wide admin credential.

Settings are **per platform**, and Polaris maintains one managed credential per
platform — a credential holds one username, and a Windows `DOMAIN\user` is
meaningless on Linux.

### Two scripts per platform

| Script | Does |
|---|---|
| **Remediation** | installs and starts the SSH server, optionally creates the local admin account, installs the public key with the right ACL/ownership, optionally scopes inbound TCP/22, and on Windows settles the firewall profile (below) |
| **Detection** | exit 0 = onboarded, 1 = remediate |

**Pairing them under an Intune Remediation or an SCCM Configuration Baseline is
what makes rollout self-healing** — a plain platform script runs once per device
and never retries.

Platform differences that matter:

- **Windows** — the key goes in `administrators_authorized_keys` with the
  Administrators+SYSTEM ACL sshd demands.
- **Linux** — the key goes in the user's `~/.ssh/authorized_keys` (700/600,
  correctly owned) with a `restorecon` for SELinux, **and** the script installs
  a **NOPASSWD sudoers drop-in**, validated with `visudo -cf` before install
  since a bad one locks sudo out for everyone. The agent installer runs
  `sudo -n`, so key auth alone cannot install an agent. It deliberately does
  **not** install `openssh-server`.

#### The Windows firewall rule, and the one Windows writes for itself

Installing the OpenSSH Server capability makes Windows create its own rule,
`OpenSSH-Server-In-TCP`, and that rule is **Private profile only** and accepts
**any source**. Both halves of that are wrong for a fleet:

- On a **domain-joined** endpoint the active profile is Domain, so the rule
  never applies. sshd is installed, running and unreachable, with nothing in the
  service or the event log to say why.
- On a Private network it leaves port 22 open to **every host on it**. Firewall
  rules are additive allows, so a tightly scoped Polaris rule alongside it
  narrows nothing.

What the remediation script does about it depends on **Polaris server address**:

| Server address | Windows firewall after the run |
|---|---|
| **set** | `Polaris SSH (TCP 22)` allows TCP/22 from that address on **every** profile, and `OpenSSH-Server-In-TCP` is **disabled** — the Polaris rule is the only inbound path to sshd |
| **blank** | nothing is opened; `OpenSSH-Server-In-TCP` is widened from Private to **Domain, Private** so a domain-joined endpoint is reachable. Which sources may connect is unchanged, so restrict port 22 some other way |

**Public is deliberately never added.** Reachable-from-Domain is the problem
being solved; an any-source TCP/22 rule on the profile a laptop picks up in an
airport is not. Both paths are idempotent, and the detection script does not
judge the firewall — it is not told which of the two shapes to expect.

> **The script does not decide who may use SSH.** It never writes `sshd_config`,
> so stock Windows OpenSSH rules apply: no `AllowUsers`/`AllowGroups`, and
> password authentication on. Every account the endpoint lets log on can
> authenticate once sshd is running — the account on the card is only the one
> whose **key** is authorized. The firewall scope above is what limits who can
> reach the port. On an endpoint that already ran sshd, the script leaves its
> config alone: it starts the service only if stopped, **appends** the key, and
> sets the service to start Automatically.

### The account Polaris signs in as

Section **2** of the card, and the setting most likely to bite:

| Mode | What the script does |
|---|---|
| **Use an existing administrator account** | installs the key **only**. It does not create the account or change its group membership — but it does **verify** both, and stops with `error: account … does not exist on this host` rather than installing a key for an account that is not there |
| **Create a dedicated local account on each endpoint** | creates it with a random password it never reports (key auth only), and adds it to Administrators |

Existing mode verifies without changing anything: choosing an account you
already have is not asking Polaris to create one, or to promote one to
administrator. If the check fails, the fix is yours to make — then the next
remediation pass succeeds on its own.

A created Windows name is capped at **20 characters** — the limit `New-LocalUser`
enforces — and is refused on save rather than failing later on every endpoint.
`DOMAIN\user` is legal only with an **existing** account: a domain account
cannot be created locally.

**Troubleshooting a login that fails after a successful onboarding run.** If an
agent install or upgrade reports `All configured authentication methods failed`,
the account is the first thing to check, not the key. `administrators_authorized_keys`
is **machine-wide** — it authorises any member of Administrators — so the key
lands correctly even when the account named on the card does not exist, and
every later login then fails in a way that reads like a key problem.

**Detection catches this**, on both platforms (business rule 72). It checks the
account as well as the key, and reports which part is missing:

| Detection output | Meaning |
|---|---|
| `remediate: local account <name> missing` | the account is not on the endpoint |
| `remediate: local account <name> is disabled` | it exists but cannot log in |
| `remediate: <name> is not a member of Administrators` | it exists but the agent installer cannot use it |
| `ok: Polaris SSH onboarding present (<name> is a local administrator)` | ready |

A domain account (`DOMAIN\user`) is invisible to `Get-LocalUser`, so for one of
those only the group membership is checked.

If you want to confirm by hand, run `Get-LocalUser` and `Get-LocalGroupMember
-Group Administrators` on the endpoint against the username the managed
credential carries. On an Entra-joined endpoint `Get-LocalGroupMember` may list
members as raw `S-1-12-1-…` SIDs, or fail outright; the detection script falls
back to the `WinNT://` provider for exactly that reason, so trust its verdict
over a bare `Get-LocalGroupMember` that errored.

> Before this check existed, a fleet could report **Detection: Without issues**
> and **Remediation: Not run** on endpoints where the account had never been
> created — indistinguishable, in the Intune console, from a healthy one. If you
> have been running an older generated pair, regenerate both halves from the
> card: machines in that state will report as needing remediation on their next
> pass and fix themselves.

The scripts are **delivery-neutral and fleet-generic** — no machine-specific
values — so the same body runs under Intune, GPO startup, SCCM, Arc, an RMM or a
one-off remote invocation.

Operator input (`username`, the Polaris server IP) is **rejected, not escaped**:
it lands in a script an admin runs fleet-wide as SYSTEM.

### Publishing

Two vehicles, each opt-in per integration:

- **[Intune](Integration-Directory#publishing-scripts-to-intune)** — Windows
  only, and Polaris **never assigns** the Remediation.
- **[Azure Arc Run Command](Integration-Azure-Arc#publishing-scripts-via-run-command)** —
  Windows **and Linux**, the only vehicle reaching Linux or Windows Server, with
  explicit target selection as the review gate.

---

## SSH host-key verification

Opt-in per credential (default **off**; **on** for newly created ones), and it
**fails closed** ([rule 21](Business-Rules#rule-21)).

Trust-on-first-use:

| State | Result |
|---|---|
| no pin stored | **stores and accepts** |
| pin matches | accepts |
| **key changed** | **refuses the connection** and stamps an event |
| internal error | **refuses** — it never silently skips |

Pins are per (host, port) in their own table, never on the credential.

---

## TLS certificate pinning

The agent does **not** use system roots. It compares the server's leaf
certificate SHA-256 against a pin set carried in `agent.conf`.

The pin embedded at install comes from the same certificate file nginx serves,
and **a reinstall re-reads the live certificate** rather than trusting the stored
one — otherwise a reinstall against a host first enrolled before a rotation
would bake in the stale pin, the handshake would fail, and the agent would sit
forever at "enrolling".

### Rotating the certificate without breaking the fleet

**Server Settings → Maintenance → Polaris Agent → Cert pin rotation.** Each
agent carries a canonical pin plus a list of staged additional pins; the **union
is its trust set**.

1. **Stage** the new pin. It propagates fleet-wide; online agents apply within
   seconds over the WebSocket, offline agents on their next config poll.
2. **Rotate** the server certificate. Agents keep working — both pins are
   trusted.
3. **Retire** the old pin. If the canonical one is removed and a staged pin
   remains, the first staged pin is promoted.

> The union **must never be empty** for an active agent — a removal that would
> empty it is skipped and reported. An empty pin set bricks the agent's TLS
> dialer until a manual reinstall.

`agent.conf` always carries both the new multi-pin key and the legacy
single-pin key, so a downgrade to an older binary keeps working.

---

## What the agent collects

| Stream | |
|---|---|
| responseTime | its own heartbeat |
| cpuMemory, temperature, interfaces, storage | host telemetry |
| — *per-core CPU and the memory breakdown* | **agent only** — see below |
| **processes** | **agent-default-ON** — an installed agent collects its process inventory automatically |
| eventLog | opt-in, behind a global master switch (PII and volume) |
| Application Map connections | needs the **`ptrace`** tier on Linux |

The storage and interface collectors run under a 30-second guard, because
`statfs` and interface ioctls can **block indefinitely** on a hung filesystem or
an unresponsive NIC — without it the whole push loop freezes while the heartbeat
keeps running and the agent looks connected.

### Per-core CPU and the memory breakdown

An agent-monitored host is the only kind whose **CPU** chart on the Assets →
System tab draws **one coloured line per logical core** alongside the
cross-core average, and whose **Memory** chart is a **stacked area in bytes**
rather than a single percentage line. No other transport — FortiOS, SNMP,
WinRM, vCenter, SSH — can report either, so on those assets the two charts
fall back to a single line each.

On the CPU chart:

- The **Average** line is the one every automation threshold reads. It stays
  on top and is the only line that dives to the baseline across a missed poll.
- The legend lists **Average** plus a chip per core. **Click a chip to isolate
  that core**; click it again, or click **Average**, to bring the rest back.
  The isolation survives the chart's automatic refresh.
- Hovering names the six busiest cores at that moment (or just the isolated
  one). On a host with many cores, isolate before you hover.
- **Per-core detail is kept for the detail-retention window only** (7 days by
  default — Server Settings → Retention). Longer ranges are served from
  hourly/daily rollups, which keep the average alone; the chart says so when
  that is why the cores are missing.

On the Memory chart the bands stack to what is actually in use, against a
dashed line at the installed total — the gap between the two is free memory:

| Band | |
|---|---|
| **Processes** | resident in running programs |
| **Buffers** | Linux block-layer buffers (absent on Windows) |
| **Cache** | page cache (Linux) / system cache (Windows) |
| **Swap / page file** | a dashed line, *not* a band — it is backing store, not RAM, so it stacks with nothing |

Two figures here are commonly misread elsewhere and are deliberately not:
Windows **cache** is the standby cache, which the usual API hides inside
"available" memory, and Windows **page file** is the page file itself rather
than the commit charge (which counts pages never written to disk and reads far
higher).

---

## Upgrading

**An upgrade never refuses for want of a credential it can find itself, and
never records one it has not proved** ([rule 49](Business-Rules#rule-49)).

The credential is resolved in one order:

```
an explicit credentialId on the request
  → the credential recorded at install
    → the Polaris-managed SSH deployment credential for the platform
```

- **An id that no longer resolves counts as absent, not as an error** —
  deleting a credential would otherwise silently strand every agent installed
  with it, and an install predating the column never had one at all.
- **Only an explicit credential that fails to resolve is an error**: an operator
  who names a credential is told it is wrong rather than quietly connected with
  another.
- **The transport follows the credential's type**, never the row's recorded
  transport.
- **An adopted credential is written back only on success.** Reaching the host
  is the proof. A genuinely WinRM-only box fails, keeps what it had recorded,
  and lands as `upgrade_failed` with a real reason — itself an upgradeable
  status.
- An operator override is **never** adopted; Polaris does not record a choice it
  did not make.
- A host the fan-out still cannot upgrade writes an `agent.upgrade_skipped`
  Event, so the silence that hid this is gone.

**Upgrade only.** Install, reinstall and uninstall still require a credential on
file; force-remove is the escape hatch.

---

## Building agent binaries in-app

**Integrations → Polaris Agent** carries a build card: cross-compile the agent
for the platform matrix from the Go toolchain on the Polaris host, with an
optional **code-signing** step for Windows binaries against your internal CA.

Go is needed only for this. Java is needed only for signing. Without either,
nothing else changes — you can download prebuilt binaries instead.

---

## Service & Process Discovery Rules

The card above the build card. Named rules that pin process and service items on
the assets they select — now **and** on assets discovered later.

Each rule has a **mode**:

| Mode | |
|---|---|
| **Monitor + map** | Application Map **and** telemetry — mapping implies monitoring |
| **Monitor only** | per-program CPU/RAM and logs, per-unit journal tailing; never touches map pins |

A four-step wizard: name → devices → items → summary. The **item step is
scope-driven** — it lists only what the selected devices report, which is what
keeps a rule from pinning a unit on every host that happens to run it.

Rules only ever target workstations and servers, since nothing else reports an
inventory.

**Auto rules:** ticking Monitor or Map on an asset's Services tab mints a
single-item auto rule for that asset; pinning the same item elsewhere
consolidates into it; un-ticking removes the asset, and an auto rule losing its
last asset is deleted. Editing an auto rule in the wizard converts it to manual.

**Mapping implies monitoring, one way.** Nothing ever writes a map pin from a
monitor pin. Removing an item or disabling a rule stops future auto-pinning; a
separate **Unmap everywhere** action does the actual strip.

---

## Troubleshooting

| Symptom | Look at |
|---|---|
| Stuck at "enrolling", host crash-looping | the Linux `agent.conf` ownership trap above — reinstall |
| Agent connected but the Application Map is empty | the Linux privilege tier. Check the **Privilege** column for "reinstall" — a SYS_PTRACE-only unit collects nothing while looking healthy |
| TLS handshake fails after a certificate rotation | the pin. Stage the new pin **before** rotating |
| Samples stop but the heartbeat continues | a hung filesystem or NIC in a collector — the 30 s guard bounds this on current builds |
| Upgrade silently skips a host | check for `agent.upgrade_skipped` Events; on older builds this was completely silent |
| `agent.disconnected` alerts never clear | the counterpart reset — an event automation should clear on `agent.connected`, scoped to the same subject ([rule 32e](Business-Rules#rule-32)) |
