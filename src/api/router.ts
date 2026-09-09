/**
 * src/api/router.ts
 */

import { Router } from "express";
import authRouter from "./routes/auth.js";
import blocksRouter from "./routes/blocks.js";
import subnetsRouter from "./routes/subnets.js";
import reservationsRouter from "./routes/reservations.js";
import utilizationRouter from "./routes/utilization.js";
import usersRouter from "./routes/users.js";
import integrationsRouter from "./routes/integrations.js";
import assetsRouter from "./routes/assets.js";
import logFlagRulesRouter from "./routes/logFlagRules.js";
import eventsRouter from "./routes/events.js";
import notificationsRouter from "./routes/notifications.js";
import notificationRulesRouter from "./routes/notificationRules.js";
import automationScriptsRouter from "./routes/automationScripts.js";
import maintenanceSchedulesRouter from "./routes/maintenanceSchedules.js";
import contactsRouter from "./routes/contacts.js";
import networkScansRouter from "./routes/networkScans.js";
import notificationChannelsRouter from "./routes/notificationChannels.js";
import pushSubscriptionsRouter from "./routes/pushSubscriptions.js";
import conflictsRouter from "./routes/conflicts.js";
import serverSettingsRouter from "./routes/serverSettings.js";
import proxySettingsRouter from "./routes/proxySettings.js";
import mibsRouter from "./routes/mibs.js";
import manufacturerProfilesRouter from "./routes/manufacturerProfiles.js";
import deviceIconsRouter from "./routes/deviceIcons.js";
import searchRouter from "./routes/search.js";
import mapRouter from "./routes/map.js";
import applicationMapRouter from "./routes/applicationMap.js";
import weatherRouter from "./routes/weather.js";
import mapRegionsRouter from "./routes/mapRegions.js";
import allocationTemplatesRouter from "./routes/allocationTemplates.js";
import credentialsRouter from "./routes/credentials.js";
import manufacturerAliasesRouter from "./routes/manufacturerAliases.js";
import assetTypesRouter from "./routes/assetTypes.js";
import monitorSettingsRouter from "./routes/monitorSettings.js";
import apiTokensRouter from "./routes/apiTokens.js";
import dashboardRouter from "./routes/dashboard.js";
import userDashboardRouter from "./routes/userDashboard.js";
import savedFiltersRouter from "./routes/savedFilters.js";
import savedDashboardsRouter from "./routes/savedDashboards.js";
import tableTabsRouter from "./routes/tableTabs.js";
import notificationPreferenceRouter from "./routes/notificationPreference.js";
import userTimezoneRouter from "./routes/userTimezone.js";
import { agentsEnrollRouter, agentsRouter, agentsBinaryRouter } from "./routes/agents.js";
import { haRouter, haEnrollRouter } from "./routes/ha.js";
import rolesRouter from "./routes/roles.js";
import groupMappingsRouter from "./routes/groupMappings.js";
import { requireAuth, attachApiToken } from "./middleware/auth.js";
import { requirePermission } from "./middleware/permissions.js";

export const router = Router();

// Resolve any presented bearer token before any auth gate runs. Sets
// req.apiToken when valid; never enforces on its own.
router.use(attachApiToken);

// Auth routes are public (login, logout, session check)
router.use("/auth", authRouter);

// Branding is public so the login page can display custom name/logo
router.get("/server-settings/branding", async (_req, res, next) => {
  try {
    const { getBranding } = await import("./routes/serverSettings.js");
    res.json(await getBranding());
  } catch (err) { next(err); }
});

