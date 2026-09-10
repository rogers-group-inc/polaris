/**
 * src/services/haEnrollmentService.ts — how a node joins the cluster.
 *
 * The operator never copies secrets around by hand. The tab mints a single-use
 * token, hands them a thin bootstrap script carrying it, and the node fetches
 * everything else itself over pinned TLS.
 *
 * ── Why redeeming the token is not enough ─────────────────────────────────────
 * A node's bundle contains the whole install: .env (with the key that decrypts
 * every stored credential), the nginx private key, the database passwords. So
 * the token buys one thing only — the right to ASK. Registration records who
 * asked, from which address, presenting which SSH host keys, and then waits.
 * An operator approves it in the UI, and only then can the bundle be
 * downloaded, once.
 *
 * That means a leaked script produces a pending row an operator can look at
 * and reject, rather than a silent handover. It also means the operator
 * approves against evidence — a source address and a host key fingerprint —
 * instead of a member name the requester chose for itself.
 *
 * ── Shape of the flow ─────────────────────────────────────────────────────────
 *   tab: POST /ha/tokens            → issued
 *   node: POST /ha/enroll           → pending   (token spent here)
 *   tab: POST /ha/enrollments/:id/approve → approved
 *   node: GET /ha/enroll/:req?download=1 → delivered (terminal)
 *
 * Tokens are the ManagedAgent pattern: `polaris_<32 chars>`, argon2id-hashed,
 * looked up by an indexed prefix and verified by hash, never compared as
 * strings.
 */

import { randomBytes } from "node:crypto";
import { gzipSync } from "node:zlib";
import { readFileSync } from "node:fs";
import { prisma } from "../db.js";
import { logger } from "../utils/logger.js";
import { AppError } from "../utils/errors.js";
import { hashPassword, verifyPassword } from "../utils/password.js";
import { TOKEN_PREFIX, TOKEN_INDEX_PREFIX_LEN, generateRawToken } from "../utils/bearerToken.js";
import { buildTar, type TarEntry } from "../utils/tarWriter.js";
import { ENV_FILE } from "../utils/paths.js";
import { getServerCertFingerprint } from "./certInfo.js";
import { getPublicApiBaseUrl } from "../utils/publicUrl.js";
import {
  getHaConfig,
  issueEtcdCert,
  type HaConfig,
  type HaNode,
  type HaRole,
} from "./haService.js";

const TOKEN_PREFIX_LEN = TOKEN_INDEX_PREFIX_LEN;

/**
 * The PostgreSQL major the setup scripts provision, used only when this host's
 * real paths were never probed. Keep in step with PG_MAJOR in
 * deploy/setup-rhel.sh and deploy/ha/setup-rhel-ha.sh.
 */
const DEFAULT_PG_MAJOR = 17;

/**
 * Pull the major out of a PGDG path — `/usr/pgsql-17/bin`, `/var/lib/pgsql/17/data`.
 * Returns null when neither path is present or neither carries a number, which
 * is the signal to fall back to DEFAULT_PG_MAJOR rather than guess.
 */
