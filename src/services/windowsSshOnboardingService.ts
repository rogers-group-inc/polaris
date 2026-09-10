/**
 * src/services/windowsSshOnboardingService.ts — the "Windows SSH Deployment"
 * workflow behind Integrations → Polaris Agent.
 *
 * WHY THIS EXISTS. Polaris can already install the Polaris Agent on Windows
 * over SSH (agentInstallService.sshWindowsInstall) using an `ssh`-type
 * Credential whose config carries a `privateKey`. Both halves have worked for
 * a while. What was missing is everything AROUND them: the operator had to run
 * ssh-keygen themselves, paste the private half into the credential form, and
 * hand-write a script to push the public half onto every endpoint — with two
 * silent failure modes waiting (wrong authorized_keys file, wrong ACL; see
 * sshOnboardingScript.ts). This service closes that loop: Polaris generates
 * the keypair, owns the credential, and emits the onboarding script.
 *
 * KEY HANDLING mirrors the Web Push VAPID precedent
 * (notificationChannelService.generateVapidKeys): the private half is written
 * straight into Credential.config — where the db.ts Prisma extension seals it
 * at rest under POLARIS_SECRET_KEY — and is NEVER returned by any read path.
 * Only the public half and its fingerprint come back out.
 *
 * The consequence is deliberate and worth stating plainly: there is no escrow.
 * Losing POLARIS_SECRET_KEY (or restoring a backup onto a host with a
 * different one) means regenerating and re-running the onboarding script. That
 * is exactly why the generated script is idempotent — recovery is a re-run,
 * not a fleet rebuild.
 *
 * BLAST RADIUS. One keypair authorizes local-administrator SSH on every
 * Windows endpoint that trusts it. That is not worse than the shared WinRM
 * administrator password it replaces — key auth takes a reusable secret off
 * the wire entirely — but it is a fleet-wide admin credential and the UI says
 * so.
 */

import { createHash } from "node:crypto";
// ssh2 is CommonJS. cjs-module-lexer surfaces `Client` as a named export (which
// is why remoteExec.ts can `import { Client }`) but NOT `utils`, so a named
// import throws at module-load under Node's real ESM loader — even though the
// bundler used by Vitest interops it happily. Reach it off the default export.
import ssh2 from "ssh2";
const sshUtils = ssh2.utils;

import { prisma } from "../db.js";
import { AppError } from "../utils/errors.js";
import { generateEd25519Keypair, SshKeygenError } from "../utils/sshKeygen.js";
import { logEvent } from "./eventLogService.js";
import { createSettingStore } from "./settingsStore.js";
import {
  createCredential,
  getCredential,
  validateConfig,
  type CredentialRecord,
} from "./credentialService.js";
import {
  assertValidServerIp,
  assertValidUsername,
  assertValidLinuxUsername,
  buildWindowsOnboardingScript,
  buildWindowsOnboardingDetectionScript,
  buildLinuxOnboardingScript,
  buildLinuxOnboardingDetectionScript,
  type SshOnboardingAccountMode,
} from "./sshOnboardingScript.js";

/** Setting row holding the card's non-secret configuration. */
const SETTING_KEY = "windowsSshOnboarding";
/** Short TTL: this is an admin-page read, not a hot path. */
const SETTING_TTL_MS = 10_000;

export type SshOnboardingPlatform = "windows" | "linux";
export const SSH_ONBOARDING_PLATFORMS: readonly SshOnboardingPlatform[] = ["windows", "linux"];

/**
 * ONE managed credential PER PLATFORM, both carrying the SAME keypair.
 *
 * A Credential holds exactly one username, and the Windows and Linux
 * deployment accounts genuinely differ in shape — Windows accepts
 * `DOMAIN\user`, which is meaningless on Linux. Trying to share a single row
 * would leave one platform unable to log in at all. Two rows with clear names
 * is the least clever arrangement that makes both install paths work; they
 * appear in the normal Install Agent / bulk-deploy pickers.
 */
