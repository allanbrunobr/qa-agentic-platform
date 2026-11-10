# Architecture

The platform has two halves:

1. **This repository** (the platform). It contains the CLI that installs a runtime into a target repository, the discovery pipeline that reads that repository, and an optional control-plane dashboard.
2. **The generated runtime.** This is a copy of `templates/persona-qa-dashboard/` placed in `<repo>/.agentic-qa/`. It runs the multi-agent QA sessions, evaluates them against workflow contracts, and serves a local dashboard.

The split exists so that the knowledge needed to test an application (routes, roles, selectors, credentials, scenarios) lives next to that application, while the platform stays generic. See [ADR 0001](decisions/0001-host-local-runtime.md).

## Data flow

```text
 target repository (read-only)
          │
          │  npm run discover-local -- <repo>
          ▼
 ┌──────────────────────────── platform: packages/dashboard-api ────────────────────────────┐
 │ repository classifier ──▶ static frontend scanner ──▶ domain specialist ──▶ code graph    │
 │ (frontend | backend_api   (routes, inputs, buttons,    (domain, personas,     builder     │
 │  | cli | library           feedback text, with         scenarios, each                    │
 │  | monorepo | unknown)     evidence references)        tied to evidence)                  │
 │                                     │                                                    │
 │                                     ▼                                                    │
 │                         local discovery materializer                                     │
 └─────────────────────────────────────┬────────────────────────────────────────────────────┘
                                       │ writes *.generated.* files only
                                       ▼
 <repo>/.agentic-qa/adapter/   personas, scenarios, capabilities, routes, auth,
                               workflow-contracts/*.generated.yaml, config/*
                                       │
                                       │ loaded at run time
                                       ▼
 ┌──────────────────────────── generated runtime: .agentic-qa/packages/api ─────────────────┐
 │ POST /api/p2/runs ──▶ quality gate check ──▶ orchestrator ──▶ agent runtime per step      │
 │                       (restricted = 409)        │               │  model provider          │
 │                                                 │               │  (anthropic | openai |   │
 │                                                 │               │   deterministic)         │
 │                                                 │               ▼                          │
 │                                                 │          tool registry ──▶ Playwright ──▶│──▶ app under test
 │                                                 │          (policy, risk level)            │    (PLAYWRIGHT_BASE_URL)
 │                                                 ▼                                          │
 │                      sensors ──▶ contract evaluation ──▶ independent auditor               │
 │                                                 │                                          │
 │                                                 ▼                                          │
 │                      session store (SQLite): events, artifacts, findings, verdicts         │
 └─────────────────────────────────────────────────┬──────────────────────────────────────────┘
                                                   ▼
                                    React dashboard (.agentic-qa/packages/web)
```

## Platform components

All paths are relative to the repository root.

