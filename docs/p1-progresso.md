# Correções P1 — progresso

Referência: [análise de 09/11/2026](analise-20261109.md). Ordem de gravidade: S-01, S-02, B-02.
Cada item tem um commit local próprio. Nada foi enviado ao remoto (sem push e sem PR).

Verificação de cada item: os comandos do job `verify` do CI (`npm run typecheck`, `npm test`,
`npm run verify:release`) mais `npm run test:e2e` com Chromium real, cada um com exit code próprio.
O job `secrets` (gitleaks) do CI não foi rodado localmente.

**Situação:** os três P1 estão corrigidos, cada um num commit local. Cada correção tem teste que
falhava antes dela e uma checagem por mutação: com a correção desfeita, o teste volta a falhar.

| Item | Commit | Teste que falhava antes |
|---|---|---|
| S-01 | `f1503e0` | `local-request-guard.test.ts` (13 falhas sem o guard) |
| S-02 | `6ac046f` | `hardening.regression.test.ts`, `testDiscoveryConfinement` (7 de 11 falhavam) |
| B-02 | ver `git log` | `execution-target.test.ts` (4 de 5) e o passo novo do e2e |

**Para o Allan (exige decisão, conta ou acesso):**

- Push e PR das três correções e do relatório; nada foi enviado.
- Rodar o job de gitleaks do CI quando houver PR.
- Decidir se o runtime gerado também deve ter token, além de `Host` e `Origin` (ver S-01).
- Runtimes já instalados em outros repositórios não recebem estas correções sem reinstalar
  (`install-local`); não há mecanismo de upgrade (A-03 do relatório).
- Rotação de chaves não é necessária por estas mudanças: nenhuma chave real foi usada ou exposta.

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

## S-02 · Discovery escreve e apaga fora do repositório via symlink — feito

**O que mudou**

- `packages/dashboard-api/src/services/confined-local-fs.ts` (novo): todo IO de discovery sob
  `.agentic-qa/` passa por aqui. A raiz é resolvida com `realpath`. Cada segmento de diretório é
  checado com `lstat`, e um symlink ou um não-diretório é recusado. Arquivos são abertos com
  `O_NOFOLLOW` e um destino que já é symlink é recusado. A limpeza de `*.generated.*` só apaga
  arquivos regulares, de diretórios reais. A cópia do snapshot de `integration-test/…` não segue
  symlink nem na origem nem no destino.
- `local-discovery-materializer.ts`: usa o módulo acima. Os caminhos devolvidos mantêm a grafia do
  chamador; só o IO usa o caminho real (no macOS, `/tmp` vira `/private/tmp`).
- A recusa é `LocalConfinementError` (`statusCode` 409, `code` `local_confinement_refused`). A CLI
  `discover-local` imprime JSON sem stack e sai com 1; a rota `POST /api/discover-local` responde
  409 em vez de 500.
- `SECURITY.md` e `docs/generated-files.md` descrevem o comportamento.

**Testes:** `testDiscoveryConfinement` em `packages/dashboard-api/src/hardening.regression.test.ts`
(roda no `npm run test:unit`). Usa a CLI real sobre cópias de `examples/storefront`, com 11
checagens em 4 casos:

1. Cópia limpa: a descoberta chega ao materializer e grava o manifesto. Isso impede que os casos
   seguintes passem só porque a descoberta falhou.
2. `.agentic-qa/adapter/config` como symlink para uma pasta de fora.
3. O manifesto gerado como symlink para um arquivo de fora.
4. `integration-test/persona-tests/support` como symlink para uma pasta de fora com um "segredo".

- **Antes da correção:** 7 checagens falharam. O arquivo `victim.generated.keep` de fora foi
  apagado; 5 JSONs foram gravados fora; o arquivo-vítima foi sobrescrito; o segredo foi copiado
  para o snapshot.
- **Depois da correção:** 11/11.

**Limite conhecido, registrado no código:** um processo do mesmo usuário que troque um diretório
por symlink entre a checagem e a escrita. Fica fora do modelo de ameaça, porque esse processo já
pode escrever os arquivos por conta própria. O arquivo final é protegido por `O_NOFOLLOW`.

**Verificação:** `typecheck` 0; `npm test` 0 (as 11 checagens novas rodam no `test:unit`, com 0
FAIL no log; API 345 testes, web 116); `verify:release` 0; `test:e2e` 0 (app saudável
`contract_compliant`, app quebrado `contract_violated`).

**Fora do escopo deste item:** os scanners de leitura que seguem symlink (S-10) continuam como P2.

**Fica para o Allan:** nada que exija conta ou credencial.

## B-02 · `targetBaseUrl` ignorado pelas tools — feito

**O que mudou**

- `phase2/types/tool-types.ts`: `ToolContext.executionTarget` (`baseUrl`, `targetRepoPath`).
- `phase2/routes/runner.ts`: o run coloca `executionTarget` no contexto (a URL resolvida do
  `execution_context`, ou o `targetRepoPath` nas execuções sem browser). Ele é posto depois dos
  `seed_artifacts`, para que um artefato enviado pelo cliente não o substitua.
- `phase2/services/agent-runtime.ts`: repassa `executionTarget` ao `ToolContext` e o mantém fora
  da lista de artefatos que vai no prompt do modelo.
- `phase2/tools/generated-adapter-tools.ts`: as tools de frontend resolvem rotas contra a base do
  run e só usam `PLAYWRIGHT_BASE_URL` quando o run não tem alvo. As tools de repositório usam o
  `targetRepoPath` do run e só usam `AGENTIC_QA_TARGET_REPO` ou o metadata como padrão.
- `docs/testing.md`: o novo passo do e2e.

**Testes**

- `phase2/__tests__/execution-target.test.ts` (5 casos): navegação usa a base do run com
  `PLAYWRIGHT_BASE_URL` diferente; o mesmo vale quando outra tool abre a página em branco; o
  fallback para o ambiente continua; as tools de repositório usam o `targetRepoPath` do run; o
  agent runtime entrega `executionTarget` à tool e não o põe no prompt. **Antes da correção:** 4
  dos 5 falharam (o de fallback já passava).
- `npm run test:e2e`, passo novo: o launcher continua com `PLAYWRIGHT_BASE_URL` no app saudável e o
  run é disparado com `targetBaseUrl` apontando para uma cópia quebrada em outra porta. Espera
  `contract_violated`.
- **Mutação:** com as tools ignorando a base do run de novo, o e2e falhou exatamente nesse passo,
  com `status=complete verdict=contract_compliant`, que é o verde falso do achado. O teste
  unitário falhou em 2 casos. Correção restaurada.

**Verificação:** `typecheck` 0; `npm test` 0 (API: 31 arquivos, 350 testes; web 116; 0 FAIL no
hardening); `verify:release` 0 (os mesmos 350); `test:e2e` 0 (saudável `contract_compliant`, run
apontado para a cópia quebrada `contract_violated`, app quebrado `contract_violated`).

**Fora do escopo deste item:** `routeHint` absoluto e `targetBaseUrl` com esquema não-http
continuam aceitos (S-07, P2).

**Fica para o Allan:** nada que exija conta ou credencial.
