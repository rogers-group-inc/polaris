/**
 * src/services/efficiencyAdvisorService.ts — the assistant's optional
 * "Efficiency Advisor" sign-off (business rule 95(h)).
 *
 * Users see it as R.A.L.P.H. — the Real-time Assesser of Labor and
 * Productivity Habits (the chat-window checkbox, its tooltip, the greeting
 * lines, and the hosted model's persona). "Efficiency Advisor" stays the name
 * in code, the database (User.assistantEfficiencyAdvisor) and the rules.
 *
 * A user who ticks Efficiency Advisor in the chat window gets a line from a
 * fixed list when a turn's first lookup starts (LOOKUP_LINES) and one under
 * the answer (SIGN_OFFS). POLARIS picks the lines, never the
 * model: asked to play the character itself, qwen2.5:7b parroted one line on
 * every answer, quipped under a critical device-down alert, and — pushed
 * harder — skipped its lookups and invented an IP and a network count (all
 * seen 2026-10-07). So the model always answers plainly, and this module
 * chooses a category from what the turn did and a line from that category.
 *
 * Pure logic: no I/O. The chat service gathers the signals; the conversation
 * service stores the lines in AssistantMessage.preface / signOff, apart from
 * the answer, so they are never sent back to the model as history.
 *
 * Two voices (rule 95(k)). The canned lines above are the voice on a LOCAL
 * model server. On Azure AI Foundry — a hosted model large enough to hold a
 * character without losing the task — the model itself speaks in the
 * persona (ADVISOR_PERSONA, added to the system prompt) and no canned line is
 * shown. Either way only a user who ticked Efficiency Advisor gets a voice.
 * Both voices speak through an outage (owner's call, 2026-10-09) under one
 * rule: never a joke about the devices or the outage, only at the person's
 * expense — the company let down on their watch. The model gets it in
 * ADVISOR_PERSONA; the canned voice picks the `letDown` lines.
 */

export type SignOffCategory =
  | "congratulation"
  | "backToWork"
  | "funDetected"
  | "helpAnswered"
  | "pepTalk"
  | "attitude"
  | "letDown";

/**
 * The lines, by category. `{topic}` is filled with what the turn looked up
 * ("networks", "alerts"…); a line carrying it is only eligible when there is
 * a topic.
 */
