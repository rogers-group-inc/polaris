/**
 * tests/unit/roleMatrixLaddersDom.test.ts — the role permission matrix renders
 * only the levels a function key can hold.
 *
 * A key may declare a shorter ladder than the four columns (`levels` on
 * FunctionKeyDef; `assetsProbe` = none|read, because a probe reads a device and
 * writes nothing in Polaris — business rule 43). The server clamps stored
 * values into that ladder either way, so the failure this pins is a UI one and
 * it is silent in both directions: a radio rendered in a cell no route can
 * satisfy lets an admin "grant" a level that does nothing, and a row whose
 * stored value sits above its ladder would select NO radio at all — which the
 * save then collects as "none", quietly revoking the capability the operator
 * came to look at rather than change.
 *
 * users.js is a classic browser script, so it is eval'd into a happy-dom Window
 * — the tagPickerRegionTags.test.ts idiom. Only the pure HTML builder is
 * exercised; nothing here touches the network.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Window } from "happy-dom";
import { FUNCTION_KEYS, FUNCTION_SECTIONS, ACCESS_LEVELS } from "../../src/api/middleware/permissions.js";

vi.mock("../../src/db.js", () => ({ prisma: {} }));

const g = globalThis as Record<string, unknown>;
const USERS_SRC = readFileSync(resolve(__dirname, "../../public/js/users.js"), "utf8");

let win: InstanceType<typeof Window>;
let doc: Window["document"];

function exported<T>(name: string): T {
  const fn = (win as unknown as Record<string, unknown>)[name] ?? g[name];
  expect(typeof fn, `users.js no longer exposes ${name}`).toBe("function");
  return fn as T;
}

/** The catalogue as GET /roles/functions serves it — levels included. */
const matrixSpec = {
  accessLevels: ACCESS_LEVELS,
  sections: FUNCTION_SECTIONS.map(s => ({ ...s })),
  functions: FUNCTION_KEYS.map(f => ({ ...f })),
};

beforeEach(() => {
  win = new Window();
  doc = win.document;
  g.window = win;
  g.document = doc;
  g.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
  g.fetch = () => Promise.reject(new Error("no network in this test"));
  g.showToast = () => {};
  g.escapeHtml = (s: unknown) =>
    String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  g.api = { roles: {}, users: {} };
  g.collectOtherTags = () => [];
  g.regionPickerHTML = () => "";
  g.otherTagsFieldHTML = () => "";
  g.tagFieldHTML = () => "";
  g.randomRoleColor = () => "#4fc3f7";
  g.roleBadgeStyleFromColor = () => "";

  doc.body.innerHTML = "<div id='host'></div>";
  try { (0, eval)(USERS_SRC); } catch { /* users.js boot wiring touches page-specific DOM */ }
  (win as unknown as Record<string, unknown>)._matrixSpec = matrixSpec;
  g._matrixSpec = matrixSpec;
});

function renderMatrix(permissions: Record<string, string>): void {
  const build = exported<(role: unknown, isCreate: boolean, isProtected: boolean, perms: Record<string, string>) => string>(
    "buildRoleSlideoverHtml",
  );
  (doc.getElementById("host") as unknown as HTMLElement).innerHTML =
    build({ id: "r1", name: "custom", permissions, userCount: 0, color: null }, false, false, permissions);
}

function cellsFor(key: string): { levels: string[]; dashes: number } {
  const radios = Array.from(doc.querySelectorAll(`input[name="perm-${key}"]`)) as unknown as HTMLInputElement[];
  const row = (radios[0] as unknown as { closest: (s: string) => Element | null })?.closest("tr");
  const dashes = row
    ? Array.from(row.querySelectorAll("td")).filter(td => (td.textContent ?? "").trim() === "—").length
    : 0;
  return { levels: radios.map(r => r.value), dashes };
}

function allPermissions(base: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of FUNCTION_KEYS) out[f.key] = base;
  return out;
}

