/**
 * src/utils/addressConfidence.ts — how sure Polaris is that an address is
 * really the device's (business rule 103). Pure: no DB.
 *
 * Every piece of evidence for an address has a WEIGHT (how reliable that kind
 * of source is) and a FRESHNESS (0.5 ^ (age / half-life)). They combine as
 *
 *     score = 100 × (1 − Π(1 − weight × freshness)) × Π(penalties)
 *
 * so corroboration adds up but never passes 100: two independent sources that
 * agree beat either alone, and a weak one never drags a strong one down.
 * Penalties are CONTRADICTIONS only — missing evidence costs nothing.
 *
 * Two numbers come out:
 *   evidenceScore — the network's evidence alone. The pin / typed-IP warning
 *                   reads THIS, so an operator's choice can't vouch for itself.
 *   score         — the same plus the operator's choice (a pin or a typed
 *                   address) as one more piece at OPERATOR_WEIGHT, never
 *                   decaying. What the tooltip shows.
 *
 * A third, discoveryScore, leaves out polling as well: only the primary earns
 * polling credit, so it is the one number on which addresses can be compared
 * fairly with each other.
 *
 * Nothing alerts, ranks or refuses a write on the score. Its one act is rule
 * 103(a): a pin is released once the network backs it on its own
 * (pinReleaseVerdict, run by jobs/releaseConfirmedPins.ts).
 */

export type EvidenceKind =
  | "interface"          // the device's own interface table (system-info scrape)
  | "detected-online"    // FortiGate detected device, online, local
  | "controller"         // a FortiGate / FortiSwitch / FortiAP record's management IP
  | "hypervisor"         // a Proxmox / Unraid / TrueNAS host, VM or container address
  | "endpoint-sighting"  // the FortiGate endpoint record's address
  | "vcenter"            // VMware Tools guest IP
  | "reservation-held"   // DHCP reservation the device is holding
  | "lease-held"         // DHCP lease the device is holding
  | "arc"                // Azure Arc network profile
  | "arp"                // FortiGate ARP entry
  | "generic-api"        // operator-described REST feed (rule 100)
  | "detected-offline"   // detected device the gate remembers but isn't seeing
  | "reservation-configured" // a DHCP reservation exists for this MAC (held or not)
  | "recorded"           // an older / unknown recorded source
  | "polling"            // Polaris's own probes answering on it as primary
  | "operator";          // pinned, or typed in by hand

interface KindSpec {
  weight: number;
  /** null = never decays. */
  halfLifeMs: number | null;
  label: string;
}

const H = 60 * 60 * 1000;

/** The weight table. Tuned by reasoning, not by data — revisit with real drift. */
export const EVIDENCE_KINDS: Record<EvidenceKind, KindSpec> = {
  "interface":          { weight: 0.95, halfLifeMs: 24 * H, label: "Device's own interface table" },
  "detected-online":    { weight: 0.90, halfLifeMs: 2 * H,  label: "Detected online" },
  // The controller's own roster names the management IP it reaches the device
  // on — the only network evidence a FortiAP has (no interface table, and
  // discovery keeps infra off the address list). Refreshed each discovery run.
  "controller":         { weight: 0.90, halfLifeMs: 24 * H, label: "Managed-device record" },
  "hypervisor":         { weight: 0.80, halfLifeMs: 6 * H,  label: "Hypervisor record" },
  // Derived from the same claims as the address rows, so modest: it mostly
  // matters for an address the list no longer carries.
  "endpoint-sighting":  { weight: 0.50, halfLifeMs: 12 * H, label: "FortiGate endpoint record" },
  "vcenter":            { weight: 0.85, halfLifeMs: 6 * H,  label: "vCenter guest IP" },
  "reservation-held":   { weight: 0.85, halfLifeMs: 12 * H, label: "DHCP reservation held" },
  "lease-held":         { weight: 0.70, halfLifeMs: 12 * H, label: "DHCP lease held" },
  "arc":                { weight: 0.70, halfLifeMs: 24 * H, label: "Azure Arc network profile" },
  "arp":                { weight: 0.60, halfLifeMs: 1 * H,  label: "ARP entry" },
  "generic-api":        { weight: 0.40, halfLifeMs: 24 * H, label: "API feed" },
  "detected-offline":   { weight: 0.30, halfLifeMs: 24 * H, label: "Detected, offline" },
  "reservation-configured": { weight: 0.20, halfLifeMs: null,   label: "DHCP reservation configured" },
  "recorded":           { weight: 0.30, halfLifeMs: 7 * 24 * H, label: "Recorded" },
  "polling":            { weight: 0.95, halfLifeMs: null,   label: "Polled OK as primary" },
  "operator":           { weight: 0.80, halfLifeMs: null,   label: "Chosen by an operator" },
};

