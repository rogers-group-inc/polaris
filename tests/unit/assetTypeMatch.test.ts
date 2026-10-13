/**
 * tests/unit/assetTypeMatch.test.ts
 *
 * The device-type inference layer.
 *
 * The load-bearing block is "shipped defaults reproduce the retired
 * predicates": the rules that ship replaced two hardcoded functions
 * (`inferAssetTypeFromOs` in discoveryEngine, `assetTypeForHit` in
 * networkScanService), and every existing install inherits them through a seed
 * migration. If the transcription drifts, a fleet silently re-types on its next
 * discovery run with nothing in the UI to explain it — so the old ladders are
 * reimplemented here as oracles and the resolver is held against them.
 *
 * Second load-bearing block, since the 2026-09 cutover to the nested AND/OR
 * tree: "the legacy shape folds forward". The seed migration wrote the flat
 * `{clauses:[…]}` list with `starts_with` / `ends_with` / `negate`, and nothing
 * rewrites it — every install reads those rows through `normalizeMatchRules`
 * forever. A fold that stopped covering one of the three would blank a
 * built-in's rules on read, which reads in the UI as "Assigned only" and in
 * discovery as a fleet of unrecognized devices.
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  DEFAULT_TYPE_MATCHING,
  MATCH_CONTEXTS,
  MATCH_GROUP_OPS,
  MATCH_MAX_DEPTH,
  clauseMatches,
  conditionMatches,
  explainAssetType,
  matchClauses,
  matchConditionMeta,
  normalizeMatchRules,
  orderTypes,
  resolveAssetType,
  resolveAssetTypeCached,
  resetAssetTypeMatchRegistry,
  setAssetTypeMatchRegistry,
  getAssetTypeMatchRegistry,
  validateMatchContexts,
  validateMatchRules,
  type MatchableType,
  type MatchContext,
  type MatchGroup,
} from "../../src/utils/assetTypeMatch.js";
import { scopeConditionMeta, SCOPE_GROUP_OPS, DEVICE_FILTER_FIELD_OPS } from "../../src/services/notificationTypes.js";

/** The shipped registry, shaped for the resolver. */
function defaultTypes(): MatchableType[] {
  return Object.entries(DEFAULT_TYPE_MATCHING).map(([name, m]) => ({
    name,
    matchRules: m.rules,
    matchContexts: m.contexts,
    matchPriority: m.priority,
  }));
}

/** An OR of `any contains <v>` leaves — the shorthand most fixtures want. */
function anyOf(...values: string[]): MatchGroup {
  return { op: "or", children: values.map((value) => ({ field: "any" as const, operator: "contains" as const, value })) };
}

// ─── The retired predicates, verbatim, as oracles ──────────────────────────

function legacyInferAssetTypeFromOs(os: string | null | undefined): "workstation" | "server" | "other" {
  if (!os) return "other";
  const lower = os.toLowerCase();
  if (
    lower.includes("server") || lower.includes("centos") || lower.includes("red hat") ||
    lower.includes("rhel") || lower.includes("rocky linux") || lower.includes("almalinux") ||
    lower.includes("oracle linux") || lower.includes("freebsd") || lower.includes("openbsd") ||
    lower.includes("netbsd") || lower.includes("esxi") || lower.includes("vmware")
  ) return "server";
  if (
    /windows\s+(10|11|7|8|xp|vista)/i.test(os) ||
    lower.includes("macos") || lower.includes("mac os x") || lower.includes("os x") ||
    lower.includes("linux mint") || lower.includes("ubuntu") || lower.includes("fedora") ||
    lower.includes("debian") || lower.includes("arch linux") || lower.includes("manjaro") ||
    lower.includes("pop!_os") || lower.includes("elementary os") || lower.includes("zorin os")
  ) return "workstation";
  return "other";
}

function legacyAssetTypeForHit(os: string | null, hostname: string | null): string {
  const text = `${os ?? ""} ${hostname ?? ""}`.toLowerCase();
  if (/\bfortigate\b|\bfirewall\b|\bpalo alto\b|\bsonicwall\b/.test(text)) return "firewall";
  if (/\bfortiswitch\b|\bswitch\b|\bcatalyst\b|\bnexus\b/.test(text)) return "switch";
  if (/\bfortiap\b|access point|\bwlan\b|\bwireless\b/.test(text)) return "access_point";
  if (/\brouter\b|\bios\b.*\brouter\b/.test(text)) return "router";
  if (/\bprinter\b|laserjet|officejet/.test(text)) return "printer";
  return "other";
}

