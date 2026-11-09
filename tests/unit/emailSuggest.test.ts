/**
 * tests/unit/emailSuggest.test.ts — public/js/email-suggest.js, the firmware
 * dialog's address-book typeahead (rule 93): it suggests for the entry being
 * typed, replaces only that entry, and never offers an address already in
 * the box.
 */
// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const g = globalThis as Record<string, any>;

beforeEach(() => {
  (0, eval)(readFileSync(resolve(__dirname, "../../public/js/email-suggest.js"), "utf8"));
});

describe("token helpers (pure)", () => {
  it("the current entry is what follows the last comma or semicolon", () => {
    const S = g.PolarisEmailSuggest;
    expect(S.currentToken("ops@example.com, al")).toBe("al");
    expect(S.currentToken("ops@example.com; noc")).toBe("noc");
    expect(S.currentToken("bob")).toBe("bob");
    expect(S.currentToken("ops@example.com, ")).toBe("");
  });
  it("picking replaces only the current entry and leaves room for the next", () => {
    const S = g.PolarisEmailSuggest;
    expect(S.replaceToken("ops@example.com, al", "alice@example.com")).toBe("ops@example.com, alice@example.com, ");
    expect(S.replaceToken("al", "alice@example.com")).toBe("alice@example.com, ");
  });
});

describe("attach", () => {
  it("offers address-book matches for the entry being typed, skips ones already chosen, and fills the pick in", async () => {
    vi.useFakeTimers();
    const search = vi.fn(async () => ({ entries: [
      { email: "ops@example.com", name: "Ops" },
      { email: "alice@example.com", name: "Alice Martin" },
    ] }));
    g.api = { contacts: { search } };
    const wrap = document.createElement("div");
    wrap.style.position = "relative";
    const input = document.createElement("input");
    wrap.appendChild(input);
    document.body.appendChild(wrap);
    const onChange = vi.fn();
    g.PolarisEmailSuggest.attach(input, { onChange });

    input.value = "ops@example.com, al";
    input.dispatchEvent(new Event("input"));
    await vi.advanceTimersByTimeAsync(300);
    expect(search).toHaveBeenCalledWith("al", false);   // the address book, not the live directory
    const items = wrap.querySelectorAll(".email-suggest-item");
    expect(items).toHaveLength(1);                       // ops@ is already in the box
    expect(items[0].textContent).toContain("Alice Martin");

    items[0].dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    expect(input.value).toBe("ops@example.com, alice@example.com, ");
    expect(onChange).toHaveBeenCalled();
    expect((wrap.querySelector(".email-suggest") as HTMLElement).style.display).toBe("none");
    vi.useRealTimers();
  });

  it("without the contacts API it is just a text box", async () => {
    vi.useFakeTimers();
    g.api = {};
    const wrap = document.createElement("div");
    const input = document.createElement("input");
    wrap.appendChild(input);
    g.PolarisEmailSuggest.attach(input);
    input.value = "alice";
    input.dispatchEvent(new Event("input"));
    await vi.advanceTimersByTimeAsync(300);
    expect((wrap.querySelector(".email-suggest") as HTMLElement).style.display).toBe("none");
    vi.useRealTimers();
  });
});