function pgMajorFromPaths(binDir?: string | null, dataDir?: string | null): number | null {
  for (const p of [binDir, dataDir]) {
    const m = p?.match(/pgsql-(\d+)|pgsql\/(\d+)/);
    const n = Number.parseInt(m?.[1] ?? m?.[2] ?? "", 10);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

/**
 * 24 hours. Longer than the agent's ten minutes because this is a human
 * workflow: the operator downloads three scripts and then walks to (or
 * provisions) three machines. Short enough that a forgotten script in a
 * downloads folder stops working the next day.
 */
export const TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

/** How long a registered node may wait for approval before it gives up. */
export const APPROVAL_WINDOW_MS = 30 * 60 * 1000;

export type EnrollmentStatus = "issued" | "pending" | "approved" | "delivered" | "rejected" | "expired";

// ─── Minting ────────────────────────────────────────────────────────────────

export interface MintedToken {
  id:        string;
  role:      HaRole;
  nodeName:  string;
  nodeAddr:  string;
  /** Shown once, embedded in the script, never stored in plaintext. */
  token:     string;
  expiresAt: Date;
}

/**
 * Mint a token for one node.
 *
 * Any earlier unused token for the same role is expired first: a re-issue is
 * how an operator recovers from a lost or stale script, and leaving the old
 * one live would widen the window for no benefit. Rows that already delivered
 * are left alone — they are the audit trail.
 */
export async function mintNodeToken(role: HaRole, actor: string): Promise<MintedToken> {
  const cfg = await getHaConfig();
  if (!cfg.enabled) throw new AppError(409, "Enable high availability first.");
  const node = cfg.nodes[role];
  if (!node) throw new AppError(400, `No ${role} node is configured.`);

  await prisma.haEnrollment.updateMany({
    where: { role, status: { in: ["issued", "pending", "approved"] } },
    data: { status: "expired" },
  });

  const token = generateRawToken();
  const row = await prisma.haEnrollment.create({
    data: {
      role,
      nodeName: node.name,
      nodeAddr: node.clusterAddr,
      tokenHash: await hashPassword(token),
      tokenPrefix: token.slice(0, TOKEN_PREFIX_LEN),
      expiresAt: new Date(Date.now() + TOKEN_TTL_MS),
      status: "issued",
      createdBy: actor,
    },
  });

  logger.info({ actor, role, nodeName: node.name }, "HA node token minted");
  return { id: row.id, role, nodeName: node.name, nodeAddr: node.clusterAddr, token, expiresAt: row.expiresAt };
}

// ─── Registration ───────────────────────────────────────────────────────────

export interface RegisterInput {
  token:                  string;
  nodeName:               string;
  sshHostKeyFingerprints: string[];
  sourceIp:               string | null;
}

/**
 * Spend the token and record a pending request.
 *
 * The token is consumed HERE, before approval, deliberately: a second attempt
 * with the same token must fail, and if someone else got hold of it the
 * operator should see a rejected attempt rather than a race. Every failure
 * returns the same 401 text — an unauthenticated caller learns nothing about
 * whether a token existed, expired or was already used.
 */
export async function registerEnrollment(input: RegisterInput): Promise<{ requestId: string }> {
  const raw = (input.token || "").trim();
  if (!raw.startsWith(TOKEN_PREFIX)) throw new AppError(401, "Invalid enrollment token");

  const candidates = await prisma.haEnrollment.findMany({
    where: {
      tokenPrefix: raw.slice(0, TOKEN_PREFIX_LEN),
      status: "issued",
      expiresAt: { gt: new Date() },
    },
  });

  for (const row of candidates) {
    const { valid } = await verifyPassword(raw, row.tokenHash);
    if (!valid) continue;

    const requestId = randomBytes(32).toString("hex");
    // Conditional update on status: two simultaneous registrations with one
    // token cannot both win, because the second finds the row no longer
    // "issued".
    const claimed = await prisma.haEnrollment.updateMany({
      where: { id: row.id, status: "issued" },
      data: {
        status: "pending",
        requestId,
        registeredFromIp: input.sourceIp,
        registeredNodeName: input.nodeName || null,
        sshHostKeyFingerprints: (input.sshHostKeyFingerprints ?? []).slice(0, 8),
        registeredAt: new Date(),
      },
    });
    if (claimed.count !== 1) throw new AppError(401, "Enrollment token rejected");

    logger.warn(
      { role: row.role, nodeName: input.nodeName, sourceIp: input.sourceIp, enrollmentId: row.id },
      "HA node registered and is awaiting operator approval",
    );
    return { requestId };
  }

  throw new AppError(401, "Enrollment token rejected");
}

export interface EnrollmentPollResult {
  status:  EnrollmentStatus;
  /** Present when the operator has approved and the bundle is downloadable. */
  ready:   boolean;
  message: string;
}

/** What the bootstrap script's poll loop sees. */
export async function pollEnrollment(requestId: string): Promise<EnrollmentPollResult> {
  const row = await prisma.haEnrollment.findUnique({ where: { requestId } });
  if (!row) throw new AppError(404, "Unknown enrollment request");
  const status = row.status as EnrollmentStatus;

  if (status === "pending" && row.registeredAt && Date.now() - row.registeredAt.getTime() > APPROVAL_WINDOW_MS) {
    await prisma.haEnrollment.update({ where: { id: row.id }, data: { status: "expired" } });
    return { status: "expired", ready: false, message: "This request waited too long for approval. Re-generate the script." };
  }

  switch (status) {
    case "pending":
      return { status, ready: false, message: "Waiting for an operator to approve this node in Server Settings -> High Availability." };
    case "approved":
      return { status, ready: true, message: "Approved. Downloading the node bundle." };
    case "delivered":
      return { status, ready: false, message: "This bundle has already been downloaded. Re-generate the script to install again." };
    case "rejected":
      return { status, ready: false, message: "An operator rejected this node." };
    default:
      return { status, ready: false, message: "This request is no longer valid. Re-generate the script." };
  }
}

// ─── Approval ───────────────────────────────────────────────────────────────

export async function listEnrollments(): Promise<
  {
    id: string; role: string; nodeName: string; nodeAddr: string; status: string;
    registeredFromIp: string | null; registeredNodeName: string | null;
    sshHostKeyFingerprints: string[]; registeredAt: Date | null;
    approvedBy: string | null; approvedAt: Date | null; deliveredAt: Date | null;
    expiresAt: Date; createdBy: string | null; createdAt: Date;
  }[]
> {
  return prisma.haEnrollment.findMany({
    orderBy: { createdAt: "desc" },
    take: 50,
    select: {
      id: true, role: true, nodeName: true, nodeAddr: true, status: true,
      registeredFromIp: true, registeredNodeName: true, sshHostKeyFingerprints: true,
      registeredAt: true, approvedBy: true, approvedAt: true, deliveredAt: true,
      expiresAt: true, createdBy: true, createdAt: true,
    },
  });
}

export async function approveEnrollment(id: string, actor: string): Promise<void> {
  const row = await prisma.haEnrollment.findUnique({ where: { id } });
  if (!row) throw new AppError(404, "Enrollment not found");
  if (row.status !== "pending") {
    throw new AppError(409, `This request is ${row.status}, not pending — only a node that has connected and is waiting can be approved.`);
  }
  await prisma.haEnrollment.update({
    where: { id },
    data: { status: "approved", approvedBy: actor, approvedAt: new Date() },
  });
  logger.warn({ actor, enrollmentId: id, role: row.role, sourceIp: row.registeredFromIp }, "HA node approved");
}

export async function rejectEnrollment(id: string, actor: string): Promise<void> {
  const row = await prisma.haEnrollment.findUnique({ where: { id } });
  if (!row) throw new AppError(404, "Enrollment not found");
  if (row.status === "delivered") {
    throw new AppError(409, "That bundle has already been delivered — rejecting it now would change nothing. Roll the credentials instead.");
  }
  await prisma.haEnrollment.update({
    where: { id },
    data: { status: "rejected", rejectedBy: actor, rejectedAt: new Date() },
  });
  logger.warn({ actor, enrollmentId: id, sourceIp: row.registeredFromIp }, "HA node rejected");
}

// ─── The bundle ─────────────────────────────────────────────────────────────

/**
 * Claim the one download this approval allows.
 *
 * The status flip happens BEFORE the archive is built, and conditionally, so
 * two concurrent downloads cannot both succeed. The cost of that ordering is
 * that a build failure burns the approval — the operator re-approves — which
 * is the right way round: a second copy of a bundle full of private keys is
 * worse than a repeated click.
 */
export async function claimBundle(requestId: string): Promise<{ archive: Buffer; filename: string }> {
  const row = await prisma.haEnrollment.findUnique({ where: { requestId } });
  if (!row) throw new AppError(404, "Unknown enrollment request");
  if (row.status !== "approved") {
    throw new AppError(403, "This node has not been approved yet.");
  }
  const claimed = await prisma.haEnrollment.updateMany({
    where: { id: row.id, status: "approved" },
    data: { status: "delivered", deliveredAt: new Date() },
  });
  if (claimed.count !== 1) throw new AppError(410, "This bundle has already been downloaded.");

  const cfg = await getHaConfig();
  const archive = await buildNodeBundle(cfg, row.role as HaRole);

  // Remember the host keys this node presented, so the reconciler can use
  // strict host-key checking instead of trusting on first use.
  if (row.sshHostKeyFingerprints.length) {
    await rememberNodeHostKeys(row.role as HaRole, row.sshHostKeyFingerprints);
  }

  logger.warn({ role: row.role, enrollmentId: row.id }, "HA node bundle delivered");
  return { archive, filename: `polaris-ha-${row.role}-bundle.tar.gz` };
}

async function rememberNodeHostKeys(role: HaRole, fingerprints: string[]): Promise<void> {
  const { getHaConfig: read } = await import("./haService.js");
  const cfg = await read();
  const node = cfg.nodes[role];
  if (!node) return;
  const next = { ...cfg, nodes: { ...cfg.nodes, [role]: { ...node, sshHostKeys: fingerprints } } };
  await prisma.setting.upsert({
    where: { key: "ha.config" },
    update: { value: next as never },
    create: { key: "ha.config", value: next as never },
  });
  const { invalidateHaConfigCache } = await import("./haService.js");
  invalidateHaConfigCache();
}

function requireNode(cfg: HaConfig, role: HaRole): HaNode {
  const node = cfg.nodes[role];
  if (!node) throw new AppError(409, `No ${role} node is configured.`);
  return node;
}

/**
 * Build one node's bundle.
 *
 * The witness gets etcd material only — no .env, no nginx key, no database
 * password. It is a vote, and a vote does not need to be able to impersonate
 * the application.
 */
export async function buildNodeBundle(cfg: HaConfig, role: HaRole): Promise<Buffer> {
  if (!cfg.enabled) throw new AppError(409, "High availability is not enabled.");
  if (!cfg.credentials || !cfg.etcdCa || !cfg.sync) {
    throw new AppError(409, "The HA configuration is incomplete — re-run Enable.");
  }
  const primary = requireNode(cfg, "primary");
  const standby = requireNode(cfg, "standby");
  const witness = requireNode(cfg, "witness");
  const self = requireNode(cfg, role);

  // Checked here, not where the cert is read into the tar below. Two reasons,
  // both learned the hard way:
  //   - The entries.push() for a non-witness role evaluates readEnvFile()
  //     BEFORE readProxyCert() (arguments evaluate left to right), so on a host
  //     whose .env is unreadable the operator got a 500 about .env and could
  //     never see this 409 — the one that names the thing they have to fix.
  //   - issueEtcdCert() below mints a node certificate. Refusing after that
  //     point means a cert was issued and thrown away for a request that was
  //     never going to succeed.
  // The witness is exempt: it gets etcd material only, and a vote does not need
  // to be able to impersonate the application.
  if (role !== "witness" && !process.env.POLARIS_PROXY_CERT_PATH) {
    throw new AppError(
      409,
      "POLARIS_PROXY_CERT_PATH is not set — the standby must serve the same certificate agents pin.",
    );
  }

  const cert = await issueEtcdCert(cfg, self.name, self.clusterAddr, self.extraSans);

  const entries: TarEntry[] = [
    { name: "MANIFEST.json", data: JSON.stringify(buildManifest(cfg, role), null, 2) + "\n", mode: 0o644 },
    { name: "etcd/ca.crt", data: cfg.etcdCa.cert, mode: 0o644 },
    { name: `etcd/${self.name}.crt`, data: cert.cert, mode: 0o644 },
    { name: `etcd/${self.name}.key`, data: cert.privateKey, mode: 0o600 },
    { name: "etcd/etcd.conf", data: renderEtcdConf(cfg, role), mode: 0o644 },
  ];

  if (role !== "witness") {
    const syncKeys = role === "primary" ? cfg.sync.primary : cfg.sync.standby;
    const peerKeys = role === "primary" ? cfg.sync.standby : cfg.sync.primary;
    entries.push(
      { name: "patroni/patroni.yml", data: renderPatroniYml(cfg, role), mode: 0o600 },
      { name: "sync/id_ed25519", data: syncKeys.privateKey, mode: 0o600 },
      { name: "sync/id_ed25519.pub", data: syncKeys.publicKey + "\n", mode: 0o644 },
      { name: "sync/peer_authorized_keys", data: renderAuthorizedKeys(cfg, role, peerKeys.publicKey), mode: 0o600 },
      { name: "app/.env", data: readEnvFile(), mode: 0o600 },
      { name: "app/nginx-cert.pem", data: readProxyCert(), mode: 0o644 },
      { name: "app/nginx-key.pem", data: readProxyKey(), mode: 0o600 },
      { name: "ha.conf", data: renderHaConf(cfg, role), mode: 0o600 },
    );
  }

  entries.push({ name: "INSTALL.txt", data: renderBundleReadme(cfg, role, { primary, standby, witness }), mode: 0o644 });
  return gzipSync(buildTar(entries));
}

function buildManifest(cfg: HaConfig, role: HaRole): Record<string, unknown> {
  return {
    role,
    scope: cfg.scope,
    generatedAt: new Date().toISOString(),
    node: cfg.nodes[role],
    // Asserted by the bootstrap script: a standby that cannot run the code it
    // is about to be handed is better refused than discovered at failover.
    expect: {
      nodeMajor: cfg.hostFacts?.nodeMajor ?? null,
      polarisUid: cfg.hostFacts?.polarisUid ?? null,
      tsdbVersion: cfg.hostFacts?.tsdbVersion ?? null,
      pgBinDir: cfg.hostFacts?.pgBinDir ?? null,
      pgdata: cfg.hostFacts?.pgdata ?? null,
    },
  };
}

function readEnvFile(): string {
  try {
    return readFileSync(ENV_FILE, "utf8");
  } catch (err: any) {
    logger.error({ err: err?.message, path: ENV_FILE }, "HA bundle: .env unreadable");
    throw new AppError(500, "Could not read this host's .env — the standby cannot run without it.");
  }
}

function readProxyCert(): string {
  const path = process.env.POLARIS_PROXY_CERT_PATH;
  if (!path) throw new AppError(409, "POLARIS_PROXY_CERT_PATH is not set — the standby must serve the same certificate agents pin.");
  try {
    return readFileSync(path, "utf8");
  } catch (err: any) {
    logger.error({ err: err?.message, path }, "HA bundle: proxy cert unreadable");
    throw new AppError(500, "Could not read the nginx certificate.");
  }
}

function readProxyKey(): string {
  const certPath = process.env.POLARIS_PROXY_CERT_PATH;
  if (!certPath) throw new AppError(409, "POLARIS_PROXY_CERT_PATH is not set.");
  // The shipped layout keeps the key beside the cert as key.pem.
  const keyPath = certPath.replace(/cert\.pem$/, "key.pem");
  try {
    return readFileSync(keyPath, "utf8");
  } catch (err: any) {
    logger.error({ err: err?.message, path: keyPath }, "HA bundle: proxy key unreadable");
    throw new AppError(
      500,
      `Could not read the nginx private key at ${keyPath}. The polaris user must be in the nginx group for the standby to serve the same certificate.`,
    );
  }
}

// ─── Rendered config ────────────────────────────────────────────────────────

function etcdInitialCluster(cfg: HaConfig): string {
  const p = requireNode(cfg, "primary");
  const s = requireNode(cfg, "standby");
  const w = requireNode(cfg, "witness");
  return [p, s, w].map((n) => `${n.name}=https://${n.clusterAddr}:2380`).join(",");
}

function renderEtcdConf(cfg: HaConfig, role: HaRole): string {
  const self = requireNode(cfg, role);
  const token = cfg.credentials!.cluster.token;
  return [
    `# Polaris HA — etcd member config for ${self.name} (${role}).`,
    "# Rendered by Polaris. See docs/HA.md.",
    "#",
    "# Bring the members up in this order the first time, all with STATE=new:",
    "# witness, then the primary, then the standby.",
    "",
    `ETCD_NAME=${self.name}`,
    `ETCD_DATA_DIR=/var/lib/etcd/${self.name}.etcd`,
    "",
    `ETCD_LISTEN_PEER_URLS=https://${self.clusterAddr}:2380`,
    `ETCD_LISTEN_CLIENT_URLS=https://${self.clusterAddr}:2379,https://127.0.0.1:2379`,
    `ETCD_INITIAL_ADVERTISE_PEER_URLS=https://${self.clusterAddr}:2380`,
    `ETCD_ADVERTISE_CLIENT_URLS=https://${self.clusterAddr}:2379`,
    "",
    `ETCD_INITIAL_CLUSTER=${etcdInitialCluster(cfg)}`,
    `ETCD_INITIAL_CLUSTER_TOKEN=${token}`,
    "# Change to \"existing\" when adding a member to a cluster that already runs.",
    "ETCD_INITIAL_CLUSTER_STATE=new",
    "",
    "# Mutual TLS on both channels. This is what makes a witness on a routable",
    "# address safe: an open port is useless without a certificate from our CA.",
    `ETCD_CERT_FILE=/etc/polaris/etcd-ca/${self.name}.crt`,
    `ETCD_KEY_FILE=/etc/polaris/etcd-ca/${self.name}.key`,
    "ETCD_TRUSTED_CA_FILE=/etc/polaris/etcd-ca/ca.crt",
    "ETCD_CLIENT_CERT_AUTH=true",
    `ETCD_PEER_CERT_FILE=/etc/polaris/etcd-ca/${self.name}.crt`,
    `ETCD_PEER_KEY_FILE=/etc/polaris/etcd-ca/${self.name}.key`,
    "ETCD_PEER_TRUSTED_CA_FILE=/etc/polaris/etcd-ca/ca.crt",
    "ETCD_PEER_CLIENT_CERT_AUTH=true",
    "",
    "# Datacenter defaults assume a LAN; these tolerate a WAN round-trip.",
    "ETCD_HEARTBEAT_INTERVAL=250",
    "ETCD_ELECTION_TIMEOUT=2500",
    "ETCD_AUTO_COMPACTION_MODE=periodic",
    "ETCD_AUTO_COMPACTION_RETENTION=1",
    "ETCD_ENABLE_V2=false",
    "",
  ].join("\n");
}

function renderPatroniYml(cfg: HaConfig, role: HaRole): string {
  const self = requireNode(cfg, role);
  const peer = requireNode(cfg, role === "primary" ? "standby" : "primary");
  const c = cfg.credentials!;
  const facts = cfg.hostFacts!;
  const hosts = [requireNode(cfg, "primary"), requireNode(cfg, "standby"), requireNode(cfg, "witness")];
  // The standby cannot win an election until a human has watched a switchover.
  const nofailover = role === "standby";
  return [
    `# Polaris HA — Patroni config for ${self.name} (${role}). Rendered by Polaris.`,
    "#",
    "# Patroni takes ownership of postgresql.conf and REGENERATES pg_hba.conf",
    "# from this file. The parameters below were read off the running primary at",
    "# Enable time; check them against `SELECT name, setting, source FROM",
    "# pg_settings WHERE source NOT IN ('default','override')` before adopting.",
    "",
    `scope: ${cfg.scope}`,
    `name: ${self.name}`,
    "",
    "restapi:",
    "  listen: 0.0.0.0:8008",
    `  connect_address: ${self.clusterAddr}:8008`,
    "  authentication:",
    "    username: patroni",
    `    password: '${c.restapi.password}'`,
    "",
    "etcd3:",
    "  hosts:",
    ...hosts.map((h) => `    - ${h.clusterAddr}:2379`),
    "  protocol: https",
    "  cacert: /etc/polaris/etcd-ca/ca.crt",
    `  cert: /etc/polaris/etcd-ca/${self.name}.crt`,
    `  key: /etc/polaris/etcd-ca/${self.name}.key`,
    "",
    "bootstrap:",
    "  dcs:",
    "    # ttl >= loop_wait + 2*retry_timeout is the split-brain timing",
    "    # invariant: a leader that cannot renew demotes ITSELF before the",
    "    # lease can expire. Do not shorten ttl alone.",
    "    ttl: 30",
    "    loop_wait: 10",
    "    retry_timeout: 10",
    "    synchronous_mode: false",
    "    # Patroni's 1MiB default would refuse to promote a standby that this",
    "    # workload routinely leaves further behind, turning an automatic",
    "    # failover into a phone call.",
    "    maximum_lag_on_failover: 268435456",
    "    failsafe_mode: true",
    "    postgresql:",
    "      use_pg_rewind: true",
    "      use_slots: true",
    "      remove_data_directory_on_rewind_failure: true",
    "      remove_data_directory_on_diverged_timelines: true",
    "      parameters:",
    "        wal_level: replica",
    "        hot_standby: 'on'",
    "        # Required for pg_rewind unless the cluster has data checksums.",
    "        wal_log_hints: 'on'",
    "        wal_compression: 'on'",
    "        max_wal_senders: 10",
    "        max_replication_slots: 10",
    "        max_slot_wal_keep_size: 20GB",
    "        ssl: 'on'",
    "        ssl_cert_file: /etc/polaris/pg-tls/server.crt",
    "        ssl_key_file: /etc/polaris/pg-tls/server.key",
    ...(facts.tsdbVersion
      ? [
          "        # Both nodes must load the same TimescaleDB version as the",
          "        # catalogue; the packages are versionlocked on each host.",
          "        shared_preload_libraries: timescaledb",
          "        timescaledb.max_background_workers: 8",
        ]
      : []),
    "",
    "  # No initdb section on purpose: this cluster is ADOPTED, never created,",
    "  # so a node with an empty data directory can never offer up a new empty",
    "  # cluster as the truth.",
    "",
    "postgresql:",
    `  listen: ${self.clusterAddr},127.0.0.1:5432`,
    `  connect_address: ${self.clusterAddr}:5432`,
    `  data_dir: ${facts.pgdata}`,
    `  bin_dir: ${facts.pgBinDir}`,
    "  use_unix_socket: true",
    "  pgpass: /var/lib/pgsql/.pgpass_patroni",
    "  authentication:",
    "    superuser:",
    "      username: postgres",
    `      password: '${c.superuser.password}'`,
    "    replication:",
    "      username: replicator",
    `      password: '${c.replicator.password}'`,
    "    rewind:",
    "      username: rewind_user",
    `      password: '${c.rewind.password}'`,
    "  pg_hba:",
    "    - local   all             all                                     peer",
    "    - host    all             all             127.0.0.1/32            scram-sha-256",
    "    - host    all             all             ::1/128                 scram-sha-256",
    "    # The application: local socket and loopback only. DATABASE_URL stays",
    "    # localhost on both nodes, which is also why an app can never reach",
    "    # the other node's database.",
    "    - local   polaris         polaris                                 scram-sha-256",
    "    - host    polaris         polaris         127.0.0.1/32            scram-sha-256",
    "    - host    polaris         polaris         ::1/128                 scram-sha-256",
    `    - hostssl replication     replicator      ${peer.clusterAddr}/32        scram-sha-256`,
    `    - hostssl all             rewind_user     ${peer.clusterAddr}/32        scram-sha-256`,
    "  create_replica_methods:",
    "    - basebackup",
    "  basebackup:",
    "    checkpoint: fast",
    "  callbacks:",
    "    on_start: /usr/local/sbin/polaris-patroni-callback",
    "    on_stop: /usr/local/sbin/polaris-patroni-callback",
    "    on_role_change: /usr/local/sbin/polaris-patroni-callback",
    "",
    "tags:",
    "  noloadbalance: false",
    "  clonefrom: false",
    `  nofailover: ${nofailover}`,
    ...(nofailover
      ? [
          "  # Removing this tag is the deliberate act that arms automatic",
          "  # failover. Do it after a switchover rehearsal (docs/HA.md).",
        ]
      : []),
    "",
    "# The only real fencing in a two-node cluster: a frozen Patroni holding a",
    "# valid lease is reset rather than allowed to thaw and write.",
    "watchdog:",
    "  mode: automatic",
    "  device: /dev/watchdog",
    "  safety_margin: 5",
    "",
  ].join("\n");
}

function renderAuthorizedKeys(cfg: HaConfig, role: HaRole, peerPublicKey: string): string {
  const peer = requireNode(cfg, role === "primary" ? "standby" : "primary");
  return [
    "# Append this line to /root/.ssh/authorized_keys on THIS host.",
    "#",
    "# It lets the peer read this host's file state for the sync, and nothing",
    "# else: the forced command permits rsync in the read direction plus two",
    "# status subcommands. Not a privilege boundary between the nodes — they",
    "# already share .env and the nginx private key — but it does stop a",
    "# repurposed key from running arbitrary commands or pushing files.",
    `from="${peer.clusterAddr}",command="/usr/local/sbin/polaris-ha-ssh-wrapper",restrict ${peerPublicKey}`,
    "",
  ].join("\n");
}

function renderHaConf(cfg: HaConfig, role: HaRole): string {
  const peer = requireNode(cfg, role === "primary" ? "standby" : "primary");
  return [
    "# Polaris HA reconciler configuration. Rendered by Polaris; see docs/HA.md.",
    `PEER_HOST='${peer.clusterAddr}'`,
    "PATRONI_REST='http://127.0.0.1:8008'",
    "APP_DIR='/opt/polaris'",
    "APP_USER='polaris'",
    "SYNC_KEY='/etc/polaris/ha/id_ed25519'",
    "# Cap the file sync so a standby rebuild cannot saturate the link that",
    "# replication also needs. Empty = unlimited.",
    "RSYNC_BWLIMIT=''",
    "",
  ].join("\n");
}

function renderBundleReadme(
  cfg: HaConfig,
  role: HaRole,
  nodes: { primary: HaNode; standby: HaNode; witness: HaNode },
): string {
  const self = requireNode(cfg, role);
  const lines = [
    `Polaris HA node bundle — ${role} (${self.name})`,
    "",
    "This archive contains private keys. It is written mode 0700 and the",
    "bootstrap script deletes it once the files are installed.",
    "",
    "Cluster:",
    `  primary  ${nodes.primary.name}  ${nodes.primary.clusterAddr}`,
    `  standby  ${nodes.standby.name}  ${nodes.standby.clusterAddr}`,
    `  witness  ${nodes.witness.name}  ${nodes.witness.clusterAddr}`,
    "",
    "Contents:",
    "  etcd/ca.crt, etcd/<name>.{crt,key}   mutual-TLS material for etcd",
    "  etcd/etcd.conf                       this member's etcd config",
  ];
  if (role !== "witness") {
    lines.push(
      "  patroni/patroni.yml                  this node's Patroni config",
      "  sync/id_ed25519{,.pub}               the file-sync keypair",
      "  sync/peer_authorized_keys            the line to add for the peer",
      "  app/.env                             the application environment",
      "  app/nginx-{cert,key}.pem             the certificate agents pin",
      "  ha.conf                              reconciler configuration",
    );
  }
  lines.push(
    "",
    role === "witness"
      ? "The witness runs etcd and nothing else. It holds no application secrets, no\ndatabase credentials and no data — only the leader key and member addresses."
      : "Install with deploy/ha/setup-rhel-ha.sh --from-bundle <this directory>.",
    "",
    "docs/HA.md has the build order, the drills and the failure modes.",
    "",
  );
  return lines.join("\n");
}

// ─── The bootstrap script ───────────────────────────────────────────────────

export interface NodeScript {
  filename: string;
  script:   string;
}

/**
 * The thin script an operator downloads and runs on the node.
 *
 * Deliberately carries no secrets beyond the one-use token: the public URL,
 * the certificate's public-key pin, and the token. Everything else it fetches
 * over TLS it has pinned, from a request a human has to approve.
 *
 * `--resolve` is what makes a private-address install work without a second
 * certificate: nginx still sees the public hostname in SNI and Host, the pin
 * still validates, and the packets go to the address the operator gave for
 * this node. It falls back to plain DNS when no override is configured.
 */
export async function renderNodeScript(role: HaRole, token: string): Promise<NodeScript> {
  const cfg = await getHaConfig();
  const self = requireNode(cfg, role);
  const primary = requireNode(cfg, "primary");
  const base = getPublicApiBaseUrl();
  if (!base) throw new AppError(409, "POLARIS_PUBLIC_URL is not set — the node has no address to call back to.");
  const url = new URL(base);
  const host = url.hostname;
  const port = url.port || "443";
  const pin = getServerCertFingerprint();
  const reachVia = self.reachPrimaryVia || primary.clusterAddr;

  const script = [
    "#!/usr/bin/env bash",
    `# Polaris HA bootstrap — ${role} node (${self.name})`,
    "#",
    "# Run as root on the node named above. It carries no secrets other than a",
    "# single-use token: it registers with Polaris, waits for an operator to",
    "# APPROVE this node in Server Settings -> High Availability, then downloads",
    "# the real bundle and installs it.",
    "#",
    "# The token expires 24 hours after it was generated and works once.",
    "",
    "set -euo pipefail",
    "",
    `POLARIS_HOST='${host}'`,
    `POLARIS_PORT='${port}'`,
    `POLARIS_ADDR='${reachVia}'`,
    `NODE_ROLE='${role}'`,
    `NODE_NAME='${self.name}'`,
    `TOKEN='${token}'`,
    ...(pin ? [`CERT_PIN='${pin}'`] : []),
    "BUNDLE_DIR=\"/root/polaris-ha-bundle-${NODE_ROLE}\"",
    "",
    "RED='\\033[0;31m'; GREEN='\\033[0;32m'; YELLOW='\\033[1;33m'; NC='\\033[0m'",
    "info()  { echo -e \"${GREEN}[INFO]${NC}  $*\"; }",
    "warn()  { echo -e \"${YELLOW}[WARN]${NC}  $*\"; }",
    "die()   { echo -e \"${RED}[ERROR]${NC} $*\" >&2; exit 1; }",
    "",
    "[[ $EUID -eq 0 ]] || die 'must run as root'",
    "command -v curl >/dev/null || die 'curl is required'",
    "command -v tar  >/dev/null || die 'tar is required'",
    "",
    "# Pin the certificate and force the connection to the address configured",
    "# for this node, while still presenting the public hostname so nginx",
    "# routes it and the pin matches.",
    "CURL=(curl -sS --fail-with-body --max-time 30",
    "      --resolve \"${POLARIS_HOST}:${POLARIS_PORT}:${POLARIS_ADDR}\")",
    ...(pin
      ? [
          "# The nginx leaf's SHA-256, as agents pin it. A different certificate",
          "# means this is not the Polaris you think it is.",
          "CURL+=(--pinnedpubkey \"sha256//$(printf '%s' \"${CERT_PIN#sha256:}\" | xxd -r -p | openssl base64 -A 2>/dev/null || true)\")",
        ]
      : []),
    "BASE=\"https://${POLARIS_HOST}:${POLARIS_PORT}/api/v1/ha\"",
    "",
    "# Present this host's SSH host keys so the operator approves against",
    "# evidence, and so the reconciler can use strict host-key checking later.",
    "FPRS=''",
    "for f in /etc/ssh/ssh_host_*_key.pub; do",
    "  [[ -f \"$f\" ]] || continue",
    "  fp=$(ssh-keygen -lf \"$f\" 2>/dev/null | awk '{print $2}') || continue",
    "  [[ -n \"$fp\" ]] && FPRS=\"${FPRS:+$FPRS,}\\\"$fp\\\"\"",
    "done",
    "",
    "info \"Registering ${NODE_NAME} (${NODE_ROLE}) with ${POLARIS_HOST} via ${POLARIS_ADDR}\"",
    "REG=$(\"${CURL[@]}\" -X POST \"${BASE}/enroll\" \\",
    "        -H 'Content-Type: application/json' \\",
    "        -d \"{\\\"token\\\":\\\"${TOKEN}\\\",\\\"nodeName\\\":\\\"${NODE_NAME}\\\",\\\"sshHostKeyFingerprints\\\":[${FPRS}]}\") \\",
    "  || die 'Registration was refused. The token may be expired or already used — generate a new script.'",
    "",
    "REQ=$(printf '%s' \"$REG\" | sed -n 's/.*\"requestId\"[[:space:]]*:[[:space:]]*\"\\([^\"]*\\)\".*/\\1/p')",
    "[[ -n \"$REQ\" ]] || die \"Could not read the request id from the response: $REG\"",
    "",
    "warn 'Waiting for an operator to APPROVE this node in Server Settings -> High Availability.'",
    "warn 'This script will wait up to 30 minutes.'",
    "for i in $(seq 1 360); do",
    "  BODY=$(\"${CURL[@]}\" \"${BASE}/enroll/${REQ}\" || true)",
    "  case \"$BODY\" in",
    "    *'\"ready\":true'*)   info 'Approved.'; break ;;",
    "    *'\"rejected\"'*)     die 'An operator rejected this node.' ;;",
    "    *'\"expired\"'*)      die 'The request expired. Generate a new script.' ;;",
    "    *'\"delivered\"'*)    die 'This bundle was already downloaded. Generate a new script.' ;;",
    "  esac",
    "  [[ $i -eq 360 ]] && die 'Timed out waiting for approval.'",
    "  sleep 5",
    "done",
    "",
    "info 'Downloading the node bundle'",
    "rm -rf \"$BUNDLE_DIR\"",
    "mkdir -p \"$BUNDLE_DIR\"",
    "chmod 0700 \"$BUNDLE_DIR\"",
    "\"${CURL[@]}\" \"${BASE}/enroll/${REQ}?download=1\" -o \"$BUNDLE_DIR/bundle.tar.gz\" \\",
    "  || die 'Bundle download failed.'",
    "tar xzf \"$BUNDLE_DIR/bundle.tar.gz\" -C \"$BUNDLE_DIR\"",
    "rm -f \"$BUNDLE_DIR/bundle.tar.gz\"",
    "info \"Bundle unpacked to $BUNDLE_DIR\"",
    "",
    "cat \"$BUNDLE_DIR/INSTALL.txt\" 2>/dev/null || true",
    "",
    "if [[ -x /opt/polaris/deploy/ha/setup-rhel-ha.sh ]]; then",
    "  info 'Running the installer'",
    `  bash /opt/polaris/deploy/ha/setup-rhel-ha.sh --role ${role} --from-bundle \"$BUNDLE_DIR\"`,
    "else",
    "  warn 'This host has no Polaris checkout, so the installer is not here.'",
    "  warn 'Copy deploy/ha/ from the primary and run:'",
    `  warn \"  bash setup-rhel-ha.sh --role ${role} --from-bundle $BUNDLE_DIR\"`,
    "  warn 'The bundle directory holds private keys — delete it once installed.'",
    "fi",
    "",
  ].join("\n");

  return { filename: `polaris-ha-${role}.sh`, script };
}

/** The script that undoes the host changes. Generated, never run by Polaris. */
export async function renderTeardownScript(): Promise<NodeScript> {
  const cfg = await getHaConfig();
  const facts = cfg.hostFacts;
  const pgdata = facts?.pgdata ?? `/var/lib/pgsql/${DEFAULT_PG_MAJOR}/data`;
  // The stock unit this host will go back to. Derived from the recorded paths
  // rather than hardcoded: the major moves (15 -> 17 on 2026-09-09), and a
  // teardown script naming the wrong one leaves the operator with a database
  // that never starts and no clue why. hostFacts carries what this host
  // actually runs; the constant is only the fallback when it was never probed.
  const pgService = `postgresql-${pgMajorFromPaths(facts?.pgBinDir, facts?.pgdata) ?? DEFAULT_PG_MAJOR}`;
  const script = [
    "#!/usr/bin/env bash",
    "# Polaris HA teardown — return this host to a single-node install.",
    "#",
    "# Run as root on the node that should own the database. The database FILES",
    "# are untouched: Patroni manages a cluster, it does not convert one.",
    "#",
    "# Read docs/HA.md section 10 before running this.",
    "",
    "set -euo pipefail",
    "[[ $EUID -eq 0 ]] || { echo 'must run as root' >&2; exit 1; }",
    "",
    "read -r -p 'Type TEARDOWN to remove HA from this host: ' c",
    "[[ \"$c\" == TEARDOWN ]] || { echo 'aborted'; exit 1; }",
    "",
    "systemctl disable --now polaris-ha-role.timer 2>/dev/null || true",
    "systemctl stop patroni 2>/dev/null || true",
    "systemctl disable patroni 2>/dev/null || true",
    "systemctl stop etcd 2>/dev/null || true",
    "systemctl disable etcd 2>/dev/null || true",
    "",
    `systemctl unmask ${pgService}`,
    `systemctl enable ${pgService}`,
    "",
    `cd ${pgdata}`,
    "# Patroni renamed the original config and includes it; restore the plain file.",
    "[[ -f postgresql.base.conf ]] && mv -f postgresql.base.conf postgresql.conf",
    "[[ -f pg_hba.conf.polaris-pre-ha ]] && cp -f pg_hba.conf.polaris-pre-ha pg_hba.conf",
    "",
    "rm -f /etc/systemd/system/polaris-*.service.d/10-ha.conf",
    "rm -f /etc/polaris/ha-node",
    "systemctl daemon-reload",
    "",
    `systemctl start ${pgService}`,
    "systemctl enable --now polaris.target",
    "",
    "echo",
    "echo 'HA removed from this host. Still present, delete by hand when sure:'",
    "echo '  /etc/patroni/  /etc/polaris/etcd-ca/  /etc/polaris/ha/  /var/lib/etcd/'",
    "echo 'Also turn HA off in Server Settings -> High Availability.'",
    "",
  ].join("\n");
  return { filename: "polaris-ha-teardown.sh", script };
}
