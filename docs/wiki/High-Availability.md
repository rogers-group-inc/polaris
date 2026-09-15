# High availability

Polaris can run as an **active/standby pair** with a witness — two application
nodes over a replicated PostgreSQL, with automatic failover.

> The full operator procedure, phase by phase, is
> **[`docs/HA.md`](https://github.com/rogers-group-inc/polaris/blob/main/docs/HA.md)**
> in the repository. This page is what it is, what it costs, and the decisions
> you make before you start.

**Server Settings → High Availability.** Reads at
`serverSettingsSystem:read`; everything that hands over or revokes the keys to
the install is **`fullwrite`**.

---

## The shape

```
            ┌──────────┐
            │ witness  │   (etcd quorum member — no data, no app)
            └────┬─────┘
                 │
   ┌─────────────┴─────────────┐
   │                           │
┌──▼───────────┐        ┌──────▼───────┐
│  primary     │        │  standby     │
│  PostgreSQL  │ ─────► │  PostgreSQL  │  streaming replication
│  polaris ✅  │        │  polaris ⛔  │  application STOPPED
└──────────────┘        └──────────────┘
         ▲
    load balancer → GET /health/ready
```

**The standby's application stays stopped.** That is not an optimisation — it is
the design. Two Polaris processes on one database would both run the monitor and
discovery loops.

The load balancer monitors **`GET /health/ready`**, which answers 200 only when
the local PostgreSQL is a **writable primary** and 503 with `in-recovery` on the
standby. It runs on its own one-connection pool over the direct database URL,
never the application pool — **a saturated pool must not be able to flap a
healthy site out of a load balancer.**

---

## Before you commit

Read §2 and §3 of `docs/HA.md` properly. The short version:

| Decide | |
|---|---|
| **Where the witness lives** | the decision most likely to be regretted. It decides which failures are survivable |
| **What a failover costs you** | streaming replication has a lag window; §2 names what is lost |
| **The network** | §2 states what must be true of it |
| **Addressing** | **three planes, never mixed** — §3 |
| **Certificates** | **not optional** — §6 |

The tab's **guidance card** states **measured figures from this install** and
**admits what it could not measure**: four levels, each a coloured badge and a
sentence. Never a bare number, and never a green tick standing in for "probably
fine".

---

## Four layers stop two instances sharing one database

The last of them is the **active-instance heartbeat**, and it is the one you are
most likely to meet ([rule 62](Business-Rules#rule-62)).

An install is identified by a **uuid persisted under its state directory**, not
by the hostname — because in a container the hostname is the container id, which
the runtime regenerates on every recreate, and that made **every image upgrade
refuse to boot**.

Three consequences:

- **A stamp carrying no instance id still compares on hostname.** It was written
  by an older release, that peer may genuinely be live, and treating an unknown
  stamp as "probably me" would open exactly the hole the guard closes. The cost
  is one 90-second wait on the upgrade that introduces the id.
- **A clean shutdown releases the claim** — only ever its own, never a peer's —
  so a restart, an upgrade or a promotion waits for nothing. A `kill -9` leaves
  the stamp and the window applies as designed.
- **The instance-id file must be excluded from the standby sync.** The sync
  copies everything it is not told to skip, so without that line the standby
  inherits the primary's identity and **this layer silently stops distinguishing
  the two nodes** — undetectable in operation, because a guard that never fires
  looks identical to a guard that cannot.

---

## Building it

Two routes, both in §7: **through the tab**, or **by hand with flags**.

The tab is a **procedure**. Five cards render in build order, and a card for a
later step **returns nothing until its step applies** — it never claims a node is
installed. Everything shown comes from the cluster or from what a node has
actually asked for, so before adoption you get instructions rather than status.

It polls every 10 seconds while visible, and **never clobbers a form** — the tick
skips when the panel is hidden, when the tab is backgrounded, and when the focus
is in one of its own inputs.

### Enrolling a node

A node being built has no session, so enrollment is a **separate, unauthenticated,
rate-limited router** where the node presents a **single-use token** in the body.
Its whole surface is three calls: register, poll, claim once.

> **Redeeming a token releases nothing.** An operator must **approve** the node
> first — so a leaked script produces a request a human can reject, rather than a
> silent handover of `.env` (and therefore `POLARIS_SECRET_KEY`), the nginx
> private key and the database passwords.

**Approving is a decision made against evidence.** The pending panel shows the
node's **source address** and the **SSH host-key fingerprints it presented**,
next to the Approve button, and the confirmation repeats them plus exactly what
the bundle contains. A **witness gets a different sentence**, because its bundle
holds no application secrets.

Every rejection returns identical text, and a malformed request id 404s before
any query runs.

The bootstrap script is minted and returned in **one call** — the raw token
exists only in that response, so there is no later download to gate.

`GET /ha/status` returns **presence flags only**, never a value. An integration
test asserts that no private key material appears in it.

### Rehearse before you enable automatic failover

That is **Phase 6** for a reason. Do it.

---

## Day to day

§8 covers:

| | |
|---|---|
| **Updating Polaris** | the order matters |
| **Switching over on purpose** | |
| **TimescaleDB or Patroni upgrades** | |
| **Rebuilding the standby from scratch** | |
| **Moving the witness** | |
| **Backups** | HA is **not** a backup. Replication faithfully replicates a deletion |

---

## Not an HA pair, but related

Two other ways Polaris scales, neither of which needs any of the above:

- **Split roles** — `web` / `monitor` / `discovery` / `dash` as separate
  processes over one database. This is how a **large fleet** is scaled, and it is
  independent of HA. See *The split-role deployment* in the install guide.
- **PgBouncer** — optional connection pooling in front of PostgreSQL. Note that
  connections **multiply** across split roles; the install guide sizes it.
