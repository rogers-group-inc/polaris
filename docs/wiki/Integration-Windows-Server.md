# Windows Server (DHCP)

Reads a Windows DHCP server over **WinRM** and turns its IPv4 scopes into
Polaris networks.

This is the narrowest of the nine integrations: it is about **address space**,
not about devices. If you want the Windows hosts themselves in inventory, use
[Active Directory or Entra ID](Integration-Directory), or the
[Polaris Agent](Polaris-Agent).

---

## Configuration

The modal has two tabs, **General** and **Monitoring**.

| Field | Default | |
|---|---|---|
| Host | — | the DHCP server |
| Port | **5985** | 5986 when Use SSL is on |
| Username | — | |
| Password | — | secret |
| Domain | — | optional; sent as `DOMAIN\username`. Leave empty for a local account |
| **Use SSL** | off | HTTPS on 5986 |
| Enabled | on | |
| Auto-Discovery Interval | **4 hours** | 1–24 |
| Include / Exclude Scopes | — | scope filters, one per line |
| Verbose logging | off | |

`pollInterval` defaults to **4 hours** here, rather than the 12 used by most
other types.

The scope filters are **case-insensitive substring matches** against the scope
name or the scope ID (e.g. `10.0.1.0`) — not wildcards. Include narrows first,
then Exclude removes.

The Monitoring tab carries the same Workstations / Servers blocks as the
directory types, `addAsMonitored` only. This type creates no assets, so they
have nothing to act on.

### On the Windows side

- **WinRM** must be enabled and reachable, and must accept **Basic
  authentication** — that is how Polaris authenticates. Over plain HTTP (5985)
  that also means allowing unencrypted traffic, which is the reason to prefer
  **Use SSL**.
- With Use SSL on, the server's certificate must be **trusted by the Polaris
  host**; there is no skip-verification option on this type.
- The account must be able to run `Get-DhcpServerv4Scope` remotely — typically
  membership of **DHCP Users** plus remote-management rights. Prefer a dedicated
  read account.

**Test Connection** checks that the **DHCP Server service is running**, not
just that WinRM answers.

---

## What it produces

| From | Becomes |
|---|---|
| IPv4 DHCP scopes (`Get-DhcpServerv4Scope`) | **networks**, named after the scope |

That is all it reads. Reservations and leases on a Windows DHCP server are
**not** imported — address-level DHCP data in Polaris comes from the Fortinet
integrations.

Networks it created are **deprecated** only when they were discovered from a
server that is no longer this integration's Host. A scope deleted on the server
is not deprecated on the next run; retire that network by hand.

---

## What it does **not** do

- **No device discovery.** It creates no assets of its own.
- **No reservations or leases.** Scopes only.
- **No push.** There is no DHCP Push or Quarantine Push tab — those are Fortinet
  surfaces. Polaris reads this server; it does not write to it.
- **No fleet-absence pass.** Nothing here decommissions anything.

Full DHCP server configuration — creating scopes, server policies, lease-time
settings — is explicitly [out of scope](Home#what-it-deliberately-does-not-do)
for Polaris.

---

## Troubleshooting

| Symptom | Look at |
|---|---|
| Connection refused on 5985 | WinRM is not listening, or you meant 5986 with **Use SSL** |
| "Authentication failed" | Basic auth disabled on the WinRM service, a wrong Domain, or a bad password |
| "DHCP Server service status … not running" | the account connected, but the DHCP Server role is stopped or not installed on that host |
| Authenticates but reads nothing | the account can log in but cannot read the DHCP configuration |
| A scope appears at several sites and collides | that is what [network exclusions](IPAM#exclusions) are for |
| A scope is missing | check the Include / Exclude lists — they are substring matches, so a short pattern can match more than you meant |
| A deleted scope's network is still active | expected — see [What it produces](#what-it-produces) |
