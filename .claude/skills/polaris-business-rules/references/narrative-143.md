# Business rule 143 — full narrative

> Written 2026-11-06 as its own file (one file per rule from 78 on). Rule numbers are a
> stable citation key — never renumber. 81 is a deliberate gap.

Each rule records the decision *and the incident or constraint that forced it*. The invariant is in `invariants-30-43.md`; rule numbers are a stable citation key — never renumber.

- [Rule 143](#rule-143) — A transceiver's DDM readings belong to its port only by the validated cage layout, applied all-or-nothing

<a id="rule-143"></a>

## Rule 143 — A transceiver's DDM readings belong to its port only by the validated cage layout, applied all-or-nothing

**The problem.** A FortiSwitch publishes every SFP's digital diagnostics (temperature, supply
voltage, Tx power, Rx power, laser bias) in ENTITY-SENSOR-MIB, and an operator wants them on the
port — "port49 Rx −26.8 dBm" is actionable, "sensor-8 −26.8 dBm" is not. RFC 4133 defines the
join (entPhysicalContainedIn → a port entity → entAliasMappingIdentifier → ifIndex), and
FortiSwitchOS publishes none of it: walked on an FSW-148F and an FSR-112F-POE (2026-11-06), every
sensor's parent is the chassis (index 1), the alias table holds a single row (the CPU port →
ifIndex 54), entPhysicalParentRelPos is a running counter, and entPhysicalName / Descr are
positional labels that are wrong even about the reading's TYPE — the 112F names its two
power-input truth-value sensors `SFP1` / `SFP2` and the first module's temperature and voltage
`SFP3` / `SFP4`; the 148F stops publishing entity rows at index 8, so later sensors fall back to
`sensor-N`. The earlier attempt, entPhysicalIndex == ifIndex, was reverted (97e54fd2) because it
was right often enough to look correct and silently wrong otherwise.

**What the device does guarantee.** Comparing the sensor walk against the switch's own
`get switch modules status` (unique readings like Rx −13.716 dBm and bias 17.042 mA matched one
port each) established the layout: each cage is five CONSECUTIVE rows — temperature, volts,
Tx dBm, Rx dBm, bias current, Tx before Rx — and an EMPTY cage still emits its five rows with
oper status unavailable(2), so the k-th group is the k-th cage whatever is seated. The cages
are the highest-numbered front ports on both models (port9–12 of 12, port49–52 of 52).

**The decision.** `utils/sfpOptics.ts → attributeSfpSensors()` applies that convention, and
refuses — maps nothing, leaving every reading an ordinary Hardware Sensors row — unless all of:
(a) the groups match the five-row shape exactly (units display first, because FortiSwitchOS has
stamped one type code on every row; the type code as fallback); (b) they form ONE unbroken run
of indexes; (c) no dBm row sits outside a group; (d) the device has at least as many `portN`
interfaces as groups, the cages being the highest-numbered N. It is all-or-nothing: a refusal
never maps some groups and guesses the rest. `ifName` is walked inside the sensor session only
when the table has a dBm row, so a device without optics pays nothing.

**Rejected guard: "an unavailable cage on a link-up port".** The first build refused the whole
switch when a cage whose five rows all read unavailable(2) sat on a port with ifOperStatus up, on
the reasoning that an empty cage cannot carry a link. A copper (RJ45) SFP has no digital
diagnostics: its cage reads unavailable exactly like an empty one while the port has link, so the
check would have refused every switch with a copper SFP in use. Removed before merge (2026-11-06,
the owner's call).

**What an attributed reading becomes.** Its sample stores `ifName` and is named
`<port> <role>` (`port10 Rx power`, `sfpSensorName`) — the stored name is how history, charts
and automation sensor-name patterns address it, so the labels are a contract. Classes are
unchanged (temperature / voltage / optical / current), so existing class-scoped automations keep
seeing the same readings. `GET /assets/:id/system-info` moves the row off `hardwareSensors` onto
its interface's `optics` object ONLY when that ifName is in the interface inventory
(`splitOpticsSamples`) — a reading never disappears from both tables. The desktop Interfaces
table shows Rx and Tx by default and temperature, voltage and bias as default-hidden columns; the
phone's interface page lists all five. The Device Map's link tooltip shows the same readings
under each end's port (`topologyGraphService → latestOpticsByPort`, which folds through
`splitOpticsSamples` against the switch's interface inventory, so it attributes exactly as the
Interfaces table does), with the same −20 dBm low-Rx line.

**History (2026-11-06).** A reading's history is read by its stored name through
`GET /assets/:id/hardware-history?sensorName=` — the same endpoint the Hardware Sensors table
used. Every optics cell in the Interfaces table opens that history in the sensor slide-over
(`openSensorDetailPanel`); the desktop interface page charts Rx and Tx under *Optical power*
(`_ifaceOpticsBlockHTML` / `_loadIfaceOpticsHistory`, on the page's own range), and the phone's
interface page draws both on one chart with its own range picker. The browser holds its own copy
of the role labels (`SFP_ROLE_LABELS` in `public/js/assets.js`; the phone spells the Rx / Tx
names inline), pinned to `sfpSensorName` by `tests/unit/sfpOpticsUi.test.ts` — a drift opens an
empty chart rather than failing. **History before the rename is not joined:** those samples sit
under the agent's positional names (`sensor-17`; `Sensor, Type: SFP` shared by several rows
and different readings), which cannot be attributed after the fact, and sample rows in
compressed chunks are never rewritten.

**Rejected:** a per-model cage table (a release per model, wrong silently for every model not in
it); reading port names from entPhysicalName (proven wrong); FortiOS REST through the controlling
gate as the only source (FortiLink-managed switches only; the endpoint is unverified — it remains
the way to get module identity and port names authoritatively, and may replace this later).
