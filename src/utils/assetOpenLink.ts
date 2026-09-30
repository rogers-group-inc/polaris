/**
 * src/utils/assetOpenLink.ts — the ONE device link Polaris hands out to a
 * reader who is not yet in the app: the "Open device" button in an alert
 * email, the `{asset.link}` template token, and the tray button on a web push.
 *
 * WHY A LANDING PATH RATHER THAN THE DEVICE PAGE ITSELF. Polaris has two
 * front ends for the same device: the desktop page
 * (`/assets.html#view=asset:<id>`) and the phone SPA (`/mobile.html#asset/<id>`).
 * Which one a reader should land on depends on the device they open the link
 * FROM, and an email cannot know that when it is composed — the same message
 * goes to everyone (business rule 25), and one recipient reads it on a laptop
 * in the morning and on their phone at 2 a.m. The phone redirect in app.ts
 * only ever fired on `/`, so an emailed desktop URL opened on a phone rendered
 * the full desktop page: pinch-zoom, a sidebar built for a mouse, and no route
 * into the app the operator had actually installed on that phone.
 *
 * So the link is a surface-neutral path — `/assets/<id>` — that the server
 * resolves per request, with the ONLY per-request fact that matters, the
 * user-agent, in hand. The same phone-class test the root redirect applies
 * decides here too, and the same `?desktop=1` escape hatch is honoured, so a
 * phone that asked for the desktop keeps getting it.
 *
 * Nothing here needs a session: it is a redirect between two pages that carry
 * their own login gates (the desktop page through `protectedPages`, the SPA
 * through its own in-app login, which keeps the hash across sign-in). Adding
 * a gate would only cost the phone reader the fragment — the login round trip
 * cannot carry one.
 */

/**
 * Phone-class user-agents. `Mobile` covers Chrome / Firefox on phones
 * (every Android phone browser carries the token, which is also why an
 * `Android.*Mobile` alternative was redundant and a polynomial-ReDoS hazard
 * on attacker-supplied UA strings); `iPhone` / `iPod` cover Safari on iPhone.
 * iPad is intentionally excluded — modern iPad Safari requests desktop
 * layouts by default, and the desktop UI works fine on a tablet-class screen.
 *
 * One regex, shared by the root redirect in app.ts and the asset landing
 * route, so "is this a phone" has exactly one answer in the codebase.
 */
export const PHONE_UA_REGEX = /(Mobile|iPhone|iPod)/i;

export function isPhoneUserAgent(userAgent: string | undefined | null): boolean {
  return PHONE_UA_REGEX.test(userAgent || "");
}

/**
 * Asset ids are UUIDs (`Asset.id @default(uuid())`). The landing route accepts
 * that shape and nothing else, so the only thing it can ever redirect to is a
 * device page keyed by a well-formed id — a stray path under `/assets/` falls
 * through to the static handler's 404 rather than becoming a redirect that
 * carries whatever was typed into the fragment.
 */
const ASSET_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isAssetOpenId(id: string | undefined | null): boolean {
  return !!id && ASSET_ID_RE.test(id);
}

/** The surface-neutral path for ONE asset — what emails and pushes embed. */
export function assetOpenPath(assetId: string): string {
  return `/assets/${encodeURIComponent(assetId)}`;
}

/** The desktop device page for ONE asset — where the landing route sends a desktop browser. */
export function desktopAssetPath(assetId: string): string {
  return `/assets.html#view=asset:${encodeURIComponent(assetId)}`;
}

/** The phone SPA's asset detail for ONE asset — where the landing route sends a phone. */
export function mobileAssetPath(assetId: string): string {
  return `/mobile.html#asset/${encodeURIComponent(assetId)}`;
}

/**
 * Where `/assets/<id>` should send THIS request. `desktop` is the raw
 * `?desktop` query value — `"1"` is the escape hatch the phone SPA's own
 * "Desktop view" link uses on the root, honoured here for the same reason.
 * Returns null for an id that is not an asset id, which the route turns into a
 * fall-through (404) rather than a redirect.
 */
export function resolveAssetOpenTarget(opts: {
  id: string | undefined | null;
  userAgent: string | undefined | null;
  desktop?: unknown;
}): string | null {
  if (!isAssetOpenId(opts.id)) return null;
  const id = opts.id as string;
  if (opts.desktop === "1") return desktopAssetPath(id);
  return isPhoneUserAgent(opts.userAgent) ? mobileAssetPath(id) : desktopAssetPath(id);
}
