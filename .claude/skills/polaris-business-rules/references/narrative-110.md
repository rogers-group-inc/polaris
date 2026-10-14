# Business rule 110 — full narrative

> Written 2026-10-12 as its own file (one file per rule from 78 on). Rule numbers are a
> stable citation key — never renumber. 81 is a deliberate gap.

Each rule records the decision *and the incident or constraint that forced it*. The invariant is in `invariants-30-43.md`; rule numbers are a stable citation key — never renumber.

- [Rule 110](#rule-110) — An outbound host is judged by the address it is, not the text it was typed as

<a id="rule-110"></a>

## Rule 110 — An outbound host is judged by the address it is, not the text it was typed as

### Where it came from

The fourth phase of the follow-up to the 2026-10-11 whole-repository security scan: eleven findings (F169, F175, F187, F202, F210, F216, F226, F231, F245, F246, F250) that are two bugs. The guard added after the 2026-06-03 review (M4) compared the text of a host against a short list: the strings `127.x`, `169.254.x`, `::1`, `fe80::/10`, and the word `localhost`. Anything else was treated as a DNS name and allowed — but the URL parser and `getaddrinfo` accept far more spellings of an address than the dotted quad. `127.1`, `2130706433`, `0x7f000001`, `0177.0.0.1`, `[0:0:0:0:0:0:0:1]` and `localhost.` all reach loopback, and `[::ffff:7f00:1]` is what the WHATWG parser rewrites `[::ffff:127.0.0.1]` into, so the one mapped-IPv6 form the guard did handle (the dotted one) was never the form it received from a `new URL(...).hostname`. Six findings were this. Five more were callers the guard was never applied to: the credential-test typed host, the SMTP channel, a Web Push endpoint, the HA advisories probe.

### The decision

**Judge the number.** A literal is parsed with the URL parser's own rules and the resulting address is compared. IPv6 is expanded to eight groups and an embedded IPv4 (mapped, compatible, NAT64, 6to4) is judged by the embedded address. The blocked set did not change: a LAN install keeps working, because RFC1918 and ULA were never in it.

**Judge a name on the connection.** A blocklist of literals cannot say anything about `rebind.example.com`. `guardedLookup` is a `lookup` handed to the socket itself: it resolves every record and refuses the connection if any is blocked, so the address that passed the check is the address that is connected to — there is no window for a rebinding resolver to answer differently the second time. Where the client cannot take a `lookup` (the global `fetch`, `web-push`, `nodemailer`), `resolveAllowedHost` resolves first and refuses; SMTP goes on to connect to the checked address and passes the typed name as the TLS `servername`, so it is a pin there. For the global `fetch` it is a check, not a pin — the residual is a resolver that answers differently within the same second, against a hostname the operator typed into a channel they were already permitted to configure; the alternative (a userland undici `Agent` for these sends) trips the documented bundled-versus-userland undici skew in `tlsDispatcher.ts`, and was not worth it.

**Redirects.** Webhook and api_call used the global `fetch`, which follows a 3xx. A receiver that answered `302 http://169.254.169.254/` carried the POST to a host the guard never saw. Both now send `redirect: "manual"`, and a 3xx is a failed delivery.

### Decisions that were the owner's

- **The LLM "Allow loopback" opt-in is unchanged** (rule 95(g)): loopback only. `llmService` also judges the host at request time now, not only at save, because a stored host may predate the guard.
- **SMTP may be loopback.** A postfix or exim relay on the Polaris host is an ordinary setup, so the channel lifts the block for loopback only; link-local, metadata, unspecified and multicast are refused. This leaves an `automationManagement:write` user able to aim an SMTP test at a loopback port and read the first line of the answer. It was judged the smaller harm than breaking local relays.
- **The credential test keeps its response body.** The finding asked for the excerpt to go. It is the feature — an HTTP check's whole point is a string the operator picks OUT of the response — so the fix is the guard on a TYPED host (this host, link-local and metadata are refused, by literal or by what the name resolves to) and not the removal of the body. A test aimed at an asset is aimed at known inventory and is not judged.
- **A saved host that was fine and now resolves into a blocked range stops connecting.** That is the intent.
- **Save-time DNS resolution was not added** for the integration schemas: they are synchronous Zod refinements, the connect-time check is the one that cannot be raced, and a save that does a lookup per field would make every edit depend on the resolver. Literals are still judged at save, in every spelling.

### What it leaves open, on purpose

- **FortiGate / FortiManager / AD / Windows hosts that are DNS names** are judged at save (literals) and not re-resolved at connect. Their transport is `tlsFetch` and the directory clients; handing them a guarded `lookup` is the same change as the one above and is not made here.
- **`restapi` credential `baseUrl`** is operator-written config on a credential, outside the typed-host path.

### The restapi test's base URL (2026-10-13, re-scan F73)

A restapi credential is aimed at its own `baseUrl`, so the typed-host guard in `POST /credentials/test` never saw where the test went. The route now runs `resolveAllowedHost` on the base URL's host as well, answering a refusal as a test result. The live REST probe used by monitoring is unchanged — it serves assets an editor attached it to — and the connect-time pin is phase 12's (the same class as F58).

### The connection is what is judged, everywhere (2026-10-14, re-scan F58, F82)

Two callers still checked a name and then let something else resolve it again: the credential test (whose `http` type returns the response body) and the webhook / api_call delivery channels. Between the two lookups a name could rebind to loopback or the metadata address. The credential test now refuses an unresolvable typed host, dials the checked address for SSH and SNMP and connects `http` through `guardedLookup`; the channels send through `utils/guardedFetch`, an undici agent whose connect lookup is `guardedLookup`. WinRM keeps the name for its certificate check and is pinned (rule 113).
