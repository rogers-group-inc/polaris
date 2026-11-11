/**
 * tests/unit/withSnmpGate.test.ts
 *
 * Bounded-wait queue behavior for the per-SNMP-agent serialization gate in
 * monitoringService.withSnmpGate. The gate FIFO-serializes all SNMP calls
 * against the same host:port so net-snmp's single-conversation state isn't
 * stepped on; this suite locks in the post-timeout-refactor invariants:
 *
 *  - Two queued calls on the same key run sequentially in FIFO order
 *  - Different keys (host:port) don't serialize against each other
 *  - A waiter that exceeds POLARIS_SNMP_GATE_WAIT_TIMEOUT_MS rejects with a
 *    clear error while the wedged running slot still completes normally
 *  - Drain continues correctly after a timed-out waiter (the next viable
 *    waiter still acquires the gate when the running slot returns)
 *
 * Timeouts run on a 50ms budget so the suite stays sub-second.
 */

import { describe, it, expect, afterEach } from "vitest";
import { withSnmpGate } from "../../src/services/monitoring/snmpCore.js";

const ORIGINAL_TIMEOUT_ENV = process.env.POLARIS_SNMP_GATE_WAIT_TIMEOUT_MS;

afterEach(() => {
  if (ORIGINAL_TIMEOUT_ENV === undefined) delete process.env.POLARIS_SNMP_GATE_WAIT_TIMEOUT_MS;
  else process.env.POLARIS_SNMP_GATE_WAIT_TIMEOUT_MS = ORIGINAL_TIMEOUT_ENV;
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("withSnmpGate", () => {
  it("serializes two callers on the same host:port in FIFO order", async () => {
    const order: string[] = [];

    const a = withSnmpGate("10.0.0.1", 161, async () => {
      order.push("a-start");
      await sleep(20);
      order.push("a-end");
      return "a";
    });
    // Enqueue b immediately — same key, so it must wait for a.
    const b = withSnmpGate("10.0.0.1", 161, async () => {
      order.push("b-start");
      return "b";
    });

    const [ra, rb] = await Promise.all([a, b]);
    expect(ra).toBe("a");
    expect(rb).toBe("b");
    expect(order).toEqual(["a-start", "a-end", "b-start"]);
  });

  it("does not serialize across different host:port keys", async () => {
    const order: string[] = [];
    const a = withSnmpGate("10.0.0.2", 161, async () => {
      order.push("a-start");
      await sleep(20);
      order.push("a-end");
    });
    const b = withSnmpGate("10.0.0.3", 161, async () => {
      order.push("b-start");
      await sleep(5);
      order.push("b-end");
    });
    await Promise.all([a, b]);
    // b's start must precede a's end — they ran concurrently
    expect(order.indexOf("b-start")).toBeLessThan(order.indexOf("a-end"));
  });

  it("rejects a waiter that exceeds POLARIS_SNMP_GATE_WAIT_TIMEOUT_MS while the running slot still completes", async () => {
    process.env.POLARIS_SNMP_GATE_WAIT_TIMEOUT_MS = "50";

    // Wedge the gate with a slot that takes longer than the timeout window.
    const wedge = withSnmpGate("10.0.0.4", 161, async () => {
      await sleep(150);
      return "wedge-done";
    });
    // This waiter should reject before the wedge returns.
    const waiter = withSnmpGate("10.0.0.4", 161, async () => "should-never-run");

    await expect(waiter).rejects.toThrow(/SNMP gate timeout for 10\.0\.0\.4:161 after \d+ms/);
    // The wedge itself is unaffected by the waiter's rejection.
    await expect(wedge).resolves.toBe("wedge-done");
  });

  it("drains correctly after a timed-out waiter: a later-enqueued caller still runs when the wedge completes", async () => {
    process.env.POLARIS_SNMP_GATE_WAIT_TIMEOUT_MS = "50";

    const wedge = withSnmpGate("10.0.0.5", 161, async () => {
      await sleep(120);
      return "wedge";
    });
    // Times out before the wedge returns.
    const dead = withSnmpGate("10.0.0.5", 161, async () => "dead");
    // Enqueued after dead. Should also time out (it's enqueued while the
    // wedge is still running, and waits the same 50ms-from-enqueue window).
    const dead2 = withSnmpGate("10.0.0.5", 161, async () => "dead2");

    await expect(dead).rejects.toThrow(/SNMP gate timeout/);
    await expect(dead2).rejects.toThrow(/SNMP gate timeout/);
    await expect(wedge).resolves.toBe("wedge");

    // After the wedge completes and the dead/dead2 slots are drained as
    // timed-out, the gate should be empty and a fresh caller should run
    // immediately without queueing behind ghost entries.
    const fresh = await withSnmpGate("10.0.0.5", 161, async () => "fresh");
    expect(fresh).toBe("fresh");
  });

  it("honors a per-call waitTimeoutMs override over the env default", async () => {
    // Env default would reject waiters at 30ms; the override extends one
    // specific waiter past the wedge so it runs instead of timing out.
    // This is the operator snmp-walk path: its budget is the walk tab's
    // client countdown, not the collectors' fail-fast default.
    process.env.POLARIS_SNMP_GATE_WAIT_TIMEOUT_MS = "30";

    const wedge = withSnmpGate("10.0.0.7", 161, async () => {
      await sleep(80);
      return "wedge";
    });
    // Default-budget waiter: times out at ~30ms while the wedge runs.
    const dead = withSnmpGate("10.0.0.7", 161, async () => "dead");
    // Override-budget waiter: outlasts the wedge and runs.
    const patient = withSnmpGate("10.0.0.7", 161, async () => "patient", 500);

    await expect(dead).rejects.toThrow(/SNMP gate timeout/);
    await expect(patient).resolves.toBe("patient");
    await expect(wedge).resolves.toBe("wedge");
  });

  it("propagates the underlying fn rejection unchanged", async () => {
    const err = new Error("upstream snmp failure");
    await expect(
      withSnmpGate("10.0.0.6", 161, async () => { throw err; }),
    ).rejects.toBe(err);
  });
});
