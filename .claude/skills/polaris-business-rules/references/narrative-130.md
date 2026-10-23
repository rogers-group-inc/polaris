# Business rule 130 — full narrative

> Written 2026-10-23 as its own file (one file per rule from 78 on). Rule numbers are a
> stable citation key — never renumber. 81 is a deliberate gap.

Each rule records the decision *and the incident or constraint that forced it*. The invariant is in `invariants-30-43.md`; rule numbers are a stable citation key — never renumber.

- [Rule 130](#rule-130) — A manufacturer custom widget polls only the assets it is switched on for, on its own cadence at the hardware-sensor interval

<a id="rule-130"></a>

## Rule 130 — A manufacturer custom widget polls only the assets it is switched on for, on its own cadence at the hardware-sensor interval

### The incident

2026-10-23. An operator built an APC profile with four PowerNet-MIB widgets (UPS status,
battery status, replace indicator, last fail cause) for a data-center UPS. The asset's
Custom MIB tab showed every card as "No sample collected yet". An SNMP Walk from the same
asset, with the same MIB and credential, read `upsBasicOutputStatus = onLine(2)` at once, so
the device, the MIB and the credential were all fine.

The widgets were not failing; they were never asked. Manufacturer widgets rode the
CPU/memory telemetry pass, and that pass is only scheduled when `cpuMemoryPolling` resolves to
something other than null or ICMP — and the widget collector additionally required it to be
SNMP. A UPS has no CPU or memory to poll, so its CPU/memory stream was left off, and with it
every widget. The workaround (set CPU/memory to SNMP) worked, but polled a stream the device
cannot answer to reach the one it can.

Two further gaps showed up in the same look: a `customWidgetIntervalSeconds` column existed on
every monitor-settings tier and a `customWidgetIntervalSec` on the asset, described as "default
60s", that nothing read and no screen showed; and a widget, once defined, started polling every
matching asset in the fleet the moment it was saved, with no way to say "only these".

### The decision

The operator's words: custom widgets run "on the same interval as hardware sensors", and
whether one polls is "a toggle on the custom widget card at the top right to enable that
specific widget on that asset" — so a widget showing on an asset does not poll it until someone
switches it on there. Creating a widget opens "a popup to enable it on the following devices".

- **Applies vs polls.** Applying stays a matter of definition (profile manufacturer + optional
  model pattern), and the Custom MIB tab still shows every widget that applies. Polling is a
  per-(asset, widget) decision, stored as an `AssetCustomWidgetEnable` row; presence is the
  switch. A new widget starts off everywhere.
- **Its own cadence.** `customWidget` is a cadence like `eventLog` or `sdwan`: its own pg-boss
  queue and worker pool, dispatched in cursor mode too, due off its own attempt stamp
  (`lastCustomWidgetAttemptAt`, rule 118) at `customWidgetIntervalSec(eff)`, which is the
  resolved hardware-sensor interval. Hardware sensors themselves still ride the telemetry pass
  today, so "the same interval" means the same SETTING, not the same timer.
- **No polling-method gate.** The switch is the gate. The SNMP half no longer reads
  `cpuMemoryPolling`; it needs only an SNMP credential, taken as the first SNMP one of
  custom-widget → hardware-sensor → CPU/memory → monitor (the sensor credential comes next
  because the widgets now share the sensor cadence), then the Fortinet integration fallback.
- **Audit per asset.** Switching changes what Polaris asks a device, so every change writes an
  `asset.custom_widget.*` Event on that asset — one per asset even for a bulk change, written
  in one `logEventsBatch`.
- **Generic API widgets are out of scope.** They are an integration's, not a profile's, carry no
  switch, and keep riding the telemetry pass.

### What an upgrade does

Turning the switch's default to OFF would have silently stopped every widget collecting on an
existing install the moment it upgraded. The migration therefore switches on every (asset,
widget) pair that produced a scalar/table or state sample in the 7 days before the upgrade
(joined to live widgets and assets, so Generic API ids and deleted rows are skipped). Pairs with
no recent data, and every widget created afterwards, start off.

### Not done here

- The dead `customWidgetIntervalSeconds` / `customWidgetIntervalSec` columns are left in place
  (dropping them is an irreversible migration for no gain) and are still read by nothing.
- Hardware sensors do not yet have an independent timer; if they get one, the widget cadence
  already reads the same setting and needs no change.