export const MANAGED_CREDENTIAL_NAMES: Record<SshOnboardingPlatform, string> = {
  windows: "Windows SSH (Polaris-managed)",
  linux: "Linux SSH (Polaris-managed)",
};
/** Comment baked into the public key so it is identifiable in authorized_keys. */
const KEY_COMMENT = "polaris-agent-deploy";

const DEFAULT_USERNAME = "polaris-agent";

export interface PlatformAccountConfig {
  accountMode: SshOnboardingAccountMode;
  /** "" only in existing mode, until an operator names the account. */
  username: string;
}

export interface WindowsSshOnboardingConfig {
  /** Managed credential per platform. Null until the first generate. */
  credentialIds: Record<SshOnboardingPlatform, string | null>;
  windows: PlatformAccountConfig;
  linux: PlatformAccountConfig;
  /** IPv4 address or CIDR; "" means the scripts leave the firewall alone. Shared. */
  polarisServerIp: string;
  /** ISO timestamp of the last keypair generation, for display. */
  generatedAt: string | null;
}

export interface WindowsSshOnboardingState extends WindowsSshOnboardingConfig {
  credentialNames: Record<SshOnboardingPlatform, string | null>;
  /** authorized_keys one-liner, or null when no keypair exists yet. */
  publicKey: string | null;
  /** "SHA256:..." — the same form `ssh-keygen -lf` prints, so it can be eyeballed. */
  fingerprint: string | null;
}

/**
 * Only a CREATED account has a default name. An existing account has none: it
 * must name an administrator that is really on the endpoints, and defaulting
 * it to polaris-agent — an account nothing creates in that mode — let the card
 * publish a fleet script whose credential could not log in anywhere.
 */
function defaultUsernameFor(accountMode: SshOnboardingAccountMode): string {
  return accountMode === "create" ? DEFAULT_USERNAME : "";
}

function parsePlatform(raw: unknown): PlatformAccountConfig {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const accountMode: SshOnboardingAccountMode = o.accountMode === "create" ? "create" : "existing";
  return {
    accountMode,
    username: typeof o.username === "string" && o.username ? o.username : defaultUsernameFor(accountMode),
  };
}

function parseConfig(raw: unknown): WindowsSshOnboardingConfig {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const ids = (o.credentialIds && typeof o.credentialIds === "object"
    ? o.credentialIds
    : {}) as Record<string, unknown>;
  const idOf = (k: string) => (typeof ids[k] === "string" && ids[k] ? (ids[k] as string) : null);

  // Fold the pre-Linux flat shape ({credentialId, accountMode, username}) into
  // the windows slot so an install that already generated a keypair keeps it.
  const legacyId = typeof o.credentialId === "string" && o.credentialId ? o.credentialId : null;
  const legacyWindows =
    o.windows === undefined && (o.accountMode !== undefined || o.username !== undefined)
      ? { accountMode: o.accountMode, username: o.username }
      : o.windows;

  return {
    credentialIds: {
      windows: idOf("windows") ?? legacyId,
      linux: idOf("linux"),
    },
    windows: parsePlatform(legacyWindows),
    linux: parsePlatform(o.linux),
    polarisServerIp: typeof o.polarisServerIp === "string" ? o.polarisServerIp : "",
    generatedAt: typeof o.generatedAt === "string" && o.generatedAt ? o.generatedAt : null,
  };
}

const store = createSettingStore<WindowsSshOnboardingConfig>({
  key: SETTING_KEY,
  ttlMs: SETTING_TTL_MS,
  parse: parseConfig,
});

/**
 * OpenSSH-style fingerprint of an authorized_keys line: SHA-256 over the raw
 * key blob, base64, trailing '=' padding stripped. Matches `ssh-keygen -lf`
 * so an operator can compare the two by eye.
 */
export function sshPublicKeyFingerprint(publicKey: string): string | null {
  const parts = String(publicKey ?? "").trim().split(/\s+/);
  if (parts.length < 2) return null;
  try {
    const blob = Buffer.from(parts[1], "base64");
    if (blob.length === 0) return null;
    return "SHA256:" + createHash("sha256").update(blob).digest("base64").replace(/=+$/, "");
  } catch {
    return null;
  }
}

