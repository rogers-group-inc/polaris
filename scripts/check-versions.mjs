#!/usr/bin/env node
/**
 * scripts/check-versions.mjs — pin-consistency guard for the tech stack.
 *
 * Polaris declares the same version in a dozen places at once: a Node major
 * lives in package.json, both Dockerfiles, six deploy/setup-* scripts, two
 * workflow files and four operator docs. Nothing cross-checked them, so a bump
 * could land in nine of twelve sites and the tenth would keep provisioning the
 * old runtime on every fresh host — silently, until someone rebuilt a box.
 *
 * This script reads every declaration site and asserts each family is
 * internally consistent. A family has TWO numbers, not one: the FLOOR it
 * requires (engines.node, the scripts' accept-checks, the docs' minimum column)
 * and the PIN it installs (the Dockerfiles, winget/MSI, the module stream, CI).
 * Those are allowed to differ — Node is 22-floor / 24-pinned on purpose — so
 * what is checked is that the floors agree with each other, the pins agree with
 * each other, and the floor is not above what any install path provisions.
 *
 * Pure file reads: no npm, no network, no database, so it runs in CI with no
 * install (the same discipline as check-docs.mjs) and finishes in milliseconds.
 *
 * It also sanity-checks src/data/platformEol.json — every family here must have
 * a dataset entry, or the in-app Platform Lifecycle card would grade a pin it
 * cannot describe.
 *
 * Wiring: `npm run check:versions`, a narrow arm of .githooks/pre-commit, and a
 * step in .github/workflows/check-docs.yml. Deliberately NOT folded into
 * check:docs — two concerns, two exit codes, so either can be bypassed alone.
 *
 * Adding a declaration site: add it to the family's `sites`. Globbed families
 * (the deploy scripts, the workflows) pick up a new file automatically and fail
 * if it declares no pin — add it to `skip` with a reason if that is correct.
 * Accepted divergences go in `allow` with the decision they defer, so the
 * checker stays a hard gate instead of decaying into ignored warnings.
 *
 * The family list mirrors the "Family index" table in
 * .claude/skills/polaris-tech-lifecycle/references/version-pin-inventory.md.
 * The two drift together or not at all.
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const JSON_OUT = process.argv.includes("--json");

/** Read a repo-relative file, CRLF-normalized. Returns null when absent. */
function read(rel) {
  try {
    return readFileSync(join(ROOT, rel), "utf8").replace(/\r\n/g, "\n");
  } catch {
    return null;
  }
}

/**
 * Same, with whole-line comments blanked out.
 *
 * A comment is not a declaration site, and reading one as a pin produces a
 * false failure that is worse than no check: setup-rhel.sh explains its module
 * reset with "nodejs:20 fails with cannot enable multiple streams otherwise"
 * right above `dnf module enable -y nodejs:24`, and matching the comment made
 * the family look like it disagreed with itself.
 *
 * Only FULL-line comments are removed. A trailing comment on a line that also
 * carries a real declaration is left alone, so `foo: 24  # bumped 2026-09` is
 * still read as 24, and lines are preserved so nothing else shifts.
 */
