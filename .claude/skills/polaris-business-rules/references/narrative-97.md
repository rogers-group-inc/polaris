# Business rule 97 — full narrative

> Written 2026-10-08 as its own file (one file per rule from 78 on). Rule numbers are a
> stable citation key — never renumber. 81 is a deliberate gap.

Each rule records the decision *and the incident or constraint that forced it*. The invariant is in `invariants-30-43.md`; rule numbers are a stable citation key — never renumber.

- [Rule 97](#rule-97) — The all-zero MAC means "no MAC": it never becomes an asset's MAC, and a reservation refuses it as a change

<a id="rule-97"></a>

## Rule 97 — The all-zero MAC means "no MAC": it never becomes an asset's MAC, and a reservation refuses it as a change

### Why

`00:00:00:00:00:00` is never a device's address. FortiOS reports it for loopback, tunnel and
unconfigured interfaces and for a reserved-address entry with no MAC set; an agent can report it
when the host's primary adapter is a VPN or virtual NIC. Stored as an identity it is worse than
nothing: two unrelated devices that both report zero would meet in the MAC index and merge.

Discovery's identity paths had refused it since the 2026-08 MAC consolidation
(`normalizeMacOrNull` / `macHexKeyOrNull`, and the ARP and detected-device filters). The gaps
were everywhere else: the operator create, edit and CSV-import routes checked format only; the
reservation routes likewise; the agent heartbeat used the loose normalizer; the AssetMacAddress
side table kept zero on purpose ("stores what the device reported"); and discovery's DHCP-lease
and device-inventory phases could reach an asset by HOSTNAME and then push the lease's zero MAC
into its list, where `selectPrimaryMac` could promote it.

### The decision

- `utils/mac.ts → isAllZeroMac()` is the one test, in any separator style.
- **Assets: zero parses to "no MAC", never to an error.** The asset create/update Zod schema
  turns it into `null`: a create stores no MAC, an update clears the field. Refusing would
  strand any asset that already holds a zero — its edit form sends the MAC back on every save,
  so an unrelated edit would 400. The CSV import skips a zero cell like an empty one.
- **Side table and primary pick drop zero at the writers**: `reconcileMacAddresses`,
  `foldMacsToRanges` (interface scrape) and `buildMacRowsForCreate` drop it, and
  `selectPrimaryMac` never returns it. Because `reconcileMacAddresses` deletes rows not in the
  new set, an old zero row disappears on the asset's next reconcile.
- **Discovery** skips a zero-MAC DHCP entry outright, and normalizes FortiSwitch / FortiAP base
  MACs and device-inventory MACs strictly.
- **Reservations refuse zero with a 400 the operator can act on** (blank, or Generate). A
  reservation is a MAC→IP binding, and on a push-eligible subnet a zero would be written to the
  FortiGate as a live entry. An update refuses it only as a CHANGE: a row already holding zero
  (written before this rule, or mirrored from the gate) stays editable when the form echoes it.
- **Global search still accepts zero**, so an operator can find stragglers
  (`macColonUpperOrNull` stays loose for reads).

### The migration

`20261008140000_null_all_zero_macs` clears `Asset.macAddress` where it is zero (one
`asset.mac.cleared` Event per asset, actor `system:migration`, timestamp in UTC because the
column is a naive TIMESTAMP) and deletes zero rows from `asset_mac_addresses`. Reservations are
deliberately not touched: nulling a zero that mirrors the gate's own entry would make Polaris and
the gate disagree, and the echo carve-out above keeps those rows editable.

### Scope and limits

- Discovery's reservation mirror (`dhcp_reservation` / `dhcp_lease` rows from the gate) still
  stores whatever the gate holds, zero included. Those rows never act as an asset identity: the
  match keys reject zero.
- Interface samples (`AssetInterfaceSample.macAddress`) record what the device reported per
  interface, zero included. They are telemetry, not identity.

Pinned by `tests/unit/mac.test.ts`, `tests/unit/macAddresses.test.ts`,
`tests/unit/interfaceMacRanges.test.ts`, and the all-zero cases in
`tests/integration/reservations.test.ts` and `tests/integration/assetPutContract.test.ts`.
