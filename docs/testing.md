# Testing

The platform is tested in layers. Fast layers check one module. Slow layers install the runtime into a real repository and drive a real browser. Each layer catches a different kind of regression, so a change is not done until the layers it touches pass.

## Setup

```bash
nvm use                 # Node 22.13+ (see .nvmrc and package.json engines)
npm ci                  # platform workspaces: packages/*, adapters/*
npm run setup:runtime   # runtime template dependencies (templates/persona-qa-dashboard)
```

The runtime template is a separate npm project with its own lockfile, which is why it needs its own install.

## Layers

| Layer | Command | What it covers | Time |
| --- | --- | --- | --- |
| Type check | `npm run typecheck` | Platform packages, runtime API, runtime web app. | ~1 min |
| Platform unit | `npm run test:unit` | Ingestion boundary (including adversarial prompt-injection cases), domain discovery contracts, static frontend scanner, domain fixture matrix, domain specialist. | seconds |
| Runtime unit | `npm run test:runtime` | Runtime API Vitest suites (`packages/api/src/**/*.test.ts`: agent runtime, orchestrator, tool registry and risk policy, sensors, quality gates, L4/L5 services), Fastify route tests on `node:test` (`packages/api/src/routes/__tests__/`), and dashboard component tests (Vitest + jsdom). | ~1 min |
| All unit | `npm test` | `test:unit` followed by `test:runtime`. | ~1–2 min |
| Integration verifiers | `npm run verify:<name>` | Scripts in `scripts/verify-*.mjs` that install and discover into fixture repositories in a temp dir and run sessions with the deterministic runtime. | minutes |
| Release gate | `npm run verify:release` | The combined gate. See below. | several minutes |
| End to end | `npm run test:e2e` | The README quick start against `examples/storefront` with real Chromium. See below. | several minutes |

### Integration verifiers

| Script | Checks |
| --- | --- |
| `verify:generic-frontend` | Install, discovery, and a runtime smoke session on a generic frontend fixture. |
| `verify:generic-repository-types` | Install and discovery for non-frontend repository kinds (backend API, CLI, library, unknown), and that no frontend surfaces leak into their adapters. |
| `verify:generic-runtime-execution` | Deterministic, no-browser execution for non-frontend repositories. |
| `verify:domain-*`, `verify:static-frontend-scanner` | Discovery contracts and fixtures (also part of `test:unit`). |
| `verify:l5` | L5 services end to end: drafts, governance decisions, audits, materialization. |
| `verify:l5:soak` | Repeated L5 loop iterations, to check that the loop guards stop runaway loops. |

### Release gate

`scripts/verify-release.mjs` is the check that must pass before a release, and CI runs it on every push. It:

1. checks the Node version (22+) and the syntax of every verifier;
2. runs the domain and discovery verifiers;
3. runs the generic install, discovery, and runtime smokes;
4. runs a fixed list of runtime route tests (`node --test`) and Vitest suites, including adaptive history, failure diagnosis, governance policy, independent auditor, L5 services and soak, sensors, and scenario-draft promotion readiness;
5. runs the dashboard tests and a production build of the dashboard.

It prints `[verify-release] PASS release verification` on success. Ports for the smoke runs come from `API_PORT`, `WEB_PORT`, or `RELEASE_PORT_SEED`. Set `AGENTIC_RELEASE_NODE_BIN` to use a different Node binary.

### End to end

`scripts/verify-e2e-storefront.mjs` proves that the documented quick start works and that a passing verdict means something:

1. Copies `examples/storefront` to a temp dir. The copy in the repository is never touched.
2. Runs `install-local` and `discover-local` on the copy.
3. Serves the copy over HTTP and starts the generated launcher with the deterministic runtime and real Chromium. API keys are cleared, so no provider is called.
4. Runs `place_order` and expects status `complete` and verdict `contract_compliant`.
5. Serves a broken copy of the app on another port and runs `place_order` with `execution_context.targetBaseUrl` pointing at it, while the launcher's `PLAYWRIGHT_BASE_URL` still points at the healthy app. Expects `contract_violated`: a run must test the target it was started for, not the environment default.
6. Breaks the app (removes its success feedback) and expects the same scenario to fail with `contract_violated`.

Steps 5 and 6 are the important ones: without step 6, a runtime that reports success for everything would pass; without step 5, a runtime that tests the wrong target would pass. See [ADR 0003](decisions/0003-fail-closed-generic-capabilities.md).

Prerequisite: Chromium for Playwright (`cd templates/persona-qa-dashboard && npx playwright install chromium`). Options: `KEEP_E2E_DIR=1` keeps the temp dir for debugging; `E2E_LAUNCH_TIMEOUT_MS` (default 15 minutes, covers the first `npm install`) and `E2E_RUN_TIMEOUT_MS` (default 5 minutes) set the timeouts.

## Running a single test

```bash
# One runtime API Vitest file, or tests matching a name
cd templates/persona-qa-dashboard/packages/api
npx vitest run src/phase2/__tests__/scenario-quality-gates.test.ts
npx vitest run -t "scenario quality gates"

# One route test (node:test)
node --import tsx --test src/routes/__tests__/runs.test.ts

# One dashboard test
cd ../web && npx vitest run src/components/__tests__/L5GovernancePanel.test.tsx

# Platform boundary tests
npx tsx packages/dashboard-api/src/ingestion/boundary.test.ts   # from the repository root

# One verifier
npm run verify:generic-frontend
```

## Deterministic runtime

`AGENTIC_QA_FORCE_DETERMINISTIC_RUNTIME=1` replaces the model provider with the deterministic provider. It maps each scenario step to the tool its capability declares (open the route, fill the field, submit, verify feedback) and calls no model. The tools, Playwright, sensors, contract evaluation, and quality gates stay real.

Use it for:

- tests and CI, where results must be repeatable and no API key is available;
- separating a product bug from model behavior: if a scenario fails deterministically, the problem is in the app, the selectors, or the contract, not in the agent.

Non-frontend repositories always run deterministically, because there is no browser surface for an agent to explore.

## Reference scenarios

By default the runtime loads only the scenarios that discovery generated for the target repository. `PERSONA_QA_USE_REFERENCE_SCENARIOS=1` also enables the built-in reference scenarios and agent profiles of the fictional order-fulfilment domain (adapter `adapters/reference-store`):

- scenarios `first_order`, `first_order_multi_role`, `quarterly_reorder_multi_role`, `quarterly_reorder_closure_multi_role`;
- roles `sales_associate`, `fulfillment_agent`, `billing_clerk`, `store_manager`.

Tests that need multi-role scenarios with a known structure use them. Do not enable this flag for a real target repository.

## Continuous integration

`.github/workflows/ci.yml` runs three jobs:

| Job | Steps |
| --- | --- |
| `verify` | `npm ci`, `npm run setup:runtime`, `npm run typecheck`, `npm test`, `npm run verify:release` |
| `e2e` | installs Chromium with system dependencies, then `npm run test:e2e` |
| `secrets` | gitleaks secret scan |

Reproduce a CI failure locally with the same command. The jobs need no secrets.
