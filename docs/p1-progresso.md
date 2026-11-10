# Correções P1 — progresso

Referência: [análise de 09/11/2026](analise-20261109.md). Ordem de gravidade: S-01, S-02, B-02.
Cada item tem um commit local próprio. Nada foi enviado ao remoto (sem push e sem PR).

Verificação de cada item: os comandos do job `verify` do CI (`npm run typecheck`, `npm test`,
`npm run verify:release`) mais `npm run test:e2e` com Chromium real, cada um com exit code próprio.

## S-01 · API do runtime gerado sem checagem de `Host` e `Origin` — feito

**O que mudou**

- `templates/persona-qa-dashboard/packages/api/src/security/local-request-guard.ts` (novo): hook
  `onRequest` que responde `403` antes de qualquer rota quando o `Host` não é loopback
  (`127.0.0.1`, `localhost`, `[::1]`, mais `AGENTIC_QA_ALLOWED_HOSTS`) ou quando há `Origin` fora
  das origens do dashboard. Vale para todos os métodos, para o preflight e para o upgrade de
  WebSocket. Requisição sem `Origin` (curl, scripts, e2e) passa se o `Host` for loopback.
- `src/app.ts` (novo): `buildApp()` saiu do `index.ts`, que sobe o servidor ao ser importado, para
  que o teste monte o mesmo app que o launcher sobe. Ordem dos hooks: plugin de WebSocket, guard,
  CORS, rotas.
- `SECURITY.md` e `README.md`: descrição real da proteção e das variáveis
  `AGENTIC_QA_WEB_ORIGIN` e `AGENTIC_QA_ALLOWED_HOSTS`.

**Decisão: sem token no runtime.** O relatório sugeria token, `Host` e `Origin`. O ataque
reproduzido (página no navegador, DNS rebinding e requisição cross-site) é fechado por `Host` e
`Origin`. Um token só acrescentaria proteção contra outro processo do mesmo usuário, que já lê os
arquivos do runtime, e exigiria levá-lo ao bundle da web. Se o Allan quiser o token mesmo assim,
fica como item separado.

**Testes:** `src/security/__tests__/local-request-guard.test.ts`, 34 casos no app real. Cobrem
`Host` estrangeiro em `GET`, `PATCH` de settings e `POST` de run; `Origin` estrangeiro em `POST`,
preflight e `Origin: null`; a origem do dashboard chegando à rota; cliente sem `Origin`; upgrade
de WebSocket recusado e aceito; o parser de `Host`.

- **Mutação:** com o registro do guard removido do `buildApp`, 13 testes falham. O teste
  distingue o código com e sem a correção.
- **Bug encontrado no caminho:** com o guard registrado antes do plugin de WebSocket, um upgrade
  recusado deixava o socket aberto no servidor. O plugin só destrói o socket se o próprio
  `onRequest` tiver rodado. O teste pegou isso (o `app.close()` travava), e a ordem foi corrigida.

**Verificação:** `typecheck` 0; `npm test` 0 (API: 30 arquivos, 345 testes; antes 29 e 311);
`verify:release` 0 (os mesmos 345); `test:e2e` 0 (app saudável `contract_compliant`, app quebrado
`contract_violated`).

**Fica para o Allan:** nada que exija conta ou credencial.

## S-02 · Discovery escreve e apaga fora do repositório via symlink — em andamento

## B-02 · `targetBaseUrl` ignorado pelas tools — pendente
