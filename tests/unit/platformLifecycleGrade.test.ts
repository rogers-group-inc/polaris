import { describe, it, expect } from "vitest";
import {
  gradeComponent,
  maxSeverity,
  findTrack,
  platformEolDatasetSchema,
  LIFECYCLE_WATCH_DAYS,
  LIFECYCLE_WARNING_DAYS,
  type PlatformTechnology,
} from "../../src/utils/platformLifecycleGrade.js";

const NOW = new Date("2026-09-08T12:00:00Z");

/** Build an ISO date N days from NOW. */
function isoIn(days: number): string {
  const d = new Date(NOW.getTime() + days * 86_400_000);
  return d.toISOString().slice(0, 10);
}

function tech(over: Partial<PlatformTechnology> = {}): PlatformTechnology {
  return {
    id: "node",
    label: "Node.js",
    kind: "runtime",
    trackGranularity: "major",
    policy: "dated",
    securityExposed: true,
    polarisMinimum: "20",
    polarisTarget: "22",
    polarisMaximumTested: "22",
    upgradePlaybook: "node-major",
    source: "https://example.invalid",
    sourceCheckedOn: "2026-09-08",
    confidence: "aggregator",
    tracks: [
      { track: "18", eol: isoIn(-500) },
      { track: "20", eol: isoIn(-131) },
      { track: "22", eol: isoIn(600) },
      { track: "24", eol: isoIn(900) },
    ],
    ...over,
  } as PlatformTechnology;
}

describe("gradeComponent — day boundaries", () => {
  const t = tech({
    polarisMinimum: "18",
    polarisTarget: "18",
    polarisMaximumTested: null,
    tracks: [{ track: "18", eol: isoIn(0) }],
  });

  const at = (days: number) =>
    gradeComponent(
      tech({
        polarisMinimum: "18",
        polarisTarget: "18",
        polarisMaximumTested: null,
        tracks: [{ track: "18", eol: isoIn(days) }],
      }),
      "18.0.0",
      NOW,
    );

  it("is current just outside the watch window", () => {
    expect(at(LIFECYCLE_WATCH_DAYS + 1).state).toBe("current");
  });

  it("is aging exactly at the watch threshold", () => {
    expect(at(LIFECYCLE_WATCH_DAYS).state).toBe("aging");
    expect(at(LIFECYCLE_WATCH_DAYS).severity).toBe("watch");
  });

  it("is aging just outside the warning window", () => {
    expect(at(LIFECYCLE_WARNING_DAYS + 1).state).toBe("aging");
  });

  it("is approaching_eol exactly at the warning threshold", () => {
    expect(at(LIFECYCLE_WARNING_DAYS).state).toBe("approaching_eol");
    expect(at(LIFECYCLE_WARNING_DAYS).severity).toBe("warning");
  });

  it("is approaching_eol on the last day and on the day itself", () => {
    expect(at(1).state).toBe("approaching_eol");
    expect(at(0).state).toBe("approaching_eol");
  });

  it("is eol the day after", () => {
    expect(at(-1).state).toBe("eol");
  });

  it("uses the exact same instant for the zero case", () => {
    expect(t.tracks[0].eol).toBe(isoIn(0));
  });
});

