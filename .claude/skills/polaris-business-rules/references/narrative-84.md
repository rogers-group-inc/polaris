# Business rule 84 — full narrative

> Written 2026-09-22 as its own file, the `narrative-60-64.md` file having been at the
> 1500-line reference-file ceiling since rules 78 and 80 were split out. Rule numbers are a
> stable citation key — never renumber. (81 is a deliberate gap; see the note at the top of
> `narrative-82.md`.)

Verbatim from BUSINESS-RULES.md: each rule records the decision *and the incident or constraint that forced it*. The invariant is in `invariants-30-43.md`; rule numbers are a stable citation key — never renumber.

- [Rule 84](#rule-84) — A value that cannot identify a device is refused where it would be WRITTEN, not where a sweep would read it

<a id="rule-84"></a>

## Rule 84 — A value that cannot identify a device is refused where it would be WRITTEN, not where a sweep would read it

### The incident

The Polaris Agent reported the wrong serial number for every Windows host it was
installed on, and had done since the Windows collector was written.

Windows publishes no serial number in the registry. Not under
`HKLM\HARDWARE\DESCRIPTION\System\BIOS`, not under `HKLM\SYSTEM\HardwareConfig\Current`,
not under any value name, on any supported release — both keys carry manufacturer,
product name, family, SKU and BIOS version, and Microsoft omits the SMBIOS serial fields
deliberately. The collector read a value called `SystemSerialNumber` that does not exist,
found nothing, and fell through to a fallback that took `SystemSKU` instead.

`SystemSKU` is a model code. A Lenovo laptop reports
`LENOVO_MT_83DG_BU_idea_FM_Legion 5 16IRX9` where its real serial is eight characters. A
Dell PowerEdge reports `SKU=NotProvided;ModelName=PowerEdge R740` — **the same string on
every R740 in a fleet**. So the answer was not merely wrong, it was wrong in the one shape
that does the most damage to an inventory: identical across a whole model line.

### Why storing it was worse than storing nothing

Two subsystems then acted on the value, and both of them were entitled to.

`utils/assetProjection.ts` ranks `polaris-agent` FIRST for `serialNumber`, above `arc` and
`intune`, on sound reasoning — the agent runs on the host and reads firmware directly,
while an MDM serial is an enrollment-time inventory value that can be stale or describe a
replaced chassis. The consequence of being first is that the agent's answer **overwrites**
the others. A machine that Intune knew the real serial for lost it to the SKU.

Business rule 83's duplicate-serial sweep reads two assets carrying one serial as one
device recorded twice, and offers a merge. A model line sharing one string is that
condition N times over. `MAX_PLAUSIBLE_DUPLICATES` (8) caught the large fleets and
`isUsableSerial` caught the *named* placeholders, so the queue mostly survived — but only
because two blunt nets happened to be in the way.

The third consequence was the quiet one. `utils/hardwareIdentity.ts` exists to bridge an
AD-discovered server and an Arc-discovered machine, which share no definitive key but a
serial the agent can stamp on both. Its `indexUniqueBy` guard — drop any serial claimed by
two assets — was written **because our own agent reports a model SKU**, and its header
said so. The workaround worked: it refused to match on those serials. Which means the
bridge it exists to enable never fired for any Windows host with an SKU, and nobody
noticed, because a bridge that does not fire looks exactly like a bridge with nothing to
join. **A workaround that names our own bug as its reason is a bug report nobody filed.**

### The rule

A serial that identifies nothing is refused **at every point a serial could be written**,
not only at the sweep that would later read it:

- **At the wire.** `usableSerial()` in `agent/internal/collectors/serialnumber.go` drops
  the value before the agent sends it, on every platform — Linux's
  `/sys/class/dmi/id/product_serial` hands back `To Be Filled By O.E.M.` as readily as
  SMBIOS does.
- **At the projection.** Every rule in `SERIAL_RULES` picks through `obsSerial`
  (`utils/assetProjection.ts` → `utils/serialNumber.ts`), never `obsString`. A placeholder
  **falls through to the next source** instead of winning the field. This is a VALUE
  filter, not a priority change: the source order is untouched, and the top-priority source
  keeps its rank precisely because it can no longer abuse it.
- **At the record.** `POST /system-info` clears a stored serial that fails the test once no
  source can supply a real one, with an `asset.serial.cleared` Event. Without this the junk
  outlives the fix — the projection's normal write-back deliberately never writes a null,
  because "no source has an opinion" must not wipe a field, and a corrected agent reporting
  an honest empty serial produces exactly that null.

Filtering only at the sweep was half a fix. It stopped the false conflict card and left
everything else: the value still sat on the asset, was still rendered to an operator as
that device's serial, was still what a human compared two records by when deciding whether
they were one machine, and still buried the real serial underneath it.

### One list, asserted rather than asked for

Three private copies of "what is not a serial" had accumulated — in
`duplicateSerialConflictService.ts`, in `hardwareIdentity.ts`, and (newly) in the agent.
They had already drifted: only `hardwareIdentity`'s knew about `chassis serial number` and
`no asset tag`. The list, the length floor and the single-repeated-character shape now live
once, in `utils/serialNumber.ts`, and `hardwareIdentity.ts` keeps only what is genuinely
its own — the stricter normalization that folds case and internal whitespace, because it
builds a match KEY rather than a value to store.

The agent's copy cannot be an import, so it is a copy that **fails the build if it
diverges**: `tests/unit/serialNumber.test.ts` parses
`agent/internal/collectors/serialnumber.go` and asserts set equality with
`PLACEHOLDER_SERIALS`. A comment saying "keep these in sync" is how they went out of sync
three times already.

### What this does not retire

The `indexUniqueBy` uniqueness guard stays, and its comments now say why in terms that do
not name a live agent bug. Agents in the field upgrade on their own schedule, so assets
stamped by a pre-0.20.1 agent keep the SKU until that agent next reports; cloned VMs
duplicate a template's serial no matter what any collector does; and a vendor default this
list has not met behaves identically to one it has. A value that is ambiguous **in the
data** is not an identity, whatever shape it is in — that was true before the agent bug and
remains true after it.

### When adding a serial source

A new entry in `SERIAL_RULES` MUST read through `obsSerial`. A new collector or integration
that reports a serial applies `isUsableSerial` / `usableSerialOrNull` before the value
reaches an `AssetSource` blob or an `Asset` row. The conflict sweep is a backstop, not the
gate — code that relies on it to catch junk is code that stores junk.

### Rule 84 — the invariant as stated in full until 2026-09-22
> Moved here verbatim from the invariants file on 2026-09-22, when the invariant layer was cut back to the contract alone; the short invariant now points here for the reasoning and the dated history. Nothing below was rewritten.

**A value that cannot identify a device is refused where it would be WRITTEN, not where a sweep would read it** — the Polaris Agent reported the wrong serial for every Windows host it ran on: Windows publishes no serial in the registry under any name (neither `HKLM\HARDWARE\DESCRIPTION\System\BIOS` nor `HKLM\SYSTEM\HardwareConfig\Current`, on any supported release), so the collector's fallback took `SystemSKU` — a MODEL code, identical on every unit of a model (`SKU=NotProvided;ModelName=PowerEdge R740`). Wrong in the one shape that does the most damage: the same string across a whole model line. **Two subsystems then acted on it, both entitled to.** `utils/assetProjection.ts` ranks `polaris-agent` FIRST for `serialNumber` (it reads firmware on the host; an MDM serial is an enrollment-time value), so the SKU OVERWROTE the real serial Intune or Arc already had. And rule 83 reads a shared serial as one device recorded twice — a model line is that condition N times, survived only because `MAX_PLAUSIBLE_DUPLICATES` and the named-placeholder list were blunt enough to catch it. The third consequence was silent: `utils/hardwareIdentity.ts`'s `indexUniqueBy` guard (drop any serial claimed by two assets) was written BECAUSE our own agent reports a model SKU, so the Arc↔AD serial bridge it exists to enable never fired for those hosts, and a bridge that does not fire looks exactly like a bridge with nothing to join — **a workaround naming our own bug as its reason is a bug report nobody filed**. The rule: a serial is tested at EVERY write point, not at the sweep that would later read it — `usableSerial()` in `agent/internal/collectors/serialnumber.go` before it goes on the wire (all platforms; Linux's `product_serial` returns `To Be Filled By O.E.M.` as readily as SMBIOS), `obsSerial` in `utils/assetProjection.ts` so every `SERIAL_RULES` pick FALLS THROUGH to the next source rather than winning the field (a VALUE filter — the priority order is untouched, and the top source keeps its rank precisely because it can no longer abuse it), and a clear at `POST /system-info` (+ `asset.serial.cleared`) for a stored placeholder no source can replace — without which the junk outlives the fix, because the projection's write-back deliberately never writes a null and a corrected agent's honest empty serial IS that null. **One list, asserted not asked for**: the three private copies (conflict service, `hardwareIdentity`, agent) had already drifted, so the list, floor and repeated-character shape live once in `utils/serialNumber.ts`, `hardwareIdentity` keeps only its stricter match-KEY normalization, and `tests/unit/serialNumber.test.ts` PARSES the .go file to assert set equality — a "keep these in sync" comment is how they diverged three times. **Nothing here retires `indexUniqueBy`**: agents upgrade on their own schedule, cloned VMs duplicate a template's serial regardless, and a default nobody has met behaves the same — ambiguity IN THE DATA is not an identity whatever shape it is in. A new `SERIAL_RULES` entry MUST use `obsSerial`; a new collector applies `isUsableSerial` before the value reaches an `AssetSource` blob.

