/**
 * src/utils/fortiosIpsec.ts
 *
 * Pure parse of the two FortiOS IPsec reads the system-info pass makes —
 * `GET /api/v2/cmdb/vpn.ipsec/phase1-interface` and
 * `GET /api/v2/monitor/vpn/ipsec` — plus the SSL-VPN session list
 * (`GET /api/v2/monitor/vpn/ssl`). Kept out of monitoringService so the
 * payload quirks are pinned by unit tests against real device answers.
 *
 * ── What the monitor answer holds (FortiOS 7.6.7 / 8.0.1, the lab ADVPN mesh) ──
 *
 * One entry per phase-1 the IKE daemon is servicing, AND one per dynamic
 * child of a phase-1. A child carries `parent: "<template>"` and is named
 * `<template>_<n>`:
 *
 *   - on a HUB, a dial-up template (CMDB `type: "dynamic"`) gets a child per
 *     connected peer — an ADVPN spoke when the template has
 *     `auto-discovery-sender: enable`, a FortiClient user when it does
 *     xauth / EAP (or was built by the FortiClient wizard), a plain dial-up
 *     peer otherwise;
 *   - on a SPOKE, a static tunnel with `auto-discovery-receiver: enable` and
 *     `net-device: enable` gets a child per on-demand ADVPN shortcut to
 *     another spoke.
 *
 * Children are the "who is connected" answer. They are NOT tunnels in the
 * sample-stream sense: they come and go with traffic and peers, so they are
 * never pinnable and never become `IpsecTunnelSample` rows (the template does,
 * as "dynamic"). They become `IpsecConnectionSample` rows instead, which the
 * asset's IPsec tab reads from a current-state table.
 *
 * Child fields relied on: `username` is the peer's IKE identity (its localid —
 * "SPK1-ISP1" — or its address when it sends none), `rgwy` the peer's
 * underlay/public address, `tun_id` its overlay / mode-cfg-assigned address,
 * `creation_time` seconds since the SA came up, `xauth_user` (when present)
 * the authenticated remote-access user. The last is read defensively under
 * a few spellings: the lab has no FortiClient user to confirm it against.
 */

/**
 * One row per FortiOS phase-1 IPsec tunnel. `status` rolls phase-2 selectors up
 * to "up" / "down" / "partial". Bytes are summed across every phase-2 selector
 * under this phase-1 and are cumulative — FortiOS resets when phase-1 renegotiates.
 *
 * Dial-up server templates (CMDB `type: "dynamic"`) report status `"dynamic"`
 * regardless of phase-2 state — these are templates that accept connections
 * from dynamic peers, so a "down" rollup at scrape time is misleading.
 */
export interface IpsecTunnelSample {
  tunnelName:      string;
  /** Parent interface from `config vpn ipsec phase1-interface`; null when the CMDB lookup fails or the phase-1 isn't found. */
  parentInterface: string | null;
  remoteGateway:   string | null;
  status:          "up" | "down" | "partial" | "dynamic";
  incomingBytes:   number | null;
  outgoingBytes:   number | null;
  proxyIdCount:    number | null;
}

/**
 * What a connection is, from the gate's point of view.
 *   advpn-spoke     — a spoke dialled into this hub's ADVPN template
 *   advpn-shortcut  — an on-demand spoke-to-spoke tunnel this spoke holds
 *   dialup-peer     — a site dialled into a dial-up template that is not ADVPN
 *   remote-access   — a FortiClient user on an IPsec dial-up template
 *   ssl-vpn         — a FortiClient / web user on SSL-VPN
 */
export type IpsecConnectionKind =
  | "advpn-spoke"
  | "advpn-shortcut"
  | "dialup-peer"
  | "remote-access"
  | "ssl-vpn";

export interface IpsecConnectionSample {
  /** Unique per gate: the FortiOS child name ("Overlay-1_0"), or `ssl:<index>` for an SSL-VPN session. */
  name:          string;
  kind:          IpsecConnectionKind;
  /** The configured phase-1 the child hangs off; null for SSL-VPN. */
  parentTunnel:  string | null;
  /** The peer's IKE identity; null when it sent none (FortiOS then echoes its address). */
  peerId:        string | null;
  /** Authenticated user (xauth / EAP / SSL-VPN login). */
  userName:      string | null;
  /** The peer's underlay / public address. */
  remoteGateway: string | null;
  /** The peer's overlay or assigned address inside the tunnel. */
  tunnelIp:      string | null;
  status:        "up" | "down" | "partial";
  incomingBytes: number | null;
  outgoingBytes: number | null;
  /** Seconds since the connection came up, as the gate reported it. */
  uptimeSec:     number | null;
}

interface Phase1Info {
  iface:     string | null;
  type:      string | null;
  remoteGw:  string | null;
  adSender:  boolean;
  adReceiver: boolean;
  remoteAccess: boolean;
}

