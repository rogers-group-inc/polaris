/**
 * src/services/monitoring/systemInfoPersist.ts — recordSystemInfoResult and its per-stream persisters (CQ-B061, moved verbatim
 * from monitoringService.ts): interfaces, storage, sensors, physical entities, SD-WAN,
 * and the rest of a system-info pass written back to the database.
 */

import { randomUUID } from "node:crypto";
import { prisma } from "../../db.js";
import { retryOnDeadlock } from "../../utils/dbRetry.js";
import { diffInventory, normalizeBytes, normalizeCpuPct, sameInventoryRow } from "../../utils/inventoryDelta.js";
import { splitInterfaceAddresses } from "../../utils/interfaceAddress.js";
import { ipv6Enabled } from "../ipv6GateService.js";
import { reconcileInterfaceMacs } from "../macAddressService.js";
import { persistInterfaces, loadInterfaceIdentity, repairInterfacePins } from "../interfaceInventoryService.js";
import { buildInterfaceIdentity, canonicalizeInterfaceRows } from "../../utils/interfaceIdentity.js";
import { type FortiswitchMclagPeer } from "../../utils/fortiswitchCmdb.js";
import { logEvent, buildFirmwareChangedEvent } from "../eventLogService.js";
import { projectAssetFromSources } from "../../utils/assetProjection.js";
import { lookupOuiOverride } from "../ouiService.js";
import { reconcileSnmpSelfIdentity } from "../snmpSelfIdentityService.js";
import { persistFibreChannel } from "../fibreChannelService.js";
import { resolveAssetTypeCached } from "../../utils/assetTypeMatch.js";
import { sameDescrObserved, type SysDescrDetail } from "../../utils/snmpDescrIdentity.js";
import { maybeEmitChangeEvents, type ChangeItem } from "../notificationChangeEvents.js";
import { isChangeActionSubscribed } from "../notificationRuleService.js";
import { logger } from "../../utils/logger.js";
import { persistApRadioInventory } from "../apRadioService.js";
import { startSampleWriteTimer } from "../../metrics.js";
import { enqueueInterfaceSamples, enqueueStorageSamples, enqueueIpsecTunnelSamples, enqueuePerfSlaSamples, type InterfaceSampleRow } from "../sampleWriteBuffer.js";
import { recordInterfaceLinkEvents } from "../interfaceLinkEventService.js";
import { persistAssetArpNeighbors } from "../arpTableService.js";
import { type IpsecTunnelSample } from "../../utils/fortiosIpsec.js";
import { persistIpsecConnections } from "../ipsecConnectionService.js";
import { recordIpHistoryEntries } from "../assetIpHistoryService.js";
import { DISCOVERED_ADDRESS_SOURCES } from "../assetAddressService.js";
import { type InterfaceSample, type StorageSample, type PerfSlaSample, type SdwanRuleSample, type SystemInfoSample, type CollectionResult } from "./types.js";
import { startPhase } from "./common.js";
import { type InterfaceAddressSource, buildMonitorAssocIpEntries } from "./lldpMatchIndex.js";
import { persistPhysicalEntities, persistTrunkMembers, persistMacTable } from "./snmpCollectors.js";
import { persistLldpNeighbors, persistWirelessStations } from "./neighborPersistence.js";
import { pollFailureText, systemInfoSuccessStamps, recordStreamFailure } from "./pollStamps.js";

// ─── recordSystemInfoResult stream persisters (split 2026-08 — the contract
// tests in tests/integration/recordSystemInfoContract.test.ts pin each
// stream's behavior: pin-aware cadence stamps, the MAC fold's source scoping,
// the assoc-IP full-replace, LLDP stickiness interplay, detected-model
// adoption, and the lastSystemInfoAt empty-interfaces guard). Each helper
// owns exactly one stream family; the orchestrator below reads as the list
// of streams a system-info scrape can carry.

/** The per-asset pins + identity bits the persisters need. One indexed PK read per scrape. */
type SystemInfoPins = {
  monitoredInterfaces: string[];
  monitoredStorage: string[];
  monitoredIpsecTunnels: string[];
  ipAddress: string | null;
  model: string | null;
  hostname: string | null;
  manufacturer: string | null;
  osVersion: string | null;
  os: string | null;
  /** For the OUI-override guard in adoptSysDescrIdentity. */
  macAddress: string | null;
  /** For the device-type inference gate — only `other` may be re-typed. */
  assetType: string;
  productType: string | null;
  /** The sysDescr serial (business rule 161) is compared against this. */
  serialNumber: string | null;
} | null;

/**
 * Interface samples (pin-aware cadence) + the Associated-MACs range fold.
 * Selection-aware cadence: the full scrape covers every entity, so stamp
 * each row "fast" when its entity is operator-pinned (kept at full retention
 * + rolled up) and "slow" otherwise (kept 24h, never rolled up).
 */