const OS_CORPUS = [
  null, "", "   ",
  "Windows 10 Pro", "Windows 11 Enterprise", "Windows 7", "Windows 8.1", "Windows XP", "Windows Vista",
  "Windows Server 2019 Datacenter", "Windows Server 2022", "Microsoft Windows Server 2016 Standard",
  "Ubuntu 22.04.3 LTS", "Debian GNU/Linux 12", "Fedora Linux 39", "Linux Mint 21", "Arch Linux",
  "Manjaro Linux", "Pop!_OS 22.04", "elementary OS 7", "Zorin OS 16",
  "CentOS Linux 7", "Red Hat Enterprise Linux 9", "RHEL 8.8", "Rocky Linux 9.3", "AlmaLinux 9",
  "Oracle Linux Server 8", "FreeBSD 14.0", "OpenBSD 7.4", "NetBSD 10",
  "VMware ESXi 8.0.3", "VMware Photon OS", "macOS 14.2 Sonoma", "Mac OS X 10.15", "OS X El Capitan",
  "iOS 17.2", "Android 14", "FortiOS 7.4.5", "JUNOS 21.4", "Cisco IOS XE",
  "HP LaserJet Pro", "Zebra Printer", "unknown", "Linux", "Windows",
];

const SCAN_CORPUS: { os: string | null; hostname: string | null }[] = [
  { os: null, hostname: null },
  { os: "FortiGate-100F", hostname: "fw-hq-01" },
  { os: "", hostname: "core-switch-3" },
  { os: "FortiSwitch 248E", hostname: null },
  { os: "FortiAP 431F", hostname: "ap-floor2" },
  { os: "Cisco Catalyst 9300", hostname: "cat9300" },
  { os: "Cisco Nexus 9000", hostname: null },
  { os: "Palo Alto PA-820", hostname: null },
  { os: "SonicWall TZ470", hostname: null },
  { os: "Cisco IOS Router 2911", hostname: "rtr-branch" },
  { os: "HP LaserJet MFP M428", hostname: "prn-acct" },
  { os: "Brother Printer", hostname: null },
  { os: "Canon OfficeJet", hostname: null },
  { os: "Aruba wireless controller", hostname: null },
  { os: null, hostname: "wlan-ctrl-1" },
  { os: "Generic Access Point", hostname: null },
  { os: "Eaton PDU", hostname: "pdu-rack4" },
  { os: "Axis Network Camera", hostname: "cam-lobby" },
  { os: "Ubuntu 22.04", hostname: "srv-app-1" },
  { os: "Windows Server 2019", hostname: "dc-01" },
];

