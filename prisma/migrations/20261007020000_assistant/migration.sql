-- AI assistant (business rule 95), 2026-10-07.
--
--   assistant_conversations  one chat thread in the floating assistant widget,
--                            owned by exactly one user (owner-only reads).
--   assistant_messages       the user / assistant turns of a thread. Tool calls
--                            and their results are never stored.
--   assistant_reports        downloadable report snapshots the create_report
--                            tool built from the database (never model text).
--
-- Plus the `assistant` function key (READ_ONLY ladder) that gates the widget.

CREATE TABLE "assistant_conversations" (
    "id"            TEXT NOT NULL,
    "userId"        TEXT NOT NULL,
    "integrationId" TEXT,
    "title"         TEXT NOT NULL DEFAULT 'New conversation',
    "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"     TIMESTAMP(3) NOT NULL,

    CONSTRAINT "assistant_conversations_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "assistant_conversations_userId_updatedAt_idx" ON "assistant_conversations"("userId", "updatedAt");
CREATE INDEX "assistant_conversations_updatedAt_idx" ON "assistant_conversations"("updatedAt");

ALTER TABLE "assistant_conversations"
    ADD CONSTRAINT "assistant_conversations_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "assistant_conversations"
    ADD CONSTRAINT "assistant_conversations_integrationId_fkey"
    FOREIGN KEY ("integrationId") REFERENCES "integrations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "assistant_messages" (
    "id"             TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "role"           TEXT NOT NULL,
    "content"        TEXT NOT NULL,
    "toolsUsed"      JSONB NOT NULL DEFAULT '[]',
    "stopped"        BOOLEAN NOT NULL DEFAULT false,
    "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "assistant_messages_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "assistant_messages_conversationId_createdAt_idx" ON "assistant_messages"("conversationId", "createdAt");

ALTER TABLE "assistant_messages"
    ADD CONSTRAINT "assistant_messages_conversationId_fkey"
    FOREIGN KEY ("conversationId") REFERENCES "assistant_conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "assistant_messages"
    ADD CONSTRAINT "assistant_messages_role_check"
    CHECK ("role" IN ('user', 'assistant'));

CREATE TABLE "assistant_reports" (
    "id"          TEXT NOT NULL,
    "messageId"   TEXT NOT NULL,
    "title"       TEXT NOT NULL,
    "columns"     JSONB NOT NULL,
    "rows"        JSONB NOT NULL,
    "rowCount"    INTEGER NOT NULL,
    "truncated"   BOOLEAN NOT NULL DEFAULT false,
    "generatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "assistant_reports_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "assistant_reports_messageId_idx" ON "assistant_reports"("messageId");

ALTER TABLE "assistant_reports"
    ADD CONSTRAINT "assistant_reports_messageId_fkey"
    FOREIGN KEY ("messageId") REFERENCES "assistant_messages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ─── Seed the `assistant` function key ──────────────────────────
-- READ_ONLY ladder: the assistant writes nothing outside the caller's own
-- conversations, and every lookup it makes runs with the caller's own role
-- (rule 95(a)), so `read` grants nothing the role does not already hold.
-- Every role gets read — including the protected `readonly`, which could
-- otherwise never be granted it — EXCEPT the legacy `api-*` token roles
-- (a bearer token has no user to own a conversation) and the `llm-*` roles
-- an llm integration mints for its own token. `updatedAt` is bumped so the
-- in-process role-version cache refetches. Idempotent: only rows that lack
-- the key.
UPDATE "roles"
   SET "permissions" = jsonb_set(
         "permissions",
         '{assistant}',
         CASE WHEN "name" LIKE 'api-%' OR "name" LIKE 'llm-%'
              THEN '"none"'::jsonb
              ELSE '"read"'::jsonb
         END,
         true),
       "updatedAt" = CURRENT_TIMESTAMP
 WHERE NOT ("permissions" ? 'assistant');
