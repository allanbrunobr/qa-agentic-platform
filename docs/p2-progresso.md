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

## B-01 (a) · Retry que se recupera contava como `contract_violated` — feito

**O que mudou** (nos dois avaliadores, o do template em `phase2/services/contract-evaluation.ts` e o
do `packages/core`):

- O status de cada passo passa a vir do **último** desfecho (`step_completed` ou `step_failed`).
  Antes, qualquer `step_failed` já registrado tinha precedência.
- A ordem observada conta cada passo uma vez, pelo primeiro `step_started`; um retry deixa de
  empurrar os passos seguintes para "fora de ordem".
- Os passos que falharam e depois completaram aparecem em `retriedSteps`, como informação, sem
  contar como violação nem como drift.
- `docs/architecture.md` explica a regra.

**Testes**

- Template, `phase2/__tests__/contract-evaluation-retries.test.ts`: 6 casos. Retry recuperado sai
  `contract_compliant`; retry que continua falhando sai `contract_violated`; 3 runs com retry
  recuperado deixam o gate `open`, e 3 runs que continuam falhando ainda deixam `restricted`.
- Core, `packages/core/src/runtime/contract-evaluation.test.ts` (novo, no `test:unit`): 8
  checagens. É o primeiro teste do `packages/core`.
- **Mutação** (semântica antiga): 3 dos 6 testes do template e 4 das 8 checagens do core falham.

**Verificação:** `typecheck` 0; `npm test` 0 (o teste do core roda no `test:unit`; API 386, web 120);
`verify:release` 0; `test:e2e` 0.

## B-01 (b) · O estado `restricted` não tinha saída — feito

**O que mudou**

- Rota `POST /api/p2/scenarios/:scenarioId/quality-gate/reset`, com `reason` obrigatório (10 a 500
  caracteres) e cenário existente. Como toda rota do runtime, exige o token.
- O reset fica gravado em `p2_quality_gate_resets`, com o motivo e o status que ele limpou, e nunca
  é apagado. O gate passa a ignorar as sessões iniciadas antes do último reset; novas violações
  voltam a restringir.
- `buildScenarioQualityGateForScenario` é o único caminho para o gate. Runner (lista e início de
  run), L5 e o mapa agregado passaram a usá-lo, então todos consideram o reset.
- A mensagem do 409 diz como sair. `docs/architecture.md` explica o procedimento.
- Não há botão no dashboard; o reset é feito pela API.

**Testes:** `phase2/__tests__/quality-gate-reset.test.ts`, com 6 casos:

- 3 violações restringem e o run recebe 409;
- o reset reabre o gate e fica gravado;
- novas violações restringem de novo;
- reset sem motivo, com motivo curto ou com mais de 500 caracteres dá 400 e não grava nada;
- cenário desconhecido dá 404;
- unidade do filtro por data de reset.

Antes desta correção a rota não existia. Na mutação (helper ignorando o reset), o teste de reabertura
falha.

**Verificação:** `typecheck` 0; `npm test` 0 (API 392, web 120); `verify:release` 0; `test:e2e` 0.

## B-05 · As instruções globais do `AGENTIC.md` nunca eram carregadas — feito

**O que mudou** (`phase2/services/instruction-layer.ts`):

- O caminho sobe 5 níveis a partir de `phase2/services` até a raiz do runtime (o template, ou
  `.agentic-qa` depois de instalado), onde fica o `AGENTIC.md`. Antes subia 3 e caía em
  `packages/api/AGENTIC.md`, que não existe.
- Um arquivo ausente agora lança erro em vez de devolver `undefined` em silêncio: um run não começa
  sem as regras que deveria seguir.
- `AGENTIC_QA_INSTRUCTIONS_PATH` permite outro arquivo.

**Testes** (em `instruction-layer.test.ts`, 3 casos novos): a função real carrega o arquivo; o
agent runtime envia o conteúdo ao provider como mensagem de sistema; um caminho configurado
inexistente lança erro. Os testes antigos montavam a camada à mão e não pegavam o defeito. Na
mutação (caminho antigo), os 2 primeiros falham.

**Verificação:** `typecheck` 0; `npm test` 0 (API 395, web 120); `verify:release` 0; `test:e2e` 0,
com o runtime instalado lendo o `AGENTIC.md` copiado para `.agentic-qa`.

**Efeito esperado:** a partir daqui, as regras "execute só o passo atual" e "não declare sucesso
cedo" chegam ao modelo, e o S-04 (saída de tool como dado, não instrução) pode se apoiar nelas.

## B-03 · Verde falso quando o modelo para sem agir — feito

**O que mudou**

- `agent-runtime.ts`, ao fim do turno do modelo:
  - parada truncada (`max_tokens`), recusa (`refusal`) ou motivo desconhecido (`incomplete`,
    `timeout`) reprovam o passo;
  - um passo de cenário só é aprovado com pelo menos uma tool call bem-sucedida. Passos fora de
    cenário (perfil avulso) seguem como antes.
- Providers: a Anthropic mapeava qualquer `stop_reason` desconhecido para `end_turn`. Agora
  `refusal` vira `refusal`, e `pause_turn` ou valores novos viram `incomplete`. Na OpenAI,
  `content_filter` vira `refusal`, e `finish_reason` desconhecido vira `incomplete`.