// The operator's logo with the Polaris symbol composited onto it. Public for
// the same reason the branding payload is: the login page renders it before
// anyone has a session. Declared here (above requireAuth) rather than in the
// serverSettings router, so there is exactly one definition of the path.
router.get("/server-settings/branding/logo-accent.png", async (req, res, next) => {
  try {
    const { renderAccentedLogo, normalizeBrandTheme } = await import("../services/brandLogoService.js");
    // ?theme= picks the symbol variant: its wedges are white on the dark one
    // and navy on the light one, so the wrong variant loses half the mark
    // against the page behind it. Narrowed to the two known values — this is
    // an unauthenticated route reaching the filesystem.
    const rendered = await renderAccentedLogo(normalizeBrandTheme(req.query.theme));
    if (!rendered) {
      // Accent off, no custom logo, or an unrenderable one — send the caller to
      // whatever the plain logo is instead of 404-ing a live <img>.
      const { getBranding } = await import("../services/brandingService.js");
      res.redirect(302, (await getBranding()).logoUrl);
      return;
    }
    // Revalidate every time: the upload route reuses one filename, so the URL
    // can't carry a version. A 304 costs one stat + a hash of two stamps.
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("ETag", `"${rendered.etag}"`);
    if (req.headers["if-none-match"] === `"${rendered.etag}"`) {
      res.status(304).end();
      return;
    }
    res.type("image/png").send(rendered.buf);
  } catch (err) { next(err); }
});

// Polaris Agent — /enroll and /binary/:filename are public (no bearer
// yet; the body or path carries everything needed). The rest of
// /agents/* is gated by the requireAgentBearer middleware mounted
// inside agentsRouter itself. Mounted here BEFORE the blanket
// requireAuth so /enroll + /binary are reachable without a session.
// /binary mounts BEFORE /enroll because both must be parsed before the
// /agents catch-all; Express's first-match routing handles ordering.
router.use("/agents/binary", agentsBinaryRouter);
router.use("/agents/enroll", agentsEnrollRouter);
router.use("/agents", agentsRouter);

// HA node enrollment — a node being built has no session and no bearer;
// it presents a single-use token in the body, exactly like /agents/enroll,
// so it mounts here above requireAuth. Redeeming the token only registers
// a PENDING request: an operator has to approve the node in the UI before
// any bundle is released, so this surface cannot hand out secrets on its
// own. The gated half of the feature is mounted after requireAuth below.
router.use("/ha/enroll", haEnrollRouter);

// Everything below requires an active session OR a valid bearer token.
// Both caller kinds pass the same requirePermission(...) gates: sessions
// resolve their login-stamped role snapshot, tokens resolve the Role they
// were bound to at mint time. A token reaches exactly what its role grants.
router.use(requireAuth);
// HA operator surface. Gates are per-route inside the file: reads at
// serverSettingsSystem=read, and anything that mints a token, approves a
// node or changes the cluster at fullwrite — those hand over the keys to
// the install. Mounted before /server-settings so "ha" is never captured
// as a settings sub-path.
router.use("/ha", haRouter);
router.use("/blocks", blocksRouter);
router.use("/subnets", subnetsRouter);
router.use("/allocation-templates", allocationTemplatesRouter);
router.use("/reservations", reservationsRouter);
// Utilization reports enumerate the IP space, so they carry the same read
// gate as the blocks they describe. Blanket-gated at the mount: bearer tokens
// (no role snapshot) and ipBlocks=none roles get a 403.
router.use("/utilization", requirePermission("ipBlocks", "read"), utilizationRouter);
// /dashboard/summary is deliberately NOT 403-gated — it's the redirect target
// for users bounced off gated pages. The handler filters sections by the
// caller's per-function read access instead (denied sections come back empty).
router.use("/dashboard", dashboardRouter);
router.use("/me/dashboard", userDashboardRouter);
// Per-user list-page tabs (Assets page tab strip) — the /me/dashboard sibling.
router.use("/me/table-tabs", tableTabsRouter);
// How the caller wants to be alerted (email / push / both) — the third
// per-caller /me route. Stored on the User so it follows them between devices;
// each client enrolls or unsubscribes its own browser to match at boot.
router.use("/me/notification-preference", notificationPreferenceRouter);
router.use("/me/timezone", userTimezoneRouter);
// Saved table filters (Assets page → Filters ▾). Gated per-request on the
// function key that owns the requested scope — see routes/savedFilters.ts.
router.use("/saved-filters", savedFiltersRouter);
// Saved dashboards (Dashboard page → Dashboards ▾) — named canvases, private
// or PUBLIC. The same router is mounted on the Dash wallboard listener, which
// is session-less and GET-only, so a public dashboard is what a wallboard can
// load; its own read floor lives inside the route file so both mounts share it.
router.use("/saved-dashboards", savedDashboardsRouter);
router.use("/users", requirePermission("users", "read"), usersRouter);
router.use("/roles", rolesRouter);
router.use("/group-mappings", requirePermission("users", "fullwrite"), groupMappingsRouter);
router.use("/integrations", requirePermission("integrations", "read"), integrationsRouter);
// asset-types is mounted BEFORE /assets so Express's first-match routing
// picks the registry endpoint instead of treating "types" as an asset id.
// Reads gated by assets=read; writes by assets=write (admin + assetsadmin
// in the default role matrix). Custom-type CRUD lives here; the eight
// built-ins are seeded as isProtected=true and reject rename/delete.
router.use("/asset-types", assetTypesRouter);
router.use("/assets", assetsRouter);
router.use("/log-flag-rules", logFlagRulesRouter);
router.use("/events", eventsRouter);
// ─── Automations (canonical) + notification-era aliases ─────────────────
// The Automations redesign renamed the user-facing API surface. Canonical
// paths are /automations (rules), /alerts (triggered instances), and
// /delivery-channels (outbound channels); the pre-rename paths stay mounted
// on the SAME routers as deprecated aliases so existing API clients and
// already-delivered web-push payloads keep working. Alias mounts carry
// Deprecation/Link headers pointing at the successor path.
const deprecatedAlias = (successor: string) =>
  ((req, res, next) => {
    res.setHeader("Deprecation", "true");
    res.setHeader("Link", `<${successor}>; rel="successor-version"`);
    next();
  }) as import("express").RequestHandler;
