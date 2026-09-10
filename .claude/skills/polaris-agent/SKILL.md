---
name: polaris-agent
description: "The Polaris Agent (Go, agent/) end to end: enrollment and bearer tokens, leaf-cert pinning and dual-pin rotation, the WebSocket command channel, sample streams, remote install over SSH/WinRM, privilege tiers (unprivileged / ptrace), in-app build and internal-CA code signing, auto-deploy, upgrade, the agent.conf format, and the rebuild/VERSION lockstep contract. Load for any change under agent/, src/api/routes/agents*.ts or the agent* services, anything about ManagedAgent/AgentCommand, 'agent' install or heartbeat problems, or a new sample stream."
---

# Polaris Agent

A Go binary (`agent/`) installed on Windows/Linux hosts that pushes samples to Polaris and
polls a command queue. **Satellite posture**: it never self-acts, refuses unknown actions,
and the only queued action is `run_script` (sha256 verified before executing, run in the
`scriptexec` sandbox). Process/service start/stop/restart control was removed. Full root
was retired with it; Linux runs `unprivileged` or `ptrace` (that unit plus `CAP_SYS_PTRACE`
**and** `CAP_DAC_READ_SEARCH` — both required).

## Which file

| You need… | Read |
|---|---|
| the whole contract: enrollment, tokens, config polling, WS channel, sample streams, `agent.conf`, privilege tiers, the rebuild/VERSION rule, cert-pin rotation checklist — writers, readers, invariants, change checklist | [references/cross-cutting-polaris-agent.md](references/cross-cutting-polaris-agent.md) |
| the in-app build (Go toolchain, cross-compile matrix, manifest, prune), code signing, download routes | [references/cross-cutting-polaris-agent-build.md](references/cross-cutting-polaris-agent-build.md) |
| the server-side narrative: the `agent` polling method, inbound + operator-facing API surface, remote install over SSH (Phase 4a) and WinRM (4b), in-app build, Windows code signing, upgrade-already-installed, the SSH Deployment card, Linux install, SSH host-key verification | [references/agent-server-side.md](references/agent-server-side.md) |
| leaf-cert pinning and dual-pin rotation (stage → rotate → retire) | [references/cert-pinning-rotation.md](references/cert-pinning-rotation.md) |
| building and running the binary by hand, wire protocol, security notes | `agent/README.md` |
| the entities: `ManagedAgent`, `AgentCommand`, `AutomationScriptRun` | `polaris-domain-model` → `platform.md`, `alerting.md` |
| the agent services' touches (install, scripts, auto-deploy, build, channel, token, command, wake, service inventory) | `polaris-change-impact` → `services/agent-services.md` |

## Lockstep rules

- **Any edit to agent code bumps `agent/VERSION` in the same commit** (the rebuild contract; `src/utils/version.ts`, `agent/Makefile` and `jobs/autoBuildAgents.ts` all lean on it).
- **A new sample stream** = Zod variant in `SamplesBodySchema` (`src/api/routes/agents.ts`) → enqueue helper → Go collector under `agent/internal/collectors/` → `agent/VERSION` bump → stream documented in `polaris-monitoring-discovery`.
- **Deploying the agent is `assets=fullwrite`** (rule 43a): install / retry / reinstall / upgrade / uninstall + bulk install; enabling a class block's `agentDeploy.enabled` is the same grant chained onto `integrations=write`.
- **An upgrade resolves its own credential** (rule 49): explicit override → `ManagedAgent.installCredentialId` → the managed SSH deployment credential; transport follows the credential's `type`, not the row's `installTransport`; an adopted credential is persisted only after the upgrade succeeds. Install / reinstall / uninstall still require one on file.
- **Cert rotation is dual-pin**: stage the new pin on every agent (`POST /server-settings/agents/cert-pins/bulk-add`) → rotate the server cert → wait for heartbeats → retire the old pin. Never leave an agent with zero pins.
- **Unit text is written only at install/reinstall** — a privilege-tier fix needs a reinstall; the agent reports its actual `CapEff` on heartbeat so the UI shows the verified state.
- **`processes` is agent-default-ON**; `eventLog` stays opt-in everywhere (PII/volume) behind the global `agentEventLog` switch.
- Agent-bearer routes are rate-limited (1200 / 5 min per IP) and gated by `requireAgentBearer`; the WS upgrade is attached at the HTTP-server level in `src/app.ts`, not via the REST router.

Related: `polaris-monitoring-discovery` (the `agent` polling method inside the resolver),
`polaris-deploy` (the cert the pins are computed from lives at `POLARIS_PROXY_CERT_PATH`),
`polaris-business-rules` rules 21 (SSH host keys) and 43.
