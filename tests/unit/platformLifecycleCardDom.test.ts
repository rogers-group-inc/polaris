/**
 * tests/unit/platformLifecycleCardDom.test.ts — the Platform Lifecycle card
 * (public/js/server-settings.js).
 *
 * What's pinned here is what would rot silently:
 *  - the empty contract (falsy input and zero components both render ""), since
 *    the Maintenance tab's row layout depends on a card being able to render
 *    nothing rather than an empty shell;
 *  - a broken dataset producing a VISIBLE message rather than a blank card —
 *    an empty card reads as "nothing wrong", which is the opposite of the truth;
 *  - the severity → CSS mapping per row, because the colour is the whole signal;
 *  - worst-first ordering, so an operator does not scan for the problem;
 *  - the upgrade playbook rendering its steps and its lockstep file list, which
 *    is the "how to upgrade" half of the original request;
 *  - the staleness line appearing only past the threshold;
 *  - every interpolated value passing through escapeHtml. probeNote carries raw
 *    `go version` / `nginx -v` output from the host, so this is not theoretical.
 *
 * server-settings.js is a ~10k-line browser script with no module boundary, so
 * the functions under test are sliced out by name and eval'd with the app-shell
 * globals stubbed — the approach of tests/unit/assetAlertsTabDom.test.ts.
 *
 * NOTE: no <select> anywhere in this card, deliberately. happy-dom mis-parses
 * `<option selected>`, so a filter control here would be untestable in this
 * harness; if one is ever added, set the default in JS after insertion and do
 * not assert on the attribute.
 *
 * @vitest-environment happy-dom
 */

import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const g = globalThis as Record<string, any>;
const SPLIT = /\r?\n/;
const lines = readFileSync(resolve(__dirname, "../../public/js/server-settings.js"), "utf8").split(SPLIT);

/** Slice a top-level `function NAME(...) {` … `}` block out of server-settings.js. */
function fnSrc(name: string): string {
  const start = lines.findIndex(
    (l) => l.startsWith(`function ${name}(`) || l.startsWith(`async function ${name}(`),
  );
  if (start < 0) throw new Error(`function ${name} not found in server-settings.js`);
  const end = lines.findIndex((l, i) => i > start && l === "}");
  if (end < 0) throw new Error(`no end of function ${name}`);
  return lines.slice(start, end + 1).join("\n");
}

const FN_NAMES = [
  "_capacitySeverityLabel",
  "_capacitySeverityCssClass",
  "_lifecycleStateLabel",
  "_lifecycleWhen",
  "_lifecycleRowHtml",
  "renderPlatformLifecycleCard",
];

let renderPlatformLifecycleCard: (l: any) => string;

beforeEach(() => {
  // The card's only collaborators from outside the sliced set: escapeHtml
  // (api.js in the browser) and formatLocalTime (app.js). Stubbed as globals,
  // the same way every other harness in this suite does it.
  g.escapeHtml = (s: any) =>
    String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  g.formatLocalTime = (s: string) => String(s);
  // eslint-disable-next-line no-eval
  const exported = eval(`(function () { ${FN_NAMES.map(fnSrc).join("\n")}
    return { renderPlatformLifecycleCard };
  })()`);
  renderPlatformLifecycleCard = exported.renderPlatformLifecycleCard;
});

function comp(over: Record<string, any> = {}) {
  return {
    id: "node",
    label: "Node.js",
    kind: "runtime",
    policy: "dated",
    observedVersion: "20.19.0",
    observedRaw: "v20.19.0",
    probeStatus: "ok",
    polarisMinimum: "20",
    polarisTarget: "24",
    targetTrackEolAt: "2028-04-30",
    playbook: null,
    grade: {
      state: "current",
      severity: "none",
      track: "20",
      eolAt: "2027-04-30",
      activeSupportEndsAt: null,
      extendedSupportUntil: null,
      daysUntilEol: 400,
    },
    ...over,
  };
}

