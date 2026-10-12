/**
 * tests/unit/agentSigningService.test.ts
 *
 * Pure + Setting-backed pieces of the internal-CA code-signing service:
 * mask/merge secret discipline, jsign argv building (env: storepass
 * indirection — the keystore password never on argv; explicit RFC3161
 * timestamping), keytool output parsing, the alias advisory, jar resolution
 * order, secret scrubbing, failure-stamp persistence, and config-driven
 * availability gating.
 *
 * NOT testable here (needs a real keystore / host toolchain — covered by the
 * manual verification steps instead): an actual jsign signing run, signature
 * and timestamp validity, the `java -version` probe, and a live keytool open.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../../src/db.js", () => ({
  prisma: {
    setting: { findUnique: vi.fn(), upsert: vi.fn(), delete: vi.fn() },
  },
}));

import {
  MASK,
  SIGNING_PASSWORD_ENV,
  DEFAULT_TSA_URL,
  AGENT_SIGNING_SETTING_KEY,
  SIGNING_FAILURE_SETTING_KEY,
  JSIGN_JAR_CANDIDATES,
  DEFAULT_SIGNING_CONFIG,
  maskSigningConfig,
  mergeSigningConfig,
  isSigningConfigured,
  buildJsignArgs,
  parseKeytoolAliases,
  parseKeytoolCertInfo,
  looksLikePkcs12,
  parseJavaHome,
  aliasAdvisory,
  isKeytoolMissing,
  scrubSecrets,
  resolveJsignJar,
  jsignJarCandidates,
  getSigningConfigRaw,
  updateSigningConfig,
  recordSigningFailure,
  clearSigningFailure,
  getSigningAlert,
  type AgentSigningConfig,
} from "../../src/services/agentSigningService.js";
import { prisma } from "../../src/db.js";

type Mock = ReturnType<typeof vi.fn>;
const findUnique = prisma.setting.findUnique as unknown as Mock;
const upsert = prisma.setting.upsert as unknown as Mock;
const del = prisma.setting.delete as unknown as Mock;

const FULL_CONFIG: AgentSigningConfig = {
  enabled: true,
  keystorePath: "/opt/polaris/tools/codesign.pfx",
  keystorePassword: "super-secret-value",
  alias: "",
  tsaUrl: "http://timestamp.digicert.com",
};

beforeEach(() => {
  vi.clearAllMocks();
  del.mockResolvedValue({});
  upsert.mockResolvedValue({});
});

describe("maskSigningConfig", () => {
  it("masks a stored password and flags it set", () => {
    const m = maskSigningConfig(FULL_CONFIG);
    expect(m.keystorePassword).toBe(MASK);
    expect(m.keystorePasswordSet).toBe(true);
    expect(m.keystorePath).toBe(FULL_CONFIG.keystorePath); // non-secret fields pass through
  });

  it("reports empty password as unset", () => {
    const m = maskSigningConfig({ ...FULL_CONFIG, keystorePassword: "" });
    expect(m.keystorePassword).toBe("");
    expect(m.keystorePasswordSet).toBe(false);
  });
});

describe("mergeSigningConfig", () => {
  it("keeps the stored password when incoming echoes the mask", () => {
    expect(mergeSigningConfig({ keystorePassword: MASK }, FULL_CONFIG).keystorePassword).toBe("super-secret-value");
  });

  it("keeps the stored password when incoming is blank", () => {
    expect(mergeSigningConfig({ keystorePassword: "  " }, FULL_CONFIG).keystorePassword).toBe("super-secret-value");
  });

  it("replaces the password when a new one is typed", () => {
    expect(mergeSigningConfig({ keystorePassword: "new-pw" }, FULL_CONFIG).keystorePassword).toBe("new-pw");
  });

  it("never persists the keystorePasswordSet UI marker", () => {
    const next = mergeSigningConfig({ keystorePasswordSet: true }, FULL_CONFIG);
    expect((next as Record<string, unknown>).keystorePasswordSet).toBeUndefined();
  });

  it("trims strings and strips the TSA's trailing slash", () => {
    const next = mergeSigningConfig(
      { keystorePath: " /srv/cs.pfx ", tsaUrl: " http://tsa.example.com/ " },
      DEFAULT_SIGNING_CONFIG,
    );
    expect(next.keystorePath).toBe("/srv/cs.pfx");
    expect(next.tsaUrl).toBe("http://tsa.example.com");
  });

  // Clearing the TSA field must not silently disable signing (it's part of
  // isSigningConfigured) — it falls back to the documented default instead.
  it("falls back to the default TSA when the field is cleared", () => {
    expect(mergeSigningConfig({ tsaUrl: "" }, FULL_CONFIG).tsaUrl).toBe(DEFAULT_TSA_URL);
    expect(mergeSigningConfig({ tsaUrl: "   " }, FULL_CONFIG).tsaUrl).toBe(DEFAULT_TSA_URL);
  });

  it("leaves omitted fields at their current values", () => {
    const next = mergeSigningConfig({ alias: "codesign" }, FULL_CONFIG);
    expect(next.alias).toBe("codesign");
    expect(next.keystorePath).toBe(FULL_CONFIG.keystorePath);
    expect(next.enabled).toBe(true);
  });

  it("tolerates garbage input", () => {
    expect(mergeSigningConfig(null as unknown as Record<string, unknown>, DEFAULT_SIGNING_CONFIG)).toEqual(
      DEFAULT_SIGNING_CONFIG,
    );
  });
});

describe("isSigningConfigured", () => {
  it("requires keystore path, password and TSA", () => {
    expect(isSigningConfigured(FULL_CONFIG)).toBe(true);
    for (const key of ["keystorePath", "keystorePassword", "tsaUrl"] as const) {
      expect(isSigningConfigured({ ...FULL_CONFIG, [key]: "" })).toBe(false);
    }
  });

  it("does NOT require alias or an explicit jar path", () => {
    expect(isSigningConfigured({ ...FULL_CONFIG, alias: "" })).toBe(true);
  });
});

describe("buildJsignArgs", () => {
  const base = {
    jarPath: "/opt/polaris/tools/jsign.jar",
    keystorePath: "/opt/polaris/tools/codesign.pfx",
    tsaUrl: "http://timestamp.digicert.com",
    filePath: "/data/agents/0.17.1/polaris-agent-windows-amd64.exe",
  };

  it("builds the PKCS12 argv with the file last", () => {
    const args = buildJsignArgs(base);
    expect(args[0]).toBe("-jar");
    expect(args[1]).toBe("/opt/polaris/tools/jsign.jar");
    expect(args[args.indexOf("--storetype") + 1]).toBe("PKCS12");
    expect(args[args.indexOf("--keystore") + 1]).toBe("/opt/polaris/tools/codesign.pfx");
    expect(args[args.length - 1]).toBe(base.filePath);
  });

  it("passes the password via env: indirection — never a literal password on argv", () => {
    const args = buildJsignArgs({ ...base, keystorePath: "/x.pfx" });
    expect(args[args.indexOf("--storepass") + 1]).toBe(`env:${SIGNING_PASSWORD_ENV}`);
    expect(args).not.toContain("super-secret-value");
  });

  // PKCS12 gets no automatic timestamping (unlike a hosted store type), so an
  // explicit tsaurl + RFC3161 mode is what keeps signatures valid past cert
  // expiry. Regressing this silently invalidates the whole fleet at once.
  it("always sets an explicit RFC3161 timestamp authority", () => {
    const args = buildJsignArgs(base);
    expect(args[args.indexOf("--tsaurl") + 1]).toBe("http://timestamp.digicert.com");
    expect(args[args.indexOf("--tsmode") + 1]).toBe("RFC3161");
  });

  it("omits --alias entirely when unset, and includes it when set", () => {
    expect(buildJsignArgs(base)).not.toContain("--alias");
    const withAlias = buildJsignArgs({ ...base, alias: "codesign" });
    expect(withAlias[withAlias.indexOf("--alias") + 1]).toBe("codesign");
  });
});

describe("parseKeytoolAliases", () => {
  it("extracts private-key and trusted-cert alias names", () => {
    const out = parseKeytoolAliases(
      [
        "Keystore type: PKCS12",
        "Keystore provider: SUN",
        "",
        "Your keystore contains 2 entries",
        "",
        "codesign, Jan 1, 2026, PrivateKeyEntry, ",
        "Certificate fingerprint (SHA-256): AB:CD",
        "oldsign, Feb 2, 2025, trustedCertEntry, ",
      ].join("\n"),
    );
    expect(out).toEqual(["codesign", "oldsign"]);
  });

  it("returns an empty list for output with no entries", () => {
    expect(parseKeytoolAliases("Your keystore contains 0 entries")).toEqual([]);
    expect(parseKeytoolAliases("")).toEqual([]);
  });
});

describe("looksLikePkcs12", () => {
  const der = Buffer.concat([Buffer.from([0x30, 0x82, 0x0a, 0x00]), Buffer.alloc(80, 1)]);

  it("accepts a DER-shaped buffer", () => {
    expect(looksLikePkcs12(der).ok).toBe(true);
  });

  // The likeliest operator mistake, and worth its own message: both
  // `openssl pkcs12` and the Windows export wizard can emit base64.
  it("names the PEM case specifically rather than saying 'not a keystore'", () => {
    const pem = Buffer.from("-----BEGIN CERTIFICATE-----\n" + "A".repeat(80));
    const res = looksLikePkcs12(pem);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/PEM/);
    expect(res.error).toMatch(/private key/i);
  });

  it("rejects a too-small file and a non-DER first byte", () => {
    expect(looksLikePkcs12(Buffer.alloc(10)).ok).toBe(false);
    expect(looksLikePkcs12(Buffer.concat([Buffer.from([0x89]), Buffer.alloc(80)])).ok).toBe(false);
  });
});

describe("parseKeytoolCertInfo", () => {
  const NOW = Date.parse("2026-08-26T00:00:00Z");
  const VERBOSE = [
    "Keystore type: PKCS12",
    "Keystore provider: SUN",
    "",
    "Your keystore contains 1 entry",
    "",
    "Alias name: codesign",
    "Creation date: Aug 26, 2026",
    "Entry type: PrivateKeyEntry",
    "Certificate chain length: 2",
    "Certificate[1]:",
    "Owner: CN=Example Publisher, O=Example Org",
    "Issuer: CN=Example Issuing CA, DC=example, DC=com",
    "Serial number: 1a2b3c",
    "Valid from: Wed Aug 26 00:00:00 UTC 2026 until: Fri Aug 26 00:00:00 UTC 2028",
    "Certificate fingerprints:",
    "\t SHA1: AA:BB:CC",
    "\t SHA256: 11:22:33:44:55",
  ].join("\n");

  it("pulls subject, issuer, fingerprint, aliases and the private-key flag", () => {
    const info = parseKeytoolCertInfo(VERBOSE, NOW);
    expect(info.subject).toBe("CN=Example Publisher, O=Example Org");
    expect(info.issuer).toBe("CN=Example Issuing CA, DC=example, DC=com");
    expect(info.fingerprintSha256).toBe("11:22:33:44:55");
    expect(info.aliases).toEqual(["codesign"]);
    expect(info.hasPrivateKey).toBe(true);
  });

  it("computes daysRemaining from the injected clock", () => {
    const info = parseKeytoolCertInfo(VERBOSE, NOW);
    expect(info.validUntilRaw).toBe("Fri Aug 26 00:00:00 UTC 2028");
    // 2026-08-26 → 2028-08-26 spans a leap year (2028), so 731 days.
    expect(info.daysRemaining).toBe(731);
  });

  it("reports a negative daysRemaining once expired", () => {
    const info = parseKeytoolCertInfo(VERBOSE, Date.parse("2029-08-26T00:00:00Z"));
    expect(info.daysRemaining).toBeLessThan(0);
  });

  // keytool formats dates per locale, so the countdown is best-effort — but the
  // displayed expiry must never be lost to an unparseable one.
  it("keeps the raw expiry when the date can't be parsed", () => {
    const odd = VERBOSE.replace(
      "Valid from: Wed Aug 26 00:00:00 UTC 2026 until: Fri Aug 26 00:00:00 UTC 2028",
      "Valid from: 26.08.2026 г. until: 26.08.2028 г.",
    );
    const info = parseKeytoolCertInfo(odd, NOW);
    expect(info.validUntilRaw).toBe("26.08.2028 г.");
    expect(info.daysRemaining).toBeUndefined();
    expect(info.validUntil).toBeUndefined();
  });

  // A keystore with only a cert can't sign — installKeystore refuses it, so
  // this flag has to be right.
  it("flags a keystore with no private key", () => {
    const certOnly = VERBOSE.replace("Entry type: PrivateKeyEntry", "Entry type: trustedCertEntry");
    expect(parseKeytoolCertInfo(certOnly, NOW).hasPrivateKey).toBe(false);
  });

  it("survives empty output", () => {
    const info = parseKeytoolCertInfo("", NOW);
    expect(info.hasPrivateKey).toBe(false);
    expect(info.aliases).toEqual([]);
    expect(info.subject).toBeUndefined();
  });
});

describe("parseJavaHome", () => {
  // The fallback this feeds exists because java-17-openjdk-headless ships
  // keytool NEXT TO THE JVM rather than necessarily on PATH — so a PATH miss
  // must not be read as "keytool is absent".
  it("extracts java.home from -XshowSettings output", () => {
    const out = [
      "Property settings:",
      "    file.encoding = UTF-8",
      "    java.home = /usr/lib/jvm/java-17-openjdk-17.0.12.0.7-2.el9.x86_64",
      "    java.io.tmpdir = /tmp",
      "",
      'openjdk version "17.0.12" 2026-07-16',
    ].join("\n");
    expect(parseJavaHome(out)).toBe("/usr/lib/jvm/java-17-openjdk-17.0.12.0.7-2.el9.x86_64");
  });

  it("handles a Windows path with spaces", () => {
    expect(parseJavaHome("    java.home = C:\\Program Files\\Microsoft\\jdk-17.0.12\\")).toBe(
      "C:\\Program Files\\Microsoft\\jdk-17.0.12\\",
    );
  });

  it("returns null when the property is absent or the output is empty", () => {
    expect(parseJavaHome("openjdk version \"17.0.12\"")).toBeNull();
    expect(parseJavaHome("")).toBeNull();
  });
});

describe("aliasAdvisory", () => {
  // The failure this exists to surface: an alias that isn't in the keystore
  // otherwise only shows up as a jsign error mid-build.
  it("warns loudly when the configured alias is absent", () => {
    const msg = aliasAdvisory("typo", ["codesign"]);
    expect(msg).toContain("WARNING");
    expect(msg).toContain("typo");
    expect(msg).toContain("codesign");
  });

  it("confirms a configured alias that is present", () => {
    expect(aliasAdvisory("codesign", ["codesign"])).toContain('Alias "codesign" found');
  });

  it("nudges toward setting an alias only for a multi-entry keystore", () => {
    expect(aliasAdvisory("", ["a", "b"])).toContain("set an alias");
    expect(aliasAdvisory("", ["only"])).toBe("");
    expect(aliasAdvisory("", [])).toBe("");
  });
});

describe("isKeytoolMissing", () => {
  it("distinguishes the degraded no-keytool case from a real open failure", () => {
    expect(isKeytoolMissing("keytool not available — password not verified")).toBe(true);
    expect(isKeytoolMissing("keystore password was incorrect")).toBe(false);
    expect(isKeytoolMissing(undefined)).toBe(false);
  });
});

describe("scrubSecrets", () => {
  it("redacts every occurrence of each secret", () => {
    const out = scrubSecrets("failed: pw abc123pass in header abc123pass", ["abc123pass"]);
    expect(out).not.toContain("abc123pass");
    expect(out).toContain("[redacted]");
  });

  it("ignores undefined and too-short values (avoids redacting common substrings)", () => {
    expect(scrubSecrets("error code 5", [undefined, "5"])).toBe("error code 5");
  });
});

describe("resolveJsignJar", () => {
  const savedEnv = process.env.POLARIS_JSIGN_JAR;
  afterEach(() => {
    if (savedEnv === undefined) delete process.env.POLARIS_JSIGN_JAR;
    else process.env.POLARIS_JSIGN_JAR = savedEnv;
  });

  it("exports a non-empty default candidate list ending with the /opt/polaris location", () => {
    expect(JSIGN_JAR_CANDIDATES.length).toBeGreaterThanOrEqual(2);
    expect(JSIGN_JAR_CANDIDATES[JSIGN_JAR_CANDIDATES.length - 1]).toBe("/opt/polaris/tools/jsign.jar");
  });

  // Business rule 105 / scan finding F198: the jar is run with `java -jar`, so
  // no stored or typed path may choose it.
  it("has no setting-supplied path: a stored jsignJarPath is dropped by the merge", () => {
    const merged = mergeSigningConfig({ jsignJarPath: "/tmp/uploads/evil.jar", enabled: true }, DEFAULT_SIGNING_CONFIG);
    expect("jsignJarPath" in merged).toBe(false);
  });

  it("takes POLARIS_JSIGN_JAR first when it is an absolute .jar path", () => {
    process.env.POLARIS_JSIGN_JAR = "/srv/tools/jsign.jar";
    expect(jsignJarCandidates()[0]).toBe("/srv/tools/jsign.jar");
    expect(jsignJarCandidates().slice(1)).toEqual(JSIGN_JAR_CANDIDATES);
  });

  it.each(["relative/jsign.jar", "/srv/tools/not-a-jar.sh", "/srv/tools/jsign.jar.exe", "-jar"])(
    "ignores POLARIS_JSIGN_JAR=%s",
    (value) => {
      process.env.POLARIS_JSIGN_JAR = value;
      expect(jsignJarCandidates()).toEqual(JSIGN_JAR_CANDIDATES);
    },
  );

  it("finds nothing at a path that does not exist", async () => {
    process.env.POLARIS_JSIGN_JAR = "/definitely/not/here/jsign.jar";
    // The env path is tried, does not exist, and the fixed candidates are
    // probed after it; on a machine without jsign installed that is null.
    const p = await resolveJsignJar();
    expect(p === null || JSIGN_JAR_CANDIDATES.includes(p)).toBe(true);
  });
});

describe("Setting persistence", () => {
  it("returns defaults when no row exists", async () => {
    findUnique.mockResolvedValue(null);
    expect(await getSigningConfigRaw()).toEqual(DEFAULT_SIGNING_CONFIG);
  });

  it("defaults ship signing disabled but with a usable TSA", () => {
    expect(DEFAULT_SIGNING_CONFIG.enabled).toBe(false);
    expect(DEFAULT_SIGNING_CONFIG.tsaUrl).toBe(DEFAULT_TSA_URL);
  });

  it("tolerates a garbage row", async () => {
    findUnique.mockResolvedValue({ key: AGENT_SIGNING_SETTING_KEY, value: "oops" });
    expect(await getSigningConfigRaw()).toEqual(DEFAULT_SIGNING_CONFIG);
  });

  it("updateSigningConfig merges + upserts and clears the failure stamp on disable", async () => {
    findUnique.mockResolvedValue({ key: AGENT_SIGNING_SETTING_KEY, value: FULL_CONFIG });
    const masked = await updateSigningConfig({ enabled: false });
    expect(masked.enabled).toBe(false);
    expect(masked.keystorePassword).toBe(MASK); // password preserved through the merge
    expect(upsert).toHaveBeenCalledTimes(1);
    expect(upsert.mock.calls[0][0].where).toEqual({ key: AGENT_SIGNING_SETTING_KEY });
    // enabled true → false must clear the alert stamp
    expect(del).toHaveBeenCalledWith({ where: { key: SIGNING_FAILURE_SETTING_KEY } });
  });

  it("updateSigningConfig does NOT clear the stamp when staying enabled", async () => {
    findUnique.mockResolvedValue({ key: AGENT_SIGNING_SETTING_KEY, value: FULL_CONFIG });
    await updateSigningConfig({ alias: "renamed" });
    expect(del).not.toHaveBeenCalled();
  });

  it("persists the plaintext password (sealing is the db.ts extension's job)", async () => {
    findUnique.mockResolvedValue({ key: AGENT_SIGNING_SETTING_KEY, value: FULL_CONFIG });
    await updateSigningConfig({ keystorePassword: "typed-pw" });
    const written = upsert.mock.calls[0][0].update.value as AgentSigningConfig;
    expect(written.keystorePassword).toBe("typed-pw");
  });
});

describe("failure stamp", () => {
  const FAILURE = {
    at: "2026-08-25T12:00:00.000Z",
    buildId: "b-1",
    version: "0.17.1",
    files: ["polaris-agent-windows-amd64.exe"],
    error: "keystore password was incorrect",
  };

  it("recordSigningFailure upserts the stamp row", async () => {
    await recordSigningFailure(FAILURE);
    expect(upsert.mock.calls[0][0].where).toEqual({ key: SIGNING_FAILURE_SETTING_KEY });
    expect(upsert.mock.calls[0][0].create.value).toEqual(FAILURE);
  });

  it("clearSigningFailure deletes and swallows a missing row", async () => {
    del.mockRejectedValue(new Error("not found"));
    await expect(clearSigningFailure()).resolves.toBeUndefined();
  });

  it("getSigningAlert round-trips a stamp and nulls on absence/garbage", async () => {
    findUnique.mockResolvedValue({ key: SIGNING_FAILURE_SETTING_KEY, value: FAILURE });
    expect((await getSigningAlert()).failure).toEqual(FAILURE);

    findUnique.mockResolvedValue(null);
    expect((await getSigningAlert()).failure).toBeNull();

    findUnique.mockResolvedValue({ key: SIGNING_FAILURE_SETTING_KEY, value: { nonsense: true } });
    expect((await getSigningAlert()).failure).toBeNull();
  });
});