/** The operator's choice, as evidence. */
export const OPERATOR_WEIGHT = EVIDENCE_KINDS.operator.weight;
/** Below this evidence score a pin or a typed address asks first. */
export const CONFIDENCE_WARN_BELOW = 50;
/** Hours of clean polling that bring the polling weight to ~63% of its cap. */
export const POLLING_RAMP_HOURS = 24;

/** Polling evidence weight for `hours` of continuous answers as primary. */
export function pollingWeight(hours: number): number {
  if (!Number.isFinite(hours) || hours <= 0) return 0;
  return EVIDENCE_KINDS.polling.weight * (1 - Math.exp(-hours / POLLING_RAMP_HOURS));
}

export interface Evidence {
  kind: EvidenceKind;
  /** When the source last saw it. Absent = now (no decay). */
  seenAt?: Date | null;
  /** The reporting gate / source name, for the tooltip. */
  device?: string | null;
  /** Polling only: hours of continuous answers. */
  hours?: number;
}

export type PenaltyKind = "alive-elsewhere" | "claimed-elsewhere";

export interface Penalty {
  kind: PenaltyKind;
  factor: number;
  detail: string;
}

/** Down here while a gate reports the device online at another address. */
export const ALIVE_ELSEWHERE_FACTOR = 0.3;
/** Another network-present device holds a fresher claim on this address. */
export const CLAIMED_ELSEWHERE_FACTOR = 0.5;

export interface ConfidencePart {
  kind: EvidenceKind;
  label: string;
  device: string | null;
  seenAt: string | null;
  hours: number | null;
  /** weight × freshness, 0–1, two decimals. */
  value: number;
}

export type ConfidenceBand = "high" | "medium" | "low" | "very-low";

export interface ConfidenceResult {
  /** 0–100, including the operator's choice. */
  score: number;
  /** 0–100, network evidence only — what the pin warning reads. */
  evidenceScore: number;
  /**
   * 0–100, DISCOVERY evidence only: no operator choice and no polling. Only the
   * primary earns polling credit, so comparing addresses with it would always
   * favour whichever one is pinned — this is the number the automatic pin
   * release compares (pinReleaseVerdict).
   */
  discoveryScore: number;
  band: ConfidenceBand;
  evidenceBand: ConfidenceBand;
  parts: ConfidencePart[];
  penalties: Penalty[];
}

export function confidenceBand(score: number): ConfidenceBand {
  if (score >= 80) return "high";
  if (score >= 50) return "medium";
  if (score >= 20) return "low";
  return "very-low";
}

export function freshness(kind: EvidenceKind, seenAt: Date | null | undefined, nowMs: number): number {
  const half = EVIDENCE_KINDS[kind].halfLifeMs;
  if (half === null || !seenAt) return 1;
  const age = Math.max(0, nowMs - seenAt.getTime());
  return Math.pow(0.5, age / half);
}

function partValue(e: Evidence, nowMs: number): number {
  if (e.kind === "polling") return pollingWeight(e.hours ?? 0);
  return EVIDENCE_KINDS[e.kind].weight * freshness(e.kind, e.seenAt, nowMs);
}

/**
 * Score one address. Several pieces of the same kind (two gates reporting it)
 * keep only the strongest — one source repeating itself is not corroboration.
 */
