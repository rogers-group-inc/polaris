# Business rule 95 — full narrative

> Written 2026-10-07 as its own file (one file per rule from 78 on). Rule numbers are a
> stable citation key — never renumber. 81 is a deliberate gap.

Each rule records the decision *and the incident or constraint that forced it*. The invariant is in `invariants-30-43.md`; rule numbers are a stable citation key — never renumber.

- [Rule 95](#rule-95) — Polaris never drives a FortiGate's API-key lockout: few requests at once, nothing after a 401 until a pause runs out, and a probe it did not send is not a miss

<a id="rule-95"></a>

## Rule 95 — Polaris never drives a FortiGate's API-key lockout: few requests at once, nothing after a 401 until a pause runs out, and a probe it did not send is not a miss

### The incident

2026-10-06/07, production. One FortiGate 1801F answered the fleet's REST API token with 401
intermittently: a request would succeed and the next one, a second later, would fail. The same
token worked every time on a second 1801F and on a 91G, all on FortiOS 7.6.7 build 3704. The
gate's `httpsd` debug showed nothing for the failing requests, which pointed (wrongly) at
something else answering the address.

`diagnose debug application http_authd -1` showed what was happening. Four requests from the
Polaris server were authorized as `polaris_api`. Then, in one second, a burst of about five
requests from the same IP carried a key that matched no api-user (`No api-user found`). After
the third, http_authd logged `API key locked out for 60 seconds` and `Source IP (…) is locked out
for API key access`. For that window every request from the Polaris server got a 401, including
ones with the correct token: discovery, monitoring, the Query API tool and hand-run curl alike.
The next bad burst started it again.

The burst came from the gate's own asset. It carried a per-stream `restapi` credential holding a
stale token, while the stream's polling method was "Inherit". The asset modal hid the credential
picker for "Inherit" and kept the stored id on save, so the page said nothing was set while
`pickRestApiCredential` kept sending that token on every monitor pass. Its parallel system-info
calls (interfaces, ARP, LLDP, IPsec) arrived together, which is exactly the burst.

### What Fortinet said

FortiOS 7.6 moved REST API-key authorization into a dedicated daemon, `http_authd`, with a new
lockout keyed per source IP. TAC: it counts EVERY non-OK result as a failed API-key login,
including transient or system failures (an upgrade window, an HA transition). After
`admin-lockout-threshold` (default 3) consecutive failures it locks that source IP out for
`admin-lockout-duration`, **doubling on every repeat**, so it can grow to hours. Raising the
threshold on the gate made the 401s stop. That is a workaround that also weakens password-
guessing protection for GUI and SSH logins, not a fix.

### Why Polaris had to change, not just the token

A stale token was the trigger, but two things Polaris did turned any trigger into a long outage,
and per Fortinet the trigger does not even have to be Polaris's fault:

1. **Concurrency.** Discovery fans out seven parallel chains per gate, and the monitor passes
   fire several calls at once and overlap discovery. One bad moment, a transient http_authd
   failure included, therefore produced three or more failures in the same instant, which is
   the whole threshold.
2. **Persistence.** Polaris kept polling on schedule through the lockout. Every request it
   sent risked counting as another failure and doubling the lockout again.

### The decision

`services/fortigateService.ts → fgRequest()` is the one function every direct FortiOS REST call
goes through: the standalone FortiGate integration, FortiManager direct mode, every FortiOS
monitoring collector, the controller inventory, both push paths and the Query API tool. It is now
paced per gate by `utils/fortiosRequestGate.ts`:

- **A concurrency cap per `host:port`**, `POLARIS_FORTIOS_PER_GATE_CONCURRENCY`, default 2. Two
  is the largest number below FortiOS's default threshold of 3, so a single bad moment costs at
  most two failures before the pause below stops the rest. Waiting for a slot is FIFO and
  bounded by the request's own timeout: a waiter that runs out of time, or whose caller aborts,
  gives up without ever sending, so a wedged gate cannot build an unbounded queue of monitor
  ticks.
- **A pause after a 401.** The gate gets nothing for 60 s, doubling on each consecutive 401 up to
  30 minutes (`authPauseMs`). Any HTTP answer other than 401 ends the run. The pause is checked
  before queuing AND again after a slot is granted, so the requests queued behind the one that
  drew the 401 are refused rather than sent. A refused request throws `FortiosAuthPausedError`,
  an AppError whose message starts with the same "Authentication failed (HTTP 401)" the push
  classifiers already read.
- **Keyed by host, not token.** The lockout belongs to the source IP. A pause that only covered
  the token that failed would let every other token Polaris holds for that address keep
  knocking.
- **Transport failures do not count.** A timeout or a refused connection never reached
  http_authd and says nothing about authorization, so it neither starts nor ends a pause.

### A probe Polaris did not send is skipped

`probeFortinet` (a gate's REST response time) and `probeFortinetController` (a managed switch's
or AP's response time, read from its controller's table) catch `FortiosAuthPausedError` and
return `skipped`, the `ProbeResult` contract vCenter and FortiManager already use when Polaris
could not ask. Counting a pause as a miss would turn one token problem into the gate going down,
and through the controller probe, every switch and AP behind it at once. The link-state sweep
needed no change: a controller it cannot read already writes nothing (rule 59).

### The modal shows what is stored

`public/js/assets.js → _credentialOptionsForStream` always lists a stored credential, naming
its type when it does not fit the chosen method, and `refreshStreamCred` shows the picker
whenever the row stores one, with a note that it stays in force under "Inherit" and that
"Source default" clears it. Before this the only way to clear it was to change the polling
method and change it back, which is what the operator eventually did.

### Scope and limits

- State is in memory and per process. A split-role install (web / monitor / discovery) paces each
  role separately, so a gate can see up to the cap times the number of roles that talk to it.
- Discovery's per-gate chains now run two at a time instead of seven, so a large gate takes
  longer to discover. Gates are still discovered in parallel with each other
  (`discoveryParallelism`), so fleet-wide wall clock grows far less than per gate.
- Response time measured by a REST probe includes time spent waiting for a slot. FortiGates
  default to ICMP for response time, so this only touches gates set to REST on purpose.

Pinned by `tests/unit/fortiosRequestGate.test.ts` and
`tests/unit/assetStreamCredentialPicker.test.ts`.
