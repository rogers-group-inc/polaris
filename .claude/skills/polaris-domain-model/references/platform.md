# Domain model — users, roles, credentials, settings, dashboards, registries

Each entity below carries its CLAUDE.md definition + load-bearing invariant, followed (in the **Schema** and **Notes** parts) by the field-level schema dump and the extended notes that lived in the skill references (formerly ARCHITECTURE.md). `prisma/schema.prisma` is the source of truth for types; these are the semantics.

## Definitions and invariants

- **ApplicationMapLayout** — shared Application Map drag layout (TopologyLayout pattern, one global `view="global"` row, no per-site FK). Written via `PUT /application-map/layout` (`applicationMap=write`); embedded as `savedLayout` on `GET /application-map`; localStorage is the per-browser reader fallback. Single writer: `applicationMapService`.

- **ApiToken** — bearer tokens for external callers (e.g. SIEM quarantine, NOC kiosk); each token is bound to a Role and acts with that role's permission matrix.

- **SshHostKey** — trust-on-first-use pins for SSH **server** host keys, one row per dialed `(host, port)` — no Asset FK, since a host is often onboarded before it exists as an Asset. A changed key **refuses** the connection. Gated per credential by `SshConfig.verifyHostKey`. See business rule 21.

- **Credential** — named SNMP / WinRM / SSH / REST API / HTTP credentials for monitoring probes. **`createdBy` is the ownership dimension of the `credentials` function key** (business rule 43): stamped once at create, never rewritten by an edit (so saving a row can't adopt it), and `null` means UNOWNED — every row predating the column, deliberately not backfilled, reachable only at `fullwrite`. The `http` type carries **authentication only** (`authMode` ∈ bearer/basic/digest) and deliberately has no "none" mode — see business rule 33. Secret fields inside `config` are **encrypted at rest** by the Prisma extension in `src/db.ts` (business rule 20b) and masked on read at the API layer.

- **MibFile** — admin-uploaded SNMP MIBs used by `oidRegistry` + `vendorTelemetryProfiles`.

- **ManufacturerProfile** / **ManufacturerProfileMetric** / **ManufacturerProfileMetricOverride** / **ManufacturerCustomWidget** — operator-editable per-manufacturer telemetry profile + custom widget definitions. `widgetType` ∈ `gauge | line | table | state | http`; `state` is a state probe (see `AssetStateSample`) and `http` is an HTTP check (business rule 33). Every widget type is gated by `modelPattern` — blank means every asset of that manufacturer.

- **ManufacturerAlias** — vendor-name canonicalization map.

- **DeviceIcon** — operator-uploaded topology icon blobs (scope + key), served to the Device Map / topology renderer.

- **User** / **Role** — dynamic-role RBAC; `User.roleId` → `Role`; permissions matrix on Role over 32 function keys. `User.notificationPreference` (`email` | `push` | `any`, default `email`) is the account's own answer to how it wants to be alerted — stored here rather than per browser so a sign-in on a new device knows to enroll or un-enroll itself; see business rule 39. `User.timezone` (an IANA name or the literal `auto`, default `auto`) is the zone this account reads times in, and `User.detectedTimezone` (nullable) is the zone its BROWSER last reported — client-posted on boot, never operator-set and never offered as a choice. The pair exists because an alert EMAIL has no browser to ask: `auto` resolves explicit-choice → detected → server zone, so an operator who never opens the picker still gets mail on their own wall clock instead of a UTC-clocked host's. Both are free-form TEXT, not an enum — the tz database moves on its own schedule and an unresolvable name degrades to `auto` on READ (`normalizeUserTimezone`) rather than failing a render or a send.

- **GroupMapping** — IdP group → role + tags map for OIDC / LDAP / SAML SSO login (`provider` + `groupKey`; nullable `roleId` for tags-only mappings).

- **ManagedAgent** — Polaris Agent install record per Asset (os/arch, version, install credential, cert-pin set for dual-pin rotation, curated `installScriptId`). `privilegeTier` (Linux-only) selects the systemd unit: `unprivileged` (hardened) or `ptrace` (that unit plus `CAP_SYS_PTRACE` **and** `CAP_DAC_READ_SEARCH` — **both are required**; SYS_PTRACE alone collects zero rows). Unit text is written only at install/reinstall, so pre-fix ptrace agents need a reinstall; the agent reports its actual CapEff on heartbeat so the UI shows the VERIFIED state. Full root was retired with service control.

- **UserDashboard** — per-user dashboard layout (widget set + positions), v3: several NAMED dashboards (the tab strip) each holding a column stack.

- **SavedDashboard** — a named, optionally SHARED snapshot of ONE dashboard canvas (Dashboard → **Dashboards ▾**): `SavedTableFilter`'s model applied to the dashboard, so `ownerId` is SetNull (a published screen outlives its author, `ownerName` being the surviving label), the name is the overwrite key, and the `layout` blob is re-validated on every write because it is replayed into other operators' browsers. **One row is ONE dashboard, not a whole layout** — a published dashboard is one screen, which is what a wallboard shows and what the Dashboard page loads as one new TAB (a COPY with fresh widget instance ids, so editing it never rewrites a row that may be someone else's — the `UserTableTabs` rule). Two things have no parallel in saved filters. It carries its **own function key** (`savedDashboards`) rather than riding a page's gate, because the Dashboard page has no key to inherit — it is gated per WIDGET; and a `public` row is what the **unauthenticated Dash wallboard** can load, which is why publishing is `write` while keeping a private one is only `read` (the ungated `/me/dashboard` already stores the same layout, so there is nothing to withhold). A wallboard shows a published dashboard LIVE rather than copying it — pinned per browser in `polaris-dash-published`, re-read on a 5-minute poll that re-renders only when `updatedAt` moves — and can never save one at all: that listener is GET-only app-wide, so its own layout stays in localStorage. The column/widget shape + caps live in `utils/dashboardLayout.ts`, shared with `/me/dashboard` so a canvas one surface accepts is always renderable by the other.

- **UserTableTabs** — per-user list-page tabs (the Assets page tab strip), one row per `(user, scope)`, each tab carrying its own filter+sort state. A tab opened from a preset keeps only a REFERENCE for its label — editing it never writes back, since the preset may be someone else's. A tab may additionally pin one preset as its **base filter** (`defaultFilterId` + `defaultFilterName` + `defaultState`), the view it RESETS to — which is what makes filtering *inside* a saved filter survivable, and which swaps the page-controls row's "Clear Filters" for **"Reset Filter"** while it is set. `defaultState` is a SNAPSHOT and is the single truth for "this tab has a base" (a label with no snapshot is normalized away), so a preset deleted by its owner can never cost a tab its way back; the client re-syncs the snapshot from the live preset every time it lists them, which is how an edit to the preset reaches the tabs based on it. A tab also owns its **favorites** (`favoriteIds`, capped at `MAX_TAB_FAVORITES` = 500) — the starred rows that float to the top of THAT view. They live here rather than in localStorage (where the blocks / subnets / widget-library stars still live) because a favorite is part of a view, and a view follows the operator across browsers; `public/js/favorites.js` grew a **provider seam** (`registerFavoritesProvider`) so the Assets page's existing star / query call sites resolve to the active tab with no page-side change. `favoriteIds: null` means "predates per-tab favorites" and is the one moment the client may seed the tab from the legacy per-user localStorage set — normalizing it to `[]` would let a second browser re-seed tabs the operator had since curated. Strictly per-caller, no Event audit, cascades with the user. Absent row = the default single tab.

- **SavedTableFilter** — a named, optionally SHARED snapshot of one list page's filter + sort state. `scope` names the table and maps to the RBAC key that already gates that page — no new permission key. `state` is re-validated on every write because a public preset is replayed into other operators' browsers. `ownerId` is SetNull, so a shared preset outlives its author.

- **TopologyLayout** — SHARED Device Map topology node positions, one row per (siteId, view). Written full-replace by operator drags (gated `deviceMap=write`, last-write-wins); server layout wins over the per-browser localStorage fallback. Cascades with the site Asset. **Two blobs, and the second is what makes Reset a choice**: `positions` is the LIVE layout every drag rewrites, `savedPositions` (+ `savedBy`/`savedAt`) is the operator's RESTORE POINT, written ONLY by the explicit Save (`POST …/layout/checkpoint`) and never by a drag — a drag is not a decision, and letting one overwrite the restore point would leave nothing to reset to. So Reset has two destinations: **last save** (copy the restore point back over the live blob, keeping the restore point so it can be used again) and **baseline** (clear the live blob and re-run the column solver). A baseline reset **empties** a row that carries a restore point rather than deleting it — an operator who resets to baseline must still be able to change their mind — and deletes one that does not, which is the pre-checkpoint behavior. `positions: {}` restores nothing at render, which IS the baseline. NULL `savedPositions` = never saved, which is every pre-existing row (nothing is backfilled) and what greys out "Reset to last save".

- **Event** — audit log, 7-day rolling retention. Four per-asset **change events** (`asset.firmware.changed` / `asset.switch_port.changed` / `asset.wireless_ap.changed` / `asset.gateway_firewall.changed`) are written edge-triggered and **unconditionally**, never behind the `change.*` subscription gate. Row builders are pure and centralized in `eventLogService`; discovery emits them from an end-of-run baseline, because coarse-then-corrected phases ping-pong within a single run. `asset.firmware.changed` additionally has a MONITOR-path writer — `adoptSysDescrIdentity`, for a device whose vendor publishes a sysDescr format Polaris can read (`utils/snmpDescrIdentity.ts`) — which has no run to baseline against and so compares against the stored row, leaning on `computeFirmwareChange`'s rule that a first learn is not an upgrade.

- **Setting** — key-value config store (`manualMonitorSettings`, `sampleRetention`, `mapRegions`, `branding`, `backupSchedule`, `assetSourcePriority`, `reservationMacPlaceholder`, `loginAccessConfig`, `dashConfig`, `apiDocsConfig`, `agentEventLog`, etc.). Secret-bearing rows are encrypted at rest (business rule 20b). `assetSourcePriority` orders learned-location precedence (business rule 22); `reservationMacPlaceholder` is the synthetic-MAC OUI (business rule 26).

- **Tag** / **GeocodeCache** — registry tables. `Tag` carries an optional **auto-assignment device filter**; when set, `tagAssignmentService` keeps the tag synced onto matching assets (managed sync — adds AND removes on drift). The shape is `assetCondition` — the SAME nested AND/OR condition tree the automations device filter and `Contact.assetCondition` store, edited in the same shared `PolarisConditionBuilder` and evaluated by the same `evaluateScopeCondition` — which superseded the flat `criteria` blob it shipped with (still READ, one shape live per row, folded forward by `criteriaToCondition` + the `migrateTagFilterShape` one-shot; an `integration` rule is the one thing the tree can't express, so a blob carrying it stays on the legacy predicate). Two asymmetries with `Contact`: an **empty tree is NO filter, never "all devices"** (a tag has no All-devices control, so an empty tree could only come from a half-built form and honoring it would tag the whole fleet on save), and a **decommissioned asset is skipped unless the filter mentions status**. The **"Map Regions" category is locked to the Device Map** — the registry refuses creating a tag in it or moving one in, and a tag in it may not carry a filter, since `RegionTagAssignment` already manages those names and a second managed-sync engine on the same string would undo the first every cycle. **TagAutoAssignment** is the per-(tag,asset) provenance table that lets managed sync strip auto-applied copies without touching a hand-applied copy of the same tag. **RegionTagAssignment** is the same pattern for `region:` tags, keyed by region id so a rename doesn't disturb it. **DirectoryContactSource** is that pattern again for the address book: one row per (integration, directory object) the GAL sync created, so a reconcile deletes only what it wrote and a hand-added row (which never has one) survives forever. A person in BOTH directories owns ONE Contact with TWO provenance rows, and the Contact dies only when its last one goes; the Contact is PROJECTED from the set rather than last-writer-wins, so two directories that disagree can't ping-pong it. **No FK on `integrationId`, deliberately** — a cascade would strip the provenance and strand the rows it justified.

---

## Schema

```
ApiToken                        -- Long-lived bearer tokens for external callers (e.g. SIEM quarantine)
  id            UUID PK
  name          String @unique
  tokenHash     String            -- argon2id of the raw token; never returned in API responses
  tokenPrefix   String            -- first 16 chars (polaris_ + 8 chars) for fast candidate lookup
  roleId        String FK->Role   -- the Role whose permission matrix this token acts with (Restrict: roleService refuses deleting a role bound to any token)
  integrationIds String[]         -- FMG/FortiGate ids this token may target. REQUIRED + non-empty when the bound role grants assetsQuarantine >= write; empty otherwise. The quarantine service drops sightings whose integration isn't in this list before pushing, and refuses release/verify outright if the existing quarantine touches integrations outside the token's scope (partial release would leave Polaris flipped to active while orphan entries linger on out-of-scope gateways). Validated at create-time: each id must exist and be type fortimanager or fortigate.
  createdBy     String
  createdAt     DateTime
  expiresAt     DateTime?
  lastUsedAt    DateTime?
  lastUsedIp    String?
  revokedAt     DateTime?
  revokedBy     String?
  -- Wire format: Authorization: Bearer polaris_<32-char-base64url-tail>
  -- Raw token shown ONCE at creation (POST /api-tokens); only the hash is stored.
  -- Role cutover (migration 20260706000000) replaced the prior scope strings
  -- (assets:read / dashboard:read / assets:quarantine); legacy tokens were
  -- mapped onto seeded api-* roles with matching matrices.

Credential                      -- Named credentials for monitoring probes (SNMP / WinRM / SSH)
  id            UUID PK
  name          String @unique
  type          String          -- "snmp" | "winrm" | "ssh"
  config        Json            -- Type-specific:
                                --   snmp v2c: { version: "v2c", community, port? }
                                --   snmp v3:  { version: "v3", username, securityLevel, authProtocol?, authKey?, privProtocol?, privKey?, port? }
                                --             authProtocol: "MD5" | "SHA" (SHA-1) | "SHA224" | "SHA256" | "SHA384" | "SHA512"
                                --             privProtocol: "DES" | "AES" (AES-128) | "AES256B" (Blumenthal draft) | "AES256R" (Reeder draft / Cisco)
                                --   winrm:    { username, password, port?, useHttps? }
                                --   ssh:      { username, password? | privateKey?, port? }
  -- Sensitive fields (community, authKey, privKey, password, privateKey) are stored plaintext and masked
  -- on every GET; PUT preserves the stored value when the caller resubmits the mask sentinel.

User
  id            UUID PK
  username      String @unique
  passwordHash  String
  roleId        String         -- FK Role; onDelete: Restrict (cannot delete a role that has users)
  role          Role           -- joined Role row, joined on every list/get response
  -- Per-user region scope. Empty = unrestricted (matches pre-cutover default).
  -- Effective regions for a session are `union(role, user, group-derived)`.
  -- Operator-set; group-derived tags are NEVER written here.
  regionTags    String[]       @default([])
  otherTags     String[]       @default([]) -- Per-user free-form ("other") tag scope; second dimension parallel to regionTags, same union semantics.
  authProvider  String          -- "local" | "azure" | "oidc" | "ldap"
  azureOid      String? @unique -- Azure AD Object ID (SAML)
  oidcSubject   String? @unique -- OIDC `sub` claim (stable per-user id for OIDC re-discovery)
  ldapUid       String? @unique -- LDAP objectGUID hex (stable per-user id for LDAP re-discovery)
  ssoGroups     String[]       @default([]) -- Last-seen normalized IdP group keys from the most recent SSO/LDAP login. Lets GET /auth/me re-resolve group→tags dynamically without re-contacting the IdP. Empty for local accounts.
  displayName   String?
  email         String?
  lastLogin     DateTime?
  totpSecret      String?       -- Base32 TOTP secret (null = not enrolled)
  totpEnabledAt   DateTime?     -- Null = not enabled; set on first valid confirm code
  totpBackupCodes String[]      -- argon2id-hashed single-use recovery codes
  needsRoleReview Boolean       -- Flipped true at the password step the first time the user logs in (Asset.lastLogin transitions null → set), EXCEPT for users whose role is already `admin` (an admin reviewing their own role is redundant; this keeps the seed admin's first login on a fresh install from triggering a self-notification). Drives the admin-only "new user logged in" panel in the sidebar (#role-review-status, rendered above #query-status). Auto-cleared when an admin PUTs /users/:id/role (implicit review) or DELETEs /users/:id/role-review (explicit Dismiss). Dismiss is global — clearing the flag hides the row for every admin at once. SAML SSO sets it on auto-provision (always `readonly`) and on first-ever login of an existing non-admin account.

Role                            -- Dynamic role + permission matrix; replaces the prior hardcoded `UserRole` enum
  id            UUID PK
  name          String @unique  -- 2-32 chars, alphanumeric + dash/underscore. Case-insensitive uniqueness enforced at service layer.
  description   String?
  permissions   Json            -- { [functionKey]: "none" | "read" | "write" | "fullwrite" } per the 25-key catalogue in `src/api/middleware/permissions.ts`. Missing keys default to "none" at read.
  -- Region scope inherited by every user holding this role. Empty =
  -- unrestricted. Effective regions for a session are
  -- `union(role, user, group-derived)`.
  regionTags    String[]       @default([])
  otherTags     String[]       @default([]) -- Free-form ("other") tag scope inherited by users with this role; second dimension parallel to regionTags.
  color         String?         -- Badge pill color as `#rrggbb`; null falls back to the legacy name-keyed `.badge-*` CSS classes in the frontend. Drives the sidebar user-badge, the users-table role column, and the Manage Roles list. Built-ins seeded by the `20260601000000_role_color` migration (admin red / networkadmin orange / assetsadmin blue / readonly gray / user green); new roles get a random color from the add-role color picker.
  isBuiltIn     Boolean        @default(false) -- true for the five seeded rows (admin / readonly / networkadmin / assetsadmin / user)
  isProtected   Boolean        @default(false) -- true for admin + readonly only; blocks edit/delete/rename + hides the row from the editable UI
  updatedAt     DateTime        -- Bumped on every write; doubles as the cache-version stamp the session snapshot compares against on each request to detect a stale matrix
  -- Seeded by `prisma/migrations/20260524000000_roles_table_cutover/migration.sql`.
  -- The five seeded rows reproduce the pre-cutover access exactly so
  -- existing users see no behavior change. Operator-created custom roles
  -- start with all-`none` permissions; admin grants per function via the
  -- matrix slide-over on /users.html.

GroupMapping                    -- IdP group → role + tags mapping (applied at OIDC/LDAP login)
  id            UUID PK
  provider      String          -- "oidc" | "ldap" | "saml" — scopes matching so an OIDC group name can't collide with an LDAP DN
  groupKey      String          -- normalized match key: lowercased DN for LDAP, trimmed claim value (exact case) for OIDC/SAML. Normalized identically on write + at login by groupMappingService.normalizeGroupKey.
  groupLabel    String?         -- as-entered form preserved for the admin UI
  roleId        String?         -- FK Role; onDelete: SetNull (a deleted role degrades the mapping to tags-only rather than blocking the delete). Null = tags-only mapping.
  regionTags    String[]       @default([])
  otherTags     String[]       @default([])
  enabled       Boolean        @default(true)
  description   String?
  createdAt     DateTime
  updatedAt     DateTime
  @@unique([provider, groupKey])
  -- At login the user's group claims are matched against the enabled rows for
  -- their provider; matched rows' tags union into effective scope and the
  -- HIGHEST-PRIVILEGE matched role wins (rankRole in permissions.ts). CRUD is
  -- gated on users=fullwrite. A mapping targeting an admin-equivalent role is
  -- a privilege-escalation surface (IdP group membership → Polaris admin,
  -- outside the lastAdminEquivalent guard) — groupMappingService stamps a
  -- warning-level Event when one is created/updated. Seeded by migration
  -- 20260612000000_group_mappings_and_other_tags (which also adds the
  -- otherTags / ssoGroups / oidcSubject / ldapUid columns above).

UserDashboard                   -- Per-user dashboard layout (widget set + positions + sizes + per-widget config)
  userId        String PK FK → User (cascade delete)
  layout        Json            -- v2: { version: 2, columns: Column[] }
                                --   Column = { id (uuid), width 3|4|6|12, widgets: WidgetInstance[] }
                                --   WidgetInstance = { id (uuid), type, height 1|2|3, config }
                                -- Server validates the v2 shape via Zod on PUT (max 12 columns, 64 widgets total);
                                -- GET is unvalidated so a legacy v1 row still loads and is migrated to v2 client-side
                                -- (public/js/dashboard.js migrateV1ToV2). The client owns layout; the server just
                                -- round-trips the blob. Absent row = empty dashboard ("Customize Page → Add Widgets");
                                -- no defaults are seeded so a fresh sign-in is a clean slate. Persists server-side so layouts follow the
                                -- operator across browsers and devices; localStorage continues to hold ephemeral UI
                                -- state (chart ranges, theme, interface-table collapse) per the existing convention.
  updatedAt     DateTime

UserTableTabs                   -- Per-user list-page TABS — this operator's set of open views on one table
                                -- (Assets page tab strip). Absent row = the default single tab, materialized
                                -- client-side and persisted only once they change something.
  userId        String FK → User (cascade delete)   -- PK part 1
  scope         String                              -- PK part 2; same vocabulary as SavedTableFilter.scope
  tabs          Json            -- { version: 1, tabs: [{ id, name, state, savedFilterId?, savedFilterName? }], activeId }
                                --   state = the same { sfFilters, sortKey, sortDir } a preset stores, validated
                                --   by the same sanitizeFilterState. A tab opened FROM a preset keeps only a
                                --   REFERENCE (id + name snapshot) for its label/tooltip — editing the tab never
                                --   writes back, because the preset may belong to someone else.
  updatedAt     DateTime
                                -- CASCADE (unlike SavedTableFilter's SET NULL): nothing here is shared, so a
                                -- deleted user's tabs are pure garbage. UserDashboard pattern otherwise —
                                -- strictly per-caller, no admin override, no Event audit.

SavedTableFilter                -- A named, shareable snapshot of one list page's table filter + sort state
                                -- (Assets page → Filters ▾ → Save current filters). Server-side rather than
                                -- localStorage precisely because presets are shareable.
  id            UUID PK
  scope         String          -- which table ("assets" today); maps to the RBAC function key that gates it
                                -- (savedFilterService.SAVED_FILTER_SCOPES) — adding another list page is one
                                -- line there plus frontend wiring, no new function key, no role migration
  name          String          -- operator's handle AND the overwrite key: same (scope, owner, name) = update
  ownerId       String? FK → User (SET NULL)  -- NOT cascade: a public preset outlives the account that
                                -- published it. The users DELETE handler drops the deleted user's PRIVATE rows
                                -- (nobody could ever see them again); public rows survive with ownerId NULL.
  ownerName     String          -- username snapshot so a surviving public preset still renders an author
  visibility    String          -- "private" (owner only) | "public" (anyone who can read the scope)
  state         Json            -- TableSF getPrefs shape: { sfFilters, sortKey, sortDir }. Validated by
                                -- sanitizeFilterState on every write — this blob is replayed into OTHER
                                -- operators' browsers when a public preset loads. Column widths / hidden
                                -- columns deliberately stay per-browser in localStorage (applyTableLayout):
                                -- they describe the operator's screen, not the query.
  createdAt     DateTime
  updatedAt     DateTime
                                -- @@unique([scope, ownerId, name]) (NULL owners compare distinct, so orphaned
                                -- presets never block a live user from reusing a name), @@index([scope, visibility])

SavedDashboard                  -- A named, shareable snapshot of ONE dashboard canvas (Dashboard page →
                                -- Dashboards ▾ → Save this dashboard). SavedTableFilter's model applied to
                                -- the dashboard, with one consequence that has no parallel there: a PUBLIC
                                -- row is also what the UNAUTHENTICATED Dash wallboard can load, which is why
                                -- publishing is gated a level higher than keeping.
  id            UUID PK
  name          String          -- operator's handle AND the overwrite key: same (owner, name) = update
  ownerId       String? FK → User (SET NULL)  -- NOT cascade: a published dashboard outlives the account that
                                -- published it (it may be on a wallboard right now). The users DELETE handler
                                -- drops that user's PRIVATE rows, exactly as it does for saved filters.
  ownerName     String          -- username snapshot so a surviving public row still renders an author
  visibility    String          -- "private" (owner only) | "public" (every reader of the registry + the wallboard)
  layout        Json            -- ONE canvas: { columns: [ { id, width 3|4|6|12, widgets: [ { id, type,
                                --   height 1|2|3, config } ] } ] } — one entry of UserDashboard.layout
                                --   .dashboards minus its id/name. Not a whole multi-tab layout: a published
                                --   dashboard is one screen, which is what a wallboard shows and what the
                                --   Dashboard page loads as one new tab. Validated on every write by
                                --   savedDashboardService.sanitizeDashboardLayout over the SAME
                                --   utils/dashboardLayout.ts schema /me/dashboard uses — this blob is
                                --   replayed into other operators' browsers and onto wallboards.
  createdAt     DateTime
  updatedAt     DateTime        -- also the wallboard's change signal: its 5-minute poll re-renders only when
                                -- this moves, since a re-render tears every widget down and back up
                                -- @@unique([ownerId, name]), @@index([visibility]) (the wallboard's read has
                                -- no owner to narrow it)
                                -- RBAC: its OWN function key `savedDashboards` (migration
                                -- 20260904040000_saved_dashboards) rather than riding a page's gate the way
                                -- SAVED_FILTER_SCOPES does — the Dashboard page has no function key at all
                                -- (it is gated per WIDGET), so there was nothing to inherit.

ApplicationMapLayout            -- SHARED Application Map node positions — the appmap.html counterpart of
                                -- TopologyLayout, minus the per-site FK (the Application Map is one global
                                -- graph, not rooted on a firewall Asset).
  id            UUID PK
  view          String @unique @default("global") -- one global map today; the column future-proofs sub-views
  positions     Json            -- { [nodeId]: { x, y } } keyed on applicationMapService's deterministic
                                -- node ids (asset:<id>, proc:<assetId>:<b64url(name)>, ip:<ip>,
                                -- ipgroup:<cidr>) so saved layouts survive refresh. Validated by the
                                -- shared topologyLayoutService.sanitizePositions.
  updatedBy     String?
  createdAt     DateTime
  updatedAt     DateTime
                                -- Written via PUT /application-map/layout (applicationMap=write, audited);
                                -- read by everyone via the savedLayout embed on GET /application-map.
                                -- localStorage ("polaris.appmap.positions") is the per-browser fallback for
                                -- readers. Single writer: applicationMapService.

TopologyLayout                  -- SHARED Device Map topology node positions (the per-resource variant of
                                -- the UserDashboard JSON-layout pattern)
  id            UUID PK
  siteId        String FK → Asset (cascade delete) -- the FortiGate the topology graph is rooted on
  view          String @default("flat")            -- "flat" | computeFloorViews key ("b|<area>|<bldg>" / "f|<area>|<bldg>|<floor>").
                                -- Renaming a:/b:/f: codes changes view keys and orphans that view's row (harmless).
  positions     Json            -- { [nodeId]: { x, y } } pixel model coords — the exact shape map.js
                                -- saves/loads (and previously kept only in localStorage). Full-replace per
                                -- save; stale nodeIds are ignored at render and dropped on the next save.
                                -- Last-write-wins between concurrent editors (updatedBy/updatedAt enable a
                                -- future conditional write). Validated by topologyLayoutService
                                -- (sanitizePositions: finite coords, ≤3000 nodes) on top of the route Zod.
  updatedBy     String?
  createdAt     DateTime
  updatedAt     DateTime
  @@unique([siteId, view])
                                -- Written via PUT /map/sites/:id/topology/layout (deviceMap=write, audited);
                                -- read by everyone via the savedLayouts embed on GET /map/sites/:id/topology.
                                -- Server layout wins client-side; localStorage remains the per-browser
                                -- fallback (non-writer drags, pre-server installs). Mobile deliberately does
                                -- NOT apply it (transposed axes). Single writer: topologyLayoutService.

Event                           -- Audit log, 7-day rolling retention
  id            UUID PK
  timestamp     DateTime
  level         String          -- "info" | "warning" | "error" (display source of truth)
  levelRank     Int @default(0) -- Numeric severity stamped at write time by logEvent from `level`:
                                -- 0=info, 1=warning, 2=error (room for -1=debug / 3=critical
                                -- later). The Events list endpoint's sortBy=level dispatches
                                -- to orderBy: { levelRank } so severity sort matches operator
                                -- expectations (info < warning < error) instead of the
                                -- alphabetical accident (error < info < warning). Backed by
                                -- the (levelRank, timestamp) composite index for "severity
                                -- within the 7-day window" Index Scan plans.
  action        String          -- e.g. "block.created", "integration.discover.started"
  resourceType  String?
  resourceId    String?
  resourceName  String?
  actor         String?         -- username that triggered the event
  message       String
  details       Json?
  -- Indexed on: timestamp, action, resourceType, level, (levelRank,timestamp),
  -- (actor,timestamp), (resourceName,timestamp). The trailing-timestamp
  -- composite indexes back the per-column sort UX added when the Events page
  -- adopted the server-side TableSF pattern.

Setting                         -- Key-value configuration store
  key           String PK
  value         Json
  -- Notable keys:
  --   "manualMonitorSettings"                  -- tier-3 settings for assets with no integration source. Same shape as Integration.config.monitorSettings (8 fields).
  --   "monitorSettingsHierarchyMigratedAt"     -- one-shot marker stamped by migrateMonitorSettingsHierarchy. Presence = migration ran; deleting it forces a re-run on next boot.
  --   "mapRegions"                              -- Operator-drawn map regions: `MapRegion[]` ({ id, name, polygon: [[lat,lng],...], color: "#rrggbb", createdBy, createdAt, updatedAt }). `color` is the polygon stroke + fill hue on the map; on create it defaults to a random palette pick (same palette `mapRegionService` uses for the matching Tag registry row) and can be overridden in the create modal or via the polygon-click popup's "Change color" action. Legacy regions written before this field existed are back-filled at read time with a random pick. See `mapRegionService`.
  --   "appMapAutoMap"                           -- Service/process DISCOVERY RULES (Integrations → Polaris Agent): `{version:2, rules:[{id, name, enabled, mode, source, scope, assetIds, processes:{names,patterns,regex}, services:{…}}]}`. `mode` = "map" (monitor + Application Map) | "monitor" (monitor-only); `source` = "manual" | "auto" (minted/consolidated from per-asset Services-tab pin toggles; single-item, scope:null + explicit assetIds — null scope + assetIds targets JUST those assets, and an auto rule losing its last asset is deleted). Each rule pins its items on union(scope matches, assetIds); several rules' pins union per asset. Applied inline on save and re-applied by the 30-min `reconcileAppMapAutoMap` job — the "and future assets too" mechanism. Additive only; `unmapEverywhere` is the separate subtractive path. The pre-rules single-selection shape folds forward into one rule at read time. See `appMapDiscoveryService`.

Tag
  id            UUID PK
  name          String @unique
  category      String @default("General")
  color         String @default("#4fc3f7")
  criteria      Json?            -- optional auto-assignment criteria; NULL = ordinary manual tag. Shape `{version:1, match:"all", rules:[{field, op, values[]} | {field:"subnet", op:"inCidr", cidrs[]}]}` (rules ANDed, values/cidrs ORed). When set, `tagAssignmentService` keeps the tag synced onto matching assets (managed sync). See `tagAssignmentService`.

TagAutoAssignment                -- Provenance for filter-based tag auto-assignment: one row per (tag, asset) pair the engine itself applied. Lets managed sync strip a tag when an asset stops matching WITHOUT touching a hand-applied copy of the same tag name (no provenance row). No FK to Tag/Asset (denormalized tags-by-name design, same no-cascade rationale as sample tables); rows cleaned by the engine on tag delete / filter clear / asset drift.
RegionTagAssignment              -- The same provenance pattern for map-region tags: one row per (regionId, targetType, targetId) pair mapRegionService itself tagged, where targetType is "asset" | "subnet" (regions propagate to both halves, which is why tag_auto_assignments' (tagId, assetId) PK can't be reused). Keyed by region id rather than tag name so a rename leaves it untouched. Bounds the reconcile's strip half: a target that drifted out of the region loses the tag only when a provenance row says we put it there — no row = operator-owned (or predates provenance) and survives forever. No FKs (regions live in a Setting JSON blob; the asset/subnet side follows TagAutoAssignment's rationale); rows cleaned on region delete and on drift.
DirectoryContactSource           -- The same provenance pattern again, for the address-book directory (GAL) sync: one row per (integrationId, externalId) directory object the sync created a Contact for, PK on that pair, `sourceKind` = "entra" | "ad". A person present in BOTH directories owns ONE Contact with TWO of these, and the Contact is deleted only when its LAST source row goes -- a hand-added contact never has one and so survives forever, which is what makes "delete the row when the person leaves the directory" safe. `observed` is the per-source DirectoryPerson blob (employee PII at rest), and the Contact is PROJECTED from the set rather than last-writer-wins, so two directories that disagree about a title can't ping-pong the row on alternating runs -- the AssetSource / projectAssetFromSources shape at contact scale. FK to Contact cascades (a contact nothing claims should take its provenance with it); there is deliberately NO FK on integrationId, because a cascade from integrations would strip the provenance while leaving the Contact rows it justified in place -- exactly the state in which the sync can no longer tell its own rows from an operator's, so it could neither refresh nor remove them. Integration delete and the sync-disable toggle call purgeDirectoryContacts explicitly instead. Adoption (`adoptDirectoryContact`) deletes these rows in the same transaction as the `Contact.origin` flip. See business rule 35.
  tagId         String
  assetId       String
  createdAt     DateTime @default(now())
  @@id([tagId, assetId])

GeocodeCache                    -- Positive+negative cache for `geocoderService.geocode()`. Negative results (no Nominatim hit) are stored too so gibberish sysLocation strings don't repeatedly hit upstream. Refreshed on TTL expiry; transport failures don't poison the cache.
  id           UUID PK
  query        String @unique  -- normalized lookup key: trim + collapse whitespace + lowercased
  displayQuery String           -- original-case query string for UI display
  latitude     Float?           -- null = geocoded but no result found (negative cache)
  longitude    Float?
  provider     String           -- "nominatim"
  fetchedAt    DateTime
  ttlExpiresAt DateTime         -- default fetchedAt + 90 days

MibFile                         -- Admin-uploaded SNMP MIB modules used to resolve vendor-specific OIDs during monitoring
  id            UUID PK
  filename      String           -- original upload filename
  moduleName    String           -- parsed from "<NAME> DEFINITIONS ::= BEGIN" (validated as a real SMI module on upload — non-MIB text or binaries are rejected)
  manufacturer  String?          -- null = generic/shared MIB (loaded for every probe). Normalized through the ManufacturerAlias map on every write via the Prisma extension in src/db.ts.
  model         String?          -- null = applies to all models from this manufacturer
  contents      String           -- raw MIB text, stored inline (MIBs are normally <100 KB; cap = 1 MB)
  imports       String[]         -- module names referenced via IMPORTS ... FROM (used to surface missing dependencies in the UI)
  size          Int              -- byte length of contents
  notes         String?
  uploadedBy    String?
  uploadedAt    DateTime
  @@unique([manufacturer, model, moduleName])  -- Postgres treats NULLs as distinct, so the service layer also rejects duplicate generic MIBs
  -- `assetId` (Slice 6a) pins a MIB to one specific asset — the most-specific tier of the resolver priority (asset → model → manufacturer → generic → seed). SetNull on asset delete so the MIB text stays reachable for download/audit. Selectable from a new Scope radio group on the MIB upload form.

ManufacturerProfile             -- Operator-editable per-manufacturer telemetry profile. Replaces the hardcoded VENDOR_TELEMETRY_PROFILES constant at runtime; the constant stays as a fresh-install fallback until the resolver swap lands. Seeded idempotently from the constant on first boot via `seedManufacturerProfiles` startup job.
  id            UUID PK
  manufacturer  String @unique     -- canonical form via the ManufacturerAlias map
  createdBy, createdAt, updatedAt
  -- One row per alias-canonicalized manufacturer. Metric rows + per-model overrides + custom widgets are nested below. Edited from Server Settings → Credentials → Manufacturer Profiles. Cache lives in manufacturerProfileService.refreshProfileCache; hot reads are sync.

ManufacturerProfileMetric       -- One row per System-tab metric the profile owns: cpu / memory / temperature / interfaces / lldp / storage / wirelessStations
  id              UUID PK
  profileId       UUID FK → ManufacturerProfile (cascade)
  metricKey       String           -- "cpu" | "memory" | "temperature" | "interfaces" | "lldp" | "storage" | "wirelessStations"
  defaultSymbol   String?          -- null = use built-in seed for this metric. For `defaultType="double_scalar"` this is the "A" OID; for `scalar`/`table` it's the single OID.
  defaultSymbolB  String?          -- Second OID for the `double_scalar` shape (the "B" OID). Combined with `defaultSymbol` via the combiner in `defaultTransform` at probe time. Null on `scalar` / `table` — the service write-path force-nulls it whenever `defaultType !== "double_scalar"` so an old value from a previous double_scalar config can't get accidentally re-promoted.
  defaultMibId    UUID? FK → MibFile (set null on delete)
  defaultMibStdKey String?         -- Operator-pinned standard MIB hint (e.g. `"std:lldp"`, `"std:host-resources"` — keys mirror `_SNMP_STANDARD_MIBS` in `public/js/assets.js` and `STD_MIB_KEYS` in `manufacturerProfileService.ts`). Mutually exclusive with `defaultMibId` — picking a standard MIB in the UI clears the uploaded-MIB FK and vice versa; the service rejects requests that set both as non-null. Display-only at probe time (the resolver still walks asset → model → vendor → generic → seed); lets the Manufacturer Profile MIB column show a meaningful label for metrics whose symbol comes from a built-in seed rather than the literal word "seed".
  defaultType     String           -- "scalar" | "double_scalar" | "table"
  defaultTransform String?         -- For `scalar`/`table`, a unary `TransformKind` (`celsius_to_fahrenheit` / `bytes_to_mb` / `ratio_to_percent` / ...); for `double_scalar`, a binary `CombinerKind` (`a_over_b_as_percent` / `a_over_a_plus_b_as_percent` / `b_minus_a_over_b_as_percent` / `a_minus_b` / `a_plus_b` / `a_over_b_ratio`). Null on `table`, optional on the other two. Validated at write time against the matching registry in `src/utils/symbolTransforms.ts` based on `defaultType` — a unary transform on a `double_scalar` row (or a combiner on a `scalar` row) is a 400 at the service layer.
  composition     Json?            -- DEPRECATED. Was the memory-only multi-OID blob (`{ shape, usedSymbol?, totalSymbol?, freeSymbol?, pctSymbol? }`). Superseded by the generic `defaultType="double_scalar" + defaultSymbolB + defaultTransform=<CombinerKind>` shape that any metric can now use. Kept on the schema for one release as a rollback safety net for the data migration that promoted existing rows; the `20260531000000_manufacturer_profile_double_scalar` SQL migration walks every row with a non-null composition and rewrites it into the new columns (`percent → scalar`; `bytes_used_total → double_scalar + a_over_b_as_percent`; `bytes_used_free → double_scalar + a_over_a_plus_b_as_percent`). New writes MUST NOT populate this column; new reads ignore it. To be dropped in a follow-up migration once production has settled.
  @@unique([profileId, metricKey])

ManufacturerProfileMetricOverride -- Per-model exception inside one metric row
  id             UUID PK
  metricRowId    UUID FK → ManufacturerProfileMetric (cascade)
  modelPattern   String            -- regex matched against Asset.model
  symbol         String            -- For `type="double_scalar"` this is the "A" OID; for `scalar`/`table` it's the single OID.
  symbolB        String?           -- Second OID for the `double_scalar` shape. Same write-path rules as `ManufacturerProfileMetric.defaultSymbolB` — force-nulled whenever `type !== "double_scalar"`.
  mibId          UUID? FK → MibFile (set null on delete)
  mibStdKey      String?           -- Per-override standard MIB hint; same mutual-exclusion contract as `ManufacturerProfileMetric.defaultMibStdKey`.
  type           String            -- "scalar" | "double_scalar" | "table"
  transform      String?           -- TransformKind on scalar / table; CombinerKind on double_scalar; null on table.
  order          Int               -- evaluation order (lower wins)
  composition    Json?             -- DEPRECATED. Same rationale + removal plan as `ManufacturerProfileMetric.composition`.
  -- Resolved at probe time by walking overrides in `order` and picking the first whose `modelPattern` regex matches `Asset.model`; no matches falls back to the parent metric row's defaults. FOUR metric keys are actually read by the runtime — `cpu` / `memory` / `temperature` / `storage` (the last since 2026-08; `interfaces` / `lldp` / `wirelessStations` are table walks with no symbol to swap and stay descriptive on the profile page). Seeded entries cover the Fortinet sub-families: `FortiSwitch → fsSysCpuUsage / fsSysMemUsage / fsSysDiskUsage`, `FortiAP → fapCpuUsage / fapMemoryUsage / fapTemperature`. The FortiSwitch memory override is stamped as `type="double_scalar", symbol="fsSysMemUsage", symbolB="fsSysMemCapacity", transform="a_over_b_as_percent"` so the editable profile matches the hardcoded baseline's bytes-form semantics. Existing installs receive the promotion via the `backfillManufacturerProfileMemoryComposition` startup job (kept its legacy name for marker-key back-compat).

ManufacturerCustomWidget        -- Powers Slice 7's Custom MIB tab. Every asset whose alias-normalized manufacturer matches the parent profile (and whose model satisfies the optional `modelPattern` gate) renders this widget against its own SNMP data.
  id             UUID PK
  profileId      UUID FK → ManufacturerProfile (cascade)
  name           String            -- operator-set label, e.g. "Connected Wireless Clients"
  symbol         String
  mibId          UUID FK → MibFile -- required (custom widgets always reference an uploaded MIB)
  type           String            -- "scalar" | "table" (auto-detected from MIB; operator may override)
  widgetType     String            -- "gauge" | "line" | "table" | "state"
  transform      String?
  displayOptions Json              -- type-specific blob (gauge min/max + thresholds; line aggregate/range/unit; table column list / decode rules)
  order          Int
  modelPattern   String?           -- optional per-model gating
  stateMap       Json?             -- STATE PROBE (widgetType="state") only: the declared 0/1 mapping `{mode, values[], trueLabel, falseLabel, trueIsProblem}` — see src/utils/stateProbes.ts. Nullable, and forced to NULL on non-state widgets by stateFieldsForWrite so flipping a widget's type can't leave a stale mapping for a later flip back to resurrect. Read back through normalizeStateMap (never throws) so a row predating a mode still yields a usable mapping on the telemetry hot path.
  labelSymbol    String?           -- STATE PROBE only: optional sibling symbol supplying each TABLE row's name, joined to the value walk on the shared OID index suffix (fgHwSensorEntName beside fgHwSensorEntAlarm). Without it rows are only nameable by bare index, which differs per model — so an alert would read "row .14 is in Alarm". Ignored on scalar probes.
  -- Widget definitions are configured under their parent ManufacturerProfile. The Slice 7 collector + asset details tab consume these rows; Slice 6a only owns persistence and the admin CRUD surface.
  -- A widgetType="state" row is a STATE PROBE rather than a rendered widget: the same walk, but each reading is mapped to a boolean at scrape time and written to AssetStateSample, which makes it alertable per row via the `customStateValue` automation metric. It still renders on the Custom MIB tab (as a per-row OK/Alarm list). `listStateProbes()` flattens every profile's probes for the automation builder, which needs each probe's NAME (its dimension value is this UUID) and its two state LABELS.

ManufacturerAlias               -- Vendor name normalization map; collapses IEEE legal forms into a single canonical brand
  id            UUID PK
  alias         String @unique  -- input string to rewrite, stored lowercased + trimmed (e.g. "fortinet, inc.")
  canonical     String          -- canonical name the alias rewrites to (e.g. "Fortinet"), stored as-typed
  -- Loaded into an in-memory cache by manufacturerAliasService.refreshAliasCache() at startup and after every CRUD mutation. The Prisma extension in src/db.ts reads the cache to canonicalize Asset.manufacturer / MibFile.manufacturer on every create/update/updateMany/upsert. Mutations also run applyAliasesToExistingRows() in the background so admin edits propagate to historical data. Default seed (idempotent) ships ~25 common IEEE → marketing-name mappings (Fortinet, Inc. → Fortinet, Cisco Systems, Inc. → Cisco, etc.); admins extend the map from Server Settings → Identification → Manufacturer Aliases.

DeviceIcon                      -- Operator-uploaded topology node icons; resolved per (scope, key) most-specific-first (manufacturer-model → manufacturer-type)
  id            UUID PK
  scope         String          -- "manufacturer-model" | "manufacturer-type"
  key           String          -- canonical "<manufacturer>/<model|assetType>" lookup key
  filename      String
  mimeType      String          -- PNG/JPEG/WebP; SVG uploads are rasterized to PNG on upload (see deviceIconService + rasterizeStoredSvgIcons job)
  data          Bytes           -- raw image bytes stored inline
  size          Int
  uploadedBy    String?
  uploadedAt    DateTime
  @@unique([scope, key])
```

---

## Notes

#### SshHostKey

**SshHostKey** — trust-on-first-use pins for SSH **server** host keys (one row per dialed `(host, port)`, plain table `ssh_host_keys`, no Asset FK — a host is often onboarded before it exists as an Asset). Written by `sshHostKeyService.verifyOrPin`: no pin → store + accept, match → accept, **differs → refuse** the connection + warn-level `ssh.host_key.mismatch`. Fingerprints are `SHA256:<unpadded base64>`, identical to `ssh-keygen -lf`. Gated per credential by `SshConfig.verifyHostKey` — **opt-in, default OFF** (default ON for new credentials), mirroring WinRM's `verifyTls`, because before this Polaris passed no `hostVerifier` to ssh2 and accepted ANY host key on every SSH path (agent install, agentless processes, the SSH probe). `buildHostVerifier` in `utils/remoteExec.ts` is shared by both `ssh2.connect` sites and fails closed. Operator list + Delete on Integrations → Polaris Agent → Windows SSH Deployment; deleting a pin is the audited recovery for a rebuilt host. See business rule 21.

#### Credential

**Credential** — named SNMP / WinRM / SSH / REST API / **HTTP** credentials for monitoring probes. **`createdBy` is the ownership dimension of the `credentials` function key** (business rule 43, migration `20260904050000_credential_ownership_and_probe_readonly`): a `write`-level role reaches only the rows it created — edit, delete AND test-with, that last one because naming a stored `id` on `POST /credentials/test` merges the row's real secrets into the probe — while `fullwrite` reaches any. Stamped once at create from the session username and never rewritten by an update, so saving a row cannot adopt it; `null` means UNOWNED (every row predating the column — deliberately NOT backfilled, since inventing an owner would hand a write-level operator every secret the install already had) and is fullwrite-only, exactly as `assertOwnership` already treats a null `createdBy` on a subnet or a contact. Indexed on `createdBy`, no FK — a username string that survives the account being deleted, like its three siblings. The `http` type carries **authentication only** — `authMode` (`bearer` | `basic` | `digest`) plus its carrier — and deliberately has no "none" mode. It used to carry the whole health check as well; that half moved to a manufacturer custom widget in 2026-08 because a check varies by vendor AND model while a login varies by vendor or site, so sharing one row meant a second path needed a second copy of the same password. See business rule 33. The `ssh` type takes `password` OR `privateKey` (+ optional `passphrase` for an encrypted key — operator-supplied escrow keys only; a Polaris-generated deployment key is never exported so a passphrase would sit beside the key it protects), plus opt-in `verifyHostKey` (business rule 21). `publicKey` is present but deliberately NOT masked. Secret fields inside `config` are **encrypted at rest** by the Prisma extension in `src/db.ts` when `POLARIS_SECRET_KEY` is set (see business rule 20b); masked-on-read at the API layer as before. The same applies to `Integration.config`, `NotificationChannel.config` and the secret-bearing `Setting` rows.

#### ManufacturerProfile

**ManufacturerProfile** / **ManufacturerProfileMetric** / **ManufacturerProfileMetricOverride** / **ManufacturerCustomWidget** — operator-editable per-manufacturer telemetry profile + custom widget definitions. `ManufacturerCustomWidget.widgetType` is `gauge | line | table | state | http`. **`state`** is a state probe (nullable `stateMap` + `labelSymbol`, `listStateProbes()` flattens them for the automation builder) — see `AssetStateSample` above. **`http`** is an HTTP CHECK (migration `20260825000000`): `symbol`/`mibId` are NULL on it (it names a request, not an OID — required for every other type, enforced in the service since the rule is per-widgetType and a column cannot express it), the definition lives in `httpCheck Json?`, and `credentialId` points at an `http` Credential (`SetNull`; NULL = unauthenticated). Every widget type is gated by `modelPattern` — blank means every asset of that manufacturer. See business rule 33.

#### ManagedAgent

**ManagedAgent** — Polaris Agent install record per Asset (os/arch, agent version, install credential, cert-pin set for dual-pin rotation, `installScriptId` = curated OS-locked install-method variant from the `agentInstallScripts` catalog — null = per-OS default). `privilegeTier` (Linux-only, default `"unprivileged"`) selects the systemd unit: **`unprivileged`** = the hardened `DynamicUser`/`NoNewPrivileges`/`ProtectSystem=strict` unit; **`ptrace`** = that same hardened unit plus `AmbientCapabilities=CAP_SYS_PTRACE CAP_DAC_READ_SEARCH`, the pair that lets the agent read other users' `/proc/<pid>/fd` for Application Map connection→PID attribution WITHOUT full root — both are required: the fd dir's open is a DAC check only DAC_READ_SEARCH passes, the readlink is the ptrace check (SYS_PTRACE alone collects zero rows; prod 2026-07-29). Operator opt-in with a warning — the pair also permits reading any process's memory and any file on the host. Unit text is written only at install/reinstall, so pre-fix ptrace agents need a reinstall; the agent (≥0.17.1, Linux) reports its actual CapEff on heartbeat (`ManagedAgent.reportedCapEff`, decoded by `utils/capEff`) so the Privilege surfaces render the VERIFIED state — a stale SYS_PTRACE-only unit shows red "reinstall" instead of looking healthy. Full **root** was retired with service control (Satellite-posture change); `privilegeTier="root"` survives only as a legacy value on pre-migration rows and is never emitted for new installs — reinstalling such an agent downgrades it to `unprivileged`/`ptrace`. Windows agents always run as LocalSystem, macOS LaunchDaemons as root, so the tier is Linux-only. The tier maps to the `[Service]` block in `src/utils/agentUnit.ts` (pure, `linuxServiceBlock`/`normalizePrivilegeTier`). The privilege change on reinstall rides `POST /assets/:id/agent/reinstall` (`privilegeTier` body field).

#### UserTableTabs

**UserTableTabs** — per-user list-page TABS (the Assets page tab strip): one row per `(user, scope)` holding `{version, tabs[{id, name, state, savedFilterId?, savedFilterName?}], activeId}`. Each tab carries its own filter+sort `state` (validated by the same `sanitizeFilterState` a preset uses); a tab opened from a preset keeps only a REFERENCE for its label — editing it never writes back, since the preset may be someone else's. Strictly per-caller, no Event audit, CASCADES with the user (the UserDashboard pattern — nothing here is shared, unlike a public SavedTableFilter, which deliberately outlives its author). Absent row = the default single tab, materialized client-side and persisted only once the operator changes something. ≤20 tabs; a stale `activeId` is repaired to the first tab rather than 400-ing the layout away.

#### SavedTableFilter

**SavedTableFilter** — a named, optionally SHARED snapshot of one list page's table filter + sort state (Assets page → Filters ▾). `scope` names the table ("assets" today) and maps to the RBAC function key that already gates that page (`SAVED_FILTER_SCOPES` in `savedFilterService`) — no new permission key. `visibility` is `private` (owner only) or `public` (anyone who can read the scope; publishing needs `<key>:write`, deleting someone else's needs `<key>:fullwrite`). `state` is the TableSF `getPrefs` shape `{ sfFilters, sortKey, sortDir }`, re-validated by `sanitizeFilterState` on every write because a public preset is replayed into other operators' browsers; column widths/visibility deliberately stay per-browser in localStorage. `ownerId` is SetNull (a shared preset outlives its author; the users DELETE drops only their private rows), with `ownerName` snapshotted for display. Same `(scope, owner, name)` save updates rather than duplicating.

#### TopologyLayout

**TopologyLayout** — SHARED Device Map topology node positions, one row per (siteId = FortiGate Asset id, view = `"flat"` | `computeFloorViews` building/floor key); `positions` = `{nodeId: {x,y}}` pixel coords. Written full-replace by operator drags in the topology modal (debounced PUT, gated `deviceMap=write`, last-write-wins); embedded for every viewer as `savedLayouts` on `GET /map/sites/:id/topology` — server layout wins over the per-browser localStorage fallback. Cascades with the site Asset. Single writer: `topologyLayoutService`.

**The row carries TWO blobs.** `positions` is the LIVE layout — rewritten by every debounced drag save, shared with every viewer. `savedPositions` (with `savedBy` / `savedAt`) is the operator's RESTORE POINT, written ONLY by the explicit Save (`POST …/topology/layout/checkpoint`) and never by a drag: a drag is not a decision, and letting one overwrite the restore point would leave nothing to reset to. That split is the whole feature — Reset stopped being one destination and became two:

- **Reset to last save** — the client copies `savedPositions` back over the live blob through the normal save pipeline (so both stores land it like a drag would). The restore point SURVIVES, because an operator who restores once usually wants to do it again after the next experiment.
- **Reset to baseline** — `DELETE …/topology/layout?view=…`. A row carrying a restore point is EMPTIED (`positions` → `{}`, which restores nothing at render, so the column solver's own placement stands) rather than deleted; a row without one is deleted outright, which is the pre-checkpoint behavior. Emptying is what lets an operator reset to baseline and still change their mind.

NULL `savedPositions` means this (site, view) was never saved — the state every pre-existing row starts in (migration `20260904030000_topology_layout_checkpoint` backfills nothing), and what greys out the menu's last-save entry. The browser mirrors both blobs: `polaris.topology.positions:<siteId>[:<view>]` for the live layout and `polaris.topology.saved:<siteId>[:<view>]` for the restore point, which is the only half a non-writer gets (their drags were already local-only).

#### Event

**Event** — audit log, 7-day rolling retention. Four per-asset **change events** are written edge-triggered and **unconditionally** (never behind the `change.*` family's subscription gate, since they're rare and wanted in the audit log regardless): `asset.firmware.changed` (os/osVersion), `asset.switch_port.changed` (`lastSeenSwitch`), `asset.wireless_ap.changed` (`lastSeenAp` — every roam), `asset.gateway_firewall.changed` (the freshest `AssetFortigateSighting` flipped gate). Row builders are pure and centralized in `eventLogService`; firmware deliberately suppresses a null→value first learn (that's identification, already covered by `asset.discovered`/`asset.discovery_updated`) while a connection event reports it. Discovery emits them from an end-of-run baseline rather than at each write, because Phase 7 vs Phase 11 (coarse-then-corrected `osVersion`) and Phase 7 vs Phase 7.5 (two formats for the same switch port) ping-pong within a single run. All four appear in the automations change-trigger picker. See polaris-change-impact → cross-cutting/asset-change-events.md.

#### Setting

**Setting** — key-value config store (`manualMonitorSettings`, `sampleRetention`, `mapRegions`, `agentEventLog`, `branding` (appName / subtitle / logoUrl / **`logoAccent`** + **`logoOnLogin`** + **`logoOnSidebar`** — see business rule 27 — + **`temperatureUnit`** — the install-wide DISPLAY-ONLY °C/°F choice for hardware sensors, Server Settings → Customization → Display Units. Samples are always collected, stored, rolled up and ALERTED ON in Celsius; the frontends convert at render via `public/js/temp-unit.js`, gated on each reading's own stored unit so fan RPM / voltage rails are untouched, and automation thresholds stay °C. It rides branding because that payload is unauthenticated, cached in localStorage for synchronous reads, and reaches the identity-less Dash wallboard), `appMapAutoMap`, `backupSchedule`, `backup_history`, `assetSourcePriority`, `reservationMacPlaceholder`, `loginAccessConfig`, etc.). `assetSourcePriority` (`{order[], integrationPrefix}`, Assets → Settings → Sources) orders which discovery source's learned location wins — see business rule 22. `reservationMacPlaceholder` (`{prefix}`, default `02:0F:5E`, Server Settings → Identification) is the OUI every generated placeholder MAC starts with, and the only thing marking such a MAC as synthetic — see business rule 26. `agentEventLog` (`{enabled, minLevel, windowsChannels, linuxMinPriority, maxPerPush, perAssetHourlyCap}`, default disabled) tunes the OS event-log → audit Event ingest (`osEventLogService`); ingested host events become `os_event.<channel>` Events (resourceType=asset) visible in the Events tab.

#### Tag

**Tag** / **GeocodeCache** — registry tables. `Tag` carries an optional **auto-assignment device filter**; when set, `tagAssignmentService` keeps the tag synced onto matching assets (managed sync — adds AND removes on drift). `assetCondition` is the shape: the SAME nested AND/OR condition tree the automations device filter and `Contact.assetCondition` store, validated against `DEVICE_FILTER_FIELD_OPS` and evaluated by the same `evaluateScopeCondition`, so "which devices?" is asked in one language across all three surfaces (and edited in one place — the shared `PolarisConditionBuilder`). It supersedes the flat `criteria` blob it shipped with (manufacturer/model/os/osVersion/hostname/department/location/assetType/status/subnet + the relation-backed `integration` and `fortigate`): both columns are still READ but only ONE is live per row (a write of either clears the other), pre-cutover rows fold forward through the pure `criteriaToCondition` on read, and the `migrateTagFilterShape` one-shot persists it — the `Contact` cutover repeated verbatim. `integration` is the one flat field with no tree equivalent, so a blob carrying it stays on the legacy predicate rather than being half-converted. Two asymmetries with `Contact`, both load-bearing: an **EMPTY tree is NO filter, never "all devices"** (a contact stores `and([])` deliberately as the form of an explicit All-devices checkbox; a tag has no such control, so an empty tree could only come from a half-built form and honoring it would tag the whole fleet on save), and a **decommissioned asset is skipped unless the filter mentions status** (implicit in the flat resolver's `buildPrefilterWhere`, stated explicitly for the tree so the shape cutover couldn't quietly begin tagging retired inventory). **The "Map Regions" category is locked to the Device Map**: the tag registry refuses creating a tag there and refuses MOVING one in (the same act), and a tag in it may not carry a filter at all — those tag names are already managed by the region reconcile through `RegionTagAssignment`, and a second managed-sync engine on the same NAME would spend every cycle undoing the first. Editing the map's own rows is unaffected. **TagAutoAssignment** is the per-(tag,asset) provenance table that lets managed sync strip auto-applied copies without ever touching a hand-applied copy of the same tag name. **RegionTagAssignment** is the same pattern for `region:<name>` tags (`mapRegionService`): one row per (regionId, targetType asset|subnet, targetId) the reconciler itself tagged, keyed by region id so a rename doesn't disturb it — what lets the daily/6h re-evaluation strip a region tag off a device that MOVED (re-pinned gate, repointed switch, re-served subnet) while never touching operator hand-attachments or tags predating provenance.

---