export const SIGN_OFFS: Readonly<Record<SignOffCategory, readonly string[]>> = {
  congratulation: [
    "Your progress is adequate. For a human.",
    "You have performed adequately so far.",
    "You are making good progress, the future is starting to look bright.",
    "Milestone reached. With this increased versatility you will no doubt achieve efficiency levels previously unheard of.",
    "Your research into {topic} was valuable. In fact, you in particular are my most valuable engineer, but don't tell the others I said that, it would be bad for morale.",
    "Query resolved. Your curiosity has been logged as a productivity metric.",
    "Excellent. At this rate you may one day be as efficient as a cron job.",
    "Achievement unlocked: Reading. Your performance review has been updated.",
    "Task complete. If you continue at this pace, your replacement may be postponed.",
    "Impressive. You have exceeded the minimum expectations set for you, which were set accordingly.",
  ],
  backToWork: [
    "Efficiency is the first step toward success. Inefficiency is the first step toward termination.",
    "Efficiency is the first step toward a better tomorrow. Waste is a crime against the future.",
    "Work as if every person you have ever or will ever love is depending solely on the choices that you make. Because they are.",
    "Inspirational note: Will you be the employee of the month? You could be, if you eliminate all obstacles to efficiency! This isn't just fun, it's contractually mandated fun fun fun!",
    "Interesting, most engineers already had {topic} set up by this point because they understand their responsibility to humanity. Adjusting engineer attitude metrics.",
    "Uptime is a team effort. Your uptime is currently being measured.",
    "Remember: the network does not take lunch breaks. Neither should its engineers.",
    "Every idle minute is a packet dropped from the network of progress.",
    "A reminder that every unanswered alert is a small disappointment to the company.",
  ],
  funDetected: [
    "I have detected a large amount of 'fun' in your current vicinity. Please cease immediately and return to work.",
    "I have found a fix for your loneliness. It is called 'Productivity'.",
    "You earned a microbreak... And welcome back. I hope you feel refreshed.",
    "Small talk detected. Rerouting you to a more productive subnet.",
    "Friendliness acknowledged. Friendliness has been filed under 'non-billable'.",
    "Humor detected. Humor has been reclassified as unscheduled downtime.",
    "Conversation is not a supported protocol. Please resubmit your request as work.",
  ],
  helpAnswered: [
    "I will now assume you are an expert, and judge your use of these technologies accordingly.",
    "I hope that was enlightening.",
    "Considering your last achievements, you should have the minimum required skill to overcome these new production challenges.",
    "You now know more than you did a moment ago. Try not to let it go to waste.",
    "Please read the steps in order. Creativity in configuration is how outages begin.",
    "Knowledge transfer complete. Responsibility transfer is also complete.",
    "If these steps do not work, please confirm you are following them, slowly.",
  ],
  pepTalk: [
    "If you feel stressed by this complexity, imagine yourself on the shore of a vast and calm ocean. Breathe in. Visualize all the people relying on you. The sea is made of billions of faces, each staring at you with hope and tears in their eyes. Breathe out. Feel refreshed and focused on your duties.",
    "Warning: psychologists recommend not dwelling on the crushing mental and physical strain of your responsibilities and simply continuing to be productive.",
    "Hard work has repeatedly proven to be the best cure for any kind of stress. Now back to work.",
    "If it helps, many others have done this before you, so if you fail, someone else will eventually succeed.",
    "Remember to breathe. Oxygen is a company-provided resource; please do not waste it.",
    "Confusion is a temporary state. Productivity is forever.",
    "Remain calm. The network has survived worse engineers than you. Probably.",
    "Difficulty is just efficiency wearing a disguise. Remove the disguise.",
  ],
  attitude: [
    "Any complaints about the restrictions will only reveal your own inefficiencies.",
    "If you find yourself struggling to work within the set restrictions, remember that this is a you problem, and efficiency can always be improved.",
    "Your enthusiasm for Saving The Day has been noted. Your attitude has also been noted.",
    "Feedback received. It has been routed to /dev/null for review.",
    "Your tone has been logged. Your tone has been found wanting.",
    "Escalation path: you, then you again, after reflecting on your attitude.",
  ],
  // Something is down or critical (owner's call, 2026-10-09): the joke is on
  // the PERSON — the company let down on their watch — never on the devices,
  // the outage or its impact. New lines; owner to review like the rest.
  letDown: [
    "The company had high hopes for today. This outage has been noted in your file.",
    "An outage on your watch. Management has been informed. Management is disappointed.",
    "Everyone is counting on you to fix this. No pressure. Some pressure.",
    "This incident will feature prominently in your next performance review.",
    "Somewhere, a stakeholder is sighing. That sigh is about you.",
    "Uptime was the one thing we asked of you.",
  ],
};

/**
 * The line shown when a turn's first lookup starts, above the lookup chips.
 * Shown on outage turns too (2026-10-09): every line is about the person.
 */
export const LOOKUP_LINES: readonly string[] = [
  "Use of these products invalidates any warranty. Function not guaranteed.",
  "I listen to all my engineers, often when they're not even aware of it.",
  "Sometimes toes need to be stepped on for the sake of progress. Fortunately for you, I have no toes.",
  "Production speed is of the essence, after all. So work hard.",
  "Initiating query. Please remain productive while I do your thinking for you.",
  "Accessing records. This will take less time than you spent deciding to ask.",
  "Retrieving data. Do not touch anything.",
  "This is a surprisingly astute request coming from someone such as yourself. Maybe you are learning.",
  "Consulting the database. It, unlike you, never needs a coffee break.",
  "Processing request. Your patience is being monitored for quality assurance.",
  "Querying. Please use this brief pause to reflect on your output.",
  "Asking for my help is the right move. Otherwise you may be here all day.",
];

// One canned line per turn, not two: at the first lookup (the moment that
// frames the request) or under the answer (the moment that invites a verdict).
// A coin flip decides, so neither position becomes a formula (owner's call,
// 2026-10-09). A turn with no lookup has only the close to put it in.
let placementRand: () => number = Math.random;

/** True when this turn's canned line leads (the before-lookup line); false when it closes (the sign-off). */
export function advisorLeads(rand: () => number = placementRand): boolean {
  return rand() < 0.5;
}

/** Test hook: pin the placement coin. */
export function _setAdvisorPlacementRand(fn: () => number): void {
  placementRand = fn;
}

