/**
 * src/services/haService.ts — the HA cluster's configuration and status.
 *
 * Owns the `ha.config` Setting: which three nodes make up the cluster, the
 * credentials Patroni and etcd need, the etcd certificate authority, and the
 * sync keypairs. Also assembles the guidance figures the tab shows before an
 * operator commits to any of it, and reads live cluster state back from the
 * local Patroni.
 *
 * Enrollment, node bundles and the generated scripts live in
 * haEnrollmentService — that is the surface a remote node talks to, and
 * keeping it separate keeps this file free of anything reachable without a
 * session.
 *
 * ── Where the secrets live ────────────────────────────────────────────────────
 * The database credentials, the CA private key and the sync private keys sit in
 * this Setting row, and they are sealed at rest by the Prisma extension. That
 * works without touching SECRET_CONFIG_KEYS because the seal walks the blob
 * recursively and matches on the KEY name: so a password is stored as
 * `{ password: ... }` and a private key as `{ privateKey: ... }`, nested under
 * whatever describes it. Renaming one of those leaf keys to something more
 * descriptive would silently store it in plaintext — the field names are the
 * contract, not decoration.
 *
 * They live here rather than only on disk because a failover has to leave the
 * surviving node able to re-issue a bundle (to rebuild the standby, or to move
 * the witness), and this row replicates with the database.
 */

import os from "node:os";
import net from "node:net";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { promisify } from "node:util";
import { prisma } from "../db.js";
import { logger } from "../utils/logger.js";
import { AppError } from "../utils/errors.js";
import { createSettingStore } from "./settingsStore.js";
import { getDirectDatabaseUrl, isPgbouncerMode } from "../utils/dbConnections.js";
import { isProxyMode } from "../utils/proxyMode.js";
import { getPublicApiBaseUrl } from "../utils/publicUrl.js";
import { generateEd25519Keypair, SshKeygenError } from "../utils/sshKeygen.js";
import { WAL_SAMPLES_KEY } from "./haHeartbeatService.js";
import {
  rttAdvisory,
  walRateFromSamples,
  walAdvisory,
  rpoAdvisory,
  rtoAdvisory,
  sizingAdvisory,
  witnessAdvisory,
  assessInstallShape,
  placementConsequences,
  type Advisory,
  type LsnSample,
  type WitnessPlacement,
} from "../utils/haAdvisories.js";

const execFileAsync = promisify(execFile);

export const HA_CONFIG_KEY = "ha.config";

/** Patroni's default lease TTL, as shipped in deploy/ha/patroni.yml.example. */
export const DEFAULT_TTL_SEC = 30;

export type HaRole = "primary" | "standby" | "witness";

export interface HaNode {
  /** etcd/Patroni member name. Must match on every member's config. */
  name: string;
  /** IP or FQDN the OTHER nodes reach this one on. Never the public URL. */
  clusterAddr: string;
  /** Extra SANs baked into this node's etcd certificate (NAT, second NIC). */
  extraSans: string[];
  /**
   * How this node reaches the PRIMARY to download its bundle, when that
   * differs from the primary's cluster address — a cloud witness coming in
   * through a NAT, for example. Undefined means "the primary's cluster
   * address".
   */
  reachPrimaryVia?: string;
  /** SSH host key fingerprints recorded at enrollment, for strict checking. */
  sshHostKeys: string[];
}

export interface HaGslbSettings {
  monitorIntervalSec: number;
  monitorRetries:     number;
  dnsTtlSec:          number;
}

export interface HaConfig {
  enabled: boolean;
  /** Patroni cluster scope. */
  scope:   string;
  witnessPlacement: WitnessPlacement;
  nodes: {
    primary?: HaNode;
    standby?: HaNode;
    witness?: HaNode;
  };
  /** The etcd CA. `privateKey` is sealed at rest by its key name. */
  etcdCa?: { cert: string; privateKey: string };
  /**
   * Patroni's own credentials. Each is `{ password }` so the seal catches it;
   * the cluster token is `{ token }` for the same reason.
   */
  credentials?: {
    superuser:  { password: string };
    replicator: { password: string };
    rewind:     { password: string };
    restapi:    { password: string };
    cluster:    { token: string };
  };
  /** Sync keypairs, one per database node. `privateKey` is sealed. */
  sync?: {
    primary: { publicKey: string; privateKey: string };
    standby: { publicKey: string; privateKey: string };
  };
  gslb: HaGslbSettings;
  /** Facts about the primary the standby must match. */
  hostFacts?: {
    pgBinDir:    string;
    pgdata:      string;
    tsdbVersion: string | null;
    nodeMajor:   string;
    polarisUid:  number | null;
  };
  enabledBy?: string;
  enabledAt?: string;
}

