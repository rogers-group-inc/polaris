# Installation

The authoritative, step-by-step install guide is **[`docs/INSTALL.md`](https://github.com/rogers-group-inc/polaris/blob/main/docs/INSTALL.md)**
in the repository. It is long because it covers real environments — TLS-
inspecting proxies, PostgreSQL major mismatches, split-role deployments, disk
sizing, migration from a Windows host. This page is the map of it, plus the
decisions you make before you start.

> **Upgrading an existing install? Do not follow the install guide.** Use the
> in-app updater at **Server Settings → Maintenance → Updates**. It also syncs
> the shipped systemd units and nginx config, which a `git pull` does not. See
> [Updates](Updates).

---

## Supported platforms

| Component | Minimum | Polaris targets |
|---|---|---|
| **Node.js** | 22 (`engines.node` is `>=22.12.0`) | **24 LTS** |
| **PostgreSQL** | 17 | **17** |
| **TimescaleDB** | 2.x | current |
| **RHEL / Rocky / AlmaLinux** | 9 | 9 |
| **Ubuntu** | 22.04 LTS | **24.04 LTS** |
| **nginx** (optional front end) | 1.30 | 1.30 |
| **Go** (only to build agent binaries in-app) | 1.26 | 1.26 |
| **Java** (only to code-sign agent binaries) | 25 | 25 |
| **PgBouncer** (optional) | 1.21 | 1.21 |

**Windows Server is not a supported Polaris host.** It was dropped because
TimescaleDB publishes no Windows installer, and the Windows route was a manual
copy of DLLs into the PostgreSQL tree — not something to stake a monitoring
database's retention and restore path on. This does not affect Windows as a
*monitored* estate: the agent still installs on Windows, WinRM polling is
unchanged, and the Windows Server DHCP integration still works.

**TimescaleDB is required, not a tuning option** ([rule 52](Business-Rules#rule-52)).
Every install path provisions it and every install script *errors out* rather
than warning if it cannot. An install that comes up without the extension has a
wrong disk forecast and an unrehearsed restore path from the first byte. The
plain-table fallback exists only for an external or managed database that
cannot offer the extension at all (RDS, Aurora and Cloud SQL have none;
Timescale Cloud, Crunchy Bridge and Azure Flexible Server do).

Polaris grades its own host against these dates at **Server Settings →
Maintenance → Platform Lifecycle**, and links the upgrade steps for anything
approaching end of life.

---

## Install paths

| Path | Use it when | Guide section |
|---|---|---|
| **RHEL / Rocky / AlmaLinux 9** | the common on-prem case | *RHEL / Rocky / AlmaLinux 9* |
| **Ubuntu / Debian** | same, Debian family | *Ubuntu / Debian* |
| **`-nodb` variants** | PostgreSQL is elsewhere (managed service, separate host) | both platform sections |
| **Docker / podman compose** | containerised | *Docker* |
| **Unraid** | a homelab NAS | *Docker* + the Unraid notes |
| **Split role** (`web` / `monitor` / `discovery` / `dash`) | large fleet, or a wallboard on its own process | *The split-role deployment* |

All of them do the same five things: provision PostgreSQL 17 + TimescaleDB,
create the `polaris` database and user, install Node 24, clone Polaris, and run
the platform's setup script.

---

## Before you start: three decisions

### 1. Where does TLS terminate?

Polaris supports all of these, and a change must keep working in each:

- **Direct** — Polaris holds the certificate.
- **nginx** — shipped config in `deploy/nginx/`, managed from Server Settings →
  Web Server.
- **A corporate load balancer / reverse proxy** — anything in front.
- **Plain HTTP on a lab VM** — a supported shape.

If TLS terminates at a proxy, **set `TRUST_PROXY`** in `.env`. Without it
`req.secure` is false, the session cookie is never marked `Secure`, and
[passkeys refuse to work](Troubleshooting#passkeys) with a message about it.

If a reverse proxy sits in front, it **must not add its own
`Referrer-Policy`** — OpenStreetMap blocks referer-less tile requests, so a
stripped `Referer` turns every map tile into "Access blocked".

### 2. Does your network inspect TLS?

If HTTPS is re-signed by an internal CA (Zscaler, Palo Alto, Netskope, Cisco
Umbrella), read the *Networks that inspect TLS* section **before installing**.
It is the one environment problem that can leave an install unable to update.
Umbrella is the awkward one — it works at the DNS layer, so the firewall never
shows a connection to npm's real addresses.

### 3. How much disk?

Read *Disk sizing* in the install guide before provisioning. Sample retention
dominates, and the figure scales with fleet size and cadence. Polaris then
tracks the real number for you: **Server Settings → Maintenance** shows a
capacity snapshot, a steady-state size projection and a disk forecast measured
on your install rather than assumed.

---

## Optional: `fping`

The packet-loss sweep bursts five ICMP echoes at every eligible asset each
cycle. With `fping` installed it batches these — one process per 500 targets,
so a 2000-asset fleet costs four process spawns. Without it, Polaris falls back
to per-host `ping` bursts, which is a **supported path, not a safety net**;
the sweep's cadence is simply floored at what the installed pinger can finish.

`fping` is in EPEL on RHEL. Note that on Debian it carries `cap_net_raw=ep`, so
a Polaris process without `CAP_NET_RAW` cannot execute it.

---

## After the install

1. Browse to the host. The [first-run setup wizard](First-Run-Setup) runs.
2. Create the first admin account.
3. Add your first [integration](Integrations), or start entering
   [address space](IPAM) by hand.

## Where things live

| | Path |
|---|---|
| Install root | `/opt/polaris` |
| Environment | `/opt/polaris/.env` |
| State (backups, agent binaries, instance id) | `/opt/polaris/data` |
| systemd unit | `polaris.service` (plus `polaris-monitor` / `polaris-discovery` / `polaris-dash` when split) |
| nginx config | `deploy/nginx/polaris.conf`, installed by the updater |
| Database | PostgreSQL `polaris` database, `polaris` user |
| Logs | `journalctl -u polaris` |

Every runtime variable is documented with comments in
[`.env.example`](https://github.com/rogers-group-inc/polaris/blob/main/.env.example).
