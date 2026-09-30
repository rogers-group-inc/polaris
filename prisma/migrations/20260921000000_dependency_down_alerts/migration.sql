-- Business rule 78 — a down automation may opt in to speaking for a
-- dependency-suppressed device (`trigger.alertWhenDependencyDown`, a key in the
-- trigger JSON like `missedPolls`, so it needs no column of its own).
--
-- The alert it raises has to be told apart from a plain Down alert on the same
-- device, by readers that never see the message text: the suppression sweep
-- (which must NOT retire it — it is the one alert supposed to be live on a
-- suppressed asset), the engine (which ends it and raises the other flavour
-- when the asset's suppression flag changes), and the alert surfaces (a badge).
-- A column rather than a key in `templateCtx`: that snapshot is written only
-- when the rule composes or escalates, so a plain in-app automation would
-- carry nothing to read.
--
-- `dependencyBlame` snapshots who silenced the device at fire time (upstream
-- device, root cause, hop count) so the row still explains itself after the
-- dependency tree is recomputed.
--
-- Default false = today's behaviour for every existing row: nothing on the
-- board is a dependency-down alert until the engine raises one.
ALTER TABLE "notifications"
  ADD COLUMN IF NOT EXISTS "dependencyDown" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "dependencyBlame" JSONB;
