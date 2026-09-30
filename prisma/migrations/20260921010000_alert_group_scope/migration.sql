-- An AlertGroup can say WHICH DEVICES it governs (business rule 75).
--
-- The same `scope` shape a NotificationRule carries, built with the same
-- condition tree. It NARROWS rather than replaces: a member automation still
-- decides what it watches and where, and this decides where the FOLD applies.
-- On a device the scope selects, a member's alerts join the group's single
-- alert; on a device it does not select, that member delivers on its own,
-- exactly as an ungrouped automation would.
--
-- NULL is "every device its members cover" — the behaviour a group had before
-- this column — so every existing group is unchanged and nothing is backfilled.
ALTER TABLE "alert_groups"
  ADD COLUMN IF NOT EXISTS "scope" JSONB;
