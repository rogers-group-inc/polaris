/**
 * src/utils/endpointGate.ts
 *
 * Business rule 101(b): the FortiGate an endpoint is attributed to (the
 * fortigate-endpoint blob's gate, projected into `Asset.learnedLocation` —
 * the Sources column's "last seen firewall") is the gate that serves the
 * asset's PRIMARY address, not whichever pathway touched the asset last.
 *
 * Discovery names a candidate gate per pathway as it goes (a DHCP claim, a
 * fresher detected-device row, the controller of the switch the MAC sits on, an
 * ARP fill), and before this the last one written won. A laptop whose address
 * came from gate A's lease but whose MAC also showed on gate B's FortiSwitch
 * read "gate B" while being monitored on an address only gate A serves. FMG
 * mode makes it worse: each managed gate is its own `syncDhcpSubnets` call, so
 * one call cannot see the claim another call decided.
 *
 * The answer is read from IPAM, which every call sees whole: the gate-owned
 * networks (`Subnet.fortigateDevice` set, not deprecated) that contain the
 * primary address, narrowest first. RFC1918 space repeats behind different
 * gates, so when several gates own an equally narrow network holding the
 * address, the caller's own candidates (this run's pathway gate, then the gate
 * the source named before) break the tie — and if none of them is among the
 * owners the answer is null, so the caller keeps its pathway answer rather
 * than guessing between sites.
 *
 * The flush asks once per touched endpoint, so the networks are parsed once
 * into a resolver (`buildLongestPrefixMatcher` in utils/cidr.ts): at 2000
 * endpoints and a few thousand networks, a parse per (asset, subnet) pair
 * would be millions per discovery call.
 */

import { buildLongestPrefixMatcher } from "./cidr.js";

export interface GateSubnet {
  cidr: string;
  status: string;
  fortigateDevice: string | null;
}

export type EndpointGateResolver = (
  ip: string | null | undefined,
  candidates?: ReadonlyArray<string | null | undefined>,
) => string | null;

/**
 * Parse the gate-owned, non-deprecated networks once; the returned function
 * answers "which gate serves this address" — null when IPAM cannot say (no
 * address, no gate-owned network containing it, or an overlap the candidates
 * do not settle). Candidates are compared after trimming, the way
 * `Subnet.fortigateDevice` is stored. Unparseable CIDRs are skipped.
 */
export function buildEndpointGateResolver(subnets: readonly GateSubnet[]): EndpointGateResolver {
  const owned = subnets
    .filter((s) => s.status !== "deprecated" && !!s.fortigateDevice?.trim())
    .map((s) => ({ cidr: s.cidr, gate: s.fortigateDevice!.trim() }));
  const narrowest = buildLongestPrefixMatcher(owned);
  return (ip, candidates = []) => {
    if (!ip) return null;
    const gates = [...new Set(narrowest(ip).map((m) => m.gate))];
    if (gates.length === 0) return null;
    if (gates.length === 1) return gates[0];
    for (const c of candidates) {
      const name = c?.trim();
      if (name && gates.includes(name)) return name;
    }
    return null;
  };
}

/** One-shot form of `buildEndpointGateResolver` — for a single lookup. */
export function gateServingAddress(
  ip: string | null | undefined,
  subnets: readonly GateSubnet[],
  candidates: ReadonlyArray<string | null | undefined> = [],
): string | null {
  return buildEndpointGateResolver(subnets)(ip, candidates);
}
