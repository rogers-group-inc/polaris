/**
 * tests/unit/llmImages.test.ts
 *
 * Screenshots on a user turn (business rule 95(l)) in both dialects the llm
 * transport speaks — chat-completions content parts and Messages API image
 * blocks — and which configs may receive them at all.
 */

import { describe, it, expect } from "vitest";
import { acceptsImages, toOpenAiMessages, toAnthropicRequest, type ChatMessage } from "../../src/services/llmService.js";

const img = { mimeType: "image/png", base64: "iVBORw0KGgo=" };

describe("acceptsImages", () => {
  it("follows the operator's switch when it is set", () => {
    expect(acceptsImages({ acceptsImages: true })).toBe(true);
    expect(acceptsImages({ provider: "azure", azureApiShape: "anthropic", acceptsImages: false })).toBe(false);
  });

  it("unset, says yes only for a Claude deployment", () => {
    expect(acceptsImages({ provider: "azure", azureApiShape: "anthropic" })).toBe(true);
    expect(acceptsImages({ provider: "azure", azureApiShape: "v1" })).toBe(false);
    expect(acceptsImages({})).toBe(false);
  });
});

describe("toOpenAiMessages", () => {
  it("turns a user turn with images into text + image_url data-URL parts", () => {
    const out = toOpenAiMessages([{ role: "user", content: "what is this?", images: [img] }]);
    expect(out).toEqual([{
      role: "user",
      content: [
        { type: "text", text: "what is this?" },
        { type: "image_url", image_url: { url: "data:image/png;base64,iVBORw0KGgo=" } },
      ],
    }]);
  });

  it("passes every other message through unchanged", () => {
    const msgs: ChatMessage[] = [
      { role: "system", content: "s" },
      { role: "user", content: "plain" },
      { role: "assistant", content: "a" },
    ];
    expect(toOpenAiMessages(msgs)).toEqual(msgs);
  });
});

describe("toAnthropicRequest with images", () => {
  it("puts base64 image blocks before the text on the user turn", () => {
    const req = toAnthropicRequest([{ role: "system", content: "sys" }, { role: "user", content: "look", images: [img] }], []);
    expect(req.system).toBe("sys");
    expect(req.messages).toEqual([{
      role: "user",
      content: [
        { type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" } },
        { type: "text", text: "look" },
      ],
    }]);
  });
});