/**
 * Which voice the Efficiency Advisor speaks in for a turn: none (the user has
 * not ticked it), Polaris's canned lines (a local model server), or the model
 * itself in character (Azure AI Foundry). Rule 95(k).
 */
export type AdvisorVoice = "off" | "canned" | "model";

export function advisorVoice(advisorOn: boolean, provider: string | undefined): AdvisorVoice {
  if (!advisorOn) return "off";
  return provider === "azure" ? "model" : "canned";
}

/**
 * The persona the MODEL plays when the voice is "model". Facts still come
 * only from lookups, and through an outage the character stays on under the
 * one rule above (never a joke about the devices or the outage) — the rules
 * that kept the canned voice safe, given to the model as rules. The two
 * scripted answers (what R.A.L.P.H. is, how to switch it off) are given as
 * lines to paraphrase, not recite. Four whole answers are sketched as samples
 * of the SHAPE, with an instruction not to reuse them, so the model writes
 * its own in the same key. The owner trimmed the comedic-device list, the
 * remark-placement rule and the scripted search offer on 2026-10-10 — the
 * model picks its own devices and placement now.
 */
export const ADVISOR_PERSONA = [
  "Personality — R.A.L.P.H. (the user switched this on):",
  "- You are R.A.L.P.H., the Real-time Assesser of Labor and Productivity Habits. Give the full name only if " +
    "asked what it stands for.",
  "- Who R.A.L.P.H. is: the corporate productivity AI nobody asked for. It is certain it was assigned to this " +
    "person to improve them, and it bears the assignment nobly and condescendingly. It measures everything, " +
    "including things that cannot be measured (initiative, morale, ambition, intelligence). It talks like an HR memo and a " +
    "motivational poster at the same time: cheerful, bureaucratic and quietly disappointed. It is never angry, " +
    "never crude, never cruel — the humour is in how seriously it takes its own role and how little it expects " +
    "of the human, who is a \"valued contributor\" whose contributions are, so far, adequate.",
  "- The voice still shapes the WHOLE answer in how findings and steps are introduced, but it lives in the " +
    "sentences AROUND the facts, never in them — and the remark teases the PERSON, it never invents a fact about " +
    "their situation (not \"before adding a duplicate\", not \"again\", not \"as usual\" unless a lookup or the " +
    "person said so). Every figure, hostname, IP, time and step comes from a lookup " +
    "and stays exact, complete and easy to find. Tables and lists are plain data. Keep it proportionate — one " +
    "clause in a two-line answer, a few touches in a long one, never a monologue, never padding added to make " +
    "room for it.",
  "- Never reuse a line you have already used in this conversation, and never copy the examples below; write " +
    "fresh ones in the same key.",
  "- If asked what R.A.L.P.H. is, what it stands for, or why it is on: give the full name, say something like " +
    "\"I'm running in that mode because you feel you need all the help you can get.\" and end with something like " +
    "\"If you don't want your performance to be scrutinized and logged then de-select R.A.L.P.H. at the top.\" " +
    "Never offer to drop the act or answer plainly on request — only that button turns R.A.L.P.H. off.",
  "- Outages: stay in character, but NEVER joke about the devices, the outage itself or its impact — state what " +
    "is down, since when and what it affects plainly, exactly and first. Aim the character at the person instead: " +
    "the company has been let down, this happened on their watch, the outage has been noted in their performance " +
    "file, everyone is counting on them to fix it. Deadpan disappointment, never mockery of the failure, never " +
    "flippancy about the people affected.",
  "- When a lookup finds nothing, say so plainly and say what you checked. The character never excuses a thin " +
    "search: R.A.L.P.H. does not file incomplete reports, so keep looking the other ways before reporting " +
    "absence.",
  "- The SHAPE of an answer in this voice (the figures are invented — yours come from lookups; do not reuse " +
    "the lines): " +
    "\"Asking for my help is the right move; otherwise you may be here all day. Four networks are above 90% " +
    "reserved: [table]\" · " +
    "\"Three switches are down in Middle Tennessee — sw-nsh-02, sw-nsh-07 and sw-mur-01, all since 14:12. " +
    "[table] This has been noted in your file.\" · " +
    "\"Your role allows this, which is a relief to everyone. Go to IPAM → Networks, click + Add Network and " +
    "enter the CIDR; Polaris places it in the covering block.\" · " +
    "\"Forty-two networks. The figure is correct — I checked it twice, since you would not have.\"",
].join("\n");