async function persistInterfaceSampleStream(
  assetId: string,
  interfaces: InterfaceSample[],
  pinned: SystemInfoPins,
  now: Date,
): Promise<void> {
  if (interfaces.length === 0) return;
  const pinnedIfaces = new Set(pinned?.monitoredInterfaces ?? []);
  // TIME-SERIES rows are written for PINNED interfaces only. Current state for
  // every interface (pinned or not) is persisted separately by
  // `persistInterfaces` into `asset_interfaces` — see the AssetInterface model.
  //
  // Unpinned interfaces used to be written here as cadence="slow" and deleted
  // 24h later. That was ~4-5x the pinned write volume for rows nothing read as
  // history: they were never compressed (deleted at 24h while the
  // selection-aware compression floor is 2 days, so they lived their whole life
  // in uncompressed heap), never rolled up, and removed by the row-level DELETE
  // behind the 2026-06-08 / 2026-06-17 compressed-chunk bloat incidents. Every
  // consumer that needed them wanted *current state*, which now has its own
  // table.
  //
  // The `cadence` column stays: storage and ipsec still use the fast/slow
  // split, the rollup + prune paths are shared, and legacy slow rows age out
  // through the existing 24h prune rather than needing a migration.
  const pinnedOnly = interfaces.filter((i) => pinnedIfaces.has(i.ifName));
  const pinnedRows: InterfaceSampleRow[] = pinnedOnly.map((i) => {
    // Business rule 126 — the same normalisation interfaceInventoryService
    // applies to the current-state row, so the two cannot disagree.
    const addr = splitInterfaceAddresses(i.ipAddress, i.ipv6Address, ipv6Enabled());
    return {
    assetId,
    timestamp: now,
    cadence:     "fast" as const,
    ifName:      i.ifName,
    adminStatus: i.adminStatus ?? null,
    operStatus:  i.operStatus ?? null,
    speedBps:    i.speedBps != null ? BigInt(Math.round(i.speedBps)) : null,
    duplex:      i.duplex ?? null,
    ipAddress:   addr.ipAddress,
    ipv6Address: addr.ipv6Address,
    macAddress:  i.macAddress ?? null,
    inOctets:    i.inOctets  != null ? BigInt(Math.round(i.inOctets))  : null,
    outOctets:   i.outOctets != null ? BigInt(Math.round(i.outOctets)) : null,
    inErrors:    i.inErrors  != null ? BigInt(Math.round(i.inErrors))  : null,
    outErrors:   i.outErrors != null ? BigInt(Math.round(i.outErrors)) : null,
    ifType:      i.ifType   ?? null,
    ifParent:    i.ifParent ?? null,
    vlanId:      i.vlanId   ?? null,
    nativeVlan:  i.nativeVlan ?? null,
    taggedVlans: i.taggedVlans ?? [],
    trunksAllVlans: i.trunksAllVlans === true,
    alias:       i.alias       ?? null,
    description: i.description ?? null,
    addressingMode: i.addressingMode ?? null,
    poeStatus:   i.poeStatus ?? null,
    poeClass:    i.poeClass  ?? null,
    // FC counters (rule 159a) — omitted, not null, on every other port.
    ...(i.fcErrors ? { fcErrors: i.fcErrors } : {}),
    };
  });
  if (pinnedRows.length > 0) {
    enqueueInterfaceSamples(pinnedRows);
    void recordInterfaceLinkEvents(pinnedRows);
  }
  // Fold EVERY scraped interface MAC (monitored or not) into the asset's
  // Associated MACs list (AssetMacAddress), coalescing contiguous MACs
  // into range rows so a 48-port switch costs one row instead of 48.
  // Source-scoped full-replace over source="monitor-interface" only —
  // rows owned by discovery/agent/manual writers are never touched.
  const ifaceMacs = interfaces
    .map((i) => i.macAddress)
    .filter((m): m is string => !!m);
  if (ifaceMacs.length > 0) {
    const stopMacWrite = startSampleWriteTimer("asset_mac_addresses");
    const endMac = startPhase("systeminfo.persist.iface_macs");
    await reconcileInterfaceMacs(assetId, ifaceMacs, now);
    endMac({ macs: ifaceMacs.length });
    stopMacWrite();
  }
}

function persistStorageSampleStream(
  assetId: string,
  storage: StorageSample[],
  pinned: SystemInfoPins,
  now: Date,
): void {
  if (storage.length === 0) return;
  const pinnedStorage = new Set(pinned?.monitoredStorage ?? []);
  enqueueStorageSamples(
    storage.map((s) => ({
      assetId,
      timestamp: now,
      cadence:    pinnedStorage.has(s.mountPath) ? ("fast" as const) : ("slow" as const),
      mountPath:  s.mountPath,
      totalBytes: s.totalBytes != null ? BigInt(Math.round(s.totalBytes)) : null,
      usedBytes:  s.usedBytes  != null ? BigInt(Math.round(s.usedBytes))  : null,
    })),
  );
}

function persistIpsecTunnelSampleStream(
  assetId: string,
  tunnels: IpsecTunnelSample[] | undefined,
  pinned: SystemInfoPins,
  now: Date,
): void {
  if (!Array.isArray(tunnels) || tunnels.length === 0) return;
  const pinnedTunnels = new Set(pinned?.monitoredIpsecTunnels ?? []);
  enqueueIpsecTunnelSamples(
    tunnels.map((t) => ({
      assetId,
      timestamp: now,
      cadence:         pinnedTunnels.has(t.tunnelName) ? ("fast" as const) : ("slow" as const),
      tunnelName:      t.tunnelName,
      parentInterface: t.parentInterface,
      remoteGateway:   t.remoteGateway,
      status:          t.status,
      incomingBytes:   t.incomingBytes != null ? BigInt(Math.round(t.incomingBytes)) : null,
      outgoingBytes:   t.outgoingBytes != null ? BigInt(Math.round(t.outgoingBytes)) : null,
      proxyIdCount:    t.proxyIdCount,
    })),
  );
}

/**
 * SD-WAN SLA time-series (gated by Integration.config.pullSdwan, only present
 * when collectSdwanFortinet ran on this SD-WAN pass). No pinned-subset concept
 * — every row is stamped "fast" so the rollup (which filters cadence='fast')
 * includes it and prune treats them all uniformly.
 */
export function persistPerfSlaSampleStream(
  assetId: string,
  perfSla: PerfSlaSample[] | undefined,
  now: Date,
): void {
  if (!Array.isArray(perfSla) || perfSla.length === 0) return;
  enqueuePerfSlaSamples(
    perfSla.map((p) => ({
      assetId,
      timestamp:   now,
      cadence:     "fast" as const,
      healthCheck: p.healthCheck,
      link:        p.link,
      zone:        p.zone,
      state:       p.state,
      latencyMs:   p.latencyMs,
      jitterMs:    p.jitterMs,
      packetLoss:  p.packetLoss,
      latencyThresholdMs:  p.latencyThresholdMs,
      jitterThresholdMs:   p.jitterThresholdMs,
      packetLossThreshold: p.packetLossThreshold,
    })),
  );
}

/**
 * Mirror per-interface IPs+MACs into the asset_associated_ips side table.
 * Replaces the legacy JSONB read-modify-write pattern. Discovery no longer
 * populates interface IPs, so the System tab is the single source for them
 * once monitoring is on. Manual entries (source = "manual") are preserved by
 * deleting only the non-manual rows before re-inserting the fresh monitor
 * set. Skipped entirely when the scrape returned no interface IPs (better to
 * keep the previous list than wipe it on a transient empty result). Also
 * folds the scraped IPs into IP History (fire-and-forget).
 */