- O enum `stopReason` ganhou `refusal` e `incomplete`.

**Teste:** `phase2/__tests__/step-completion-guard.test.ts`, com 7 casos:

- passo sem tool call reprova;
- passo cuja única tool falhou reprova;
- `max_tokens` reprova;
- recusa reprova;
- passo com tool bem-sucedida completa;
- os dois mapeamentos de provider.

Antes da correção, 6 dos 7 falharam. Na mutação (regras novas desligadas), os 4 casos do agent
runtime falham. O resto da suíte da API seguiu verde, então nenhum teste existente dependia do
comportamento antigo.

**Verificação:** `typecheck` 0; `npm test` 0 (API 402, web 120); `verify:release` 0; `test:e2e` 0. O
e2e confirma que o caminho determinístico continua aprovando o app saudável (ele sempre chama a tool
do passo) e reprovando o quebrado.

## B-04 · O agente não tinha como registrar um finding — feito

**O que mudou**

- `phase2/tools/finding-tools.ts` (novo): tool `reportFinding`. Recebe `severity`, `title`,
  `description`, `evidenceArtifactIds` e, opcionalmente, `expected`/`actual`, e valida a entrada
  com zod. Ela é registrada no `runtime-bootstrap`.
- `agent-runtime.ts` trata o resultado dela:
  - aplica a política de evidência do perfil: com `requireScreenshotForFinding`, o finding precisa
    citar um `artifactId` de screenshot capturado **neste passo**; senão o modelo recebe
    `finding_without_evidence`, com instrução de como anexar, e nada é gravado;
  - persiste o finding com `storeFinding` (que antes não tinha nenhum chamador) e o acrescenta aos
    `findings` do passo.
- O escopo de um passo de cenário passa a oferecer, além da capability, `captureScreenshot` e
  `reportFinding`. Essas tools de apoio não contam como "executar o passo" para a regra do B-03.

**Teste:** `phase2/__tests__/report-finding.test.ts`, com 8 casos:

- finding com screenshot do passo é gravado e devolvido;
- sem evidência, com política que exige, é recusado;
- id de evidência não capturado no passo é recusado;
- sem exigência de evidência, é gravado;
- entrada inválida dá `invalid_finding`;
- reportar só um finding não executa o passo;
- as tools de apoio são oferecidas no escopo;
- a tool é registrada pelo bootstrap.

Antes, a tool não existia. Na mutação (tratamento desligado), 3 testes falham.

**Verificação:** `typecheck` 0; `npm test` 0 (API 410, web 120); `verify:release` 0; `test:e2e` 0.

## S-03 e S-06 · Segredos na CLI do alvo e redaction só por nome — feito

**O que mudou**

- **S-03** (`generated-adapter-tools.ts`):
  - O processo da CLI do alvo recebe um ambiente mínimo (`PATH`, `HOME`, locale, diretórios
    temporários, mais o que estiver em `AGENTIC_QA_CLI_ENV_ALLOWLIST`). Antes recebia o
    `process.env` inteiro, com as chaves de provider e as credenciais de teste.
  - Os argumentos escolhidos pelo modelo só passam se forem flags de ajuda ou versão ou nomes simples
    de subcomando, no máximo 4. `-e`, `--eval`, caminhos e sintaxe de shell recebem
    `cli_args_not_allowed`.
- **S-06** (`tool-registry.ts`):
  - A redaction reconhece segredos pelo valor: `sk-ant-…`, `sk-…`, tokens do GitHub, chaves AWS,
    JWT, chaves privadas, e os valores literais de variáveis de ambiente com nome de segredo
    (`KEY`, `TOKEN`, `SECRET`, `PASSWORD`…).
  - Agora vale também para a mensagem de erro das tools.
  - O input da `tool_call` gravado nos eventos da sessão e enviado aos hooks passa por
    `redactSecrets`; antes era gravado cru.
- `README.md` e `SECURITY.md` descrevem o comportamento.

**Fora do escopo:** o `riskLevel` de `runCliHelp` continua `read`. Hoje nenhum perfil define
`riskPolicy`, então mudar a classificação não altera o comportamento; isso entra com o S-05.

**Teste:** `phase2/__tests__/secrets-handling.test.ts`, com 13 casos:

- a CLI falsa do alvo informa que não recebeu `ANTHROPIC_API_KEY` nem `TEST_PASSWORD`;
- argumentos de ajuda e versão passam, e 5 formas perigosas são recusadas;
- redaction por valor dos 7 formatos;
- texto comum fica intacto;
- segredo no output de uma tool é redigido;
- segredo no input da `tool_call` não aparece nos eventos.

Antes da correção, 10 dos 13 falharam. Na mutação das três partes, 9 falham.

**Verificação:** `typecheck` 0; `npm test` 0 (API 423, web 120); `verify:release` 0, incluindo o smoke
determinístico de repositórios CLI, que roda `runCliHelp` com o ambiente mínimo; `test:e2e` 0.