export function scoreAddress(
  evidence: readonly Evidence[],
  penalties: readonly Penalty[],
  nowMs: number,
): ConfidenceResult {
  const bestByKind = new Map<EvidenceKind, { e: Evidence; v: number }>();
  for (const e of evidence) {
    const v = partValue(e, nowMs);
    if (v <= 0) continue;
    const prev = bestByKind.get(e.kind);
    if (!prev || v > prev.v) bestByKind.set(e.kind, { e, v });
  }
  const parts: ConfidencePart[] = [...bestByKind.values()]
    .sort((a, b) => b.v - a.v)
    .map(({ e, v }) => ({
      kind: e.kind,
      label: EVIDENCE_KINDS[e.kind].label,
      device: e.device ?? null,
      seenAt: e.seenAt ? e.seenAt.toISOString() : null,
      hours: e.kind === "polling" ? Math.round((e.hours ?? 0) * 10) / 10 : null,
      value: Math.round(v * 100) / 100,
    }));

  const combine = (vals: number[]) => 1 - vals.reduce((acc, v) => acc * (1 - v), 1);
  const factor = penalties.reduce((acc, p) => acc * p.factor, 1);
  const networkVals = [...bestByKind.entries()].filter(([k]) => k !== "operator").map(([, x]) => x.v);
  const discoveryVals = [...bestByKind.entries()].filter(([k]) => k !== "operator" && k !== "polling").map(([, x]) => x.v);
  const allVals = [...bestByKind.values()].map((x) => x.v);
  const evidenceScore = Math.round(100 * combine(networkVals) * factor);
  const discoveryScore = Math.round(100 * combine(discoveryVals) * factor);
  const score = Math.round(100 * combine(allVals) * factor);
  return {
    score,
    evidenceScore,
    discoveryScore,
    band: confidenceBand(score),
    evidenceBand: confidenceBand(evidenceScore),
    parts,
    penalties: [...penalties],
  };
}

/**
 * Has the network come to back the operator's pin? (Business rule 103(a).)
 * True when the pinned address's DISCOVERY score reaches the warn line and is
 * strictly higher than every other address the asset has — then the pin is no
 * longer doing anything the evidence wouldn't, and is released.
 *
 * Discovery score, not the displayed one: the operator's own weight would make
 * every pin confirm itself, and polling credit (earned only by the primary)
 * would make every pin confirm itself within a day — after which discovery
 * could move the asset back to the address the operator overrode, and the pin
 * would have released into exactly the state it was set to prevent. The warn
 * line keeps "best of a weak lot" from counting as backing.
 */
export function pinReleaseVerdict(
  pinnedIp: string,
  scores: ReadonlyMap<string, Pick<ConfidenceResult, "discoveryScore">>,
): { release: boolean; pinnedScore: number; bestOther: { ip: string; score: number } | null } {
  const pinnedScore = scores.get(pinnedIp)?.discoveryScore ?? 0;
  let bestOther: { ip: string; score: number } | null = null;
  for (const [ip, r] of scores) {
    if (ip === pinnedIp) continue;
    if (!bestOther || r.discoveryScore > bestOther.score) bestOther = { ip, score: r.discoveryScore };
  }
  const release = pinnedScore >= CONFIDENCE_WARN_BELOW && (!bestOther || pinnedScore > bestOther.score);
  return { release, pinnedScore, bestOther };
}

/**
 * The polling-run patch for one probe result (Asset.ipConfirmedFor /
 * ipConfirmedSince). A run starts — both columns set — on a success Polaris
 * itself sent when the probed address isn't the one the run is for, when
 * there is no run yet, or when the device is coming back from down / unknown.
 * Otherwise nothing is written, and the flush keeps the run. An agent-reported
 * result proves nothing about the address and never touches it.
 */
export function pollingRunStart(
  asset: { ipAddress?: string | null; ipConfirmedFor?: string | null; ipConfirmedSince?: Date | null },
  success: boolean,
  previousStatus: string | null | undefined,
  agentDriven: boolean,
  now: Date,
): { ipConfirmedFor?: string; ipConfirmedSince?: Date } {
  if (!success || agentDriven || !asset.ipAddress) return {};
  const restarts =
    asset.ipConfirmedFor !== asset.ipAddress ||
    !asset.ipConfirmedSince ||
    previousStatus === "down" || previousStatus === "unknown" || previousStatus == null;
  return restarts ? { ipConfirmedFor: asset.ipAddress, ipConfirmedSince: now } : {};
}

/**
 * Hours of polling credit for `ip`: only the address the run is for, only
 * while the device is not down.
 */
export function pollingHoursFor(
  ip: string,
  asset: { ipConfirmedFor?: string | null; ipConfirmedSince?: Date | null; monitorStatus?: string | null; monitored?: boolean | null },
  nowMs: number,
): number {
  if (!asset.monitored || asset.monitorStatus === "down") return 0;
  if (asset.ipConfirmedFor !== ip || !asset.ipConfirmedSince) return 0;
  return Math.max(0, (nowMs - asset.ipConfirmedSince.getTime()) / H);
}
