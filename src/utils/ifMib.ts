/**
 * src/utils/ifMib.ts — pure IF-MIB (RFC 2863) enum decoders.
 *
 * Extracted from monitoringService.ts so the network-Discovery scan can decode
 * an interface list from a bare `snmpWalkRaw` without importing the monitor
 * service (a util may not depend on a service, and the scan runner is a
 * service that imports both). Two consumers, one table: a second copy is how
 * a scan would come to disagree with the collector about what ifType 161 is.
 *
 * Both are deliberately CONSERVATIVE — an unrecognized enum value returns
 * null rather than a plausible default. `ifType` in particular has hundreds of
 * registered values and the canonical vocabulary Polaris pins interfaces by
 * (physical / aggregate / vlan / loopback / tunnel, see
 * autoMonitorInterfacesService.IF_TYPES) has five, so mapping an unknown value
 * onto "physical" would put a virtual interface into a byTypes pin set.
 */

/** IF-MIB ifAdminStatus / ifOperStatus (1.3.6.1.2.1.2.2.1.{7,8}). The agent's Windows and Linux readers emit the same strings. */
export function ifStatusLabel(n: number | null | undefined): string | null {
  switch (n) {
    case 1: return "up";
    case 2: return "down";
    case 3: return "testing";
    case 4: return "unknown";
    case 5: return "dormant";
    case 6: return "notPresent";
    case 7: return "lowerLayerDown";
    default: return null;
  }
}

/**
 * EtherLike-MIB dot3StatsDuplexStatus (1.3.6.1.2.1.10.7.2.1.19, RFC 3635),
 * whose index dot3StatsIndex is the interface's ifIndex. 1 = unknown (also
 * what an agent reports for a link that is down), 2 = halfDuplex,
 * 3 = fullDuplex.
 */
export function dot3DuplexLabel(n: number | null | undefined): string | null {
  switch (n) {
    case 2:  return "half";
    case 3:  return "full";
    default: return null;
  }
}

/**
 * IF-MIB ifType (1.3.6.1.2.1.2.2.1.3) → Polaris's canonical type string.
 * Only covers the values commonly seen on network gear; everything else is
 * null (see the file header for why that isn't "physical").
 */
export function snmpIfTypeLabel(n: number | null | undefined): string | null {
  switch (n) {
    case 6:   return "physical";   // ethernetCsmacd
    case 24:  return "loopback";   // softwareLoopback
    case 131: return "tunnel";     // tunnel
    case 135: return "vlan";       // l2vlan
    case 161: return "aggregate";  // ieee8023adLag
    case 166: return "tunnel";     // mpls
    default:  return null;
  }
}
