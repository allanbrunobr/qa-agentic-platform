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
  Any path that logs, commits, or sends that key elsewhere is in scope. The runtime runs the target's
  CLI with a minimal environment that never includes provider keys or test credentials, and redacts
  secrets by value (provider keys, GitHub and AWS tokens, JWTs, private keys, and the values of
  secret-named environment variables) in tool output and in the tool input recorded in session events.
- **Host code.** `install-local` and `discover-local` must only write inside `<repo>/.agentic-qa/`.
  A write outside that directory is a bug. A symlinked `.agentic-qa` is refused, and so is any
  symlinked folder or generated file inside it: `discover-local` fails with
  `local_confinement_refused` instead of writing or deleting through the link. Folders copied from
  the repository into the host-source snapshot are read without following symlinks.
  `.env.local` is rewritten on install and is not sourced by the launcher.
- **Control plane.** `dev:api` and `dev:web` listen on `127.0.0.1`. Both refuse any request
  whose `Host` is not a loopback name, so a DNS-rebinding page cannot load the dashboard (which
  embeds the token) under its own domain. The API also refuses a foreign `Origin` on every method.
  Requests other than `GET /health` require the token in `data/control-plane.token`.

- **Generated runtime API.** It listens on `127.0.0.1` and checks every request before any route
  runs, in this order:
  1. `Host` must be a loopback name, or the request gets `403` (DNS rebinding).
  2. An `Origin` other than the local dashboard gets `403` (cross-site requests).
  3. The local API token is required, or the request gets `401`. This applies to every method,
     including the CORS preflight and the WebSocket upgrade. The only exception is `GET`/`HEAD /health`.

  The token is 32 random bytes, created on first start in `.agentic-qa/data/runtime-api.token`
  (mode `0600`, under the runtime's gitignored `data/` folder). A symlinked token file is refused.
  The server compares it in constant time, reads it only from the `x-agentic-token` header or
  `Authorization: Bearer`, and never from the query string. The dashboard never sees the token: it
  calls the API through its own Vite dev server, which adds the token to proxied requests on the
  server side. To call the API yourself, send the header with the contents of that file.

  Known limit: the dashboard has no login. While it runs, any client that can reach the dashboard
  port on `127.0.0.1` (including another local user or a sandboxed process) gets the dashboard's
  access to the API, because the proxy adds the token for it. The token closes the API port, not
  the dashboard port. Do not run the dashboard on a machine shared with untrusted local users.

Running the generated dashboard on a public interface is not supported. Bind it to localhost.
Extra host names can be allowed with `AGENTIC_QA_ALLOWED_HOSTS`, and extra dashboard origins with
`AGENTIC_QA_WEB_ORIGIN` (both comma-separated).
