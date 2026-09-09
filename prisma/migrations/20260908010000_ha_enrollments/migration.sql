-- Active/standby HA (docs/HA.md) — one row per node joining the cluster.
--
-- The Server Settings → High Availability tab mints a single-use token per node
-- and hands the operator a thin bootstrap script carrying it. The node runs the
-- script, which registers here as `pending` and then polls until an operator
-- approves it, at which point it may download the real bundle once: the
-- rendered Patroni/etcd config, that member's etcd certificate and key, the
-- sync keypair, .env, and the nginx cert+key.
--
-- Redeeming the token is deliberately NOT enough to receive anything. A leaked
-- token produces a pending row naming the source address and the SSH host keys
-- the caller presented, which an operator can inspect and reject — rather than
-- silently handing over every secret the install holds.
--
-- Nothing is backfilled and no existing behaviour changes: an install that
-- never opens the HA tab keeps an empty table.
CREATE TABLE "ha_enrollments" (
    "id" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "nodeName" TEXT NOT NULL,
    "nodeAddr" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "tokenPrefix" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "requestId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'issued',
    "registeredFromIp" TEXT,
    "registeredNodeName" TEXT,
    "sshHostKeyFingerprints" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "registeredAt" TIMESTAMP(3),
    "approvedBy" TEXT,
    "approvedAt" TIMESTAMP(3),
    "rejectedBy" TEXT,
    "rejectedAt" TIMESTAMP(3),
    "deliveredAt" TIMESTAMP(3),
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ha_enrollments_pkey" PRIMARY KEY ("id")
);

-- The bootstrap script polls by requestId; it must be unique and it is the only
-- handle the script holds after the token is spent.
CREATE UNIQUE INDEX "ha_enrollments_requestId_key" ON "ha_enrollments"("requestId");

-- Token lookup is by prefix, then argon2id verify against the row's hash — the
-- ManagedAgent bearer pattern. Without the prefix index every unauthenticated
-- registration attempt would be a full scan.
CREATE INDEX "ha_enrollments_tokenPrefix_idx" ON "ha_enrollments"("tokenPrefix");

-- The tab lists pending rows on every poll.
CREATE INDEX "ha_enrollments_status_idx" ON "ha_enrollments"("status");
