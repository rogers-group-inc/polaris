/**
 * src/utils/fortinetParentKey.ts
 *
 * Resolving a Fortinet infra asset's PARENT from the identity stamps discovery
 * wrote onto `Asset.fortinetTopology`.
 *
 * The problem this exists to solve: `fortinetTopology.controllerFortigate` holds
 * FortiManager's DEVICE NAME, which is assigned inside FMG and is under no
 * obligation to match the gate's own `system global hostname`. `Asset.hostname`
 * for a FortiGate is projected from the gate's configured hostname
 * (`device.hostname || device.name`), so on any install where an operator named
 * the FMG device differently from the gate, every name-keyed parent lookup
 * silently resolved to nothing:
 *
 *   - dependency suppression never fired (no parent ⇒ never suppressed), so a
 *     FortiGate in a maintenance window left its switches reading "Down"
 *     instead of "Dep. Down" (prod 2026-08-12, the bug that found this)
 *   - the Device Map showed the gate with none of its switches/APs
 *   - map-region assignment, interface auto-monitor and connection paths all
 *     skipped the children
 *
 * The serial is definitive on both sides, so discovery now also stamps
 * `controllerSerial`. This module is the single resolution order every consumer
 * shares:
 *
 *   1. `controllerSerial` against serials — definitive, present on rows written
 *      after the 2026-08 fix.
 *   2. the NAME against hostnames — exactly the pre-fix behavior, kept as the
 *      fallback because a stamp only gains `controllerSerial` when its
 *      integration next runs discovery. Never remove it.
 *   3. the NAME against serials — covers the FortiSwitch/FortiAP direction,
 *      where the stamp (`parentSwitch`, from the AP's LLDP table) carries a
 *      switch-id that IS the serial while `Asset.hostname` may be an
 *      operator-set label.
 *
 * A HOSTNAME IS NOT AN IDENTITY (business rule 91). A FortiSwitch's hostname
 * is its `switch-id`, which FortiLink fleets rename per site — so "IDF-1" exists
 * once behind every gate — and the name-keyed stamps (`lastSeenSwitch`,
 * `lastSeenAp`, an AP's `parentSwitch`, an LLDP `systemName`) carry nothing
 * else. The hostname step used to be first-writer-wins, which parented half of
 * one site's endpoints to another site's switch and silenced their alerts
 * behind a device they never sat under. Now a name matching several candidates
 * of the expected type is resolved by SCOPE — the controller FortiGate each
 * candidate stamps against the gate(s) the caller already knows the child sits
 * under — and when no scope picks exactly one, the answer is NULL (ambiguous),
 * never a guess. Within one gate the `switch-id` is unique, so a scope that
 * names the right gate always settles it.
 *
 * IMPORTANT — `controllerFortigate` has a second, unrelated class of consumer
 * that must keep using the NAME: anything addressing an FMG/FortiOS API
 * (monitoringService's parent-FortiGate polling, the discovery decommission
 * sweeps comparing against the FMG roster, infraDhcpBinding's name-to-name
 * compare, and the Sources column, which shows the FMG name deliberately —
 * business rule 22). Those are not asset-identity lookups and must not route
 * through here.
 *
 * Pure — no DB access. Callers supply the candidate set.
 */

/** One candidate parent asset. Field names match the Asset columns. */
export interface InfraParentCandidate {
  id: string;
  hostname: string | null;
  serialNumber: string | null;
  assetType: string;
  /** The candidate's OWN `fortinetTopology`. Supplying it lets the index pick up
   *  a firewall's `deviceName` (its name in FortiManager) — the key its children
   *  actually stamp. Omit and resolution falls back to hostname/serial only. */
  fortinetTopology?: unknown;
}

/** The stamps read off a child's `fortinetTopology`. Both optional. */
export interface InfraParentStamp {
  /** `controllerSerial` (or any definitive serial stamp, e.g. parentApSerial). */
  serial?: string | null;
  /** `controllerFortigate` / `parentSwitch` — a NAME, possibly a serial. */
  name?: string | null;
}