describe("role matrix — per-key access ladders", () => {
  it("renders four radios for a full-ladder key", () => {
    renderMatrix(allPermissions("read"));
    const { levels, dashes } = cellsFor("assets");
    expect(levels).toEqual(["none", "read", "write", "fullwrite"]);
    expect(dashes).toBe(0);
  });

  it("renders a dash instead of a radio for a level assetsProbe cannot hold", () => {
    renderMatrix(allPermissions("read"));
    const { levels, dashes } = cellsFor("assetsProbe");
    expect(levels).toEqual(["none", "read"]);
    // The two cells above Read are still drawn, so the columns stay aligned.
    expect(dashes).toBe(2);
  });

  it("a stored over-level value still selects a radio (clamped down, not lost)", () => {
    // The shape of a role stored before the ladder narrowed.
    const perms = allPermissions("read");
    perms.assetsProbe = "fullwrite";
    renderMatrix(perms);
    const radios = Array.from(doc.querySelectorAll('input[name="perm-assetsProbe"]')) as unknown as HTMLInputElement[];
    const checked = radios.filter(r => r.checked);
    expect(checked.map(r => r.value)).toEqual(["read"]);
  });

  it("every ownership-dimensioned key still offers write AND fullwrite", () => {
    renderMatrix(allPermissions("read"));
    for (const f of FUNCTION_KEYS.filter(x => x.hasOwnershipDimension)) {
      const { levels } = cellsFor(f.key);
      expect(levels, `${f.key} lost a level the ownership dimension needs`).toContain("write");
      expect(levels).toContain("fullwrite");
    }
  });
});

describe("role matrix — page section headers", () => {
  it("draws one header per section, in sidebar order, each spanning every column", () => {
    renderMatrix(allPermissions("read"));
    const headers = Array.from(doc.querySelectorAll("tr.role-perm-section")) as unknown as HTMLElement[];
    expect(headers.map(h => h.getAttribute("data-section"))).toEqual(FUNCTION_SECTIONS.map(s => s.id));
    expect(headers.map(h => (h.textContent ?? "").trim())).toEqual(FUNCTION_SECTIONS.map(s => s.label));
    const th = headers[0].querySelector("th");
    expect(th?.getAttribute("colspan")).toBe(String(ACCESS_LEVELS.length + 1));
  });

  it("files each function under its own section's header", () => {
    renderMatrix(allPermissions("read"));
    const rows = Array.from(doc.querySelectorAll("tbody tr")) as unknown as HTMLElement[];
    let current: string | null = null;
    for (const row of rows) {
      if (row.classList.contains("role-perm-section")) { current = row.getAttribute("data-section"); continue; }
      const key = (row.querySelector('input[type="radio"]')?.getAttribute("name") ?? "").replace(/^perm-/, "");
      const def = FUNCTION_KEYS.find(f => f.key === key);
      expect(def, `row for unknown key ${key}`).toBeTruthy();
      expect(current, `${key} sits under the wrong header`).toBe(def!.section);
    }
  });

  it("names the other pages a shared key reaches", () => {
    renderMatrix(allPermissions("read"));
    const radio = doc.querySelector('input[name="perm-credentials"]') as unknown as { closest: (s: string) => Element | null };
    const note = radio.closest("tr")?.querySelector(".role-perm-also-on");
    expect((note?.textContent ?? "").trim()).toBe("Also used on: Assets, Integrations, Path Monitor");
    const plain = doc.querySelector('input[name="perm-ipBlocks"]') as unknown as { closest: (s: string) => Element | null };
    expect(plain.closest("tr")?.querySelector(".role-perm-also-on")).toBeNull();
  });

  it("renders the flat table when the spec carries no sections", () => {
    const flat = { accessLevels: ACCESS_LEVELS, functions: FUNCTION_KEYS.map(f => ({ ...f })) };
    (win as unknown as Record<string, unknown>)._matrixSpec = flat;
    g._matrixSpec = flat;
    renderMatrix(allPermissions("read"));
    expect(doc.querySelectorAll("tr.role-perm-section").length).toBe(0);
    expect(doc.querySelectorAll('input[name="perm-assets"]').length).toBe(4);
  });
});