function defaults(): HaConfig {
  return {
    enabled: false,
    scope: "polaris",
    witnessPlacement: "third-site",
    nodes: {},
    gslb: { monitorIntervalSec: 5, monitorRetries: 3, dnsTtlSec: 5 },
  };
}

function parse(raw: unknown): HaConfig {
  const d = defaults();
  if (!raw || typeof raw !== "object") return d;
  const o = raw as Partial<HaConfig>;
  return {
    ...d,
    ...o,
    nodes: { ...(o.nodes ?? {}) },
    gslb: { ...d.gslb, ...(o.gslb ?? {}) },
  };
}

const store = createSettingStore<HaConfig>({ key: HA_CONFIG_KEY, ttlMs: 10_000, parse });

export async function getHaConfig(): Promise<HaConfig> {
  return store.get();
}

export function invalidateHaConfigCache(): void {
  store.invalidate();
}

/** Never let the sealed material reach an HTTP response. */
export function redactHaConfig(cfg: HaConfig): Record<string, unknown> {
  return {
    enabled: cfg.enabled,
    scope: cfg.scope,
    witnessPlacement: cfg.witnessPlacement,
    nodes: cfg.nodes,
    gslb: cfg.gslb,
    hostFacts: cfg.hostFacts,
    enabledBy: cfg.enabledBy,
    enabledAt: cfg.enabledAt,
    etcdCaPresent: Boolean(cfg.etcdCa?.cert),
    credentialsPresent: Boolean(cfg.credentials?.replicator?.password),
    syncKeysPresent: Boolean(cfg.sync?.primary?.publicKey),
  };
}

// ─── Host facts ─────────────────────────────────────────────────────────────

/**
 * Non-loopback addresses of this host, to pre-fill the primary's row.
 *
 * The operator still confirms it: a host with several NICs has no way of
 * knowing which one the other datacenter routes to, and guessing wrong here
 * produces a cluster that never forms.
 */
export function detectLocalAddresses(): { address: string; family: string; iface: string }[] {
  const out: { address: string; family: string; iface: string }[] = [];
  const ifaces = os.networkInterfaces();
  for (const [iface, addrs] of Object.entries(ifaces)) {
    for (const a of addrs ?? []) {
      if (a.internal) continue;
      if (a.family !== "IPv4" && a.family !== "IPv6") continue;
      out.push({ address: a.address, family: String(a.family), iface });
    }
  }
  return out;
}

/** Round-trip time to a host's SSH port, or null when unreachable. */
export async function measureRtt(addr: string, port = 22, timeoutMs = 2000): Promise<number | null> {
  if (!addr) return null;
  const attempt = (): Promise<number | null> =>
    new Promise((resolve) => {
      const started = process.hrtime.bigint();
      const socket = new net.Socket();
      let settled = false;
      const finish = (value: number | null): void => {
        if (settled) return;
        settled = true;
        socket.destroy();
        resolve(value);
      };
      socket.setTimeout(timeoutMs);
      socket.once("connect", () => finish(Number(process.hrtime.bigint() - started) / 1e6));
      socket.once("timeout", () => finish(null));
      socket.once("error", () => finish(null));
      try {
        socket.connect(port, addr);
      } catch {
        finish(null);
      }
    });
  // Three probes, median — a single sample over a WAN is noise.
  const samples = (await Promise.all([attempt(), attempt(), attempt()])).filter(
    (v): v is number => v !== null,
  );
  if (!samples.length) return null;
  samples.sort((a, b) => a - b);
  return samples[Math.floor(samples.length / 2)];
}

async function readWalSamples(): Promise<LsnSample[]> {
  try {
    const row = await prisma.setting.findUnique({ where: { key: WAL_SAMPLES_KEY } });
    const blob = row?.value as { samples?: unknown } | undefined;
    if (!blob || !Array.isArray(blob.samples)) return [];
    return blob.samples.filter(
      (s): s is LsnSample =>
        !!s && typeof s === "object" &&
        typeof (s as LsnSample).at === "string" &&
        typeof (s as LsnSample).lsn === "string",
    );
  } catch {
    return [];
  }
}

