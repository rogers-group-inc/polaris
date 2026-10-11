/**
 * tests/unit/assetPanelClickWiring.test.ts
 *
 * The asset panel opens on ANY page — global search loads assets.js through
 * PolarisPanels — but the Assets page's own init returns early everywhere
 * else. A document-level click handler registered inside that init therefore
 * exists only on the Assets page: the MAC list's × was drawn on every page and
 * did nothing off it (prod 2026-10-11). The panel's click handlers are wired
 * at load instead, guarded against assets.js being evaluated twice. This pins
 * that shape for each of them.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const src = readFileSync(resolve(__dirname, "../../public/js/assets.js"), "utf8").replace(/\r\n/g, "\n");

const PANEL_HANDLERS = [
  { handler: "_handleMacDeleteClick", guard: "__polarisMacDeleteWired" },
  { handler: "_handlePrimaryAddressClick", guard: "__polarisPrimaryAddressWired" },
];

describe("asset panel click handlers are wired at load, not in the Assets page init", () => {
  for (const { handler, guard } of PANEL_HANDLERS) {
    it(`${handler} is registered once, at top level, behind window.${guard}`, () => {
      const registrations = src.split("\n").filter((l) => l.includes(`addEventListener("click", ${handler})`));
      expect(registrations).toHaveLength(1);
      const block = new RegExp(
        `\\nif \\(!window\\.${guard}\\) \\{\\n  window\\.${guard} = true;\\n  document\\.addEventListener\\("click", ${handler}\\);\\n\\}`,
      );
      expect(src).toMatch(block);
    });
  }
});