| Component | Location | Role |
| --- | --- | --- |
| CLI | `packages/dashboard-api/src/cli.ts`, `src/cli/*` | Commands `install-local`, `discover-local`, `discover`, `bootstrap`, `review`. Exposed as `npm run <command> -- <repo>`. |
| Installer | `src/services/local-package-installer.ts` | Copies the runtime template into `<repo>/.agentic-qa/`, writes the launcher, `.env.example`, optional `.env.local`, and install metadata. |
| Repository classifier | `src/services/repository-classifier.ts` | Decides the repository kind (`frontend`, `backend_api`, `cli`, `library`, `monorepo`, `unknown`). The kind selects the discovery path and, later, whether the runtime needs a browser. |
| Static frontend scanner | `src/services/static-frontend-scanner.ts` | Reads frontend source without running it and builds a surface map: routes, inputs, buttons, and visible text, each with a file reference. |
| Domain specialist | `src/services/domain-specialist-service.ts` | Scores the surface map against domain profiles and proposes a domain, personas, capabilities, and scenarios. Every candidate must cite evidence that exists in the surface map (`assertEvidenceRefsExist`), so a scenario cannot be invented from nothing. Below a confidence threshold it falls back to a generic profile. |
| Code graph builder | `src/services/code-graph-builder.ts` | Builds a graph of files, routes, and capabilities. The materializer uses it to add hints to capabilities, and the runtime exposes it to the dashboard. |
| Materializer | `src/services/local-discovery-materializer.ts` | Turns the discovery report and bootstrap draft into the files under `.agentic-qa/adapter/`. It deletes and rewrites only files whose names contain `.generated.`. See [Generated files](generated-files.md). |
| Ingestion boundary | `src/ingestion/boundary.ts` | Wraps and neutralizes repository content before it goes into an LLM prompt. See [Security boundaries](#security-boundaries). |
| Platform API and UI | `packages/dashboard-api/src/server.ts`, `packages/dashboard-web/` | Optional control plane (ports 3101 and 4177). It reviews discovery and bootstrap output and tracks adapter promotion (`generated → reviewed → certified`). |
| Shared contracts | `packages/host-sdk/` | Types and Zod schemas shared by discovery and adapters: repository kinds, discovery reports, domain discovery bundles, code graph, runtime hooks. |
| Shared runtime pieces | `packages/core/` | Scenario, session, and tool types, a file-based session store, contract evaluation, and scenario quality gates used by the platform-side execution runner. |
| Reference adapters | `adapters/` | `template` (a starting point for a hand-written adapter) and `reference-store` (a fictional order-fulfilment host, used for tests and as an example of a hand-mapped adapter). |

The default discovery path is static and deterministic: no model call is needed to install and discover. An LLM-assisted discovery module exists (`src/services/llm-discovery.ts`). It is not part of the default `discover-local` path, and it always sends repository content through the ingestion boundary.

## Generated runtime components

The runtime is the template in `templates/persona-qa-dashboard/`. Paths below are relative to `packages/api/src/` in that template (and in `.agentic-qa/` after install).

| Component | Location | Role |
| --- | --- | --- |
| Fastify API | `index.ts`, `routes/*`, `phase2/routes/*` | REST and WebSocket API for the dashboard. `POST /api/p2/runs` starts a session. |
| React dashboard | `../../web/` (Vite, React, TanStack Query) | Overview, agentic runs, session detail, maturity and governance panels, settings (provider selection). |
| Runtime bootstrap | `phase2/services/runtime-bootstrap.ts` | `createPhase2Runtime()` wires the session service, tool registry, sensor runner, provider, agent runtime, and orchestrator. |
| Orchestrator | `phase2/services/orchestrator.ts` | Runs the scenario step by step in contract order, assigns each step to the agent for its role, runs sensors, and calls the independent auditor at the end. |
| Agent runtime | `phase2/services/agent-runtime.ts` | The model-and-tools loop for one step. It builds layered instructions, enforces the agent's tool policy (allowed or denied tools and risk levels `read`, `write`, `destructive`), and closes the tool ledger when a step times out or is interrupted. |
| Instruction layer | `phase2/services/instruction-layer.ts` | Assembles the prompt from layers with explicit precedence. The global layer is the runtime's `AGENTIC.md`. |
| Tool registry | `phase2/services/tool-registry.ts`, `phase2/tools/*` | Registers tools with metadata (risk level, browser requirement). Generic capability tools come from `generated-adapter-tools.ts`. Evidence tools capture screenshots and refuse blank pages. |
| Providers | `phase2/providers/*` | `anthropic`, `openai`, and `deterministic`. The deterministic provider maps each step to its declared tool without calling a model. It is used for non-frontend repositories and when `AGENTIC_QA_FORCE_DETERMINISTIC_RUNTIME=1`. |
| Sensors | `phase2/sensors/*`, `phase2/services/sensor-runner.ts` | Per-step checks: artifacts produced, output shape, schema, timeout, tool policy, and trend against history. |
| Contract evaluation | `phase2/services/contract-evaluation.ts` | Compares the session with its workflow contract and produces a verdict (see below). |
| Scenario quality gates | `phase2/services/scenario-quality-gates.ts` | Turns recent verdicts into a gate status (see below). |
| Session store | `phase2/services/session-service.ts` | SQLite store for sessions, steps, events, artifacts, findings, and L4/L5 records. Default file `persona-qa.db` in the API working directory (`.agentic-qa/` when started by the launcher); override with `DATABASE_URL`. In the installed copy, the `better-sqlite3` import resolves to a small shim over Node's built-in `node:sqlite`, so no native build is needed. |

### Workflow contracts and verdicts

Each scenario has a workflow contract: an ordered list of steps, each with a role, a capability, and the artifacts it must produce. Discovery writes one YAML file per scenario. When a session reaches a final state (`complete` or `failed`), contract evaluation compares what happened with the contract:

| Verdict | Condition |
| --- | --- |
| `contract_violated` | A hard violation: a step never started, did not finish, or failed, or a required artifact is missing. |
| `contract_drift` | No hard violation, but steps ran out of order, unexpected steps ran, or a step used a different capability than declared. |
| `contract_compliant` | Neither of the above. |

While a session is still running, the verdict is `contract_evaluating`.

A step's status is its last attempt. A step that failed and then completed on retry counts as complete, keeps its place in the step order, and is listed in `retriedSteps` (informational, not a violation or drift). A step whose last attempt failed is a violation.

### Scenario quality gates

Gates look at the last 5 final sessions of a scenario:

| Status | Condition | Effect |
| --- | --- | --- |
| `restricted` | 3 or more violations, or 3 consecutive violations | New runs are rejected (`409 scenario_restricted_by_quality_gate`). |
| `review_required` | At least 1 violation, 3 or more drifts, or 2 consecutive failures | Runs are allowed. The dashboard flags the scenario for review. |
| `open` | Otherwise | Normal operation. |

See [ADR 0002](decisions/0002-deterministic-workflow-contracts.md) for why the verdict is computed deterministically instead of by a model.

## Maturity model (L1–L5)

The runtime is organized around a five-level agentic maturity model. Each level adds a feedback loop on top of the previous one.

| Level | Feedback loop | What it means here | Main code |
| --- | --- | --- | --- |
| L1 Assisted | Open loop | A model with tools executes actions. Tools are registered, policy-checked by risk level, and every call is recorded in a ledger that is closed on timeout or interruption. | `agent-runtime.ts`, `tool-registry.ts` |
| L2 Instructed | One-way | Workflow contracts and layered instructions prescribe behavior. The agent executes only the current step. | `instruction-layer.ts`, `workflow-contracts/`, `AGENTIC.md` |
| L3 Measured | Two-way | Sensors, contract evaluation, and quality gates measure each run. | `sensors/*`, `contract-evaluation.ts`, `scenario-quality-gates.ts` |
| L4 Adaptive | Closed loop | Decisions use run history: retries and recovery depend on past failure patterns, and failures are diagnosed by root cause. | `adaptive-decision-engine.ts`, `failure-pattern-service.ts`, `failure-diagnosis-service.ts` |
| L5 Self-Sustaining | Multi-loop | The system proposes its own improvements (new scenarios, prompt overlays, profile tuning, healing actions) under governance. | services listed below |

`maturity-service.ts` reports the live status of L4 (`ready`, `stable`, `attention`) and L5 (`controlled_beta`, `operational`, `attention`) from the session store, and the dashboard shows it in the maturity panel.

### L4 and L5 services

All in `templates/persona-qa-dashboard/packages/api/src/phase2/services/`.

| Service | Purpose |
| --- | --- |
| `adaptive-decision-engine.ts` | Chooses retry and recovery behavior from recent step history. |
| `failure-pattern-service.ts` | Aggregates recurring failures per scenario and step. |
| `failure-diagnosis-service.ts` | Classifies failures by root cause (`provider_auth`, `ui_selector`, `backend_unavailable`, `workflow_contract`, `tool_policy`, `artifact_missing`, and others). |
| `coverage-analysis-service.ts` | Finds coverage gaps: uncovered capabilities, untested role combinations, suggested edge cases. |
| `scenario-draft-mapping-review.ts`, `scenario-draft-promotion-readiness-service.ts` | Scenario drafts from coverage gaps, and the checks a draft must pass before approval or promotion. |
| `learning-playbook-service.ts`, `learning-control-service.ts` | Learning recommendations, and the proposal lifecycle (propose, approve, apply) for prompt overlays. |
| `profile-tuning-service.ts` | Recommendations for agent profile settings based on history. |
| `self-healing-service.ts` | Bounded automatic healing (for example a timeout increase of at most 50 %, at most 10 actions per hour, quarantine needs a human). Every action is logged and can be rolled back. |
| `governance-policy-service.ts` | Decides whether a learning, healing, or scenario-draft action may proceed. Applying a proposal requires human review, and only safe patch kinds are applied automatically. |
| `independent-auditor-service.ts` | Re-checks terminal sessions and governance decisions independently of the agent that ran them (`passed`, `warning`, `failed`). |
| `l5-loop-guard-service.ts` | Circuit breakers per loop (`learning`, `scenario_generation`, `self_healing`, `materialization`, `meta_orchestration`), for example at most 20 pending drafts. |
| `l5-materialization-service.ts`, `l5-knowledge-promotion-service.ts` | Write approved knowledge to disk (for example `adapter/scenarios/scenarios.promoted.json`) and verify it after promotion. |
| `l5-closed-loop-service.ts`, `l5-closed-loop-scheduler.ts` | Run one improvement iteration on demand, or on a timer when `PERSONA_QA_L5_CLOSED_LOOP_AUTOSTART=1`. |
| `meta-orchestrator.ts`, `l5-audit-bundle-service.ts` | Risk-based scheduling of which scenarios to run next, and an exportable audit bundle with a replay plan. |

The design rule for L5: loops produce **drafts and recommendations**. Nothing changes the contracts, prompts, or scenarios that runs use until governance approves it, and every change is recorded.

## Security boundaries

| Boundary | Rule | Where |
| --- | --- | --- |
| Host code | `install-local` and `discover-local` write only inside `<repo>/.agentic-qa/`. Discovery reads the repository and never modifies it. Re-running discovery replaces only `*.generated.*` files. | `local-package-installer.ts`, `local-discovery-materializer.ts` |
| Untrusted content | Repository files and paths are untrusted. Before they reach an LLM prompt they are wrapped in `BEGIN_EXTERNAL_UNTRUSTED_CONTENT` / `END_EXTERNAL_UNTRUSTED_CONTENT` markers with provenance (source kind, trust level, content hash), and common injection markers are neutralized. The boundary currently covers repository file contents, file lists, and the repo path. DOM evidence, tool output, and CLI output are typed as source kinds but are not yet routed through it. | `packages/dashboard-api/src/ingestion/boundary.ts`, [ADR 0004](decisions/0004-untrusted-repository-content.md) |
| Secrets | Provider keys come from the environment or `.env.local` files, which are git-ignored in this repository. The installer writes a resolved key to `<repo>/.agentic-qa/.env.local` and the launcher loads it. The file is written with mode `0600`, and the installer adds `.agentic-qa/.gitignore` so it is never committed (the target's own `.gitignore` is not edited). CI runs a secret scan (gitleaks). | `local-package-installer.ts`, `.github/workflows/ci.yml` |
| Tool use | Agents can only call tools allowed by their profile. Risk-level policy can deny or hold `write` and `destructive` tools. Generic capabilities fail closed. | `agent-runtime.ts`, [ADR 0003](decisions/0003-fail-closed-generic-capabilities.md) |
| Network exposure | The launcher binds both the runtime API and the dashboard to `127.0.0.1`, so neither is reachable from other machines. The API also defaults to `127.0.0.1` when started directly (override with `HOST`). | `scripts/start-local-dashboard.generated.sh` (generated) |
