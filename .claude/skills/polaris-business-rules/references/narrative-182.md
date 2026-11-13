# Business rule 182 — full narrative

> Written 2026-11-13 as its own file (one file per rule from 78 on). Rule numbers are a
> stable citation key — never renumber. 81 is a deliberate gap.

Each rule records the decision *and the incident or constraint that forced it*. The invariant is in `invariants-30-43.md`; rule numbers are a stable citation key — never renumber.

- [Rule 182](#rule-182) — A floor plan can be a CAD drawing

## Rule 182 — A floor plan can be a CAD drawing

**The request (2026-11-13).** The operator's underground mine maps (annual MSHA submittals) come from AutoCAD as vector PDFs: each level a separate sheet, with a drawing scale but no real-world location. Floor plans in Polaris were raster images only (PNG / JPEG / WebP), so a mine level had to be rasterised and then stretched into place by eye — three times, once per level, never quite aligned. The operator asked whether CAD could give something better; the answer was the drawing itself.

**DXF, not DWG.** DWG is AutoCAD's closed binary format: reading it needs the Open Design Alliance libraries (a paid membership, not redistributable in a FOSS app), LibreDWG (GPL, gaps on newer files) or the proprietary ODA File Converter on every host. DXF is AutoCAD's own open exchange format, saved natively (Save As → AutoCAD DXF), text, and documented; for 2D plans it carries the same linework, layers, text and units. Operator decision: DXF only for now. A DWG is recognised by its `AC10xx` header and refused with the Save As instruction; binary DXF likewise.

**Polaris draws the SVG itself.** The DXF is parsed on the server and the kept layers are written out as an SVG by `renderDxfSvg`, which emits only numbers and escaped text — nothing in an uploaded file reaches a browser as markup. The SVG is stored and served like any background image (an `<img>` in the floor's plan overlay, so it scales as vectors), with a `sandbox` CSP on the response so the file opened on its own can run nothing either. The DXF is not kept: re-importing a newer one replaces the drawing (and can keep the floor's placement).

**What is read.** Lines, light-weight and old-style polylines (bulges become arcs), arcs, circles, ellipses, splines (through their fit points, else their control points — an approximation), TEXT / ATTRIB and MTEXT (formatting stripped), and blocks expanded with their transforms (layer-0 contents take the insert's layer; MINSERT grids too; ≤8 deep). Entities in mirrored object coordinates (negative extrusion) are mirrored back. HATCH, SOLID, dimensions, 3D, images and proxies are counted and listed as not drawn. A drawing past 400,000 primitives is cut short and the dialog says so. Layers named like sheet furniture (title, border, frame, viewport, legend) start unticked.

**The details stay on the server.** What Polaris read (file name, units, extents, kept layers, geographic location) is stored on the image row (`TopologyBackgroundImage.cad`) and copied onto the floor's background by `resolveImage` at save time. The client's copy is display only; a save cannot forge it.

**Placement.** A CAD drawing's image covers its extents exactly, so a drawing coordinate maps onto the floor's plan units by one factor (`cadToPlan`), and every placement is a similarity transform solved from two point pairs (`fitTwoPoints`):

- **Its own location** — when AutoCAD's GEODATA gives the reference point in longitude / latitude: the design point lands there, north up, at the drawing's units (Web Mercator stretch included). A location in a projected system (state plane, UTM) needs that projection, which Polaris does not carry; such a drawing is placed by two points.
- **Line up with another floor** — the two corners of the new drawing are carried through the other CAD floor's placement, so the same drawing point lands on the same spot. Levels from one mine survey share coordinates, which is what makes Boone's three levels stack exactly (rule 152(a)). The dialog shows how much the two drawings' extents overlap, as a sanity check.
- **Two points** — a place on the drawing, the same place on the map, twice. The result is compared with the drawing's own units ("one unit is 1.003 ft, 0.3 % off"); a big difference is almost always a mis-click.

**Rejected.** Rendering the DXF in the browser (a client-side parser handing an SVG back to the server) was rejected: the server would then have to sanitise an uploaded SVG, which is exactly the risk the server-side renderer avoids. Storing the parsed geometry as JSON and drawing it live in Leaflet was rejected for scale: a mine level can hold tens of thousands of shapes, and one SVG image costs the map nothing per pan.

**The first real file (2026-11-13).** The operator's first real export, the Camp Nelson annual submittal, previewed as an empty box with a speck in one corner. The DXF carried its sheet layout too: the title block, legend and viewports in paper space (group code 67 = 1), in sheet inches around 0,0, while the mine sits in Kentucky state-plane feet around (1,280,000, 280,000). The extents spanned both, so the mine was a few pixels wide. Paper space is now skipped (and counted as "on the sheet layout"). The same file declared no units (`$INSUNITS` 0) but was set to imperial (`$MEASUREMENT` 0); the dialog now offers feet, marked as a guess, with a note that state plane drawings are usually US survey feet. The drawing has no GEODATA either, so it is placed by two points. The floor-plan image limit went from 15 to 20 MB at the same time (operator request).