/**
 * Read a managed credential, tolerating a config that points at a row an admin
 * deleted from the Credentials page. Returns null rather than throwing — the
 * card should render "no keypair yet" and offer Generate, not a 500.
 */
async function loadManagedCredential(id: string | null): Promise<CredentialRecord | null> {
  if (!id) return null;
  try {
    // revealSecrets is NOT set: this path only ever needs the public half.
    return await getCredential(id);
  } catch {
    return null;
  }
}

export async function getOnboardingState(): Promise<WindowsSshOnboardingState> {
  const cfg = await store.get();
  const [win, lin] = await Promise.all([
    loadManagedCredential(cfg.credentialIds.windows),
    loadManagedCredential(cfg.credentialIds.linux),
  ]);
  // Either row carries the same public half; prefer whichever exists.
  const config = ((win ?? lin)?.config ?? {}) as Record<string, unknown>;
  const publicKey = typeof config.publicKey === "string" && config.publicKey ? config.publicKey : null;
  return {
    ...cfg,
    // A dangling id reads as "not generated yet" so Generate can recover it.
    credentialIds: {
      windows: win ? cfg.credentialIds.windows : null,
      linux: lin ? cfg.credentialIds.linux : null,
    },
    credentialNames: { windows: win?.name ?? null, linux: lin?.name ?? null },
    publicKey,
    fingerprint: publicKey ? sshPublicKeyFingerprint(publicKey) : null,
  };
}

export interface SaveOnboardingConfigInput {
  platform?: unknown;
  accountMode?: unknown;
  username?: unknown;
  polarisServerIp?: unknown;
}

function assertPlatform(v: unknown): SshOnboardingPlatform {
  if (v === "windows" || v === "linux") return v;
  throw new AppError(400, 'Platform must be "windows" or "linux"');
}

/**
 * Validate a username with the rules of the platform it will be written into.
 * Linux is stricter (no DOMAIN\user, POSIX charset), so sharing one validator
 * would either let an unusable value through or reject a valid Windows one.
 */
function validateUsernameFor(
  platform: SshOnboardingPlatform,
  username: string,
  accountMode: SshOnboardingAccountMode,
): string {
  return platform === "linux"
    ? assertValidLinuxUsername(username)
    : assertValidUsername(username, accountMode);
}

export async function saveOnboardingConfig(
  input: SaveOnboardingConfigInput,
  actor: string,
): Promise<WindowsSshOnboardingState> {
  const current = await store.get();
  const platform = assertPlatform(input.platform ?? "windows");
  const cur = current[platform];

  const accountMode: SshOnboardingAccountMode =
    input.accountMode === undefined
      ? cur.accountMode
      : input.accountMode === "create" || input.accountMode === "existing"
        ? input.accountMode
        : (() => {
            throw new AppError(400, 'Account mode must be "create" or "existing"');
          })();

  const rawUsername = input.username === undefined ? cur.username : String(input.username ?? "");
  // Validated against the SAME rules the script generator enforces, so a bad
  // value is rejected at save time rather than at download time. A blank field
  // takes the mode's default — polaris-agent for a created account, nothing
  // (so the validator refuses it) for an existing one.
  const username = validateUsernameFor(platform, rawUsername || defaultUsernameFor(accountMode), accountMode);
  const polarisServerIp = assertValidServerIp(
    input.polarisServerIp === undefined ? current.polarisServerIp : String(input.polarisServerIp ?? ""),
  );

  const next: WindowsSshOnboardingConfig = {
    ...current,
    [platform]: { accountMode, username },
    polarisServerIp,
  };
  const changed =
    accountMode !== cur.accountMode ||
    username !== cur.username ||
    polarisServerIp !== current.polarisServerIp;

  if (changed) {
    await store.save(next);
    // Keep the managed credential's username in step with the account the
    // script provisions — otherwise Polaris would log in as the old one.
    await syncCredentialUsername(platform, next, actor);
    await logEvent({
      action: "windows_ssh_onboarding.updated",
      resourceType: "setting",
      resourceName: SETTING_KEY,
      actor,
      message: `Updated ${platform} SSH deployment settings (account ${accountMode}: ${username})`,
      details: { platform, accountMode, username, polarisServerIp: polarisServerIp || null },
    });
  }
  return getOnboardingState();
}

