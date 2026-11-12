# Business rule 171 — full narrative

> Written 2026-11-12 as its own file (one file per rule from 78 on). Rule numbers are a
> stable citation key — never renumber. 81 is a deliberate gap.

Each rule records the decision *and the incident or constraint that forced it*. The invariant is in `invariants-30-43.md`; rule numbers are a stable citation key — never renumber.

- [Rule 171](#rule-171) — A device whose identity is in no standard MIB states it through its manufacturer profile's identity rows, on the probe's cadence too

## Rule 171 — A device whose identity is in no standard MIB states it through its manufacturer profile's identity rows, on the probe's cadence too

**How it was found.** 2026-11-12: an APC Smart-UPS's General tab had no model and no serial,
while the APC rack PDUs beside it, configured the same way (automatic MIBs, Response Time and
Hardware Sensors on SNMP), showed both. Two causes:

- **The model.** The APC profile already had a `model` row (`upsBasicIdentModel`, scoped to
  device type `power`). But the only reader of that row was the system-info pass, and that pass
  runs only when the Interfaces stream resolves to a method. The UPS's Interfaces stream was "not
  delivered", so the row was never asked. The PDUs did not need it: their built-in card's sysDescr
  carries the PDU's own `MN:` / `SN:` (rule 161), and sysDescr rides the Response Time probe.
- **The serial.** No path at all. ENTITY-MIB: APC implements none. sysDescr: on a UPS the `SN:` is
  the SmartSlot management card's, which rule 161 deliberately refuses. A profile: there was no
  serial row to point at `upsAdvIdentSerialNumber`.

**What changed.** A `serial` row beside `model`; both read by the system-info pass AND by the
probe's existing 10-minute identity cadence, so an asset polled only for response time gets
them; recorded as a source of their own and ranked by the projection.

**Why a separate source (`snmp-profile`), not more fields on `snmp-identity`.** The ENTITY-MIB
reading only exists in the system-info pass; the profile reading also comes from the probe. One
row with two writers would flip between their blobs every pass (one with the chassis serial, one
with the profile's). Two rows, each with its own edge cache, let the ladder decide once.

**Why the probe's read is detached, its own session and one OID per GET.** The probe is the
liveness signal: its round trip is charted, and its failure is a missed poll. A profile row can
name an object a given model does not publish (the APC profile's UPS rows on an AP8870 PDU), and
on SNMPv1 one missing varbind fails the whole PDU; batched into the probe's GET it would turn a
healthy device into a down one. Each scalar is therefore its own GET, after the probe, outside its
timing, and a failure is a debug log.

**Why it ranks above `snmp-identity` and below `snmp-sysdescr`.** A profile row is the operator's
statement of where this vendor keeps the value (rule 68: a profile is an override), so it beats
the generic chassis row. A vendor-format sysDescr the device's own built-in card states (rule 161)
is narrower still, and on an APC PDU the two must not disagree: the PDU never answers the UPS row.

**Rejected.** *Read `upsAdvIdentSerialNumber` in code for APC sysObjectIDs under the UPS branch.*
Vendor knowledge belongs in profiles (rule 68); the next vendor with a private serial object would
need another code change. *Run the whole system-info pass when Interfaces is off.* It walks the
interface tables the operator switched off.

### Rule 171 — the invariant as stated in full until 2026-11-12

(new rule; the invariant above is its first statement)
