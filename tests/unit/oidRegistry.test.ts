import { describe, it, expect } from "vitest";
import {
  BUILT_IN_OIDS,
  findUnresolvedRootSymbols,
  parseObjectAssignments,
  tryResolveParts,
} from "../../src/services/oidRegistry.js";

/**
 * Resolve a whole MIB body the way `resolveScope` does — seed the numeric
 * table, then make repeated forward passes until one adds nothing. Returns the
 * resolved map plus whatever never resolved, so a test can assert on both.
 */
function resolveAll(rawMib: string, seed: Record<string, string> = BUILT_IN_OIDS) {
  const all = parseObjectAssignments(rawMib);
  const pending = [...all];
  const numeric = new Map<string, string>(Object.entries(seed));

  let progress = true;
  while (progress && pending.length > 0) {
    progress = false;
    for (let i = pending.length - 1; i >= 0; i--) {
      const resolved = tryResolveParts(pending[i].parts, numeric);
      if (resolved != null) {
        numeric.set(pending[i].name, resolved);
        pending.splice(i, 1);
        progress = true;
      }
    }
  }
  return { total: all.length, numeric, unresolved: pending.map((p) => p.name) };
}

/** BUILT_IN_OIDS minus the IEEE 802.1 anchor chain — the pre-fix seed. */
const SEED_WITHOUT_IEEE = Object.fromEntries(
  Object.entries(BUILT_IN_OIDS).filter(
    ([k]) => !["std", "iso8802", "ieee802dot1", "ieee802dot1mibs"].includes(k),
  ),
);