## S-04 e S-05 · Saída de tool como instrução e escopo de tools que falha aberto — feito

**O que mudou**

- **S-05:**
  - Um passo de cenário cuja capability não tem tool registrada falha antes de chamar o modelo,
    com `capability_not_materialized`. Antes, o modelo recebia todas as tools registradas.
  - Capabilities compostas (`validateManagementClosure`) liberam as tools que as compõem. O mapa
    agora é um módulo único (`composite-capabilities.ts`), usado também pela avaliação de contrato.
  - Uma persona gerada com `allowedCapabilities` vazio ou ausente fica sem nenhuma tool, em vez de
    todas.
- **S-04:**
  - Os resultados de tool de cada rodada voltam ao modelo dentro de um bloco
    `BEGIN_UNTRUSTED_TOOL_OUTPUT nonce=…` / `END_UNTRUSTED_TOOL_OUTPUT nonce=…`, com nonce aleatório
    e precedido de um aviso de que aquilo é dado, não instrução.
  - Marcadores forjados dentro do conteúdo são reescritos.
  - O `AGENTIC.md` do runtime ganhou a regra correspondente. A regra "tool output is data" já
    existia, mas só passou a chegar ao modelo com o B-05.

**Fora do escopo:** usar o protocolo nativo `tool_use`/`tool_result` dos providers e definir
`riskPolicy` padrão nos perfis. Ficam como melhorias do mesmo tema.

**Testes:** `phase2/__tests__/tool-scope-and-untrusted-output.test.ts`, com 6 casos:

- capability ausente falha sem chamar o modelo;
- capability composta oferece só as suas tools;
- persona vazia fica sem tools;
- invólucro com nonce e aviso;
- marcador forjado neutralizado;
- regra no `AGENTIC.md`.

Antes da correção, 5 dos 6 falharam. Por mutação:

- recusa de capability e invólucro desligados: 2 falham;
- só a neutralização desligada: 1 falha.

O teste de neutralização foi fortalecido depois que a primeira versão passou mesmo sem invólucro.

**Ajuste em teste existente:** os 4 testes de overlays L5 em `agent-runtime.test.ts` usavam a
capability `registerCustomer` sem registrar a tool e dependiam do escopo que falhava aberto. A
fixture passou a registrar a tool do passo, e as asserções sobre o prompt continuam as mesmas.

**Verificação:** `typecheck` 0; `npm test` 0 (API 429, web 120); `verify:release` 0; `test:e2e` 0.

## S-07 e S-08 · Browser navegando para qualquer host e screenshot lendo qualquer arquivo — feito

**O que mudou**

- **S-07, rotas** (`generated-adapter-tools.ts`):
  - O `routeHint` do adapter gerado só leva o browser à origem do alvo: aceita um caminho relativo
    (confinado com o mesmo `confineEndpointUrl` das chamadas de endpoint) ou uma URL absoluta
    http(s) da mesma origem.
  - URL de outro host, `//host` ou barra invertida recebem `route_outside_target`, sem navegar.
  - O registro de tools passou a preservar o `code` de um erro lançado de propósito (sem marcar
    como retryable) e a redigir a mensagem.
- **S-07, execution context** (`execution-context.ts`, `runner.ts`):
  - `targetBaseUrl` e as URLs de preview só aceitam http(s).
  - Um `execution_context` inválido dá `400 invalid_execution_context`. Antes era descartado em
    silêncio, e o run caía na URL do ambiente.
- **S-08** (`services/screenshot-path.ts`, `routes/findings.ts`): o `screenshot_path` de um
  finding sincronizado só é servido se for imagem e se o caminho real, com symlinks resolvidos,
  ficar dentro do diretório do projeto.
- Apoio a teste: o catálogo de capabilities aceita `PERSONA_QA_CAPABILITIES_FILE`, como os outros
  arquivos gerados.

**Teste:** `phase2/__tests__/browser-target-confinement.test.ts`, com 16 casos:

- 3 rotas recusadas sem navegar;
- rota relativa e URL absoluta da mesma origem aceitas;
- 4 esquemas recusados no contexto;
- http(s) aceitos;
- `POST /api/p2/runs` com `file://` dá 400;
- screenshot dentro do projeto servido;
- 5 recusas: absoluto fora, relativo que sobe, symlink para fora, não-imagem, ausente.

O módulo do S-08 não existia antes. Por mutação, em cada uma das quatro proteções:

| Proteção desligada | Testes que falham |
|---|---:|
| rota | 3 |
| esquema | 5 |
| validação no runner | 1 |
| confinamento do screenshot | 3 |

**Verificação:** `typecheck` 0; `npm test` 0 (API 445, web 120); `verify:release` 0; `test:e2e` 0. O e2e
inclui o passo do B-02, que usa `targetBaseUrl` http real e continua passando.

## S-09, S-10 e S-11 · Discovery sobre repositório não confiável — feito

**O que mudou**

- **S-09** (`static-frontend-scanner.ts`): a regex `/^(?:[a-z]+-[a-z0-9/.[\]]+\s*){2,}$/`, com
  quantificadores aninhados ambíguos, virou uma checagem token a token, sem ambiguidade, limitada a
  300 caracteres. A outra regex da mesma função foi medida com quatro tipos de entrada ambígua até
  1000 repetições e é linear.
