# Business rule 179 — full narrative

> Written 2026-11-13 as its own file (one file per rule from 78 on). Rule numbers are a
> stable citation key — never renumber. 81 is a deliberate gap.

Each rule records the decision *and the incident or constraint that forced it*. The invariant is in `invariants-30-43.md`; rule numbers are a stable citation key — never renumber.

- [Rule 179](#rule-179) — A queue worker wakes on NOTIFY and drains; polling is the backstop

## Rule 179 — A queue worker wakes on NOTIFY and drains; polling is the backstop

**How it was found.** The 2026-11-13 efficiency audit (group 2, steady database load). In pg-boss mode a monitor process registers about 200 workers — 24 probe at a 1 s poll, 24 fast and 8 SD-WAN and 24 loss-sweep at 2 s, the rest at 5 s — and pg-boss runs every one of them as its own polling loop. On top of that the floating pool polled all ten monitor queues, one `fetch` each, every 500 ms whenever they were empty. That is roughly 80–90 empty fetch queries a second per monitor process at the defaults, on an idle fleet as on a busy one, and it multiplies by the number of monitor replicas.

**What pg-boss offers.** pg-boss 12 can wake workers with LISTEN/NOTIFY: a queue created with `notify: true` sends a `pg_notify` in the same statement that inserts a runnable job, and an instance started with `useListenNotify` holds one dedicated, self-healing LISTEN connection that wakes that queue's workers. While notify is active a worker's poll relaxes to `notifyPollingIntervalSeconds` (default 30 s) — the backstop for a lost notification; the listener also forces one fetch on every worker after it reconnects.

**The trap that shaped the design.** Read in pg-boss's `Worker.run` loop: after EVERY fetch, a successful one included, the worker waits the resolved interval before fetching again, unless it was notified during the job. With notify active that interval is the 30 s backstop. So a worker that just finished a job would sleep 30 s with a backlog behind it — a batch insert sends one notification, wakes the idle workers once, each takes one job, and the rest of the backlog waits half a minute. pg-boss's burst options do not fix it at `batchSize: 1`: `burstWhenReadyExceeds` keys on a queue-size cache refreshed every 60 s and must be at least 1, and `burstWhenBatchFull` is ignored at batch size 1. The handler is never told which worker runs it, so it cannot re-arm a worker started with `localConcurrency > 1`.

**The decision.** Register each worker on its own (`localConcurrency: 1`, `registerDrainingWorkers`), keep the id `work()` returns, and have the handler call `notifyWorker(id)` in a `finally` after any non-empty batch. The worker then fetches again at once while there is work and only sleeps after an empty fetch — a drain-until-empty loop, which is also what lets a stately queue's queued successor (runnable only once the job ahead of it completes, with no new insert to notify) be picked up straight away. `offWork(name)` still stops every worker on the queue: it matches on the name.

**Measured (2026-11-13, pg-boss 12.38.1, a local PostgreSQL 17).** Four workers on a notify queue with a 30 s backstop, idle for 3 s, then 60 jobs queued in one insert: registered one by one and re-armed after each job, all 60 ran in 0.5 s; registered as one `localConcurrency: 4` worker, 4 of 60 had run after 20 s — each worker took one job on the notification and then slept out the backstop.

**The floating loop.** It calls `fetch` itself, outside pg-boss's worker loop, so notifications never reach it. Its job is to take work the dedicated workers cannot, which only exists once a dedicated pool is full. So its idle wait grows from 500 ms to 10 s while every queue is empty, and `runDedicatedWorker` wakes it (`wakeFloatingLoop`) whenever it takes the last free slot of a pool. Stop and the stall recovery wake it too, so it exits at once.

**Which processes listen.** Only a process that consumes — monitor, discovery, or `all`. The producer's NOTIFY is sent by its insert whatever its own instance does (it follows the queue's `notify` flag), so a web process opening a LISTEN connection would hold a connection for nothing.

**Connections.** The listener is one connection per consuming process outside the pg-boss pool. `app.ts` adds it to the role's stamped capacity and the Capacity Advisor adds one per process to its `max_connections` floor. pg-boss already runs on the direct URL (`getDirectDatabaseUrl`, pgbouncer-compatibility.md), so LISTEN is safe there; an install whose "direct" URL is really a transaction pooler sets `POLARIS_PGBOSS_LISTEN_NOTIFY=false` and gets the old polling.

**Discovery and scan queues.** Notify-enabled too, with the same re-arm: a run an operator starts begins at once rather than on the next 5 s poll, and a queued run behind a finished one does not wait 30 s.

**Rejected.** (1) Keep polling and only lengthen the intervals — trades away probe latency on every install to save load. (2) `notify` with the base poll kept as the notify interval — no saving at all. (3) A hand-rolled LISTEN outside pg-boss — duplicates the reconnect and gap-recovery logic pg-boss already has.

**What to expect.** Idle monitor processes fetch about 7 times a second instead of 80–90 (each worker once per 30 s, the floating loop at its 10 s ceiling); probe and heavy jobs start the moment they are queued rather than up to 1–5 s later; a backlog drains back to back.
