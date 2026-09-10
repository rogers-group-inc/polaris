/**
 * src/services/agentSigningService.ts — internal-CA code signing for agent binaries
 *
 * Owns the `agent.codeSigning` Setting (operator config for signing the two
 * Windows agent binaries with an organization-internal code-signing
 * certificate via jsign), the `agent.signing.lastFailure` Setting (the durable
 * failure stamp behind the sidebar "unsigned binaries" alert — in-memory build
 * state has a 1h TTL, which is too short for an alert an operator may not see
 * for days), and the jsign invocation itself.
 *
 * ── Why an internal CA rather than a public one ────────────────────────────
 * Freshly compiled Go binaries are a textbook match for Defender's ML
 * heuristics, and every in-app build produces a new hash, so per-file
 * reputation resets each time. Public trust (a hosted signing service, or an
 * OV cert from a commercial CA) buys durable *publisher* reputation. An
 * internal CA buys something different but sufficient for a managed fleet: a
 * deterministic allow, via a Defender for Endpoint certificate indicator or an
 * App Control for Business publisher rule, instead of waiting on a cloud
 * reputation service to warm up on a hash that changes every build.
 *
 * The trade, accepted deliberately: it covers only machines that trust the
 * internal root. Unmanaged, contractor and not-yet-onboarded hosts see an
 * UNTRUSTED signature, which can present worse than an unsigned binary.
 *
 * ── Keystore ───────────────────────────────────────────────────────────────
 * A PKCS#12 (.pfx/.p12) file on the Polaris host holding the internal-CA
 * issued code-signing cert plus its private key. The password reaches jsign
 * via `--storepass env:POLARIS_SIGNING_PASSWORD` (jsign's env: indirection),
 * never via argv, so it cannot appear in process listings or error output; the
 * same indirection carries it to keytool's `-storepass:env` in the test path.
 *
 * The password is sealed at rest by the Prisma extension in src/db.ts — which
 * is why the field is named `keystorePassword` AND that name is registered in
 * utils/configSecretFields.ts. Renaming it without touching that set would
 * silently store the password in plaintext.
 *
 * NOTE the private key lives on disk, so its custody rests on host hardening
 * (0400, owned by the service user). A leaked internal signing key lets an
 * attacker sign anything the fleet trusts — a materially worse blast radius
 * than a hosted HSM service. Flagged here because the mitigation is
 * operational and nothing in this module can enforce it.
 *
 * ── Timestamping is REQUIRED, not optional ─────────────────────────────────
 * jsign auto-enables RFC3161 timestamping only for hosted store types. For
 * PKCS12 it must be passed explicitly, so `tsaUrl` is part of
 * `isSigningConfigured()`: without a countersignature every signature in the
 * fleet goes invalid the moment the signing cert expires — all at once, on a
 * date nobody is watching. A public RFC3161 TSA is valid with an internal-CA
 * cert (a TSA attests to time, not identity) and is the shipped default.
 *
 * Signing is FAIL-OPEN by design (operator decision): a failure marks the
 * sign step failed + stamps the failure Setting + warns via Event, but the
 * build completes and ships unsigned binaries — never blocks agent rollout.
 */

