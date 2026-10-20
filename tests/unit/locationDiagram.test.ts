/**
 * tests/unit/locationDiagram.test.ts
 *
 * The location-code nesting diagram (app.js → locationCodesDiagramHTML) draws
 * each a:/b:/f:/r:/jb: tier in the colour and border style of that tier's
 * Device Map hull. The values are copied from LOC_GROUP_KINDS in
 * topology-render.js because that file is not loaded on every page that
 * edits a description — so only this test stops the explainer's "pink area,
 * blue building" from drifting away from the map's.
 *
 * Both files are read as text (neither is a module); the two literals are
 * lifted and evaluated on their own, and the builder is evaluated with only
 * the isLightTheme global it reads.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const APP_JS = readFileSync(join(process.cwd(), "public", "js", "app.js"), "utf-8");
const TOPO_JS = readFileSync(join(process.cwd(), "public", "js", "topology-render.js"), "utf-8");

/** Lifts `var <name> = <open> … <close>;` and evaluates just that literal. */
function literal(src: string, name: string, open: string, close: string): unknown {
  const decl = `var ${name} = ${open}`;
  const start = src.indexOf(decl);
  if (start < 0) throw new Error(`${name} not found`);
  const end = src.indexOf(`${close};`, start);
  return new Function(`return ${src.slice(start + decl.length - 1, end + 1)};`)();
}

/** Lifts a top-level `function <name>(` … through its closing `\n}`. */
function fnSrc(src: string, name: string): string {
  const start = src.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`${name} not found`);
  return src.slice(start, src.indexOf("\n}", start) + 2);
}

type Tier = { code: string; name: string; example: string; color: string; colorLight: string; dash: string };
type Kind = { rank: number; color: string; colorLight: string; dash: string };

const TIERS = literal(APP_JS, "LOC_DIAGRAM_TIERS", "[", "]") as Tier[];
const KINDS = literal(TOPO_JS, "LOC_GROUP_KINDS", "{", "}") as Record<string, Kind>;
const KIND_FOR_CODE: Record<string, string> = { a: "area", b: "building", f: "floor", r: "room", jb: "jb" };

function build(light: boolean): string {
  const fn = new Function(
    "isLightTheme",
    `var LOC_DIAGRAM_TIERS = ${JSON.stringify(TIERS)};\n${fnSrc(APP_JS, "locationCodesDiagramHTML")}\nreturn locationCodesDiagramHTML();`,
  );
  return fn(() => light) as string;
}

describe("location-code nesting diagram", () => {
  it("lists every hull tier, outermost first", () => {
    const byRank = Object.entries(KINDS).sort((x, y) => x[1].rank - y[1].rank).map(([k]) => k);
    expect(TIERS.map((t) => KIND_FOR_CODE[t.code])).toEqual(byRank);
  });

  it("paints each tier in its hull's colours and border style", () => {
    for (const t of TIERS) {
      const k = KINDS[KIND_FOR_CODE[t.code]];
      expect({ color: t.color, colorLight: t.colorLight, dash: t.dash }).toEqual({
        color: k.color,
        colorLight: k.colorLight,
        dash: k.dash,
      });
    }
  });

  it("nests the boxes area → junction box with the device innermost", () => {
    const html = build(false);
    const order = TIERS.map((t) => html.indexOf(`<code>${t.code}:${t.example}</code>`));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((x, y) => x - y)).toEqual(order);
    expect(html.indexOf("this device")).toBeGreaterThan(order[order.length - 1]);
    expect(html.match(/class="loc-diagram-box"/g)?.length).toBe(TIERS.length);
  });

  it("takes the daylight colour on a light theme", () => {
    expect(build(true)).toContain(`--loc-c:${TIERS[0].colorLight}`);
    expect(build(false)).toContain(`--loc-c:${TIERS[0].color}`);
  });
});
