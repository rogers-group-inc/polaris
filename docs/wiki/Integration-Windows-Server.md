# Windows Server (DHCP)

Reads a Windows DHCP server over **WinRM** and turns its scopes and
reservations into Polaris networks and reservations.

This is the narrowest of the seven integrations: it is about **address space**,
not about devices. If you want the Windows hosts themselves in inventory, use
[Active Directory or Entra ID](Integration-Directory), or the
[Polaris Agent](Polaris-Agent).

---

## Configuration

| Field | Default | |
|---|---|---|
| Host | — | the DHCP server |
| Port | **5985** | 5986 when Use SSL is on |
| Username | — | |
| Password | — | secret |
| **Use SSL** | off | |
| Domain | — | |
| `dhcpInclude` / `dhcpExclude` | — | scope filters, wildcards |
| Workstation / Server monitor blocks | — | per-class polling for anything it owns |
| Verbose logging | off | |

`pollInterval` defaults to **4 hours** here, rather than the 12 used by the
Fortinet types.

### On the Windows side

WinRM must be enabled and reachable, and the account must be able to read the
DHCP server configuration. Standard WinRM hardening applies — prefer SSL, and
prefer a dedicated read account.

---

## What it produces

| From | Becomes |
|---|---|
| DHCP scopes | **networks** |
| DHCP reservations | reservations with `sourceType: dhcp_reservation` |
| Active leases | reservations with `sourceType: dhcp_lease` |

The same authority rules apply as everywhere else in Polaris
([rule 23](Business-Rules#rule-23)):

- **`sourceType` answers who owns the address; `dhcpBinding` answers how the
  server hands it out.** They are separate facts.
- A `dhcp_lease` row is **observed presence, not a claim** — creating a manual
  reservation over one is a plain create, not a release of someone's row.
- A `dhcp_reservation` row **is** authoritative and a create over it returns
  409.

---

## What it does **not** do

- **No device discovery.** It creates no assets of its own.
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
| Authenticates but reads nothing | the account can log in but cannot read the DHCP configuration |
| A scope appears at several sites and collides | that is what [network exclusions](IPAM#exclusions) are for |
| Reservations vanish and return | check the scope filters, and whether another integration is also discovering the same range |
| Stale lease rows accumulating | leases age out on their own; the Stale Reservations widget ranks the cleanup candidates |
