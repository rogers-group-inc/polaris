/**
 * src/services/assistantPlaybookService.ts — the assistant's playbooks
 * (business rule 95).
 *
 * The tool layer answers FACTS; what it cannot encode is PROCEDURE — the
 * order of lookups that answers a multi-step NOC question well. "Why did
 * sw-nsh-02 go down?" is best answered device → alerts in the window →
 * events in the window → the upstream parent, with what the data shows kept
 * apart from what is inferred. One sentence in the system prompt says so; a
 * hosted model follows it inconsistently and a small local one not at all.
 *
 * A playbook is matched from the question, and for that turn it supplies:
 *   - `guidance`: a numbered procedure, added as a second leading system
 *     message (a Claude deployment folds it into `system`; an OpenAI server
 *     sees two system messages);
 *   - `firstRoundTools`: the tools offered on round 0, so the first lookup is
 *     the right one — the same steering `asksForReport` / `asksHowTo` do.
 *     Every tool is offered again from round 1.
 *
 * A report request and a how-to question keep priority over any playbook
 * (the chat service checks those first). Pure logic: no I/O, no model names.
 */

export interface AssistantPlaybook {
  id: "profile" | "telemetry" | "correlate" | "dependencies" | "changed" | "health" | "capacity" | "address" | "endpoint";
  /** Shown in the audit Event and tests. */
  label: string;
  match: RegExp;
  /** Tool names offered on round 0 (all tools from round 1). */
  firstRoundTools: readonly string[];
  guidance: string;
}

const SEPARATE = "Keep what the data shows apart from what you infer, and say so in those words.";