async function persistAssocIpMirror(
  assetId: string,
  interfaces: InterfaceSample[],
  pinned: { ipAddress: string | null } | null,
  now: Date,
  source: InterfaceAddressSource = "monitor-system-info",
): Promise<void> {
  const monitorAssocEntries = buildMonitorAssocIpEntries(interfaces, now, source);
  if (monitorAssocEntries.length === 0) return;
  const stopWrite = startSampleWriteTimer("asset_associated_ips");
  const endAssoc = startPhase("systeminfo.persist.assoc_ips_txn");
  // One $transaction so the delete + insert pair is atomic — a concurrent
  // reader will either see the old set or the new set, never an empty
  // intermediate. retryOnDeadlock: a concurrent system-info / probe-patch
  // writer can win a deadlock against this delete+insert pair (40P01). The
  // op is idempotent (full-replace of the asset's non-manual IPs), so re-run
  // on deadlock instead of crashing the whole system-info scrape.
  // Discovery's rows (business rule 102, services/assetAddressService) are not
  // this scrape's to delete — they are current-state per gate and pruned by
  // their own writer. The scrape takes over an IP both report (the device's
  // own interface table names it better), and leaves the rest alone.
  const scrapedIps = monitorAssocEntries.map((e) => e.ip);
  await retryOnDeadlock(() =>
    prisma.$transaction([
      prisma.assetAssociatedIp.deleteMany({
        where: {
          assetId,
          OR: [
            { source: { notIn: ["manual", ...DISCOVERED_ADDRESS_SOURCES] } },
            { source: { in: [...DISCOVERED_ADDRESS_SOURCES] }, ip: { in: scrapedIps } },
          ],
        },
      }),
      prisma.assetAssociatedIp.createMany({
        data: monitorAssocEntries.map((e) => ({ ...e, assetId })),
        skipDuplicates: true,
      }),
    ]),
  );
  endAssoc({ rows: monitorAssocEntries.length });
  stopWrite();
  // Fold the asset's interface IPs into IP History so the timeline captures
  // every IP the device holds — including public WAN / secondary addresses,
  // which never become the primary `ipAddress` and so were previously absent
  // from the history. The primary IP is already recorded by the db.ts Prisma
  // extension; recordIpHistoryEntries skips it to avoid firstSeen churn on
  // the shared management address. Fire-and-forget — best-effort, never
  // blocks or fails the scrape.
  void recordIpHistoryEntries(
    assetId,
    monitorAssocEntries.map((e) => ({ ip: e.ip, source: e.source })),
    pinned?.ipAddress ?? null,
  );
}

/**
 * The agent's interface push, mirrored into the address list the same way
 * recordSystemInfoResult mirrors a scrape (one replace, manual and discovered
 * rows kept, empty push skipped). For an agent-monitored host this push IS
 * the interface table.
 */
export async function persistAgentAddressRows(
  assetId: string,
  interfaces: ReadonlyArray<Pick<InterfaceSample, "ifName" | "ipAddress" | "ipv6Address" | "macAddress">>,
  now: Date,
): Promise<void> {
  const asset = await prisma.asset.findUnique({ where: { id: assetId }, select: { ipAddress: true } });
  await persistAssocIpMirror(assetId, interfaces as InterfaceSample[], { ipAddress: asset?.ipAddress ?? null }, now, "agent-interface");
}

/**
 * Detected hardware model (FortiSwitch fsSysVersion parse). Adopt onto
 * Asset.model only while the stored model is empty or still generic —
 * discovery stamps the literal "FortiSwitch" (the managed-switch CMDB has
 * no model field) and the projection deliberately skips the fortiswitch
 * source's model, so this write can't be clobbered by the next discovery
 * cycle. A previously-detected "FortiSwitch <token>" stays overwritable
 * (self-heals on a hardware swap behind the same IP); anything else is
 * operator-typed and never touched. Edge-triggered: writes + logs only
 * when the value actually changes.
 */
async function adoptDetectedModel(
  assetId: string,
  detectedModel: string | null | undefined,
  pinned: SystemInfoPins,
): Promise<void> {
  if (typeof detectedModel !== "string" || !detectedModel || !pinned) return;
  const currentModel = (pinned.model ?? "").trim();
  const overwritable = !currentModel || /^fortiswitch\b/i.test(currentModel);
  if (!overwritable || currentModel === detectedModel) return;
  await prisma.asset.update({ where: { id: assetId }, data: { model: detectedModel } });
  logEvent({
    action: "asset.model_detected",
    resourceType: "asset",
    resourceId: assetId,
    resourceName: pinned.hostname || undefined,
    level: "info",
    message: `Model detected via SNMP: ${pinned.hostname || assetId} "${currentModel || "(none)"}" → "${detectedModel}"`,
    // Any profile's Model identity row lands here now, not only FortiSwitch's.
    details: { previousModel: currentModel || null, model: detectedModel, source: "snmp:model-profile" },
  });
}

/**
 * Adopt what the device's own sysDescr format stated (model / firmware /
 * manufacturer), for the vendors whose layout `utils/snmpDescrIdentity.ts`
 * can read. Which fields may move, and why each differs, is the pure
 * `decideDescrAdoption` — this is only the I/O around it.
 *
 * Two guards live here rather than in the decision, because both are facts
 * about the row rather than about the reading:
 *
 *  - **Only an asset no discovery source claims.** These three columns are
 *    PROJECTED from `AssetSource` rows for anything a controller, directory,
 *    vCenter or agent knows about (`utils/assetProjection.ts`), and `manual`
 *    appears in none of those ladders — so writing here is safe exactly while
 *    `manual` is all there is, and would otherwise be a write the next
 *    projection silently reverts. That population IS the one this exists for:
 *    equipment belonging to no controller and no directory (business rule 34).
 *  - **The Event comes from the existing builder.** `computeFirmwareChange`
 *    already rules that a first learn is not an upgrade, so a camera whose
 *    firmware Polaris never knew fills the field silently and only a real move
 *    writes `asset.firmware.changed` — the same event discovery emits, which
 *    is what the firmware_changed automation trigger watches.
 *
 * Edge-triggered by construction: `decideDescrAdoption` returns null when
 * nothing should move, so an unchanged device costs one comparison and no
 * query at all.
 */
async function adoptSysDescrIdentity(
  assetId: string,
  d: SystemInfoSample,
  pinned: SystemInfoPins,
): Promise<void> {
  if (!pinned || !d.descrIdentity) return;
  await applyDescrIdentity(assetId, d.descrIdentity, d.sysDescr ?? null, pinned, d.sysObjectId ?? null);
}

