# Polaris

**Polaris is an asset management and network monitoring tool.** It pulls the
systems you already run into one dashboard: it discovers what is on your
network, keeps one record per device, watches those devices, and tells the right
people when something breaks.

The name is the point: a fixed reference you navigate by when wiring up
everything else.

---

## What it actually does

Four things, in the order a new install grows into them:

1. **Discovers what exists.** Seven integration types read your FortiManager,
   FortiGates, Entra ID / Intune, Active Directory, Windows DHCP servers,
   vCenter and Azure Arc. See [Discovery](Discovery).
2. **Keeps one record per device, from all of them.** This is the part that
   makes a central dashboard worth having. An asset that AD, Intune, Azure Arc
   and a FortiGate all know about is **one row carrying four sources**, and
   every field shows the answer from whichever source is most trustworthy *for
   that field* — not whichever system wrote last. Where they genuinely disagree,
   you get a [conflict](Conflict-Resolution) rather than a silent overwrite. See
   [Assets](Assets).
3. **Monitors those devices.** Eight independent telemetry streams over six
   transports, on a cadence you set per asset, per class or per integration.
   See [Monitoring](Monitoring).
4. **Acts when something is wrong.** Automations watch a metric, a device
   state, an event or a change; raise an alert at a severity; notify people by
   email, push or webhook; escalate when nobody answers; and run a script or
   call an API if you want them to. See [Automations](Automations).

Alongside those, it keeps a full **address registry** — blocks, networks,
individual addresses and reservations, with overlaps refused, CIDRs normalised
and deletions protected while reservations are live. See [IPAM](IPAM).

## What it deliberately does not do

- DNS record management.
- Full DHCP server configuration (scopes, policies, lease times). Individual
  reservation push and lease release *are* supported, via the Fortinet
  integrations.
- Network device provisioning.
- Cloud VPC / subnet creation (AWS, GCP, Azure).
- Acting as an identity provider. Polaris authenticates *against* local
  accounts, Azure SAML, OIDC, LDAP/AD or Entra App Proxy — it issues
  identities for nothing.

---

## Reading this wiki

| If you are… | Start at |
|---|---|
| installing Polaris for the first time | [Installation](Installation) → [First-run setup](First-Run-Setup) |
| new to an install someone else built | [Concepts](Concepts) → [Getting around](Navigation-and-Account) |
| trying to get devices into inventory | [Discovery](Discovery) → the page for your integration |
| trying to get alerted about something | [Automations](Automations) → [Triggers](Automation-Triggers) → [Actions](Automation-Actions) |
| wondering why Polaris decided something | [Business rules](Business-Rules) — 64 numbered decisions, each with the incident that forced it |
| wiring Polaris into another system | [REST API](API) |
| holding a broken install | [Troubleshooting](Troubleshooting) |

Every screen has its own page, and every page answers three questions in the
same order: **what this screen is for**, **how to configure it**, and **the
logic behind what it decides**. The third one is where Polaris differs most
from tools that look like it — a great deal of behaviour here is a considered
rule rather than an accident, and the rules are written down.

---

## The shape of an install

Polaris is one Node.js application over one PostgreSQL 17 database with
TimescaleDB. It can run as a single process or split into four roles —
`web`, `monitor`, `discovery`, `dash` — sharing that database, which is how a
large fleet is scaled. TLS terminates wherever you put it: direct, behind
nginx, behind a corporate load balancer, or nowhere at all on a lab VM.

```
     browsers ─┐
     phones  ──┼─► nginx ─► polaris (web)  ─┐
     API     ──┘                            │
                                            ├─► PostgreSQL 17 + TimescaleDB
     polaris (monitor)  ── SNMP/SSH/REST ───┤
     polaris (discovery) ── FMG/Graph/LDAP ─┤
     polaris (dash) ── NOC wallboard ───────┘
```

Every integration is optional and absent by default — discovery is something you
turn on, not something you turn off. An install with none at all still works:
you enter assets and address space by hand, and monitor them over SNMP, SSH,
WinRM, ICMP or the agent. But the integrations are the point of the thing, and
an install with one is worth more than an install with none.

---

## Versions

The version in the sidebar reads `<major>.<minor>.<commit count>`. The major
and minor live in `package.json`; the patch is the git commit count, computed
at runtime. It is embedded in backup filenames, so a backup always names the
build that produced it.

## A note on scale

Polaris is written to work at both ends of a wide range — a lab with one device
and a fleet with two thousand. Where a setting's right value depends on fleet
size, the page for that setting says so. Where a figure is measured on *your*
install rather than assumed, the screen showing it says that too.