export const PLAYBOOKS: readonly AssistantPlaybook[] = [
  {
    // First, so "why is the CPU missing for our APCs" is a profile question and
    // not an outage correlation (which matches any "why is").
    id: "profile",
    label: "manufacturer profile / MIB",
    match: /\b(manufacturer profiles?|mib|mibs|oid|oids|snmp (symbol|object|walk|oid)s?|unresolved|custom (mib|widgets?)|state probes?|sensor table|hardware sensors?|which (symbol|object|oid))\b/i,
    firstRoundTools: ["search_help", "list_manufacturer_profiles", "get_manufacturer_profile", "list_mibs", "search_mib_symbols"],
    guidance: [
      "Playbook — manufacturer profile / MIB. Follow these steps in order:",
      "1. get_manufacturer_profile for the vendor (list_manufacturer_profiles if the name is unsure). Note which rows are " +
        "configured and, for each symbol, whether it resolves and from which MIB — or why not.",
      "2. list_mibs for that manufacturer: which modules are uploaded under its name, and what they import.",
      "3. When something must be chosen (a CPU, memory, sensor or status object), search_mib_symbols in the vendor's " +
        "module for it. Read the SYNTAX, enum values and description: a scalar is read as .0, a table column must be " +
        "walked; CPU must already be a percent; an enum status is a state probe, not a gauge.",
      "4. search_help for how the profile page works (Manufacturer Profiles) when the person needs to make the change.",
      "5. Answer: what is wrong or what to set, row by row, naming each symbol and the module it is in. Suggest ONLY " +
        "symbols search_mib_symbols returned — never one from memory. Say a MIB to upload by its module name. You " +
        "cannot change the profile; say where in Polaris they make the change. " + SEPARATE,
    ].join("\n"),
  },
  {
    // Before correlate and capacity: "highest memory utilization of the 61F
    // firewalls" matched capacity's "utilization" and was steered to networks
    // (seen live 2026-10-26), and "why is fw1's CPU high" is a figures question
    // before it is an outage one.
    id: "telemetry",
    label: "CPU / memory",
    // "your memory" / "my memory" is the assistant's memory of the person (rule 95(i)).
    match: /^(?!.*\b(your|my) memory\b).*\b(cpu|processor|memory|ram|mem)\b/is,
    firstRoundTools: ["telemetry_summary", "search", "get_asset"],
    guidance: [
      "Playbook — CPU / memory. Follow these steps in order:",
      "1. telemetry_summary with the devices the person named as filters — model (e.g. \"61F\"), manufacturer, " +
        "assetType, region, or search for one hostname — metric \"memory\" or \"cpu\", sortBy \"max\" when they ask " +
        "about peaks or spikes, order \"lowest\" for the least loaded, and hours or since/until for the period " +
        "(the last 24 hours if they gave none).",
      "2. If one device is in question and it looks high, get_asset for its state, alerts and upstream device.",
      "3. Answer with the ranking from the lookup, the window it covers, and how many matching devices had no " +
        "CPU / memory data (noData). Every figure comes from the lookup — never estimate one. More than about 15 " +
        "rows → offer a report. " + SEPARATE,
    ].join("\n"),
  },
  {
    id: "correlate",
    label: "outage correlation",
    match: /\b(why (did|is|was|has|does)\b|what (happened|caused|took down|went wrong|killed)\b|root cause|correlat\w*|what else (went|is|was) down|cause of|caused by)/i,
    firstRoundTools: ["search", "get_asset", "list_alerts", "get_dependencies"],
    guidance: [
      "Playbook — outage correlation. Follow these steps in order before answering:",
      "1. Find the device: get_asset by its hostname or IP (search first if the name is partial). Note its " +
        "monitorStatus, when it changed (monitorStatusChangedAt), its last seen time and the upstream device it " +
        "hangs off.",
      "2. Alerts in the window: list_alerts with since/until set to a few hours either side of that change — " +
        "first for the device, then without the device filter to see what else alerted at the same time " +
        "(siblings behind the same parent, the parent itself).",
      "3. Events in the same window: list_events — configuration changes, discovery runs, maintenance holds, " +
        "integration failures. A change minutes before the drop is the lead.",
      "4. The upstream chain: get_dependencies on the device — its rootCause, when present, is the device whose " +
        "outage explains it; otherwise check whether a parent in its upstream went down first. A device under a " +
        "dark parent is a casualty, not a fault.",
      "5. Answer with a short timeline first (times from the lookups, in order), then the likely cause ONLY if " +
        "the data supports it, else say what is missing. " + SEPARATE,
    ].join("\n"),
  },
  {
    // After correlate: "why did X go down" walks the tree as one of its steps.
    id: "dependencies",
    label: "dependency tree",
    match: /\b(depends? on|dependenc(y|ies)|upstream|downstream|hangs? off|what('s| is) (behind|under|connected to)|what (goes|would go|will go) down (if|when)|blast radius|parent device)\b/i,
    firstRoundTools: ["get_dependencies", "search"],
    guidance: [
      "Playbook — dependency tree. Follow these steps in order:",
      "1. get_dependencies for the device (search first if the name is partial).",
      "2. Answer upstream first — each hop by name, top of the tree last, and how the link was learned when it " +
        "matters — then downstream: how many devices sit behind it, how many are down or suppressed now, and the " +
        "direct children by name (offer the rest rather than listing dozens). If rootCause is present, say it. " +
        "Link every device you name. " + SEPARATE,
    ].join("\n"),
  },
  {
    id: "changed",
    label: "what changed",
    match: /\b(what('s| has| is)? changed|what changed|changes? (since|overnight|last night|today|this morning)|since (yesterday|last night|this morning|my shift)|overnight|last night|in the last \d+ ?(hours?|days?|h|d)\b|recently changed|anything new)/i,
    firstRoundTools: ["list_events", "list_alerts", "list_assets"],
    guidance: [
      "Playbook — what changed. The window is what the person said; if they gave none, use hours: 24.",
      "1. list_events for the window: group what you find by kind — configuration changes, discovery runs, " +
        "status changes, integration or job failures.",
      "2. list_alerts for the window: what opened, what cleared, what is still open.",
      "3. list_assets with sortBy: \"monitorStatusChangedAt\" and monitorStatus [\"down\", \"warning\", " +
        "\"recovering\"]: devices whose state moved in the window.",
      "4. Answer with headline counts first (events, alerts opened, devices that changed state), then the " +
        "notable items with times, newest first. Stay inside the window asked. " + SEPARATE,
    ].join("\n"),
  },
  {
    id: "health",
    label: "device health",
    match: /\b(is \S+ (ok|okay|healthy|up|fine|alright|alive)\b|health of|how (is|'s) \S+ (doing|looking)|status of \S+|check (on )?\S+)/i,
    firstRoundTools: ["search", "get_asset", "list_alerts"],
    guidance: [
      "Playbook — device health. Follow these steps in order:",
      "1. get_asset for the device (search first if the name is partial): monitorStatus and since when, last " +
        "seen, last response time, the upstream device, and its active alerts.",
      "2. list_alerts for the device over the last 24 hours (hours: 24) — anything that cleared recently matters " +
        "as much as what is open.",
      "3. list_events for the device over the same window.",
      "4. Answer with a one-line verdict first (up / degraded / down, and since when), then the evidence. " +
        "If nothing is wrong, say so plainly and stop. " + SEPARATE,
    ].join("\n"),
  },
  {
    id: "capacity",
    label: "capacity review",
    match: /\b(running out|near(ly)? full|(almost|nearly) (full|exhausted)|utili[sz]ation|capacity|room left|filling up|(over|above|more than) \d+ ?%|fullest|most used)/i,
    firstRoundTools: ["list_networks", "list_assets"],
    guidance: [
      "Playbook — capacity review. Follow these steps in order:",
      "1. list_networks with minUtilizationPercent (80 unless the person named a threshold), fullest first: " +
        "CIDR, name, VLAN, reserved / usable, utilization.",
      "2. If they asked about a region or site, narrow list_networks by tag and list_assets by region.",
      "3. list_assets with notSeenForHours: 720 for the same scope — addresses held by devices not seen in a " +
        "month are the first space to reclaim.",
      "4. Answer with the worst networks first, each with its numbers; then the reclaimable space. More than " +
        "about 15 rows → offer a report instead of a long table. " + SEPARATE,
    ].join("\n"),
  },
  {
    id: "address",
    label: "address lookup",
    // An IPv4 literal plus a lookup verb. Last, so "why is 10.1.1.5 down" and
    // "is 10.1.1.5 ok" keep their own playbooks.
    match: /(?=.*\b(?:\d{1,3}\.){3}\d{1,3}\b)(?=.*\b(look ?up|whose|who (has|owns|uses|is using)|where is|which (device|asset|host)|what (is|device|asset|has)|find|identify|belongs?|anything (on|about|for))\b)/i,
    firstRoundTools: ["search", "get_asset", "list_reservations", "find_endpoint"],
    guidance: [
      "Playbook — address lookup. Follow these steps in order:",
      "1. search the exact address. Read matchedOn on each asset hit: \"ipAddress\" means it is the device's " +
        "current primary IP; \"ipHistory\" with heldThisAddress means the device held that address (WAN, " +
        "secondary or former) — it IS a hit, not a text coincidence. An `ipsec` hit means a FortiGate " +
        "(context.assetId) terminates a tunnel to that address or has a peer / VPN user connected from it — " +
        "report the gate, the tunnel or connection name, and the far-end device when context.peerAssetId is set.",
      "2. get_asset on each hit (by id) for its ipHistory and current state, so you can say when the address " +
        "was first and last seen on it and what the device's primary IP is now.",
      "3. list_reservations with search set to the address, for a reservation or lease that names it.",
      "4. find_endpoint with the ip: the MAC the gateways pair it with, the switch port it is on (the hit with " +
        "likelyAccessPort), or the access point for a wireless client.",
      "5. Answer: which device holds the address now (if any), which held it before and when, any " +
        "reservation, and where it is plugged in — each device linked to its details. If nothing holds it, say " +
        "what you checked. " + SEPARATE,
    ].join("\n"),
  },
  {
    id: "endpoint",
    label: "endpoint location",
    // A MAC literal (colon, dash or Cisco dotted; four octets or more, so a
    // time like 10:30:45 is not one), or where-is-it-plugged-in wording.
    // Last, after address.
    match: /\b([0-9a-f]{2}([:-])[0-9a-f]{2}(\2[0-9a-f]{2}){2,4}|[0-9a-f]{4}\.[0-9a-f]{4}\.[0-9a-f]{4})\b|\b(which|what) (switch )?port\b|\bplugged in(to)?\b|\b(which|what) (ap|access point)\b|\bconnected to (port|interface)\b|\bon (port|interface) \S+/i,
    firstRoundTools: ["find_endpoint", "search"],
    guidance: [
      "Playbook — endpoint location. Follow these steps in order:",
      "1. find_endpoint with the MAC or IP the person gave — or, for \"what is on port X of switch Y\", device and port.",
      "2. If they named a device rather than an address, search for it first and use its MAC or IP.",
      "3. Answer with the access port first (likelyAccessPort: switch, port, VLAN), then the gateway that " +
        "pairs the IP and MAC, then the access point, SSID and signal for a wireless client — each with how long " +
        "ago it was seen. A port that holds many MACs is an uplink, not where the device is plugged in; say so " +
        "if it is the only sighting. " + SEPARATE,
    ].join("\n"),
  },
];

/** The playbook a question triggers, first match wins; null when none fits. Exported for tests. */
export function pickPlaybook(question: string): AssistantPlaybook | null {
  const q = (question ?? "").trim();
  if (!q) return null;
  return PLAYBOOKS.find((p) => p.match.test(q)) ?? null;
}
