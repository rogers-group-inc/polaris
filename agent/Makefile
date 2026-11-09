# Polaris Agent build matrix — produces 6 static binaries from one go build
# command per platform/arch. Output lands under dist/<VERSION>/; the parent
# Polaris release tarball reads from there and ships agents matching the
# server version.
#
# Run `make all` from agent/ to produce every platform. Run `make linux-amd64`
# to produce just one. CGO_ENABLED=0 keeps the binaries static so they don't
# depend on the host's glibc / musl version; the agent's footprint is small
# enough that we don't need the runtime libraries glibc would link.
#
# The binary is GENERIC across customer deployments — per-install identity
# lives in agent.conf, written server-side at install time. The same
# polaris-agent-linux-amd64 binary works against any Polaris server.

# Single source of truth for the agent's version: the agent/VERSION text
# file in this directory. The server-side in-app build path
# (agentBuildService.ts) reads the same file, so a `make all` from a shell
# and a click on the Build button in the UI produce binaries stamped with
# the same -ldflags='-X main.version=...' value. Anyone editing agent code
# must bump VERSION in the same commit per the polaris-agent skill's rebuild contract.
VERSION := $(shell cat $(dir $(lastword $(MAKEFILE_LIST)))VERSION | tr -d '[:space:]')
PKG     := github.com/polaris/agent/cmd/polaris-agent
OUTDIR  := dist/$(VERSION)

GOFLAGS := -trimpath
LDFLAGS := -s -w -X 'main.version=$(VERSION)'

# CGO_ENABLED=0 → static binaries. Important for cross-compilation and for
# the install path (we copy ONE file to the host; nothing else to link).
BUILDENV := CGO_ENABLED=0

all: linux-amd64 linux-arm64 darwin-amd64 darwin-arm64 windows-amd64 windows-arm64

linux-amd64:
	@mkdir -p $(OUTDIR)
	$(BUILDENV) GOOS=linux GOARCH=amd64 go build $(GOFLAGS) -ldflags="$(LDFLAGS)" -o $(OUTDIR)/polaris-agent-linux-amd64 $(PKG)

linux-arm64:
	@mkdir -p $(OUTDIR)
	$(BUILDENV) GOOS=linux GOARCH=arm64 go build $(GOFLAGS) -ldflags="$(LDFLAGS)" -o $(OUTDIR)/polaris-agent-linux-arm64 $(PKG)

darwin-amd64:
	@mkdir -p $(OUTDIR)
	$(BUILDENV) GOOS=darwin GOARCH=amd64 go build $(GOFLAGS) -ldflags="$(LDFLAGS)" -o $(OUTDIR)/polaris-agent-darwin-amd64 $(PKG)

darwin-arm64:
	@mkdir -p $(OUTDIR)
	$(BUILDENV) GOOS=darwin GOARCH=arm64 go build $(GOFLAGS) -ldflags="$(LDFLAGS)" -o $(OUTDIR)/polaris-agent-darwin-arm64 $(PKG)

windows-amd64:
	@mkdir -p $(OUTDIR)
	$(BUILDENV) GOOS=windows GOARCH=amd64 go build $(GOFLAGS) -ldflags="$(LDFLAGS)" -o $(OUTDIR)/polaris-agent-windows-amd64.exe $(PKG)

windows-arm64:
	@mkdir -p $(OUTDIR)
	$(BUILDENV) GOOS=windows GOARCH=arm64 go build $(GOFLAGS) -ldflags="$(LDFLAGS)" -o $(OUTDIR)/polaris-agent-windows-arm64.exe $(PKG)

clean:
	rm -rf dist/

# Quick local-arch build for dev iteration. Doesn't go into dist/.
dev:
	$(BUILDENV) go build $(GOFLAGS) -ldflags="$(LDFLAGS)" -o polaris-agent $(PKG)

# Regenerate the Windows VERSIONINFO resources (rsrc_windows_{amd64,arm64}.syso
# in cmd/polaris-agent/, linked automatically by any GOOS=windows go build —
# including the server-side agentBuildService path, which needs no extra
# tooling because the .syso files are COMMITTED). The embedded metadata
# (ProductName/CompanyName/FileVersion — Explorer → Properties → Details)
# makes the PE look legitimate to Defender heuristics and carries the agent
# version. MUST be re-run whenever VERSION bumps — the version is baked into
# the .syso at generation time (see polaris-agent → cross-cutting-polaris-agent.md).
winres:
	cd cmd/polaris-agent && go run github.com/tc-hib/go-winres@v0.3.3 make --in winres.json --arch amd64,arm64 --file-version $(VERSION) --product-version $(VERSION)

# Formatting, static checks and tests, exactly as the CI test job runs them
# (.github/workflows/docker-publish.yml). Run on Linux or in CI: on a Windows
# checkout with core.autocrlf=true every .go file is CRLF in the working tree
# and gofmt lists all of them. Never `gofmt -w` a whole package there.
fmt-check:
	@out="$$(gofmt -l .)"; if [ -n "$$out" ]; then echo "gofmt needed:"; echo "$$out"; exit 1; fi

vet:
	go vet ./...

test:
	go test ./...

.PHONY: all linux-amd64 linux-arm64 darwin-amd64 darwin-arm64 windows-amd64 windows-arm64 clean dev winres fmt-check vet test