describe("shipped defaults reproduce the retired predicates", () => {
  const types = defaultTypes();

  it("matches inferAssetTypeFromOs on the directory context, across the OS corpus", () => {
    for (const os of OS_CORPUS) {
      const got = resolveAssetType(types, { os }, "directory") ?? "other";
      expect(got, `OS ${JSON.stringify(os)}`).toBe(legacyInferAssetTypeFromOs(os));
    }
  });

  it("matches assetTypeForHit on the scan context, across the scan corpus", () => {
    for (const hit of SCAN_CORPUS) {
      const got = resolveAssetType(types, { os: hit.os, hostname: hit.hostname }, "scan") ?? "other";
      expect(got, `hit ${JSON.stringify(hit)}`).toBe(legacyAssetTypeForHit(hit.os, hit.hostname));
    }
  });

  it("keeps server ahead of workstation, so a Windows Server is not an endpoint", () => {
    // The old ladder tested server FIRST. Priority is what preserves that:
    // "Windows Server 2019" also satisfies workstation's windows regex only if
    // it were reached, which it must not be.
    expect(resolveAssetType(types, { os: "Windows Server 2019" }, "directory")).toBe("server");
    const ordered = orderTypes(types).map((t) => t.name);
    expect(ordered.indexOf("server")).toBeLessThan(ordered.indexOf("workstation"));
  });

  it("keeps the two contexts disjoint, so an OS string never yields an infra type", () => {
    // The bug this guards: collapsing the rule sets would type an AD computer
    // named "PRINTER-01" as a printer off the directory path.
    expect(resolveAssetType(types, { os: "HP LaserJet Pro" }, "directory")).toBeNull();
    expect(resolveAssetType(types, { os: "Windows 11", hostname: "switch-room-pc" }, "directory"))
      .toBe("workstation");
    // ...and conversely a scanned Ubuntu box is not a "server" on the scan path.
    expect(resolveAssetType(types, { os: "Ubuntu 22.04" }, "scan")).toBeNull();
  });

  it("ships every default with rules that pass validation", () => {
    for (const [name, m] of Object.entries(DEFAULT_TYPE_MATCHING)) {
      expect(validateMatchRules(m.rules), name).toBeNull();
      expect(validateMatchContexts(m.contexts), name).toBeNull();
    }
  });

  it("ships no rules for the types only an authoritative source assigns", () => {
    for (const name of ["other", "hypervisor", "kubernetes_cluster"]) {
      expect(DEFAULT_TYPE_MATCHING[name]).toBeUndefined();
    }
  });
});

describe("the process cache", () => {
  beforeEach(() => resetAssetTypeMatchRegistry());

  it("falls back to the shipped rules before it has ever been loaded", () => {
    // The bug this guards: `seedAssetTypes` runs only where `runsMigrations`
    // is true, so in the split-role layout the DISCOVERY process — the one
    // that types devices — reaches the resolver with a cold cache. Answering
    // "nothing matches" there would file an entire run under Other and look
    // exactly like a fleet of unrecognized devices.
    expect(resolveAssetTypeCached({ os: "Windows Server 2019" }, "directory")).toBe("server");
    expect(resolveAssetTypeCached({ os: "FortiGate-60F" }, "scan")).toBe("firewall");
  });

  it("distinguishes never-loaded from loaded-and-empty", () => {
    // An operator clearing every rule is a real answer and must be honoured;
    // only the cold cache falls back.
    setAssetTypeMatchRegistry([]);
    expect(resolveAssetTypeCached({ os: "Windows Server 2019" }, "directory")).toBeNull();
    resetAssetTypeMatchRegistry();
    expect(resolveAssetTypeCached({ os: "Windows Server 2019" }, "directory")).toBe("server");
  });

  it("serves what was loaded, in resolver order", () => {
    setAssetTypeMatchRegistry([
      { name: "b", matchPriority: 9, matchContexts: ["scan"], matchRules: anyOf("x") },
      { name: "a", matchPriority: 1, matchContexts: ["scan"], matchRules: anyOf("x") },
    ]);
    expect(getAssetTypeMatchRegistry().map((t) => t.name)).toEqual(["a", "b"]);
    expect(resolveAssetTypeCached({ os: "x" }, "scan")).toBe("a");
  });
});