interface HostFactsProbe {
  cpuCount:      number;
  totalMemBytes: number;
  dbSizeBytes:   number | null;
  pgdataLocal:   boolean;
  nodeMajor:     string;
  polarisUid:    number | null;
  pgBinDir:      string | null;
  tsdbVersion:   string | null;
  chrony:        string | null;
}

/**
 * What this host can say about itself, all best-effort.
 *
 * Every field is optional in the answer because the tab must still render on a
 * host where the database role lacks `pg_read_all_settings` or where `rpm` is
 * not on the path — an unknown figure reads as "could not determine", which is
 * useful, where a failed request would leave the operator with nothing.
 */
async function probeHostFacts(): Promise<HostFactsProbe> {
  const facts: HostFactsProbe = {
    cpuCount: os.cpus().length,
    totalMemBytes: os.totalmem(),
    dbSizeBytes: null,
    pgdataLocal: false,
    nodeMajor: process.version,
    polarisUid: null,
    pgBinDir: null,
    tsdbVersion: null,
    chrony: null,
  };

  try {
    const rows = await prisma.$queryRaw<{ size: bigint }[]>`SELECT pg_database_size(current_database()) AS size`;
    if (rows?.[0]?.size != null) facts.dbSizeBytes = Number(rows[0].size);
  } catch { /* role may lack the grant */ }

  try {
    const rows = await prisma.$queryRaw<{ dir: string }[]>`SELECT current_setting('data_directory') AS dir`;
    const dir = rows?.[0]?.dir;
    if (dir) {
      // A data directory this process can stat is a database on this host.
      const { existsSync } = await import("node:fs");
      facts.pgdataLocal = existsSync(dir);
    }
  } catch { /* needs pg_read_all_settings; absence is not fatal */ }

  if (process.platform === "linux") {
    try {
      const { stdout } = await execFileAsync("id", ["-u", "polaris"], { timeout: 3000 });
      const uid = Number.parseInt(stdout.trim(), 10);
      if (Number.isFinite(uid)) facts.polarisUid = uid;
    } catch { /* not a packaged install */ }
    try {
      // -qa with a glob, not -q with one major: the package name carries the
      // PostgreSQL major (timescaledb-2-postgresql-17), so a hardcoded name
      // reports "not installed" on every host that has moved. This figure is
      // compared between the two nodes to catch a version skew that would stop
      // a replica replaying the primary's WAL, so a silent "none" on both sides
      // is worse than useless — it looks like agreement.
      const { stdout } = await execFileAsync("rpm", ["-qa", "--qf", "%{VERSION} ", "timescaledb-2-postgresql-*"], { timeout: 5000 });
      const version = stdout.trim().split(/\s+/)[0] ?? "";
      if (version && !/not installed/i.test(version)) facts.tsdbVersion = version;
    } catch { /* Timescale is optional */ }
    try {
      const { stdout } = await execFileAsync("chronyc", ["tracking"], { timeout: 3000 });
      const line = stdout.split("\n").find((l) => /System time/i.test(l));
      facts.chrony = line ? line.trim() : "synchronised";
    } catch { /* chrony may not be installed yet */ }
  }

  return facts;
}

// ─── Advisories ─────────────────────────────────────────────────────────────

export interface AdvisoryInput {
  standbyAddr?: string;
  witnessAddr?: string;
  gslb?: Partial<HaGslbSettings>;
}

export interface HaAdvisories {
  support:   ReturnType<typeof assessInstallShape>;
  latency:   { standby: Advisory; witness: Advisory };
  bandwidth: Advisory & { recommendedMbps?: number };
  rpo:       Advisory;
  rto:       Advisory & { estimate: { minSec: number; maxSec: number } };
  standby:   Advisory & { minDbVolumeBytes?: number };
  witness:   Advisory;
  placements: ReturnType<typeof placementConsequences>;
  host: {
    cpuCount: number;
    totalMemBytes: number;
    dbSizeBytes: number | null;
    nodeMajor: string;
    polarisUid: number | null;
    tsdbVersion: string | null;
    chrony: string | null;
    publicUrl: string | null;
    localAddresses: { address: string; family: string; iface: string }[];
  };
}

