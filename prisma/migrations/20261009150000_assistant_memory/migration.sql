-- Assistant memory (business rule 95(i)), 2026-10-09.
--
--   users.assistant_memory      the chat window's per-user "Remember things" switch; on by default.
--   assistant_memory_entries    one short sentence about the person, sent in the system prompt
--                               of every turn they start. Owner-only; deleted with the user.

ALTER TABLE "users" ADD COLUMN "assistant_memory" BOOLEAN NOT NULL DEFAULT true;

CREATE TABLE "assistant_memory_entries" (
    "id"        TEXT NOT NULL,
    "userId"    TEXT NOT NULL,
    "text"      VARCHAR(200) NOT NULL,
    "source"    TEXT NOT NULL DEFAULT 'assistant',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "assistant_memory_entries_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "assistant_memory_entries_userId_createdAt_idx" ON "assistant_memory_entries"("userId", "createdAt");

ALTER TABLE "assistant_memory_entries"
    ADD CONSTRAINT "assistant_memory_entries_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