// Script registry — MUST mount before /automations so "scripts" is never
// captured as a rule id. Gated automationScripts (RCE-equivalent key).
router.use("/automations/scripts", automationScriptsRouter);
// Rules CRUD/schema/preview.
router.use("/automations", notificationRulesRouter);
router.use("/notification-rules", deprecatedAlias("/api/v1/automations"), notificationRulesRouter);
// Maintenance schedules (Assets page → Maintenance modal); per-route gates
// on the maintenanceManagement function key.
router.use("/maintenance-schedules", maintenanceSchedulesRouter);
// Address book (Automations → Address Book tab + the recipient picker's
// typeahead); per-route gates on the ownership-dimensioned contacts key.
router.use("/contacts", contactsRouter);
// Network Discovery — saved active scans of operator-supplied IP ranges
// (Assets page → "+ Add Asset(s)" → Discovery). The whole mount carries a
// networkScan:read floor; adoption additionally chains assets:write, so
// "may scan" and "may create assets" stay separable (business rule 34a).
router.use("/network-scans", networkScansRouter);
// Outbound delivery channels (Automations → Delivery tab).
router.use("/delivery-channels", notificationChannelsRouter);
router.use("/notification-channels", deprecatedAlias("/api/v1/delivery-channels"), notificationChannelsRouter);
// Triggered automation instances ("alerts": list + acknowledge/clear).
// /notification-rules stays mounted before /notifications (shadowing).
router.use("/alerts", notificationsRouter);
router.use("/notifications", deprecatedAlias("/api/v1/alerts"), notificationsRouter);
router.use("/push-subscriptions", pushSubscriptionsRouter);
router.use("/search", searchRouter);
// Region routes are mounted BEFORE /map so Express's first-match routing picks
// the more-specific path. Region CRUD is gated by the mapRegions function key.
//
// /map carries a blanket deviceMap=read floor. This is the gate the surrounding
// comment used to only CLAIM: before 2026-08 the three read routes (/sites,
// /sites/:id/topology, /sites/:id/topology/search) had no requirePermission at
// all, so any authenticated session — and any bearer token bound to a role with
// deviceMap=none — could read every FortiGate's hostname, coordinates and full
// topology (switches, APs, wireless stations, LLDP neighbours). The nav entry
// was ungated too, so the only thing resembling access control was the UI.
// The layout writes inside mapRouter escalate to deviceMap=write on top of this.
//
// NOTE the deliberate asymmetry that follows from these two lines: region CRUD
// needs mapRegions, but `GET /map/region-overlay` — read-only region polygons +
// the derived containment tree, for the map's "Show regions" button — lives in
// mapRouter and is therefore reachable at deviceMap=read. That is intentional
// (the button is for anyone who can look at the map) and is documented at the
// route itself. Do not "tidy" it under /map/regions: that would re-gate it on
// mapRegions and break the button for exactly the viewers it exists for.
router.use("/map/regions", requirePermission("mapRegions", "read"), mapRegionsRouter);
router.use("/map", requirePermission("deviceMap", "read"), mapRouter);
// Application Map: process-connectivity graph + shared layout. Per-route
// gates on the applicationMap function key (read = graph, write = layout).
router.use("/application-map", applicationMapRouter);
// Status Map weather proxy — public weather data (RainViewer radar tiles +
// Open-Meteo temps) cached server-side; any authenticated caller. The widget
// falls back to the CDNs directly when these fail.
router.use("/weather", weatherRouter);
router.use("/conflicts", conflictsRouter);
router.use("/credentials", credentialsRouter);
router.use("/manufacturer-aliases", requirePermission("manufacturerAliases", "read"), manufacturerAliasesRouter);
// monitor-settings: reads open to any auth caller (asset-modal tier badges
// need them); writes guarded per-route by requirePermission(assetMonitorSettings, write).
router.use("/monitor-settings", monitorSettingsRouter);
router.use("/api-tokens", requirePermission("apiTokens", "read"), apiTokensRouter);
// MIBs surface mounted BEFORE /server-settings so its per-route guards
// (mibDatabase read on browse/walk, mibDatabase write on upload/delete)
// take precedence over the blanket serverSettingsSystem gate on the rest
// of /server-settings. Express first-match routing handles the rest — any
// path under /server-settings that doesn't start with /server-settings/mibs
// falls through to the serverSettingsRouter below.
router.use("/server-settings/mibs", mibsRouter);
// Same precedent — per-route guards (manufacturerProfiles read on browse,
// write on edits). Mounted before the blanket so reads reach roles that
// have manufacturerProfiles=read but not serverSettingsSystem.
router.use("/server-settings/manufacturer-profiles", manufacturerProfilesRouter);
// nginx GUI surface mounted BEFORE /server-settings so the proxy-mode gate
// and explicit per-route serverSettingsSystem guards (read on GET, fullwrite
// on PUT/apply/rotate/adopt) apply. Apply + rotate are high-blast-radius —
// they can lock out the operator from the UI if mis-set — so fullwrite is
// the right floor regardless of the blanket gate's read level.
router.use("/server-settings/proxy", proxySettingsRouter);
// The tag REGISTRY's picker-shaped read, declared above the blanket
// /server-settings gate so it escapes it. The tag picker is rendered by every
// form that can tag something — the asset edit form, blocks, subnets — and
// none of those roles hold serverSettingsSystem (every non-admin built-in is
// seeded "none"), so reading the catalogue through the registry's own
// GET /server-settings/tags 403'd for all of them and the picker rendered
// "No tags defined yet" at an install with a full registry. Auth-only, the
// /monitor-settings-reads precedent: this returns name / category / colour,
// which every asset, block and subnet row already shows its reader. The
// registry's own routes — including the auto-assignment device filter on each
// row — stay behind the gate below.
router.get("/server-settings/tags/catalog", async (_req, res, next) => {
  try {
    const { listTagCatalog } = await import("../services/tagAssignmentService.js");
    res.json(await listTagCatalog());
  } catch (err) { next(err); }
});
// Blanket /server-settings gate: serverSettingsSystem read floor for the
// whole surface. Mutating routes inside additionally carry per-route
// requirePermission escalations (serverSettingsSystem fullwrite for the
// system cards, serverSettingsData read/fullwrite for backup download /
// backup-restore / queue-mode / security tokens / restart / updates) —
// so a Data-scoped role still needs serverSettingsSystem read to reach
// its routes through this mount.
router.use("/server-settings", requirePermission("serverSettingsSystem", "read"), serverSettingsRouter);
// device-icons applies its own per-route guards (deviceIcons write on CRUD;
// auth-only for image-serve since the asset details modal embeds icon URLs).
router.use("/device-icons", deviceIconsRouter);
