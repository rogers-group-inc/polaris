/**
 * tests/unit/platformEolDataset.test.ts
 *
 * Structural invariants of the REAL committed src/data/platformEol.json.
 *
 * check-docs does not police the dataset and check-versions only checks a few
 * cross-references, so this is what stops a refresh from shipping a dataset
 * that parses but is wrong in a way an operator would see: a playbook pointing
 * at a deleted file, a target track that is itself nearly end-of-life, a
 * minimum that does not exist in the track list.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  platformEolDatasetSchema,
  gradeComponent,
} from "../../src/utils/platformLifecycleGrade.js";

const ROOT = join(import.meta.dirname, "..", "..");
const raw = readFileSync(join(ROOT, "src/data/platformEol.json"), "utf8");
const parsed = platformEolDatasetSchema.safeParse(JSON.parse(raw));

describe("the committed platform EOL dataset", () => {
  it("parses against the schema", () => {
    if (!parsed.success) {
      throw new Error(`dataset failed schema validation:\n${JSON.stringify(parsed.error.issues, null, 2)}`);
    }
    expect(parsed.success).toBe(true);
  });

  if (!parsed.success) return;
  const data = parsed.data;
  const playbookIds = new Set(data.playbooks.map((p) => p.id));

  it("has a unique id per technology", () => {
    const ids = data.technologies.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("resolves every upgradePlaybook reference", () => {
    for (const t of data.technologies) {
      if (t.upgradePlaybook) {
        expect(playbookIds, `technology "${t.id}"`).toContain(t.upgradePlaybook);
      }
    }
  });

  it("names only files that exist, in every playbook", () => {
    // A playbook that sends an operator to a file that has been renamed or
    // deleted is worse than no playbook: it reads as authoritative.
    const missing: string[] = [];
    for (const p of data.playbooks) {
      for (const f of p.files) {
        if (!existsSync(join(ROOT, f))) missing.push(`${p.id} -> ${f}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it("has unique, sorted tracks per technology", () => {
    for (const t of data.technologies) {
      const tracks = t.tracks.map((x) => x.track);
      expect(new Set(tracks).size, `technology "${t.id}"`).toBe(tracks.length);
    }
  });

  it("declares polarisMinimum / polarisTarget / polarisMaximumTested as real tracks", () => {
    for (const t of data.technologies) {
      if (t.policy !== "dated") continue;
      const tracks = new Set(t.tracks.map((x) => x.track));
      for (const key of ["polarisMinimum", "polarisTarget", "polarisMaximumTested"] as const) {
        const v = t[key];
        if (v) expect(tracks, `technology "${t.id}" ${key}=${v}`).toContain(v);
      }
    }
  });

  it("never targets a prerelease track", () => {
    for (const t of data.technologies) {
      if (!t.polarisTarget) continue;
      const row = t.tracks.find((x) => x.track === t.polarisTarget);
      expect(row?.prerelease ?? false, `technology "${t.id}"`).toBe(false);
    }
  });

  it("targets a track with at least 12 months of life left", () => {
    // A target that is itself nearly end-of-life is a dataset bug: it would
    // send an operator through a maintenance window onto a version they have
    // to leave again next year.
    const horizon = Date.now() + 365 * 86_400_000;
    for (const t of data.technologies) {
      if (t.policy !== "dated" || !t.polarisTarget) continue;
      const row = t.tracks.find((x) => x.track === t.polarisTarget);
      if (!row?.eol) continue; // null eol = no announced end, which is fine
      expect(
        Date.parse(`${row.eol}T00:00:00Z`),
        `technology "${t.id}" targets ${t.polarisTarget}, which is EOL ${row.eol}`,
      ).toBeGreaterThan(horizon);
    }
  });

  it("records provenance on every technology", () => {
    for (const t of data.technologies) {
      expect(t.source, `technology "${t.id}"`).toBeTruthy();
      expect(t.sourceCheckedOn, `technology "${t.id}"`).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(["vendor", "aggregator"]).toContain(t.confidence);
    }
  });

  it("gives every non-dated technology a note explaining why it is ungraded", () => {
    // Silence would read as an oversight. An operator seeing a blank status
    // deserves to know it is deliberate.
    for (const t of data.technologies) {
      if (t.policy === "dated") continue;
      expect(t.notes, `technology "${t.id}" has policy ${t.policy} but no notes`).toBeTruthy();
    }
  });

  it("grades every technology without throwing", () => {
    const now = new Date();
    for (const t of data.technologies) {
      for (const row of t.tracks) {
        expect(() => gradeComponent(t, `${row.track}.0`, now)).not.toThrow();
      }
      expect(() => gradeComponent(t, null, now)).not.toThrow();
    }
  });

  it("covers the stack the pin checker polices", () => {
    // check-versions asserts these exist too; duplicated here so the dataset
    // test fails on its own rather than only in CI.
    const ids = new Set(data.technologies.map((t) => t.id));
    for (const required of ["node", "postgres", "go", "nginx", "java", "timescaledb"]) {
      expect(ids).toContain(required);
    }
  });
});