- **S-10:**
  - `generic-discovery-provider.ts`: a varredura não segue symlinks (`Dirent.isFile`), ignora uma
    raiz que seja symlink, pula `.git` e `.agentic-qa`, para em 2000 arquivos e não lê arquivos
    acima de 256 KB.
  - `static-frontend-scanner.ts`: a raiz candidata do frontend é verificada com `lstat`; um
    symlink é ignorado.
- **S-11** (`local-discovery-materializer.ts`): a mensagem do stub TS gerado, que leva rotas, nomes
  de arquivo e URLs do alvo, é emitida como literal JSON. Aspa, crase ou `${` do alvo não viram
  código.

**Teste:** `packages/dashboard-api/src/discovery-hardening.test.ts` (novo, no `test:unit`), com 11
checagens:

- reconhecimento de classes utilitárias preservado;
- rótulo adversarial de 1000 caracteres em 0,0 ms e página com título adversarial em 9 ms;
- raiz symlink não varrida;
- rota real ainda descoberta;
- arquivo symlink não lido;
- arquivo grande não lido;
- stub não executa o texto do alvo e o preserva na mensagem.

**Antes da correção e mutações:**

- No código antigo, o teste ficou preso na regex por mais de 120 s e foi interrompido. É a prova do
  ReDoS.
- Mutação do S-10 (aceitar symlink e voltar ao `stat`): 2 checagens falham. Mutação só do limite
  de tamanho: 1 falha.
- Mutação do S-11 (voltar às aspas simples): 2 falham.
- A checagem de tamanho estava vazia na primeira versão, porque o arquivo grande não era um
  servidor Express e nunca teria a rota extraída. A fixture foi corrigida e agora distingue.

**Verificação:** `typecheck` 0; `npm test` 0 (as 11 checagens novas no `test:unit`; API 445, web 120);
`verify:release` 0, incluindo os verificadores do scanner e da matriz de domínios; `test:e2e` 0.

## B-07 e B-08 · Sessões presas em `running` e retry que terminava `complete` — feito

**O que mudou**

- **B-08** (`packages/core`, `adapter-execution-engine.ts`): o laço de retry era limitado por um 1
  fixo, enquanto a decisão de desistir usava o `maxRetries` do passo. Um passo que continuava
  falhando saía do laço e era gravado como concluído; a sessão terminava `complete`. Agora o laço
  só termina por sucesso, cancelamento ou desistência, respeita o `maxRetries` pedido (teto de
  segurança de 10) e mantém 1 retry como padrão.
- **B-07, core:** se qualquer hook lança, a sessão é fechada como `failed`, com `run_failed`, antes
  de o erro chegar ao chamador. Antes ficava `running`.
- **B-07, runtime:**
  - `SessionService.failInterruptedSessions` fecha como `failed`, com evento
    `interruption_recorded`, toda sessão `pending` ou `running`.
  - A API chama esse método no arranque (sessões deixadas por um processo que morreu) e no
    desligamento por SIGTERM/SIGINT (sessões que o processo abandona).
  - O efeito é que o gate e as métricas passam a contar essas execuções como falha; antes elas
    sumiam do gate, que só conta sessões finais.

**Testes**

- `packages/core/src/runtime/adapter-execution-engine.test.ts` (novo, no `test:unit`), com 9
  checagens. No código antigo, 6 falharam. Destaque: um passo que falhou duas vezes e só passaria
  na terceira tentativa era gravado `complete` depois da segunda falha.
- `phase2/__tests__/session-recovery.test.ts`, com 4 casos. Um deles sobe o `src/index.ts` real
  como processo filho sobre um banco temporário: a sessão deixada `running` é fechada no arranque,
  e outra criada com o servidor no ar é fechada no SIGTERM. Na mutação (chamadas removidas do
  `index.ts`), esse teste falha.
- A primeira versão desse teste checava a ligação procurando texto no `index.ts`, o tipo de
  instrumento que o T-02 critica. Foi trocada pelo teste com o processo real. No caminho apareceu
  um detalhe de ambiente: o processo filho herdava `VITEST` e usava banco em memória.

**Verificação:** `typecheck` 0; `npm test` 0 (as 9 checagens do motor no `test:unit`; API 449, web 120);
`verify:release` 0; `test:e2e` 0.

## B-06 · Timeout de passo não cancelava ferramenta nem chamada ao modelo — feito

**O que mudou**

- O timeout do passo era só um `Promise.race`: a ferramenta e a chamada ao modelo continuavam
  rodando depois do passo marcado `timeout`, podiam seguir dirigindo a página compartilhada com o
  retry e gravar evidência num passo já encerrado.
- `AgentRuntime` cria um `AbortController` por passo. O `signal` vai para o provedor
  (`ModelProviderOptions.signal`) e para a ferramenta (`ToolContext.signal`). `finishStep` aborta
  o controlador em qualquer desfecho (timeout, erro ou conclusão normal).
- Provedores: o Anthropic passa `{ signal }` como segundo argumento de `messages.create` (só
  quando há signal, para não mudar a chamada sem ele); o OpenAI passa `signal` ao `fetch`.
