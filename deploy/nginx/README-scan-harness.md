# nginx scan harness

A throwaway reverse proxy that puts `deploy/nginx/polaris.conf`'s edge headers in
front of a local `npm run dev`, so a HawkScan run can actually see them.

**This is dev tooling, not an install artifact.** Operators run
`deploy/nginx/polaris.conf` via `deploy/migrate-to-nginx.sh`; nothing here ships.

## Why it exists

Of the four findings in the first HawkScan run against Polaris, only one lived in
the Node app:

| Finding | Lives in |
|---|---|
| CSP: Wildcard Directive (on 404s) | `src/app.ts` — Express's `finalhandler` overwrote helmet's CSP |
| Strict-Transport-Security Multiple Header Entries | `deploy/nginx/polaris.conf` — the edge and helmet both emitted it |
| Server leaks version information | `deploy/nginx/polaris.conf` — `server_tokens` |
| Cookie without HttpOnly (`polaris_csrf`) | by design — the double-submit CSRF cookie must be JS-readable |

A scan pointed straight at `http://127.0.0.1:3010` cannot see rows 2 and 3 at all,
and would report the nginx half clean. Hence the proxy.

## Prerequisites

1. `podman machine start` (see the `polaris-worktree-workflow` skill).
2. This worktree's Postgres up, and the app listening on `:3010`.
3. **`TRUST_PROXY=1` passed to the dev server**, i.e. `TRUST_PROXY=1 npm run dev`.
   Without it Express ignores `X-Forwarded-Proto`, `req.secure` stays false, and
   both `polaris_csrf` and `connect.sid` come back without their `Secure` flag —
   a whole class of finding that does not exist in any real proxied install.

   **Pass it on the command line; do NOT add it to `.env`.** `tests/setup.ts`
   loads `.env` with dotenv so the suite picks up `DATABASE_URL` the way
   `npm run dev` does, which means anything parked there also reaches every
   test. `TRUST_PROXY` in `.env` breaks
   `tests/integration/dashServer.test.ts` — the case asserting that a spoofed
   `X-Forwarded-For` loses to the socket IP *without* trust proxy — and it
   fails as a bare `socket hang up`, which reads like anything but a leftover
   env var.

## Run it

```bash
HARNESS=$(mktemp -d)

# 1. A self-signed cert for localhost. HawkScan accepts self-signed certs.
openssl req -x509 -newkey rsa:2048 -nodes -days 30 \
  -keyout "$HARNESS/key.pem" -out "$HARNESS/cert.pem" \
  -subj "/CN=localhost" -addext "subjectAltName=DNS:localhost,IP:127.0.0.1"

# 2. The upstream address is the app as seen FROM the podman machine, which is
#    not 127.0.0.1 and not host.containers.internal. On Windows/WSL that name
#    resolves to the gvproxy gateway (169.254.1.2), which refuses :3010 --
#    the app is on the Windows host, one hop further out. Use the WSL vEthernet
#    gateway instead, and confirm before starting nginx or you get a silent 502:
#      podman run --rm docker.io/library/busybox \
#        wget -q -O - http://172.19.112.1:3010/api/v1/health
#    (401 is the expected answer -- it proves reachability, not authorization.)
UPSTREAM=172.19.112.1:3010

# 3. Port 8443, not 443: rootless podman cannot publish a privileged port and
#    fails with "Listen failed for HOST TCP port 127.0.0.1/443: Permission denied".
podman run -d --name polaris-hawkscan-nginx \
  -p 127.0.0.1:8443:443 \
  -e POLARIS_SCAN_UPSTREAM="$UPSTREAM" \
  -e NGINX_ENVSUBST_FILTER=POLARIS_ \
  -v "$PWD/deploy/nginx/polaris-scan-harness.conf.template:/etc/nginx/templates/default.conf.template:ro,Z" \
  -v "$HARNESS/cert.pem:/etc/polaris-nginx/cert.pem:ro,Z" \
  -v "$HARNESS/key.pem:/etc/polaris-nginx/key.pem:ro,Z" \
  docker.io/library/nginx:stable
```

On Windows/Git Bash, prefix the `podman run` with `MSYS_NO_PATHCONV=1` and use
`$(pwd -W)` rather than `$PWD` — otherwise MSYS rewrites the *container-side*
path and podman fails with `invalid option type` naming a mangled
`C:\Program Files\Git\...` path instead of the one you asked for.

`NGINX_ENVSUBST_FILTER=POLARIS_` is not optional — without it the image's
entrypoint expands nginx's own `$host` / `$remote_addr` /
`$proxy_add_x_forwarded_for` to empty strings and every proxy header goes blank.

The image is `nginx:stable`, matching `docker-compose.yml`; the floor is 1.30
(`polaris-tech-lifecycle` → version-pin-inventory.md).

## Confirm the harness before scanning

```bash
# exactly 1 -- more than one HSTS header is itself one of the findings
curl -sk -i https://localhost:8443/ | grep -ic '^strict-transport-security'

# "nginx", with no version after it
curl -sk -i https://localhost:8443/ | grep -i '^server:'

# a 404 must carry the real CSP, not finalhandler's default-src 'none'
curl -sk -i https://localhost:8443/robots.txt | grep -io "frame-ancestors [^;]*"

# both cookies Secure; connect.sid also HttpOnly; polaris_csrf deliberately not
curl -sk -i https://localhost:8443/ | grep -i '^set-cookie'
```

Then scan with `APP_HOST=https://localhost:8443 hawk scan` (see `stackhawk.yml`).

## Tear down

```bash
podman rm -f polaris-hawkscan-nginx
rm -rf "$HARNESS"      # the cert and key are throwaway; never commit them
```