export interface InfraParentIndex {
  bySerial: Map<string, InfraParentCandidate>;
  /** First writer per hostname — kept for callers that only want A candidate.
   *  Resolution itself reads `byHostnameAll` so a duplicate is seen, not hidden. */
  byHostname: Map<string, InfraParentCandidate>;
  /** EVERY candidate carrying each hostname (rule 91). */
  byHostnameAll: Map<string, InfraParentCandidate[]>;
  /** Keyed on each candidate's own `fortinetTopology.deviceName`. */
  byDeviceName: Map<string, InfraParentCandidate>;
  /** Memo for `controllerGateIdOf`: candidate id → resolved controller gate id. */
  gateIdMemo: Map<string, string | null>;
}

/**
 * What the caller already knows about WHERE the device it is resolving sits —
 * the disambiguator for a hostname several candidates share (rule 91).
 */
export interface InfraParentScope {
  /**
   * Candidate asset ids the caller has DIRECT evidence for — e.g. the switches
   * whose forwarding table currently holds the endpoint's MAC. Consulted before
   * `gateIds`: an observation of the device on the candidate outranks knowing
   * which site it is at. Kept only when exactly one same-named candidate is in
   * the list.
   */
  preferIds?: readonly string[];
  /**
   * Asset ids of the FortiGate(s) the child is known to sit under, MOST
   * PREFERRED FIRST (an endpoint's sightings freshest-first, then the gate IPAM
   * says owns its address; an AP's own controller). A hostname match is kept
   * only when exactly one of the same-named candidates stamps one of these
   * gates as its controller; the earliest gate in the list that singles out a
   * candidate wins.
   */
  gateIds?: readonly string[];
}

export interface InfraParentResolution {
  hit: InfraParentCandidate | null;
  /**
   * True when the NAME matched several candidates of the expected type and
   * neither the scope nor the serial step could pick one. `hit` is null then.
   * Callers that log should count these: an ambiguous name is a device the
   * tree silently cannot place.
   */
  ambiguous: boolean;
  /** The same-named candidates when `ambiguous`; empty otherwise. */
  candidates: InfraParentCandidate[];
}

/** Normalize a serial for comparison. Serials are compared case-insensitively
 *  upper-cased throughout the codebase (`existingAsset.serialNumber.toUpperCase()`
 *  in the discovery match guards); keep that convention. */
export function normalizeSerialKey(v: string | null | undefined): string {
  return typeof v === "string" ? v.trim().toUpperCase() : "";
}

/** Normalize a hostname/device name for comparison — lower-cased, matching the
 *  pre-existing `byHostname` maps this replaces. */
export function normalizeNameKey(v: string | null | undefined): string {
  return typeof v === "string" ? v.trim().toLowerCase() : "";
}

/**
 * Build the lookup index once per pass.
 *
 * First writer wins on a duplicate serial or device name so the index is stable
 * in whatever order the caller supplies (the dependency recompute sorts by id
 * for determinism). Duplicate serials shouldn't exist — discovery's
 * serial-mismatch guards prevent two assets sharing one — and FMG device names
 * are unique within an ADOM. A duplicate HOSTNAME absolutely can exist (two
 * switches named `IDF-1` at two sites; a workstation ghost beside its real
 * record), so every hostname's full candidate set is kept in `byHostnameAll`
 * for `resolveInfraParentAsset` to disambiguate (rule 91). Never throws.
 */
export function buildInfraParentIndex(candidates: InfraParentCandidate[]): InfraParentIndex {
  const bySerial = new Map<string, InfraParentCandidate>();
  const byHostname = new Map<string, InfraParentCandidate>();
  const byHostnameAll = new Map<string, InfraParentCandidate[]>();
  const byDeviceName = new Map<string, InfraParentCandidate>();
  for (const c of candidates) {
    const s = normalizeSerialKey(c.serialNumber);
    if (s && !bySerial.has(s)) bySerial.set(s, c);
    const h = normalizeNameKey(c.hostname);
    if (h) {
      if (!byHostname.has(h)) byHostname.set(h, c);
      const list = byHostnameAll.get(h);
      if (list) list.push(c);
      else byHostnameAll.set(h, [c]);
    }
    const d = normalizeNameKey(readFirewallDeviceName(c.fortinetTopology));
    if (d && !byDeviceName.has(d)) byDeviceName.set(d, c);
  }
  return { bySerial, byHostname, byHostnameAll, byDeviceName, gateIdMemo: new Map() };
}