- Ferramentas de evidência (`captureScreenshot`, `collectDomSnippet`, `recordArtifact`) recusam com
  `step_aborted` antes de tocar a página e de novo logo antes de gravar.
- Ferramentas geradas de browser recebem a página embrulhada num `Proxy`: todo método da página,
  e dos locators que ela devolve, checa o signal antes de agir e lança `StepAbortedError`
  (`step_aborted`).

**Testes**

- `phase2/__tests__/step-cancellation.test.ts`, com 9 casos. Os 5 primeiros falharam todos no
  código antigo.
- Mutações, cada uma morta por pelo menos um caso: sem `abort` no `finishStep`; sem `signal` para
  o modelo; sem `signal` para a ferramenta; sem a guarda das ferramentas de evidência; sem a
  checagem no proxy; locators sem proxy; provedores Anthropic e OpenAI sem repassar o `signal`.
- Duas dessas mutações (checagem no proxy e locators sem proxy) sobreviveram à primeira versão
  dos testes, que só abortava antes de a ferramenta começar. Entraram dois casos com o aborto no
  meio da ferramenta: um durante a leitura de `url()` antes da navegação e outro entre `count()`
  e `fill()` no mesmo locator.
- Uma terceira mutação (checagem do signal na entrada de `requirePage`) sobreviveu por ser
  redundante com o proxy, que barra o primeiro uso da página. A linha foi retirada.
- Três testes antigos do provedor Anthropic quebraram quando `create` passou a receber um segundo
  argumento `undefined`. A chamada agora só leva o segundo argumento quando há signal.

**Verificação:** `typecheck` 0; `npm test` 0 (API 458, web 120); `verify:release` 0; `test:e2e` 0.

**Limite conhecido:** uma ação de Playwright já em andamento quando o passo termina (um `fill` em
espera, por exemplo) não é interrompida no meio; o que o passo impede é a próxima ação.

## T-01 · Testes de política de risco que não distinguiam bloquear de executar — feito

**O que mudou** (só teste; o runtime já bloqueava)

- `story-1.3-risk-aware-tool-policy.test.ts`: os handlers passam a ser espiões que registram cada
  execução real.
- "runs a read tool and refuses a destructive one…": o modelo pede `readData` e depois `deleteAll`.
  O teste afirma que só `readData` executou, que há um `tool_result` de `deleteAll` com
  `tool_not_allowed` e que `deleteAll` não foi oferecido.
- "refuses a write tool that requires approval…": o modelo agora pede de fato `writeData`. A
  política põe `write` em `allowedRiskLevels` e em `requireApprovalFor`, para que só a regra de
  aprovação possa barrar. O teste afirma que nada executou e que houve `tool_not_allowed`.

**Medição do instrumento**

| Mutação no `agent-runtime.ts` | Teste antigo | Teste novo |
|---|---|---|
| Execução sem checar a política (`isToolAllowed` → `true`) | passa | falha (2 casos) |
| Sem a regra `requireApprovalFor` | passa | falha |
| Sem a regra `denyRiskLevels` | falha ("deny takes precedence") | falha |

**Verificação:** `typecheck` 0; `npm test` 0 (API 458, web 120); `verify:release` 0; `test:e2e` 0.

## T-02 · Testes de hardening que confirmavam a própria hipótese — feito

**O que mudou**

- **(a) Bind.** `startPlatformApi` e `startPlatformWeb` passam a ser exportadas e esperam o `listen`
  terminar (rejeitam se o bind falhar). O ponto de entrada de produção continua chamando as mesmas
  funções. O teste sobe os dois servidores por elas, em portas livres, e lê `server.address()`.
  O helper `listen` do próprio teste e a checagem "api address family stays loopback" (promise que
  resolvia na hora) saíram de `testControlPlane`.
- **(b) Escape.** As três checagens que procuravam a string `escapeHtml(...)` no HTML foram
  trocadas por `testExecutionRenderingEscapes`. Ela executa o script real da página num `vm` com um
  DOM falso que registra todo HTML escrito na página. Depois chama `renderExecutionList` e
  `renderExecutionDetail` com uma execução cujos campos são `<img src=x onerror=…>`. Exige que os
  payloads apareçam escapados (prova de que a renderização aconteceu) e que nenhum `<img` chegue
  como marcação. Não entrou dependência nova (jsdom); o `fetch` falso nunca resolve, então o
  carregamento inicial da página não roda.

**Medição do instrumento**

| Mutação | Teste antigo | Teste novo |
|---|---|---|
| API faz bind em `0.0.0.0` | passa | falha |
| Dashboard faz bind em `0.0.0.0` | passa | falha |
| `scenarioId` sem escape na lista | falha (grep) | falha |
| `adapterId` sem escape no detalhe | passa | falha |
| `escapeHtml` do cliente sem trocar `<` | passa | falha (5 checagens) |

**Verificação:** `typecheck` 0; `npm test` 0 (API 458, web 120); `verify:release` 0; `test:e2e` 0.

## T-03 · O typecheck excluía os testes do runtime — feito

