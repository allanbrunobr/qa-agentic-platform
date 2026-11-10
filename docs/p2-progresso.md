# Correções P2 — progresso

Referência: [análise de 09/11/2026](analise-20261109.md), seção 6 (plano priorizado). Branch local
`p2-correcoes`, criada a partir de `98aecb3` (o fim de `analise-qa-agentic`, que fica parada).
Um commit local por item. Nada é enviado ao remoto: o push depende de decisão do Allan sobre o portão
`ci-ok.sh` (ver `docs/p1-progresso.md`).

Verificação de cada item: `npm run typecheck`, `npm test`, `npm run verify:release` e
`npm run test:e2e`, cada um com exit code próprio. Cada correção tem um teste que falhava antes dela.

Ordem: a do plano do relatório (S-15, B-01, B-05, B-03, B-04, S-03/S-06, S-04/S-05, S-07/S-08,
S-09/S-10/S-11, B-06/B-07/B-08, testes, arquitetura, dependências).

## S-15 · Token do control plane vaza por DNS rebinding — feito

**O que mudou**

- `control-plane-guard.ts`: `isLoopbackHost` aceita só `127.0.0.1`, `localhost` e `[::1]`, com ou
  sem porta.
- Dashboard web (`dashboard-web/src/server.ts`): responde `403 host_not_allowed` a qualquer `Host`
  que não seja loopback, antes de servir a página que embute o token.
- API (`dashboard-api/src/server.ts`): checa `Host` e `Origin` em todo método, antes do token. Antes,
  a `Origin` só era checada no `OPTIONS`.
- `SECURITY.md`: descreve as duas checagens.

**Teste:** `testControlPlaneRebinding` em `hardening.regression.test.ts`, com requisições HTTP
brutas (o `fetch` não deixa forjar `Host`) contra os dois servidores reais.

- **Antes da correção:** 4 checagens falharam. A página entregou o token a `Host: evil.example`, e a
  API atendeu `Host` estrangeiro e `Origin` estrangeiro em `GET`, mesmo com o token.
- **Depois:** todas passam, e o acesso legítimo (loopback com a origem do dashboard) continua `200`.

**Verificação:** `typecheck` 0; `npm test` 0 (0 FAIL no hardening; API 380, web 120); `verify:release`
0; `test:e2e` 0.