/**
 * Re-stamp a managed credential's username after a config change. Skipped when
 * no keypair exists yet (generate will write the current username anyway).
 */
async function syncCredentialUsername(
  platform: SshOnboardingPlatform,
  cfg: WindowsSshOnboardingConfig,
  _actor: string,
): Promise<void> {
  const id = cfg.credentialIds[platform];
  if (!id) return;
  const cred = await loadManagedCredential(id);
  if (!cred) return;
  const existing = await getCredential(id, { revealSecrets: true });
  const conf = (existing.config ?? {}) as Record<string, unknown>;
  if (conf.username === cfg[platform].username) return;
  const nextConfig = { ...conf, username: cfg[platform].username };
  validateConfig("ssh", nextConfig);
  await prisma.credential.update({ where: { id }, data: { config: nextConfig as never } });
}

/**
 * Generate (or rotate) the deployment keypair and store it on the managed
 * credential, creating that credential on first use.
 *
 * Note the ordering: the key is generated BEFORE createCredential, not after.
 * validateSshConfig requires a password or a private key, so there is no way
 * to create an empty ssh credential and key it afterwards.
 */
export async function generateKeypair(actor: string): Promise<WindowsSshOnboardingState> {
  const cfg = await store.get();

  // ed25519: small, fast, and supported by both ssh2 and Windows OpenSSH, and
  // the OpenSSH private-key format ssh2.connect accepts directly — no
  // conversion, no shelling out to ssh-keygen.
  //
  // Through the shared helper because ssh2's generator intermittently emits a
  // key its own parser rejects (about one call in three on Node 20+). Before
  // that helper existed, this button returned a 500 roughly a third of the time
  // and two test files flaked at the same rate. The helper validates by parsing
  // and retries, so a key that reaches the database is one that will actually
  // authenticate.
  let privateKey: string;
  let publicKey: string;
  try {
    const pair = generateEd25519Keypair(KEY_COMMENT);
    privateKey = pair.privateKey;
    publicKey = pair.publicKey;
  } catch (err) {
    // Fail before touching the DB rather than storing a credential that would
    // silently never authenticate.
    if (err instanceof SshKeygenError) throw new AppError(500, err.message);
    throw err;
  }

  // Both platforms get the SAME keypair; only the username differs. Rotation
  // must touch both or one platform silently keeps trusting a retired key.
  const credentialIds: Record<SshOnboardingPlatform, string | null> = { windows: null, linux: null };
  let rotating = false;

  for (const platform of SSH_ONBOARDING_PLATFORMS) {
    const existing = await loadManagedCredential(cfg.credentialIds[platform]);
    // validateSshConfig requires a username, and an existing-mode card may not
    // have named one yet. The placeholder is replaced by syncCredentialUsername
    // the moment it is saved, and no script renders until then.
    const nextConfig = { username: cfg[platform].username || DEFAULT_USERNAME, privateKey, publicKey, port: 22 };
    if (existing) {
      rotating = true;
      // REPLACE the config rather than merging it. updateCredential() routes
      // through mergeConfigPreservingSecrets, which treats an empty string for
      // a secret field as "keep what's stored" — that's what lets the edit
      // modal round-trip a masked value without wiping it, but it also makes
      // clearing `password` impossible through that path. A stale password on
      // a Polaris-managed key credential is dead config that still reads as a
      // live secret in the UI, and remoteExec silently prefers privateKey.
      //
      // So: validate explicitly, then write the whole config. Same shape as
      // the VAPID precedent in notificationChannelService.generateVapidKeys.
      validateConfig("ssh", nextConfig);
      await prisma.credential.update({
        where: { id: existing.id },
        data: { config: nextConfig as never },
      });
      credentialIds[platform] = existing.id;
    } else {
      const created = await createCredential({
        name: await uniqueCredentialName(MANAGED_CREDENTIAL_NAMES[platform]),
        type: "ssh",
        config: nextConfig,
      });
      credentialIds[platform] = created.id;
    }
  }

  await store.save({ ...cfg, credentialIds, generatedAt: new Date().toISOString() });

  // Warning level on purpose: rotating invalidates every endpoint that trusts
  // the old key until the onboarding script re-runs across the fleet.
  await logEvent({
    action: "credential.ssh_keypair_generated",
    resourceType: "credential",
    resourceId: credentialIds.windows ?? undefined,
    resourceName: "SSH deployment keypair",
    actor,
    level: "warning",
    message: rotating
      ? "Regenerated the SSH deployment keypair — every endpoint must re-run its onboarding script before Polaris can reach it again"
      : "Generated the SSH deployment keypair (Windows + Linux credentials)",
    details: {
      rotated: rotating,
      fingerprint: sshPublicKeyFingerprint(publicKey),
      credentialIds,
    },
  });

  return getOnboardingState();
}

