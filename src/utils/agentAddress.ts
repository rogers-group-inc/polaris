/**
 * src/utils/agentAddress.ts — the address an asset's own agent vouches for
 * (business rule 195).
 *
 * The agent's own `primaryIp` is the first up, non-loopback interface the OS
 * enumerates — on Windows that can be a Hyper-V, WSL, VPN or Docker adapter —
 * so it never decides the primary address on its own. What does is the address
 * the agent CONNECTS to Polaris from: the interface the host's routing table
 * actually uses to reach the server. It counts only when it is
 *
 *   - RFC 1918 IPv4 (loopback is an unresolved proxy hop; a public address is a
 *     NAT gateway's), and
 *   - one of the addresses the agent itself reports (its interface report, or
 *     its primaryIp): a source address the host's own table lacks means a
 *     translation sits in between, and the translated address names some
 *     other device.
 *
 * Pure — the route resolves the caller address and reads the interface rows.
 */

import { isPrivateIpv4, unwrapMappedIpv4 } from "./cidr.js";

/**
 * How long a confirmed agent address keeps the primary after the agent's last
 * system-info push. Matches the agent-interface evidence window (rule 103(e)).
 * A host that moves gets a new confirmed address on its next push, so this
 * only bounds how long a DEAD agent holds the address before the network
 * evidence (rule 101) decides again. Generous because the heartbeat interval
 * is operator-configurable and uncapped.
 */
export const AGENT_ADDRESS_FRESH_MS = 24 * 60 * 60 * 1000;

export function confirmAgentAddress(input: {
  sourceIp: string | null | undefined;
  primaryIp: string | null | undefined;
  reportedIps: Iterable<string>;
}): string | null {
  if (!input.sourceIp) return null;
  const src = unwrapMappedIpv4(input.sourceIp);
  if (!isPrivateIpv4(src)) return null;
  if (input.primaryIp && unwrapMappedIpv4(input.primaryIp) === src) return src;
  for (const ip of input.reportedIps) {
    if (unwrapMappedIpv4(ip) === src) return src;
  }
  return null;
}