/**
 * The FortiGate a switch / AP candidate sits under, as an asset id — its own
 * `controllerSerial` / `controllerFortigate` stamp resolved against the
 * firewalls in the same index (serial first, per the order above). Null for a
 * firewall (it IS a gate), for a candidate with no stamp, and when the stamp
 * names a gate the index does not hold. Memoized per index.
 */
export function controllerGateIdOf(index: InfraParentIndex, c: InfraParentCandidate): string | null {
  if (c.assetType === "firewall") return null;
  const memo = index.gateIdMemo.get(c.id);
  if (memo !== undefined) return memo;
  const stamp = readControllerStamp(c.fortinetTopology);
  // No scope here on purpose: a controller stamp names a FIREWALL, and the
  // firewall steps (serial, FMG device name) are unique keys. A gate whose
  // hostname is itself duplicated and unstamped resolves to nothing — the
  // safe side.
  const gate = (stamp.serial || stamp.name)
    ? resolveInfraParentAssetDetailed(index, stamp, "firewall").hit
    : null;
  const id = gate ? gate.id : null;
  index.gateIdMemo.set(c.id, id);
  return id;
}

/**
 * Resolve a parent from a child's stamps.
 *
 * `expectedType` guards the edge kind the caller is building (a switch's
 * controller must be a firewall; an AP's parentSwitch must be a switch) — a
 * stamp that resolves to the wrong asset type yields null rather than a bogus
 * edge, which is what the pre-fix `parent.assetType === "firewall"` checks did
 * inline. Pass undefined to accept any type.
 *
 * `scope` is what the caller knows about where the child sits (rule 91). It is
 * consulted ONLY when the hostname step finds several candidates of the
 * expected type; a unique name never needs it.
 *
 * Returns null when nothing matches — OR when the name is shared and nothing
 * singles a candidate out — which every caller must treat as "no parent", NOT
 * as an error. An unadopted switch, a gate discovered by another integration
 * that hasn't run yet, a genuinely orphaned device and a same-named switch at
 * a site the caller cannot name all land here legitimately. Use
 * `resolveInfraParentAssetDetailed` to tell the last case apart for logging.
 */
export function resolveInfraParentAsset(
  index: InfraParentIndex,
  stamp: InfraParentStamp,
  expectedType?: string,
  scope?: InfraParentScope,
): InfraParentCandidate | null {
  return resolveInfraParentAssetDetailed(index, stamp, expectedType, scope).hit;
}

/** As `resolveInfraParentAsset`, reporting an ambiguous hostname as such. */
export function resolveInfraParentAssetDetailed(
  index: InfraParentIndex,
  stamp: InfraParentStamp,
  expectedType?: string,
  scope?: InfraParentScope,
): InfraParentResolution {
  const typeOk = (c: InfraParentCandidate | undefined): InfraParentCandidate | null => {
    if (!c) return null;
    if (expectedType && c.assetType !== expectedType) return null;
    return c;
  };
  const found = (hit: InfraParentCandidate | null): InfraParentResolution =>
    ({ hit, ambiguous: false, candidates: [] });

  // 1) Definitive: the stamped serial.
  const serialKey = normalizeSerialKey(stamp.serial);
  if (serialKey) {
    const hit = typeOk(index.bySerial.get(serialKey));
    if (hit) return found(hit);
  }

  const nameKey = normalizeNameKey(stamp.name);
  if (!nameKey) return found(null);

  // 2) The stamped name against each candidate's OWN FMG device name. This is
  //    the like-for-like comparison (`controllerFortigate` and `deviceName` are
  //    both FMG's name for the gate) and the one that works on data written
  //    before `controllerSerial` existed.
  const byDevice = typeOk(index.byDeviceName.get(nameKey));
  if (byDevice) return found(byDevice);

  // 3) Pre-fix behavior: the name against hostnames. Correct whenever the FMG
  //    device name and the gate's configured hostname agree — and, for a
  //    switch or AP, whenever the name is unique among its kind. Filtered by
  //    type BEFORE counting, so a workstation ghost carrying a switch's name
  //    neither shadows the switch nor makes it ambiguous.
  const sameName = (index.byHostnameAll.get(nameKey) ?? []).filter(c => typeOk(c) !== null);
  if (sameName.length === 1) return found(sameName[0]);
  if (sameName.length > 1) {
    const picked = pickByScope(index, sameName, scope);
    if (picked) return found(picked);
  }

  // 4) The name may itself BE a serial (a FortiSwitch's switch-id is its
  //    serial, and that's what an AP's LLDP table reports as parentSwitch).
  //    Definitive, so it is allowed to settle a name step 3 found ambiguous.
  const asSerial = typeOk(index.bySerial.get(normalizeSerialKey(stamp.name)));
  if (asSerial) return found(asSerial);

  return sameName.length > 1
    ? { hit: null, ambiguous: true, candidates: sameName }
    : found(null);
}

