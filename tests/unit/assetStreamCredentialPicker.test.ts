/**
 * tests/unit/assetStreamCredentialPicker.test.ts — the asset modal's per-stream
 * credential picker (`_credentialOptionsForStream` + `refreshStreamCred` in
 * public/js/assets.js).
 *
 * The incident this guards: a FortiGate asset carried a stored per-stream
 * `restapi` credential with a stale token while its stream sat on "Inherit".
 * The picker rendered no options for "Inherit", so it was hidden and read as
 * "nothing set", yet the dispatchers kept sending that token. Every pass sent a
 * burst of bad keys, FortiOS 7.6's http_authd locked the Polaris server's IP out
 * of API-key access, and the lockout doubled on each repeat. The operator could
 * only clear it by switching the method away and back.
 *
 * So the picker must always render a STORED credential, whatever the method's
 * credential type, and must not render one that is not stored.
 *
 * The options are asserted as an HTML string, not parsed into a <select>:
 * happy-dom mis-parses `<option selected>` in some layouts.
 *
 * @vitest-environment happy-dom
 */

import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const g = globalThis as Record<string, any>;
const assetsSrc = readFileSync(resolve(__dirname, "../../public/js/assets.js"), "utf8");
const assetsLines = assetsSrc.split(/\r?\n/);

/** Slice a top-level `function NAME(...) {` … `}` block out of assets.js. */
function fnSrc(name: string): string {
  const start = assetsLines.findIndex((l) => l.startsWith(`function ${name}(`));
  if (start < 0) throw new Error(`assets.js: function ${name} not found`);
  const end = assetsLines.findIndex((l, i) => i > start && l === "}");
  if (end < 0) throw new Error(`assets.js: no end of function ${name}`);
  return assetsLines.slice(start, end + 1).join("\n");
}

let optionsFor: (selectedId: string, credType: string | null) => string;

beforeAll(() => {
  g.escapeHtml = (s: unknown) =>
    String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  g._credentialCache = {
    loaded: true,
    list: [
      { id: "c-snmp", name: "Branch SNMP", type: "snmp" },
      { id: "c-rest-old", name: "METRO REST (old)", type: "restapi" },
      { id: "c-rest", name: "Fleet REST", type: "restapi" },
    ],
  };
  optionsFor = new Function(
    "escapeHtml",
    "_credentialCache",
    `${fnSrc("_credentialOptionsForStream")}\nreturn _credentialOptionsForStream;`,
  )(g.escapeHtml, g._credentialCache);
});

describe("_credentialOptionsForStream", () => {
  it("lists only the method's credential type and selects the stored one", () => {
    const html = optionsFor("c-rest", "restapi");
    expect(html).toContain('<option value="">— Source default —</option>');
    expect(html).toContain('<option value="c-rest" selected>Fleet REST</option>');
    expect(html).toContain('<option value="c-rest-old">METRO REST (old)</option>');
    expect(html).not.toContain("Branch SNMP");
  });

  it("renders a stored credential when the stream inherits its method", () => {
    // The incident: "Inherit" has no credential type. The stored restapi
    // credential must still appear, selected, so the save keeps what the row
    // holds and the operator can see it and pick "Source default" to clear it.
    const html = optionsFor("c-rest-old", null);
    expect(html).toContain('<option value="c-rest-old" selected>METRO REST (old) (restapi)</option>');
  });

  it("names a stored credential whose type does not fit the chosen method", () => {
    const html = optionsFor("c-rest-old", "snmp");
    expect(html).toContain('<option value="c-snmp">Branch SNMP</option>');
    expect(html).toContain('value="c-rest-old" selected>METRO REST (old) (restapi, not used by this method)</option>');
  });

  it("keeps a stored id the caller cannot list, rather than dropping it", () => {
    const html = optionsFor("c-unknown", null);
    expect(html).toContain('<option value="c-unknown" selected>Stored credential (not visible to you)</option>');
  });

  it("adds nothing when the row stores no credential", () => {
    expect(optionsFor("", null)).toBe('<option value="">— Source default —</option>');
    expect(optionsFor("", "restapi")).not.toContain("selected");
  });
});

describe("refreshStreamCred", () => {
  it("shows the picker when a credential is stored, even with no credential type", () => {
    // refreshStreamCred is nested inside _wireMonitorEditTab, so assert on its
    // source: the show condition must include the stored id, not credType alone.
    const start = assetsSrc.indexOf("function refreshStreamCred(");
    expect(start).toBeGreaterThan(0);
    const body = assetsSrc.slice(start, assetsSrc.indexOf("function refresh()", start));
    expect(body).toMatch(/if \(credType \|\| current\)/);
    expect(body).toContain('streamDef.pollId + "-cred-hint"');
  });
});