describe("oidRegistry", () => {
  describe("BUILT_IN_OIDS — IEEE 802.1 anchor chain", () => {
    // Cross-checked against the bundled LLDP-MIB, which spells the same chain
    // out longhand: `{ iso std(0) iso8802(8802) ieee802dot1(1)
    // ieee802dot1mibs(1) 2 }` == 1.0.8802.1.1.2.
    it("seeds the chain LLDP-MIB's longhand anchor implies", () => {
      expect(BUILT_IN_OIDS.std).toBe("1.0");
      expect(BUILT_IN_OIDS.iso8802).toBe("1.0.8802");
      expect(BUILT_IN_OIDS.ieee802dot1).toBe("1.0.8802.1");
      expect(BUILT_IN_OIDS.ieee802dot1mibs).toBe("1.0.8802.1.1");
    });
  });

  describe("BUILT_IN_OIDS — scaffolding only", () => {
    it("carries nothing under the enterprises arc — vendor OIDs come from uploaded MIBs", () => {
      // The 2026-09 boundary: fifteen vendor anchors and eighteen telemetry
      // leaves used to live here so the built-in profiles worked with no
      // upload. A vendor's OID layout is the vendor's MIB's to state.
      // `enterprises` itself (1.3.6.1.4.1) is the IETF node and stays.
      const vendor = Object.entries(BUILT_IN_OIDS).filter(([, oid]) => /^1\.3\.6\.1\.4\.1\.\d/.test(oid));
      expect(vendor).toEqual([]);
      expect(BUILT_IN_OIDS.enterprises).toBe("1.3.6.1.4.1");
      for (const gone of ["fortinet", "fnFortiSwitchMib", "fsSysCpuUsage", "fapTemperature", "cisco", "cpmCPUTotal5secRev", "juniperMIB", "radlan"]) {
        expect(BUILT_IN_OIDS[gone], gone).toBeUndefined();
      }
    });

    it("carries no BRIDGE-MIB anchors — the standard layer supplies them", () => {
      // dot1dBridge / dot1dStp were seeded so Q-BRIDGE-MIB and RSTP-MIB could
      // see a sibling's symbol. The bundled standard modules now resolve
      // together (oidRegistryStandardLayer.test.ts pins that), so a
      // re-seed here would be the old workaround coming back.
      expect(BUILT_IN_OIDS.dot1dBridge).toBeUndefined();
      expect(BUILT_IN_OIDS.dot1dStp).toBeUndefined();
    });
  });

  describe("IEEE8021-* modules anchored on an imported symbol", () => {
    // The IEEE8021-* family (MSTP, bridge extensions) does NOT use the inline
    // named-number idiom LLDP-MIB does. It writes `::= { ieee802dot1mibs N }`
    // with that symbol IMPORTED from IEEE8021-TC-MIB. Every other assignment in
    // the module chains off that one root, so an unseeded anchor doesn't cost a
    // few symbols — it costs the entire MIB, which is what an operator sees as
    // "uploaded, everything unresolved".
    //
    // Excerpt of the real IEEE8021-MSTP-MIB (IEEE Std 802.1Q-2011) covering the
    // root plus one nested table, which is enough to exercise the chaining.
    const MSTP_EXCERPT = `
IEEE8021-MSTP-MIB DEFINITIONS ::= BEGIN

IMPORTS
    MODULE-IDENTITY, OBJECT-TYPE, Unsigned32
        FROM SNMPv2-SMI
    ieee802dot1mibs, IEEE8021MstIdentifier
        FROM IEEE8021-TC-MIB;

ieee8021MstpMib MODULE-IDENTITY
    LAST-UPDATED "201103230000Z"
    ORGANIZATION "IEEE 802.1 Working Group"
    ::= { ieee802dot1mibs 6 }

ieee8021MstpNotifications OBJECT IDENTIFIER ::= { ieee8021MstpMib 0 }
ieee8021MstpObjects      OBJECT IDENTIFIER ::= { ieee8021MstpMib 1 }

ieee8021MstpCistPortTable OBJECT-TYPE
    SYNTAX      SEQUENCE OF Unsigned32
    MAX-ACCESS  not-accessible
    STATUS      current
    DESCRIPTION "CIST port table."
    ::= { ieee8021MstpObjects 3 }

END
`;

    it("resolves the module root and everything chained off it", () => {
      const { total, numeric, unresolved } = resolveAll(MSTP_EXCERPT);

      expect(unresolved).toEqual([]);
      expect(total).toBeGreaterThan(0);
      // { ieee802dot1mibs 6 } → 1.0.8802.1.1.6
      expect(numeric.get("ieee8021MstpMib")).toBe("1.0.8802.1.1.6");
      expect(numeric.get("ieee8021MstpObjects")).toBe("1.0.8802.1.1.6.1");
      expect(numeric.get("ieee8021MstpCistPortTable")).toBe("1.0.8802.1.1.6.1.3");
    });

    // The regression itself: without the seed the failure is total, not partial.
    // Asserting the all-or-nothing shape is the point — it's what distinguishes
    // this bug from an ordinary missing-symbol gap, and what makes the fix a
    // seed rather than a parser change.
    it("resolves NOTHING without the IEEE anchor seeds", () => {
      const { total, numeric, unresolved } = resolveAll(MSTP_EXCERPT, SEED_WITHOUT_IEEE);

      expect(unresolved.length).toBe(total);
      expect(numeric.get("ieee8021MstpMib")).toBeUndefined();
    });
  });

  describe("findUnresolvedRootSymbols", () => {
    const MSTP_EXCERPT = `
IEEE8021-MSTP-MIB DEFINITIONS ::= BEGIN
ieee8021MstpMib MODULE-IDENTITY
    LAST-UPDATED "201103230000Z"
    ::= { ieee802dot1mibs 6 }
ieee8021MstpObjects OBJECT IDENTIFIER ::= { ieee8021MstpMib 1 }
END
`;

    it("names the missing external anchor, not the symptoms chained off it", () => {
      const { numeric } = resolveAll(MSTP_EXCERPT, SEED_WITHOUT_IEEE);
      // `ieee8021MstpObjects` is unresolved too, but it's defined locally — the
      // operator can't upload anything to fix it. Only the genuinely external
      // name is actionable.
      expect(findUnresolvedRootSymbols(MSTP_EXCERPT, numeric)).toEqual(["ieee802dot1mibs"]);
    });

    it("reports nothing once the anchor resolves", () => {
      const { numeric } = resolveAll(MSTP_EXCERPT);
      expect(findUnresolvedRootSymbols(MSTP_EXCERPT, numeric)).toEqual([]);
    });

    // The shape `resolveSymbolsForMib` actually returns: every symbol in the
    // module is a KEY, with null as the value for the ones that didn't
    // resolve. Membership therefore doesn't mean resolution, and a `.has()`
    // test here would report no root causes on precisely the broken MIBs this
    // exists to explain.
    it("treats a null-valued entry as unresolved, not as present", () => {
      const resolvedWithNulls = new Map<string, string | null>([
        ["ieee8021MstpMib", null],
        ["ieee8021MstpObjects", null],
      ]);
      expect(findUnresolvedRootSymbols(MSTP_EXCERPT, resolvedWithNulls)).toEqual([
        "ieee802dot1mibs",
      ]);
    });

    it("deduplicates and sorts across many assignments", () => {
      const mib = `
X-MIB DEFINITIONS ::= BEGIN
aaa OBJECT IDENTIFIER ::= { zzzMissing 1 }
bbb OBJECT IDENTIFIER ::= { zzzMissing 2 }
ccc OBJECT IDENTIFIER ::= { aaaMissing 3 }
END
`;
      expect(findUnresolvedRootSymbols(mib, new Map())).toEqual(["aaaMissing", "zzzMissing"]);
    });
  });

  describe("tryResolveParts", () => {
    it("reads ASN.1 named-number arcs without needing the name defined", () => {
      // LLDP-MIB's anchor form — every arc carries its own number.
      const parts = ["iso", "std(0)", "iso8802(8802)", "ieee802dot1(1)", "ieee802dot1mibs(1)", "2"];
      expect(tryResolveParts(parts, new Map([["iso", "1"]]))).toBe("1.0.8802.1.1.2");
    });

    it("returns null when a bare symbol is unknown", () => {
      expect(tryResolveParts(["somethingUnknown", "4"], new Map())).toBeNull();
    });
  });
});
