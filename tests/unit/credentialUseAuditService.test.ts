/**
 * tests/unit/credentialUseAuditService.test.ts
 *
 * Business rule 112: aiming a stored credential at a destination is allowed
 * and recorded; a credential the caller neither owns nor may use by grant is
 * recorded as BORROWED (warning). These are the pure halves — which writes
 * count as a use, and what each Event says.
 */

import { describe, it, expect } from "vitest";
import {
  isBorrowed,
  buildCredentialUseEvents,
  assetCredentialUses,
  credentialRefs,
  changedCredentialRefs,
  scanCredentialUses,
  summarizeTargets,
  CREDENTIAL_BORROWED_ACTION,
  CREDENTIAL_USED_ACTION,
} from "../../src/services/credentialUseAuditService.js";

const alice = { username: "alice", mayUseAny: false };
const admin = { username: "root", mayUseAny: true };
const cred = (id: string, createdBy: string | null) => ({ id, name: `cred-${id}`, type: "ssh", createdBy });

describe("isBorrowed", () => {
  it("is false for the owner and for a Full RW caller", () => {
    expect(isBorrowed(alice, "alice")).toBe(false);
    expect(isBorrowed(admin, "bob")).toBe(false);
    expect(isBorrowed(admin, null)).toBe(false);
  });
  it("is true for someone else's credential, an unowned one, and a caller with no username", () => {
    expect(isBorrowed(alice, "bob")).toBe(true);
    expect(isBorrowed(alice, null)).toBe(true);
    expect(isBorrowed({ username: null, mayUseAny: false }, null)).toBe(true);
  });
});

describe("buildCredentialUseEvents", () => {
  it("writes a warning credential.borrowed row naming the owner, the destination and the asset", () => {
    const [e] = buildCredentialUseEvents(alice, "asset.update", [
      { credentialId: "c1", destination: "10.0.0.9", assetId: "a1", assetName: "fw1" },
    ], [cred("c1", "bob")]);
    expect(e.action).toBe(CREDENTIAL_BORROWED_ACTION);
    expect(e.level).toBe("warning");
    expect(e.resourceType).toBe("credential");
    expect(e.resourceId).toBe("c1");
    expect(e.assetId).toBe("a1");
    expect(e.message).toBe('alice used credential "cred-c1" (owned by bob) against 10.0.0.9 (asset fw1) — asset edit');
    expect(e.details).toMatchObject({ via: "asset.update", credentialOwner: "bob", borrowed: true, destination: "10.0.0.9" });
  });

  it("writes an info credential.used row for the owner", () => {
    const [e] = buildCredentialUseEvents(alice, "asset.snmp-walk", [{ credentialId: "c1", destination: "10.0.0.9" }], [cred("c1", "alice")]);
    expect(e.action).toBe(CREDENTIAL_USED_ACTION);
    expect(e.level).toBe("info");
  });

  it("skips an id with no credential row and folds duplicates", () => {
    const rows = buildCredentialUseEvents(alice, "network-scan.run", [
      { credentialId: "c1", destination: "10.0.0.0/24" },
      { credentialId: "c1", destination: "10.0.0.0/24" },
      { credentialId: "gone", destination: "10.0.0.0/24" },
    ], [cred("c1", "alice")]);
    expect(rows).toHaveLength(1);
  });

  it("writes the display actor when one is given (a bearer token)", () => {
    const [e] = buildCredentialUseEvents({ username: null, actor: "api:ci", mayUseAny: false }, "path-check.test",
      [{ credentialId: "c1", destination: "http https://x" }], [cred("c1", "bob")]);
    expect(e.actor).toBe("api:ci");
    expect(e.action).toBe(CREDENTIAL_BORROWED_ACTION);
  });
});

