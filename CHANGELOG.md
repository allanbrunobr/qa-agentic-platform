# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/). Until 1.0, minor versions can
contain breaking changes.

## [Unreleased]

Changes from the review in `docs/analise-20261109.md`. Item ids (S-, B-, T-, A-, M-) refer to it.

### Security

- The installed runtime API requires a local token on every request and refuses a foreign `Host` or
  `Origin` before any route runs, including the WebSocket upgrade (S-01). The control plane checks
  `Host` and `Origin` too (S-15).
- Discovery and install refuse symlinks inside `.agentic-qa` and read repository folders without
  following them, with size and count limits (S-02, S-10). The class-label check runs in linear time
  (S-09), and generated capability stubs embed names safely (S-11).
- Secrets stay out of the target CLI environment, tool output and session events (S-03, S-06).
- Tool output reaches the model fenced as untrusted data, including the artifacts earlier steps
  produced; a step whose capability has no tool fails instead of getting every tool (S-04, S-05).
- The QA browser stays on the run target (S-07). The finding screenshot route that S-08 confined was
  removed with the legacy run model (A-04).
- Untrusted repository content is wrapped in nonce-matched markers the content cannot forge (S-13).
- Generated API calls follow redirects only on the configured origin; generated browser tools take
  their risk level from the handler they get; `POST /api/personas` no longer overwrites an unreadable
  personas file (S-14).
- Dependencies: `zod` 4.6.7 and `drizzle-orm` 0.45.4, plus the in-range security updates; `npm run
  audit:deps` reports no high finding (S-12).

### Fixed

- A step that recovers on retry is no longer a contract violation, and a restricted scenario can be
  reset (`POST /api/p2/scenarios/:scenarioId/quality-gate/reset`) (B-01).
- Runs use the URL they were given as their target (B-02).
- Truncated, refused or incomplete model answers and steps with no successful tool call fail the
  step (B-03); agents can report findings with evidence (B-04); `AGENTIC.md` is found (B-05).
- A step that ends cancels its tool and model call (B-06).
- Sessions interrupted by a crash or shutdown are closed as failed; retries honour `maxRetries`
  (B-07, B-08).
- `addEvent` no longer reloads the whole session; invalid stored JSON no longer breaks reads (B-09).
- Contract step timeouts are honoured; a tool batch runs to the end; a refused install writes
  nothing; `discover-local` keeps the install metadata (B-10).
- The control-plane engine records the capability a step actually executed (B-11), and each retry
  opens the step again, so what a retry executed counts for its step, as in the runtime.
- Screenshots taken under the launcher (`.agentic-qa/artifacts/`) are gitignored. A finding about a
  page `captureScreenshot` refuses as blank can use a DOM snippet taken while it is blank
  (`collectDomSnippet` reports `pageBlank`, and `about:blank` before the first navigation does not count). When the
  response that completes a step captures evidence after the action, or has a `reportFinding`
  refused, the agent gets up to two more responses with only the evidence and finding tools, so it
  can report what the action showed; other steps cost no extra model call. A finding still refused
  when those run out is recorded as an error event and shown in the agent conversation. The block of
  artifact values in a step's first message says they come from earlier steps or the operator and
  are to be passed as tool inputs. The dashboard's observed step order lists a retried step once.

### Changed

- Runtime databases have versioned migrations that also adopt databases from older installs; the
  install metadata records `templateVersion` (A-03).
- The installer copies the runtime source exactly as the template has it (A-02).
- The release gate never reads, validates or copies a developer's provider key, and removes its
  temp fixtures (T-06, T-07).
- Tests: runtime tests are type-checked; coverage is measured (`npm run test:coverage`); the risk
  policy, hardening and boundary tests check behaviour instead of strings (T-01 to T-05).
- `docs/environment-variables.md` lists the variables the code reads; `npm run verify:env-docs`
  enforces it (M-01).

### Removed

- The legacy run model of the installed runtime (A-04): `POST /api/runs`, which ran
  `pnpm test:persona-qa` in the project directory, the routes `/api/runs`, `/api/scenarios` and
  `/api/findings` (with the finding screenshot route), the `/ws/runs/:runId` log stream, and their
  runner. The dashboard pages and components that read them were not reachable and are gone too.
  `/api/stats`, `/api/insights`, `/api/sync` and the legacy tables stay for now.

## [0.1.0] - 2026-10-22

First public release (alpha).

### Added

- CLI commands `install-local` and `discover-local`. They install a
  self-contained `.agentic-qa/` runtime (dashboard, API, and launcher) into a
  target repository, and write reviewable discovery output to
  `.agentic-qa/adapter/`.
- Discovery for frontend, backend API, CLI, library, monorepo, and unknown
  repositories. Frontends get personas, capabilities, routes, scenarios, and
  workflow contracts derived from a TypeScript AST code graph.
- Multi-agent runs that drive the target app in a real browser (Playwright),
  with Anthropic or OpenAI models, or with a deterministic runtime that needs no
  API key.
- Deterministic workflow contracts and contract evaluation
  (`contract_compliant`, `contract_drift`, `contract_violated`), quality gates,
  and evidence (events, artifacts, screenshots).
- Governed L4/L5 loops: failure diagnosis, adaptive retries, scenario drafts,
  profile tuning, and bounded self-healing that require approval.
- Runtime dashboard (agentic overview, runs, personas, insights, code graph) and
  an optional platform dashboard.
- Runnable example in `examples/storefront`.
- CI on GitHub Actions: typecheck, unit tests, and an end-to-end check that
  runs the example and expects a deliberately broken copy to fail.
- `npm run demo:capture`, which captures the dashboard screenshots used in
  the README.
- Documentation: architecture, generated files, testing, and ADRs.

### Fixed

- Generic frontend runs fail closed. A missing or disabled control fails the
  step, and the final assertion needs visible success feedback. Before this
  fix, such runs could be reported as passes.

### Security

- The runtime binds to localhost. `.env.local` is written with `0600`
  permissions and is git-ignored in the installed runtime.

[0.1.0]: https://github.com/allanbrunobr/qa-agentic-platform/releases/tag/v0.1.0
