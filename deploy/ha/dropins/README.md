# HA systemd drop-ins

Installed by `deploy/ha/setup-rhel-ha.sh` to
`/etc/systemd/system/<unit>.d/10-ha.conf`, one per shipped Polaris unit.

They exist because the shipped units hardcode the stock PostgreSQL unit:

```
After=network.target postgresql-15.service polaris-migrate.service
Requires=postgresql-15.service polaris-migrate.service
```

Under Patroni that unit is masked — Patroni starts and stops PostgreSQL itself,
and a `Requires=` on it would either fail the start or, worse, race Patroni by
starting a second postgres against the same data directory. A drop-in is the
right place for the redirect because the updater overwrites the main unit files
on every update (`cp -f` from `deploy/`) and leaves `<unit>.d/*.conf` alone.

Each file does up to four things:

1. **Resets** `After=` and `Requires=` with an empty assignment, then sets them
   again pointing at `patroni.service`. The reset is why these are named `10-`:
   an empty assignment clears entries parsed *earlier*, so this must sort before
   `nginx-dependency.conf` and any operator drop-in.
2. Adds `ExecStartPre=` on `polaris-migrate` and `polaris-web` asking Patroni
   whether this node is the primary. Every app unit `Requires=` the migrate
   one-shot, so a failed guard there fails the whole group start — the app
   cannot come up on a replica no matter who typed `systemctl start`.
3. Sets `TimeoutStopSec=20` so a demoted node's app cannot sit in shutdown for
   systemd's default 90s while its write-buffer flush retries against a
   database that has just gone read-only.
4. Adds `EnvironmentFile=-/etc/polaris/local.env`, parsed after `.env`, for the
   rare genuinely host-specific override. `.env` itself is synced between the
   nodes and must stay identical.

Verify after installing:

```bash
systemctl show -p Requires -p After polaris-web.service | grep -c postgresql-15   # must be 0
systemctl start polaris-migrate.service                                            # must FAIL on a replica
```