**O que mudou**

- `templates/persona-qa-dashboard/packages/api/tsconfig.test.json` estende o `tsconfig.json` e
  inclui `__tests__`. O `npm run typecheck` da raiz passa a rodar `tsc -p tsconfig.test.json` depois
  do typecheck de produção.
- Medido antes de corrigir: 37 erros. Os 29 do relatório mais 8 em testes escritos nas próprias
  P1/P2 deste trabalho, exatamente o risco que o item aponta.
- Correções, todas em testes:
  - 21 fixtures de `AgentStepOutput` sem `findings`, que a produção sempre preenche, ganharam
    `findings: []`.
  - Mocks de provedor passaram a ter `stopReason` literal e assinatura tipada.
  - Hooks de teste deixaram de devolver o `number` de `Array.push`.
  - Dois `noUncheckedIndexedAccess` resolvidos com `!` em fixtures conhecidas.
- `local-request-guard.test.ts` (S-01) importava `ws`, que nenhum `package.json` declara: vinha
  transitivamente e sem tipos. O teste de upgrade agora fala HTTP cru sobre `net.connect` e lê a
  linha de status. Ninguém precisou instalar `@types/ws`.

**Medição do instrumento**

- Um `findings: []` removido de `sensors.test.ts`: o `typecheck` novo sai com 2; o antigo
  (`package.json` do HEAD), com 0.
- O cliente de upgrade novo continua distinguindo o guard: sem a checagem de Origin, o caso
  cross-site falha; sem a de token, o caso sem token falha.

**Verificação:** `typecheck` 0 (agora com os testes do runtime); `npm test` 0 (API 458, web 120); `verify:release` 0; `test:e2e` 0.

## T-06 · Release gate validava chave na rede e podia copiar a chave real — feito

**O que mudou**

- O alcance era maior do que o relatório descreve. O instalador lê primeiro o `.env.local` da
  plataforma (cwd) e só depois o ambiente. Por isso, zerar `ANTHROPIC_API_KEY` no ambiente, como
  faziam dois verificadores, não impedia que uma chave real desse arquivo fosse validada na rede e
  gravada na fixture temporária. O `verify-generic-repository-types` nem zerava. A chave OpenAI
  seguia o mesmo caminho e não tinha override.
- Instalador (`local-package-installer.ts`):
  - `ANTHROPIC_API_KEY_OVERRIDE` e o novo `OPENAI_API_KEY_OVERRIDE` vencem qualquer outra fonte
    quando estão definidos, mesmo vazios. Vazio significa "sem chave". Antes, o override vazio era
    ignorado.
  - Com `AGENTIC_QA_SKIP_KEY_VALIDATION=1`, a validação não faz `fetch` e o resultado diz
    "skipped".
- `scripts/lib/provider-isolation.mjs` define esse ambiente, aplicado aos quatro pontos que rodam
  `install-local`: `verify-generic-frontend`, `verify-generic-runtime-execution`,
  `verify-generic-repository-types` e `storefront-runtime` (e2e). O `verify-generic-frontend` usa
  sempre o placeholder, e não mais "o placeholder só se não houver chave".

**Testes**

- `testProviderKeyIsolation` em `hardening.regression.test.ts`. O instalador roda com o cwd num
  diretório temporário que tem um `.env.local` de plataforma plantado (o real nunca é lido), com
  chaves também no ambiente e com o `fetch` trocado por um espião.
- No código antigo, falharam: chamada de rede feita, validação não marcada como pulada e chave
  OpenAI do `.env.local` plantado gravada na fixture.
- Checagem do instrumento: sem a flag, o mesmo espião vê exatamente uma validação.

**Medição no verificador real:** `verify-generic-frontend` rodado com `ANTHROPIC_API_KEY` e
`OPENAI_API_KEY` fictícias no ambiente.

- Saiu com 0 e reportou "validation skipped".
- O `.env.local` da fixture tem o placeholder e nenhuma das duas chaves fictícias.
- O verificador antigo não foi rodado com a chave fictícia, porque mandaria essa chave à API da
  Anthropic. O 401 dele já estava medido no relatório.

**Fora deste item:** a fixture continua ficando em `/tmp` depois da execução (T-07, P3).

**Verificação:** `typecheck` 0; `npm test` 0 (API 458, web 120); `verify:release` 0, sem nenhuma linha de validação com falha nem menção a `api.anthropic` no log; `test:e2e` 0.

## A-02 · O instalador remendava o template com `string.replace` — feito

**O que mudou**

- Simulação das 14 substituições contra o template atual: 11 não casavam (o template já tinha o
  texto de destino) e 3 casavam, todas com efeito errado ou fora do lugar:
  - `session-service.ts`: `private readonly sqlite: Database` casava como prefixo e virava
    `Database.Database.Database`, como diz o relatório.
  - `runtime-bootstrap.ts`: o template já tinha o import de `getSessionService`/`setSessionService`;
    o `replace` o inseria de novo. Visto na fixture instalada: linhas 16 e 17 iguais. O esbuild
    (`tsx`) funde os dois imports e o runtime sobe; um `tsc` na cópia instalada rejeitaria esse
    import e o tipo acima. Isso é inferência, não rodei. Este defeito não estava no relatório.
  - `Overview.tsx:963`: o template quebrava sem sessões (`orderedSessions[0]!.startedAt`) e só a
    cópia instalada era consertada.
