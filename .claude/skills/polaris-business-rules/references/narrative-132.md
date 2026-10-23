# Business rule 132 — full narrative

> Written 2026-10-23 as its own file (one file per rule from 78 on). Rule numbers are a
> stable citation key — never renumber. 81 is a deliberate gap.

Each rule records the decision *and the incident or constraint that forced it*. The invariant is in `invariants-30-43.md`; rule numbers are a stable citation key — never renumber.

- [Rule 132](#rule-132) — A Hardware Sensors table is what its profile row says, and nothing a vendor ships is in code

<a id="rule-132"></a>

## Rule 132 — A Hardware Sensors table is what its profile row says, and nothing a vendor ships is in code

### What was found

2026-10-23, while writing the manufacturer-profile skill for the Polaris toolbox plugin: a
Hardware Sensors row of type `table` saved, showed READY when its symbol resolved, and was
then ignored. `collectHardwareSensorsSnmpCore` walked FortiGate's fgHwSensorTable from three
OID literals in `monitoringService`'s `OID` map whenever the manufacturer matched /fortinet/
OR the row said `table`, and never read the row's symbol. So a table row on any other vendor
walked Fortinet's columns, found nothing, and fell through to ENTITY-SENSOR-MIB. The
profile page could not describe a sensor table at all, only point at the one that was
hardcoded. It was also the last Fortinet stream that worked without the vendor's MIB, and
the clearest remaining breach of the vendor-SNMP knowledge boundary (Phase 5b of the
uniform-SNMP plan: "the hardware-sensor table becomes the first declarative table stream").

The hardcoded walk also had a quiet bug: a sensor whose value column was blank read
`Number("") = 0`, a confident zero for a reading that never arrived.

### The decision

The operator chose the generic table over refusing non-Fortinet table rows, and, when asked
what an install without FORTINET-FORTIGATE-MIB should do, chose to **accept the break** rather
than ship the vendor MIB or keep a code fallback. The reasoning is Phase 3's: vendor symbols
resolve only from the vendor's uploaded MIB, and readiness (the profile page and the boot
`manufacturer_profile.unresolved` Event) names what is missing.

- **The row's symbol is the VALUE column.** The rest of the table is one JSON field beside it,
  `SensorColumns`: a name column, an alarm column with a mapping (the state-probe modes, so a
  vendor's polarity is declared rather than assumed; `nonzero` when none is given), a fixed
  sensor class for tables whose row names say nothing ("Probe 1"), and a `tenths_to_units`
  scale for DISPLAY-HINT "d-1" columns. One JSON field rather than four columns keeps the
  migration, the API, export / import and the editor to a single new field each.
- **Only a `table` row walks a table.** The manufacturer dispatch is gone. A FortiSwitch or
  FortiAP that inherits the Fortinet row still walks it, gets nothing, and falls through as
  before. A Fortinet device governed by no profile row no longer walks fgHwSensorTable at all.
- **The join is pure** (`utils/hardwareSensors.ts → sensorTableRows`) and is held to the old
  walk by a parity test fed FortiGate's columns. The one declared difference is a blank value:
  null now, 0 before.
- **Columns follow the effective type,** as state probes' mappings do: refused on a metric that
  has no sensor table (a typo the resolver would ignore), cleared from a temperature row that
  is not or no longer a table, so a later flip back cannot resurrect stale columns.

### What an upgrade does

Migration `20261024020000_sensor_table_columns` adds the two JSON columns and rewrites every
temperature `table` row (metric row or override) whose symbol is `fgHwSensorTable`, which is what
the Phase 4 seed and migration wrote, to `fgHwSensorEntValue` with `FORTIGATE_SENSOR_COLUMNS`.
Those rows then collect exactly the sensors they did, **provided FORTINET-FORTIGATE-MIB (and
FORTINET-CORE-MIB) is uploaded under the profile's manufacturer.** Without it they report
unresolved, as the profile's CPU and memory rows already did. Any other `table` temperature row
keeps its symbol, which is now honoured as its value column. The seed (`profileToMetricSeeds`)
and an import of a pre-rule export file (`upgradeLegacySensorTable`) produce the same row, and
`seedManufacturerProfiles.test.ts` reads the migration's JSON to hold the two together.

### Who it affects

FortiGates polled over SNMP. A FortiGate monitored through FortiManager or the FortiOS REST API
reads sensors from `sensor-info` and never touches this path. A fresh install seeds only Cisco,
so on a new install SNMP-polled FortiGates get sensors only once someone creates a Fortinet
profile with this row and uploads the MIB.