describe("gradeComponent — states", () => {
  it("grades a below-minimum install critical, beating any future EOL", () => {
    const g = gradeComponent(tech(), "18.20.4", NOW);
    expect(g.state).toBe("below_minimum");
    expect(g.severity).toBe("critical");
    // No cap: this one SHOULD reach the non-dismissible sidebar alert.
    expect(g.capacitySeverityCap).toBeUndefined();
  });

  it("grades below-minimum critical even when that track is still supported", () => {
    const g = gradeComponent(
      tech({ polarisMinimum: "22", tracks: [{ track: "20", eol: isoIn(900) }] }),
      "20.19.0",
      NOW,
    );
    expect(g.state).toBe("below_minimum");
    expect(g.severity).toBe("critical");
  });

  it("grades a past-EOL security-exposed component critical but capped at warning", () => {
    const g = gradeComponent(tech(), "20.19.0", NOW);
    expect(g.state).toBe("eol");
    expect(g.severity).toBe("critical");
    expect(g.capacitySeverityCap).toBe("warning");
    expect(g.daysUntilEol).toBe(-131);
  });

  it("grades a past-EOL build-time component warning, not critical", () => {
    const g = gradeComponent(
      tech({
        id: "go",
        securityExposed: false,
        trackGranularity: "major.minor",
        polarisMinimum: "1.22",
        polarisTarget: "1.26",
        polarisMaximumTested: null,
        tracks: [{ track: "1.22", eol: isoIn(-500) }],
      }),
      "1.22.7",
      NOW,
    );
    expect(g.state).toBe("eol");
    expect(g.severity).toBe("warning");
  });

  it("grades eol_extended as warning when an extension is still live", () => {
    const g = gradeComponent(
      tech({
        polarisMinimum: "18",
        polarisTarget: "18",
        polarisMaximumTested: null,
        tracks: [{ track: "18", eol: isoIn(-10), extendedSupport: isoIn(400) }],
      }),
      "18.0.0",
      NOW,
    );
    expect(g.state).toBe("eol_extended");
    expect(g.severity).toBe("warning");
    expect(g.capacitySeverityCap).toBe("warning");
  });

  it("falls through to eol when the extension has also passed", () => {
    const g = gradeComponent(
      tech({
        polarisMinimum: "18",
        polarisTarget: "18",
        polarisMaximumTested: null,
        tracks: [{ track: "18", eol: isoIn(-500), extendedSupport: isoIn(-10) }],
      }),
      "18.0.0",
      NOW,
    );
    expect(g.state).toBe("eol");
  });

  it("grades a supported-but-behind-target track as behind_target, not aging", () => {
    // 600 days of life left, so nothing about this is a clock — the only thing
    // true of it is that the dataset names a newer track. Reporting it as
    // "aging" alongside a genuine 120-days-to-EOL row is what made a Java 17
    // with 386 days left read as overdue.
    const g = gradeComponent(
      tech({ polarisTarget: "24", polarisMaximumTested: "24", tracks: [{ track: "22", eol: isoIn(600) }] }),
      "22.1.0",
      NOW,
    );
    expect(g.state).toBe("behind_target");
    expect(g.severity).toBe("watch");
  });

  it("prefers aging over behind_target when the EOL clock is also running", () => {
    // Both conditions true at once: below target AND inside the watch window.
    // The date is the more urgent fact, so it wins and the operator sees a
    // clock rather than a preference.
    const g = gradeComponent(
      tech({ polarisTarget: "24", polarisMaximumTested: "24", tracks: [{ track: "22", eol: isoIn(120) }] }),
      "22.1.0",
      NOW,
    );
    expect(g.state).toBe("aging");
    expect(g.severity).toBe("watch");
  });

  it("grades a track equal to its target as current", () => {
    // The Java case: target deliberately equals the minimum, so a healthy
    // install must read Current rather than nagging forever.
    const g = gradeComponent(
      tech({ polarisMinimum: "17", polarisTarget: "17", polarisMaximumTested: "17", tracks: [{ track: "17", eol: isoIn(386) }] }),
      "17.0.19",
      NOW,
    );
    expect(g.state).toBe("current");
    expect(g.severity).toBe("none");
  });

  it("grades the target track with a distant EOL as current", () => {
    const g = gradeComponent(tech(), "22.1.0", NOW);
    expect(g.state).toBe("current");
    expect(g.severity).toBe("none");
  });

  it("grades a track above polarisMaximumTested as ahead_of_tested", () => {
    const g = gradeComponent(tech(), "24.0.0", NOW);
    expect(g.state).toBe("ahead_of_tested");
    expect(g.severity).toBe("watch");
  });

  it("treats a track with no announced EOL as current", () => {
    const g = gradeComponent(
      tech({ polarisTarget: "22", polarisMaximumTested: "22", tracks: [{ track: "22", eol: null }] }),
      "22.0.0",
      NOW,
    );
    expect(g.state).toBe("current");
    expect(g.daysUntilEol).toBeNull();
  });
});

