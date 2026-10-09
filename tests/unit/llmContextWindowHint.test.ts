/**
 * tests/unit/llmContextWindowHint.test.ts — the AI Assistant form's Context
 * window hint names the provider's numbers.
 *
 * The window sizes every turn on every provider (assistantChatService
 * → contextBudget). The hint used to speak only of Ollama, so an operator on
 * Azure AI Foundry read it as a local-only setting and left a 1M-token Claude
 * deployment at the 8192 default — trimming history and lookups as if the
 * model were small. The helper is a pure string function, extracted from the
 * shipped source and evaluated, as fortigatePushTabCopy.test.ts does.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const js = readFileSync(resolve(__dirname, "../../public/js/integrations.js"), "utf8").replace(/\r\n/g, "\n");

function grab(name: string): string {
  const i = js.indexOf("\nfunction " + name + "(");
  if (i < 0) throw new Error(name + " not found in integrations.js");
  return js.slice(i, js.indexOf("\n}\n", i) + 3);
}

// eslint-disable-next-line @typescript-eslint/no-implied-eval
const hint = new Function(grab("_llmContextWindowHint") + "\nreturn _llmContextWindowHint;")() as (azure: boolean) => string;

describe("AI Assistant form — Context window hint", () => {
  it("on Azure AI Foundry names the 1M Claude window and why a large window is safe", () => {
    const h = hint(true);
    expect(h).toContain("<code>1000000</code>");
    expect(h).toMatch(/Haiku 5\.5/);
    expect(h).toMatch(/Messages of history sent/);
    expect(h).not.toMatch(/Ollama/);
  });

  it("on a local server keeps the Ollama guidance", () => {
    expect(hint(false)).toMatch(/OLLAMA_CONTEXT_LENGTH/);
  });

  it("is drawn on first render and swapped by the provider toggle", () => {
    expect(js).toContain('<p class="hint" id="f-contextWindow-hint">\' + _llmContextWindowHint(azure) + \'</p>');
    expect(grab("_applyLlmProvider")).toContain("ctxHint.innerHTML = _llmContextWindowHint(azure)");
  });
});
