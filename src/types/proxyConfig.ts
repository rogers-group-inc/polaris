/**
 * src/types/proxyConfig.ts — shape + defaults for the operator-settable nginx
 * reverse-proxy config. Persisted as a single JSON blob in the Setting table
 * under key `proxyConfig` (see src/services/proxyConfigService.ts).
 *
 * managedMode is the opt-in gate for the refuse-and-banner drift UX: existing
 * installs (before this feature shipped) start with managedMode=false and the
 * GUI controls remain read-only until the operator clicks "Adopt managed
 * mode." Fresh installs via migrate-to-nginx.sh seed managedMode=true.
 *
 * lastAppliedHash is sha256 of the rendered config the LAST time Polaris
 * wrote it. updateService.ts compares against the on-disk file's hash to
 * detect hand-edits between writes.
 */

export type TlsProtocol = "TLSv1.2" | "TLSv1.3";

interface ProxyConfigHsts {
  enabled: boolean;
  maxAgeSeconds: number;
  includeSubDomains: boolean;
  preload: boolean;
}

export interface ProxyConfig {
  httpsPort: number;
  hsts: ProxyConfigHsts;
  tlsProtocols: TlsProtocol[];
  http3Enabled: boolean;
  prometheusAllowIps: string[];
  managedMode: boolean;
  lastAppliedAt: string | null;
  lastAppliedHash: string | null;
}

export function defaultProxyConfig(): ProxyConfig {
  return {
    httpsPort: 443,
    hsts: {
      enabled: true,
      maxAgeSeconds: 31536000,
      includeSubDomains: true,
      preload: true,
    },
    tlsProtocols: ["TLSv1.2", "TLSv1.3"],
    http3Enabled: true,
    prometheusAllowIps: [],
    managedMode: false,
    lastAppliedAt: null,
    lastAppliedHash: null,
  };
}
