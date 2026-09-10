# syntax=docker/dockerfile:1.7

# ─── Builder ──────────────────────────────────────────────────────────────────
FROM node:24-trixie AS builder

WORKDIR /app

RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 build-essential \
 && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json prisma.config.ts ./
COPY prisma ./prisma

# Stub DATABASE_URL so prisma.config.ts's env() resolver doesn't error during
# the postinstall `prisma generate`. No connection is made at build time.
ENV DATABASE_URL="postgresql://build:build@localhost:5432/build"

RUN npm ci --include=dev

COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts

RUN npm run build

RUN npm prune --omit=dev

# ─── Runtime ──────────────────────────────────────────────────────────────────
FROM node:24-trixie-slim AS runtime

# Commit count from the build host. Baked into the runtime image as the
# patch number for the sidebar version display, since the runtime has no
# .git directory for `git rev-list --count HEAD` to inspect. Defaults to
# "0" so a local `docker build` without --build-arg still produces a
# usable image (version will read as <minor>.0).
ARG POLARIS_BUILD_COMMIT_COUNT=0

ENV NODE_ENV=production \
    PORT=3000 \
    POLARIS_STATE_DIR=/app/state \
    POLARIS_BUILD_COMMIT_COUNT=${POLARIS_BUILD_COMMIT_COUNT}

# fping batches the ICMP packet-loss sweep: ONE process per 500 targets rather
# than one `ping` per host. Polaris works without it — it falls back to
# per-host bursts and stretches the sweep interval to whatever the host can
# finish — but a container is a controlled environment with no reason to make
# it take the slow path. ~100 KB.
#
# postgresql-client-17 by NAME, not the unversioned `postgresql-client`
# metapackage. src/utils/pgClientTools.ts resolves pg_dump/psql by the SERVER's
# major (rule 47), so a client that silently follows the base image's default
# is how an in-container backup starts refusing with "pg_dump is PostgreSQL 15
# but the server is PostgreSQL 17". The version is now stated here and checked
# by scripts/check-versions.mjs like every other PostgreSQL site.
#
# Debian 13 (trixie) ships 17, so this needs no PGDG apt repo in the image —
# which is exactly why the base moved to trixie alongside the server bump. A
# major that trixie does NOT carry would mean adding apt.postgresql.org here.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      postgresql-client-17 \
      iputils-ping \
      fping \
      ca-certificates \
      tini \
 && rm -rf /var/lib/apt/lists/*

# Install Go for the Polaris Agent build feature (Server Settings →
# Maintenance → Polaris Agent → Build). trixie ships golang 1.24, which is
# below agent/go.mod's floor; trixie-backports carries 1.26.
# The backports SUITE must track the base image — a bookworm-backports line on
# a trixie base resolves to nothing and the build fails at apt-get install.
# Image size grows from ~50 MB to ~350 MB (one-time hit, not per-tag).
RUN echo "deb http://deb.debian.org/debian trixie-backports main" \
      > /etc/apt/sources.list.d/backports.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends -t trixie-backports \
      golang-go \
 && rm -rf /var/lib/apt/lists/*

# Java 25 (headless) + the jsign jar for the optional agent code-signing
# feature (Integrations → Polaris Agents → Code signing — internal-CA
# signing of the two Windows agent binaries during the in-app build). The
# jar lands at /opt/polaris/tools/jsign.jar, one of agentSigningService's
# default probe locations. Adds ~250 MB (JRE) — signing stays opt-in at
# runtime; the tooling is pre-installed so it works the moment an operator
# configures it. SHA-256-pinned: signing tools must not be swappable by a
# compromised download host.
#
# The signing KEYSTORE is deliberately NOT part of the image: baking a
# fleet-trusted private key into a distributable layer would publish it to
# every registry the image reaches. Operators mount their PKCS#12 under the
# persistent state dir (/app/state/tools/codesign.pfx) and point the
# keystore path at it — see docs/INSTALL.md → "Optional: Code signing".
#
# openjdk-25-jre-headless by NAME. `default-jre-headless` is whatever the base
# image's Debian release calls default — 21 on trixie — so it carries no
# version for check:versions to compare and would drift under the image on the
# next base bump, exactly as it did on the Ubuntu scripts.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      openjdk-25-jre-headless \
 && rm -rf /var/lib/apt/lists/*
ADD https://github.com/ebourg/jsign/releases/download/7.5/jsign-7.5.jar /opt/polaris/tools/jsign.jar
RUN echo "602a51c3545a6dc4fb99bd2ea7152b26d1345916d0c93ddfbd5936cb735af91c  /opt/polaris/tools/jsign.jar" | sha256sum -c - \
 && chmod 0644 /opt/polaris/tools/jsign.jar

WORKDIR /app

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/prisma.config.ts ./prisma.config.ts
COPY public ./public
# Polaris Agent Go source — the in-app build feature (Server Settings →
# Maintenance → Polaris Agent → Build) shells out to `go build` against
# this directory. Without it, agentBuildService throws "agent/ source
# directory not found" before the first compiler invocation. Source-only;
# no compiled binaries are baked into the image — operators click Build
# on the running container to produce the per-platform agent binaries
# under /app/state/data/agents/<version>/.
COPY agent ./agent

COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh \
 && mkdir -p /app/state/data/backups /app/state/public/uploads /app/state/data/agents /app/state/.cache/go-build \
 && chown -R node:node /app/state
# The application runs as the image's unprivileged `node` user (uid 1000) —
# docker-entrypoint.sh reconciles the /app/state bind mount and then drops to
# it with setpriv. See the block at the top of that script for why the drop
# lives there and not in a `USER` line here.
#
# /app itself stays root-owned and is never written to at runtime: dist/,
# node_modules/ and agent/ are read-only to the process, and every mutable
# artefact (backups, uploads, built agent binaries, GOCACHE) lands under
# /app/state. That is deliberate — the app cannot rewrite its own code.
# /app/state/data/agents holds Polaris Agent binaries (per-version subdir
# + manifest.json). With Go now pre-installed in the image, operators
# can click Build agent binaries on Server Settings → Maintenance and
# the binaries land here automatically. The directory is still empty
# at boot — the install path surfaces a clear "no binaries available"
# error until the first Build click completes.
#
# /app/state/.cache/go-build is the GOCACHE the build subprocess uses
# (HOME=/app/state is set when the build runs). Pre-creating keeps the
# first build from racing on mkdir.

# 3000 = main app (web/all role); 3001 = Dash wallboard listener (dash/all role).
EXPOSE 3000 3001

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/docker-entrypoint.sh"]