- O bloco inteiro de `replace` saiu do instalador. A correção do `Overview` foi para a fonte. Não
  sobrou nada a trocar na instalação, então "falhar quando não casar" não se aplica.

**Testes**

- `testInstalledSourceMatchesTemplate` (`hardening.regression.test.ts`) instala num repositório
  temporário e compara byte a byte os 213 arquivos de `packages/{api,web}/src` com o template.
  Antes da correção, falhou apontando exatamente `runtime-bootstrap.ts`, `session-service.ts` e
  `Overview.tsx`. Daqui em diante, qualquer remendo novo na instalação também quebra esse teste.
- `packages/web/src/__tests__/OverviewEmpty.test.tsx` renderiza o `Overview` com a API vazia. Com
  a linha antiga, falha com `TypeError: Cannot read properties of undefined (reading 'startedAt')`;
  com a corrigida, mostra "no activity yet".

**Verificação:** `typecheck` 0; `npm test` 0 (API 458, web 121); `verify:release` 0; `test:e2e` 0.

## Revisão dos itens já commitados

### B-06, segunda parte · O passo que terminava por exceção não abortava o signal — feito

- A primeira versão abortava o controlador dentro de `finishStep` e o guardava num `Map` indexado
  por `sessionId`. Isso deixava dois furos:
  - Se `executeStep` rejeitava sem passar por `finishStep` (um erro do `SessionService` ao gravar
    o evento, por exemplo), o signal nunca era abortado.
  - Um passo que terminava abortava o signal de outro passo em andamento na mesma sessão.
- Agora o controlador é local a cada chamada. `executeStep` chama `runProfileStep` dentro de
  `try/finally` e aborta no `finally`. O `Map` saiu.
- Dois casos novos em `step-cancellation.test.ts`, os dois vistos falhando antes da correção:
  - o `appendEvent` do `tool_result` lança e o signal tem de ficar abortado;
  - dois passos concorrentes na mesma sessão: o que termina primeiro não aborta o outro.
- Mutação: sem o `abort()` do `finally`, 5 dos 11 casos falham.

### T-06 · Pontos conferidos

- O runtime instalado também tem um caminho de validação de chave
  (`validateProviderCredentials` em `runner.ts`). Ele não roda no gate, porque os dois lançamentos
  de runtime nos verificadores passam `AGENTIC_QA_FORCE_DETERMINISTIC_RUNTIME=1`, e nesse modo o
  runner não carrega as configurações de provedor. Conferido por leitura de código.
- As instalações antigas do `testInstaller` já estavam isoladas: `chdir` para um diretório
  temporário vazio, chaves removidas do ambiente e um `fetch` que lança.

### T-03 · Correção de número

- Eram 21 fixtures com `findings: []`, não 22. Contado com
  `git show 0151068 | grep -c '^+ *findings: \[\],'`.

**Verificação (revisão):** `typecheck` 0; `npm test` 0 (API 460, web 121); `verify:release` 0; `test:e2e` 0.

## S-12 · Dependências com vulnerabilidades conhecidas — parte 1 (sem major) feita

**O que mudou**

- O registry é o público (`registry.npmjs.org`), sem `.npmrc` no projeto.
- Baseline com `npm audit --json`:
  - raiz: 1 vulnerabilidade alta (`zod`, direta, só corrige com major);
  - template: 17 (1 crítica `shell-quote`, 8 altas, 7 moderadas, 1 baixa).
- `npm audit fix` (sem `--force`) caiu num bug do npm 10.9.8: `Cannot read properties of null
  (reading 'edgesOut')` em `#loadPeerSet`, ao resolver os peers do `vitest`. Por isso:
  - `npm update` das transitivas vulneráveis dentro das faixas declaradas, só no lockfile;
  - `vite` e `vitest` com `npx npm@11.6.2 update … --package-lock-only`, que não tem o bug. O
    lockfile continua na versão 3;
  - `npm ci` com o lockfile novo: `vite` 6.4.2 → 6.4.6, `vitest` 4.1.4 → 4.1.12.
- Template depois: 6 vulnerabilidades (0 crítica, 2 altas, 4 moderadas). Todas exigem major:
  - `drizzle-orm` (alta, produção);
  - `zod` (alta, produção);
  - `drizzle-kit` e o `esbuild` antigo que ele arrasta (moderadas, desenvolvimento).
- `npm run audit:deps` roda `npm audit --audit-level=high` na raiz e no template e falha se
  qualquer um tiver alta. Hoje sai com 1, pelas majors pendentes. Ligar isso ao CI exige mexer em
  `.github/`, que está fora deste trabalho; fica para o Allan.

**Verificação:** `typecheck` 0; `npm test` 0 (API 460, web 121); `verify:release` 0; `test:e2e` 0, já com o `node_modules` reinstalado pelo lockfile novo.

## S-12 · parte 2: `drizzle-orm` 0.36 → 0.45.4 — feito