function payload(over: Record<string, any> = {}) {
  return {
    computedAt: "2026-09-08T12:00:00.000Z",
    datasetReviewedAt: "2026-09-08",
    datasetError: null,
    severity: "none",
    components: [comp()],
    informational: [{ id: "polaris", label: "Polaris", version: "0.9.2686" }],
    ...over,
  };
}

describe("the empty contract", () => {
  it("renders nothing for a falsy payload", () => {
    expect(renderPlatformLifecycleCard(null)).toBe("");
    expect(renderPlatformLifecycleCard(undefined)).toBe("");
  });

  it("renders nothing when there are no components", () => {
    expect(renderPlatformLifecycleCard(payload({ components: [] }))).toBe("");
  });
});

describe("a broken dataset", () => {
  it("renders a visible message, not an empty card", () => {
    const html = renderPlatformLifecycleCard(payload({ datasetError: "ENOENT: no such file" }));
    expect(html).toContain("Unavailable");
    expect(html).toContain("ENOENT: no such file");
    expect(html).toContain("platform-lifecycle-card");
  });

  it("escapes the error text", () => {
    const html = renderPlatformLifecycleCard(payload({ datasetError: '<img src=x onerror="alert(1)">' }));
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
  });
});

describe("row rendering", () => {
  it("maps severity to the capacity CSS vocabulary", () => {
    const cases: Array<[string, string]> = [
      ["critical", "capacity-reason-red"],
      ["warning", "capacity-reason-amber"],
      ["watch", "capacity-reason-watch"],
      ["none", "capacity-reason-ok"],
    ];
    for (const [sev, cls] of cases) {
      const html = renderPlatformLifecycleCard(
        payload({ components: [comp({ grade: { ...comp().grade, severity: sev, state: "eol" } })] }),
      );
      expect(html, `severity ${sev}`).toContain(cls);
    }
  });

  it("labels each lifecycle state in operator language", () => {
    const expected: Record<string, string> = {
      below_minimum: "Below minimum",
      eol: "End of life",
      eol_extended: "EOL (extended support)",
      approaching_eol: "Approaching EOL",
      aging: "Aging",
      ahead_of_tested: "Ahead of tested",
      current: "Current",
      not_installed: "Not installed",
      unknown: "Unknown",
    };
    for (const [state, label] of Object.entries(expected)) {
      const html = renderPlatformLifecycleCard(
        payload({ components: [comp({ grade: { ...comp().grade, state } })] }),
      );
      expect(html, `state ${state}`).toContain(label);
    }
  });

  it("states the EOL date and a relative distance", () => {
    const html = renderPlatformLifecycleCard(
      payload({ components: [comp({ grade: { ...comp().grade, daysUntilEol: 74, eolAt: "2026-11-21" } })] }),
    );
    expect(html).toContain("2026-11-21");
    expect(html).toContain("in 74 days");
  });

  it("states a past EOL as time elapsed", () => {
    const html = renderPlatformLifecycleCard(
      payload({ components: [comp({ grade: { ...comp().grade, daysUntilEol: -131, state: "eol" } })] }),
    );
    expect(html).toContain("131 days ago");
  });

  it("says 'no published date' rather than an em dash for an ungradeable policy", () => {
    const html = renderPlatformLifecycleCard(
      payload({
        components: [comp({ policy: "none", grade: { ...comp().grade, eolAt: null, daysUntilEol: null, state: "unknown" } })],
      }),
    );
    expect(html).toContain("no published date");
  });

  it("shows 'not installed' for an absent component", () => {
    const html = renderPlatformLifecycleCard(
      payload({
        components: [comp({ observedVersion: null, probeStatus: "absent", grade: { ...comp().grade, state: "not_installed", track: null } })],
      }),
    );
    expect(html).toContain("not installed");
  });

  it("orders worst first", () => {
    const html = renderPlatformLifecycleCard(
      payload({
        components: [
          comp({ id: "a", label: "Aaa healthy", grade: { ...comp().grade, severity: "none" } }),
          comp({ id: "z", label: "Zzz broken", grade: { ...comp().grade, severity: "critical", state: "eol" } }),
        ],
      }),
    );
    expect(html.indexOf("Zzz broken")).toBeLessThan(html.indexOf("Aaa healthy"));
  });

  it("counts the components needing attention in the header", () => {
    const html = renderPlatformLifecycleCard(
      payload({
        severity: "critical",
        components: [
          comp({ id: "a", grade: { ...comp().grade, severity: "critical", state: "eol" } }),
          comp({ id: "b", grade: { ...comp().grade, severity: "warning", state: "approaching_eol" } }),
          comp({ id: "c", grade: { ...comp().grade, severity: "watch", state: "aging" } }),
        ],
      }),
    );
    // watch does not count as "needs attention" — it is not actionable yet.
    expect(html).toContain("2 need");
  });
});