/**
 * Everything the guidance card shows, computed about THIS install.
 *
 * Generic advice about two-datacenter deployments is easy to ignore; "312 ms
 * to your witness, which is past what this design is tested to" is not.
 */
export async function computeAdvisories(input: AdvisoryInput = {}): Promise<HaAdvisories> {
  const cfg = await getHaConfig();
  const gslb: HaGslbSettings = { ...cfg.gslb, ...(input.gslb ?? {}) };
  const standbyAddr = input.standbyAddr || cfg.nodes.standby?.clusterAddr || "";
  const witnessAddr = input.witnessAddr || cfg.nodes.witness?.clusterAddr || "";

  const [facts, walSamples, standbyRtt, witnessRtt, lagBytes] = await Promise.all([
    probeHostFacts(),
    readWalSamples(),
    standbyAddr ? measureRtt(standbyAddr) : Promise.resolve(null),
    witnessAddr ? measureRtt(witnessAddr) : Promise.resolve(null),
    readReplicationLagBytes(),
  ]);

  const rate = walRateFromSamples(walSamples);

  return {
    support: assessInstallShape({
      platform: process.platform,
      proxyMode: isProxyMode(),
      pgbouncer: isPgbouncerMode(),
      localPgdata: facts.pgdataLocal,
      docker: Boolean(process.env.POLARIS_STATE_DIR),
    }),
    latency: {
      standby: standbyAddr
        ? rttAdvisory(standbyRtt, "the standby")
        : { level: "unknown", detail: "Enter the standby's cluster address to measure the round-trip time." },
      witness: witnessAddr
        ? rttAdvisory(witnessRtt, "the witness")
        : { level: "unknown", detail: "Enter the witness address to measure the round-trip time." },
    },
    bandwidth: walAdvisory(rate),
    rpo: rpoAdvisory(lagBytes, rate),
    rto: rtoAdvisory({
      ttlSec: DEFAULT_TTL_SEC,
      monitorIntervalSec: gslb.monitorIntervalSec,
      monitorRetries: gslb.monitorRetries,
      dnsTtlSec: gslb.dnsTtlSec,
    }),
    standby: sizingAdvisory({
      cpuCount: facts.cpuCount,
      totalMemBytes: facts.totalMemBytes,
      dbSizeBytes: facts.dbSizeBytes,
      walKeepBytes: null,
    }),
    witness: witnessAdvisory(),
    placements: placementConsequences(),
    host: {
      cpuCount: facts.cpuCount,
      totalMemBytes: facts.totalMemBytes,
      dbSizeBytes: facts.dbSizeBytes,
      nodeMajor: facts.nodeMajor,
      polarisUid: facts.polarisUid,
      tsdbVersion: facts.tsdbVersion,
      chrony: facts.chrony,
      publicUrl: getPublicApiBaseUrl(),
      localAddresses: detectLocalAddresses(),
    },
  };
}

/** Replication lag in bytes as the PRIMARY sees it, or null when not replicating. */
async function readReplicationLagBytes(): Promise<number | null> {
  if (!getDirectDatabaseUrl()) return null;
  try {
    const rows = await prisma.$queryRaw<{ lag: bigint | null }[]>`
      SELECT MAX(pg_wal_lsn_diff(sent_lsn, replay_lsn))::bigint AS lag FROM pg_stat_replication`;
    const lag = rows?.[0]?.lag;
    return lag == null ? null : Number(lag);
  } catch {
    return null;
  }
}

// ─── Cluster status ─────────────────────────────────────────────────────────

export interface HaMember {
  name:     string;
  role:     string;
  state:    string;
  host?:    string;
  lagBytes: number | null;
  timeline: number | null;
  tags:     Record<string, unknown>;
}

export interface HaClusterStatus {
  /** False when Patroni is not installed or not answering. */
  available: boolean;
  reason?:   string;
  members:   HaMember[];
  /** This node's own role per the local Patroni. */
  localRole: "primary" | "replica" | "unknown";
  /** True once the standby carries no `nofailover` tag. */
  automaticFailover: boolean;
}

const PATRONI_REST = process.env.POLARIS_PATRONI_REST || "http://127.0.0.1:8008";