describe("clause evaluation", () => {
  const facts = { os: "Ubuntu 22.04 LTS", hostname: "srv-app-01", manufacturer: "Dell Inc." };

  it("is case-insensitive on every operator", () => {
    expect(clauseMatches({ field: "os", operator: "contains", value: "UBUNTU" }, facts)).toBe(true);
    expect(clauseMatches({ field: "manufacturer", operator: "equals", value: "dell inc." }, facts)).toBe(true);
    expect(clauseMatches({ field: "hostname", operator: "startsWith", value: "SRV-" }, facts)).toBe(true);
    expect(clauseMatches({ field: "hostname", operator: "endsWith", value: "-01" }, facts)).toBe(true);
    expect(clauseMatches({ field: "os", operator: "regex", value: "^ubuntu" }, facts)).toBe(true);
  });

  it("reads `any` as the space-joined facts", () => {
    expect(clauseMatches({ field: "any", operator: "contains", value: "srv-app" }, facts)).toBe(true);
    expect(clauseMatches({ field: "any", operator: "contains", value: "dell" }, facts)).toBe(true);
  });

  it("never matches an absent fact — negative operator or not", () => {
    // The invariant, and the one place this evaluator deliberately disagrees
    // with the device filter it now shares a builder with: at discovery time a
    // missing field means "not yet known", so letting absence satisfy a
    // negation would let one field outage re-type a fleet. (In
    // evaluateScopeCondition, `notContains` against a NULL column IS
    // satisfied — that one filters stored rows, where null is an answer.)
    const empty = { os: null, hostname: "  " };
    expect(clauseMatches({ field: "os", operator: "contains", value: "x" }, empty)).toBe(false);
    expect(clauseMatches({ field: "os", operator: "notContains", value: "x" }, empty)).toBe(false);
    expect(clauseMatches({ field: "hostname", operator: "notEquals", value: "x" }, empty)).toBe(false);
    expect(clauseMatches({ field: "os", operator: "notRegex", value: "^x" }, empty)).toBe(false);
    expect(clauseMatches({ field: "any", operator: "contains", value: "x" }, { os: null })).toBe(false);
  });

  it("negates a present fact, on every operator that has a negative twin", () => {
    expect(clauseMatches({ field: "os", operator: "notContains", value: "windows" }, facts)).toBe(true);
    expect(clauseMatches({ field: "os", operator: "notContains", value: "ubuntu" }, facts)).toBe(false);
    expect(clauseMatches({ field: "manufacturer", operator: "notEquals", value: "hp" }, facts)).toBe(true);
    expect(clauseMatches({ field: "hostname", operator: "notStartsWith", value: "ws-" }, facts)).toBe(true);
    expect(clauseMatches({ field: "hostname", operator: "notEndsWith", value: "-99" }, facts)).toBe(true);
    expect(clauseMatches({ field: "os", operator: "notRegex", value: "^windows" }, facts)).toBe(true);
    expect(clauseMatches({ field: "os", operator: "notRegex", value: "^ubuntu" }, facts)).toBe(false);
  });

  it("treats an uncompilable stored regex as no-match rather than throwing", () => {
    // Write-time validation refuses these, but a hand-edited row or a restored
    // backup can still carry one, and it must not throw into the discovery loop.
    expect(() => clauseMatches({ field: "os", operator: "regex", value: "([unclosed" }, facts)).not.toThrow();
    expect(clauseMatches({ field: "os", operator: "regex", value: "([unclosed" }, facts)).toBe(false);
  });
});

describe("resolution", () => {
  const types: MatchableType[] = [
    { name: "pdu", matchPriority: 5, matchContexts: ["directory", "scan"], matchRules: anyOf("eaton") },
    { name: "camera", matchPriority: 5, matchContexts: ["scan"], matchRules: anyOf("axis") },
    { name: "server", matchPriority: 20, matchContexts: ["directory"], matchRules: { op: "or", children: [{ field: "os", operator: "contains", value: "server" }] } },
    { name: "unruled", matchPriority: 1, matchContexts: ["directory"], matchRules: null },
    { name: "outofcontext", matchPriority: 1, matchContexts: [], matchRules: anyOf("eaton") },
  ];

  it("returns null when nothing claims the device, leaving the default to the caller", () => {
    expect(resolveAssetType(types, { os: "TempleOS" }, "directory")).toBeNull();
  });

  it("honours priority, then name, deterministically", () => {
    const tied: MatchableType[] = [
      { name: "zebra", matchPriority: 10, matchContexts: ["scan"], matchRules: anyOf("x") },
      { name: "alpha", matchPriority: 10, matchContexts: ["scan"], matchRules: anyOf("x") },
    ];
    expect(resolveAssetType(tied, { os: "x" }, "scan")).toBe("alpha");
    expect(resolveAssetType([...tied].reverse(), { os: "x" }, "scan")).toBe("alpha");
  });

  it("skips a type whose contexts exclude this one", () => {
    expect(resolveAssetType(types, { os: "Axis camera" }, "directory")).toBeNull();
    expect(resolveAssetType(types, { os: "Axis camera" }, "scan")).toBe("camera");
  });

  it("skips a type with no rules at all, however high its priority", () => {
    expect(resolveAssetType(types, { os: "Windows Server 2019" }, "directory")).toBe("server");
  });

  it("skips a type declaring no contexts", () => {
    expect(resolveAssetType(
      types.filter((t) => t.name === "outofcontext"),
      { os: "Eaton PDU" },
      "directory",
    )).toBeNull();
  });

  it("explains which clause decided, agreeing with the resolver", () => {
    const { type, clause } = explainAssetType(types, { os: "Eaton ePDU G3" }, "scan");
    expect(type).toBe("pdu");
    expect(clause).toEqual({ field: "any", operator: "contains", value: "eaton" });
    expect(type).toBe(resolveAssetType(types, { os: "Eaton ePDU G3" }, "scan"));
  });
});