/**
 * Credential names are unique. If an operator already has a credential by the
 * managed name (hand-made, or left behind by an earlier config row that was
 * cleared), suffix rather than 409 the whole generate.
 */
async function uniqueCredentialName(base: string): Promise<string> {
  const taken = await prisma.credential.findMany({
    where: { name: { startsWith: base } },
    select: { name: true },
  });
  const names = new Set(taken.map((r) => r.name));
  if (!names.has(base)) return base;
  for (let i = 2; i < 100; i++) {
    const candidate = `${base} ${i}`;
    if (!names.has(candidate)) return candidate;
  }
  throw new AppError(409, "Could not allocate a name for the managed SSH credential");
}

export type OnboardingScriptKind = "remediation" | "detection";

export interface OnboardingScriptResult {
  script: string;
  filename: string;
  kind: OnboardingScriptKind;
  platform: SshOnboardingPlatform;
}

export async function getOnboardingScript(
  platform: SshOnboardingPlatform,
  kind: OnboardingScriptKind,
): Promise<OnboardingScriptResult> {
  const state = await getOnboardingState();
  if (!state.publicKey) {
    throw new AppError(400, "Generate the deployment keypair before downloading the onboarding script");
  }
  const acct = state[platform];
  // An existing account has no default name, so an unnamed one has nothing to
  // put in the script. Say what to do instead of the validator's bare
  // "username is required" — this message also reaches Intune/Arc publishing.
  // Windows detection never names the account, so it still renders.
  if (!acct.username && (platform === "linux" || kind === "remediation")) {
    throw new AppError(
      400,
      `Enter the existing ${platform === "linux" ? "Linux" : "Windows"} account Polaris signs in as on the ` +
        "SSH Deployment card and save — an existing account has no default name",
    );
  }

  if (platform === "linux") {
    return kind === "detection"
      ? {
          platform, kind,
          filename: "polaris-ssh-onboarding-detect.sh",
          script: buildLinuxOnboardingDetectionScript({
            publicKey: state.publicKey,
            username: acct.username,
          }),
        }
      : {
          platform, kind: "remediation",
          filename: "polaris-ssh-onboarding.sh",
          script: buildLinuxOnboardingScript({
            publicKey: state.publicKey,
            username: acct.username,
            accountMode: acct.accountMode,
            polarisServerIp: state.polarisServerIp || undefined,
          }),
        };
  }

  return kind === "detection"
    ? {
        platform, kind,
        filename: "polaris-ssh-onboarding-detect.ps1",
        script: buildWindowsOnboardingDetectionScript({ publicKey: state.publicKey }),
      }
    : {
        platform, kind: "remediation",
        filename: "polaris-ssh-onboarding.ps1",
        script: buildWindowsOnboardingScript({
          publicKey: state.publicKey,
          username: acct.username,
          accountMode: acct.accountMode,
          polarisServerIp: state.polarisServerIp || undefined,
        }),
      };
}

/** Test seam — drop the TTL cache between cases. */
export function _invalidateCache(): void {
  store.invalidate();
}
