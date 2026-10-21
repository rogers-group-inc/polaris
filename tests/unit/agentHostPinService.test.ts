/**
 * tests/unit/agentHostPinService.test.ts — the pure parts of business rule 123:
 * which address strings a pin may be keyed on, and the defensive read of the
 * archive JSON. The database paths are in tests/integration/agentHostPinArchive.test.ts.
 */

import { describe, it, expect } from "vitest";
import { assetPinHosts, parseArchivedPins, pinFingerprintQuery } from "../../src/services/agentHostPinService.js";

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

describe("pinFingerprintQuery", () => {
  it("reads a hex thumbprint with colons, spaces or dashes as upper-case hex", () => {
    expect(pinFingerprintQuery("ab:cd:ef:01")?.hex).toBe("ABCDEF01");
    expect(pinFingerprintQuery("ab cd ef 01 23")?.hex).toBe("ABCDEF0123");
    expect(pinFingerprintQuery("AB-CD-EF-01")?.hex).toBe("ABCDEF01");
  });

  it("reads an SSH fingerprint with or without SHA256: and its padding, case kept", () => {
    expect(pinFingerprintQuery("SHA256:AbCdEf+/12")?.ssh).toBe("AbCdEf+/12");
    expect(pinFingerprintQuery("AbCdEf+/12==")?.ssh).toBe("AbCdEf+/12");
    expect(pinFingerprintQuery("SHA256:AbCdEf+/12")?.hex).toBeNull();
  });

  it("ignores anything shorter than 8 characters or shaped like neither", () => {
    expect(pinFingerprintQuery("abcd")).toBeNull();
    expect(pinFingerprintQuery("ab:cd:ef")).toBeNull();
    expect(pinFingerprintQuery("web-01.corp.example")).toBeNull();
    expect(pinFingerprintQuery("10.0.0.5")).toBeNull();
  });
});
});