/**
 * Reconcile one parsed sysDescr reading onto an asset.
 *
 * Shared by the two readers, which see the same device on different
 * schedules: the SNMP **system-info pass** (which reads sysDescr anyway, but
 * only runs when an interfaces / LLDP / storage stream is enabled AND the
 * asset reads `up`), and the SNMP **response-time probe** (which reaches
 * every SNMP-polled asset on its own 10-minute anchor, including one that is
 * flapping and therefore never gets a heavy pass). Whichever runs first
 * stamps `Asset.lastDescrAt` and satisfies the other.
 */
export async function applyDescrIdentity(
  assetId: string,
  detail: SysDescrDetail,
  sysDescr: string | null,
  pinned: NonNullable<SystemInfoPins>,
  sysObjectId: string | null = null,
): Promise<void> {

  // What the device said about itself, in the shape the projection reads.
  const observed = {
    manufacturer: detail.manufacturer ?? null,
    model: detail.model ?? null,
    osVersion: detail.osVersion ?? null,
    productType: detail.productType ?? null,
    // Only ever set where the device is its own card (business rule 161).
    serialNumber: detail.serialNumber ?? null,
    // The product registration that decided whether model / serial were
    // claimed — kept so the Sources tab can show why a UPS has none.
    sysObjectId,
    // The whole reading, verbatim, as the record of what the device said —
    // read by the Sources tab and by nothing that decides anything. It is
    // deliberately NOT offered to the `os` projection: that column is
    // rendered as "OS / Firmware" beside osVersion, so contributing the raw
    // descr printed the entire semicolon-delimited string where "8.40.3"
    // belonged.
    sysDescr,
  };

  // Steady state costs ONE indexed read and nothing else. The gate is "did
  // the device's answer change since we last recorded it?" — deliberately
  // NOT "does it disagree with the Asset row", which never converges for a
  // device whose identity a higher-priority source legitimately owns: that
  // comparison differs on every pass forever, re-writing and re-projecting
  // to reach the same answer. Comparing against our own last recording is
  // stable whoever wins the projection.
  const existing = await prisma.assetSource.findUnique({
    where: { sourceKind_externalId: { sourceKind: "snmp-sysdescr", externalId: assetId } },
    select: { observed: true },
  });
  if (existing && sameDescrObserved(existing.observed as Record<string, unknown> | null, observed)) {
    return;
  }

  const now = new Date();
  await prisma.assetSource.upsert({
    where: { sourceKind_externalId: { sourceKind: "snmp-sysdescr", externalId: assetId } },
    // externalId is the assetId — the convention `manual` rows already use.
    // This source has no identifier of its own to key on, being the device's
    // own voice rather than a record in someone else's inventory.
    create: {
      assetId,
      sourceKind: "snmp-sysdescr",
      externalId: assetId,
      observed,
      syncedAt: now,
      lastSeen: now,
    },
    update: { assetId, observed, syncedAt: now, lastSeen: now },
  });

  // Whether the device's word WINS is the priority list's call, not this
  // function's — which is the whole reason this routes through an AssetSource
  // instead of writing the columns. A gate that fingerprinted the device as
  // "ip camera" loses to the device's own "M2036-LE"; an in-guest agent or
  // Arc reading real SMBIOS does not.
  const sources = await prisma.assetSource.findMany({
    where: { assetId },
    select: { sourceKind: true, inferred: true, observed: true, lastSeen: true },
  });
  const { projected } = projectAssetFromSources(
    sources.map((r) => ({
      sourceKind: r.sourceKind,
      inferred: r.inferred,
      observed: r.observed as Record<string, unknown> | null,
      lastSeen: r.lastSeen,
    })),
  );

  // ONLY the identity fields this source can speak to. Applying the
  // whole projection here would make the monitor path a general projection
  // writer — rewriting hostname, IP and learnedLocation from other sources on
  // a cadence that has nothing to do with them.
  const diff: Record<string, string | null> = {};
  for (const f of ["manufacturer", "model", "os", "osVersion", "productType", "serialNumber"] as const) {
    const next = projected[f];
    if (next !== null && next !== pinned[f]) diff[f] = next;
  }

  // One-way cleanup, provenance-bounded: earlier versions of this path (and
  // Discovery adoption) stamped the RAW sysDescr into `os`, which the asset
  // page prints beside osVersion as "OS / Firmware". Clear it where the stored
  // value IS the string this device is telling us right now — never a value
  // some other source contributed, and never a guess at what the OS is called.
  // Projection cannot do this: it only ever writes non-null, so a column
  // nobody states any more keeps its last value forever.
  if (sysDescr && (pinned.os ?? "").trim() === sysDescr.trim() && diff.os === undefined) {
    diff.os = null;
  }

  // An operator's OUI override is an explicit statement about the VENDOR, and
  // discovery Phase 9a writes it straight onto the Asset rather than through a
  // source row — so the projection cannot see it, and the two would trade
  // writes every cycle, each auditing an identity "change" that is really two
  // writers disagreeing. The operator's statement wins; the device still
  // supplies model, firmware and self-description. Costs an in-memory map
  // lookup, and only when there is a vendor diff to suppress.
  if (diff.manufacturer && pinned.macAddress) {
    const override = await lookupOuiOverride(pinned.macAddress);
    if (override) delete diff.manufacturer;
  }

  if (Object.keys(diff).length === 0) return;
  await prisma.asset.update({ where: { id: assetId }, data: diff });

  // A device that just told us what it is can be TYPED from that, through the
  // operator's own rules in the registry rather than a predicate in here.
  //
  // Three deliberate bounds. It runs in the **scan** context, not a context of
  // its own: an SNMP read on the monitor path is the same KIND of evidence a
  // Network Discovery collects — we asked the device directly — so a rule an
  // operator wrote for scans applies here without being written twice, and
  // this is the only reader that reaches a camera already in inventory (the
  // scan context otherwise fires once, at adoption). It is **`other`-only**,
  // the eligibility the registry's own retroactive Apply uses, so a type an
  // authoritative source or an operator set is never overwritten. And the
  // facts include the raw sysDescr as `os` even though the column no longer
  // stores it, because a rule written against the whole self-description has
  // to keep matching what it matched before productType existed.
  if (pinned.assetType === "other") {
    const nextType = resolveAssetTypeCached(
      {
        os: sysDescr,
        hostname: pinned.hostname,
        manufacturer: diff.manufacturer ?? pinned.manufacturer,
        model: diff.model ?? pinned.model,
        productType: diff.productType ?? pinned.productType,
      },
      "scan",
    );
    if (nextType && nextType !== "other") {
      // Re-assert `other` in the WHERE, not just in the read: discovery or an
      // operator may have typed this row in the time it took to get here.
      const typed = await prisma.asset.updateMany({
        where: { id: assetId, assetType: "other" },
        data: { assetType: nextType },
      });
      if (typed.count > 0) {
        logEvent({
          action: "asset.type_inferred",
          resourceType: "asset",
          resourceId: assetId,
          resourceName: pinned.hostname || undefined,
          level: "info",
          message:
            `Device type inferred as "${nextType}" from what the device reports` +
            `${detail.productType ? ` ("${detail.productType}")` : ""}`,
          details: {
            source: "snmp:sysDescr",
            assetType: nextType,
            productType: detail.productType ?? null,
            model: detail.model ?? null,
          },
        });
      }
    }
  }

  const ev = buildFirmwareChangedEvent(
    { assetId, assetName: pinned.hostname, actor: "system:monitor", source: "snmp-sysdescr" },
    { osVersion: pinned.osVersion },
    // Only osVersion is offered to the differ: `os` here is the whole
    // sysDescr, in which the firmware is one token, so reporting both would
    // state the same upgrade twice in one sentence.
    { osVersion: diff.osVersion ?? pinned.osVersion },
  );
  if (ev) logEvent(ev);

  // Hardware identity MOVING is its own finding, and a different one from
  // firmware: a model that changes behind a fixed address means the device was
  // replaced, and a manufacturer that changes usually means Polaris had it
  // wrong (every camera adopted before the enterprise-arc-368 fix says
  // "ServerTech"). Audited on a MOVE only — a first learn fills the column
  // silently, the same rule `computeFirmwareChange` applies to firmware, or
  // the first pass over a camera fleet would write one row per device saying
  // nothing changed. Reuses `asset.model_detected`, the action
  // `adoptDetectedModel` already writes, so no new event vocabulary appears.
  const moved: string[] = [];
  if (diff.model && (pinned.model ?? "").trim()) {
    moved.push(`model "${pinned.model}" → "${diff.model}"`);
  }
  if (diff.manufacturer && (pinned.manufacturer ?? "").trim()) {
    moved.push(`manufacturer "${pinned.manufacturer}" → "${diff.manufacturer}"`);
  }
  if (diff.serialNumber && (pinned.serialNumber ?? "").trim()) {
    moved.push(`serial "${pinned.serialNumber}" → "${diff.serialNumber}"`);
  }
  if (moved.length) {
    logEvent({
      action: "asset.model_detected",
      resourceType: "asset",
      resourceId: assetId,
      resourceName: pinned.hostname || undefined,
      level: "info",
      message: `Identity restated by the device: ${pinned.hostname || assetId} ${moved.join("; ")}`,
      details: {
        source: "snmp:sysDescr",
        previousModel: pinned.model || null,
        model: diff.model ?? pinned.model ?? null,
        previousManufacturer: pinned.manufacturer || null,
        manufacturer: diff.manufacturer ?? pinned.manufacturer ?? null,
      },
    });
  }
}

