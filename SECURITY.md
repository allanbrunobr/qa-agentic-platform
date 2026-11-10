# Security policy

## Reporting a vulnerability

Please do not open a public issue for security problems. Use GitHub's
[private vulnerability reporting](https://github.com/allanbrunobr/qa-agentic-platform/security/advisories/new)
instead. Include the affected version or commit, steps to reproduce, and the impact you expect.

You should get a first answer within 7 days.

## Scope

This is an alpha, single-maintainer project. The areas that matter most:

- **Repository content reaching LLM prompts.** Files from the target repository are untrusted input.
  They pass through the ingestion boundary (`packages/dashboard-api/src/ingestion/boundary.ts`)
  before any prompt is built. Bypasses of this boundary are in scope.
- **Secrets.** The installer can write a provider key to `<repo>/.agentic-qa/.env.local`.
  Any path that logs, commits, or sends that key elsewhere is in scope.
- **Host code.** `install-local` and `discover-local` must only write inside `<repo>/.agentic-qa/`.
  A write outside that directory is a bug. A symlinked `.agentic-qa` is refused, and so is any
  symlinked folder or generated file inside it: `discover-local` fails with
  `local_confinement_refused` instead of writing or deleting through the link. Folders copied from
  the repository into the host-source snapshot are read without following symlinks.
  `.env.local` is rewritten on install and is not sourced by the launcher.
- **Control plane.** `dev:api` and `dev:web` listen on `127.0.0.1`. Requests other than
  `GET /health` require the token in `data/control-plane.token`.

- **Generated runtime API.** It listens on `127.0.0.1` and rejects, before any route runs, every
  request whose `Host` is not a loopback name (DNS rebinding) and every request that carries an
  `Origin` other than the local dashboard (cross-site requests, including WebSocket upgrades).
  Requests without `Origin` (curl, scripts) are accepted on a loopback `Host`. The runtime API has
  no token: a process running as the same user can already read the runtime's files.

Running the generated dashboard on a public interface is not supported. Bind it to localhost.
Extra host names can be allowed with `AGENTIC_QA_ALLOWED_HOSTS`, and extra dashboard origins with
`AGENTIC_QA_WEB_ORIGIN` (both comma-separated).