function pickFiniteNumber(v: unknown): number | null {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

function resultsArray(res: unknown): unknown[] {
  if (Array.isArray(res)) return res;
  const r = (res as { results?: unknown } | null)?.results;
  return Array.isArray(r) ? r : [];
}

function isEnabled(v: unknown): boolean {
  return str(v).toLowerCase() === "enable";
}

/** A usable IPv4/IPv6 literal, or null for the empty / 0.0.0.0 placeholders. */
function addr(v: unknown): string | null {
  const s = str(v);
  if (!s || s === "0.0.0.0" || s === "::" || s === "::0.0.0.0") return null;
  return s;
}

export function parsePhase1Cmdb(cmdbRes: unknown): Map<string, Phase1Info> {
  const out = new Map<string, Phase1Info>();
  for (const p of resultsArray(cmdbRes)) {
    if (!p || typeof p !== "object") continue;
    const o = p as Record<string, unknown>;
    const name = str(o.name);
    if (!name) continue;
    const xauth = str(o.xauthtype).toLowerCase();
    const wizard = str(o["wizard-type"]).toLowerCase();
    out.set(name, {
      iface:    str(o.interface) || null,
      type:     str(o.type).toLowerCase() || null,
      // Static peers carry the configured gateway in `remote-gw`; dial-up
      // templates report the 0.0.0.0 placeholder → null.
      remoteGw: addr(o["remote-gw"]),
      adSender:   isEnabled(o["auto-discovery-sender"]),
      adReceiver: isEnabled(o["auto-discovery-receiver"]),
      // A template that authenticates a USER — xauth (IKEv1) or EAP (IKEv2) —
      // or that the FortiClient wizard built is a remote-access template.
      remoteAccess: (xauth !== "" && xauth !== "disable") || isEnabled(o.eap) || wizard.startsWith("dialup-forticlient"),
    });
  }
  return out;
}

function rollupProxyIds(t: Record<string, unknown>) {
  const proxyArr = Array.isArray(t.proxyid) ? t.proxyid : [];
  let upCount = 0, downCount = 0, inBytes = 0, outBytes = 0, anyBytes = false;
  for (const p of proxyArr) {
    if (!p || typeof p !== "object") continue;
    const s = String((p as any).status || "").toLowerCase();
    if (s === "up") upCount++; else downCount++;
    const ib = pickFiniteNumber((p as any).incoming_bytes);
    const ob = pickFiniteNumber((p as any).outgoing_bytes);
    if (ib != null) { inBytes  += ib; anyBytes = true; }
    if (ob != null) { outBytes += ob; anyBytes = true; }
  }
  return { proxyCount: proxyArr.length, upCount, downCount, inBytes, outBytes, anyBytes };
}

function userOf(t: Record<string, unknown>): string | null {
  return str(t.xauth_user) || str(t.xauthuser) || str(t.xauth_username) || str(t.eap_user) || null;
}

/**
 * Classify a dynamic child. The template's CMDB entry decides when it was
 * read; without it (token lacking cmdb scope) an authenticated user still
 * marks remote access and everything else falls back to the child's own
 * `type` ("dialup" on a hub's children).
 */
export function classifyIpsecChild(
  child: Record<string, unknown>,
  parent: Phase1Info | null,
): IpsecConnectionKind {
  if (userOf(child)) return "remote-access";
  if (parent) {
    if (parent.type === "dynamic") {
      if (parent.remoteAccess) return "remote-access";
      if (parent.adSender) return "advpn-spoke";
      return "dialup-peer";
    }
    // A child of a static tunnel only exists for an ADVPN shortcut.
    return "advpn-shortcut";
  }
  return str(child.type).toLowerCase() === "dialup" ? "dialup-peer" : "advpn-shortcut";
}

/**
 * Split the monitor answer into phase-1 tunnel rows (the sample stream) and
 * dynamic-child connection rows (the IPsec tab). The tunnel half is the
 * pre-existing rollup unchanged, including CMDB-only synthesis: configured
 * phase-1 tunnels the IKE daemon dropped from the monitor response (dead
 * parent link) still get a row so they don't vanish from samples while
 * configured.
 */
export function parseFortiosIpsec(
  cmdbRes: unknown,
  monitorRes: unknown,
): { tunnels: IpsecTunnelSample[]; connections: IpsecConnectionSample[] } {
  const phase1Map = parsePhase1Cmdb(cmdbRes);
  const tunnels: IpsecTunnelSample[] = [];
  const connections: IpsecConnectionSample[] = [];
  const seenConn = new Set<string>();

  for (const raw of resultsArray(monitorRes)) {
    if (!raw || typeof raw !== "object") continue;
    const t = raw as Record<string, unknown>;
    const name = String(t.name || "").trim();
    if (!name) continue;
    const r = rollupProxyIds(t);
    const parentName = str(t.parent);

    if (parentName) {
      if (seenConn.has(name)) continue;
      seenConn.add(name);
      const parent = phase1Map.get(parentName) ?? null;
      const status: IpsecConnectionSample["status"] =
        r.proxyCount === 0 ? "up" : r.downCount === 0 ? "up" : r.upCount === 0 ? "down" : "partial";
      // Phase-1 byte totals are the authoritative per-peer counters; the
      // phase-2 sum is the fallback for builds that omit them.
      const inB  = pickFiniteNumber(t.incoming_bytes) ?? (r.anyBytes ? r.inBytes : null);
      const outB = pickFiniteNumber(t.outgoing_bytes) ?? (r.anyBytes ? r.outBytes : null);
      const remoteGateway = addr(t.rgwy);
      const rawPeerId = str(t.username);
      connections.push({
        name,
        kind:          classifyIpsecChild(t, parent),
        parentTunnel:  parentName,
        // FortiOS echoes the peer's address here when it sent no localid.
        peerId:        rawPeerId && rawPeerId !== remoteGateway ? rawPeerId : null,
        userName:      userOf(t),
        remoteGateway,
        tunnelIp:      addr(t.assigned_ip) ?? addr(t.tun_id),
        status,
        incomingBytes: inB,
        outgoingBytes: outB,
        uptimeSec:     pickFiniteNumber(t.creation_time),
      });
      continue;
    }

    const phase1 = phase1Map.get(name) ?? null;
    let status: IpsecTunnelSample["status"];
    if (phase1?.type === "dynamic") {
      // Dial-up server template — accepts connections from dynamic peers, so
      // "up/down" against a single rollup is misleading. Its connected peers
      // are the children above.
      status = "dynamic";
    } else if (r.proxyCount === 0) {
      // No phase-2 selectors reported — fall back to the phase-1 connect_count
      // (>0 = up). Some FortiOS releases omit `proxyid` entirely on dial-up
      // tunnels with no active children.
      const cc = pickFiniteNumber(t.connect_count);
      status = cc != null && cc > 0 ? "up" : "down";
    } else if (r.downCount === 0) status = "up";
    else if (r.upCount === 0)     status = "down";
    else                          status = "partial";
    const rgwy = t.rgwy ?? t.tun_id ?? null;
    tunnels.push({
      tunnelName:      name,
      parentInterface: phase1?.iface ?? null,
      remoteGateway:   typeof rgwy === "string" && rgwy ? rgwy : null,
      status,
      incomingBytes:   r.anyBytes ? r.inBytes  : null,
      outgoingBytes:   r.anyBytes ? r.outBytes : null,
      proxyIdCount:    r.proxyCount || null,
    });
  }

  const seenNames = new Set(tunnels.map((t) => t.tunnelName));
  for (const [name, p1] of phase1Map) {
    if (seenNames.has(name)) continue;
    tunnels.push({
      tunnelName:      name,
      parentInterface: p1.iface,
      remoteGateway:   p1.remoteGw,
      status:          p1.type === "dynamic" ? "dynamic" : "down",
      incomingBytes:   null,
      outgoingBytes:   null,
      proxyIdCount:    null,
    });
  }
  return { tunnels, connections };
}

/**
 * SSL-VPN sessions from `/api/v2/monitor/vpn/ssl`. One row per logged-in
 * user session; the tunnel-mode subsession (if any) carries the assigned
 * address and the byte counters. FortiOS 7.6.3+ dropped SSL-VPN tunnel mode
 * (FortiClient remote access moved to IPsec), where this list is simply
 * empty — older gates are where it still matters.
 */
export function parseFortiosSslVpn(res: unknown): IpsecConnectionSample[] {
  const out: IpsecConnectionSample[] = [];
  const seen = new Set<string>();
  for (const raw of resultsArray(res)) {
    if (!raw || typeof raw !== "object") continue;
    const s = raw as Record<string, unknown>;
    const user = str(s.user_name) || str(s.username) || null;
    const remote = addr(s.remote_host);
    const idx = s.index != null ? String(s.index) : `${user ?? ""}@${remote ?? ""}`;
    const name = `ssl:${idx}`;
    if (seen.has(name)) continue;
    seen.add(name);
    const subs = Array.isArray(s.subsessions) ? s.subsessions as Record<string, unknown>[] : [];
    let tunnelIp: string | null = null;
    let inB: number | null = null, outB: number | null = null;
    for (const sub of subs) {
      if (!sub || typeof sub !== "object") continue;
      tunnelIp = tunnelIp ?? addr(sub.aip) ?? addr(sub.assigned_ip);
      const ib = pickFiniteNumber(sub.in_bytes);
      const ob = pickFiniteNumber(sub.out_bytes);
      if (ib != null) inB = (inB ?? 0) + ib;
      if (ob != null) outB = (outB ?? 0) + ob;
    }
    out.push({
      name,
      kind:          "ssl-vpn",
      parentTunnel:  null,
      peerId:        null,
      userName:      user,
      remoteGateway: remote,
      tunnelIp,
      status:        "up",
      incomingBytes: inB,
      outgoingBytes: outB,
      uptimeSec:     pickFiniteNumber(s.duration),
    });
  }
  return out;
}