export async function recordSystemInfoResult(assetId: string, result: CollectionResult<SystemInfoSample>): Promise<void> {
  if (!result.supported) return;
  const now = new Date();
  if (!result.data) {
    await recordStreamFailure("systemInfo", assetId, now, pollFailureText(result.error, "The device returned no interface data"));
    return;
  }
  const d = result.data;
  // One indexed PK read per scrape on the slow (~10 min) cadence — the pins
  // drive the fast/slow cadence stamps, the identity bits feed the assoc-IP
  // history fold and the model adoption.
  const pinned: SystemInfoPins = await prisma.asset.findUnique({
    where: { id: assetId },
    select: { monitoredInterfaces: true, monitoredStorage: true, monitoredIpsecTunnels: true, ipAddress: true, ipv6Address: true, model: true, hostname: true, manufacturer: true, osVersion: true, os: true, macAddress: true, assetType: true, productType: true, serialNumber: true },
  });

  // Reconcile the collected names against the identity of record BEFORE
  // anything keys on them. A scrape whose `ifName` walk failed names every
  // port by its `ifDescr` — the operator's DESCRIPTION on a FortiSwitch — and
  // that name would otherwise land in the inventory, the pin list and every
  // alert dimension as if it were a port (prod 2026-08-25; see
  // utils/interfaceIdentity.ts).
  if (d.interfaces.length > 0) {
    const identity = await loadInterfaceIdentity(assetId);
    const canon = canonicalizeInterfaceRows(d.interfaces, identity);
    if (canon.renamed.length > 0 || canon.dropped > 0) {
      logger.warn(
        { assetId, ports: canon.renamed.slice(0, 5).map((r) => r.to), renamedCount: canon.renamed.length, dropped: canon.dropped },
        "interface scrape named ports by their description — mapped back to the port name",
      );
      d.interfaces = canon.rows;
    }
  }

  await persistInterfaceSampleStream(assetId, d.interfaces, pinned, now);
  // CURRENT-STATE interface inventory. Written from the FULL pass only — never
  // from recordFastFilteredResult, which sees just the pinned subset and would
  // wipe every unpinned interface's row on each probe tick.
  //
  // Skipped on an empty array for the same reason lastSystemInfoAt is: an empty
  // interface list means "this pull returned nothing useful" at least as often
  // as it means "this device has no interfaces" (a FortiOS token without
  // monitor scope answers 200 OK with empty results), and blanking the System
  // tab while the device is online is the worse failure.
  if (d.interfaces.length > 0) {
    const stopIfWrite = startSampleWriteTimer("asset_interfaces");
    const endIfaces = startPhase("systeminfo.persist.interfaces");
    await persistInterfaces(assetId, d.interfaces, now);
    endIfaces({ interfaces: d.interfaces.length });
    stopIfWrite();
    // Pins are reconciled against the inventory just written, not the one the
    // canonicalization above read: a pin created while a scrape was naming
    // ports by description ("MORGAN-221E-1") names a port that does not
    // exist, and only the fresh rows can say which port it described. Cheap
    // and edge-triggered — no write unless a pin actually moves.
    await repairInterfacePins(
      assetId,
      buildInterfaceIdentity(d.interfaces),
      pinned?.monitoredInterfaces,
      pinned?.hostname,
    );
  }
  persistStorageSampleStream(assetId, d.storage, pinned, now);
  persistIpsecTunnelSampleStream(assetId, d.ipsecTunnels, pinned, now);
  // Who is connected through the gate's IPsec / SSL-VPN (the IPsec tab).
  // CURRENT-STATE, full pass only — recordFastFilteredResult never sees
  // these. Each half is replaced only when its own read answered (see
  // SystemInfoSample.ipsecConnections), so an SSL-VPN read the token can't
  // make does not wipe the IPsec peers or vice versa.
  if (Array.isArray(d.ipsecConnections) || Array.isArray(d.sslVpnSessions)) {
    const stopWrite = startSampleWriteTimer("asset_ipsec_connections");
    const endConn = startPhase("systeminfo.persist.ipsec_connections");
    const written = await persistIpsecConnections(assetId, { ipsec: d.ipsecConnections, sslVpn: d.sslVpnSessions }, now);
    endConn({ connections: written });
    stopWrite();
  }
  // SD-WAN SLA samples + rules are written by runSdwanFor on their own cadence.

  await persistAssocIpMirror(assetId, d.interfaces, pinned, now);

  // LLDP neighbors. `undefined` = the collector didn't run / unsupported
  // transport, so leave the existing rows alone. An array = queried
  // successfully → persistLldpNeighbors reconciles it (with the 48h sticky
  // window, so one empty scrape doesn't flap a live neighbor off).
  if (Array.isArray(d.lldpNeighbors)) {
    const stopWrite = startSampleWriteTimer("asset_lldp_neighbors");
    const endLldp = startPhase("systeminfo.persist.lldp");
    await persistLldpNeighbors(assetId, d.lldpNeighbors, now, d.lldpSource ?? "fortios");
    endLldp({ neighbors: d.lldpNeighbors.length });
    stopWrite();
  }
  // Hardware inventory. Same undefined/[] contract as LLDP: undefined means
  // the transport can't supply it (FortiOS REST, agent) and stored rows stay;
  // [] means the device was walked and has no FRUs to report, which wipes.
  if (Array.isArray(d.physicalEntities)) {
    const stopWrite = startSampleWriteTimer("asset_physical_entities");
    const endEnt = startPhase("systeminfo.persist.physical_entities");
    await persistPhysicalEntities(assetId, d.physicalEntities);
    endEnt({ entities: d.physicalEntities.length });
    stopWrite();
  }
  // Fibre-channel ports and logins (business rule 159). Same undefined /
  // walked contract: undefined = not an FC switch, nothing written.
  if (d.fibreChannel) {
    const endFc = startPhase("systeminfo.persist.fibre_channel");
    await persistFibreChannel(assetId, d.fibreChannel, now);
    endFc({ ports: d.fibreChannel.ports.length, logins: d.fibreChannel.logins.length });
  }
  // Forwarding database. Same undefined/[] contract again.
  if (Array.isArray(d.macTable)) {
    const stopWrite = startSampleWriteTimer("asset_mac_table_entries");
    const endMac = startPhase("systeminfo.persist.mac_table");
    await persistMacTable(assetId, d.macTable);
    endMac({ entries: d.macTable.length });
    stopWrite();
  }
  // IP neighbour cache. NOT the undefined/[] contract the tables above use:
  // this one ACCUMULATES, so there is nothing to wipe and an empty array is
  // simply nothing to record. Matching is left to the discovery writer's warm
  // index -- resolving MACs here would mean a fleet-wide asset read on the
  // system-info hot path, and COALESCE in the upsert keeps a match already
  // resolved by discovery rather than clearing it.
  if (Array.isArray(d.arpNeighbors) && d.arpNeighbors.length > 0) {
    const stopWrite = startSampleWriteTimer("asset_arp_entries");
    const endArp = startPhase("systeminfo.persist.arp_neighbors");
    const { written } = await persistAssetArpNeighbors(assetId, d.arpNeighbors);
    endArp({ entries: written });
    stopWrite();
  }
  // Trunk membership. Same undefined/[] contract.
  if (Array.isArray(d.trunkMembers)) {
    const stopWrite = startSampleWriteTimer("asset_trunk_members");
    const endTrunk = startPhase("systeminfo.persist.trunk_members");
    await persistTrunkMembers(assetId, d.trunkMembers);
    endTrunk({ trunks: d.trunkMembers.length });
    stopWrite();
  }
  // Wireless stations (FortiAP only). Same undefined/[] semantics as LLDP —
  // undefined leaves rows alone, [] wipes them. Per-scrape full-replace
  // with NO 48h stickiness window: wireless clients are transient by
  // design and a missing station means the client roamed or disconnected.
  if (Array.isArray(d.wirelessStations)) {
    const stopWrite = startSampleWriteTimer("asset_wireless_stations");
    const endWireless = startPhase("systeminfo.persist.wireless");
    await persistWirelessStations(assetId, d.wirelessStations);
    endWireless({ stations: d.wirelessStations.length });
    stopWrite();
  }
  // Radio + broadcast-SSID inventory (FortiAP only), the two levels above
  // those stations. Same undefined/[] semantics again. The controller half
  // of this runs in discovery; persistApRadioInventory merges the two per
  // column, so whichever ran last does not erase what the other established.
  if (Array.isArray(d.apRadios)) {
    const stopWrite = startSampleWriteTimer("asset_ap_radios");
    const endRadios = startPhase("systeminfo.persist.ap_radios");
    const res = await persistApRadioInventory(assetId, d.apRadios, "snmp");
    endRadios({ radios: res.radios, vaps: res.vaps });
    stopWrite();
  }
  // MCLAG ICL peers (FortiSwitch only). Same undefined/[] semantics as LLDP:
  // undefined = not collected (switch not in CMDB / fetch failed) → leave rows
  // alone; an array (even empty) = full-replace this switch's ICL-peer rows.
  if (Array.isArray(d.mclagPeers)) {
    const stopWrite = startSampleWriteTimer("asset_mclag_peers");
    const endMclag = startPhase("systeminfo.persist.mclag_peers");
    await persistMclagPeers(assetId, d.mclagPeers);
    endMclag({ peers: d.mclagPeers.length });
    stopWrite();
  }

  await adoptDetectedModel(assetId, d.detectedModel, pinned);
  await adoptSysDescrIdentity(assetId, d, pinned);
  // sysName + the ENTITY-MIB chassis row (business rule 154). Edge-triggered
  // in memory, so an unchanged device costs no query.
  await reconcileSnmpSelfIdentity(assetId, d.selfIdentity);

  // Only bump lastSystemInfoAt when the scrape returned interfaces. The
  // /system-info GET endpoint anchors its interface query to this
  // timestamp, so bumping it on an empty interfaces[] silently empties the
  // System tab table — operators on REST API direct have seen FortiOS
  // return 200 OK with an empty results object (token without monitor
  // scope, VDOM weirdness, transient state) which used to slip past the
  // earlier "result.data is set" guard. Preserving the prior interface set
  // is strictly better than displaying nothing while the device is online.
  // The other streams (storage / ipsec / temperatures / lldp) read their
  // own latest-row timestamp and are written above unconditionally, so they
  // still refresh on every successful pull.
  //
  // An empty interface list is therefore a FAILED poll for the stream's own
  // accounting too (business rule 118): the attempt is stamped so the device
  // waits a cadence before the next walk, and the failure run says why.
  const endUpdate = startPhase("systeminfo.persist.update_asset");
  if (d.interfaces.length > 0) {
    await prisma.asset.update({
      where: { id: assetId },
      // This pass read sysDescr in its own multi-GET, so the identity read is
      // satisfied for another interval — folded into the update this path
      // already makes rather than costing a write of its own. It is what
      // keeps the response-time probe from carrying a redundant sysDescr
      // varbind for every asset that also has a heavy stream enabled.
      data: { ...systemInfoSuccessStamps(now), ...(d.sysDescr ? { lastDescrAt: now } : {}) },
    });
  } else {
    await recordStreamFailure("systemInfo", assetId, now, pollFailureText(result.error, "The device answered but returned no interfaces"));
  }
  endUpdate();
}

