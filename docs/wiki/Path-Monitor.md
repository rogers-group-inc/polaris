# Path Monitor

A path check tests whether a web page, a service or an address can be
reached **from the machines that run the Polaris Agent**, not from the Polaris
server. Each matching host runs the check on its own schedule and reports:

- whether it passed, and how long it took (split into DNS, connect, TLS and
  time-to-first-byte for web checks);
- for web checks, the HTTP status, whether the body matched, the TLS
  certificate's issuer and expiry, and a fingerprint of the response;
- a **traceroute** of the path the traffic took, with each hop matched to the
  device Polaris monitors at that address.

Checks live on the **Path Monitor** page (sidebar, under Application Map). Results appear on each host's
**Paths** tab and on the check's **Results** view.

> A check measures the path from a host. It **never changes that host's own
> Up / Down status** — a laptop that cannot reach the intranet is not a laptop
> that is down ([business rule 85](Business-Rules#rule-85)).

## What you need

- The **Polaris Agent 0.21.0 or later** on the hosts that should run the check.
  Older agents are listed on the check's Results view with *upgrade agent*;
  they run nothing until upgraded.
- The **Path Monitor** permission. *Read-Only* shows the list and the
  results; *Read-Write* creates, edits and deletes checks. It is its own
  permission because a check tells every matching agent to send traffic to a
  destination on a schedule.

No extra privilege is needed on the hosts. HTTP, HTTPS, TCP, ping and
traceroute all run under the agent's normal (unprivileged) service account. The
one exception is below under *Troubleshooting*.

## Creating a check

Click **+ Add check**. The dialog has four tabs.

### General

| Field | What it means |
|---|---|
| **Kind** | **HTTPS** / **HTTP** send one `GET` request. **TCP** opens a connection to a port. **ICMP** sends one ping. |
| **Target** | A full URL for HTTP / HTTPS (`https://intranet.example/health`), `host:port` for TCP (`db01.example:5432`), a host or IP address for ICMP. |
| **Every (minutes)** | How often each host runs it: 1 to 60 minutes. |
| **Timeout (ms)** | How long a run may take before it fails: 500 to 30 000 ms, and at most half the interval. |

Some targets are refused: loopback, link-local (including cloud metadata
addresses), multicast, IPv6 addresses, URLs with a user name or password in
them, and the Polaris server itself. Private (RFC 1918) addresses are allowed.
The agent checks the address again after it resolves the name.

### Expectations (HTTP / HTTPS only)

- **Accepted status codes** — codes and ranges, comma-separated, e.g.
  `200,204,300-399`. Blank means any 2xx. Redirects are never followed, so a
  302 is judged as a 302.
- **Body must** contain / equal exactly / match a regular expression. Checked in
  the first 64 KB. Regular expressions run on the agent, which does not support
  lookahead, lookbehind or backreferences.
- **Verify the TLS certificate** — on by default. Off accepts any certificate;
  the check still reports the certificate's issuer and expiry.
- **Keep a body excerpt on every run** — see *What is stored* below.

TCP and ICMP checks pass when the connection (or the ping reply) arrives within
the timeout.

### Traceroute

On by default. A traceroute runs on the first run, every *N* runs after that
(default 5), and **immediately whenever a run fails after a passing one**, so a
failure always has a fresh path to look at. *Max hops* (default 30) and *Probes
per hop* (default 3) set how far and how thoroughly it looks.

macOS agents do not trace in this version; their checks still run.

### Sources

Which hosts run the check. It is always limited to hosts with an active Polaris
Agent. Either tick **All agent hosts**, or build a device filter with the same
condition builder the automation wizard uses (for example *Tag has
branch-office*). The preview underneath lists the hosts that will run it.

Tick the box beside a host to **pin** it: a pinned host keeps running the check
even if it stops matching the filter.

A host runs at most 20 checks. If it matches more, it runs the oldest 20, and
Polaris writes a `path_check.agent_over_cap` event naming it.

## Reading the results

**Results** (from a check's row menu) lists every host that runs it, with the
latest result, latency, HTTP status, resolved address, hop count and the last
error. It refreshes on the check's interval while it is open. Click a host to
open its Paths tab.

The host's **Paths** tab shows:

- a table of every check the host runs — click one to see it below;
- **Latency** over time. Failed runs show as red dots on the baseline. Use the
  chips above the chart to add the DNS, Connect, TLS and TTFB lines. If an
  automation sets a latency SLA on this check, its threshold is shaded on the
  chart;
- **Availability** — the share of runs that passed. A gap means the agent did
  not report (for example, the host was off), not that the check failed;
- **HTTP status** — one cell per run, green for a pass and red for a failure;
- **Latest result** — including the body fingerprint and size, the TLS issuer
  and how many days are left on the certificate, and the error text;
- **Path** — the traceroute, as a graph and a table. Pick an earlier trace
  from the list to compare. Hops that changed since the previous trace are
  marked in the table. A hop that is a device Polaris monitors links to it,
  with its status at the time of the trace, and shows the subnet it sits in.

### Reading the path graph

The graph combines the host's last ten traces. It reads left to right: this
host, then one column per hop, then the destination.

- **Branches** are routes that changed. When recent traces took different
  routers at the same hop, the graph splits there and joins again where the
  routes meet. Thicker links were taken by more traces.
- **The selected trace** is drawn solid on top; the other routes are faded.
  Each of its links is coloured by the latency that hop **adds**: green under
  10 ms, amber for 10–50 ms or when some probes got no reply, red over 50 ms.
  The red link is usually the one to look at.
- **Circles** carry the hop number. A hop Polaris monitors is filled with its
  status colour — click it to open the device. A dashed `*` is a router that
  did not reply; that is common and does not mean traffic stopped there.
- **A dashed red link with a cross** into the destination means that trace
  never reached it.

Hover a circle for its address, reverse DNS, round-trip times, lost probes and
how many of the recent traces passed through it.

## Alerting — setting an SLA

A check has no threshold of its own. To be alerted, create an
[automation](Automations) on one of the path-check metrics:

| Metric | Meaning |
|---|---|
| **Path latency** | ms for a run. A failed run has no latency. |
| **Path failure rate** | % of runs that failed over the *History* window, like packet loss |
| **Path check result** | *Reachable* / *Unreachable* for each run |
| **Path HTTP status** | the status code returned |
| **Traceroute hop count** | hops in the latest traces |
| **TLS certificate days remaining** | days until the target's certificate expires |

Pick the check in the condition's **Check** picker, or leave it blank to watch
every check each host runs (one alert per check). In the **Devices** step,
*Polaris Agent installed is equal to yes* selects every agent host. Holds,
severity bands, resets, maintenance windows and dependency suppression all work
as for any other automation.

For route changes, use a **Change** trigger with **Path changed
(traceroute)**. Polaris writes this event (`path_check.path_changed`) at most
once every 10 minutes per host and check, naming the host.

## What is stored

| Kept | For how long |
|---|---|
| Each run's result, timings, status, fingerprint (SHA-256) and size of the body | the *Path checks* row of the Retention card (Server Settings → Maintenance), default 7 days raw / 30 days hourly / 365 days daily |
| Up to 4 KB of the response body — **only when the run failed**, or on every run when *Keep a body excerpt* is on | the same |
| Traceroutes | the *Path traceroutes* row, default 30 days |

Response bodies can contain sensitive data. Leave *Keep a body excerpt* off
unless you need it.

Deleting a check stops the agents running it on their next config refresh
(within a few minutes). Its past results are not deleted immediately; they age
out on the retention schedule.

## Troubleshooting

| Symptom | Look at |
|---|---|
| A host never shows results | the agent version (0.21.0+), and whether the host appears on the check's Results view. A host that is not listed does not match the Sources |
| ICMP check fails with `icmp unsupported on this host (ping_group_range)` | Linux only. See [Polaris Agent → Troubleshooting](Polaris-Agent#troubleshooting) for the one-line fix. HTTP, TCP and traceroute are unaffected |
| Every hop after the first shows `* * *` | the network drops the ICMP replies traceroute relies on. The check result is unaffected |
| An HTTPS check fails with a certificate error | the host does not trust the target's certificate. Fix the certificate or its chain, or turn off *Verify the TLS certificate* |
| A 302 fails the check | redirects are never followed. Point the check at the final URL, or accept `300-399` |

See also: [Polaris Agent](Polaris-Agent), [Automation triggers](Automation-Triggers), [Business rule 85](Business-Rules#rule-85).
