# AssetCard

One asset in a list: its device glyph, name, status and a line of identifying meta.

Markup is `.asset-card > .top + .meta` inside an `.asset-list`. `.top` holds an `.ico`
well with a device-type class, the `.name` and a status `.dot`; `.meta` holds a `.mono`
address and short `span`s such as the type and when it was last seen. The meta line is
indented to align with the name.

The device classes are `.ico-fw` (firewall), `.ico-sw` (switch), `.ico-srv` (server),
`.ico-prn` (printer), `.ico-ap` (access point), `.ico-rtr` (router), `.ico-wks`
(workstation) and `.ico-other`; each sets its well's tint and the glyph's colour.

- The same stand-in glyph is used for every type here; the app draws a distinct one per
  type.
- **Light-theme contrast:** `.ico-fw` uses a literal `#ffc78a` that reads at 1.3:1 on
  the light card — nearly invisible. Carried from the source unchanged.