function readCode(rel) {
  const src = read(rel);
  if (src === null) return null;
  return src
    .split("\n")
    .map((line) => (/^\s*(#|\/\/|--)/.test(line) ? "" : line))
    .join("\n");
}

/** Repo-relative paths in `dir` whose basename matches `re`, sorted. */
function glob(dir, re) {
  const abs = join(ROOT, dir);
  if (!existsSync(abs)) return [];
  return readdirSync(abs)
    .filter((n) => re.test(n))
    .sort()
    .map((n) => `${dir}/${n}`);
}

const LINUX_SETUP = () => glob("deploy", /^setup-(rhel|ubuntu)(-nodb)?\.sh$/);
const WINDOWS_SETUP = () => glob("deploy", /^setup-windows(-nodb)?\.ps1$/);
const ALL_SETUP = () => [...LINUX_SETUP(), ...WINDOWS_SETUP()];
const UNITS = () => glob("deploy", /^polaris-.*\.service$/);
const WORKFLOWS = () => glob(".github/workflows", /\.ya?ml$/);

/** Truncate a version to the family's agreed granularity. */
function track(value, agree) {
  const parts = String(value).split(".");
  return agree === "major" ? parts[0] : parts.slice(0, 2).join(".");
}

/** Numeric track comparison: "1.9" < "1.10", "20" < "22". */
function compareTracks(a, b) {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

// ---------------------------------------------------------------------------
// Families. Each site yields zero or more { value } from one file; `pick` turns
// a regex match into the version string. `kind` is informational in the output:
//   pin           an exact version this repo installs or requires
//   accept-range  a floor an install script will accept (a range, not a pin)
//   prose         a version claim in a doc or a script header
// ---------------------------------------------------------------------------
const FAMILIES = [
  {
    id: "node-major",
    label: "Node.js",
    agree: "major",
    minSites: 13,
    sites: [
      { file: "package.json", label: "engines.node", kind: "accept-range",
        re: /"node":\s*">=\s*(\d+)\./g, pick: (m) => m[1] },
      { file: "package.json", label: "@types/node", kind: "pin", role: "floor",
        re: /"@types\/node":\s*"[\^~]?(\d+)\./g, pick: (m) => m[1] },
      { files: ["Dockerfile", "Dockerfile.dev"], label: "FROM node", kind: "pin",
        re: /^FROM node:(\d+)-/gm, pick: (m) => m[1] },
      { files: LINUX_SETUP, label: "node -v accept floor", kind: "accept-range",
        re: /node -v\)" == v(\d+)\*/g, pick: (m) => m[1] },
      { files: LINUX_SETUP, label: "install source", kind: "pin",
        re: /nodejs:(\d+)\b|node_(\d+)\.x/g, pick: (m) => m[1] ?? m[2] },
      { files: WINDOWS_SETUP, label: "node accept floor", kind: "accept-range",
        re: /node -v\) -match "\^v\((\d+)\|/g, pick: (m) => m[1] },
      { files: WINDOWS_SETUP, label: "winget pin", kind: "pin",
        re: /OpenJS\.NodeJS\.LTS --version (\d+)\./g, pick: (m) => m[1] },
      { files: WINDOWS_SETUP, label: "MSI fallback URL", kind: "pin",
        re: /nodejs\.org\/dist\/v(\d+)\./g, pick: (m) => m[1] },
      { files: WORKFLOWS, label: "node-version", kind: "pin",
        re: /node-version:\s*(\d+)/g, pick: (m) => m[1] },
      { files: ["docs/INSTALL.md", "README.md", "CLAUDE.md"], label: "prose floor", kind: "prose", role: "floor",
        re: /Node\.js (\d+)\+/g, pick: (m) => m[1] },
      // The minimum the app itself enforces at boot. Without this site the
      // code constant could drift from engines.node and the boot advisory
      // would police a number nothing else agrees with.
      { file: "src/utils/platformVersions.ts", label: "NODE_MINIMUM_MAJOR", kind: "pin", role: "floor",
        re: /NODE_MINIMUM_MAJOR = "(\d+)"/g, pick: (m) => m[1] },
      // The canonical supported-versions table in the install guide. It is the
      // operator-facing mirror of these pins, so it gets policed like one — an
      // unchecked canonical list is the most confident way to be wrong.
      { file: "docs/INSTALL.md", label: "supported-versions table", kind: "prose", role: "floor",
        re: /\*\*Node\.js\*\*\s*\|\s*(\d+)\s*\|/g, pick: (m) => m[1] },
      // README's system-requirements table. Its own row format, so the prose
      // regex above misses it — and it said "20 LTS" for both minimum and
      // recommended long after Node 20 went EOL, which is precisely the drift
      // an unchecked site accumulates.
      { file: "README.md", label: "system-requirements table", kind: "prose", role: "floor",
        re: /\|\s*Node\.js\s*\|\s*(\d+)\+/g, pick: (m) => m[1] },
    ],
    // The Linux scripts accept a *range* (v20 or v22) while Windows pins one
    // exact build. That is not a contradiction the equality check can see, but
    // it does mean "Node 20+" is false on Windows past the pinned patch.
    extra(found) {
      const warns = [];
      const linuxCeiling = new Set();
      for (const rel of LINUX_SETUP()) {
        const src = read(rel) ?? "";
        for (const m of src.matchAll(/\|\| "\$\(node -v\)" == v(\d+)\*/g)) linuxCeiling.add(m[1]);
      }
      for (const rel of WINDOWS_SETUP()) {
        const src = read(rel) ?? "";
        for (const m of src.matchAll(/node -v\) -match "\^v\(\d+\|(\d+)\)/g)) linuxCeiling.add(m[1]);
      }
      const pins = found.filter((f) => f.kind === "pin").map((f) => f.value);
      for (const ceil of linuxCeiling) {
        if (!pins.includes(ceil)) {
          warns.push(
            `install scripts accept Node ${ceil}, but nothing installs it — every pin is ${[...new Set(pins)].join("/")}. ` +
              `A host that already has ${ceil} is accepted and never tested.`,
          );
        }
      }
      return warns;
    },
  },

  {
    id: "go-pin",
    label: "Go toolchain",
    agree: "major.minor",
    minSites: 8,
    sites: [
      { file: "agent/go.mod", label: "go directive", kind: "pin",
        re: /^go (\d+\.\d+)/gm, pick: (m) => m[1] },
      { files: LINUX_SETUP, label: "go version accept floor", kind: "accept-range",
        re: /go1\\\.\((\d)\[(\d)-9\]/g, pick: (m) => `1.${m[1]}${m[2]}` },
      { files: WINDOWS_SETUP, label: "go accept floor", kind: "accept-range",
        re: /go1\\\.\((\d)\[(\d)-9\]/g, pick: (m) => `1.${m[1]}${m[2]}` },
      { files: WINDOWS_SETUP, label: "winget id", kind: "pin",
        re: /GoLang\.Go\.(\d+\.\d+)/g, pick: (m) => m[1] },
      { files: WINDOWS_SETUP, label: "MSI fallback URL", kind: "pin",
        re: /go\.dev\/dl\/go(\d+\.\d+)\./g, pick: (m) => m[1] },
      { files: ["docs/INSTALL.md"], label: "prose floor", kind: "prose",
        re: /Go (\d+\.\d+)\+/g, pick: (m) => m[1] },
      // The minimum the app enforces at the agent-build preflight, and the
      // number every operator-facing "install Go N+" string interpolates.
      { file: "src/services/agentBuildService.ts", label: "GO_MINIMUM", kind: "pin",
        re: /GO_MINIMUM = "(\d+\.\d+)"/g, pick: (m) => m[1] },
      { file: "docs/INSTALL.md", label: "supported-versions table", kind: "prose",
        re: /\*\*Go\*\*[^|\n]*\|\s*(\d+\.\d+)\s*\|/g, pick: (m) => m[1] },
    ],
  },

  {
    id: "nginx-floor",
    label: "nginx",
    agree: "major.minor",
    minSites: 5,
    sites: [
      { files: LINUX_SETUP, label: "nginx -v accept floor", kind: "accept-range",
        re: /nginx -v 2>&1 \| grep -qE '(\d)\\\.\((\d)\[(\d)-9\]/g,
        pick: (m) => `${m[1]}.${m[2]}${m[3]}` },
      { files: ["docs/INSTALL.md"], label: "prose floor", kind: "prose",
        re: /nginx[^\n]*?(?:≥|>=)\s*(\d+\.\d+)/gi, pick: (m) => m[1] },
      { file: "docs/INSTALL.md", label: "supported-versions table", kind: "prose",
        re: /\*\*nginx\*\*\s*\|\s*(\d+\.\d+)\s*\|/g, pick: (m) => m[1] },
    ],
  },

  {
    id: "postgres-major",
    label: "PostgreSQL",
    agree: "major",
    minSites: 8,
    sites: [
      { files: UNITS, label: "unit After=/Requires=", kind: "pin",
        re: /postgresql-(\d+)\.service/g, pick: (m) => m[1] },
      { files: WINDOWS_SETUP, label: "winget id", kind: "pin",
        re: /PostgreSQL\.PostgreSQL\.(\d+)/g, pick: (m) => m[1] },
      { files: WINDOWS_SETUP, label: "installer URL", kind: "pin",
        re: /postgresql-(\d+)\.\d+-\d+-windows/g, pick: (m) => m[1] },
      { files: WINDOWS_SETUP, label: "--servicename", kind: "pin",
        re: /--servicename postgresql-(\d+)/g, pick: (m) => m[1] },
      { file: "compose.dev.yml", label: "dev image tag", kind: "pin",
        re: /timescaledb:latest-pg(\d+)/g, pick: (m) => m[1] },
      { files: WORKFLOWS, label: "CI service image", kind: "pin",
        re: /image:\s*postgres:(\d+)-/g, pick: (m) => m[1] },
      { files: ["docs/INSTALL.md"], label: "timescaledb package", kind: "pin",
        re: /timescaledb-2-postgresql-(\d+)/g, pick: (m) => m[1] },
      { files: ["docs/INSTALL.md"], label: "pg_config path", kind: "pin",
        re: /\/usr\/pgsql-(\d+)\//g, pick: (m) => m[1] },
      { file: "docs/INSTALL.md", label: "supported-versions table", kind: "prose",
        re: /\*\*PostgreSQL\*\*\s*\|\s*(\d+)\s*\|/g, pick: (m) => m[1] },
      { file: "README.md", label: "system-requirements table", kind: "prose",
        re: /\|\s*PostgreSQL\s*\|\s*(\d+)\+/g, pick: (m) => m[1] },
    ],
  },

  {
    id: "java-major",
    label: "Java (agent signing)",
    agree: "major",
    minSites: 5,
    sites: [
      { file: "Dockerfile", label: "JDK package", kind: "pin",
        re: /openjdk-(\d+)-jre-headless|java-(\d+)-openjdk/g, pick: (m) => m[1] ?? m[2] },
      { files: LINUX_SETUP, label: "JDK package", kind: "pin",
        re: /java-(\d+)-openjdk|openjdk-(\d+)-jre/g, pick: (m) => m[1] ?? m[2] },
      { files: WINDOWS_SETUP, label: "winget id", kind: "pin",
        re: /Microsoft\.OpenJDK\.(\d+)/g, pick: (m) => m[1] },
      { files: WINDOWS_SETUP, label: "JDK MSI URL", kind: "pin",
        re: /microsoft-jdk-(\d+)-windows/g, pick: (m) => m[1] },
      { file: "docs/INSTALL.md", label: "supported-versions table", kind: "prose",
        re: /\*\*Java\*\*[^|\n]*\|\s*(\d+)\s*\|/g, pick: (m) => m[1] },
    ],
  },

  {
    id: "jsign-pin",
    label: "jsign",
    agree: "major.minor",
    minSites: 3,
    sites: [
      { file: "Dockerfile", label: "release URL", kind: "pin",
        re: /jsign\/releases\/download\/(\d+\.\d+)\//g, pick: (m) => m[1] },
      { files: LINUX_SETUP, label: "JSIGN_VERSION", kind: "pin",
        re: /JSIGN_VERSION="?(\d+\.\d+)"?/g, pick: (m) => m[1] },
      { files: WINDOWS_SETUP, label: "JSIGN_VERSION", kind: "pin",
        re: /JSIGN_VERSION\s*=\s*"(\d+\.\d+)"/g, pick: (m) => m[1] },
    ],
  },
];

// Divergences we have decided to live with, each recorded with the decision it
// defers. An entry here suppresses one file's value from the equality check —
// it does NOT hide it from the report. Empty today; keep it that way by fixing
// drift rather than allow-listing it, and give every entry a real reason.
const ALLOW = [];

/**
 * postgres-source — warn-only, and deliberately not a family.
 *
 * A family asserts "these sites name the same version". This asserts something
 * different: that the RHEL script installs a Postgres that can actually satisfy
 * the units the same script goes on to install. It cannot today —
 * `dnf install -y postgresql-server` + `postgresql-setup --initdb` yields an
 * unversioned postgresql.service, while the shipped units declare
 * Requires=postgresql-15.service and docs/INSTALL.md documents the PGDG
 * packages instead (whose names are also the only ones that satisfy
 * timescaledb-2-postgresql-15).
 *
 * Warn rather than fail: fixing it changes the RHEL install path, which is a
 * behaviour decision for a human, not a drift fix a checker should force.
 */
function checkPostgresSource() {
  const out = [];
  const unitMajors = new Set();
  for (const rel of UNITS()) {
    for (const m of (read(rel) ?? "").matchAll(/postgresql-(\d+)\.service/g)) unitMajors.add(m[1]);
  }
  if (unitMajors.size === 0) return out;

  for (const rel of glob("deploy", /^setup-rhel(-nodb)?\.sh$/)) {
    const src = read(rel) ?? "";
    const appstream = /dnf install -y postgresql-server\b/.test(src) || /postgresql-setup --initdb/.test(src);
    const versioned = /postgresql1\d-server|\/usr\/pgsql-\d+\//.test(src);
    if (appstream && !versioned) {
      out.push(
        `${rel} installs unversioned AppStream postgresql-server (postgresql.service), but the shipped units ` +
          `require postgresql-${[...unitMajors].join("/")}.service and docs/INSTALL.md documents the PGDG ` +
          `packages. The script cannot satisfy its own units, and AppStream's package names cannot satisfy ` +
          `timescaledb-2-postgresql-${[...unitMajors][0]}. Decide the RHEL install path; this is not a pin fix.`,
      );
    }
  }
  return out;
}

// Tags that cannot be pin-checked at all. Reported so a bump session knows what
// the checker is blind to.
const FLOATING = [
  { file: "compose.dev.yml", re: /timescale\/timescaledb:latest-pg\d+/g },
  { file: "docker-compose.yml", re: /nginx:mainline/g },
  { file: "docker-compose.yml", re: /polaris:latest/g },
];

const DATASET = "src/data/platformEol.json";
const DATASET_STALE_DAYS = 120;

// ---------------------------------------------------------------------------

const failures = [];
const warnings = [];
const report = [];

function resolveFiles(site) {
  if (site.file) return [site.file];
  return typeof site.files === "function" ? site.files() : site.files;
}

function collect(family) {
  const found = [];
  const filesSeen = new Set();
  for (const site of family.sites) {
    for (const rel of resolveFiles(site)) {
      const src = readCode(rel);
      if (src === null) continue;
      filesSeen.add(rel);
      let values = [];
      for (const m of src.matchAll(site.re)) {
        const raw = site.pick(m);
        if (raw) values.push(track(raw, family.agree));
      }
      // An accept-range site declares a FLOOR. `[[ node -v == v20* || == v22* ]]`
      // yields two matches, but only the lower one is the requirement — the
      // upper end is a tested-ceiling question, which the family's `extra`
      // check reports separately as a warning.
      if (site.kind === "accept-range" && values.length > 1) {
        values = [values.sort(compareTracks)[0]];
      }
      // A site is either a FLOOR (the minimum this repo requires) or a PIN
      // (the version it actually installs). They are allowed to differ — see
      // the two-number model in the family loop below.
      const role = site.role ?? (site.kind === "accept-range" ? "floor" : "pin");
      for (const value of new Set(values)) {
        found.push({ file: rel, label: site.label, kind: site.kind, role, value });
      }
    }
  }
  return { found, filesSeen };
}

for (const family of FAMILIES) {
  const { found } = collect(family);

  if (found.length === 0) {
    failures.push({
      check: family.id,
      msg: `${family.label}: no declaration sites matched at all. A pin was renamed or a file moved — the patterns in scripts/check-versions.mjs are stale.`,
    });
    continue;
  }
  if (family.minSites && found.length < family.minSites) {
    failures.push({
      check: family.id,
      msg:
        `${family.label}: only ${found.length} declaration site(s) matched, expected at least ${family.minSites}. ` +
        `A site was renamed or removed, or a new install script declares no ${family.label} pin.`,
    });
  }

  const allowed = new Set(ALLOW.filter((a) => a.family === family.id).map((a) => a.file));
  const considered = found.filter((f) => !allowed.has(f.file));

  // A family has TWO numbers, not one, and conflating them was wrong.
  //
  //   FLOOR — the minimum this repo requires: engines.node, the scripts'
  //           accept-checks, NODE_MINIMUM_MAJOR, the docs' minimum column.
  //   PIN   — what it actually installs: the Dockerfiles, the winget/MSI
  //           versions, the module stream, node-version in CI.
  //
  // Node is legitimately 22-floor / 24-pinned: the dependency tree needs
  // >=22.12 but every install path provisions 24, so an install already on a
  // runnable major is not locked out of an update. Demanding all sites be one
  // number would force a false choice between lying in engines and lying in
  // the Dockerfile. What must hold is that each GROUP is internally
  // consistent, and that the floor is not above what we install.
  const floors = [...new Set(considered.filter((f) => f.role === "floor").map((f) => f.value))].sort(compareTracks);
  const pins = [...new Set(considered.filter((f) => f.role === "pin").map((f) => f.value))].sort(compareTracks);

  const describe = (f) => `      ${f.value.padEnd(8)} ${f.role.padEnd(6)} ${f.file} (${f.label})`;
  const lines = (role) => [...new Set(considered.filter((f) => f.role === role).map(describe))].sort();

  report.push({ family: family.id, label: family.label, sites: found.length, floors, pins, found });

  if (floors.length > 1) {
    failures.push({
      check: family.id,
      msg: `${family.label}: the MINIMUM disagrees across sites — found ${floors.join(", ")}.\n` + lines("floor").join("\n"),
    });
  }
  if (pins.length > 1) {
    failures.push({
      check: family.id,
      msg: `${family.label}: the INSTALLED version disagrees across sites — found ${pins.join(", ")}.\n` + lines("pin").join("\n"),
    });
  }
  if (floors.length === 1 && pins.length === 1 && compareTracks(floors[0], pins[0]) > 0) {
    failures.push({
      check: family.id,
      msg:
        `${family.label}: the minimum (${floors[0]}) is ABOVE what every install path provisions (${pins[0]}). ` +
        `A fresh install would fail its own requirement.`,
    });
  }

  for (const w of family.extra?.(found) ?? []) warnings.push({ check: family.id, msg: `${family.label}: ${w}` });
}

/**
 * unversioned-install — warn-only.
 *
 * A site that installs a distro default instead of a named version is invisible
 * to the equality check: there is no number in it to disagree with. It still
 * drifts, just silently and per-host — `default-jre-headless` is Java 17 on
 * Ubuntu 22.04 and Java 21 on 24.04, so two supported Polaris hosts sign agent
 * binaries with different JDK majors and only one of them matches what the
 * Dockerfile and the RHEL and Windows scripts pin.
 */
// Only unversioned installs with NO version verification anywhere near them.
// The Go installs look unversioned too (`dnf install -y golang`,
// `apt-get install -y golang-go`) but are deliberately guarded — RHEL enables
// the go-toolset module stream first, Ubuntu re-checks `go version` against the
// accept-regex and falls back to snap when the distro package is too old. They
// are excluded on purpose: a checker that cries wolf gets ignored, which is the
// failure this whole guard exists to prevent.
const UNVERSIONED = [
  {
    re: /apt-get install -y default-jre-headless/g,
    what: "Java",
    pinned: "java-17-openjdk-headless (RHEL) / Microsoft.OpenJDK.17 (Windows)",
    // A versioned install of the same technology in the SAME file means the
    // unversioned one is a deliberate fallback, not the primary path — the pin
    // check works, and the degradation is logged at install time. Only an
    // unpaired unversioned install is invisible.
    // Matches the INSTALL COMMAND, not the package name. A bare-name regex went
    // quiet twice on a host with no pin at all: first on the comment explaining
    // the fallback, then on the `info` line that reports it. What matters is
    // whether the script actually installs a versioned JDK.
    pairedWith: /(?:apt-get|dnf) install -y (?:openjdk-\d+-jre-headless|java-\d+-openjdk)/,
  },
  {
    // Bare `postgresql` — not postgresql15, not "postgresql${PG_MAJOR}", not
    // postgresql-server (that one is postgres-source's job). On RHEL 9 the
    // unversioned AppStream client is PostgreSQL 13, and pg_dump refuses a
    // server newer than itself: setup-rhel-nodb.sh installed exactly this and
    // every backup on such a host failed with "server version mismatch" while
    // `command -v pg_dump` said all was well (prod, 2026-09-09).
    re: /dnf install -y postgresql(?![0-9"${}\w-])/g,
    what: "the PostgreSQL client tools",
    pinned: "postgresql15 from PGDG — RHEL 9's unversioned AppStream package is PostgreSQL 13, which cannot dump a 15+ server",
    pairedWith: /dnf install -y "?postgresql(?:\$\{PG_(?:CLIENT_)?MAJOR\}|1\d)\b/,
  },
];
function checkUnversionedInstalls() {
  const out = [];
  for (const rel of ALL_SETUP()) {
    // readCode, not read: the pairing test must look at what the script RUNS,
    // not what it says. The comment explaining why the fallback exists names
    // `openjdk-17-jre-headless`, which made this check see a versioned install
    // that was not there and go quiet on a genuinely unpinned host. Same trap
    // as reading a pin out of a comment, one function along.
    const src = readCode(rel) ?? "";
    for (const u of UNVERSIONED) {
      if (u.pairedWith && u.pairedWith.test(src)) continue;
      for (const m of src.matchAll(u.re)) {
        out.push(
          `${rel} installs ${u.what} unversioned (\`${m[0]}\`) — whatever the distro default is — while other ` +
            `sites pin ${u.pinned}. Nothing here can disagree, so nothing here can be checked; the host decides.`,
        );
      }
    }
  }
  return out;
}

for (const msg of checkPostgresSource()) warnings.push({ check: "postgres-source", msg });
for (const msg of checkUnversionedInstalls()) warnings.push({ check: "unversioned-install", msg });

// --- dataset shape ---------------------------------------------------------
const rawDataset = read(DATASET);
if (rawDataset === null) {
  failures.push({ check: "dataset-shape", msg: `${DATASET} is missing — the in-app lifecycle card has no data to grade against.` });
} else {
  let data = null;
  try {
    data = JSON.parse(rawDataset);
  } catch (err) {
    failures.push({ check: "dataset-shape", msg: `${DATASET} does not parse: ${err.message}` });
  }
  if (data) {
    const ids = new Set((data.technologies ?? []).map((t) => t.id));
    const playbooks = new Set((data.playbooks ?? []).map((p) => p.id));

    for (const t of data.technologies ?? []) {
      if (!t.source || !t.sourceCheckedOn) {
        failures.push({ check: "dataset-shape", msg: `${DATASET}: technology "${t.id}" has no source/sourceCheckedOn. Every date must name the page a human read and when.` });
      }
      if (t.upgradePlaybook && !playbooks.has(t.upgradePlaybook)) {
        failures.push({ check: "dataset-shape", msg: `${DATASET}: technology "${t.id}" points at unknown playbook "${t.upgradePlaybook}".` });
      }
    }
    for (const p of data.playbooks ?? []) {
      for (const f of p.files ?? []) {
        if (!existsSync(join(ROOT, f))) {
          failures.push({ check: "dataset-shape", msg: `${DATASET}: playbook "${p.id}" names ${f}, which does not exist. A playbook that sends you to a missing file is worse than none.` });
        }
      }
    }

    // Every checked family must be describable by the dataset.
    const FAMILY_TO_TECH = {
      "node-major": ["node"],
      "go-pin": ["go"],
      "nginx-floor": ["nginx"],
      "postgres-major": ["postgres"],
      "java-major": ["java"],
      "jsign-pin": [],
    };
    for (const family of FAMILIES) {
      for (const techId of FAMILY_TO_TECH[family.id] ?? []) {
        if (!ids.has(techId)) {
          failures.push({ check: "dataset-shape", msg: `${DATASET}: no entry for "${techId}", but check-versions polices the ${family.label} pin. The card would grade a pin it cannot describe.` });
        }
      }
    }

    // ── dataset-docs-mirror ────────────────────────────────────────────────
    // The "Supported platform versions" table in docs/INSTALL.md is the
    // operator-facing mirror of this dataset, and nothing kept the two in step.
    // That gap produced the same bug twice in one day: the table went on saying
    // Node's minimum was 20 after the bump to 22, and went on saying Java
    // targeted 21 after that target was dropped to 17. Both were caught by
    // reading, which is not a mechanism.
    //
    // Only `dated` technologies are compared. TimescaleDB ("2.x" / "current"),
    // Windows Server and PgBouncer state prose in those columns on purpose,
    // because they have no dated lifecycle to mirror.
    const INSTALL_DOC = "docs/INSTALL.md";
    const ROW_TO_TECH = {
      "Node.js": "node",
      "PostgreSQL": "postgres",
      "Go": "go",
      "nginx": "nginx",
      "Java": "java",
      "RHEL / Rocky / AlmaLinux": "os:rhel",
      "Ubuntu": "os:ubuntu",
    };
    const installDoc = read(INSTALL_DOC);
    if (installDoc === null) {
      failures.push({ check: "dataset-docs-mirror", msg: `${INSTALL_DOC} is missing — the canonical supported-versions table cannot be checked.` });
    } else {
      // Pull "| **Node.js** | 22 | **24** | …" into { label, min, target }.
      const seenRows = new Set();
      for (const line of installDoc.split("\n")) {
        if (!line.startsWith("|")) continue;
        const cells = line.split("|").map((c) => c.trim());
        if (cells.length < 5) continue;
        // Strip bold, parenthetical scoping, and an "LTS" suffix.
        const label = cells[1].replace(/\*\*/g, "").replace(/\s*\([^)]*\)\s*/g, "").trim();
        const techId = ROW_TO_TECH[label];
        if (!techId) continue;
        const tech = (data.technologies ?? []).find((t) => t.id === techId);
        if (!tech || tech.policy !== "dated") continue;
        seenRows.add(techId);
        const cell = (raw) => {
          const m = raw.replace(/\*\*/g, "").trim().match(/^(\d+(?:\.\d+)*)/);
          return m ? m[1] : null;
        };
        const docMin = cell(cells[2]);
        const docTarget = cell(cells[3]);
        if (docMin !== null && tech.polarisMinimum && docMin !== tech.polarisMinimum) {
          failures.push({
            check: "dataset-docs-mirror",
            msg: `${INSTALL_DOC} says ${label} minimum is ${docMin}, but ${DATASET} says ${tech.polarisMinimum}. The table is what operators read; keep it in step with the dataset in the same commit.`,
          });
        }
        if (docTarget !== null && tech.polarisTarget && docTarget !== tech.polarisTarget) {
          failures.push({
            check: "dataset-docs-mirror",
            msg: `${INSTALL_DOC} says ${label} targets ${docTarget}, but ${DATASET} says ${tech.polarisTarget}. The table is what operators read; keep it in step with the dataset in the same commit.`,
          });
        }
      }
      // A row that vanished from the table is drift too — silently dropping a
      // technology from the operator-facing list is worse than a wrong number.
      for (const [label, techId] of Object.entries(ROW_TO_TECH)) {
        const tech = (data.technologies ?? []).find((t) => t.id === techId);
        if (tech && tech.policy === "dated" && !seenRows.has(techId)) {
          failures.push({
            check: "dataset-docs-mirror",
            msg: `${INSTALL_DOC}'s supported-versions table has no row for ${label} (dataset id "${techId}"), which the dataset grades on real dates. Add it, or drop the technology from the dataset.`,
          });
        }
      }
    }

    const reviewed = Date.parse(`${data.reviewedAt}T00:00:00Z`);
    if (Number.isNaN(reviewed)) {
      failures.push({ check: "dataset-shape", msg: `${DATASET}: reviewedAt "${data.reviewedAt}" is not an ISO date.` });
    } else {
      const ageDays = Math.floor((Date.now() - reviewed) / 86_400_000);
      if (ageDays > DATASET_STALE_DAYS) {
        warnings.push({
          check: "dataset-shape",
          msg: `${DATASET} was last reviewed ${ageDays} days ago (>${DATASET_STALE_DAYS}). Refresh it: /polaris-tech-lifecycle → references/eol-dataset.md.`,
        });
      }
    }
  }
}

// --- floating tags (informational) -----------------------------------------
const floating = [];
for (const f of FLOATING) {
  const src = read(f.file);
  if (src === null) continue;
  for (const m of src.matchAll(f.re)) floating.push(`${m[0]} (${f.file})`);
}

// --- output ----------------------------------------------------------------
if (JSON_OUT) {
  console.log(JSON.stringify({ ok: failures.length === 0, failures, warnings, families: report, floating }, null, 2));
  process.exit(failures.length === 0 ? 0 : 1);
}

for (const w of warnings) console.log(`⚠ check-versions (warn) [${w.check}]: ${w.msg}\n`);

if (floating.length > 0) {
  console.log(`ℹ check-versions: ${floating.length} floating tag(s) — these move under you and cannot be pin-checked:`);
  for (const f of [...new Set(floating)]) console.log(`      ${f}`);
  console.log("");
}

if (failures.length > 0) {
  console.error(`✗ check-versions: ${failures.length} issue(s) found.\n`);
  for (const f of failures) console.error(`  [${f.check}] ${f.msg}\n`);
  console.error("Every site for a version must agree. The full site list per family is in");
  console.error(".claude/skills/polaris-tech-lifecycle/references/version-pin-inventory.md.");
  process.exit(1);
}

const totalSites = report.reduce((n, r) => n + r.sites, 0);
console.log(`✓ check-versions: ${report.length} families consistent (${totalSites} declaration sites).`);
for (const r of report) {
  // Show floor→pin when they differ, so "22 → 24" reads as the deliberate
  // arrangement it is rather than looking like unresolved drift.
  const f = r.floors.join("/");
  const p = r.pins.join("/");
  const shape = f === p ? p : !f ? p : !p ? f : `${f} → ${p}`;
  console.log(`      ${r.label.padEnd(22)} ${shape.padEnd(12)} (${r.sites} sites)`);
}
if (ALLOW.length > 0) {
  console.log(`\n  ${ALLOW.length} allow-listed divergence(s) excluded from the equality check:`);
  for (const a of ALLOW) console.log(`      [${a.family}] ${a.file}`);
}
process.exit(0);