describe("the upgrade playbook", () => {
  const withPlaybook = () =>
    payload({
      components: [
        comp({
          grade: { ...comp().grade, severity: "critical", state: "eol" },
          playbook: {
            id: "node-major",
            title: "Move Polaris to a new Node major",
            docAnchor: "docs/INSTALL.md#supported-platform-versions",
            risk: "medium",
            steps: ["Bump engines.node", "Bump both Dockerfiles"],
            files: ["package.json", "deploy/setup-windows.ps1"],
          },
        }),
      ],
    });

  it("renders the steps and the lockstep file list", () => {
    const html = renderPlatformLifecycleCard(withPlaybook());
    expect(html).toContain("How to upgrade");
    expect(html).toContain("Bump engines.node");
    expect(html).toContain("Bump both Dockerfiles");
    expect(html).toContain("package.json");
    expect(html).toContain("deploy/setup-windows.ps1");
    expect(html).toContain("docs/INSTALL.md#supported-platform-versions");
  });

  it("does not render a playbook for a healthy component", () => {
    const p = withPlaybook();
    p.components[0].grade.severity = "none";
    p.components[0].grade.state = "current";
    expect(renderPlatformLifecycleCard(p)).not.toContain("How to upgrade");
  });

  it("offers no action button — nothing here is one-click fixable", () => {
    expect(renderPlatformLifecycleCard(withPlaybook())).not.toContain("<button");
  });
});

describe("dataset staleness", () => {
  it("says nothing when the dataset was reviewed recently", () => {
    const recent = new Date(Date.now() - 10 * 86400000).toISOString().slice(0, 10);
    const html = renderPlatformLifecycleCard(payload({ datasetReviewedAt: recent }));
    expect(html).not.toContain("Refresh the dataset");
  });

  it("warns once the review is over the threshold", () => {
    const old = new Date(Date.now() - 400 * 86400000).toISOString().slice(0, 10);
    const html = renderPlatformLifecycleCard(payload({ datasetReviewedAt: old }));
    expect(html).toContain("Refresh the dataset");
    expect(html).toContain(old);
  });
});

describe("escaping", () => {
  it("escapes a hostile probeNote from host output", () => {
    const html = renderPlatformLifecycleCard(
      payload({ components: [comp({ probeNote: '"><script>alert(1)</script>' })] }),
    );
    expect(html).not.toContain("<script>");
  });

  it("escapes a hostile observed version", () => {
    const html = renderPlatformLifecycleCard(
      payload({ components: [comp({ observedVersion: '<b>20</b>' })] }),
    );
    expect(html).not.toContain("<b>20</b>");
  });

  it("escapes playbook content", () => {
    const html = renderPlatformLifecycleCard(
      payload({
        components: [
          comp({
            grade: { ...comp().grade, severity: "warning", state: "approaching_eol" },
            playbook: { id: "x", title: "<script>t</script>", steps: ["<script>s</script>"], files: ["<script>f</script>"] },
          }),
        ],
      }),
    );
    expect(html).not.toContain("<script>");
  });
});

describe("the footer", () => {
  it("states when it was checked and when the dates were reviewed", () => {
    const html = renderPlatformLifecycleCard(payload());
    expect(html).toContain("Checked");
    expect(html).toContain("dates reviewed 2026-09-08");
  });

  it("lists the informational versions", () => {
    const html = renderPlatformLifecycleCard(payload());
    expect(html).toContain("Polaris 0.9.2686");
  });
});
