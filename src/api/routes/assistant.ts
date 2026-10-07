/**
 * src/api/routes/assistant.ts — the floating AI assistant (business rule 95).
 *
 * Mounted at /api/v1/assistant behind requirePermission("assistant", "read").
 *
 *   GET    /status                          enabled llm integrations (name + model only) + settings
 *   GET    /conversations                   the caller's conversations, newest first
 *   POST   /conversations                   start one
 *   GET    /conversations/:id               its messages and report snapshots
 *   PATCH  /conversations/:id               rename
 *   DELETE /conversations/:id               delete
 *   DELETE /conversations/:id/messages      /clear — empty it, keep the thread
 *   POST   /conversations/:id/stop          Stop the running turn (a page change does not)
 *   POST   /conversations/:id/messages      ask; answers as a text/event-stream
 *   PUT    /settings                        conversation retention (serverSettingsSystem write)
 *   PUT    /preferences                     the caller's own Efficiency Advisor checkbox (rule 95(h))
 *
 * SESSION-ONLY: a conversation belongs to a user, and a bearer token has none,
 * so token callers get a 403 here even when their role holds `assistant`.
 * Every conversation route is owner-scoped in the service (404 for anyone
 * else's id — rule 95(d)).
 */

import { Router, type Request, type Response, type NextFunction } from "express";
import { z } from "zod";
import { AppError } from "../../utils/errors.js";
import { requirePermission } from "../middleware/permissions.js";
import { makeRateLimiter } from "../middleware/rateLimits.js";
import {
  listConversations,
  createConversation,
  getConversation,
  renameConversation,
  deleteConversation,
  clearConversation,
  getAssistantSettings,
  updateAssistantSettings,
  getEfficiencyAdvisor,
  setEfficiencyAdvisor,
} from "../../services/assistantConversationService.js";
import {
  listAssistantIntegrations,
  resolveAssistantIntegration,
  streamAssistantTurn,
  registerTurn,
  releaseTurn,
  isTurnRunning,
  stopTurn,
} from "../../services/assistantChatService.js";

const router = Router();

const CreateConversationSchema = z.object({
  title: z.string().max(120).optional(),
});

const RenameSchema = z.object({
  title: z.string().min(1).max(120),
});

const AskSchema = z.object({
  content: z.string().max(8000).optional(),
  integrationId: z.string().uuid().optional(),
  regenerate: z.boolean().optional(),
}).refine((b) => b.regenerate || (b.content && b.content.trim().length > 0), "Message is empty");

const SettingsSchema = z.object({
  retentionDays: z.number().int().min(1).max(3650),
});

const PreferencesSchema = z.object({
  efficiencyAdvisor: z.boolean(),
});

const IdParam = z.string().uuid();

// A local model answers slowly and each turn may run several lookups, so
// this bounds a runaway client rather than normal use: 30 questions a minute.
const askLimiter = makeRateLimiter({
  windowMs: 60 * 1000,
  max: 30,
  message: "Too many assistant messages — wait a minute and try again.",
});

function sessionUser(req: Request): { userId: string; username?: string } {
  const userId = req.session?.userId;
  if (!userId || req.apiToken) {
    throw new AppError(403, "The assistant is available to signed-in users only (API tokens have no conversations)");
  }
  return { userId, username: req.session?.username ?? undefined };
}

function convId(req: Request): string {
  const p = IdParam.safeParse(req.params.id);
  if (!p.success) throw new AppError(404, "Conversation not found");
  return p.data;
}

router.get("/status", async (req, res, next) => {
  try {
    const { userId } = sessionUser(req);
    const [integrations, settings, efficiencyAdvisor] = await Promise.all([
      listAssistantIntegrations(), getAssistantSettings(), getEfficiencyAdvisor(userId),
    ]);
    res.json({ enabled: integrations.length > 0, integrations, retentionDays: settings.retentionDays, efficiencyAdvisor });
  } catch (err) { next(err); }
});

// A personal display choice on the caller's own account: the `assistant`
// read gate the router is mounted behind is the whole permission.
router.put("/preferences", async (req, res, next) => {
  try {
    const { userId } = sessionUser(req);
    const input = PreferencesSchema.parse(req.body);
    res.json({ efficiencyAdvisor: await setEfficiencyAdvisor(userId, input.efficiencyAdvisor) });
  } catch (err) { next(err); }
});

router.put("/settings", requirePermission("serverSettingsSystem", "write"), async (req, res, next) => {
  try {
    const input = SettingsSchema.parse(req.body);
    res.json(await updateAssistantSettings(input));
  } catch (err) { next(err); }
});

router.get("/conversations", async (req, res, next) => {
  try {
    const { userId } = sessionUser(req);
    res.json({ conversations: await listConversations(userId) });
  } catch (err) { next(err); }
});

