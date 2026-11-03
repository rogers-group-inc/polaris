-- Saved folders and role / region ownership of saved items (business rule 140).
--
-- 1. saved_folders — nested folders of saved filters (kind 'filter', scope =
--    the table) or saved dashboards (kind 'dashboard', scope 'dashboards').
--    parent_id is SET NULL as a backstop only: the service re-parents a
--    folder's contents before deleting it.
--
-- 2. ownerRoleId / ownerRegion / folderId on saved_table_filters and
--    saved_dashboards (camelCase, matching those tables' existing columns).
--    At most one of ownerId / ownerRoleId / ownerRegion is set; none = an
--    ownerless row only a fullwrite holder manages. Every existing row keeps
--    its user owner (or stays ownerless, as a deleted user's public row already
--    is), so no data moves.

CREATE TABLE "saved_folders" (
    "id"            TEXT NOT NULL,
    "kind"          TEXT NOT NULL,
    "scope"         TEXT NOT NULL,
    "name"          TEXT NOT NULL,
    "parent_id"     TEXT,
    "owner_id"      TEXT,
    "owner_role_id" TEXT,
    "owner_region"  TEXT,
    "owner_name"    TEXT NOT NULL,
    "visibility"    TEXT NOT NULL DEFAULT 'private',
    "created_at"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"    TIMESTAMP(3) NOT NULL,

    CONSTRAINT "saved_folders_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "saved_folders_kind_scope_idx" ON "saved_folders"("kind", "scope");
CREATE INDEX "saved_folders_parent_id_idx" ON "saved_folders"("parent_id");

ALTER TABLE "saved_folders"
  ADD CONSTRAINT "saved_folders_parent_id_fkey"
  FOREIGN KEY ("parent_id") REFERENCES "saved_folders"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "saved_folders"
  ADD CONSTRAINT "saved_folders_owner_id_fkey"
  FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "saved_folders"
  ADD CONSTRAINT "saved_folders_owner_role_id_fkey"
  FOREIGN KEY ("owner_role_id") REFERENCES "roles"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "saved_table_filters" ADD COLUMN "ownerRoleId" TEXT;
ALTER TABLE "saved_table_filters" ADD COLUMN "ownerRegion" TEXT;
ALTER TABLE "saved_table_filters" ADD COLUMN "folderId" TEXT;
CREATE INDEX "saved_table_filters_folderId_idx" ON "saved_table_filters"("folderId");
ALTER TABLE "saved_table_filters"
  ADD CONSTRAINT "saved_table_filters_ownerRoleId_fkey"
  FOREIGN KEY ("ownerRoleId") REFERENCES "roles"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "saved_table_filters"
  ADD CONSTRAINT "saved_table_filters_folderId_fkey"
  FOREIGN KEY ("folderId") REFERENCES "saved_folders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "saved_dashboards" ADD COLUMN "ownerRoleId" TEXT;
ALTER TABLE "saved_dashboards" ADD COLUMN "ownerRegion" TEXT;
ALTER TABLE "saved_dashboards" ADD COLUMN "folderId" TEXT;
CREATE INDEX "saved_dashboards_folderId_idx" ON "saved_dashboards"("folderId");
ALTER TABLE "saved_dashboards"
  ADD CONSTRAINT "saved_dashboards_ownerRoleId_fkey"
  FOREIGN KEY ("ownerRoleId") REFERENCES "roles"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "saved_dashboards"
  ADD CONSTRAINT "saved_dashboards_folderId_fkey"
  FOREIGN KEY ("folderId") REFERENCES "saved_folders"("id") ON DELETE SET NULL ON UPDATE CASCADE;
