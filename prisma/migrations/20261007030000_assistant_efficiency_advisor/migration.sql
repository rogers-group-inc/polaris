-- Assistant "Efficiency Advisor" (business rule 95(h)), 2026-10-07.
--
--   users.assistant_efficiency_advisor  the chat window's per-user checkbox; off by default.
--   assistant_messages.preface          the canned line shown when a turn's first lookup started.
--   assistant_messages.signOff          the canned line shown under an answer.
--
-- Both lines are chosen by Polaris and stored apart from the answer text, so
-- they are never resent to the model.

ALTER TABLE "users" ADD COLUMN "assistant_efficiency_advisor" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "assistant_messages" ADD COLUMN "preface" TEXT;
ALTER TABLE "assistant_messages" ADD COLUMN "signOff" TEXT;