/**
 * Read cluster state from the local Patroni over loopback.
 *
 * Deliberately tolerant: before adoption there is no Patroni at all, and the
 * tab has to render its build instructions in exactly that state. An
 * unreachable API is reported as `available: false` with the reason, never as
 * an error the UI has to catch.
 */
export async function getClusterStatus(): Promise<HaClusterStatus> {
  const empty: HaClusterStatus = { available: false, members: [], localRole: "unknown", automaticFailover: false };
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2500);
    let res: Response;
    try {
      res = await fetch(`${PATRONI_REST}/cluster`, { signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) return { ...empty, reason: `Patroni answered ${res.status}` };
    const body = (await res.json()) as { members?: unknown[] };
    const members: HaMember[] = (body.members ?? []).map((m) => {
      const o = (m ?? {}) as Record<string, any>;
      return {
        name: String(o.name ?? "?"),
        role: String(o.role ?? "?"),
        state: String(o.state ?? "?"),
        host: o.host ? String(o.host) : undefined,
        lagBytes: typeof o.lag === "number" ? o.lag : null,
        timeline: typeof o.timeline === "number" ? o.timeline : null,
        tags: (o.tags ?? {}) as Record<string, unknown>,
      };
    });
    // "master" in Patroni 3.x, "primary" in 4.x — accept both rather than
    // pinning a version, exactly as the callback script does.
    const leader = members.find((m) => m.role === "leader" || m.role === "master" || m.role === "primary");
    const replicas = members.filter((m) => m !== leader);
    return {
      available: true,
      members,
      localRole: await readLocalRole(),
      // Failover is only really armed once no replica is tagged nofailover.
      automaticFailover: replicas.length > 0 && replicas.every((m) => m.tags?.nofailover !== true),
    };
  } catch (err: any) {
    return { ...empty, reason: err?.name === "AbortError" ? "Patroni did not answer in 2.5 s" : "Patroni is not reachable on this host" };
  }
}

async function readLocalRole(): Promise<"primary" | "replica" | "unknown"> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2000);
    try {
      const res = await fetch(`${PATRONI_REST}/primary`, { signal: controller.signal });
      if (res.status === 200) return "primary";
      if (res.status === 503) return "replica";
      return "unknown";
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return "unknown";
  }
}

// ─── Enable / disable ───────────────────────────────────────────────────────

export interface EnableHaInput {
  scope?: string;
  witnessPlacement: WitnessPlacement;
  primary: { name: string; clusterAddr: string; extraSans?: string[] };
  standby: { name: string; clusterAddr: string; extraSans?: string[]; reachPrimaryVia?: string };
  witness: { name: string; clusterAddr: string; extraSans?: string[]; reachPrimaryVia?: string };
  gslb?: Partial<HaGslbSettings>;
}

function randomPassword(): string {
  // Base64 minus the characters that need quoting in YAML, a shell, or a
  // libpq connection string — these end up in all three.
  return randomBytes(24)
    .toString("base64")
    .replace(/[+/=]/g, "")
    .slice(0, 28);
}

/**
 * Turn HA on: validate the topology, mint the credentials and the etcd CA.
 *
 * This writes configuration only. Nothing is installed and nothing is
 * restarted — the operator runs the generated scripts, and the primary's own
 * adoption is deliberately a script they watch rather than a button, because
 * it stops the database the UI is served from.
 */