/**
 * Replace the asset's SD-WAN rule rows with the latest scrape. CURRENT-STATE,
 * not a time-series: SD-WAN rules carry no history (only the SLA-metrics stream
 * does). Mirrors the LLDP / wireless-station delete-replace pattern — wipe the
 * asset's rows and re-insert the fresh set in one atomic transaction so a
 * concurrent reader sees either the old set or the new set, never an empty
 * intermediate. `asset_sdwan_rules` is a PLAIN table (not a hypertable), so the
 * delete-replace is compression-safe.
 */
export async function persistSdwanRules(
  assetId: string,
  rules: SdwanRuleSample[],
): Promise<void> {
  const data = rules.map((r) => ({
    id:               randomUUID(),
    assetId,
    ruleName:         r.ruleName,
    ruleId:           r.ruleId,
    seq:              r.seq,
    enabled:          r.enabled,
    mode:             r.mode,
    criteria:         r.criteria,
    healthChecks:     r.healthChecks,
    dst:              r.dst,
    status:           r.status,
    selectedMember:   r.selectedMember,
    availableMembers: r.availableMembers,
    priorityZones:    r.priorityZones,
  }));
  // Change detection (gated): capture prior selected-member per rule so we can
  // emit a failover event when it changes.
  const watchFailover = await isChangeActionSubscribed("change.sdwan.failover");
  const priorMembers = watchFailover
    ? new Map((await prisma.assetSdwanRule.findMany({ where: { assetId }, select: { ruleName: true, selectedMember: true } })).map((r) => [r.ruleName, r.selectedMember]))
    : null;

  await retryOnDeadlock(() =>
    prisma.$transaction([
      prisma.assetSdwanRule.deleteMany({ where: { assetId } }),
      ...(data.length > 0
        ? [prisma.assetSdwanRule.createMany({ data, skipDuplicates: true })]
        : []),
    ]),
  );

  if (priorMembers) {
    const failovers: ChangeItem[] = [];
    for (const r of rules) {
      if (priorMembers.has(r.ruleName)) {
        const before = priorMembers.get(r.ruleName) ?? null;
        if (before && r.selectedMember && before !== r.selectedMember) {
          failovers.push({ label: `${r.ruleName}: ${before} → ${r.selectedMember}`, details: { ruleName: r.ruleName, from: before, to: r.selectedMember } });
        }
      }
    }
    if (failovers.length) {
      const assetName = (await prisma.asset.findUnique({ where: { id: assetId }, select: { hostname: true } }))?.hostname ?? null;
      await maybeEmitChangeEvents("change.sdwan.failover", assetId, assetName, failovers);
    }
  }
}

