# Business rule 169 — full narrative

> Written 2026-11-12 as its own file (one file per rule from 78 on). Rule numbers are a
> stable citation key — never renumber. 81 is a deliberate gap.

Each rule records the decision *and the incident or constraint that forced it*. The invariant is in `invariants-30-43.md`; rule numbers are a stable citation key — never renumber.

- [Rule 169](#rule-169) — A renamed tag is followed everywhere its name is stored

## Rule 169 — A renamed tag is followed everywhere its name is stored

**How it was found.** The 2026-11-11 orphan audit (E.7). A tag has an id in the registry, but nothing refers to it by that id: a device carries the tag as a string in `tags`, and everything that selects devices by tag stores the same string. Renaming a tag already rewrote the string on the things that CARRY it (blocks, networks, assets, interface tags, network-inheritance rows). It did not rewrite the things that SELECT by it. So after a rename:

- **Write scope.** A Read-Write user reaches the devices that carry one of their tags (`User.otherTags`, or an SSO group mapping's `otherTags`). The devices now carried the new name and the user still held the old one, so the user lost every device they could change, at once and without a message. Nobody had changed the user.
- **Device filters.** A `tag` condition in an automation's Devices step, an alert group, a quiet time, a path check, a contact, an Application Map rule, or in ANOTHER tag's own auto-assign filter, went on naming the old tag and matched nothing.
- **Interface filters and recipients.** A condition narrowed to ports with a tag (`dimensionFilter.ifTag`) and a notify action routed to the users of a tag (`recipientTags`) did the same.

None of it was visible. The automation stayed enabled, the user stayed in their role.

**The decision.** Follow the name. The alternative considered was to refuse a rename while anything names the tag, as rule 167 does for a delete; it was rejected because a rename is not a removal — the operator's intent is plainly "the same tag, called something else", every reference still means what it meant, and making them edit thirty automations by hand first would be the tool creating work it can do itself. A rename is also the one case where carrying is unambiguous: there is exactly one new value.

**What it does.** `tagRegistryService.updateTag`, after its existing rewrites, calls `tagRenameCarryService.carryTagRename(old, new)`:

- the two tag-scope lists are rewritten in place; a list that already holds the new name drops the old one rather than list it twice;
- each holder of device filters is read once and every JSON column on it passed through `rewriteTagRefs`, a pure deep walk that recognises three shapes wherever they sit — a `{ field: "tag", value }` condition row, a `recipientTags` array, an `ifTag` "|" list — and returns the same object when nothing matched, so only rows that actually name the tag are written (an untouched automation keeps its `updatedAt`);
- the `tag.updated` Event's message says what followed ("followed in 2 users, 3 automations").

Matching is whole-name and case-insensitive, because that is how every reader compares (`scopeConditions` lower-cases both sides, `interfaceTagMatch` is whole-name and case-insensitive): a filter typed "Critical" for a tag named "critical" was matching before the rename and must go on matching after it.

It runs after the rename has committed and is best-effort per holder: a holder that fails is logged and the others still run. The rename has already happened; failing it retroactively is not possible and leaving half the holders unrewritten because the first one threw would be worse.

**What it does not do.** A DELETE carries nothing and needs nothing: deleting a registry tag leaves the string on every device that carries it by hand, so the references still select those devices. Region tags (`region:…`) are not renamed through this route at all — the tag registry refuses it — and a region rename not reaching condition trees is its own open item (E.8). A saved table filter (`SavedTableFilter.state`) is a per-user UI state in a different shape and is left alone. A tag referenced inside an automation SCRIPT's body or a Generic API mapping is free text and is not read.

**Scale.** A rename is rare and operator-driven. The carry reads eight small configuration tables once each (users and group mappings only where a tag scope is set) and writes only the rows that name the tag. Nothing here runs on a tick.

Pinned by `tests/unit/tagRenameCarry.test.ts` (the three shapes, whole-name matching, no mutation) and `tests/integration/tagRenameCarry.test.ts` (every holder, through `updateTag`).

### Rule 169(a) — a region rename is carried the same way

**How it was found.** The same audit row's neighbour (E.8). A map region reaches the rest of Polaris as the tag `region:<name>`. Renaming a region already rotated that tag on assets and networks, rewrote the `Tag` registry row, moved every user's and group mapping's region scope (`regionScopeService.renameRegionInPrincipalScopes`) and the saved folders a region owns (rule 140). It did not touch the device filters that say "devices in region East" — a `tag` condition whose value is `region:East` — nor a notify action routed to "the users of region East" (`recipientRegions`, which holds the BARE name). After the rename those automations matched no device and paged nobody, with the region itself looking perfectly healthy on the map.

**What it does.** The rename route calls `tagRenameCarryService.carryRegionRename(old, new)` in the same block as the principal-scope move. `rewriteRegionRefs` is `rewriteTagRefs`' sibling over one shared walker: it renames `region:<old>` wherever a tag is named (conditions, `ifTag`) and `<old>` inside `recipientRegions`, and leaves `recipientTags` and a plain tag that merely shares the region's name alone. The holders are the same list, now in one function (`carryFilterHolders`) so the two renames cannot drift apart. The `region.updated` Event says what followed.

**What it does not do.** A region DELETE carries nothing, for rule 58's reason: there is no new name to move to, and stripping the reference would destroy the operator's statement of intent. A `region:` tag typed by hand onto an IP BLOCK is not rotated by a rename (the rotation covers assets and networks, which is where the map puts it); that half of E.8 stays open. `Notification.regionTags` on alerts already raised is history and is not rewritten.

Pinned by the "169(a)" cases in `tests/unit/tagRenameCarry.test.ts` and `tests/integration/tagRenameCarry.test.ts`.
