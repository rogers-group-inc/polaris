# Manufacturer Profiles

A **manufacturer profile** tells Polaris which SNMP objects carry a vendor's
CPU, memory, hardware sensors, storage and model, for the devices Polaris polls
over SNMP. Polaris ships the standard MIBs and no vendor's, so a vendor's objects
come from a MIB you upload, and a profile names which of them to read. Profiles
live at **Server Settings → Credentials → Manufacturer Profiles**, beside the
**MIB Database** they read from. [Monitoring](Monitoring) explains where profiles
sit among the other sources of readings. This page is the guide to building one.

Profiles drive SNMP collection only. A device whose CPU and memory come from the
Polaris Agent, FortiManager, the FortiOS REST API or vCenter never reads one.

## Before you build one

**Check whether you need one at all.** Polaris reads the standard MIBs on every
device: CPU and memory from HOST-RESOURCES-MIB, disks from its storage table,
temperatures, fans and voltages from ENTITY-SENSOR-MIB. Many devices, especially
Linux-based ones, already answer those. A profile row is only for what the vendor
publishes nowhere else. The quickest test is the asset's **SNMP Walk** tab: pick a
standard MIB and walk it.

**Use the manufacturer name your devices carry.** A profile covers the devices
whose manufacturer is its name. **+ Add Manufacturer** suggests the names already
in your inventory, with device counts. "Aruba Networks" and "Aruba" are two
different names: fold the spelling with a **Manufacturer Alias** (MAC & Vendor
Identification), or give the profile an **Also applies when** pattern.

**Upload the vendor's MIBs under that same name**, every module the objects need.
A vendor's main module usually imports a core module (FORTINET-FORTIGATE-MIB
imports FORTINET-CORE-MIB). Upload the core module first; the upload result names
any module that is still missing.

## The rows

A new profile has eight rows. Five are read when Polaris collects:

| Row | What it reads |
|---|---|
| **Model identity** | one value holding the hardware model, plus a pattern that pulls the model out of it. Used only while the device's model is empty |
| **CPU** | a percent from 0 to 100. A single value, or a table column whose rows are averaged |
| **Memory** | a percent, or two byte counts: used and total, or used and free |
| **Hardware Sensors** | one temperature value, or a whole vendor sensor table (below) |
| **Storage** | two byte counts for one volume, used only when the standard storage table has no disks |

**Interfaces**, **LLDP** and **Wireless stations** describe what Polaris reads
from the standard MIBs. Editing them changes nothing.

**Type** says how a row reads its symbol. *Scalar* reads one value. *Table* walks
a column of rows. *Double scalar* reads two values, and its combiner says what the
pair is: *A / B × 100* is used and total, *A / (A + B) × 100* is used and free.
**Walk: average rows / sum rows** collapses a walked column into one reading: an
average for CPU tables, a sum for memory pools.

A row left empty means "no opinion": the standard MIBs answer for that metric.

### Hardware Sensors as a table

Use this when a vendor lists its sensors in its own MIB rather than in
ENTITY-SENSOR-MIB, which Polaris always tries first. Set the type to **table**.
The **Symbol** is the table's value column, and the fields under it name the
rest:

- **Name column**: the column that names each row. Without one, rows are named
  by their index.
- **Alarm column** (optional), and when it means alarm: *not 0*, *is 0*, *is one
  of* or *is not one of* a list of values, or *at least* / *at most* a number.
- **Class** (optional): what every row measures, for a table whose row names
  don't say. Left on *from row name*, each row is classified by its name.
- **Scale** (optional): *tenths → units* for a column reporting tenths.

FortiGate's table is the worked example: value `fgHwSensorEntValue`, name
`fgHwSensorEntName`, alarm `fgHwSensorEntAlarmStatus`, alarm when *not 0*. See
[Business Rules](Business-Rules#rule-132).

## One vendor, several device families

Under each row, **Add** a scoped row for one device type, one model pattern, or
both. For each metric, the most specific match wins: type and model, then model,
then the type's default, then the row itself.

A row with a model pattern and **no** device type also settles which family a
device belongs to, for every metric. A FortiAP mis-typed as a switch then reads
its FortiAP rows, never the switch rows. So when a family is identified by its
model, give it a row on every metric it needs. The Fortinet layout shows the
pattern: each family has a device-type default (for devices with no model yet)
**and** a model-pattern row with the same content (for devices typed wrongly).

## Custom widgets and state probes

Widgets carry what the five rows can't: battery runtime, client counts, an HTTP
health page, an alarm bit. Each needs its symbol's MIB uploaded (a standard MIB
too, uploaded as a generic module). A **state probe** maps a status value to
two named states ("Fault" / "Normal"), one per row of a table if you give it a
name column, and an automation can alert on it by name.

A new widget polls **no** device until you switch it on, either from the device
list Polaris opens when you save it or from the switch on each card of the
asset's Custom MIB tab ([rule 130](Business-Rules#rule-130)). A switched-on widget
polls on the device's hardware-sensor interval, using its first SNMP credential.

## Checking it works

- **The MIB cell of every row** says which module each symbol resolved from, or
  what to upload. A profile whose every symbol resolves is marked **READY**.
- **Saving warns, never refuses.** You can type a symbol before uploading its
  MIB, and the warning tells you what is still missing.
- After saving, the change reaches collection within about a minute and shows
  from the device's next poll after that.
  Walk the symbol from the asset's **SNMP Walk** tab to see the raw answer.

| You see | Usually means |
|---|---|
| *no uploaded MIB defines it* | the vendor's MIB isn't uploaded, or is uploaded under another manufacturer name |
| *… is missing FORTINET-CORE-MIB* | the main module is uploaded but a module it imports is not |
| READY, but the chart stays empty | the device's CPU / memory isn't polled over SNMP, the symbol is a table column on a *scalar* row, or the device doesn't answer that object |
| CPU stuck at 100 | the object isn't a percent (a load average, or per-mille) |
| A widget never shows a sample | it isn't switched on for that device, or the device has no SNMP credential |
| a *manufacturer_profile.unresolved* warning in [Events](Events) after a restart | a profile names a symbol no uploaded MIB defines, for example after a MIB was deleted |

## Sharing a profile

**Export** on a profile's header downloads it as a file another install can
**Import…**. The file names its MIBs but does not contain them, and holds no
passwords or per-device switches. The import lists each item, says what it would
add or replace, and names any MIB to upload first. **View Code** shows the same
JSON for editing in place.

The [AI Assistant](AI-Assistant) can read your profiles and uploaded MIBs: ask
why a row is unresolved, or which object in a module carries a reading. It
suggests only objects it finds in your uploaded MIB, and it never saves a change.