/**
 * Rule 91's tie-break: among several same-named candidates, first the one the
 * caller directly observed (`scope.preferIds`), then the one whose controller
 * is the earliest gate in `scope.gateIds` that singles out exactly one of
 * them. Two same-named candidates under ONE gate cannot happen for a managed
 * switch (`switch-id` is the gate's mkey) and is refused when it does. No
 * scope, or a scope naming none of them, picks nothing.
 */
function pickByScope(
  index: InfraParentIndex,
  sameName: InfraParentCandidate[],
  scope: InfraParentScope | undefined,
): InfraParentCandidate | null {
  const preferIds = scope?.preferIds ?? [];
  if (preferIds.length > 0) {
    const preferred = sameName.filter(c => preferIds.includes(c.id));
    if (preferred.length === 1) return preferred[0];
  }
  const gateIds = scope?.gateIds ?? [];
  if (gateIds.length === 0) return null;
  const gateOf = new Map<string, string | null>();
  for (const c of sameName) gateOf.set(c.id, controllerGateIdOf(index, c));
  for (const gateId of gateIds) {
    if (!gateId) continue;
    const under = sameName.filter(c => gateOf.get(c.id) === gateId);
    if (under.length === 1) return under[0];
    if (under.length > 1) return null;
  }
  return null;
}

/**
 * The stamps a child asset carries, read defensively off the untyped
 * `fortinetTopology` JSON. Shared so the ~8 consumers don't each re-derive the
 * key names (and so a future rename is one edit).
 */
export function readControllerStamp(topology: unknown): InfraParentStamp {
  const t = (topology ?? null) as Record<string, unknown> | null;
  if (!t) return {};
  return {
    serial: typeof t.controllerSerial === "string" ? t.controllerSerial : null,
    name: typeof t.controllerFortigate === "string" ? t.controllerFortigate : null,
  };
}

/**
 * The identities of one controller FortiGate, as an Asset row exposes them.
 * Take this shape rather than positional strings — three same-typed arguments
 * in an order nobody can remember is how a serial ends up compared to a name.
 */
export interface ControllerIdentity {
  hostname?: string | null;
  serialNumber?: string | null;
  /**
   * `fortinetTopology.deviceName` — the FortiGate's name IN FORTIMANAGER, which
   * discovery already stamps on the firewall precisely so write paths don't have
   * to re-look it up. This is the key children actually carry in
   * `controllerFortigate`, which makes it the match that works on data written
   * BEFORE `controllerSerial` existed. Read it with `readFirewallDeviceName`.
   */
  deviceName?: string | null;
}

/**
 * The `OR` branches selecting the children of ONE controller FortiGate. Shared
 * by the Prisma consumers (Device Map topology, the map route's per-site switch
 * list, peer-inferred LLDP) so their filters can't drift apart.
 *
 * Order matches `resolveInfraParentAsset`: definitive serial, then the FMG
 * device name, then the hostname. All three are OR'd in one query — the order is
 * documentation, not precedence, since any match makes the row a child.
 *
 * Why the hostname is LAST and still present: it was the only key these call
 * sites used before 2026-08, and it is correct on every install where the FMG
 * device name happens to equal the gate's configured hostname. Dropping it would
 * silently unparent children of a firewall whose `deviceName` stamp predates
 * that field.
 *
 * Returns a plain array; spread it into an `OR`. EMPTY when the gate exposes no
 * identity at all — callers must treat that as "no children" rather than pass
 * `OR: []` to Prisma, which matches nothing in a much less obvious way.
 */