describe("gradeComponent — ungradeable inputs never carry a severity", () => {
  it("returns unknown with no severity when the version is missing", () => {
    const g = gradeComponent(tech(), null, NOW);
    expect(g.state).toBe("unknown");
    expect(g.severity).toBe("none");
  });

  it("returns unknown when the track is absent from the dataset", () => {
    // No minimum declared, so below_minimum cannot fire and the missing-track
    // path is what is actually under test.
    const g = gradeComponent(
      tech({ polarisMinimum: null, polarisTarget: null, polarisMaximumTested: null, tracks: [{ track: "22", eol: isoIn(600) }] }),
      "19.0.0",
      NOW,
    );
    expect(g.state).toBe("unknown");
    expect(g.severity).toBe("none");
  });

  it("still reports below_minimum for an unknown track under the floor", () => {
    // The complement of the case above: a track absent from the dataset but
    // clearly below the supported floor is a misconfiguration, not a mystery.
    const g = gradeComponent(
      tech({ polarisMaximumTested: null, tracks: [{ track: "22", eol: isoIn(600) }] }),
      "19.0.0",
      NOW,
    );
    expect(g.state).toBe("below_minimum");
    expect(g.severity).toBe("critical");
  });

  it("never grades a policy:none technology, however old", () => {
    const g = gradeComponent(
      tech({ policy: "none", polarisMinimum: "99", tracks: [] }),
      "7.0.0",
      NOW,
    );
    expect(g.state).toBe("unknown");
    expect(g.severity).toBe("none");
  });

  it("never grades a policy:compat technology", () => {
    const g = gradeComponent(tech({ policy: "compat", tracks: [] }), "2.17.2", NOW);
    expect(g.state).toBe("unknown");
    expect(g.severity).toBe("none");
  });

  it("returns not_installed when the component is absent", () => {
    const g = gradeComponent(tech(), null, NOW, { installed: false });
    expect(g.state).toBe("not_installed");
    expect(g.severity).toBe("none");
  });
});

describe("findTrack", () => {
  it("resolves an observed version to its dataset row", () => {
    expect(findTrack(tech(), "20.19.0")?.track).toBe("20");
  });

  it("resolves at major.minor granularity", () => {
    const t = tech({
      trackGranularity: "major.minor",
      tracks: [{ track: "1.22", eol: isoIn(-1) }, { track: "1.26", eol: null }],
    });
    expect(findTrack(t, "1.26.3")?.track).toBe("1.26");
  });

  it("returns null for an unknown track or missing version", () => {
    expect(findTrack(tech(), "99.0.0")).toBeNull();
    expect(findTrack(tech(), null)).toBeNull();
  });
});

describe("maxSeverity", () => {
  it("picks the highest", () => {
    expect(maxSeverity(["none", "watch", "warning"])).toBe("warning");
    expect(maxSeverity(["warning", "critical"])).toBe("critical");
    expect(maxSeverity(["none", "none"])).toBe("none");
  });

  it("is none for an empty list", () => {
    expect(maxSeverity([])).toBe("none");
  });
});

