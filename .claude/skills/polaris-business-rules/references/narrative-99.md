# Business rule 99 — full narrative

> Written 2026-10-09 as its own file (one file per rule from 78 on). Rule numbers are a
> stable citation key — never renumber. 81 is a deliberate gap.

Each rule records the decision *and the incident or constraint that forced it*. The invariant is in `invariants-30-43.md`; rule numbers are a stable citation key — never renumber.

- [Rule 99](#rule-99) — Polaris never restarts its own container: in a container it asks the operator to

<a id="rule-99"></a>

## Rule 99 — Polaris never restarts its own container: in a container it asks the operator to

### What happened

On 2026-10-09 the operator's Unraid install (one Polaris container, PostgreSQL in its
own container) showed Capacity Advisor recommendations for the pool and worker
variables. They ticked them, clicked **Stage**, and then **Restart Polaris to apply**.
The container stopped and did not come back.

The first diagnosis blamed the staged values: pool sizes rounded up to 50, against a
PostgreSQL container started with `max_connections=150`. That was wrong. The cause
was the button. `POST /server-settings/restart` calls `updateService.ts →
restartService()`, which is written for the systemd layout: it spawns a transient
`systemd-run` unit to restart `polaris.target`. A container has no systemd, so the
path falls through to its fallback, a plain process exit, and leaves bringing the
process back to whatever supervises it. Under systemd that is `Restart=`. In a
container it is the container's restart policy, which Polaris cannot see. Unraid's
default is "no", and a plain `docker run` has the same default, so the container
exited and stayed stopped. The shipped `docker-compose.yml` sets
`restart: unless-stopped`, under which the same click works. That is why it had not
been seen before.

### The decision

The operator's instruction was to stop offering the restart and ask instead. So in a
container:

- the card has no restart button. After Stage it shows an instruction to restart
  the container from the host (`docker compose restart`, `docker restart <name>`, or
  Restart on the host's Docker page), and the footer and toast say "container";
- `POST /server-settings/restart` refuses with 409, so no other client (the API, a
  stale page, a script) can strand the container the same way;
- `GET /server-settings/capacity-advisor` carries `runtimeIsContainer`, so the card
  can choose without a second request.

Detecting the restart policy was rejected. It is not visible from inside the
container without the Docker socket, which Polaris does not mount and should not ask
for. Even a compose stack that sets `unless-stopped` needs every role restarted
together after `.env` changes, which a self-exit of the web container does not do.

### The same reasoning elsewhere

This is the container half of a line the updater already drew: in-app updates are
disabled in Docker because the image, not Polaris, is the unit of change (the
Application Updates card). On 2026-10-09 that card also gained a daily registry check
(`updateService.ts → checkImageForUpdates`). It tells the operator a newer image
exists and leaves the pull and recreate to them, for the same reason: what happens to
a container is decided on its host.
