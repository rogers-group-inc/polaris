#!/usr/bin/env node
/**
 * scripts/fetch-std-mibs.mjs — pull the eleven canonical standard MIB
 * modules backing the twelve browse-tree keys in the SNMP Walk tab. Modules
 * and keys are not 1:1: IF-MIB serves both std:interfaces and std:if-ext.
 *
 * Each module is written to src/services/stdMibs/ and a SHA-256 line is
 * appended to SOURCES.md alongside the source URL it actually came from.
 *
 * Two mirrors, tracked per module in `mirror`:
 *   pysnmp   — https://mibs.pysnmp.com/asn1/<MODULE>   (the original source
 *              for the first seven modules; tracks IETF + IEEE upstreams)
 *   netdisco — the netdisco-mibs `rfc/` tree, used for the four modules added
 *              in the switch physical-layer work (POWER-ETHERNET / BRIDGE /
 *              Q-BRIDGE / RSTP) because the pysnmp mirror was returning
 *              HTTP 522 at the time. Each of those four was verified after
 *              download: correct `<NAME> DEFINITIONS ::= BEGIN` envelope, an
 *              RFC reference and LAST-UPDATED matching the published RFC
 *              (3621 / 4188 / 4363 / 4318), IETF Trust copyright present, and
 *              — the real check — every symbol resolving to its canonical
 *              OID through scripts/smoke-std-mibs.ts.
 *
 * Re-run this script to refresh the bundle; existing files are overwritten in
 * place. Network access required. If a mirror is down, prefer fixing the URL
 * over silently swapping sources — the SHA-256 in SOURCES.md is what makes a
 * substituted file detectable.
 */
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import https from "node:https";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, "..", "src", "services", "stdMibs");

const MIBS = [
  { module: "SNMPv2-MIB",       stdKey: "std:system",          mirror: "pysnmp",   rootOid: "1.3.6.1.2.1.1",   description: "RFC 3418 — system group + sysObjectID/sysDescr/sysUpTime/sysContact/etc." },
  { module: "IF-MIB",           stdKey: "std:interfaces",      mirror: "pysnmp",   rootOid: "1.3.6.1.2.1.2",   description: "RFC 2863 — ifTable (legacy 32-bit counters) + ifXTable. Single file backs both std:interfaces and std:if-ext." },
  { module: "HOST-RESOURCES-MIB", stdKey: "std:host-resources", mirror: "pysnmp",  rootOid: "1.3.6.1.2.1.25", description: "RFC 2790 — hrStorageTable / hrProcessorTable / hrSWRunTable." },
  { module: "ENTITY-MIB",       stdKey: "std:entity",          mirror: "pysnmp",   rootOid: "1.3.6.1.2.1.47",  description: "RFC 4133 — entPhysicalTable hardware inventory." },
  { module: "ENTITY-SENSOR-MIB", stdKey: "std:entity-sensor",  mirror: "pysnmp",   rootOid: "1.3.6.1.2.1.99",  description: "RFC 3433 — entPhySensorTable temperature/voltage/etc." },
  { module: "LLDP-MIB",         stdKey: "std:lldp",            mirror: "pysnmp",   rootOid: "1.0.8802.1.1.2",  description: "IEEE 802.1AB — lldpLocPortTable / lldpRemTable / lldpRemManAddrTable. Re-read the IEEE license boilerplate before bundling updates." },
  { module: "POWER-ETHERNET-MIB", stdKey: "std:poe",           mirror: "netdisco", rootOid: "1.3.6.1.2.1.105", description: "RFC 3621 — pethPsePortTable (per-port PoE detection status + power class) / pethMainPseTable (per-PSE consumption watts). No per-port wattage object exists in this MIB." },
  { module: "BRIDGE-MIB",       stdKey: "std:bridge",          mirror: "netdisco", rootOid: "1.3.6.1.2.1.17",  description: "RFC 4188 — dot1dTpFdbTable (MAC forwarding), dot1dBasePortIfIndex (the basePort→ifIndex join), dot1dStp (spanning tree). Q-BRIDGE-MIB and RSTP-MIB both anchor on symbols from here." },
  { module: "Q-BRIDGE-MIB",     stdKey: "std:q-bridge",        mirror: "netdisco", rootOid: "1.3.6.1.2.1.17.7", description: "RFC 4363 — dot1qTpFdbTable, the VLAN-aware forwarding database a VLAN-aware switch populates instead of dot1dTpFdbTable." },
  { module: "IP-MIB",           stdKey: "std:ip",              mirror: "pysnmp",   rootOid: "1.3.6.1.2.1.4",   description: "RFC 4293 — the ip group. ipNetToPhysicalTable (the neighbour cache: ARP for IPv4, NDP for IPv6) and its deprecated RFC 1213 predecessor ipNetToMediaTable, plus ipAddressTable and the IP counters. The neighbour tables are the L3 counterpart to BRIDGE-MIB's forwarding database." },
  { module: "RSTP-MIB",         stdKey: "std:rstp",            mirror: "netdisco", rootOid: "1.3.6.1.2.1.134", description: "RFC 4318 — dot1dStpExtPortTable (oper edge-port / point-to-point / protocol migration), the RSTP complement to BRIDGE-MIB's dot1dStp." },
];