import { execFile, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { stat, access, mkdir, writeFile, rename, unlink, chmod } from "node:fs/promises";
import { constants as FS } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { prisma } from "../db.js";
import { AppError } from "../utils/errors.js";
import { STATE_DIR, SIGNING_DIR } from "../utils/paths.js";
import { SECRET_MASK, isMaskedSecret } from "../utils/secretMask.js";
import { asObject } from "../utils/object.js";

const execFileAsync = promisify(execFile);

// ─── Setting keys + constants ─────────────────────────────────────────

export const AGENT_SIGNING_SETTING_KEY = "agent.codeSigning";
export const SIGNING_FAILURE_SETTING_KEY = "agent.signing.lastFailure";

/** The shared UI mask sentinel — see src/utils/secretMask.ts. */
export const MASK = SECRET_MASK;

/**
 * Env var the keystore password is passed through, for BOTH jsign
 * (`--storepass env:<name>`) and keytool (`-storepass:env <name>`). Never argv.
 */
export const SIGNING_PASSWORD_ENV = "POLARIS_SIGNING_PASSWORD";

/**
 * Default RFC3161 timestamp authority. A public TSA is correct even though the
 * signing cert is internal — a TSA countersigns *when*, not *who*. Requires
 * outbound access from the Polaris host; operators on a closed network point
 * this at their own AD CS timestamping endpoint instead.
 */
export const DEFAULT_TSA_URL = "http://timestamp.digicert.com";

/**
 * Where resolveJsignJar() looks when the operator hasn't set an explicit
 * path. MUST stay in lockstep with where the deploy surfaces drop the jar:
 * Dockerfile + setup-{rhel,ubuntu}.sh → /opt/polaris/tools/jsign.jar;
 * setup-windows.ps1 → <app dir>\tools\jsign.jar (covered by the cwd probe);
 * POLARIS_STATE_DIR layouts → <state>/tools/jsign.jar.
 */
export const JSIGN_JAR_CANDIDATES: string[] = [
  resolvePath(process.cwd(), "tools", "jsign.jar"),
  resolvePath(STATE_DIR, "tools", "jsign.jar"),
  "/opt/polaris/tools/jsign.jar",
];

// ─── Config shape + mask/merge ────────────────────────────────────────

export interface AgentSigningConfig {
  enabled: boolean;
  /** Path to the PKCS#12 keystore holding the internal-CA cert + private key. */
  keystorePath: string;
  /** Keystore password. Sealed at rest — see configSecretFields.ts. */
  keystorePassword: string;
  /** Key alias. Only needed when the keystore holds more than one entry. */
  alias: string;
  /** RFC3161 timestamp authority URL. Required — see the header note. */
  tsaUrl: string;
  /** Explicit jsign jar path; "" = probe JSIGN_JAR_CANDIDATES. */
  jsignJarPath: string;
}

export interface MaskedSigningConfig extends Omit<AgentSigningConfig, "keystorePassword"> {
  keystorePassword: string; // MASK or ""
  keystorePasswordSet: boolean;
}

export const DEFAULT_SIGNING_CONFIG: AgentSigningConfig = {
  enabled: false,
  keystorePath: "",
  keystorePassword: "",
  alias: "",
  tsaUrl: DEFAULT_TSA_URL,
  jsignJarPath: "",
};

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

/** Mask the password; report whether one is stored. Pure. */
export function maskSigningConfig(cfg: AgentSigningConfig): MaskedSigningConfig {
  const set = cfg.keystorePassword.length > 0;
  return { ...cfg, keystorePassword: set ? MASK : "", keystorePasswordSet: set };
}

/**
 * Merge an incoming (possibly partial, possibly mask-echoing) config onto the
 * stored one. Blank/masked incoming password keeps the stored password;
 * strings are trimmed; UI-only `keystorePasswordSet` never persists.
 *
 * A blank incoming `tsaUrl` falls back to the DEFAULT rather than to empty:
 * empty fails `isSigningConfigured` and would disable signing, and silently
 * turning signing off because a field was cleared is worse than timestamping
 * against the documented default. Pure.
 */
export function mergeSigningConfig(
  incoming: Record<string, unknown>,
  current: AgentSigningConfig,
): AgentSigningConfig {
  const inc = asObject(incoming);
  const secret = str(inc.keystorePassword);
  const tsa = inc.tsaUrl !== undefined ? str(inc.tsaUrl) : current.tsaUrl;
  return {
    enabled: typeof inc.enabled === "boolean" ? inc.enabled : current.enabled,
    keystorePath: inc.keystorePath !== undefined ? str(inc.keystorePath) : current.keystorePath,
    keystorePassword: secret === "" || isMaskedSecret(secret) ? current.keystorePassword : secret,
    alias: inc.alias !== undefined ? str(inc.alias) : current.alias,
    tsaUrl: tsa === "" ? DEFAULT_TSA_URL : tsa.replace(/\/+$/, ""),
    jsignJarPath: inc.jsignJarPath !== undefined ? str(inc.jsignJarPath) : current.jsignJarPath,
  };
}

// ─── Setting persistence ──────────────────────────────────────────────

export async function getSigningConfigRaw(): Promise<AgentSigningConfig> {
  try {
    const row = await prisma.setting.findUnique({ where: { key: AGENT_SIGNING_SETTING_KEY } });
    return mergeSigningConfig(asObject(row?.value), DEFAULT_SIGNING_CONFIG);
  } catch {
    return { ...DEFAULT_SIGNING_CONFIG };
  }
}

export async function getSigningConfigMasked(): Promise<MaskedSigningConfig> {
  return maskSigningConfig(await getSigningConfigRaw());
}

/**
 * Merge-and-save. Returns the masked result. Disabling signing also clears
 * the failure stamp — a deliberate operator opt-out shouldn't leave a stale
 * "unsigned binaries" alert in everyone's sidebar. Event emission is the
 * route's job (it knows the actor + what changed).
 */
export async function updateSigningConfig(input: Record<string, unknown>): Promise<MaskedSigningConfig> {
  const current = await getSigningConfigRaw();
  const next = mergeSigningConfig(input, current);
  await prisma.setting.upsert({
    where: { key: AGENT_SIGNING_SETTING_KEY },
    update: { value: next as object },
    create: { key: AGENT_SIGNING_SETTING_KEY, value: next as object },
  });
  if (!next.enabled && current.enabled) {
    await clearSigningFailure();
  }
  return maskSigningConfig(next);
}

// ─── Failure stamp (drives the sidebar alert) ─────────────────────────

export interface SigningFailure {
  /** ISO timestamp of the failure — the client's dismissal key. */
  at: string;
  buildId: string;
  version: string;
  /** The windows binaries that failed to sign (filenames). */
  files: string[];
  /** Scrubbed one-line reason. */
  error: string;
}

export async function recordSigningFailure(failure: SigningFailure): Promise<void> {
  await prisma.setting.upsert({
    where: { key: SIGNING_FAILURE_SETTING_KEY },
    update: { value: failure as unknown as object },
    create: { key: SIGNING_FAILURE_SETTING_KEY, value: failure as unknown as object },
  });
}

export async function clearSigningFailure(): Promise<void> {
  await prisma.setting.delete({ where: { key: SIGNING_FAILURE_SETTING_KEY } }).catch(() => {});
}

/** Read the current failure stamp (null = last signed build was clean / never failed). */
export async function getSigningAlert(): Promise<{ failure: SigningFailure | null }> {
  try {
    const row = await prisma.setting.findUnique({ where: { key: SIGNING_FAILURE_SETTING_KEY } });
    const v = asObject(row?.value);
    if (typeof v.at !== "string" || v.at === "") return { failure: null };
    return {
      failure: {
        at: v.at,
        buildId: str(v.buildId),
        version: str(v.version),
        files: Array.isArray(v.files) ? v.files.filter((f): f is string => typeof f === "string") : [],
        error: str(v.error),
      },
    };
  } catch {
    return { failure: null };
  }
}

// ─── jsign availability + invocation ──────────────────────────────────

/** First existing jar: explicit config path, else the candidate list. */
export async function resolveJsignJar(cfg: Pick<AgentSigningConfig, "jsignJarPath">): Promise<string | null> {
  const candidates = cfg.jsignJarPath ? [cfg.jsignJarPath] : JSIGN_JAR_CANDIDATES;
  for (const p of candidates) {
    try {
      const st = await stat(p);
      if (st.isFile()) return p;
    } catch {
      /* keep probing */
    }
  }
  return null;
}

export interface SigningAvailability {
  enabled: boolean;
  /** All required config fields present (keystore path + password + TSA). */
  configured: boolean;
  javaOk: boolean;
  javaVersion?: string;
  jarPath?: string;
  /** The keystore file exists and is readable by this process. */
  keystoreOk: boolean;
  /** enabled + configured + javaOk + jar found + keystore readable. */
  ok: boolean;
  error?: string;
}

export function isSigningConfigured(cfg: AgentSigningConfig): boolean {
  return Boolean(cfg.keystorePath && cfg.keystorePassword && cfg.tsaUrl);
}

/**
 * Everything the UI + build path need to know about whether signing can run
 * right now. Like goAvailable(): not cached — operators expect "install Java
 * and reload" to just work, and the probes are cheap.
 */
export async function signingAvailability(cfg?: AgentSigningConfig): Promise<SigningAvailability> {
  const config = cfg ?? (await getSigningConfigRaw());
  const configured = isSigningConfigured(config);

  let javaOk = false;
  let javaVersion: string | undefined;
  try {
    // `java -version` prints to STDERR by long-standing JDK convention.
    const { stderr, stdout } = await execFileAsync("java", ["-version"], { timeout: 5_000 });
    javaOk = true;
    javaVersion = (stderr || stdout).split("\n")[0]?.trim();
  } catch {
    javaOk = false;
  }

  const jarPath = (await resolveJsignJar(config)) ?? undefined;

  // Readability, not just existence: the keystore is deliberately 0400 and a
  // wrong owner is the likeliest misconfiguration after a manual copy.
  let keystoreOk = false;
  if (config.keystorePath) {
    try {
      await access(config.keystorePath, FS.R_OK);
      keystoreOk = (await stat(config.keystorePath)).isFile();
    } catch {
      keystoreOk = false;
    }
  }

  let error: string | undefined;
  if (!config.enabled) error = "Code signing is disabled";
  else if (!config.keystorePath) error = "No signing keystore configured";
  else if (!config.keystorePassword) error = "Keystore password is not set";
  else if (!config.tsaUrl) error = "No timestamp authority configured";
  else if (!javaOk) error = "Java runtime not found on PATH (install Java 17+ headless)";
  else if (!jarPath) {
    const looked = (config.jsignJarPath ? [config.jsignJarPath] : JSIGN_JAR_CANDIDATES).join(", ");
    error = `jsign jar not found (looked at: ${looked})`;
  } else if (!keystoreOk) {
    error = `Signing keystore not readable at ${config.keystorePath} (check path, owner and mode)`;
  }

  return {
    enabled: config.enabled,
    configured,
    javaOk,
    javaVersion,
    jarPath,
    keystoreOk,
    ok: config.enabled && configured && javaOk && !!jarPath && keystoreOk,
    error,
  };
}

/**
 * jsign argv for one file. The keystore password is deliberately NOT part of
 * the argv — `--storepass env:POLARIS_SIGNING_PASSWORD` makes jsign read it
 * from the child env, keeping it out of process listings.
 *
 * `--tsmode RFC3161` is explicit because jsign's Authenticode default is the
 * legacy mode, and unlike a hosted store type PKCS12 gets no automatic
 * timestamping at all. `--alias` is omitted when unset so a single-entry
 * keystore needs no configuration. Pure.
 */
export function buildJsignArgs(opts: {
  jarPath: string;
  keystorePath: string;
  alias?: string;
  tsaUrl: string;
  filePath: string;
}): string[] {
  const args = [
    "-jar", opts.jarPath,
    "--storetype", "PKCS12",
    "--keystore", opts.keystorePath,
    "--storepass", `env:${SIGNING_PASSWORD_ENV}`,
  ];
  if (opts.alias) args.push("--alias", opts.alias);
  args.push("--tsaurl", opts.tsaUrl, "--tsmode", "RFC3161");
  args.push(opts.filePath);
  return args;
}

/** Remove secret material from text destined for step errors / Events / logs. Pure. */
export function scrubSecrets(text: string, secrets: Array<string | undefined>): string {
  let out = text;
  for (const s of secrets) {
    if (s && s.length >= 6) out = out.split(s).join("[redacted]");
  }
  return out;
}

/**
 * Minimal structural view of BuildState so this module doesn't import
 * agentBuildService (which imports us — avoid the cycle). cancelBuild()
 * reaches through `activeChild` to SIGTERM a running jsign exactly like a
 * running `go build`.
 */
export interface SigningProcessSlot {
  cancelled?: boolean;
  activeChild?: ChildProcess;
}

export class SigningCancelledError extends Error {
  constructor() {
    super("Signing cancelled");
    this.name = "SigningCancelledError";
  }
}

/** Sign one PE file in place with jsign. Mirrors runGoBuild's child handling. */
export function signFile(
  slot: SigningProcessSlot,
  opts: {
    jarPath: string;
    keystorePath: string;
    keystorePassword: string;
    alias?: string;
    tsaUrl: string;
    filePath: string;
  },
): Promise<void> {
  const args = buildJsignArgs(opts);
  return new Promise<void>((resolve, reject) => {
    const child = execFile(
      "java",
      args,
      {
        timeout: 120_000,
        env: { ...process.env, [SIGNING_PASSWORD_ENV]: opts.keystorePassword },
        maxBuffer: 4 * 1024 * 1024,
      },
      (err, stdout, stderr) => {
        slot.activeChild = undefined;
        if (err) {
          if (slot.cancelled) return reject(new SigningCancelledError());
          const detail = scrubSecrets((stderr || stdout || err.message || "").trim(), [opts.keystorePassword]);
          return reject(new Error(detail || "jsign exited non-zero"));
        }
        resolve();
      },
    );
    slot.activeChild = child;
  });
}

/** Pull alias names out of `keytool -list` output. Pure. */
export function parseKeytoolAliases(stdout: string): string[] {
  const out: string[] = [];
  for (const line of stdout.split("\n")) {
    // "myalias, Jan 1, 2026, PrivateKeyEntry, " / "myalias, Jan 1, 2026, trustedCertEntry, "
    const m = /^([^,]+),\s.*(?:PrivateKeyEntry|trustedCertEntry)/.exec(line.trim());
    if (m?.[1]) out.push(m[1].trim());
  }
  return out;
}

/**
 * Does the stored password actually open the keystore, and what aliases does
 * it hold? Uses keytool (`-storepass:env`, never argv) because it ships with
 * the same JDK the availability probe already requires and needs no file to
 * sign.
 *
 * Resolution is two-step: the bare name (which is the whole story wherever the
 * JDK registered its alternatives), then the JVM-reported `java.home`. That
 * second step matters because `java-25-openjdk-headless` DOES ship keytool —
 * beside the JVM — so a PATH miss is not the same as the tool being absent,
 * and without the fallback the Test button would sit permanently degraded on a
 * perfectly well-provisioned host.
 *
 * A genuinely MISSING binary degrades to "unverified" rather than reporting a
 * failure — telling the operator their password is wrong because a tool is
 * missing would send them to the wrong field entirely.
 */
export async function verifyKeystore(
  cfg: Pick<AgentSigningConfig, "keystorePath" | "keystorePassword">,
): Promise<{ verified: boolean; aliases: string[]; error?: string }> {
  const args = [
    "-list", "-storetype", "PKCS12",
    "-keystore", cfg.keystorePath,
    "-storepass:env", SIGNING_PASSWORD_ENV,
  ];
  const opts = {
    timeout: 15_000,
    env: { ...process.env, [SIGNING_PASSWORD_ENV]: cfg.keystorePassword },
  };

  // Bare name first: on a host where the JDK registered its alternatives this
  // is the whole story, and it costs one exec.
  try {
    const { stdout } = await execFileAsync("keytool", args, opts);
    return { verified: true, aliases: parseKeytoolAliases(stdout) };
  } catch (err: any) {
    if (err?.code !== "ENOENT") {
      const detail = scrubSecrets((err?.stderr || err?.stdout || err?.message || "").trim(), [cfg.keystorePassword]);
      return { verified: false, aliases: [], error: detail || "keystore could not be opened" };
    }
    /* not on PATH — fall through to the JVM-reported location */
  }

  // `java-25-openjdk-headless` DOES ship keytool, but next to the JVM rather
  // than necessarily symlinked into /usr/bin, so a PATH miss is not the same
  // as "absent". Ask the JVM where it lives instead of guessing at
  // /usr/lib/jvm globs, which differ across distros and Windows JDKs.
  const resolved = await resolveKeytoolPath();
  if (!resolved) {
    return { verified: false, aliases: [], error: "keytool not available — password not verified" };
  }
  try {
    const { stdout } = await execFileAsync(resolved, args, opts);
    return { verified: true, aliases: parseKeytoolAliases(stdout) };
  } catch (err: any) {
    if (err?.code === "ENOENT") {
      return { verified: false, aliases: [], error: "keytool not available — password not verified" };
    }
    const detail = scrubSecrets((err?.stderr || err?.stdout || err?.message || "").trim(), [cfg.keystorePassword]);
    return { verified: false, aliases: [], error: detail || "keystore could not be opened" };
  }
}

/**
 * Pull `java.home` out of `java -XshowSettings:properties -version` output
 * (which the JVM prints to STDERR). Pure.
 */
export function parseJavaHome(output: string): string | null {
  const m = /^\s*java\.home\s*=\s*(.+?)\s*$/m.exec(output);
  return m?.[1] ? m[1] : null;
}

/**
 * Absolute path to keytool when it isn't on PATH: `JAVA_HOME` if the operator
 * set one, else the running JVM's own `java.home`. Returns null when neither
 * yields an executable file — the caller then reports the honest "password not
 * verified" rather than blaming the password.
 */
export async function resolveKeytoolPath(): Promise<string | null> {
  const exe = process.platform === "win32" ? "keytool.exe" : "keytool";
  const candidates: string[] = [];

  if (process.env.JAVA_HOME) candidates.push(resolvePath(process.env.JAVA_HOME, "bin", exe));

  try {
    // Properties go to stderr; -version keeps it from waiting on a main class.
    const { stderr, stdout } = await execFileAsync("java", ["-XshowSettings:properties", "-version"], {
      timeout: 10_000,
    });
    const home = parseJavaHome(stderr || stdout || "");
    if (home) candidates.push(resolvePath(home, "bin", exe));
  } catch {
    /* no java, or an old JVM without -XshowSettings — nothing more to try */
  }

  for (const c of candidates) {
    try {
      if ((await stat(c)).isFile()) return c;
    } catch {
      /* keep probing */
    }
  }
  return null;
}

/** Is this verifyKeystore() error the degraded "no keytool" case? Pure. */
export function isKeytoolMissing(error?: string): boolean {
  return Boolean(error && error.startsWith("keytool not available"));
}

// ─── Operator-uploaded keystore ───────────────────────────────────────

/**
 * Where an uploaded keystore is stored. One fixed filename, so re-uploading on
 * renewal replaces in place rather than accumulating keys on disk — every
 * surviving copy of a fleet-trusted signing key is another place it can leak
 * from. Under SIGNING_DIR, which no static handler serves (see paths.ts).
 */
export const MANAGED_KEYSTORE_PATH = resolvePath(SIGNING_DIR, "codesign.pfx");

/** Mode for the stored keystore: readable only by the service user. */
const KEYSTORE_MODE = 0o400;

/**
 * Cheap structural gate before anything touches disk. A PKCS#12 is DER, so it
 * opens with an ASN.1 SEQUENCE tag (0x30); a PEM export — the likeliest operator
 * mistake, since `openssl pkcs12` and the Windows wizard can both emit
 * base64 — starts with "-----". Naming that case explicitly saves an operator
 * from re-reading the docs. Pure.
 */
export function looksLikePkcs12(buf: Buffer): { ok: boolean; error?: string } {
  if (buf.length < 64) return { ok: false, error: "File is too small to be a PKCS#12 keystore" };
  if (buf.subarray(0, 5).toString("latin1") === "-----") {
    return { ok: false, error: "That looks like a PEM file — export the certificate as PKCS#12 (.pfx/.p12) with its private key" };
  }
  if (buf[0] !== 0x30) {
    return { ok: false, error: "Not a PKCS#12 keystore (expected DER encoding)" };
  }
  return { ok: true };
}

export interface KeystoreCertInfo {
  /** Certificate subject DN as keytool reports it ("Owner:"). */
  subject?: string;
  issuer?: string;
  /** Raw "until" text from keytool — locale-formatted, shown verbatim. */
  validUntilRaw?: string;
  /** ISO form, only when the raw text parsed. */
  validUntil?: string;
  /** Whole days until expiry; negative once expired. Only when parseable. */
  daysRemaining?: number;
  /** SHA-256 fingerprint — the value to paste into a Defender indicator. */
  fingerprintSha256?: string;
  /** False when the keystore holds no PrivateKeyEntry (i.e. cannot sign). */
  hasPrivateKey: boolean;
  aliases: string[];
}

/**
 * Parse `keytool -list -v` output. Pure so the shapes are unit-testable without
 * a keystore.
 *
 * `nowMs` is injected rather than read from the clock so `daysRemaining` is
 * deterministic in tests. Dates are LOCALE-FORMATTED by keytool, so the raw
 * text is always kept and the parsed form is best-effort — a locale this can't
 * read loses the countdown, never the displayed expiry.
 */
export function parseKeytoolCertInfo(stdout: string, nowMs: number): KeystoreCertInfo {
  const info: KeystoreCertInfo = {
    hasPrivateKey: /^\s*Entry type:\s*PrivateKeyEntry\s*$/m.test(stdout),
    aliases: [],
  };

  for (const m of stdout.matchAll(/^\s*Alias name:\s*(.+?)\s*$/gm)) {
    if (m[1]) info.aliases.push(m[1]);
  }

  const owner = /^\s*Owner:\s*(.+?)\s*$/m.exec(stdout);
  if (owner?.[1]) info.subject = owner[1];
  const issuer = /^\s*Issuer:\s*(.+?)\s*$/m.exec(stdout);
  if (issuer?.[1]) info.issuer = issuer[1];

  const valid = /^\s*Valid from:\s*(.+?)\s+until:\s*(.+?)\s*$/m.exec(stdout);
  if (valid?.[2]) {
    info.validUntilRaw = valid[2];
    const parsed = Date.parse(valid[2]);
    if (!Number.isNaN(parsed)) {
      info.validUntil = new Date(parsed).toISOString();
      info.daysRemaining = Math.floor((parsed - nowMs) / 86_400_000);
    }
  }

  // keytool prints fingerprints on their own indented lines under
  // "Certificate fingerprints:".
  const fp = /^\s*SHA-?256:\s*([0-9A-Fa-f:]+)\s*$/m.exec(stdout);
  if (fp?.[1]) info.fingerprintSha256 = fp[1].toUpperCase();

  return info;
}

/**
 * Read the installed keystore's certificate details for display. Returns null
 * when there's no keystore, no keytool, or the password doesn't open it — every
 * one of which is already reported by signingAvailability()/testSigningSetup(),
 * so this stays a best-effort enrichment rather than a second error channel.
 */
export async function keystoreCertInfo(
  cfg: Pick<AgentSigningConfig, "keystorePath" | "keystorePassword">,
  nowMs: number = Date.now(),
): Promise<KeystoreCertInfo | null> {
  if (!cfg.keystorePath || !cfg.keystorePassword) return null;
  const args = [
    "-list", "-v", "-storetype", "PKCS12",
    "-keystore", cfg.keystorePath,
    "-storepass:env", SIGNING_PASSWORD_ENV,
  ];
  const opts = {
    timeout: 15_000,
    env: { ...process.env, [SIGNING_PASSWORD_ENV]: cfg.keystorePassword },
    maxBuffer: 4 * 1024 * 1024,
  };
  try {
    const { stdout } = await execFileAsync("keytool", args, opts);
    return parseKeytoolCertInfo(stdout, nowMs);
  } catch (err: any) {
    if (err?.code !== "ENOENT") return null;
  }
  const resolved = await resolveKeytoolPath();
  if (!resolved) return null;
  try {
    const { stdout } = await execFileAsync(resolved, args, opts);
    return parseKeytoolCertInfo(stdout, nowMs);
  } catch {
    return null;
  }
}

export interface InstallKeystoreResult {
  path: string;
  /** False when keytool was unavailable — stored, but unverified. */
  verified: boolean;
  info: KeystoreCertInfo | null;
  /** Operator-facing note when something is off but not fatal. */
  warning?: string;
}

/**
 * Validate an uploaded PKCS#12 and, only if it opens, install it as the managed
 * keystore and point the config at it.
 *
 * Validate-then-commit is the whole point: the alternative is writing bytes to
 * disk, pointing signing at them, and finding out at the next build that the
 * password was wrong — by which time the previous working keystore is already
 * overwritten. So the upload lands on a temp path in the SAME directory (making
 * the promote a same-filesystem rename), is opened with the supplied password,
 * and is only promoted once it answers.
 *
 * A keystore with no PrivateKeyEntry is REFUSED rather than warned about: it
 * cannot sign, so accepting it would swap a working config for one guaranteed
 * to fail at the next build.
 *
 * When keytool is genuinely unavailable the upload is accepted UNVERIFIED —
 * jsign doesn't need keytool, so refusing would block a host that can sign
 * perfectly well; the caller surfaces the warning.
 */
export async function installKeystore(
  buffer: Buffer,
  password: string,
): Promise<InstallKeystoreResult> {
  const shape = looksLikePkcs12(buffer);
  if (!shape.ok) throw new AppError(400, shape.error ?? "Not a PKCS#12 keystore");
  if (!password) throw new AppError(400, "The keystore password is required to validate the upload");

  await mkdir(SIGNING_DIR, { recursive: true });
  const tmpPath = `${MANAGED_KEYSTORE_PATH}.upload`;
  await writeFile(tmpPath, buffer, { mode: KEYSTORE_MODE });

  try {
    const probe = await verifyKeystore({ keystorePath: tmpPath, keystorePassword: password });
    let verified = probe.verified;
    let warning: string | undefined;
    let info: KeystoreCertInfo | null = null;

    if (!probe.verified) {
      if (!isKeytoolMissing(probe.error)) {
        // Wrong password, corrupt file — say so and keep the previous keystore.
        throw new AppError(400, `Keystore could not be opened: ${probe.error ?? "unknown error"}`);
      }
      verified = false;
      warning =
        "Stored, but NOT verified — keytool was unavailable, so the password could not be checked. " +
        "Signing itself does not use keytool; a wrong password will surface at the next build.";
    } else {
      info = await keystoreCertInfo({ keystorePath: tmpPath, keystorePassword: password });
      if (info && !info.hasPrivateKey) {
        throw new AppError(
          400,
          "That keystore holds no private key, so it cannot sign. Re-export the certificate WITH its private key.",
        );
      }
    }

    // Same-directory rename → atomic promote; a crash mid-upload can't leave a
    // half-written keystore in place of a working one.
    await rename(tmpPath, MANAGED_KEYSTORE_PATH);
    await chmod(MANAGED_KEYSTORE_PATH, KEYSTORE_MODE).catch(() => {
      /* best effort — Windows has no POSIX mode */
    });

    await updateSigningConfig({ keystorePath: MANAGED_KEYSTORE_PATH, keystorePassword: password });
    return { path: MANAGED_KEYSTORE_PATH, verified, info, warning };
  } finally {
    await unlink(tmpPath).catch(() => {
      /* already promoted, or never written */
    });
  }
}

/**
 * Delete the managed keystore and clear the config's pointer to it.
 *
 * Only ever touches MANAGED_KEYSTORE_PATH — an operator-typed path pointing at
 * a keystore they placed themselves is left alone, since Polaris didn't put it
 * there and deleting it would be a surprise. The password is cleared too: a
 * stored password with no keystore is a secret kept for nothing.
 */
export async function removeManagedKeystore(): Promise<{ removed: boolean }> {
  let removed = false;
  try {
    await unlink(MANAGED_KEYSTORE_PATH);
    removed = true;
  } catch {
    /* nothing stored */
  }
  const cfg = await getSigningConfigRaw();
  if (cfg.keystorePath === MANAGED_KEYSTORE_PATH) {
    await prisma.setting.upsert({
      where: { key: AGENT_SIGNING_SETTING_KEY },
      update: { value: { ...cfg, keystorePath: "", keystorePassword: "" } as object },
      create: { key: AGENT_SIGNING_SETTING_KEY, value: DEFAULT_SIGNING_CONFIG as object },
    });
  }
  return { removed };
}

/**
 * Build the alias advisory for the test result. Pure so the wording is
 * unit-testable: a configured-but-absent alias is the failure mode that
 * otherwise only surfaces as a jsign error mid-build.
 */
export function aliasAdvisory(alias: string, aliases: string[]): string {
  if (alias) {
    return aliases.includes(alias)
      ? ` Alias "${alias}" found.`
      : ` WARNING: alias "${alias}" is NOT in this keystore (found: ${aliases.join(", ") || "none"}).`;
  }
  return aliases.length > 1
    ? ` Keystore holds ${aliases.length} entries (${aliases.join(", ")}) — set an alias to pick one.`
    : "";
}

/**
 * Test-button dry run: availability probe + a real keystore open (proves the
 * path/password pair and surfaces the aliases, which is what an operator needs
 * in order to fill the alias field on a multi-entry keystore).
 *
 * Deliberately does NOT invoke jsign — there's nothing to sign outside a
 * build — and makes no network call, so a pass here does not prove the TSA is
 * reachable. The message says so rather than implying full coverage.
 */
export async function testSigningSetup(): Promise<{ ok: boolean; message: string }> {
  const cfg = await getSigningConfigRaw();
  if (!isSigningConfigured(cfg)) {
    return {
      ok: false,
      message: "Signing configuration is incomplete — keystore path, password and timestamp URL are all required",
    };
  }
  const avail = await signingAvailability(cfg);
  if (!avail.javaOk) return { ok: false, message: "Java runtime not found on PATH (install Java 17+ headless)" };
  if (!avail.jarPath) {
    return { ok: false, message: "jsign jar not found — set the jar path or install it to a default location" };
  }
  if (!avail.keystoreOk) return { ok: false, message: avail.error ?? "Signing keystore is not readable" };

  const ks = await verifyKeystore(cfg);
  if (!ks.verified) {
    if (isKeytoolMissing(ks.error)) {
      return {
        ok: true,
        message:
          `Ready: ${avail.javaVersion ?? "java"} + ${avail.jarPath}, keystore readable. ` +
          `Password NOT verified (keytool unavailable). Timestamping via ${cfg.tsaUrl}, which is not contacted by this test.`,
      };
    }
    return { ok: false, message: `Keystore could not be opened: ${ks.error}` };
  }

  return {
    ok: true,
    message:
      `Ready: keystore opened, ${avail.javaVersion ?? "java"} + ${avail.jarPath}.` +
      `${aliasAdvisory(cfg.alias, ks.aliases)} Timestamping via ${cfg.tsaUrl} (not contacted by this test). ` +
      `Signing runs on the next agent build.`,
  };
}