export function controllerStampWhereOr(id: ControllerIdentity): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  const seen = new Set<string>();
  const push = (key: string, value: string | null | undefined) => {
    if (!value) return;
    const dedup = `${key}:${value}`;
    if (seen.has(dedup)) return;
    seen.add(dedup);
    out.push({ fortinetTopology: { path: [key], equals: value } });
  };
  push("controllerSerial", id.serialNumber);
  push("controllerFortigate", id.deviceName);
  push("controllerFortigate", id.hostname);
  return out;
}

/**
 * The `OR` branches finding the PARENT asset named by one child stamp — the
 * reverse of `controllerStampWhereOr` (there: one gate, find its children;
 * here: one child, find its gate).
 *
 * Deliberately over-fetches rather than picking a winner in SQL: `findFirst`
 * with an OR gives no control over WHICH match comes back, so callers should
 * fetch with this and then run the candidates through `resolveInfraParentAsset`,
 * which applies the documented precedence deterministically. One query, one
 * decision, and the precedence lives in exactly one place.
 *
 * EMPTY when the stamp names nothing — treat as "no parent".
 */
export function parentAssetWhereOr(stamp: InfraParentStamp): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  if (stamp.serial) out.push({ serialNumber: stamp.serial });
  if (stamp.name) {
    out.push({ fortinetTopology: { path: ["deviceName"], equals: stamp.name } });
    out.push({ hostname: stamp.name });
    // A stamped "name" that is really a switch-id, i.e. a serial.
    out.push({ serialNumber: stamp.name });
  }
  return out;
}

/**
 * Read the FMG device name off a FIREWALL's own `fortinetTopology.deviceName`.
 * Returns null when absent (a firewall discovered before the stamp existed, or
 * a manually-created one), which every caller must tolerate.
 */
export function readFirewallDeviceName(topology: unknown): string | null {
  const t = (topology ?? null) as Record<string, unknown> | null;
  if (!t) return null;
  return typeof t.deviceName === "string" && t.deviceName.trim() ? t.deviceName.trim() : null;
}

/**
 * Every string a controller FortiGate might be named by in a CHILD's stamp or in
 * `Subnet.fortigateDevice`, most-definitive first. For the callers that compare
 * in memory or need a plain `in:` list rather than a JSON-path OR.
 */
export function controllerIdentityKeys(id: ControllerIdentity): string[] {
  const out: string[] = [];
  for (const v of [id.serialNumber, id.deviceName, id.hostname]) {
    const t = typeof v === "string" ? v.trim() : "";
    if (t && !out.includes(t)) out.push(t);
  }
  return out;
}

/**
 * The `OR` branches that match ONE topology stamp key against several identities
 * of the same device. Used for `parentSwitch`, where there is only one stamp key
 * but the value may be either the switch's hostname or its switch-id (= serial),
 * depending on what the reporting AP's LLDP table published.
 *
 * Duplicates and empties are dropped so an asset whose hostname equals its
 * serial produces one branch, not two.
 */
export function topologyStampWhereOr(
  key: string,
  values: Array<string | null | undefined>,
): Array<Record<string, unknown>> {
  const seen = new Set<string>();
  const out: Array<Record<string, unknown>> = [];
  for (const v of values) {
    if (!v) continue;
    if (seen.has(v)) continue;
    seen.add(v);
    out.push({ fortinetTopology: { path: [key], equals: v } });
  }
  return out;
}

/** As `readControllerStamp`, for an AP's wired uplink switch. There is no
 *  `parentSwitchSerial` stamp — the AP's LLDP table reports a name — but that
 *  name is usually the switch-id, which resolution step 3 handles. */
export function readParentSwitchStamp(topology: unknown): InfraParentStamp {
  const t = (topology ?? null) as Record<string, unknown> | null;
  if (!t) return {};
  return {
    serial: null,
    name: typeof t.parentSwitch === "string" ? t.parentSwitch : null,
  };
}