describe("validation", () => {
  it("accepts null / absent rules", () => {
    expect(validateMatchRules(null)).toBeNull();
    expect(validateMatchRules(undefined)).toBeNull();
  });

  it("refuses an uncompilable regex at write time, in either shape", () => {
    // The whole point of write-time validation: the resolver runs per device
    // per discovery run, so one typo must not be able to reach it.
    expect(validateMatchRules({ clauses: [{ field: "os", op: "regex", value: "([unclosed" }] }))
      .toMatch(/Invalid regex/);
    expect(validateMatchRules({ op: "or", children: [{ field: "os", operator: "notRegex", value: "([unclosed" }] }))
      .toMatch(/Invalid regex/);
  });

  it("names the offending condition, by its place in the tree", () => {
    expect(validateMatchRules({
      clauses: [
        { field: "os", op: "contains", value: "ok" },
        { field: "nope", op: "contains", value: "x" },
      ],
    })).toMatch(/Condition 2/);
    expect(validateMatchRules({
      op: "and",
      children: [
        { field: "os", operator: "contains", value: "ok" },
        { op: "or", children: [{ field: "os", operator: "bogus", value: "x" }] },
      ],
    })).toMatch(/group 2 . condition 1/);
  });

  it("refuses unknown fields, operators, empty values and bad contexts", () => {
    expect(validateMatchRules({ clauses: [{ field: "serial", op: "contains", value: "x" }] })).toMatch(/field/);
    expect(validateMatchRules({ clauses: [{ field: "os", op: "matches", value: "x" }] })).toMatch(/operator/);
    expect(validateMatchRules({ clauses: [{ field: "os", op: "contains", value: "  " }] })).toMatch(/value is required/);
    expect(validateMatchRules({ clauses: [{ field: "os", op: "contains", value: "x".repeat(201) }] })).toMatch(/longer than/);
    expect(validateMatchRules({ notChildren: [] })).toMatch(/children/);
    expect(validateMatchRules({ op: "xor", children: [] })).toMatch(/group operator/);
    expect(validateMatchContexts(["directory", "nope"])).toMatch(/Unknown match context/);
    expect(validateMatchContexts([...MATCH_CONTEXTS] as MatchContext[])).toBeNull();
  });

  it("refuses a tree nested deeper than the builder allows", () => {
    // The builder caps nesting client-side; the server has to agree, or a
    // hand-built payload walks past a limit the UI advertises.
    let node: MatchGroup = { op: "or", children: [{ field: "os", operator: "contains", value: "x" }] };
    for (let i = 0; i < MATCH_MAX_DEPTH; i++) node = { op: "and", children: [node] };
    expect(validateMatchRules(node)).toMatch(/nest at most/);
  });

  it("counts leaves across the whole tree, not per group", () => {
    const leaf = { field: "os" as const, operator: "contains" as const, value: "x" };
    const big: MatchGroup = {
      op: "or",
      children: [
        { op: "and", children: Array.from({ length: 33 }, () => ({ ...leaf })) },
        { op: "and", children: Array.from({ length: 33 }, () => ({ ...leaf })) },
      ],
    };
    expect(validateMatchRules(big)).toMatch(/At most 64 conditions/);
  });

  it("normalizes an unusable blob to null rather than throwing", () => {
    expect(normalizeMatchRules({ clauses: [{ field: "bogus", op: "contains", value: "x" }] })).toBeNull();
    expect(normalizeMatchRules({ clauses: [] })).toBeNull();
    expect(normalizeMatchRules({ op: "and", children: [] })).toBeNull();
    expect(normalizeMatchRules(null)).toBeNull();
    expect(normalizeMatchRules("not an object")).toBeNull();
  });
});

