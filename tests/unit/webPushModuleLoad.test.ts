/**
 * tests/unit/webPushModuleLoad.test.ts
 *
 * Loads the web-push channel against the REAL `web-push` package — no mock.
 *
 * web-push 4.0 became a pure ES module with named exports only. The channel's
 * old `import webpush from "web-push"` still type-checked (esModuleInterop over
 * @types/web-push) and the unit suite still passed (its mock supplied a
 * `default`), but the real module has no default export, so a Node process
 * importing the channel failed to link. This test is the one place the real
 * package is exercised, so a default-vs-named mismatch fails here, not in
 * production.
 */

import { describe, expect, it } from "vitest";

describe("web-push channel against the real package", () => {
  it("imports and generates a VAPID keypair", async () => {
    const { generateVapidKeys } = await import("../../src/services/notificationChannels/webPushChannel.js");
    const keys = generateVapidKeys();
    expect(keys.publicKey).toMatch(/^[A-Za-z0-9_-]{80,}$/);
    expect(keys.privateKey).toMatch(/^[A-Za-z0-9_-]{40,}$/);
  });
});