describe("platformEolDatasetSchema", () => {
  it("rejects a non-ISO reviewedAt", () => {
    const bad = { schemaVersion: 1, reviewedAt: "Sept 2026", technologies: [tech()] };
    expect(platformEolDatasetSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects an empty technology list", () => {
    const bad = { schemaVersion: 1, reviewedAt: "2026-09-08", technologies: [] };
    expect(platformEolDatasetSchema.safeParse(bad).success).toBe(false);
  });

  it("accepts a minimal valid dataset", () => {
    const ok = { schemaVersion: 1, reviewedAt: "2026-09-08", technologies: [tech()], playbooks: [] };
    expect(platformEolDatasetSchema.safeParse(ok).success).toBe(true);
  });
});

describe("gradeComponent — security floor", () => {
  const FLOOR = {
    version: "24.22.1",
    advisories: [{ id: "CVE-2026-111497", severity: "high" }],
    source: "https://nodejs.org/en/blog/vulnerability/october-2026-security-releases",
    sourceCheckedOn: "2026-10-23",
  };
  const withFloor = (over: Partial<PlatformTechnology> = {}) =>
    tech({
      polarisMinimum: "22",
      polarisTarget: "24",
      polarisMaximumTested: "24",
      tracks: [
        { track: "20", eol: isoIn(-131) },
        { track: "22", eol: isoIn(600) },
        { track: "24", eol: isoIn(900), securityFloor: FLOOR },
      ],
      ...over,
    });

  it("grades a supported track below its floor as unpatched, critical, capped at warning", () => {
    const g = gradeComponent(withFloor(), "24.14.1", NOW);
    expect(g.state).toBe("unpatched");
    expect(g.severity).toBe("critical");
    expect(g.capacitySeverityCap).toBe("warning");
    expect(g.securityFloor?.version).toBe("24.22.1");
    expect(g.eolAt).toBe(isoIn(900));
  });

  it("compares the full version component-wise, not as a string", () => {
    expect(gradeComponent(withFloor(), "24.9.0", NOW).state).toBe("unpatched");
    expect(gradeComponent(withFloor(), "24.22.0", NOW).state).toBe("unpatched");
  });

  it("treats the floor itself and anything newer as patched", () => {
    expect(gradeComponent(withFloor(), "24.22.1", NOW).state).toBe("current");
    expect(gradeComponent(withFloor(), "24.23.0", NOW).state).toBe("current");
    expect(gradeComponent(withFloor(), "24.22.1", NOW).securityFloor).toBeUndefined();
  });

  it("only applies a floor to its own track", () => {
    // 22 carries no floor in this fixture: an old 22 patch is not flagged.
    expect(gradeComponent(withFloor(), "22.12.0", NOW).state).toBe("behind_target");
  });

  it("colours by the worst vendor rating, one step higher when network-exposed", () => {
    const at = (severities: string[], securityExposed: boolean) =>
      gradeComponent(
        withFloor({
          securityExposed,
          tracks: [
            {
              track: "24",
              eol: isoIn(900),
              securityFloor: {
                ...FLOOR,
                advisories: severities.map((severity, i) => ({ id: `CVE-2026-${i}`, severity })) as any,
              },
            },
          ],
        }),
        "24.14.1",
        NOW,
      ).severity;
    expect(at(["low"], false)).toBe("watch");
    expect(at(["medium"], false)).toBe("warning");
    expect(at(["high"], false)).toBe("critical");
    expect(at(["critical"], false)).toBe("critical");
    expect(at(["low"], true)).toBe("warning");
    expect(at(["medium"], true)).toBe("critical");
    // The worst advisory wins, wherever it sits in the list.
    expect(at(["low", "high", "medium"], false)).toBe("critical");
  });

  it("keeps a low-rated floor out of the capacity snapshot's actionable set", () => {
    // watch is card-only: lifecycleCapacityReasons takes warning and critical.
    const g = gradeComponent(
      withFloor({
        securityExposed: false,
        tracks: [{ track: "24", eol: isoIn(900), securityFloor: { ...FLOOR, advisories: [{ id: "CVE-1", severity: "low" }] } }],
      }),
      "24.14.1",
      NOW,
    );
    expect(g.state).toBe("unpatched");
    expect(g.severity).toBe("watch");
  });

  it("lets end of life outrank an open advisory — an EOL track has no patch to move to", () => {
    const t = withFloor({
      polarisMinimum: "18",
      tracks: [{ track: "20", eol: isoIn(-131), securityFloor: { ...FLOOR, version: "20.99.0" } }],
    });
    expect(gradeComponent(t, "20.19.0", NOW).state).toBe("eol");
  });

  it("validates the floor's shape", () => {
    const parses = (securityFloor: unknown) =>
      platformEolDatasetSchema.safeParse({
        schemaVersion: 1,
        reviewedAt: "2026-09-08",
        technologies: [tech({ tracks: [{ track: "24", securityFloor } as any] })],
      }).success;
    expect(parses(FLOOR)).toBe(true);
    expect(parses({ ...FLOOR, version: "v24.22.1" })).toBe(false);
    expect(parses({ ...FLOOR, advisories: [] })).toBe(false);
    // Every advisory carries the vendor's rating; a bare ID is the old shape.
    expect(parses({ ...FLOOR, advisories: ["CVE-2026-111497"] })).toBe(false);
    expect(parses({ ...FLOOR, advisories: [{ id: "CVE-2026-111497", severity: "important" }] })).toBe(false);
  });
});
