/**
 * src/services/credentialUseAuditService.ts — business rule 112: a stored
 * credential pointed at a destination is recorded, and a BORROWED one is
 * flagged.
 *
 * Polaris lets an operator who may edit an asset (or run a Discovery, or build
 * a path check) aim any stored credential at the device or address in front of
 * them — the owner's decision is to trust that operator rather than block them.
 * The price of that trust is an audit trail: every time someone attaches a
 * credential to a destination, or moves the destination an attached credential
 * goes to, one Event is written per credential naming who did it, which
 * credential, who owns it and where it now goes.
 *
 * `credential.used` (info) is a caller using a credential they own, or any
 * credential while holding Credentials Full RW. `credential.borrowed`
 * (warning) is everyone else — the filter an administrator reads after the
 * fact. Routine monitoring polls are NOT recorded: the moment worth recording
 * is the one where a person chose the destination.
 */

import { prisma } from "../db.js";
import { logEventsBatch, type LogEventInput } from "./eventLogService.js";

export const CREDENTIAL_USED_ACTION = "credential.used";
export const CREDENTIAL_BORROWED_ACTION = "credential.borrowed";

/** What put the credential on the wire — shown in the message and stored in details.via. */
export type CredentialUseVia =
  | "asset.create"
  | "asset.update"
  | "asset.bulk-monitor"
  | "asset.snmp-walk"
  | "mib.walk"
  | "monitor-settings.override"
  | "integration.save"
  | "firmware.binding"
  | "firmware.flash"
  | "device.reboot"
  | "network-scan.save"
  | "network-scan.run"
  | "path-check.save"
  | "path-check.test";

const VIA_LABEL: Record<CredentialUseVia, string> = {
  "asset.create":              "asset create",
  "asset.update":              "asset edit",
  "asset.bulk-monitor":        "bulk monitor",
  "asset.snmp-walk":           "SNMP walk",
  "mib.walk":                  "MIB walk",
  "monitor-settings.override": "monitor settings override",
  "integration.save":          "integration save",
  "firmware.binding":          "firmware device-login binding",
  "firmware.flash":            "firmware upgrade",
  "device.reboot":             "reboot",
  "network-scan.save":         "Network Discovery save",
  "network-scan.run":          "Network Discovery run",
  "path-check.save":           "path check save",
  "path-check.test":           "path check test",
};

export interface CredentialUseActor {
  /** The caller's username (what Credential.createdBy holds), or null for a caller with none. */
  username: string | null;
  /** The display actor written on the Event (requestActor). Defaults to username. */
  actor?: string | null;
  /** Holds Credentials Full RW — may use any credential, so nothing is borrowed. */
  mayUseAny: boolean;
}

export interface CredentialUse {
  credentialId: string;
  /** Where the secret now goes: an address, a URL, a target list or a scope label. */
  destination: string;
  assetId?: string | null;
  assetName?: string | null;
}

export interface CredentialRow {
  id: string;
  name: string;
  type: string;
  createdBy: string | null;
}

/** The asset columns that hold a stored credential the monitor sends to the asset's address. */
export const ASSET_CREDENTIAL_SLOTS = [
  "monitorCredentialId",
  "responseTimeCredentialId",
  "cpuMemoryCredentialId",
  "temperatureCredentialId",
  "interfacesCredentialId",
  "lldpCredentialId",
] as const;

export type AssetCredentialSlots = {
  id: string;
  hostname: string | null;
  dnsName?: string | null;
  ipAddress: string | null;
} & Partial<Record<(typeof ASSET_CREDENTIAL_SLOTS)[number], string | null>>;

/** Where the monitor sends an asset's credentials: its address, else the name it resolves. */
export function assetCredentialDestination(a: AssetCredentialSlots): string {
  return a.ipAddress || a.dnsName || a.hostname || "(no address)";
}

/**
 * The rule 112 uses one asset write makes: every credential slot that now
 * names a credential it did not name before, and — when the address moved —
 * every credential still attached, since each one now goes somewhere new.
 * `before` is null for a create. Pure.
 */
export function assetCredentialUses(before: AssetCredentialSlots | null, after: AssetCredentialSlots): CredentialUse[] {
  const ipMoved = before !== null && !!after.ipAddress && (after.ipAddress ?? null) !== (before.ipAddress ?? null);
  const destination = assetCredentialDestination(after);
  const uses: CredentialUse[] = [];
  for (const slot of ASSET_CREDENTIAL_SLOTS) {
    const id = after[slot];
    if (!id) continue;
    if (before && before[slot] === id && !ipMoved) continue;
    uses.push({ credentialId: id, destination, assetId: after.id, assetName: after.hostname ?? after.ipAddress });
  }
  return uses;
}

/**
 * Every credential a settings object names, by the path of the key that names
 * it: any key ending in `CredentialId` / `credentialId` holding a string, at
 * any depth (an integration config binds them per device class, e.g.
 * `fortiswitchMonitor.monitorCredentialId`). Pure.
 */
export function credentialRefs(value: unknown, prefix = ""): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (v: unknown, path: string): void => {
    if (!v || typeof v !== "object") return;
    if (Array.isArray(v)) { v.forEach((x, i) => walk(x, `${path}[${i}]`)); return; }
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      const p = path ? `${path}.${k}` : k;
      if (/[cC]redentialId$/.test(k) && typeof x === "string" && x) out.set(p, x);
      else walk(x, p);
    }
  };
  walk(value, prefix);
  return out;
}