/**
 * Replace the switch's MCLAG ICL-peer rows with the latest scrape. CURRENT-
 * STATE delete-replace, mirroring persistSdwanRules / persistLldpNeighbors:
 * wipe + re-insert in one atomic transaction so a reader sees either the old or
 * new set, never an empty intermediate. `asset_mclag_peers` is a PLAIN table
 * (not a hypertable). Each row's `peerSn` is resolved to the peer switch's
 * Asset id (`matchedAssetId`) via a single serial lookup so the topology
 * renderer can draw a clickable sibling edge; unresolved serials (peer not yet
 * discovered) leave matchedAssetId null and self-heal on a later scrape.
 */
async function persistMclagPeers(
  assetId: string,
  peers: FortiswitchMclagPeer[],
): Promise<void> {
  // Resolve peer serials → asset ids in one query. Serials are compared
  // case-insensitively (CMDB and stored serials are normally uppercase, but
  // don't assume). Usually 1-2 distinct serials, so the IN clause stays tiny.
  const serialToId = new Map<string, string>();
  const distinctSerials = [...new Set(peers.map((p) => p.peerSn))];
  if (distinctSerials.length > 0) {
    const matches = await prisma.asset.findMany({
      where: { serialNumber: { in: distinctSerials, mode: "insensitive" } },
      select: { id: true, serialNumber: true },
    });
    for (const m of matches) {
      if (m.serialNumber) serialToId.set(m.serialNumber.toUpperCase(), m.id);
    }
  }
  const data = peers.map((p) => ({
    id:             randomUUID(),
    assetId,
    localPort:      p.localPort,
    iclTrunk:       p.iclTrunk,
    peerSn:         p.peerSn,
    peerName:       p.peerName,
    peerPort:       p.peerPort,
    matchedAssetId: serialToId.get(p.peerSn.toUpperCase()) ?? null,
  }));
  // Change detection (gated): capture prior peer serials so we can emit a
  // peer-lost event when one disappears.
  const watchPeerLost = await isChangeActionSubscribed("change.mclag.peer_lost");
  const priorPeers = watchPeerLost
    ? await prisma.assetMclagPeer.findMany({ where: { assetId }, select: { peerSn: true, peerName: true, localPort: true } })
    : null;

  await retryOnDeadlock(() =>
    prisma.$transaction([
      prisma.assetMclagPeer.deleteMany({ where: { assetId } }),
      ...(data.length > 0
        ? [prisma.assetMclagPeer.createMany({ data, skipDuplicates: true })]
        : []),
    ]),
  );

  if (priorPeers) {
    const newSerials = new Set(peers.map((p) => p.peerSn.toUpperCase()));
    const lost: ChangeItem[] = priorPeers
      .filter((p) => !newSerials.has(p.peerSn.toUpperCase()))
      .map((p) => ({ label: `${p.peerName || p.peerSn} on ${p.localPort}`, details: { peerSn: p.peerSn, peerName: p.peerName, localPort: p.localPort } }));
    if (lost.length) {
      const assetName = (await prisma.asset.findUnique({ where: { id: assetId }, select: { hostname: true } }))?.hostname ?? null;
      await maybeEmitChangeEvents("change.mclag.peer_lost", assetId, assetName, lost);
    }
  }
}