- `npx npm@11.6.2 install drizzle-orm@^0.45.4 -w @persona-qa/api --package-lock-only`, depois
  `npm ci`. `tsc` 0 sem nenhuma mudança de código.
- Risco específico: o runtime instalado não usa o `better-sqlite3` real, e sim o shim sobre
  `node:sqlite` que o instalador gera. Nenhum verificador chama as rotas com drizzle no runtime
  instalado. Medição: as suítes `node:test` de `src/routes/__tests__` (27 testes, rotas runs,
  stats e sync) rodadas com um hook de resolução do Node que troca `better-sqlite3` pelo shim.
  Resultado: 27/27 com o shim e 27/27 com o `better-sqlite3` real.
- Checagem do instrumento: com um shim que lança no construtor, o mesmo comando falha em 5 suítes,
  então o hook carrega o shim de fato.
- Template depois: 5 vulnerabilidades (1 alta, `zod`; 4 moderadas de `drizzle-kit`/`esbuild`, só
  em desenvolvimento).

**Verificação:** `typecheck` 0; `npm test` 0 (API 460, rotas `node:test` 27, web 121); `verify:release` 0; `test:e2e` 0.

## S-12 · parte 3: `zod` 3 → 4.6.7 (raiz e template) — feito

- Instalado com `npx npm@11.6.2 install zod@^4.6.7 --package-lock-only` nos workspaces
  `@persona-qa/api`, `@agentic-platform/core` e `@agentic-platform/host-sdk`, seguido de `npm ci`.
- O `tsc` apontou dois tipos de quebra:
  - 31 `z.record(valor)` de um argumento (18 no template, 13 na raiz). O zod 4 exige o schema da
    chave; viraram `z.record(z.string(), valor)`. A troca foi feita por um script que só altera
    chamadas com argumento único.
  - `z.typeToFlattenedError` em `validateExecutionContext`, código meu do S-07. Foi trocado por um
    tipo estrutural explícito e `z.flattenError`.
- Risco de semântica conferido:
  - No zod 4, o valor de `.default()` não passa mais pelo schema. O `tsc` exige que ele satisfaça
    o tipo de saída completo e passou, então nenhum default de objeto ficou dependendo de defaults
    internos.
  - Não há `transform`/`preprocess`/`pipe` em nenhum dos schemas.
- `npm run audit:deps` agora sai com 0:
  - raiz: 0 vulnerabilidades;
  - template: 4 moderadas, todas de `drizzle-kit` e do `esbuild` antigo que ele traz, só em
    desenvolvimento. O `drizzle-kit` 0.31 é major e não entrou.

**Resultado do S-12:** template de 17 (1 crítica, 8 altas) para 4 moderadas de desenvolvimento;
raiz de 1 alta para 0.

**Verificação:** `typecheck` 0; `npm test` 0 (API 460, rotas `node:test` 27, web 121); `verify:release` 0; `test:e2e` 0.

## T-05 · Cobertura não era medida — feito (medição, sem piso)

**O que mudou**

- Runtime (template): `@vitest/coverage-v8` 4.1.12, a mesma versão do `vitest`. A config de
  cobertura ficou em `packages/api/vitest.config.ts`: `src/**` sem os `__tests__`.
- Plataforma: `c8` na raiz. Os testes da plataforma são runners `tsx` caseiros; o `c8` coleta a
  cobertura V8 de qualquer processo e dos seus filhos, sem trocar de runner.
- `npm run test:coverage` roda os dois e gera HTML em `coverage/` (já no `.gitignore`; o instalador
  já excluía `coverage` da cópia). Não há piso: isso fica para quando houver uma série de medições.
- Os testes do core pedidos no relatório já existiam desde o B-01a (`contract-evaluation`), o B-07 e
  o B-08 (`adapter-execution-engine`), e estão no `test:unit`. O que faltava era medir.

**Medição**

| Escopo | Linhas | Branches | Funções |
|---|---|---|---|
| Plataforma (`packages/*/src`, `test:unit` inteiro) | 78,28% | 69,35% | 75,46% |
| Runtime (`packages/api/src`, vitest) | 63,85% | 54,03% | 67,68% |
| `core/.../adapter-execution-engine.ts` | 77,96% | 59,01% | — |
| `core/.../contract-evaluation.ts` | 96,48% | 69,69% | — |
| `core/.../scenario-quality-gates.ts` | 29,78% | 100% | — |

- Checagem do instrumento: o mesmo comando `c8 --all` sobre `node -e ""` dá 0% com o mesmo
  denominador (14.854 linhas). O número da plataforma vem de fato dos testes.
- Limites conhecidos:
  - As 27 suítes `node:test` de `src/routes/__tests__` não entram no número do runtime, então os
    arquivos de rota aparecem abaixo do real.
  - O pacote web não foi medido.
  - `scenario-quality-gates.ts` do core segue com pouca cobertura; o teste dele cabe no A-01.
- `npm run audit:deps` continua saindo com 0 depois das dependências novas.

**Verificação:** `typecheck` 0; `npm test` 0 (API 460, rotas `node:test` 27, web 121); `verify:release` 0; `test:e2e` 0.