/** The references in `after` that `before` did not already hold at the same path. Pure. */
export function changedCredentialRefs(before: unknown, after: unknown): Array<{ path: string; credentialId: string }> {
  const was = credentialRefs(before);
  return [...credentialRefs(after)]
    .filter(([path, id]) => was.get(path) !== id)
    .map(([path, credentialId]) => ({ path, credentialId }));
}

/** A target list as one destination string: the first ten values, then a count. Pure. */
export function summarizeTargets(targets: unknown): string {
  const values = (Array.isArray(targets) ? targets : [])
    .map((t) => (t && typeof t === "object" ? String((t as { value?: unknown }).value ?? "") : String(t ?? "")))
    .filter(Boolean);
  if (values.length === 0) return "(no targets)";
  const head = values.slice(0, 10).join(", ");
  return values.length > 10 ? `${head} and ${values.length - 10} more` : head;
}

function scanCredentialIds(methods: unknown): string[] {
  const out = new Set<string>();
  for (const m of Array.isArray(methods) ? methods : []) {
    const ids = (m as { credentialIds?: unknown } | null)?.credentialIds;
    for (const id of Array.isArray(ids) ? ids : []) if (typeof id === "string" && id) out.add(id);
  }
  return [...out];
}

/**
 * The uses a Discovery makes. `before` null (a new Discovery) or `run` true (a
 * run, which sends every credential to every target) → all of its credentials.
 * Otherwise only the credentials it did not carry before — or all of them when
 * the targets changed, since each one now goes somewhere new. Pure.
 */
export function scanCredentialUses(
  before: { targets: unknown; methods: unknown } | null,
  after: { targets: unknown; methods: unknown },
  run = false,
): CredentialUse[] {
  const destination = summarizeTargets(after.targets);
  const ids = scanCredentialIds(after.methods);
  if (!before || run) return ids.map((credentialId) => ({ credentialId, destination }));
  const targetsMoved = summarizeTargets(before.targets) !== destination
    || JSON.stringify(before.targets ?? null) !== JSON.stringify(after.targets ?? null);
  const had = new Set(scanCredentialIds(before.methods));
  return ids.filter((id) => targetsMoved || !had.has(id)).map((credentialId) => ({ credentialId, destination }));
}

/** True when the caller is using a credential they neither own nor may use by grant. */
export function isBorrowed(actor: CredentialUseActor, createdBy: string | null): boolean {
  if (actor.mayUseAny) return false;
  return !(createdBy !== null && actor.username !== null && createdBy === actor.username);
}

/** The Event rows for a set of uses. Pure: the caller supplies the credential rows. Unknown ids are skipped. */
export function buildCredentialUseEvents(
  actor: CredentialUseActor,
  via: CredentialUseVia,
  uses: readonly CredentialUse[],
  credentials: readonly CredentialRow[],
): LogEventInput[] {
  const byId = new Map(credentials.map((c) => [c.id, c]));
  const seen = new Set<string>();
  const who = actor.actor ?? actor.username ?? "unknown";
  const out: LogEventInput[] = [];
  for (const u of uses) {
    const cred = byId.get(u.credentialId);
    if (!cred) continue;
    const key = `${cred.id}\u0000${u.destination}\u0000${u.assetId ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const borrowed = isBorrowed(actor, cred.createdBy);
    const owner = cred.createdBy ?? "no recorded owner";
    const on = u.assetName ? ` (asset ${u.assetName})` : "";
    out.push({
      action: borrowed ? CREDENTIAL_BORROWED_ACTION : CREDENTIAL_USED_ACTION,
      level: borrowed ? "warning" : "info",
      resourceType: "credential",
      resourceId: cred.id,
      resourceName: cred.name,
      actor: who,
      assetId: u.assetId ?? null,
      message: borrowed
        ? `${who} used credential "${cred.name}" (owned by ${owner}) against ${u.destination}${on} — ${VIA_LABEL[via]}`
        : `${who} used credential "${cred.name}" against ${u.destination}${on} — ${VIA_LABEL[via]}`,
      details: {
        via,
        credentialId: cred.id,
        credentialType: cred.type,
        credentialOwner: cred.createdBy,
        borrowed,
        destination: u.destination,
        ...(u.assetId ? { assetId: u.assetId } : {}),
      },
    });
  }
  return out;
}

/**
 * Record the uses: one credential lookup for the whole set, one batched write.
 * Never throws (logEventsBatch swallows a write failure, and a lookup failure
 * is caught here) — an audit write must not fail the request it describes.
 * Returns the number of rows written.
 */
export async function recordCredentialUse(
  actor: CredentialUseActor,
  via: CredentialUseVia,
  uses: readonly CredentialUse[],
): Promise<number> {
  const ids = [...new Set(uses.map((u) => u.credentialId).filter((id): id is string => typeof id === "string" && id.length > 0))];
  if (ids.length === 0) return 0;
  try {
    const credentials = await prisma.credential.findMany({
      where: { id: { in: ids } },
      select: { id: true, name: true, type: true, createdBy: true },
    });
    return await logEventsBatch(buildCredentialUseEvents(actor, via, uses, credentials));
  } catch {
    return 0;
  }
}