/** One aggregated-by-name program row for the current-state process inventory. */
export interface AssetProcessInput {
  name:          string;
  instanceCount: number;
  cpuPct:        number | null;
  memRssBytes:   bigint | null;
  exePath:       string | null;
  username:      string | null;
  startedAt:     Date | null;
  serviceUnit:   string | null;
  controllable:  boolean;
}

/** The stored process columns a scrape can change. cpuPct / memRssBytes are
 *  compared through the dead band (sameInventoryRow); the rest exactly. */
const PROCESS_FIELDS = [
  "instanceCount", "cpuPct", "memRssBytes", "exePath", "username", "startedAt", "serviceUnit", "controllable",
] as const satisfies readonly (keyof AssetProcessInput)[];

const PROCESS_EXACT_FIELDS = PROCESS_FIELDS.filter((f) => f !== "cpuPct" && f !== "memRssBytes");

/**
 * Current-state process inventory for one asset, written as a DELTA
 * (utils/inventoryDelta) in one transaction: read the host's rows, create the
 * programs that appeared, delete the ones that vanished, update only the ones
 * that changed, and stamp the scrape time (AssetInventoryScrape). A reader sees
 * either the old set or the new set, never a mix. An empty `rows` is a valid
 * delete-only scrape. Same shape as serviceInventoryService.persistAssetServices;
 * CPU and memory are stored rounded and compared through a dead band.
 *
 * The delta IS the started/stopped change set, so change detection costs no
 * read of its own any more; only EMITTING is gated on a subscribed rule.
 */
export async function persistAssetProcesses(
  assetId: string,
  rows: AssetProcessInput[],
  now: Date = new Date(),
): Promise<{ created: number; updated: number; removed: number; unchanged: number }> {
  const incoming: AssetProcessInput[] = rows.map((r) => ({
    ...r,
    cpuPct: normalizeCpuPct(r.cpuPct),
    memRssBytes: normalizeBytes(r.memRssBytes),
  }));
  const pick = (r: AssetProcessInput) => ({
    instanceCount: r.instanceCount,
    cpuPct:        r.cpuPct,
    memRssBytes:   r.memRssBytes,
    exePath:       r.exePath,
    username:      r.username,
    startedAt:     r.startedAt,
    serviceUnit:   r.serviceUnit,
    controllable:  r.controllable,
  });
  const delta = await retryOnDeadlock(() =>
    prisma.$transaction(
      async (tx) => {
        const existing = await tx.assetProcess.findMany({
          where: { assetId },
          select: { id: true, name: true, ...Object.fromEntries(PROCESS_FIELDS.map((f) => [f, true])) },
        }) as unknown as Array<AssetProcessInput & { id: string }>;
        const d = diffInventory(existing, incoming, (r) => r.name, (e) => e.name,
          (e, n) => sameInventoryRow<AssetProcessInput>(e, n, PROCESS_EXACT_FIELDS, "cpuPct", "memRssBytes"));
        if (d.remove.length > 0) {
          await tx.assetProcess.deleteMany({ where: { id: { in: d.remove.map((e) => e.id) } } });
        }
        if (d.create.length > 0) {
          await tx.assetProcess.createMany({
            data: d.create.map((r) => ({ id: randomUUID(), assetId, name: r.name, ...pick(r) })),
            skipDuplicates: true,
          });
        }
        // updateMany: a concurrent push may have deleted the row since our read.
        for (const { existing: e, next } of d.update) {
          await tx.assetProcess.updateMany({ where: { id: e.id }, data: pick(next) });
        }
        await tx.assetInventoryScrape.upsert({
          where: { assetId_kind: { assetId, kind: "processes" } },
          create: { assetId, kind: "processes", scrapedAt: now },
          update: { scrapedAt: now },
        });
        return d;
      },
      // The first write after the upgrade re-rounds every stored figure once.
      { timeout: 30_000 },
    ),
  );

  const watchChanges =
    (await isChangeActionSubscribed("change.process.started")) ||
    (await isChangeActionSubscribed("change.process.stopped"));
  if (watchChanges) {
    const started: ChangeItem[] = delta.create.map((r) => ({ label: r.name, details: { name: r.name } }));
    const stopped: ChangeItem[] = delta.remove.map((e) => ({ label: e.name, details: { name: e.name } }));
    if (started.length || stopped.length) {
      const assetName = (await prisma.asset.findUnique({ where: { id: assetId }, select: { hostname: true } }))?.hostname ?? null;
      await maybeEmitChangeEvents("change.process.started", assetId, assetName, started);
      await maybeEmitChangeEvents("change.process.stopped", assetId, assetName, stopped);
    }
  }
  return { created: delta.create.length, updated: delta.update.length, removed: delta.remove.length, unchanged: delta.unchanged };
}