describe("the legacy flat shape folds forward", () => {
  // Nothing rewrites the rows the seed migration wrote, so this fold runs on
  // every read on every install, forever.

  it("reads a flat clause list as an OR of its clauses", () => {
    const out = normalizeMatchRules({
      clauses: [
        { field: "os", op: "contains", value: "centos" },
        { field: "os", op: "contains", value: "rhel" },
      ],
    });
    expect(out).toEqual({
      op: "or",
      children: [
        { field: "os", operator: "contains", value: "centos" },
        { field: "os", operator: "contains", value: "rhel" },
      ],
    });
  });

  it("renames the two snake_case operators", () => {
    const out = normalizeMatchRules({
      clauses: [
        { field: "hostname", op: "starts_with", value: "srv-" },
        { field: "hostname", op: "ends_with", value: "-01" },
      ],
    });
    expect(matchClauses(out).map((c) => c.operator)).toEqual(["startsWith", "endsWith"]);
  });

  it("folds `negate` onto the operator's negative twin, and drops a falsy one", () => {
    expect(matchClauses(normalizeMatchRules({
      clauses: [
        { field: "os", op: "contains", value: "a", negate: true },
        { field: "os", op: "equals", value: "b", negate: true },
        { field: "hostname", op: "starts_with", value: "c", negate: true },
        { field: "hostname", op: "ends_with", value: "d", negate: true },
        { field: "os", op: "regex", value: "e", negate: true },
      ],
    }))).toEqual([
      { field: "os", operator: "notContains", value: "a" },
      { field: "os", operator: "notEquals", value: "b" },
      { field: "hostname", operator: "notStartsWith", value: "c" },
      { field: "hostname", operator: "notEndsWith", value: "d" },
      { field: "os", operator: "notRegex", value: "e" },
    ]);
    // A falsy negate is not stored — it was never a distinct state.
    expect(matchClauses(normalizeMatchRules({
      clauses: [{ field: "os", op: "contains", value: "x", negate: false }],
    }))[0]).toEqual({ field: "os", operator: "contains", value: "x" });
  });

  it("evaluates a folded legacy list exactly as the flat ANY-of did", () => {
    const legacy = normalizeMatchRules({
      clauses: [
        { field: "os", op: "contains", value: "windows" },
        { field: "hostname", op: "starts_with", value: "prn-" },
      ],
    })!;
    expect(conditionMatches(legacy, { os: "Windows 11" })).toBe(true);
    expect(conditionMatches(legacy, { hostname: "prn-acct" })).toBe(true);
    expect(conditionMatches(legacy, { os: "Ubuntu", hostname: "srv-1" })).toBe(false);
  });
});

