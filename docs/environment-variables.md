# Environment variables

The environment variables the code reads, grouped by where they are read. `npm run verify:env-docs`
(part of `npm run test:unit`) fails when it finds a read of a variable that is not listed here. It finds
reads by pattern (see `scripts/verify-env-docs.mjs`); a name assembled at run time is not seen.

Variables of the installed runtime (`.agentic-qa`) are read from the process environment. The launcher
loads only `ANTHROPIC_API_KEY` and `OPENAI_API_KEY` from `.agentic-qa/.env.local`; any other variable
must be set in the environment the launcher (or `upgrade-local`) is started from.

## Provider keys and models

| Variable | Read by | Effect |
|---|---|---|
| `ANTHROPIC_API_KEY` | runtime, installer, LLM discovery | Anthropic key. The installer copies it into `.agentic-qa/.env.local`. |
| `ANTHROPIC_API` | runtime, installer | Legacy alias of `ANTHROPIC_API_KEY`. |
| `ANTHROPIC_API_KEY_OVERRIDE` | installer | When set (even empty), wins over every other key source at install time. Empty means "no key". A key already in the target's `.agentic-qa/.env.local` is kept on reinstall. |
| `OPENAI_API_KEY` | runtime, installer | OpenAI key. The installer copies it into `.agentic-qa/.env.local`. |
| `OPENAI_API_KEY_OVERRIDE` | installer | Same as `ANTHROPIC_API_KEY_OVERRIDE`, for the OpenAI key. |
| `OPENAI_BASE_URL` | runtime | Base URL of the OpenAI-compatible API. **The OpenAI key is sent there.** Default `https://api.openai.com/v1`. |
| `OPENAI_MODEL_DEFAULT`, `OPENAI_MODEL_FAST`, `OPENAI_MODEL_SMART` | runtime | OpenAI model per tier. |
| `MODEL_PROVIDER`, `LLM_PROVIDER` | runtime | Default provider (`anthropic` or `openai`) for the runtime settings. `MODEL_PROVIDER` wins; without either, `anthropic`. |
| `AGENTIC_PLATFORM_DISCOVERY_MODEL` | control plane | Model used by LLM discovery. |
| `AGENTIC_QA_SKIP_KEY_VALIDATION` | installer | `1` skips the network validation of the Anthropic key at install time. The release gate sets it. |

## Control plane (`npm run dev:api`, `npm run dev:web`)

| Variable | Effect |
|---|---|
| `AGENTIC_PLATFORM_API_PORT`, `AGENTIC_PLATFORM_WEB_PORT` | Ports of the control-plane API and dashboard. Both bind to `127.0.0.1`. |
| `AGENTIC_PLATFORM_DEFAULT_REPO` | Repository path prefilled in the dashboard. |
| `AGENTIC_PLATFORM_ROOT` | Platform root, when not inferred from the source location. |
| `AGENTIC_DATA_DIR` | Data directory of the control plane (executions, sessions, token). |
| `AGENTIC_CONTROL_PLANE_TOKEN_PATH` | File holding the control-plane token (mode 0600). |
| `AGENTIC_ADAPTERS_ROOT` | Adapters directory read by the control plane. |
| `AGENTIC_PLATFORM_ADAPTERS_ROOT` | Adapters directory written by the adapter materializer. A second name for the same place (M-03). |
| `AGENTIC_QA_TEMPLATE_ROOT` | Runtime template the installer copies, instead of `templates/persona-qa-dashboard`. |

## Installed runtime: server and security

| Variable | Effect |
|---|---|
| `HOST` | Bind address of the runtime API. Default `127.0.0.1`. **Another value exposes the API beyond this machine.** |
| `PORT` | Port of the runtime API. Default `3001`; the launcher passes its own. |
| `LOG_LEVEL` | Fastify log level. Default `info`. |
| `AGENTIC_QA_WEB_ORIGIN` | Comma-separated dashboard origins the API accepts (CORS and the Origin check). The launcher adds this launch's origins to the user's. |
| `AGENTIC_QA_ALLOWED_HOSTS` | Extra `Host` header values the API accepts besides loopback. |
| `AGENTIC_QA_API_TOKEN_PATH` | File holding the runtime API token. The Vite proxy reads it to add `x-agentic-token`. |
| `AGENTIC_QA_API_URL` | Runtime API the dashboard's Vite proxy forwards to. |
| `AGENTIC_QA_CLI_ENV_ALLOWLIST` | Comma-separated extra variable names passed to the target CLI; by default secrets are not passed. |
| `DATABASE_URL` | SQLite file of the runtime, relative to the API's working directory (`.agentic-qa` with the launcher, `.agentic-qa/packages/api` with `dev:api`). Default `./persona-qa.db`. Read from the environment only. `upgrade-local` reads it from its own environment. |

## Installed runtime: target, adapter and scenarios