export async function enableHa(input: EnableHaInput, actor: string): Promise<HaConfig> {
  const names = [input.primary.name, input.standby.name, input.witness.name];
  const addrs = [input.primary.clusterAddr, input.standby.clusterAddr, input.witness.clusterAddr];
  for (const [i, n] of names.entries()) {
    if (!n || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,62}$/.test(n)) {
      throw new AppError(400, `Node ${i + 1} needs a member name of letters, digits, dots, dashes or underscores.`);
    }
  }
  if (new Set(names).size !== 3) throw new AppError(400, "The three member names must differ — etcd matches members by name.");
  for (const [i, a] of addrs.entries()) {
    if (!a || !/^[a-zA-Z0-9._:-]{1,255}$/.test(a)) {
      throw new AppError(400, `Node ${i + 1} needs a cluster address (an IP or a resolvable name).`);
    }
  }
  if (new Set(addrs).size !== 3) throw new AppError(400, "The three cluster addresses must differ.");

  const existing = await getHaConfig();
  const support = assessInstallShape({
    platform: process.platform,
    proxyMode: isProxyMode(),
    pgbouncer: isPgbouncerMode(),
    localPgdata: true, // enableHa writes config only; the scripts re-check on the host
    docker: Boolean(process.env.POLARIS_STATE_DIR),
  });
  if (!support.supported) {
    throw new AppError(409, `This install cannot use the HA deployment: ${support.reasons.join(" ")}`);
  }

  const node = (
    n: { name: string; clusterAddr: string; extraSans?: string[]; reachPrimaryVia?: string },
    prev?: HaNode,
  ): HaNode => ({
    name: n.name,
    clusterAddr: n.clusterAddr,
    extraSans: (n.extraSans ?? []).filter((s) => !!s && /^[a-zA-Z0-9._:-]{1,255}$/.test(s)),
    reachPrimaryVia: n.reachPrimaryVia || undefined,
    // Host keys are learned at enrollment; keep any we already have.
    sshHostKeys: prev?.sshHostKeys ?? [],
  });

  const facts = await probeHostFacts();

  const cfg: HaConfig = {
    ...defaults(),
    ...existing,
    enabled: true,
    scope: input.scope?.trim() || existing.scope || "polaris",
    witnessPlacement: input.witnessPlacement,
    nodes: {
      primary: node(input.primary, existing.nodes.primary),
      standby: node(input.standby, existing.nodes.standby),
      witness: node(input.witness, existing.nodes.witness),
    },
    gslb: { ...existing.gslb, ...(input.gslb ?? {}) },
    // Re-enabling must never rotate credentials the nodes already hold.
    credentials: existing.credentials ?? {
      superuser:  { password: randomPassword() },
      replicator: { password: randomPassword() },
      rewind:     { password: randomPassword() },
      restapi:    { password: randomPassword() },
      cluster:    { token: randomPassword() },
    },
    etcdCa: existing.etcdCa ?? (await generateEtcdCa()),
    sync: existing.sync ?? {
      primary: generateSyncKeypair("polaris-ha primary"),
      standby: generateSyncKeypair("polaris-ha standby"),
    },
    hostFacts: {
      // Fallbacks only — a probed host overwrites both. Keep the major in step
      // with PG_MAJOR in deploy/setup-rhel.sh and deploy/ha/setup-rhel-ha.sh.
      pgBinDir: existing.hostFacts?.pgBinDir ?? "/usr/pgsql-17/bin",
      pgdata: existing.hostFacts?.pgdata ?? "/var/lib/pgsql/17/data",
      tsdbVersion: facts.tsdbVersion,
      nodeMajor: facts.nodeMajor,
      polarisUid: facts.polarisUid,
    },
    enabledBy: actor,
    enabledAt: new Date().toISOString(),
  };

  await store.save(cfg);
  logger.info({ actor, nodes: names }, "HA enabled");
  return cfg;
}

/**
 * Turn HA off in Polaris's own configuration.
 *
 * Keeps the credentials and the CA: an operator who disables HA to rebuild it,
 * or who is mid-teardown, must not have to re-issue every certificate. The
 * generated teardown script is what actually undoes the host changes.
 */
export async function disableHa(actor: string): Promise<HaConfig> {
  const cfg = await getHaConfig();
  const next: HaConfig = { ...cfg, enabled: false };
  await store.save(next);
  logger.warn({ actor }, "HA disabled in configuration (host changes are undone by the teardown script)");
  return next;
}

// ─── etcd CA and sync keys ──────────────────────────────────────────────────

/**
 * A dedicated CA for etcd's mutual TLS.
 *
 * Its own authority rather than the public web certificate or the agent
 * signing CA: these certificates authenticate three machines to each other on
 * two ports and nothing else, which is what makes it safe to put the witness
 * on a routable address. Generated with openssl because Node cannot sign an
 * X.509 certificate, and openssl is present on every host that runs Polaris.
 */
