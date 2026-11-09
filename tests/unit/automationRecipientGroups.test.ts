/**
 * tests/unit/automationRecipientGroups.test.ts
 *
 * The Automations list's Addresses column — `ruleRecipientGroups` in
 * public/js/automations-wizard.js, loaded out of the browser module via
 * node:vm (the automationRecipientPills.test.ts idiom).
 *
 * The column answers "who does this automation actually reach?" without
 * opening the wizard, so the properties worth pinning are the ones whose
 * failure mode is a confidently-wrong answer:
 *
 *   - EVERY action location is walked (base actions, per-action escalation
 *     chains, the rule-level chain, band actions and their chains, the
 *     band-level chain, dedicated resolved actions, reset actions). A missed
 *     location reads as "nobody is notified".
 *   - A chat/webhook channel posts to its OWN destination, so the action's
 *     recipient fields are ignored — listing them would name people who never
 *     get the message.
 *   - Cc/Bcc inheritance matches composeForNotify: a plain notify action
 *     inherits the rule's emailComposition wholesale, an escalation tier does
 *     not (it merges templates but takes cc/bcc from the action alone).
 *   - Legacy email-tier escalation (which the server's `withV2` read does NOT
 *     normalize) is understood, so a pre-v2 rule doesn't show an empty chain.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import vm from "node:vm";

interface Group {
  where: string;
  channel: string | null;
  channelType: string | null;
  fixedDestination: boolean;
  to: string[];
  cc: string[];
  bcc: string[];
}

let ruleRecipientGroups: (rule: unknown, catalogs: unknown) => Group[];
let normalizeEscalationV2: (esc: unknown) => unknown;

beforeAll(() => {
  const src = readFileSync(resolve(__dirname, "../../public/js/automations-wizard.js"), "utf8");
  const sandbox: Record<string, unknown> = {};
  sandbox.window = sandbox;
  sandbox.document = { addEventListener() {}, querySelector: () => null, getElementById: () => null };
  sandbox.setTimeout = setTimeout;
  sandbox.clearTimeout = clearTimeout;
  vm.createContext(sandbox);
  // The pill vocabulary lives in recipient-picker.js, which every page loads
  // before the wizard (2026-11-09).
  new vm.Script(readFileSync(resolve(__dirname, "../../public/js/recipient-picker.js"), "utf8"), { filename: "recipient-picker.js" }).runInContext(sandbox);
  new vm.Script(src, { filename: "automations-wizard.js" }).runInContext(sandbox);
  const api = (sandbox.window as Record<string, unknown>).PolarisAutomationRecipients as {
    ruleRecipientGroups: typeof ruleRecipientGroups;
    normalizeEscalationV2: typeof normalizeEscalationV2;
  };
  ruleRecipientGroups = api.ruleRecipientGroups;
  normalizeEscalationV2 = api.normalizeEscalationV2;
});

const CATALOGS = {
  users: [
    { id: "u1", username: "jdoe", displayName: "Jane Doe", email: "jane@example.com" },
    { id: "u2", username: "svc", displayName: null, email: null },
  ],
  roles: [{ id: "r1", name: "NOC" }],
  channels: [
    { id: "mail", name: "Corp SMTP", type: "smtp" },
    { id: "chat", name: "#alerts", type: "slack" },
  ],
};

const notify = (addresses: string[], extra?: Record<string, unknown>) =>
  ({ type: "notify", channelId: "mail", addresses, ...(extra ?? {}) });
const chain = (afterMin: number, addresses: string[]) =>
  ({ tiers: [{ afterMin, actions: [notify(addresses)] }] });
const flat = (groups: Group[]) => groups.flatMap((g) => [...g.to, ...g.cc, ...g.bcc]);

describe("ruleRecipientGroups", () => {
  it("walks every action location", () => {
    const rule = {
      actions: [notify(["base@example.com"], { escalation: chain(15, ["tier-a@example.com"]) })],
      escalation: chain(60, ["tier-r@example.com"]),
      severityBands: [
        {
          severity: "critical",
          actions: [notify(["band@example.com"], { escalation: chain(5, ["band-a@example.com"]) })],
          escalation: chain(30, ["band-r@example.com"]),
        },
      ],
      bandNotify: { resolvedMode: "dedicated", resolvedActions: [notify(["eased@example.com"])] },
      resetActions: [notify(["cleared@example.com"])],
    };
    expect(flat(ruleRecipientGroups(rule, CATALOGS)).sort()).toEqual([
      "band-a@example.com",
      "band-r@example.com",
      "band@example.com",
      "base@example.com",
      "cleared@example.com",
      "eased@example.com",
      "tier-a@example.com",
      "tier-r@example.com",
    ]);
  });

  it("names the per-action and rule-level chains apart", () => {
    const rule = {
      actions: [notify(["a@example.com"], { escalation: chain(15, ["x@example.com"]) })],
      escalation: chain(60, ["y@example.com"]),
    };
    expect(ruleRecipientGroups(rule, CATALOGS).map((g) => g.where)).toEqual([
      "When it fires",
      "Action 1 escalation tier 1 (after 15m)",
      "Escalation tier 1 (after 60m)",
    ]);
  });

  it("reuse-mode resolved actions are not their own group — the band's actions already are", () => {
    const rule = {
      actions: [],
      bandNotify: { resolvedMode: "reuse", resolvedActions: [notify(["nope@example.com"])] },
    };
    expect(ruleRecipientGroups(rule, CATALOGS)).toEqual([]);
  });

  it("a chat channel posts to its own destination, so the action's recipients are not listed", () => {
    const rule = { actions: [{ type: "notify", channelId: "chat", addresses: ["ignored@example.com"] }] };
    const [g] = ruleRecipientGroups(rule, CATALOGS);
    expect(g.fixedDestination).toBe(true);
    expect(g.channel).toBe("#alerts");
    expect(flat([g])).toEqual([]);
  });

  it("resolves a Polaris account to its email, and to the account name without one", () => {
    const rule = { actions: [{ type: "notify", channelId: "mail", recipientUserIds: ["u1", "u2", "gone"] }] };
    expect(ruleRecipientGroups(rule, CATALOGS)[0].to).toEqual(["jane@example.com", "svc", "(unknown user)"]);
  });

  it("labels roles, regions and the fire-time dynamic recipients", () => {
    const rule = {
      actions: [{
        type: "notify",
        channelId: "mail",
        recipientRoles: ["r1"],
        recipientRegions: ["Atlanta"],
        recipientDeviceRegion: true,
        recipientAssetContacts: true,
        recipientAllUsers: true,
      }],
    };
    const to = ruleRecipientGroups(rule, CATALOGS)[0].to;
    expect(to).toContain("Role: NOC");
    expect(to).toContain("Region: Atlanta");
    expect(to).toContain("All users");
    expect(to.some((t) => /Region Users/.test(t))).toBe(true);
    expect(to.some((t) => /Responsible Contacts/.test(t))).toBe(true);
  });

  it("a plain action inherits the rule's Cc; an escalation tier does not", () => {
    const rule = {
      actions: [notify(["a@example.com"], { escalation: chain(15, ["t@example.com"]) })],
      emailComposition: { cc: { addresses: ["boss@example.com"] } },
    };
    const [base, tier] = ruleRecipientGroups(rule, CATALOGS);
    expect(base.cc).toEqual(["boss@example.com"]);
    expect(tier.cc).toEqual([]);
  });

  it("understands legacy email-tier escalation, which the read path does not normalize", () => {
    const rule = {
      actions: [],
      escalation: {
        tiers: [{
          afterMin: 45,
          channelId: "mail",
          to: { addresses: ["oncall@example.com"] },
          cc: { addresses: ["cc@example.com"] },
        }],
      },
    };
    const [g] = ruleRecipientGroups(rule, CATALOGS);
    expect(g.where).toBe("Escalation tier 1 (after 45m)");
    expect(g.to).toEqual(["oncall@example.com"]);
    expect(g.cc).toEqual(["cc@example.com"]);
  });

  it("normalizeEscalationV2 leaves an already-v2 chain alone", () => {
    const v2 = { stopOn: "clear", tiers: [{ afterMin: 5, actions: [{ type: "event" }] }] };
    expect(normalizeEscalationV2(v2)).toBe(v2);
  });

  it("survives missing catalogs rather than dropping recipients", () => {
    const rule = { actions: [notify(["a@example.com"], { recipientUserIds: ["u1"] })] };
    const [g] = ruleRecipientGroups(rule, {});
    expect(g.channel).toBeNull();
    expect(g.fixedDestination).toBe(false);
    expect(g.to).toEqual(["(unknown user)", "a@example.com"]);
  });

  it("ignores non-notify actions", () => {
    const rule = {
      actions: [{ type: "script", scriptId: "s1", runOn: "server" }, { type: "event" }, { type: "api_call", url: "https://x" }],
    };
    expect(ruleRecipientGroups(rule, CATALOGS)).toEqual([]);
  });
});