| Variable | Effect |
|---|---|
| `PLAYWRIGHT_BASE_URL` | Default URL of the application under test, when a run gives no `execution_context`. |
| `GENERIC_API_BASE_URL`, `TARGET_API_BASE_URL`, `API_BASE_URL` | Base URL for generated API calls, in that order of precedence, when a run gives none. |
| `GENERIC_CLI_COMMAND`, `TARGET_CLI_COMMAND` | Command the generated CLI tools run. |
| `AGENTIC_QA_TARGET_REPO` | Repository of the target, for generated non-browser runtimes. |
| `AGENTIC_QA_REPOSITORY_KIND` | Repository kind (frontend, backend API, CLI, library), when not read from the install metadata. |
| `AGENTIC_QA_FORCE_DETERMINISTIC_RUNTIME` | `1` runs scenarios without a model provider (deterministic runtime). The release gate and e2e use it. |
| `AGENTIC_QA_FAKE_WORKFLOW_TOOLS` | `1` uses fake workflow tools (tests and demos). |
| `AGENTIC_QA_INSTRUCTIONS_PATH` | `AGENTIC.md` with the global agent instructions, when not at the default path. |
| `HEADLESS` | `false` opens a visible browser. |
| `TEST_USER`, `TEST_PASSWORD`, `RECEPTIONIST_USER` | Credentials for the application under test. The dashboard's **Settings** reports whether each is set (`/api/stats`); set them in the environment the launcher is started from. |
| `PERSONA_QA_PERSONAS_FILE` | Generated personas file. |
| `PERSONA_QA_SCENARIOS_FILE` | Generated scenarios file. |
| `PERSONA_QA_PROMOTED_SCENARIOS_FILE` | Scenarios promoted by the L5 loop. |
| `PERSONA_QA_CAPABILITIES_FILE` | Generated capabilities file. |
| `PERSONA_QA_CODE_GRAPH_FILE` | Code graph file. |
| `PERSONA_QA_DOMAIN_DISCOVERY_FILE` | Domain discovery bundle. |
| `PERSONA_QA_DISCOVERY_REPORT_FILE` | Discovery report. |
| `PERSONA_QA_INSTALL_METADATA_FILE` | Install metadata (`install-metadata.generated.json`). |
| `PERSONA_QA_USE_REFERENCE_SCENARIOS` | `1` uses the built-in reference scenarios instead of the generated ones. |
| `PERSONA_QA_STRICT_AVAILABLE_SCENARIOS` | `1` hides sessions of scenarios that are not available any more. |
| `PHASE2_ARTIFACT_DIR` | Directory for screenshots and other session artifacts. Default: `artifacts/` in the API working directory (`.agentic-qa/artifacts/` under the launcher, which the generated `.gitignore` covers). |

## Installed runtime: L5 closed loop

| Variable | Effect |
|---|---|
| `PERSONA_QA_L5_CLOSED_LOOP_AUTOSTART` | `1` starts the closed-loop scheduler with the API. |
| `PERSONA_QA_L5_CLOSED_LOOP_RUN_IMMEDIATELY` | `1` runs a cycle as soon as the scheduler starts. |
| `PERSONA_QA_L5_CLOSED_LOOP_INTERVAL_MS` | Interval between cycles. |
| `PERSONA_QA_L5_CLOSED_LOOP_MAX_SCENARIOS` | Scenarios per cycle. |
| `PERSONA_QA_L5_CLOSED_LOOP_APPLY_APPROVED` | `1` lets the loop apply changes that were approved. |
| `PERSONA_QA_L5_CLOSED_LOOP_MAX_APPROVED_APPLIES` | Approved changes applied per cycle. |
| `PERSONA_QA_L5_CLOSED_LOOP_GENERATE_DRAFTS` | `1` lets the loop generate scenario drafts. |
| `PERSONA_QA_L5_CLOSED_LOOP_ACTOR` | Name recorded as the actor of the loop's decisions. |

## Installed runtime: legacy data sync (A-04)

Read only by the legacy data sync (`POST /api/sync`, `GET /api/sync/summary` and the sync at API start),
which fills the tables behind `/api/stats` and `/api/insights`. The legacy run routes (`/api/runs`,
`/api/scenarios`, `/api/findings`) and their runner were removed.

| Variable | Effect |
|---|---|
| `PERSONA_QA_PROJECT_DIR` | Project directory the data sync resolves its default data directory from. |
| `PERSONA_QA_DATA_DIR` | Data directory the data sync reads. |

## Live scenario script (`npm run phase2:live`)

| Variable | Effect |
|---|---|
| `PHASE2_CUSTOMER_NAME`, `PHASE2_CUSTOMER_PHONE`, `PHASE2_ORDER_TYPE` | Seed data for the live reference scenario. |

## Release gate and tests

| Variable | Effect |
|---|---|
| `AGENTIC_RELEASE_NODE_BIN` | Node binary directory the verifiers use. |
| `RELEASE_PORT_SEED` | Seed for the ports `verify:release` picks. |
| `KEEP_VERIFY_FIXTURES` | `1` keeps the verifiers' temp fixtures and prints where they are. |
| `KEEP_E2E_DIR` | `1` keeps the e2e working copy. |
| `E2E_LAUNCH_TIMEOUT_MS`, `E2E_RUN_TIMEOUT_MS` | Timeouts of the e2e launch and run. |
| `AGENTIC_DOMAIN_FIXTURE_ROOT`, `FIXTURE_ROOT` | Passed by a verifier to its child process: where the fixtures are. |
| `EXPECTED_ARTIFACTS`, `SCENARIO_ID` | Passed by `verify-generic-runtime-execution` to its child process. |

Process-level names (`PATH`, `NODE_ENV`, `VITEST`, `NODE_NO_WARNINGS`, `HOME`, `TMPDIR`) are not listed.
The generated launcher script (`start-local-dashboard.generated.sh`) has its own options (`--api-port`,
`--web-port`) and is not covered by the check.