describe("tree evaluation", () => {
  const facts = { os: "Windows Server 2019", hostname: "dc-01", manufacturer: "Dell Inc." };

  it("carries the same four group operators as the device filter, with the same identities", () => {
    // Shared grammar is the point of the cutover — a tree an operator reads in
    // one builder has to mean the same thing in the other.
    expect([...MATCH_GROUP_OPS]).toEqual([...SCOPE_GROUP_OPS]);
    const hit = { field: "os" as const, operator: "contains" as const, value: "windows" };
    const miss = { field: "os" as const, operator: "contains" as const, value: "ubuntu" };
    expect(conditionMatches({ op: "and", children: [hit, miss] }, facts)).toBe(false);
    expect(conditionMatches({ op: "or", children: [hit, miss] }, facts)).toBe(true);
    expect(conditionMatches({ op: "none", children: [hit, miss] }, facts)).toBe(false);
    expect(conditionMatches({ op: "none", children: [miss] }, facts)).toBe(true);
    expect(conditionMatches({ op: "notAll", children: [hit, miss] }, facts)).toBe(true);
    expect(conditionMatches({ op: "notAll", children: [hit] }, facts)).toBe(false);
  });

  it("expresses the thing the flat list could not: AND with an exclusion", () => {
    // "A Windows box that is NOT a server" needed one hand-written regex
    // before; this is why the cutover happened.
    const rules: MatchGroup = {
      op: "and",
      children: [
        { field: "os", operator: "contains", value: "windows" },
        { field: "os", operator: "notContains", value: "server" },
      ],
    };
    expect(conditionMatches(rules, { os: "Windows 11 Enterprise" })).toBe(true);
    expect(conditionMatches(rules, facts)).toBe(false);
  });

  it("nests groups", () => {
    const rules: MatchGroup = {
      op: "and",
      children: [
        { field: "manufacturer", operator: "contains", value: "dell" },
        { op: "or", children: [
          { field: "hostname", operator: "startsWith", value: "dc-" },
          { field: "hostname", operator: "startsWith", value: "srv-" },
        ] },
      ],
    };
    expect(conditionMatches(rules, facts)).toBe(true);
    expect(conditionMatches(rules, { ...facts, hostname: "ws-04" })).toBe(false);
  });

  it("never lets an emptied group claim the fleet", () => {
    // `and([])` is true by identity, so an operator who cleared the last
    // condition would otherwise have handed this type every device. The
    // structural answer is that normalization prunes it away to null, and a
    // type with null rules matches nothing.
    expect(normalizeMatchRules({ op: "and", children: [] })).toBeNull();
    expect(normalizeMatchRules({
      op: "and",
      children: [{ field: "os", operator: "contains", value: "x" }, { op: "and", children: [] }],
    })).toEqual({ op: "and", children: [{ field: "os", operator: "contains", value: "x" }] });
    const types: MatchableType[] = [{ name: "greedy", matchPriority: 1, matchContexts: ["scan"], matchRules: null }];
    expect(resolveAssetType(types, { os: "anything" }, "scan")).toBeNull();
  });
});

describe("explaining a match", () => {
  it("names a satisfied leaf, agreeing with the resolver", () => {
    const types: MatchableType[] = [
      { name: "pdu", matchPriority: 5, matchContexts: ["scan"], matchRules: anyOf("eaton", "vertiv") },
    ];
    const { type, clause } = explainAssetType(types, { os: "Vertiv rPDU" }, "scan");
    expect(type).toBe("pdu");
    expect(clause).toEqual({ field: "any", operator: "contains", value: "vertiv" });
    expect(type).toBe(resolveAssetType(types, { os: "Vertiv rPDU" }, "scan"));
  });

  it("descends into a nested and/or group", () => {
    const types: MatchableType[] = [{
      name: "ws", matchPriority: 5, matchContexts: ["directory"],
      matchRules: { op: "and", children: [
        { field: "os", operator: "contains", value: "windows" },
        { op: "or", children: [{ field: "os", operator: "contains", value: "11" }] },
      ] },
    }];
    expect(explainAssetType(types, { os: "Windows 11" }, "directory").clause)
      .toEqual({ field: "os", operator: "contains", value: "windows" });
  });

  it("names nothing under an inverted group, rather than naming the wrong thing", () => {
    // Under `none`, a leaf that tested TRUE is what would have PREVENTED the
    // match — reporting it as the reason would be exactly backwards, so the
    // preview shows a dash instead.
    const types: MatchableType[] = [{
      name: "odd", matchPriority: 5, matchContexts: ["scan"],
      matchRules: { op: "none", children: [{ field: "os", operator: "contains", value: "windows" }] },
    }];
    const { type, clause } = explainAssetType(types, { os: "Ubuntu" }, "scan");
    expect(type).toBe("odd");
    expect(clause).toBeNull();
  });
});

