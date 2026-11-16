/**
 * tests/unit/emailChannel.test.ts — the two email transports (CQ-T010).
 *
 * SMTP (nodemailer) and Microsoft 365 Graph sendMail. Both transports are
 * mocked at the module boundary: nodemailer.createTransport, netGuard's
 * resolveAllowedHost (rule 110: connect to the CHECKED address, TLS verifies
 * the typed name), and the global fetch for the Graph token + sendMail calls.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { createTransport, sendMail, resolveAllowedHost } = vi.hoisted(() => {
  const sendMail = vi.fn();
  return {
    sendMail,
    createTransport: vi.fn((_opts: Record<string, unknown>) => ({ sendMail })),
    resolveAllowedHost: vi.fn(),
  };
});
vi.mock("nodemailer", () => ({ default: { createTransport } }));
vi.mock("../../src/utils/netGuard.js", () => ({ resolveAllowedHost }));

import {
  sendSmtpEmail,
  sendM365Email,
  buildGraphMessage,
  type SmtpConfig,
  type M365Config,
  type EmailMessage,
} from "../../src/services/notificationChannels/emailChannel.js";
import { AppError } from "../../src/utils/errors.js";

const smtp = (over: Partial<SmtpConfig> = {}): SmtpConfig => ({
  host: "mail.example.com",
  port: 587,
  security: "starttls",
  username: "alerts@example.com",
  password: "pw",
  from: "Polaris <alerts@example.com>",
  ...over,
});

const msg = (over: Partial<EmailMessage> = {}): EmailMessage => ({
  to: "ops@example.com",
  subject: "Down",
  text: "plain body",
  ...over,
});

const transportOpts = () => createTransport.mock.calls[0]![0] as Record<string, any>;
const sentMail = () => sendMail.mock.calls[0]![0] as Record<string, any>;

beforeEach(() => {
  createTransport.mockClear();
  sendMail.mockReset();
  sendMail.mockResolvedValue({ messageId: "x" });
  resolveAllowedHost.mockReset();
  resolveAllowedHost.mockResolvedValue("203.0.113.25");
});

describe("sendSmtpEmail — config and host guard", () => {
  it("refuses a channel with no host as a 400 before resolving anything", async () => {
    await expect(sendSmtpEmail(smtp({ host: "" }), msg())).rejects.toMatchObject({ httpStatus: 400, message: /missing a host/ });
    expect(resolveAllowedHost).not.toHaveBeenCalled();
    expect(createTransport).not.toHaveBeenCalled();
  });

  it("resolves the host with loopback allowed (a local relay is ordinary)", async () => {
    await sendSmtpEmail(smtp(), msg());
    expect(resolveAllowedHost).toHaveBeenCalledWith("mail.example.com", { allowLoopback: true });
  });

  it("turns a BLOCKED_HOST refusal into a 400 AppError and never opens a transport", async () => {
    resolveAllowedHost.mockRejectedValue(Object.assign(new Error("host 169.254.169.254 is blocked"), { code: "BLOCKED_HOST" }));
    const err = await sendSmtpEmail(smtp({ host: "169.254.169.254" }), msg()).catch((e) => e);
    expect(err).toBeInstanceOf(AppError);
    expect(err).toMatchObject({ httpStatus: 400, message: "host 169.254.169.254 is blocked" });
    expect(createTransport).not.toHaveBeenCalled();
  });

  it("rethrows any other resolver failure unchanged", async () => {
    const boom = Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" });
    resolveAllowedHost.mockRejectedValue(boom);
    await expect(sendSmtpEmail(smtp(), msg())).rejects.toBe(boom);
  });

  it("connects a NAMED host to the checked address and verifies TLS against the typed name", async () => {
    await sendSmtpEmail(smtp(), msg());
    expect(transportOpts()).toMatchObject({ host: "203.0.113.25", tls: { servername: "mail.example.com" } });
  });

  it("keeps the typed name when the resolver returns nothing", async () => {
    resolveAllowedHost.mockResolvedValue(null);
    await sendSmtpEmail(smtp(), msg());
    expect(transportOpts().host).toBe("mail.example.com");
    expect(transportOpts().tls).toBeUndefined();
  });

  it("passes an IPv4 literal straight through with no servername override", async () => {
    resolveAllowedHost.mockResolvedValue("192.0.2.10");
    await sendSmtpEmail(smtp({ host: "192.0.2.10" }), msg());
    expect(transportOpts().host).toBe("192.0.2.10");
    expect(transportOpts().tls).toBeUndefined();
  });

  it("passes a bare IPv6 literal straight through with no servername override", async () => {
    resolveAllowedHost.mockResolvedValue("2001:db8::25");
    await sendSmtpEmail(smtp({ host: "2001:db8::25" }), msg());
    expect(transportOpts().host).toBe("2001:db8::25");
    expect(transportOpts().tls).toBeUndefined();
  });

  // Was a bug until 2026-11-14: sendSmtpEmail strips the brackets only to DECIDE the host is a literal
  // (net.isIP), then hands nodemailer the still-bracketed cfg.host. For host
  // "[2001:db8::25]" nodemailer receives host "[2001:db8::25]", which net.isIP
  // rejects, so it DNS-resolves the bracketed string and the send fails with
  // ENOTFOUND. It should connect to the bare "2001:db8::25" (the address the
  // guard checked).
  it("connects a bracketed IPv6 literal to the bare address", async () => {
    resolveAllowedHost.mockResolvedValue("2001:db8::25");
    await sendSmtpEmail(smtp({ host: "[2001:db8::25]" }), msg());
    expect(transportOpts().host).toBe("2001:db8::25");
  });
});

describe("sendSmtpEmail — transport options", () => {
  it("ssl = implicit TLS (secure), not requireTLS", async () => {
    await sendSmtpEmail(smtp({ security: "ssl", port: 465 }), msg());
    expect(transportOpts()).toMatchObject({ port: 465, secure: true, requireTLS: false });
  });

  it("starttls = requireTLS on a plain socket", async () => {
    await sendSmtpEmail(smtp({ security: "starttls" }), msg());
    expect(transportOpts()).toMatchObject({ port: 587, secure: false, requireTLS: true });
  });

  it("none = neither", async () => {
    await sendSmtpEmail(smtp({ security: "none", port: 25 }), msg());
    expect(transportOpts()).toMatchObject({ port: 25, secure: false, requireTLS: false });
  });

  it("defaults a missing / non-numeric port to 587 and coerces a numeric string", async () => {
    await sendSmtpEmail(smtp({ port: 0 }), msg());
    expect(transportOpts().port).toBe(587);
    createTransport.mockClear();
    await sendSmtpEmail(smtp({ port: "2525" as unknown as number }), msg());
    expect(transportOpts().port).toBe(2525);
    createTransport.mockClear();
    await sendSmtpEmail(smtp({ port: "abc" as unknown as number }), msg());
    expect(transportOpts().port).toBe(587);
  });

  it("authenticates only when a username is set", async () => {
    await sendSmtpEmail(smtp(), msg());
    expect(transportOpts().auth).toEqual({ user: "alerts@example.com", pass: "pw" });
    createTransport.mockClear();
    await sendSmtpEmail(smtp({ username: "", password: "" }), msg());
    expect(transportOpts().auth).toBeUndefined();
  });
});

describe("sendSmtpEmail — the message", () => {
  it("sends from `from`, falling back to the username", async () => {
    await sendSmtpEmail(smtp(), msg());
    expect(sentMail().from).toBe("Polaris <alerts@example.com>");
    sendMail.mockClear();
    await sendSmtpEmail(smtp({ from: "" }), msg());
    expect(sentMail().from).toBe("alerts@example.com");
  });

  it("passes a single To and a To list through as given", async () => {
    await sendSmtpEmail(smtp(), msg({ to: ["a@x.com", "b@x.com"] }));
    expect(sentMail().to).toEqual(["a@x.com", "b@x.com"]);
  });

  it("omits empty Cc / Bcc lists and keeps non-empty ones", async () => {
    await sendSmtpEmail(smtp(), msg({ cc: [], bcc: [] }));
    expect(sentMail().cc).toBeUndefined();
    expect(sentMail().bcc).toBeUndefined();
    sendMail.mockClear();
    await sendSmtpEmail(smtp(), msg({ cc: ["c@x.com"], bcc: ["d@x.com"] }));
    expect(sentMail()).toMatchObject({ cc: ["c@x.com"], bcc: ["d@x.com"] });
  });

  it("carries subject, text and html", async () => {
    await sendSmtpEmail(smtp(), msg({ html: "<b>hi</b>" }));
    expect(sentMail()).toMatchObject({ subject: "Down", text: "plain body", html: "<b>hi</b>" });
  });

  it("maps inline attachments with their cid (Content-ID) and omits an empty list", async () => {
    const content = Buffer.from("png");
    await sendSmtpEmail(smtp(), msg({ html: "<img src='cid:c1'>", attachments: [{ cid: "c1", filename: "c.png", contentType: "image/png", content }] }));
    expect(sentMail().attachments).toEqual([{ filename: "c.png", cid: "c1", contentType: "image/png", content }]);
    sendMail.mockClear();
    await sendSmtpEmail(smtp(), msg({ attachments: [] }));
    expect(sentMail().attachments).toBeUndefined();
  });
});

describe("sendSmtpEmail — failures", () => {
  it("wraps a send failure as a 502 naming the server's first response line", async () => {
    sendMail.mockRejectedValue(Object.assign(new Error("Invalid login"), { response: "535 5.7.8 Authentication failed\r\nmore detail" }));
    const err = await sendSmtpEmail(smtp(), msg()).catch((e) => e);
    expect(err).toBeInstanceOf(AppError);
    expect(err).toMatchObject({ httpStatus: 502, message: "SMTP send failed: 535 5.7.8 Authentication failed" });
  });

  it("falls back to the error message, then the code", async () => {
    sendMail.mockRejectedValueOnce(new Error("connect ECONNREFUSED 203.0.113.25:587"));
    await expect(sendSmtpEmail(smtp(), msg())).rejects.toMatchObject({ message: "SMTP send failed: connect ECONNREFUSED 203.0.113.25:587" });
    sendMail.mockRejectedValueOnce({ code: "ETIMEDOUT" });
    await expect(sendSmtpEmail(smtp(), msg())).rejects.toMatchObject({ message: "SMTP send failed: ETIMEDOUT" });
    sendMail.mockRejectedValueOnce(undefined);
    await expect(sendSmtpEmail(smtp(), msg())).rejects.toMatchObject({ message: "SMTP send failed: unknown error" });
  });
});

describe("buildGraphMessage", () => {
  it("text-only message → Text body, single To wrapped in a list", () => {
    expect(buildGraphMessage(msg())).toEqual({
      subject: "Down",
      body: { contentType: "Text", content: "plain body" },
      toRecipients: [{ emailAddress: { address: "ops@example.com" } }],
    });
  });

  it("HTML wins when present", () => {
    expect(buildGraphMessage(msg({ html: "<p>x</p>" })).body).toEqual({ contentType: "HTML", content: "<p>x</p>" });
  });

  // Was a bug until 2026-11-14: buildGraphMessage tests html for truthiness to choose the content
  // type but uses `??` to choose the content. For html "" it returns
  // { contentType: "Text", content: "" } — an empty email — instead of
  // { contentType: "Text", content: "plain body" }.
  it("an empty html string falls back to the text body", () => {
    expect(buildGraphMessage(msg({ html: "" })).body).toEqual({ contentType: "Text", content: "plain body" });
  });

  it("keeps To order, adds Cc / Bcc only when non-empty", () => {
    const g = buildGraphMessage(msg({ to: ["a@x.com", "b@x.com"], cc: ["c@x.com"], bcc: [] }));
    expect(g.toRecipients).toEqual([{ emailAddress: { address: "a@x.com" } }, { emailAddress: { address: "b@x.com" } }]);
    expect(g.ccRecipients).toEqual([{ emailAddress: { address: "c@x.com" } }]);
    expect(g).not.toHaveProperty("bccRecipients");
    expect(buildGraphMessage(msg({ cc: [] }))).not.toHaveProperty("ccRecipients");
    expect(buildGraphMessage(msg({ bcc: ["d@x.com"] })).bccRecipients).toEqual([{ emailAddress: { address: "d@x.com" } }]);
  });

  it("attaches inline images (base64, isInline, contentId) only alongside an HTML body", () => {
    const attachments = [{ cid: "c1", filename: "c.png", contentType: "image/png", content: Buffer.from("png") }];
    expect(buildGraphMessage(msg({ html: "<img src='cid:c1'>", attachments })).attachments).toEqual([
      {
        "@odata.type": "#microsoft.graph.fileAttachment",
        name: "c.png",
        contentType: "image/png",
        contentBytes: Buffer.from("png").toString("base64"),
        isInline: true,
        contentId: "c1",
      },
    ]);
    // A text-only Graph message would show them as visible file attachments.
    expect(buildGraphMessage(msg({ attachments }))).not.toHaveProperty("attachments");
    expect(buildGraphMessage(msg({ html: "<p/>", attachments: [] }))).not.toHaveProperty("attachments");
  });
});

describe("sendM365Email", () => {
  const m365 = (over: Partial<M365Config> = {}): M365Config => ({
    tenantId: "tenant/1",
    clientId: "client",
    clientSecret: "secret",
    fromUserId: "alerts@example.com",
    ...over,
  });
  let fetchMock: ReturnType<typeof vi.fn>;
  const okToken = () => new Response(JSON.stringify({ access_token: "tok" }), { status: 200 });

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each([
    ["tenantId", { tenantId: "" }],
    ["clientId", { clientId: "" }],
    ["fromUserId", { fromUserId: "" }],
  ])("refuses a channel missing %s as a 400 before any request", async (_k, over) => {
    await expect(sendM365Email(m365(over), msg())).rejects.toMatchObject({ httpStatus: 400 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fetches a client-credentials token, then POSTs sendMail with it", async () => {
    fetchMock.mockResolvedValueOnce(okToken()).mockResolvedValueOnce(new Response(null, { status: 202 }));
    await sendM365Email(m365(), msg({ html: "<p>x</p>" }));
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const [tokenUrl, tokenInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(tokenUrl).toBe("https://login.microsoftonline.com/tenant%2F1/oauth2/v2.0/token");
    expect(tokenInit.method).toBe("POST");
    const form = new URLSearchParams(String(tokenInit.body));
    expect(Object.fromEntries(form)).toEqual({
      grant_type: "client_credentials",
      client_id: "client",
      client_secret: "secret",
      scope: "https://graph.microsoft.com/.default",
    });

    const [sendUrl, sendInit] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(sendUrl).toBe("https://graph.microsoft.com/v1.0/users/alerts%40example.com/sendMail");
    expect((sendInit.headers as Record<string, string>).Authorization).toBe("Bearer tok");
    const body = JSON.parse(String(sendInit.body));
    expect(body.saveToSentItems).toBe(false);
    expect(body.message).toEqual(buildGraphMessage(msg({ html: "<p>x</p>" })));
  });

  it("reports a token refusal's error_description (first line) as a 502", async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: "invalid_client", error_description: "AADSTS7000215: Invalid secret\r\nTrace ID: 1" }), { status: 401 }));
    await expect(sendM365Email(m365(), msg())).rejects.toMatchObject({
      httpStatus: 502,
      message: "Microsoft 365 token request failed: AADSTS7000215: Invalid secret",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("falls back to `error`, then to the HTTP status, for a token refusal", async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: "unauthorized_client" }), { status: 400 }));
    await expect(sendM365Email(m365(), msg())).rejects.toMatchObject({ message: "Microsoft 365 token request failed: unauthorized_client" });
    fetchMock.mockResolvedValueOnce(new Response("<html>gateway</html>", { status: 503 }));
    await expect(sendM365Email(m365(), msg())).rejects.toMatchObject({ message: "Microsoft 365 token request failed: HTTP 503" });
  });

  it("refuses a token response with no access_token as a 502", async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ token_type: "Bearer" }), { status: 200 }));
    await expect(sendM365Email(m365(), msg())).rejects.toMatchObject({ httpStatus: 502, message: /missing access_token/ });
  });

  it("reports a sendMail refusal's error.message (first line) as a 502", async () => {
    fetchMock
      .mockResolvedValueOnce(okToken())
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { code: "ErrorAccessDenied", message: "Access is denied.\nCheck credentials" } }), { status: 403 }));
    await expect(sendM365Email(m365(), msg())).rejects.toMatchObject({ httpStatus: 502, message: "Microsoft 365 sendMail failed: Access is denied." });
  });

  it("falls back to the HTTP status when a sendMail refusal has no JSON error", async () => {
    fetchMock.mockResolvedValueOnce(okToken()).mockResolvedValueOnce(new Response("nope", { status: 500 }));
    await expect(sendM365Email(m365(), msg())).rejects.toMatchObject({ message: "Microsoft 365 sendMail failed: HTTP 500" });
  });

  // Was a bug until 2026-11-14: sendM365Email lets a transport failure escape raw. With
  // login.microsoftonline.com unreachable, fetch rejects with a TypeError
  // ("fetch failed") and the channel Test route answers 500 "Internal server
  // error" — the exact thing sendSmtpEmail's catch exists to prevent. It should
  // reject with an AppError (502) naming the reason.
  it("a network failure surfaces as a 502 AppError, like SMTP's", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("fetch failed"));
    const err = await sendM365Email(m365(), msg()).catch((e) => e);
    expect(err).toBeInstanceOf(AppError);
    expect(err.httpStatus).toBe(502);
  });
});