router.post("/conversations", async (req, res, next) => {
  try {
    const { userId } = sessionUser(req);
    const input = CreateConversationSchema.parse(req.body ?? {});
    res.status(201).json(await createConversation(userId, input.title));
  } catch (err) { next(err); }
});

router.get("/conversations/:id", async (req, res, next) => {
  try {
    const { userId } = sessionUser(req);
    const id = convId(req);
    const conv = await getConversation(userId, id);
    // pending: a turn is still being answered (possibly started on the page
    // the user just left) — the widget waits for it instead of re-asking.
    res.json({ ...conv, pending: isTurnRunning(id) });
  } catch (err) { next(err); }
});

router.patch("/conversations/:id", async (req, res, next) => {
  try {
    const { userId } = sessionUser(req);
    const input = RenameSchema.parse(req.body);
    res.json(await renameConversation(userId, convId(req), input.title));
  } catch (err) { next(err); }
});

// POST /conversations/:id/stop — the Stop button. A page change no longer
// stops an answer (the stream is dropped, the turn carries on and is stored),
// so stopping is explicit. Owner-only, like every conversation route.
router.post("/conversations/:id/stop", async (req, res, next) => {
  try {
    const { userId } = sessionUser(req);
    const id = convId(req);
    await getConversation(userId, id); // 404 for anyone else's id
    res.json({ stopped: stopTurn(id, userId) });
  } catch (err) { next(err); }
});

router.delete("/conversations/:id/messages", async (req, res, next) => {
  try {
    const { userId } = sessionUser(req);
    await clearConversation(userId, convId(req));
    res.status(204).send();
  } catch (err) { next(err); }
});

router.delete("/conversations/:id", async (req, res, next) => {
  try {
    const { userId } = sessionUser(req);
    await deleteConversation(userId, convId(req));
    res.status(204).send();
  } catch (err) { next(err); }
});

// POST /conversations/:id/messages — one streamed turn.
//
// Everything that can fail cheaply (auth, body, ownership is checked inside
// streamAssistantTurn's beginTurn, the integration) fails BEFORE the stream
// opens, as an ordinary JSON error. Once the 200 + text/event-stream headers
// are out, failures arrive as an `error` event instead.
//
// `Cache-Control: no-transform` is load-bearing: the app-wide compression()
// middleware skips a response that carries it, and would otherwise buffer the
// stream into one late chunk. `X-Accel-Buffering: no` does the same for the
// shipped nginx front. A proxy that buffers anyway (a corporate load balancer)
// degrades this to "the whole answer arrives at once", never to a failure.
router.post("/conversations/:id/messages", askLimiter, async (req: Request, res: Response, next: NextFunction) => {
  let streaming = false;
  let controller: AbortController | null = null;
  let claimedId: string | null = null;
  try {
    const { userId, username } = sessionUser(req);
    const id = convId(req);
    const body = AskSchema.parse(req.body ?? {});
    const integration = await resolveAssistantIntegration(body.integrationId);
    if (!integration) throw new AppError(409, "No Local AI Assistant integration is enabled. Add one under Integrations.");

    // One turn per conversation at a time. A client disconnect (the user
    // changed page) does NOT abort it — see registerTurn; Stop is explicit.
    const turn = registerTurn(id, userId);
    controller = turn;
    claimedId = id;

    const write = (event: string, data: unknown) => {
      if (res.writableEnded || res.destroyed) return;
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    // Ownership + the stored question happen inside streamAssistantTurn
    // before any model call; open the stream only once that has passed, by
    // deferring the headers to the first emitted event.
    const open = () => {
      if (streaming) return;
      streaming = true;
      res.status(200);
      res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
      res.setHeader("Cache-Control", "no-cache, no-transform");
      res.setHeader("X-Accel-Buffering", "no");
      res.setHeader("Connection", "keep-alive");
      res.flushHeaders();
      write("open", { integration: { id: integration.id, name: integration.name, model: integration.config.model || "auto" } });
    };
    // Keep idle proxies from closing the socket while a slow model thinks.
    const heartbeat = setInterval(() => {
      if (streaming && !res.writableEnded && !res.destroyed) res.write(": keep-alive\n\n");
    }, 15_000);

    try {
      await streamAssistantTurn({
        req,
        userId,
        username,
        conversationId: id,
        integration,
        content: body.content,
        regenerate: body.regenerate,
        signal: turn.signal,
        emit: (event, data) => {
          open();
          write(event, data);
        },
      });
    } finally {
      clearInterval(heartbeat);
    }
    releaseTurn(id, turn);
    claimedId = null;
    open();
    res.end();
  } catch (err) {
    if (claimedId && controller) releaseTurn(claimedId, controller);
    if (streaming) {
      if (!res.writableEnded) {
        res.write(`event: error\ndata: ${JSON.stringify({ message: (err as Error)?.message || "The assistant failed" })}\n\n`);
        res.end();
      }
      return;
    }
    next(err);
  }
});

export default router;
