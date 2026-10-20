/**
 * tests/unit/agentHostPinService.test.ts — the pure parts of business rule 123:
 * which address strings a pin may be keyed on, and the defensive read of the
 * archive JSON. The database paths are in tests/integration/agentHostPinArchive.test.ts.
 */

import { describe, it, expect } from "vitest";
import { assetPinHosts, parseArchivedPins } from "../../src/services/agentHostPinService.js";

describe("assetPinHosts", () => {
  it("lists ip, dns name and hostname in dial order, de-duplicated and trimmed", () => {
    expect(assetPinHosts({ ipAddress: "10.0.0.5", dnsName: " srv.example.com ", hostname: "srv" }))
      .toEqual(["10.0.0.5", "srv.example.com", "srv"]);
    expect(assetPinHosts({ ipAddress: "srv", dnsName: null, hostname: "srv" })).toEqual(["srv"]);
    expect(assetPinHosts({ ipAddress: null, dnsName: "", hostname: null })).toEqual([]);
  });
});

describe("parseArchivedPins", () => {
  it("keeps well-formed entries and drops the rest", () => {
    const pins = parseArchivedPins([
      { kind: "ssh", host: "10.0.0.5", port: 22, fingerprint: "SHA256:x", keyType: "ssh-ed25519", firstSeen: "2026-01-01T00:00:00.000Z", lastSeen: "2026-02-01T00:00:00.000Z" },
      { kind: "tls", host: "10.0.0.5", port: 5986, fingerprint: "AB", subject: "CN=x" },
      { kind: "ftp", host: "10.0.0.5", port: 21, fingerprint: "x" },
      { kind: "ssh", host: "10.0.0.5", port: 70000, fingerprint: "x" },
      null,
      "junk",
    ]);
    expect(pins.map((p) => `${p.kind}:${p.port}`)).toEqual(["ssh:22", "tls:5986"]);
    expect(pins[0].keyType).toBe("ssh-ed25519");
    expect(pins[1].subject).toBe("CN=x");
    expect(pins[1].firstSeen).toBe(new Date(0).toISOString());
  });

  it("reads a non-array as no pins", () => {
    expect(parseArchivedPins(null)).toEqual([]);
    expect(parseArchivedPins({ kind: "ssh" })).toEqual([]);
  });
});
