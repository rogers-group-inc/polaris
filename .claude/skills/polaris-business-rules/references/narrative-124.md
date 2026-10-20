# Business rule 124 — full narrative

> Written 2026-10-20 as its own file (one file per rule from 78 on). Rule numbers are a
> stable citation key — never renumber. 81 is a deliberate gap.

Each rule records the decision *and the incident or constraint that forced it*. The invariant is in `invariants-30-43.md`; rule numbers are a stable citation key — never renumber.

- [Rule 124](#rule-124) — An interface is selected by what the operator reads — its name or its description — and an interface filter may name several

<a id="rule-124"></a>

## Rule 124 — An interface is selected by what the operator reads — its name or its description — and an interface filter may name several

### The incident (2026-10-20)

An operator built "EPLS interface down": `ifOperStatus == down`, scoped to firewalls,
filtered to the interface `ATT EPLS`. Two FortiGates carry that circuit, and both had
the interface pinned. The automation only ever saw one of them.

The two gates carry the circuit differently. On one, `ATT EPLS` is a VLAN interface's
NAME. On the other it is the DESCRIPTION of the physical port it rides (`port25`). The
Interfaces tab shows the description in bold with the name underneath, so both rows read
"ATT EPLS". The engine compared `ifNamePattern` against `ifName` alone, so `port25` could
never match. The picker listed pinned NAMES only, which made it worse: the operator was
offered `port25` for the second gate and nothing that said "ATT EPLS".

They then asked for the obvious workaround, `ATT EPLS | port25`, the way the SD-WAN
overlay picker takes a list. The interface filter treated that as one literal substring,
so it would have matched nothing, and the automation would have gone silent on both gates.

### The decision

1. **Match the description as well as the name.** The description is where operators name
   a circuit, and it is what the UI shows first. A filter that ignores the words on the
   screen asks the operator to know an internal identifier they never see in bold.
2. **Take a "|" any-of list**, the same shape as the SD-WAN pair (`utils/sdwanDimensions.ts`),
   so one automation can name interfaces that share no common substring. FortiOS
   forbids "|" in object names, and IF-MIB names don't use it, so the separator can't split a
   real name. The same rule holds for descriptions in practice. A description that does
   contain "|" splits into terms that are each still substrings of it, so it still matches.
3. **One predicate for every interface arm.** `interfacePatternMatch` replaced the three
   `substringMatch(r.ifName, df.ifNamePattern)` sites: the counter arms, the state arm,
   and the unpinned PoE-fault readings. Reset leaves run through the same arms, so firing
   and clearing can't disagree about which interface a filter names.
4. **The picker offers what the engine matches.** Both interface sources add each
   interface's description beside its name. Descriptions are dropped when blank, when they
   repeat the name, or (for the pin-set source) when the interface isn't pinned. Offering
   an unpinned interface's description would be the filter-that-never-fires mistake rule 57's
   picker exists to prevent.

### What it does NOT change

- **The pin gate (rule 57).** Pins stay keyed on `ifName`. The description only decides
  which of the pinned interfaces a filter names. It never makes an unpinned interface
  alertable.
- **The dimension key.** Readings are still keyed by `ifName`, so an alert's identity,
  its acknowledgement and its reset are unaffected by a description being edited.

### Consequence, stated because it widens existing automations

A stored single-term filter now also matches interfaces whose DESCRIPTION contains the
term. A rule filtered to `wan` that used to see `wan1` / `wan2` will now also see a pinned
`port7` described "Backup WAN". That is the intended reading of the filter: the operator
typed the word they see. But an automation can start alerting on a pinned interface
it never alerted on before. The widening is bounded by the pin set.

### Alternatives rejected

- **A separate "interface description" filter.** That's two fields for one question, and the
  original rule still could not say "either gate's ATT EPLS" without an OR group.
- **Regex.** It is more expressive than the any-of list, and it's a second matching language
  next to the substring one every other dimension uses. Rule 116 would also require it to
  run on RE2.
- **Matching the description only when the name doesn't match.** That's the same result as an OR,
  with a harder explanation.

### The picker bug found alongside

While typing in the interface box, the suggestion list sat on "Checking what the selected
devices report…" and loaded only after the operator left the field. Two paths caused it.
A response was painted only onto the inputs that existed when its request went out, so a
row re-rendered in between kept its open list on "Checking…". And a row added or dropped by a
click in the trigger tree never asked for its values, because only a `change` event did.
Now `refreshDimOptions` repaints the panel's live inputs, opening a picker asks when nothing
is cached, and the trigger tree's onChange refreshes the lists the way the reset tree's
already did. That fix is UI plumbing, not part of this rule. It is pinned by
`tests/unit/automationsWizardDom.test.ts` ("fills the list of a row re-rendered while its
values were still loading").
