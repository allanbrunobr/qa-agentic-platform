# Generated files

Everything the platform writes goes into one directory inside the target repository: `<repo>/.agentic-qa/`. Nothing outside it is created or modified. This page lists what each command writes and which files you should review or edit.

Rule of thumb:

- A file whose name contains **`.generated.`** belongs to discovery. `discover-local` deletes and rewrites these files on every run. Do not hand-edit them. It only touches real files and folders inside `.agentic-qa/`: if a folder or a generated file there is a symlink, discovery stops with `local_confinement_refused` and writes nothing through it. To change them, change the source repository and run discovery again, or copy the file to a name without `.generated.` (see [Customizing](#customizing)).
- Everything else is either runtime code (copied from the template) or runtime state (database, screenshots, settings).

## `install-local`

Source: `packages/dashboard-api/src/services/local-package-installer.ts`.

| Path in `.agentic-qa/` | What it is | Edit? |
| --- | --- | --- |
| `AGENTIC.md`, `README.md` | Runtime agent rules (loaded as the global prompt layer) and the runtime README. | Rarely. `AGENTIC.md` changes agent behavior for every run. |
| `package.json`, `package-lock.json`, `.npmrc` | Runtime package manifest. The installer sets `engines.node` to `>=22.5.0` and `legacy-peer-deps=true`. | No |
| `packages/api/` | Fastify API and phase 2 runtime source (`src/`, `package.json`, `tsconfig.json`, `drizzle.config.ts`). Installed exactly as in the template; a regression test compares the installed source with the template byte for byte. | No. Change the template in this repository instead. |
| `packages/web/` | React dashboard source. | No |
| `vendor/better-sqlite3-shim/` | Small `better-sqlite3`-compatible shim over Node's built-in `node:sqlite`, so the runtime needs no native build. | No |
| `scripts/start-local-dashboard.generated.sh` | Launcher. Installs dependencies on first run, installs Playwright Chromium for frontend repositories, loads `.env.local`, starts the API on `127.0.0.1` and the dashboard. Defaults: API port `3201`, web port `5176` (`--api-port`, `--web-port`). | No |
| `adapter/config/install-metadata.generated.json` | Install time, template version (`templateVersion`) and source, mode (`host-local-runtime`), ports, and the result of API key validation, and `lastUpgrade` after an `upgrade-local`. Contains no secret. `discover-local` keeps it. | No |
| `.env.example` | Empty `ANTHROPIC_API_KEY=` and `OPENAI_API_KEY=` entries. | Copy to `.env.local` if you want to set keys by hand. |
| `.env.local` | Provider keys, file mode `0600`. On reinstall the existing file is merged: your variables, comments and keys stay as they are, and a provider key is added only when it is missing; lines that are not assignments are dropped. The launcher loads only `ANTHROPIC_API_KEY` and `OPENAI_API_KEY` from it; other variables kept here are not exported to the runtime. A key with unsafe characters stops the install before anything is written. **Contains a secret.** | Yes, but never commit it. |
| `.gitignore` | Ignores `.env.local`, `node_modules/`, `data/`, SQLite files, `packages/web/dist/`, and `packages/api/artifacts/`, so the host repository can commit `.agentic-qa/` without secrets or local state. | Optional |
| `docs/README.md` | Short generated note about the installed runtime. | Optional |
| `adapter/<area>/`, `data/`, `packages/api/artifacts/` | Empty directories that discovery and the runtime fill. | — |

The installer never edits the target repository's own `.gitignore`. Instead it writes `.agentic-qa/.gitignore` (above), which keeps the secret, the database, dependencies, and run artifacts out of git. Ignoring the whole `.agentic-qa/` directory is also fine if you do not want to share reviewed scenarios.

## `discover-local`

Source: `packages/dashboard-api/src/services/local-discovery-materializer.ts`. All files are under `.agentic-qa/adapter/`.

| Path | What it is | Review? |
| --- | --- | --- |
| `config/discovery-report.generated.json` | Repository kind, detected stack, routes, evidence, and warnings. The launcher reads `repository.kind` from it. | Yes: confirm the repository kind is correct. |
| `config/bootstrap-draft.generated.json` | Draft adapter (personas, capabilities, scenarios) before it is split into the files below. | Optional |
| `config/code-graph.generated.json` | Graph of files, routes, and capabilities. | No |
| `config/domain-discovery-bundle.generated.json` | Frontend only. Inferred domain, confidence, and the evidence for every persona and scenario. | Yes: low confidence means generic scenarios. |
| `config/frontend-surface-map.generated.json` | Frontend only. Routes, inputs, buttons, and visible text found by the static scanner. | When a selector looks wrong |
| `manifest/adapter-manifest.generated.json` | Adapter identity and status (`draft`). | No |
| `personas/personas.generated.json` | Personas and their roles. | Yes |
| `scenarios/scenarios.generated.json` | Scenarios: steps, roles, capabilities, expected outcome. | **Yes: this is what the agents will do.** |
| `workflow-contracts/<scenarioId>.generated.yaml`, `workflow-contracts/index.generated.json` | One deterministic contract per scenario: ordered steps, each with role, capability, and required artifacts. Verdicts are computed against these. | **Yes** |
| `capabilities/capabilities.generated.json` | Capabilities (the actions a step can take) with selector and route hints. | Yes |
| `routes/routes.generated.json`, `auth/auth.generated.json` | Detected routes and authentication strategy. | Yes, if the app needs login |
| `runtime/runtime-plan.generated.json` | How the runtime should execute this repository: `runtimeMode` is `browser_model` (browser plus a model provider) or `deterministic_non_browser`, plus route and capability coverage. | No |
| `runtime/auth-runtime.generated.ts`, `runtime/capability-handlers.generated.ts`, `assertions/assertions.generated.ts` | Generated runtime hooks. | No |
| `runtime/reference-bridge.generated.json`, `runtime/host-source-snapshot/` | Links to existing test helpers in the host repository. The snapshot is copied only if the repository has such helpers. | No |

## Runtime state

Written while the runtime runs. All of it is local state; none of it should be committed.

| Path | What it is |
| --- | --- |
| `persona-qa.db` (plus `-wal`/`-shm`) | SQLite session store: sessions, steps, events, findings, verdicts, L4/L5 records. Created in the API working directory, which is `.agentic-qa/` when you use the launcher. Override with `DATABASE_URL`. Its schema is versioned (`schema_migrations`); `upgrade-local` applies pending migrations after copying it to `persona-qa.db.pre-upgrade-<timestamp>.bak`. |
| `packages/api/artifacts/screenshots/<sessionId>/` | Screenshots captured as evidence. |
| `data/runtime-settings.json` | Provider and model selected in the dashboard settings page. |
| `data/runtime-api.token` | Local API token, created on first start (mode `0600`). **Secret**: every API request except `GET /health` needs it, and `data/` is gitignored. Delete it to rotate; the next start creates a new one. |
| `adapter/scenarios/scenarios.promoted.json` | Scenarios promoted by the L5 loop after governance approval. Review it like any other scenario file. |

## Customizing

The runtime loads the generated files by default. To use hand-edited versions without discovery overwriting them, copy a file to a name without `.generated.` and point the runtime at it:

| Variable | File |
| --- | --- |
| `PERSONA_QA_SCENARIOS_FILE` | Scenarios |
| `PERSONA_QA_PERSONAS_FILE` | Personas |
| `PERSONA_QA_PROMOTED_SCENARIOS_FILE` | Promoted scenarios |
| `PERSONA_QA_DISCOVERY_REPORT_FILE` | Discovery report |
| `PERSONA_QA_DOMAIN_DISCOVERY_FILE` | Domain discovery bundle |
| `PERSONA_QA_CODE_GRAPH_FILE` | Code graph |

Discovery deletes only files whose names contain `.generated.`, so your copies survive a new discovery run. You must merge new discovery output into them yourself.
