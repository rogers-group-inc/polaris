# syntax=docker/dockerfile:1.7

# ─── Builder ──────────────────────────────────────────────────────────────────
FROM node:24-bookworm AS builder

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
FROM node:24-bookworm-slim AS runtime

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
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      postgresql-client \
      iputils-ping \
      fping \
      ca-certificates \
      tini \
 && rm -rf /var/lib/apt/lists/*

# Install Go 1.22+ for the Polaris Agent build feature (Server Settings →
# Maintenance → Polaris Agent → Build). bookworm-slim ships golang 1.21.x
# which is too old for agent/go.mod; bookworm-backports has 1.22+.
# Image size grows from ~50 MB to ~350 MB (one-time hit, not per-tag).
RUN echo "deb http://deb.debian.org/debian bookworm-backports main" \
      > /etc/apt/sources.list.d/backports.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends -t bookworm-backports \
      golang-go \
 && rm -rf /var/lib/apt/lists/*

# Java 17 (headless) + the jsign jar for the optional agent code-signing
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
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      default-jre-headless \
 && rm -rf /var/lib/apt/lists/*
ADD https://github.com/ebourg/jsign/releases/download/7.4/jsign-7.4.jar /opt/polaris/tools/jsign.jar
RUN echo "2abf2ade9ea322acc2d60c24794eadc465ff9380938fca4c932d09e0b25f1c28  /opt/polaris/tools/jsign.jar" | sha256sum -c - \
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
 && mkdir -p /app/state/data/backups /app/state/public/uploads /app/state/data/agents /app/state/.cache/go-build
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
