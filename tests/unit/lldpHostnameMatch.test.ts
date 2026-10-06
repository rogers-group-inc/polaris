/**
 * tests/unit/lldpHostnameMatch.test.ts — the hostname arm of LLDP neighbour
 * matching under business rule 91: a name several assets share is matched to
 * the one under the SAME gate as the scraping asset, else to nothing.
 */

import { describe, it, expect } from "vitest";
import { indexLldpHostname, pickLldpHostnameMatch, type LldpHostnameMatchIndex } from "../../src/utils/lldpHostnameMatch.js";

function index(): LldpHostnameMatchIndex {
  const byHostnameAll = new Map<string, string[]>();
  indexLldpHostname(byHostnameAll, "IDF-1", "swA");
  indexLldpHostname(byHostnameAll, "IDF-1", "swB");
  indexLldpHostname(byHostnameAll, "CORE-1", "swCore");
  indexLldpHostname(byHostnameAll, "SITE-A-FW.example.com", "fgA");
  return {
    byHostnameAll,
    gateIdByAssetId: new Map([
      ["fgA", "fgA"], ["fgB", "fgB"],
      ["swA", "fgA"], ["swB", "fgB"], ["swCore", "fgA"], ["apA", "fgA"],
    ]),
  };
}

describe("indexLldpHostname", () => {
  it("indexes the lower-cased name and, for an FQDN, its leftmost label, once per asset", () => {
    const m = new Map<string, string[]>();
    indexLldpHostname(m, "Host.Example.com", "a");
    indexLldpHostname(m, "host.example.com", "a");
    expect(m.get("host.example.com")).toEqual(["a"]);
    expect(m.get("host")).toEqual(["a"]);
    indexLldpHostname(m, "   ", "b");
    indexLldpHostname(m, null, "b");
    expect(m.size).toBe(2);
  });
});

describe("pickLldpHostnameMatch", () => {
  it("matches a unique name outright", () => {
    expect(pickLldpHostnameMatch(index(), "swA", "core-1")).toBe("swCore");
    expect(pickLldpHostnameMatch(index(), "swA", "site-a-fw")).toBe("fgA");
  });

  it("never matches the scraping asset itself", () => {
    expect(pickLldpHostnameMatch(index(), "swCore", "core-1")).toBeNull();
  });

  it("matches a shared name to the candidate under the scraping asset's gate", () => {
    expect(pickLldpHostnameMatch(index(), "apA", "idf-1")).toBe("swA");
    expect(pickLldpHostnameMatch(index(), "swCore", "idf-1")).toBe("swA");
    // The firewall is its own gate.
    expect(pickLldpHostnameMatch(index(), "fgB", "idf-1")).toBe("swB");
  });

  it("returns null for a shared name when the scraping asset has no known gate", () => {
    expect(pickLldpHostnameMatch(index(), "workstation", "idf-1")).toBeNull();
  });

  it("returns null when no same-named candidate is at the scraping asset's site", () => {
    const idx = index();
    idx.gateIdByAssetId.set("swC", "fgC");
    expect(pickLldpHostnameMatch(idx, "swC", "idf-1")).toBeNull();
  });

  it("excludes the scraping asset before counting, so its own twin is unique", () => {
    // swA scraping and seeing "IDF-1": the only OTHER IDF-1 is swB — but it is
    // at another site, so LLDP cannot have seen it. Null, not swB.
    expect(pickLldpHostnameMatch(index(), "swA", "idf-1")).toBeNull();
  });
});