/** Where each mirror serves a module's ASN.1 text. */
const MIRRORS = {
  pysnmp:   (m) => `https://mibs.pysnmp.com/asn1/${encodeURIComponent(m)}`,
  netdisco: (m) => `https://raw.githubusercontent.com/netdisco/netdisco-mibs/master/rfc/${encodeURIComponent(m)}.txt`,
};

function fetch(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { "User-Agent": "polaris-mib-fetch/1.0" } }, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetch(res.headers.location).then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`${url} → HTTP ${res.statusCode}`));
      }
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
      res.on("error", reject);
    }).on("error", reject);
  });
}

function sha256(text) {
  return createHash("sha256").update(text, "utf-8").digest("hex");
}

async function main() {
  const sourcesLines = [
    "# Standard MIB sources",
    "",
    "These canonical MIB modules back the SNMP Walk tab's browse tree for",
    "built-in MIBs (`std:system`, `std:interfaces`, `std:if-ext`, `std:host-resources`,",
    "`std:entity`, `std:entity-sensor`, `std:lldp`, `std:poe`, `std:bridge`,",
    "`std:q-bridge`, `std:rstp`, `std:ip`). They are loaded by",
    "[../stdMibLibrary.ts](../stdMibLibrary.ts) at first use.",
    "",
    "Re-pull via:",
    "",
    "```",
    "node scripts/fetch-std-mibs.mjs",
    "```",
    "",
    "Source mirrors (per-module, see the `mirror` field in the fetch script):",
    "",
    "- <https://mibs.pysnmp.com/> — tracks IETF + IEEE upstreams. Source of every",
    "  module except the four below.",
    "- <https://github.com/netdisco/netdisco-mibs> (`rfc/` tree) — source of the four",
    "  switch physical-layer modules (POWER-ETHERNET / BRIDGE / Q-BRIDGE / RSTP),",
    "  whose download from pysnmp was returning HTTP 522 when they were added. Each",
    "  was verified after download: correct `<NAME> DEFINITIONS ::= BEGIN` envelope,",
    "  an RFC reference and `LAST-UPDATED` matching the published RFC, IETF Trust",
    "  copyright present, and — the check that actually matters — every expected",
    "  symbol resolving to its canonical OID via `scripts/smoke-std-mibs.ts`.",
    "",
    "## Files",
    "",
    "| Module | std key | Root OID | Source URL | SHA-256 | Bytes |",
    "|---|---|---|---|---|---|",
  ];

  for (const m of MIBS) {
    const buildUrl = MIRRORS[m.mirror];
    if (!buildUrl) throw new Error(`${m.module}: unknown mirror "${m.mirror}"`);
    const url = buildUrl(m.module);
    process.stdout.write(`Fetching ${m.module} (${m.mirror})… `);
    // Normalize to LF before writing AND hashing. `.gitattributes` has
    // `* text=auto`, so a CRLF-served module (IP-MIB from pysnmp is one) is
    // stored LF in the git blob regardless -- hashing the served bytes would
    // record a SHA-256 that never matches the bundled file, defeating the one
    // mechanism that makes a substituted MIB detectable. Every module already
    // served LF, so no existing hash changes.
    const text = (await fetch(url)).replace(/\r\n/g, "\n");
    const filename = `${m.module}.txt`;
    const outPath = join(outDir, filename);
    writeFileSync(outPath, text, "utf-8");
    const hash = sha256(text);
    const bytes = Buffer.byteLength(text, "utf-8");
    sourcesLines.push(`| \`${m.module}\` | \`${m.stdKey}\` | \`${m.rootOid}\` | <${url}> | \`${hash}\` | ${bytes} |`);
    console.log(`${bytes} bytes, ${hash.slice(0, 12)}…`);
  }

  sourcesLines.push("");
  // Everything below is hand-maintained prose that lives in the GENERATOR, not
  // in the output file. It used to live only in SOURCES.md, where re-running
  // this script silently deleted it (found 2026-08-21 while adding IP-MIB).
  // Edit it here so a refresh reproduces the whole document.
  sourcesLines.push("## Cross-module anchors");
  sourcesLines.push("");
  sourcesLines.push("`stdMibLibrary` resolves each module independently against `BUILT_IN_OIDS` —");
  sourcesLines.push("there is no cross-MIB visibility between bundled modules. Two of these anchor on");
  sourcesLines.push("a sibling's symbol via IMPORTS and therefore need that symbol seeded in");
  sourcesLines.push("`oidRegistry.BUILT_IN_OIDS`, or they resolve to (almost) nothing:");
  sourcesLines.push("");
  sourcesLines.push("| Module | Anchors on | Seeded as | Without the seed |");
  sourcesLines.push("|---|---|---|---|");
  sourcesLines.push("| `Q-BRIDGE-MIB` | `dot1dBridge` (BRIDGE-MIB) | `1.3.6.1.2.1.17` | 0 of 129 assignments resolve |");
  sourcesLines.push("| `RSTP-MIB` | `dot1dStp` (BRIDGE-MIB) | `1.3.6.1.2.1.17.2` | 9 of 19 assignments resolve |");
  sourcesLines.push("");
  sourcesLines.push("Check the IMPORTS of any newly-added module for symbols used as OID parents.");
  sourcesLines.push("`IP-MIB` needs no seed: it hangs off `mib-2` like the rest, and its IMPORTS");
  sourcesLines.push("(InetAddressType, InterfaceIndex, …) are textual conventions, not OID parents.");
  sourcesLines.push("");
  sourcesLines.push("## Known cosmetic gap");
  sourcesLines.push("");
  sourcesLines.push("`BRIDGE-MIB`'s `dot1dBasePort` and `LLDP-MIB`'s two `*ManAddrSubtype` symbols");
  sourcesLines.push("render as \"(unresolved)\" in the browse tree. This is a pre-existing quirk of the");
  sourcesLines.push("regex extractor in `oidRegistry.parseObjectAssignments`, which skips those");
  sourcesLines.push("particular OBJECT-TYPE definitions; it is display-only and affects no collector,");
  sourcesLines.push("since collectors use numeric OIDs. Notably `dot1dBasePortIfIndex` — the");
  sourcesLines.push("basePort→ifIndex join every FDB and STP row depends on — resolves correctly.");
  sourcesLines.push("Changing `ASSIGNMENT_RE` to close the gap is guarded by the 102 cases in");
  sourcesLines.push("`tests/unit/mibParseStructured.test.ts`.");
  sourcesLines.push("");
  sourcesLines.push("## Licensing");
  sourcesLines.push("");
  sourcesLines.push("- **IETF RFC-derived MIBs** (SNMPv2-MIB, IF-MIB, HOST-RESOURCES-MIB, ENTITY-MIB,");
  sourcesLines.push("  ENTITY-SENSOR-MIB, POWER-ETHERNET-MIB, BRIDGE-MIB, Q-BRIDGE-MIB, RSTP-MIB,");
  sourcesLines.push("  IP-MIB) carry the IETF Trust legal provisions — permissive, allows bundling");
  sourcesLines.push("  and redistribution.");
  sourcesLines.push("- **LLDP-MIB** (IEEE 802.1AB) carries an IEEE-specific copyright header. IEEE");
  sourcesLines.push("  historically allows reproduction of standalone MIB modules; the boilerplate is");
  sourcesLines.push("  preserved in the file. Re-read the in-file header on every refresh and have a");
  sourcesLines.push("  human verify before committing significant version changes.");
  sourcesLines.push("- **A manufacturer MIB never goes in this directory.** The vendor MIBs Polaris");
  sourcesLines.push("  ships live in `../vendorMibs/` and are SEEDED into the MIB Database as rows an");
  sourcesLines.push("  operator can delete, not baked in here where `loadStandardLayer` globs them and");
  sourcesLines.push("  nobody can. See that directory's SOURCES.md for the distinction and the");
  sourcesLines.push("  licensing position on shipping a vendor's file at all.");
  sourcesLines.push("- **IEEE8021-* modules are deliberately NOT bundled** (e.g. IEEE8021-MSTP-MIB for");
  sourcesLines.push("  per-MSTI spanning tree). They carry IEEE copyright and would need the same");
  sourcesLines.push("  human licensing review LLDP-MIB got. Operators can upload them instead — the");
  sourcesLines.push("  IEEE 802.1 anchor chain is seeded in `BUILT_IN_OIDS` so a single leaf module");
  sourcesLines.push("  resolves without also uploading IEEE8021-TC-MIB.");
  sourcesLines.push("");

  writeFileSync(join(outDir, "SOURCES.md"), sourcesLines.join("\n"), "utf-8");
  console.log(`\nWrote ${MIBS.length} MIB files + SOURCES.md to ${outDir}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
