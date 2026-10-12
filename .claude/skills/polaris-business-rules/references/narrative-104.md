# Business rule 104 — full narrative

> Written 2026-10-12 as its own file (one file per rule from 78 on). Rule numbers are a
> stable citation key — never renumber. 81 is a deliberate gap.

Each rule records the decision *and the incident or constraint that forced it*. The invariant is in `invariants-30-43.md`; rule numbers are a stable citation key — never renumber.

- [Rule 104](#rule-104) — The Active Directory bind account is offered only to a destination discovery chose

<a id="rule-104"></a>

## Rule 104 — The Active Directory bind account is offered only to a destination discovery chose

### Where it came from

A whole-repository security scan on 2026-10-11, before the repository was announced publicly. It reported that the Active Directory integration's bind password could be sent to an address an `assets:write` user chooses.

### Why the fallback exists

An Active Directory integration reads a directory with a service account, and that same account is very often a local administrator on the servers it discovers. Polling those servers over WinRM or SSH with it means an operator does not have to create and select a credential for every discovered host. `probeAsset` (the response-time stream), `resolveAgentlessCredConfig` (CPU and memory, interfaces and storage, event log) and the process collector each fall back to it when the asset has no credential of its own.

### What was wrong

The fallback decided WHICH secret to send but not WHERE. The destination is `asset.ipAddress`, or for WinRM and SSH `dnsName` then `hostname` when there is no address. An operator with `assets:write` can pin the address (`ipOverride`) and the name (`hostnameOverride`) and can set an asset's Response Time polling to WinRM or SSH. So pointing an AD-sourced row at a host they run, and waiting for the next poll, delivered the bind account's credentials to that host in the handshake. That secret is encrypted at rest and masked in the integration editor from everyone without `integrations`, so the path turned asset editing into a read of the directory credential. WinRM over HTTPS here does not verify the certificate, so nothing on the wire stood in the way.

### The rule

The fallback applies only while no operator has named the destination. `adBindFallbackAllowed` is false when `ipOverride` or `hostnameOverride` is set, and every fallback site passes the integration through `adBindFallbackIntegration`, which returns null for a pinned asset so the resolver finds no fallback credential. A destination that came from discovery, or from the DNS lookup on a discovered address, keeps the convenience.

### What an operator sees

An AD-sourced server whose address or name has been edited by hand stops being polled with the bind account and reports "No WinRM credential selected" (or SSH) until a credential is selected on it. That is the intended outcome and not a regression: selecting a credential is the explicit act that says "send this secret to this address", which is exactly what the bind-account fallback could not say.

### What it does not cover

Discovery itself is the other writer of an address. A host that is genuinely compromised, or an AD computer object whose `dNSHostName` an attacker controls, is outside this rule; the integration's own permissions decide who may add computers to the directory. The check also leaves the WinRM certificate unverified, which is a separate decision about how the Windows path is built.
