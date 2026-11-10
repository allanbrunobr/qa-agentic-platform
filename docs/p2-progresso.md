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