async function generateEtcdCa(): Promise<{ cert: string; privateKey: string }> {
  const { mkdtempSync, readFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "polaris-ha-ca-"));
  try {
    const keyPath = join(dir, "ca.key");
    const crtPath = join(dir, "ca.crt");
    await execFileAsync("openssl", ["genrsa", "-out", keyPath, "4096"], { timeout: 60_000 });
    await execFileAsync("openssl", [
      "req", "-x509", "-new", "-nodes", "-key", keyPath, "-sha256", "-days", "3650",
      "-subj", "/CN=Polaris HA etcd CA", "-out", crtPath,
    ], { timeout: 30_000 });
    return {
      cert: readFileSync(crtPath, "utf8"),
      privateKey: readFileSync(keyPath, "utf8"),
    };
  } catch (err: any) {
    logger.error({ err: err?.message }, "etcd CA generation failed");
    throw new AppError(500, "Could not generate the etcd certificate authority — is openssl installed on this host?");
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

/**
 * An ed25519 keypair for the file-sync channel.
 *
 * In-process via ssh2's generator, the same call windowsSshOnboardingService
 * uses — it emits the OpenSSH private-key format the client accepts directly,
 * so there is no ssh-keygen to shell out to and no format conversion.
 */
/**
 * An ed25519 keypair for the file-sync channel.
 *
 * Through the shared helper, which validates by parsing and retries: ssh2's
 * generator emits an unparseable private key about one call in three, and
 * without the retry one HA enable in three would fail with a 500 after having
 * already created the certificate authority.
 */
function generateSyncKeypair(comment: string): { publicKey: string; privateKey: string } {
  try {
    const pair = generateEd25519Keypair(comment);
    return { publicKey: pair.publicKey, privateKey: pair.privateKey };
  } catch (err) {
    if (err instanceof SshKeygenError) throw new AppError(500, err.message);
    throw err;
  }
}

/**
 * Issue a member certificate from the stored CA.
 *
 * Both usages on one certificate: an etcd member is a server to its peers and
 * a client to them at the same time, and Patroni reuses the same pair to
 * authenticate to etcd. Every address the member might be dialled on has to be
 * a SAN, or the peer that dialled it rejects the handshake.
 */
export async function issueEtcdCert(
  cfg: HaConfig,
  nodeName: string,
  addr: string,
  extraSans: string[] = [],
): Promise<{ cert: string; privateKey: string }> {
  if (!cfg.etcdCa) throw new AppError(409, "No etcd certificate authority yet — enable HA first.");
  const { mkdtempSync, readFileSync, writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "polaris-ha-cert-"));
  try {
    const caKey = join(dir, "ca.key");
    const caCrt = join(dir, "ca.crt");
    const key = join(dir, "node.key");
    const csr = join(dir, "node.csr");
    const crt = join(dir, "node.crt");
    const cnf = join(dir, "node.cnf");
    writeFileSync(caKey, cfg.etcdCa.privateKey, { mode: 0o600 });
    writeFileSync(caCrt, cfg.etcdCa.cert);

    const isIpv4 = (v: string): boolean => /^\d{1,3}(\.\d{1,3}){3}$/.test(v);
    const sans = [addr, ...extraSans, "127.0.0.1", "localhost"];
    const lines: string[] = [];
    let ipN = 1;
    let dnsN = 1;
    for (const s of sans) {
      if (!s) continue;
      if (isIpv4(s)) lines.push(`IP.${ipN++} = ${s}`);
      else lines.push(`DNS.${dnsN++} = ${s}`);
    }
    writeFileSync(cnf, [
      "[req]", "distinguished_name = dn", "req_extensions = ext", "prompt = no",
      "[dn]", `CN = ${nodeName}`,
      "[ext]", "basicConstraints = CA:FALSE",
      "keyUsage = digitalSignature, keyEncipherment",
      "extendedKeyUsage = serverAuth, clientAuth",
      "subjectAltName = @san",
      "[san]", ...lines, "",
    ].join("\n"));

    await execFileAsync("openssl", ["genrsa", "-out", key, "2048"], { timeout: 30_000 });
    await execFileAsync("openssl", ["req", "-new", "-key", key, "-out", csr, "-config", cnf], { timeout: 15_000 });
    await execFileAsync("openssl", [
      "x509", "-req", "-in", csr, "-CA", caCrt, "-CAkey", caKey, "-CAcreateserial",
      "-out", crt, "-days", "1825", "-sha256", "-extensions", "ext", "-extfile", cnf,
    ], { timeout: 15_000 });

    return { cert: readFileSync(crt, "utf8"), privateKey: readFileSync(key, "utf8") };
  } catch (err: any) {
    logger.error({ err: err?.message, nodeName }, "etcd member certificate issuance failed");
    throw new AppError(500, "Could not issue the etcd member certificate — see the server log for details.");
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}