describe("the builder catalog", () => {
  const meta = matchConditionMeta();
  const filterMeta = scopeConditionMeta(DEVICE_FILTER_FIELD_OPS);

  it("publishes the same shape the device filter's builder consumes", () => {
    // The shared PolarisConditionBuilder reads meta.fields[].{field,label,ops},
    // meta.groupOps, meta.groupOpLabels, meta.operatorLabels and meta.maxDepth.
    // A key missing here renders a builder with empty dropdowns.
    for (const key of ["groupOps", "groupOpLabels", "operatorLabels", "fields", "maxDepth"]) {
      expect(meta, key).toHaveProperty(key);
    }
    expect(meta.fields.every((f) => f.field && f.label && f.ops.length)).toBe(true);
    expect(meta.maxDepth).toBe(filterMeta.maxDepth);
  });

  it("words the shared operators identically to the device filter", () => {
    // Two labels for one operator in two builders on the same install is how a
    // rule copied from one to the other quietly stops meaning the same thing.
    for (const op of ["equals", "notEquals", "contains", "notContains", "startsWith", "endsWith"] as const) {
      expect(meta.operatorLabels[op], op).toBe(
        (filterMeta.operatorLabels as Record<string, string>)[op],
      );
    }
    expect(meta.groupOpLabels).toEqual(filterMeta.groupOpLabels);
  });

  it("offers no field the resolver cannot read", () => {
    // The vocabularies are deliberately disjoint: there is no tag, subnet or
    // status at inference time. What must hold is that every offered field is
    // one factText() knows.
    expect(meta.fields.map((f) => f.field)).toEqual(
      ["any", "os", "osVersion", "hostname", "manufacturer", "model", "chassis", "productType"],
    );
  });
});

describe("productType — typing equipment no directory has heard of", () => {
  /** The registry row an operator would add for a camera fleet. */
  const cameraType = {
    name: "camera",
    label: "Camera",
    matchRules: { op: "or", children: [{ field: "productType", operator: "contains", value: "camera" }] },
    matchContexts: ["scan"],
    matchPriority: 50,
  } as any;

  const axisM2025 = {
    os: "; AXIS M2025-LE; Network Camera; 8.40.3; Sep 06 2019 17:30; 727; 1; 8.40.3",
    hostname: "gatehouse-cam",
    manufacturer: "Axis Communications",
    model: "M2025-LE",
    productType: "Network Camera",
  };

  it("types both AXIS product-type spellings from ONE rule", () => {
    expect(resolveAssetType([cameraType], axisM2025, "scan")).toBe("camera");
    expect(
      resolveAssetType([cameraType], { ...axisM2025, productType: "Bullet Camera" }, "scan"),
    ).toBe("camera");
  });

  it("does not type an NVR merely NAMED for cameras — the point of the field", () => {
    // The same fleet expressed as a regex over `any` would catch this host,
    // because `any` folds in hostname. Keyed on productType it cannot.
    const nvr = {
      os: "Linux nvr01 5.4.0-91-generic",
      hostname: "CAMERA-NVR-01",
      manufacturer: "Dell",
      model: "PowerEdge R640",
      productType: null,
    };
    expect(resolveAssetType([cameraType], nvr, "scan")).toBeNull();

    // …and the `any` version of the same rule demonstrably does catch it,
    // which is why the narrow field exists.
    const anyRule = {
      ...cameraType,
      matchRules: { op: "or", children: [{ field: "any", operator: "regex", value: "\\bcamera\\b" }] },
    } as any;
    expect(resolveAssetType([anyRule], nvr, "scan")).toBe("camera");
  });

  it("matches case-insensitively, including via regex", () => {
    // "Network Camera" has a capital C; a case-sensitive engine would miss it.
    const rx = {
      ...cameraType,
      matchRules: { op: "or", children: [{ field: "productType", operator: "regex", value: "\\bcamera\\b" }] },
    } as any;
    expect(resolveAssetType([rx], axisM2025, "scan")).toBe("camera");
  });

  it("an absent productType never matches, negated or not", () => {
    const notCamera = {
      ...cameraType,
      matchRules: { op: "or", children: [{ field: "productType", operator: "notContains", value: "camera" }] },
    } as any;
    // A device that reported no product type is *not yet known*, not "not a
    // camera" — the resolver's absence rule, checked here for the new field.
    expect(resolveAssetType([notCamera], { ...axisM2025, productType: null }, "scan")).toBeNull();
  });

  it("rides `any` too, so a device calling itself a switch lands in that bucket", () => {
    const switchType = {
      name: "switch",
      label: "Switch",
      matchRules: { op: "or", children: [{ field: "any", operator: "contains", value: "switch" }] },
      matchContexts: ["scan"],
      matchPriority: 60,
    } as any;
    const facts = {
      os: null, hostname: "sw-idf3", manufacturer: "Acme",
      model: "A1", productType: "Network Switch",
    };
    expect(resolveAssetType([switchType], facts, "scan")).toBe("switch");
  });
});