describe("assetCredentialUses", () => {
  const base = { id: "a1", hostname: "srv1", ipAddress: "10.0.0.5", dnsName: null };

  it("counts every credential on a new asset", () => {
    const uses = assetCredentialUses(null, { ...base, monitorCredentialId: "c1", cpuMemoryCredentialId: "c2" });
    expect(uses.map((u) => u.credentialId).sort()).toEqual(["c1", "c2"]);
    expect(uses[0].destination).toBe("10.0.0.5");
  });

  it("counts only a slot that changed when the address did not", () => {
    const before = { ...base, monitorCredentialId: "c1", cpuMemoryCredentialId: "c2" };
    const uses = assetCredentialUses(before, { ...before, cpuMemoryCredentialId: "c3" });
    expect(uses.map((u) => u.credentialId)).toEqual(["c3"]);
  });

  it("counts nothing for a re-save", () => {
    const before = { ...base, monitorCredentialId: "c1" };
    expect(assetCredentialUses(before, { ...before })).toEqual([]);
  });

  it("counts every attached credential when the address moved", () => {
    const before = { ...base, monitorCredentialId: "c1", lldpCredentialId: "c2" };
    const uses = assetCredentialUses(before, { ...before, ipAddress: "198.51.100.7" });
    expect(uses.map((u) => u.credentialId).sort()).toEqual(["c1", "c2"]);
    expect(uses.every((u) => u.destination === "198.51.100.7")).toBe(true);
  });

  it("does not count clearing the address as a move", () => {
    const before = { ...base, monitorCredentialId: "c1" };
    expect(assetCredentialUses(before, { ...before, ipAddress: null })).toEqual([]);
  });
});

describe("credentialRefs / changedCredentialRefs", () => {
  const cfg = { host: "fmg", fortiswitchMonitor: { monitorCredentialId: "c1", sshCredentialId: null }, serverMonitor: { winrmCredentialId: "c2" } };

  it("finds credential ids at any depth, by path", () => {
    expect([...credentialRefs(cfg)]).toEqual([["fortiswitchMonitor.monitorCredentialId", "c1"], ["serverMonitor.winrmCredentialId", "c2"]]);
  });

  it("reports only what changed", () => {
    const after = { ...cfg, fortiswitchMonitor: { monitorCredentialId: "c1", sshCredentialId: "c3" } };
    expect(changedCredentialRefs(cfg, after)).toEqual([{ path: "fortiswitchMonitor.sshCredentialId", credentialId: "c3" }]);
    expect(changedCredentialRefs(cfg, cfg)).toEqual([]);
    expect(changedCredentialRefs(null, { credentialId: "c9" })).toEqual([{ path: "credentialId", credentialId: "c9" }]);
  });
});

describe("scanCredentialUses", () => {
  const targets = [{ kind: "cidr", value: "10.4.0.0/24" }];
  const methods = [{ type: "icmp" }, { type: "ssh", credentialIds: ["c1", "c2"] }];

  it("counts every credential on a new Discovery and on a run", () => {
    expect(scanCredentialUses(null, { targets, methods })).toHaveLength(2);
    expect(scanCredentialUses({ targets, methods }, { targets, methods }, true)).toHaveLength(2);
  });

  it("counts only an added credential when the targets did not move", () => {
    const after = { targets, methods: [{ type: "ssh", credentialIds: ["c1", "c2", "c3"] }] };
    expect(scanCredentialUses({ targets, methods }, after).map((u) => u.credentialId)).toEqual(["c3"]);
    expect(scanCredentialUses({ targets, methods }, { targets, methods })).toEqual([]);
  });

  it("counts every credential when the targets moved", () => {
    const after = { targets: [{ kind: "single", value: "203.0.113.9" }], methods };
    const uses = scanCredentialUses({ targets, methods }, after);
    expect(uses.map((u) => u.credentialId)).toEqual(["c1", "c2"]);
    expect(uses[0].destination).toBe("203.0.113.9");
  });
});

describe("summarizeTargets", () => {
  it("lists ten values then a count", () => {
    const t = Array.from({ length: 12 }, (_, i) => ({ kind: "single", value: `10.0.0.${i}` }));
    expect(summarizeTargets(t)).toBe("10.0.0.0, 10.0.0.1, 10.0.0.2, 10.0.0.3, 10.0.0.4, 10.0.0.5, 10.0.0.6, 10.0.0.7, 10.0.0.8, 10.0.0.9 and 2 more");
    expect(summarizeTargets([])).toBe("(no targets)");
  });
});
