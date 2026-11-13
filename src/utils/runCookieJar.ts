/**
 * src/utils/runCookieJar.ts — the cookies ONE path-check run keeps across its
 * own redirect hops (business rule 85(b)).
 *
 * A load balancer's cookie check (a NetScaler, for one) answers a request with
 * no cookie with `302` + `Set-Cookie` back to the same URL. A browser returns
 * the cookie and gets the page; a client that drops cookies is redirected
 * forever and reads "more than 5 redirects" on a site that works. So a run
 * keeps what the target sets, the way a browser does within one visit — and
 * no further:
 *  - HOST-ONLY: a cookie goes back only to the exact host that set it. The
 *    Domain attribute is ignored, so a redirect to another host gets nothing.
 *  - Path, Secure, Max-Age and Expires are honoured (RFC 6265 §5.1.4, §5.3).
 *  - In memory for one run, then dropped: never stored, logged or carried to
 *    the next run, so every run is a first visit.
 * The agent does the same with Go's net/http/cookiejar behind a Domain-
 * stripping wrapper (agent/internal/collectors/path_check_http.go).
 */

interface StoredCookie {
  value: string;
  path: string;
  secure: boolean;
  expiresAt: number | null;
}

/** At most this many cookies per host, and this many characters per value. */
const MAX_COOKIES_PER_HOST = 50;
const MAX_VALUE_CHARS = 4096;

/** RFC 6265 §5.1.4 default-path: the request path up to (not including) its last "/". */
function defaultPath(u: URL): string {
  const p = u.pathname || "/";
  if (!p.startsWith("/")) return "/";
  const i = p.lastIndexOf("/");
  return i <= 0 ? "/" : p.slice(0, i);
}

/** RFC 6265 §5.1.4 path-match. */
function pathMatches(requestPath: string, cookiePath: string): boolean {
  if (requestPath === cookiePath) return true;
  if (!requestPath.startsWith(cookiePath)) return false;
  return cookiePath.endsWith("/") || requestPath.charAt(cookiePath.length) === "/";
}

const hostKey = (u: URL) => u.hostname.toLowerCase();

export class RunCookieJar {
  private readonly byHost = new Map<string, Map<string, StoredCookie>>();

  /** Keep the cookies one response set. `setCookie` is the raw header (Node gives an array). */
  store(u: URL, setCookie: string | string[] | undefined, now: number = Date.now()): void {
    if (!setCookie) return;
    const lines = Array.isArray(setCookie) ? setCookie : [setCookie];
    let jar = this.byHost.get(hostKey(u));
    for (const line of lines) {
      const [pair, ...attrs] = line.split(";");
      const eq = pair.indexOf("=");
      if (eq <= 0) continue;
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      if (!name || value.length > MAX_VALUE_CHARS) continue;
      let path = defaultPath(u);
      let secure = false;
      let maxAge: number | null = null;
      let expires: number | null = null;
      for (const a of attrs) {
        const ai = a.indexOf("=");
        const key = (ai < 0 ? a : a.slice(0, ai)).trim().toLowerCase();
        const val = ai < 0 ? "" : a.slice(ai + 1).trim();
        if (key === "path" && val.startsWith("/")) path = val;
        else if (key === "secure") secure = true;
        else if (key === "max-age" && /^-?\d+$/.test(val)) maxAge = Number(val);
        else if (key === "expires") {
          const t = Date.parse(val);
          if (!Number.isNaN(t)) expires = t;
        }
      }
      // Max-Age wins over Expires (§5.3 step 3).
      const expiresAt = maxAge !== null ? now + maxAge * 1000 : expires;
      const key = `${name}\u0000${path}`;
      if (expiresAt !== null && expiresAt <= now) {
        jar?.delete(key);
        continue;
      }
      if (!jar) { jar = new Map(); this.byHost.set(hostKey(u), jar); }
      if (!jar.has(key) && jar.size >= MAX_COOKIES_PER_HOST) continue;
      jar.set(key, { value, path, secure, expiresAt });
    }
  }

  /** The Cookie header for a request to `u`, or null when the jar has nothing for it. */
  header(u: URL, now: number = Date.now()): string | null {
    const jar = this.byHost.get(hostKey(u));
    if (!jar) return null;
    const reqPath = u.pathname || "/";
    const https = u.protocol === "https:";
    const out: Array<{ name: string; value: string; pathLen: number }> = [];
    for (const [key, c] of jar) {
      if (c.expiresAt !== null && c.expiresAt <= now) continue;
      if (c.secure && !https) continue;
      if (!pathMatches(reqPath, c.path)) continue;
      out.push({ name: key.slice(0, key.indexOf("\u0000")), value: c.value, pathLen: c.path.length });
    }
    if (!out.length) return null;
    // Longer paths first (§5.4 step 2); insertion order otherwise.
    out.sort((a, b) => b.pathLen - a.pathLen);
    return out.map((c) => `${c.name}=${c.value}`).join("; ");
  }
}
