/**
 * tests/unit/winrm.test.ts — re-scan F84 (business rule 116). WinRM SOAP
 * responses come from the remote host and were parsed with backtracking
 * regexes on the event loop every collector shares. The parsers are now
 * indexOf-based and linear; these pin both that they still read real
 * WS-Management responses and that hostile bodies stay cheap.
 */

import { describe, it, expect, vi } from "vitest";

vi.mock("../../src/utils/pinnedTlsAgent.js", () => ({ pinnedAgentFor: () => undefined }));

import { faultReason, MAX_WINRM_BODY_BYTES, parseReceive, xmlAttr, xmlElement } from "../../src/utils/winrm.js";

const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");

const RECEIVE_DONE =
  `<s:Envelope xmlns:s="x" xmlns:rsp="y"><s:Body><rsp:ReceiveResponse>` +
  `<rsp:Stream Name="stdout" CommandId="C1">${b64("hello ")}</rsp:Stream>` +
  `<rsp:Stream Name="stderr" CommandId="C1">${b64("warn")}</rsp:Stream>` +
  `<rsp:Stream Name="stdout" CommandId="C1">${b64("world")}</rsp:Stream>` +
  `<rsp:Stream Name="stdout" CommandId="C1" End="true"></rsp:Stream>` +
  `<rsp:CommandState CommandId="C1" State="http://schemas.microsoft.com/wbem/wsman/1/windows/shell/CommandState/Done">` +
  `<rsp:ExitCode>3</rsp:ExitCode></rsp:CommandState>` +
  `</rsp:ReceiveResponse></s:Body></s:Envelope>`;

describe("WinRM response parsing", () => {
  it("reads streams in order, the Done state and the exit code", () => {
    expect(parseReceive(RECEIVE_DONE)).toEqual({ stdout: "hello world", stderr: "warn", done: true, exitCode: 3 });
  });

  it("a Running state is not done", () => {
    const xml = RECEIVE_DONE.replace("CommandState/Done", "CommandState/Running");
    expect(parseReceive(xml).done).toBe(false);
  });

  it("reads ShellId / CommandId whatever the prefix", () => {
    expect(xmlElement(`<rsp:Shell><rsp:ShellId>ABC-1</rsp:ShellId></rsp:Shell>`, "ShellId")?.content).toBe("ABC-1");
    expect(xmlElement(`<CommandId>X</CommandId>`, "CommandId")?.content).toBe("X");
    // A longer name that merely starts with the one asked for is not it.
    expect(xmlElement(`<rsp:ShellIdX>no</rsp:ShellIdX>`, "ShellId")).toBeNull();
  });

  it("reads a SOAP fault's reason text", () => {
    const fault = `<s:Fault><s:Code><s:Value>s:Receiver</s:Value></s:Code><s:Reason><s:Text xml:lang="en-US">Access is denied. </s:Text></s:Reason></s:Fault>`;
    expect(faultReason(fault)).toBe("Access is denied. ");
    expect(faultReason("<html>500</html>")).toBeNull();
  });

  it("an attribute is matched by whole name only", () => {
    expect(xmlAttr(` CommandId="C1" Name="stdout"`, "Name")).toBe("stdout");
    expect(xmlAttr(` XName="no"`, "Name")).toBeNull();
  });

  it("hostile bodies stay linear: thousands of unclosed openers parse in milliseconds", () => {
    const n = 200_000;
    const bodies = [
      "<Reason>" + "<Text>".repeat(n),
      '<rsp:Stream Name="stdout"'.repeat(n / 4),
      "<rsp:CommandState State=\"Done\">" + "<rsp:ExitCode>".repeat(n),
      "<".repeat(n * 5),
    ];
    const t0 = Date.now();
    for (const body of bodies) {
      faultReason(body);
      parseReceive(body);
      xmlElement(body, "ShellId");
    }
    expect(Date.now() - t0).toBeLessThan(2_000);
  });

  it("caps a response body", () => {
    expect(MAX_WINRM_BODY_BYTES).toBe(4 * 1024 * 1024);
  });
});
