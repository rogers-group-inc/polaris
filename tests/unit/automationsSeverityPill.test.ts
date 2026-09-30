/**
 * tests/unit/automationsSeverityPill.test.ts — the Automations list's Severity
 * cell (`_severityPill` in public/js/automations.js).
 *
 * An automation with severity bands escalates through several levels, so the
 * pill names it "Escalation" instead of one level, coloured by the base
 * severity — the first tier the automation fires at.
 */

import { describe, it, expect, beforeAll, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Window } from "happy-dom";

vi.mock("../../src/db.js", () => ({ prisma: {} }));

const g = globalThis as Record<string, unknown>;
let pill: (r: Record<string, unknown>) => string;

beforeAll(() => {
  const win = new Window();
  win.document.body.innerHTML = '<button id="btn-refresh"></button>';
  g.window = win;
  g.document = win.document;
  g.escapeHtml = (s: unknown) => String(s ?? "");
  g.showToast = () => {};
  g.showConfirm = async () => false;
  g.permAtLeast = () => false;
  g.api = {};
  (0, eval)(readFileSync(resolve(__dirname, "../../public/js/automations.js"), "utf8"));
  pill = (win as unknown as { _severityPill: typeof pill })._severityPill;
});

describe("automations list severity pill", () => {
  it("shows the single severity for an automation without bands", () => {
    const html = pill({ severity: "serious", severityBands: null });
    expect(html).toContain("badge-level-serious");
    expect(html).toContain(">SERIOUS<");
    expect(html).not.toContain("ESCALATION");
  });

  it("treats an empty band list as single-severity", () => {
    expect(pill({ severity: "warning", severityBands: [] })).toContain(">WARNING<");
  });

  it("reads Escalation, coloured by the first tier, when bands are set", () => {
    const html = pill({
      severity: "warning",
      severityBands: [
        { threshold: 20, severity: "serious" },
        { threshold: 30, severity: "critical" },
      ],
    });
    expect(html).toContain("badge-level-warning");
    expect(html).toContain(">ESCALATION<");
    expect(html).toContain("Escalates: WARNING → SERIOUS (20) → CRITICAL (30)");
  });
});