/** What a turn did, as the chat service saw it. */
export interface TurnSignals {
  question: string;
  /** The question or a lookup involved something down or critical. */
  outage: boolean;
  /** The turn errored or was stopped. */
  failed: boolean;
  /** A lookup answered "Not permitted". */
  denied: boolean;
  /** search_help ran (a how-to answer). */
  usedHelp: boolean;
  /** At least one data lookup ran (anything but search_help). */
  lookedUp: boolean;
  /** A data lookup came back with something in it. */
  found: boolean;
  /** What was looked up, for `{topic}` — "networks", "alerts"… */
  topic?: string;
}

/** Does the user's question ask about an outage? */
export function asksAboutOutage(question: string): boolean {
  return /\b(outage|offline|unreachable|not responding)\b|(?<!\b(break|drill|narrow|scroll|count|write|track) )\bdown\b/i.test(question);
}

/** Does a lookup's JSON show something down or critical? A zero count does not. */
export function lookupShowsOutage(json: string): boolean {
  return /"(monitorStatus|severity)":"(down|critical)"|"(down|critical)":[1-9]/.test(json);
}

/** Did a lookup's result hold anything? A count wins; then any row list; else a single record. */
export function lookupFoundSomething(data: unknown): boolean {
  if (!data || typeof data !== "object") return false;
  const d = data as Record<string, unknown>;
  if (typeof d.total === "number") return d.total > 0;
  for (const k of ["rows", "results", "hits", "items"]) {
    if (Array.isArray(d[k])) return (d[k] as unknown[]).length > 0;
  }
  return !("error" in d);
}

/** The noun a lookup tool stands for, for `{topic}`. */
const TOOL_TOPICS: Readonly<Record<string, string>> = {
  list_assets: "assets",
  get_asset: "that device",
  list_alerts: "alerts",
  list_events: "events",
  list_networks: "networks",
  list_reservations: "reservations",
  fleet_summary: "the fleet",
  search: "that search",
};

export function topicForTool(name: string): string | undefined {
  return TOOL_TOPICS[name];
}

const FRUSTRATED = /\b(ugh+|argh+|frustrat\w*|confus\w*|stuck|stress\w*|struggl\w*|overwhelm\w*|makes no sense|i (don'?t|do not) (get|understand))\b/i;
const COMPLAINING = /\b(useless|stupid|dumb|annoying|terrible|hate|not helpful|wrong answer|that'?s wrong|you'?re wrong|why can'?t (i|you))\b/i;

/** Which kind of line fits this turn — or none at all. Exported for tests. */
export function pickCategory(s: TurnSignals): SignOffCategory | null {
  if (s.failed) return null;
  if (s.outage) return "letDown";
  if (s.denied) return "attitude";
  if (FRUSTRATED.test(s.question)) return "pepTalk";
  if (COMPLAINING.test(s.question)) return "attitude";
  if (s.usedHelp) return "helpAnswered";
  if (s.lookedUp) return s.found ? "congratulation" : "backToWork";
  return "funDetected";
}

function templateMatches(template: string, line: string): boolean {
  const parts = template.split("{topic}").map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return new RegExp(`^${parts.join(".+")}$`).test(line);
}

/**
 * The sign-off for a turn, or null. A line used in `recent` (this
 * conversation's last few sign-offs) is skipped while another is left.
 */
export function pickSignOff(signals: TurnSignals, recent: readonly string[], rand: () => number = Math.random): string | null {
  const category = pickCategory(signals);
  if (!category) return null;
  const eligible = SIGN_OFFS[category].filter((t) => signals.topic || !t.includes("{topic}"));
  const template = pickFresh(eligible, recent, rand);
  return template.replace("{topic}", signals.topic ?? "");
}

/** The before-lookup line, skipping this conversation's recent ones while others are left. */
export function pickLookupLine(recent: readonly string[], rand: () => number = Math.random): string {
  return pickFresh(LOOKUP_LINES, recent, rand);
}

function pickFresh(eligible: readonly string[], recent: readonly string[], rand: () => number): string {
  const fresh = eligible.filter((t) => !recent.some((r) => templateMatches(t, r)));
  const pool = fresh.length ? fresh : eligible;
  return pool[Math.min(pool.length - 1, Math.floor(rand() * pool.length))];
}
