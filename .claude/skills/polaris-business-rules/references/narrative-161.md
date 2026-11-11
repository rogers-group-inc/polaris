# Business rule 161 — full narrative

> Written 2026-11-11 as its own file (one file per rule from 78 on). Rule numbers are a
> stable citation key — never renumber. 81 is a deliberate gap.

Each rule records the decision *and the incident or constraint that forced it*. The invariant is in `invariants-30-43.md`; rule numbers are a stable citation key — never renumber.

- [Rule 161](#rule-161) — A management card's model and serial are the device's only when the card is built into it, and the product's registration says which

## Rule 161 — A management card's model and serial are the device's only when the card is built into it, and the product's registration says which

**The incident (2026-11-11).** An operator walked the system group of an APC AP8870 rack PDU in the data center:

```
sysDescr    APC Web/SNMP Management Card (MB:v4.2.9 PF:v1.5.1.1 PN:apc_hw21_aos_1.5.1.1.bin
            AF1:v1.2.0.4 AN1:apc_hw21_rpdu2g_1.2.0.4.bin MN:AP8870 HR:03 SN: ZA2406030655 MD:02/10/2024)
sysObjectID 1.3.6.1.4.1.318.1.3.4.6
sysName     apc8F29C4
```

Polaris knew it was APC (enterprise 318) and nothing else: `parseVendorSysDescr` knew only AXIS and returned early on any string without a `;`, and APC cards do not implement ENTITY-MIB, so rule 154's chassis read found nothing either. The model, serial and firmware were sitting in the string. A second, connected complaint: the custom widgets built for the site's APC UPSes showed up on the PDU, because one APC profile governs every APC device and the PDU had no model for a widget's `modelPattern` to exclude.

**The format.** Every APC NMC generation (NMC1 `hw02`, NMC2 `hw05`, NMC3 `hw21`) answers the same `KEY:value` layout inside the first parentheses: MB boot monitor, PF the card's AOS, PN its image, AF1 / AN1 the application firmware and image, MN model, HR hardware revision, SN serial, MD manufacture date. It is read by KEY, never by position, and `SN:` carries a space after the colon — so a blank `SN:` followed by `MD:…` must not read `MD:…` as the serial.

**What the operator saw.** The PDU's General tab: hostname an operator override ("Datacenter APC PURE 208v 1"), manufacturer APC and OS "APC AOS" from the FortiGate's device inventory, and serial, model and firmware empty — nothing on the monitor path could read the card.

**The trap the rule exists for.** MN and SN describe the CARD. On a rack PDU the card is built in, so they are the PDU's own part number and serial. In a Smart-UPS's SmartSlot (AP9630 / AP9631 / AP9640 / AP9641) they are the add-on card's: storing them would call every UPS an "AP9631", give it the card's serial, and — because the card moves between UPSes — feed rule 83's duplicate-serial report with the history of a card rather than a device. That is the plausible-but-wrong identity `snmpDescrIdentity.ts` was written to refuse.

**How the device is told apart.** APC registers each product family under `1.3.6.1.4.1.318.1.3.<family>` (PowerNet-MIB): `.4` is `masterSwitch`, whose children are every rack-PDU generation (`masterSwitchrPDU` .5, `masterSwitchrPDU2` .6 — this PDU — `sPDU` .7, `rPDUB` .8, `ePDU` .9, and the original MasterSwitch units), all with built-in cards; `.1` / `.2` / `.27` are Back-UPS / Smart-UPS / Smart-UPS 2. sysObjectID is a registered assignment, so it outranks anything inferred from the text (the `AN1` image name `rpdu2g` was considered and rejected as the gate for that reason). Model, serial and the productType "Rack PDU" are claimed under `.4` (and, below, under the transfer-switch and monitor arcs); anywhere else, or when the caller could not read sysObjectID, the parse yields the firmware alone, which is the card's on a UPS and is still the version the operator upgrades.

**Firmware.** PF, the card's AOS ("1.5.1.1"), falling back to AF1 when a card states no platform. The first draft took AF1, the application ("rpdu2g v1.2.0.4"). The operator's General tab showed why not: a FortiGate's device inventory fingerprints the card's OS as "APC AOS", the asset page prints OS / Firmware as `[os, osVersion]`, and AF1 would have read "APC AOS 1.2.0.4" — a version AOS never had. The application version is kept verbatim in the raw sysDescr on the source row.

**Cost.** sysObjectID rides the GET each reader already makes: the response-time probe's identity read (one varbind beside sysDescr, every ~10 minutes) and the system-info multi-GET. Both are mandatory system-group objects, so an SNMPv1 agent that answers one answers the other.

**Rejected.** Separate "APC UPS" / "APC PDU" manufacturer profiles (the profile is keyed by manufacturer, and both say APC — a second key would change how every profile resolves); a device-type scope on custom widgets (the operator chose to separate UPS and PDU widgets with `modelPattern`, which this rule makes possible by giving the PDU its model); the `AN1` image name as the PDU test (text, not a registration).

**Transfer switches and NetBotz (same day).** The operator asked for both with no hardware to test against, so each arc was admitted on published evidence only: the rack Automatic Transfer Switches (`automaticXferSwitch` `.11`, `automaticXferSwitch4G` `.32`, `automaticXferSwitch5G` `.38`) have integrated management; the NetBotz Rack Monitor 200 answers this same sysDescr layout (`AN1:apc_hw03_nb200_… MN:NBRK0200 … SN: ZA…`) with sysObjectID `monitors.mem` (`.8.4`) in a published walk, and its manual says the card is inside the unit — so the whole `monitors` branch (`.8`: environmental, EMS, EMU2, mem) is admitted as "Environmental Monitor". Left out: the InfraStruXure ATS (`.19`), whose card could not be confirmed built in, and the NetBotz 450 / 550 / 570 / 750 / 755 appliances, which register under NetBotz's own enterprise (5528) and answer a different sysDescr that never reaches this parser. The first real walk of any of these is the test still owed.

**Limits as shipped.** Only the arcs above are admitted; every other APC product yields the firmware alone.
