# Business rule 76 — full narrative

> Moved verbatim out of `narrative-60-64.md` on 2026-09-22 (one narrative file per rule is the convention from
> rule 78 on; that file was at the 1500-line ceiling). Rule numbers are a stable citation key and did not change.
> The invariant is in `invariants-30-43.md`.

- [Rule 76](#rule-76) — Access is granted on the network profile the endpoint is actually on, and scoping it counts for nothing while a wider rule stands beside it

## Rule 76 — Access is granted on the network profile the endpoint is actually on, and scoping it counts for nothing while a wider rule stands beside it

The Windows onboarding script ends by putting a firewall rule on the endpoint, and the rule it
writes has always been right: `Polaris SSH (TCP 22)`, inbound TCP/22, `-RemoteAddress` the
Polaris server, `-Profile Any`. Every profile. Nothing about it was ever Private-only.

The rule beside it was the problem, and it is not ours. `Add-WindowsCapability -Online -Name
OpenSSH.Server` makes Windows create `OpenSSH-Server-In-TCP` on its way in, and Windows creates
it for the **Private profile only**, accepting TCP/22 from **any source**. Both halves of that
are wrong for a fleet, in opposite directions:

- A **domain-joined** endpoint is on the Domain profile, where that rule does not apply. On a
  host where no Polaris server address was configured — the script then wrote no rule of its
  own — sshd was installed, enabled, running and completely unreachable. The service reports
  healthy. The event log says nothing. This is the same silence business rule 72 was written
  about, arriving one step further along.
- On a **Private** network it opens port 22 to every host on that network. Firewall rules are
  additive allows: a second rule cannot narrow the first. So `-RemoteAddress 10.0.0.42` on the
  Polaris rule restricted nothing at all while this one was enabled, even though the generated
  script's own header told the operator it `scopes inbound TCP/22 to 10.0.0.42` — and so did the
  card in the UI, and so did the wiki.

The fix is to stop leaving Windows' rule unsettled, and what "settled" means follows from
whether the operator gave Polaris a server address:

| Server address | What the run leaves behind |
|---|---|
| set | the scoped Polaris rule on every profile, and `OpenSSH-Server-In-TCP` **disabled** — the Polaris rule is then the only inbound path to sshd, and the scoping claim is true |
| blank | nothing opened, and `OpenSSH-Server-In-TCP` **widened** from `Private` to `Domain, Private` — a domain-joined endpoint becomes reachable, and which sources may connect is exactly what Windows wrote |

**Public is deliberately never added.** The defect is that a domain-joined endpoint cannot be
reached; enabling an any-source TCP/22 rule on the profile a laptop picks up in an airport is a
different thing entirely, and not one an onboarding script should do on the operator's behalf.

Three details carry the weight. The lookup is by **Name**, wildcarded (`OpenSSH-Server-In-*`) —
the DisplayName is localized and the suffix is build-dependent (`-NoScope` exists on some), and
a lookup that finds nothing takes the count-0 branch rather than throwing under the script's
`$ErrorActionPreference = 'Stop'`. Both paths are **idempotent**, because each re-reads the
rule's own `Enabled` / `Profile` before acting: this script runs on every boot and every
remediation cycle. And the **detection half still judges no firewall** — it is not told whether
a server address was configured, so both settled states would read as drift half the time, which
is the boundary business rule 72 drew and this rule does not cross.

**Amended 2026-09-24:** detection is now told. `getOnboardingScript` passes `polarisServerIp` to
both builders, and detection asserts whichever of the two settled states that setting produces.
An endpoint onboarded before the remediation reached it had passed detection with Windows' rule
still Private-only, on a DomainAuthenticated network, so it was never remediated and never
reachable. The reasoning and the exact checks are in business rule 72's dated section.

What is NOT in scope here is who may use SSH once it is reachable. The script never writes
`sshd_config`: stock Windows OpenSSH has no `AllowUsers`/`AllowGroups` and password
authentication on, so every account the endpoint lets log on can authenticate. The account on
the card is only the one whose KEY is authorized. The firewall scope above is the whole of what
limits who can reach the port, which is why leaving a wider rule beside a narrow one mattered.

---

<a id="rule-77"></a>

> **Rule 77** moved to [narrative-77.md](narrative-77.md#rule-77) on 2026-09-22 (one file per rule from rule 78 on; this file was at the 1500-line ceiling).

### Rule 76 — the invariant as stated in full until 2026-09-22
> Moved here verbatim from the invariants file on 2026-09-22, when the invariant layer was cut back to the contract alone; the short invariant now points here for the reasoning and the dated history. Nothing below was rewritten.

**Access is granted on the network profile the endpoint is actually on, and scoping it counts for nothing while a wider rule stands beside it** — installing the OpenSSH Server capability makes Windows create its own `OpenSSH-Server-In-TCP`, which accepts TCP/22 from ANY source and applies to the **Private profile only**. A domain-joined endpoint is on the Domain profile, so that rule never applies to it: sshd installed, running and unreachable, with nothing in the service or the event log to say why — the silent shape the onboarding generator exists to prevent (business rule 72). The Polaris rule `Polaris SSH (TCP 22)` was already `-Profile Any` and so was never the blocked one; what blocked the fleet was the assumption that Windows' rule agreed with it. And because firewall rules are additive ALLOWS, that rule being enabled also meant `-RemoteAddress <polarisServerIp>` narrowed nothing — port 22 stayed open to every host on a Private network while the header of the generated script said `scopes inbound TCP/22 to <ip>`. So `services/sshOnboardingScript.ts` settles Windows' rule either way: with a server address it **disables** it, leaving the scoped Polaris rule as the only inbound path to sshd; with none it **widens** it from `Private` to `Domain, Private`, which changes the networks the rule applies on and never which sources may connect. Public is deliberately not added — reachable-from-Domain is the defect, an any-source TCP/22 rule on the profile a laptop picks up in an airport is not. Both paths are idempotent (they re-read the rule's own `Profile` / `Enabled`), the lookup is wildcarded by NAME (`OpenSSH-Server-In-*`) because the DisplayName is localized and the suffix is build-dependent, and the detection half still judges no firewall at all: it is not told whether a server address was configured, so either settled state would read as drift half the time.

