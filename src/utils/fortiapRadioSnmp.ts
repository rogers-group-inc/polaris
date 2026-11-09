/**
 * src/utils/fortiapRadioSnmp.ts
 *
 * Pure (no I/O) decoders for FORTINET-FORTIAP-MIB's radio and VAP tables — the
 * SNMP half of the FortiAP radio → SSID → station tree. The walking lives in
 * monitoringService; everything that turns a raw varbind into a stored value
 * lives here so it can be tested without a session.
 *
 * Column numbers are transcribed from the published module. Two of them were
 * already in the codebase (`fapRadioType` = 6, `fapRadioChannelOper` = 14, used
 * since the station collector shipped) and they match, which is the only
 * cross-check available short of a live walk.
 *
 * The one thing the module does NOT state: a unit for the three tx-power
 * objects. `fapRadioTxPowerConfig` / `Oper` / `Max` are bare `Integer32` with
 * no `UNITS` clause, no range, and a DESCRIPTION that says only "Configured /
 * Operating / Maximum Tx Power of the Radio" — while FortiOS reports the same
 * quantity over REST as a percentage of the radio's ceiling. So the values are
 * stored and rendered without a unit rather than being labelled dBm on a
 * guess; see the column comments on AssetApRadio.
 */

/** FORTINET-FORTIAP-MIB::fapRadioEntry, 1.3.6.1.4.1.12356.120.4.1.1 */
const FAP_RADIO_ENTRY = "1.3.6.1.4.1.12356.120.4.1.1";
/** FORTINET-FORTIAP-MIB::fapVapEntry, 1.3.6.1.4.1.12356.120.7.1.1 */
const FAP_VAP_ENTRY = "1.3.6.1.4.1.12356.120.7.1.1";

/**
 * The columns Polaris walks. INDEX columns are deliberately absent: both
 * tables encode their index in the row suffix (fapRadioIndex; fapVapRadioId +
 * fapVapWlanId), so walking them again would cost a round trip to learn what
 * the suffix already says.
 */
export const FAP_RADIO_OID = {
  mode:          `${FAP_RADIO_ENTRY}.2`,  // INTEGER ap(0) disabled(1) monitor(2) sniffer(3) failed(4)
  country:       `${FAP_RADIO_ENTRY}.3`,  // DisplayString
  stationInfo:   `${FAP_RADIO_ENTRY}.5`,  // DisplayString "x/y"
  type:          `${FAP_RADIO_ENTRY}.6`,  // INTEGER, the 802.11 mode enum below
  txPowerConfig: `${FAP_RADIO_ENTRY}.9`,  // Integer32, unit unstated
  txPowerOper:   `${FAP_RADIO_ENTRY}.10`, // Integer32, unit unstated
  txPowerMax:    `${FAP_RADIO_ENTRY}.11`, // Integer32, unit unstated
  channelWidth:  `${FAP_RADIO_ENTRY}.12`, // INTEGER bw20Mhz(0) bw40Mhz(1) bw80Mhz(2)
  channelOper:   `${FAP_RADIO_ENTRY}.14`, // Integer32
} as const;

export const FAP_VAP_OID = {
  bssid:      `${FAP_VAP_ENTRY}.3`,  // PhysAddress
  ssid:       `${FAP_VAP_ENTRY}.4`,  // DisplayString
  status:     `${FAP_VAP_ENTRY}.6`,  // INTEGER down(0) up(1)
  vlanId:     `${FAP_VAP_ENTRY}.18`, // Integer32 (1..4094)
  staCount:   `${FAP_VAP_ENTRY}.45`, // Integer32
} as const;

/** fapRadioMode. Anything outside the enum passes through as null. */
export function decodeRadioMode(raw: unknown): string | null {
  const n = toInt(raw);
  switch (n) {
    case 0: return "ap";
    case 1: return "disabled";
    case 2: return "monitor";
    case 3: return "sniffer";
    case 4: return "failed";
    default: return null;
  }
}

/**
 * fapRadioChannelWidth. The enum stops at 80 MHz — the module predates Wi-Fi 6E
 * and 7 — so a 160 or 320 MHz radio reports a value this does not name. Those
 * return null rather than a guess: a wrong width reads exactly as confidently
 * as a right one, and the width is also readable from the controller.
 */
export function decodeChannelWidth(raw: unknown): number | null {
  const n = toInt(raw);
  switch (n) {
    case 0: return 20;
    case 1: return 40;
    case 2: return 80;
    default: return null;
  }
}

/**
 * fapRadioType → (label, band). The enum is 802.11a/b/g/n/ac only, and every
 * member names the band it operates in, which makes this the ONE source that
 * knows a radio's band without inferring it from a channel number.
 *
 * `ieee80211n(7)` is the exception and returns no band: plain "n" runs on
 * either. It falls through to the channel-based derivation like everything
 * else. There is no 6 GHz member at all, so a 6E radio on a newer FortiAP
 * reports a value outside this enum — handled the same way, label null, band
 * from the channel.
 */
export function decodeRadioType(raw: unknown): { label: string | null; band: "2.4GHz" | "5GHz" | null } {
  const n = toInt(raw);
  switch (n) {
    case 0: return { label: "802.11a", band: "5GHz" };
    case 1: return { label: "802.11b", band: "2.4GHz" };
    case 2: return { label: "802.11g only", band: "2.4GHz" };
    case 3: return { label: "802.11ac 2.4GHz", band: "2.4GHz" };
    case 4: return { label: "802.11ac", band: "5GHz" };
    case 5: return { label: "802.11n 2.4GHz", band: "2.4GHz" };
    case 6: return { label: "802.11n 5GHz", band: "5GHz" };
    case 7: return { label: "802.11n", band: null };
    default: return { label: null, band: null };
  }
}

/**
 * fapRadioStationInfo is "x/y" — connected count over the configured maximum.
 * Only the connected half is stored; the maximum is a profile setting, not a
 * reading, and the station table is the authority on who is actually on.
 * Returns null for any shape that isn't two integers, rather than reading the
 * first number of something unexpected as a client count.
 */
export function parseStationInfoCount(raw: unknown): number | null {
  if (raw == null) return null;
  const m = /^\s*(\d+)\s*\/\s*(\d+)\s*$/.exec(String(raw));
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

/**
 * Split a fapVapTable row suffix into its two index columns. The INDEX is
 * { fapVapRadioId, fapVapWlanId }, both Integer32, so a well-formed suffix is
 * exactly two parts — anything else is a row shape Polaris does not recognize
 * and is dropped rather than guessed at.
 */
export function parseVapSuffix(suffix: string): { radioIndex: number; wlanId: number } | null {
  const parts = String(suffix).split(".");
  if (parts.length !== 2) return null;
  const radioIndex = Number(parts[0]);
  const wlanId = Number(parts[1]);
  if (!Number.isInteger(radioIndex) || !Number.isInteger(wlanId)) return null;
  return { radioIndex, wlanId };
}

/** Coerce a varbind value to an integer, or null. */
function toInt(raw: unknown): number | null {
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;
  if (typeof raw === "string" && raw.trim() !== "") {
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}
