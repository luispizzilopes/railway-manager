## Context

### Estado atual do repositório

| Arquivo | Papel |
|---|---|
| `Dockerfile` | Alpine + `bash`/`curl`/`jq`/`tzdata` + `supercronic`; gera `/app/crontab` a partir de `START_SCHEDULE`/`STOP_SCHEDULE` (build args). |
| `startup.sh` | Imprime configuração e faz `exec supercronic /app/crontab`. |
| `railway.sh` | Valida o token com `project(id: $RAILWAY_PROJECT_ID) { name }`; para cada `SERVICES_ID` lê `deployments(first: 1, input: {projectId, environmentId, serviceId})`; **stop** = `deploymentRemove(id)` se status ≠ `REMOVED`; **start** = `deploymentRedeploy(id, usePreviousImageTag: true)` somente se o último status for `REMOVED`. |
| `README.md` | Documentação do template "Railway Service Cron" (deploy button público). |

Não há testes, frontend, persistência, nem código Rust. Limitações observadas: IDs de projeto/ambiente fixos via variáveis injetadas pelo Railway (só gerencia o próprio projeto); considera apenas o último deployment (ignora múltiplos ativos); não confirma o resultado; queries montadas por concatenação de strings; erros apenas impressos. **O que se reaproveita**: as regras de negócio (checar antes de agir; pular quem já está no estado; remove/redeploy com imagem anterior), que estão em produção e foram a base da análise de viabilidade abaixo.

### Viabilidade na API do Railway (verificada)

Fontes: introspecção de `https://backboard.railway.com/graphql/v2` em 2026-11-16 (690 tipos) e páginas `integrations/api`, `integrations/api/manage-deployments`, `deployments/deployment-actions`, `deployments/serverless` da documentação oficial. Todos os campos abaixo existem no schema.

| Necessidade | Operação | Observações |
|---|---|---|
| Validar token de conta | `me { id name email workspaces { id name } }` | Não funciona com token de workspace/projeto (docs). |
| Validar token de workspace | `workspace(workspaceId) { id name }` | Requer `workspaceId` informado pelo usuário. |
| Listar projetos | `projects(first, after, workspaceId, includeDeleted: false)` → `QueryProjectsConnection { edges { node { id name description workspaceId deletedAt } } pageInfo }` | Paginação cursor. Para token de conta: uma chamada por workspace de `me.workspaces`. Alternativa em lote: `projectsByIds(ids)`. |
| Projeto e ambientes | `project(id) { id name description deletedAt environments(first) { edges { node { id name isEphemeral } } } services(first) { edges { node { id name } } } }` | `Service.serviceInstances` está **deprecated**; usar `environment.serviceInstances`. |
| Instâncias de um ambiente | `environment(id) { serviceInstances(first) { edges { node { id serviceId serviceName environmentId sleepApplication numReplicas deletedAt latestDeployment { … } activeDeployments { … } } } } }` | Uma chamada por ambiente cobre todas as instâncias — usada também no *polling*. |
| Instância específica | `serviceInstance(environmentId, serviceId)` | Mesmos campos. |
| Deployments ativos | `ServiceInstance.activeDeployments: [Deployment!]!` | "All currently active (deployed and running) deployments". Resolve o caso de mais de um ativo, ignorado pelo script atual. |
| Histórico/filtro | `deployments(first, input: { projectId, environmentId, serviceId, status: { in: [...] } })` | **Divergência**: a documentação mostra `status: { successfulOnly: true }`, que **não existe** no schema (`DeploymentStatusInput` só tem `in`/`notIn`). Seguimos o schema. |
| Estado de um deployment | `deployment(id) { id status statusUpdatedAt canRedeploy deploymentStopped }` | `deploymentStopped`: "instances have all stopped". |
| Desligar | `deploymentRemove(id): Boolean!` | Docs: "remove the deployment and stop any further project usage". Fluxo já em produção no `railway.sh`. Status resultante `REMOVING` → `REMOVED`. Não apaga volumes, variáveis nem o serviço. |
| Desligar (alternativa) | `deploymentStop(id): Boolean!` | Existe e é documentado apenas como "Stop a running deployment". Status resultante e forma de religar **não documentados** → ver Decisão 1 / spike. |
| Iniciar | `deploymentRedeploy(id, usePreviousImageTag: true): Deployment!` | Cria **novo** deployment com o mesmo código/config; `usePreviousImageTag` evita rebuild. Elegibilidade via `canRedeploy`. Sujeito à política de retenção de imagens do plano. |
| Status possíveis | `DeploymentStatus`: `BUILDING CRASHED DEPLOYING FAILED INITIALIZING NEEDS_APPROVAL QUEUED REMOVED REMOVING SKIPPED SLEEPING SUCCESS WAITING` | A tabela da documentação omite `INITIALIZING`, `NEEDS_APPROVAL`, `REMOVING`; o schema é a referência. |
| Rate limit | Free 100 RPH; Hobby 1000 RPH / 10 RPS; Pro 10000 RPH / 50 RPS | Cabeçalhos `X-RateLimit-Limit/Remaining/Reset`, `RateLimit-Policy`; `429` + `Retry-After`. |
| Erros | HTTP 200 com `errors` (inclusive autorização), 400 (validação, `extensions.code`), 429 | Sempre inspecionar `errors`. |

**Operações descartadas e por quê**

- `deploymentRestart` — reinicia o container de um deployment existente; **não** é "iniciar um serviço parado" (exigência explícita da proposta). Não usado.
- `serviceInstanceRedeploy`, `serviceInstanceDeploy(V2)`, `environmentTriggersDeploy` — disparam build a partir da fonte/trigger, podendo publicar código diferente do que estava rodando. Não usados na v1 (possível ação explícita futura "novo deploy").
- `serviceInstanceUpdate { sleepApplication }` (Serverless) — não é desligamento: o serviço acorda com qualquer tráfego e o valor só vale após novo deploy (docs).
- `serviceInstanceUpdate { numReplicas: 0 }` — não documentado como suportado; alteraria configuração do serviço. Não usado.
- Qualquer `*Delete`, `volume*`, `variable*`, `environmentPatchCommit*` — fora de escopo e potencialmente destrutivas.

## Goals / Non-Goals

**Goals:**
- Domínio independente de Railway, SQLite e Axum, garantido pelo grafo de dependências entre crates.
- Toda chamada GraphQL validada em compile-time contra um snapshot do schema.
- Um único binário que serve API e frontend estático; instalação via `docker run` ou `cargo run` + `npm run build`.
- Pontos de extensão explícitos para agendamento e múltiplas contas, sem implementá-los.

**Non-Goals:**
- Multiusuário/RBAC (apenas um administrador).
- Atualização em tempo real via WebSocket/subscriptions (polling basta na v1).
- Substituir o template cron legado nesta entrega.
- Suporte a token de projeto.

## Decisions

### 1. Mecanismo de desligar/iniciar: `deploymentRemove` + `deploymentRedeploy(usePreviousImageTag: true)`, com spike para `deploymentStop`

- **Desligar**: para cada item de `serviceInstance.activeDeployments`, `deploymentRemove(id)`. Confirmação: `activeDeployments` vazio e `latestDeployment.status = REMOVED`.
- **Iniciar**: exige `latestDeployment.status = REMOVED` (ou o estado "parado" equivalente, se o spike adotar `deploymentStop`) e `canRedeploy = true`; então `deploymentRedeploy(id, usePreviousImageTag: true)` e acompanha o deployment retornado até `SUCCESS` / `FAILED` / `CRASHED`. Se o último deployment não for "parado" ou não for reaproveitável, falha com motivo — mesma regra conservadora do `railway.sh`, que evita ressuscitar um deployment antigo quando o mais recente falhou.
- **Por que**: é o único par cujo comportamento de ida *e volta* está comprovado (em uso no repositório) e documentado ("stop any further project usage"; redeploy "with the exact same code and build/deploy configuration").
- **Alternativa**: `deploymentStop`. Pode preservar melhor o deployment no histórico, mas a documentação não diz qual status ele produz nem se `deploymentRedeploy` funciona depois. A tarefa 2.6 executa um spike numa conta real (projeto descartável) e registra em ADR: status após stop, valor de `deploymentStopped`/`canRedeploy`, e se o redeploy volta a mesma imagem. A estratégia fica atrás de um enum `StopMechanism { Remove, Stop }` em configuração, default `Remove`, para que a troca não mude nada fora do adaptador.
- **Volumes**: `deploymentRemove` não remove volumes; o serviço reanexa o volume ao novo deployment. Documentado no README e validado no spike.

### 2. Cliente GraphQL: `graphql_client` (codegen) + `reqwest`, com lista fechada de operações

- Snapshot `backend/crates/infrastructure/graphql/railway.schema.json` (introspecção) + um arquivo `.graphql` por operação. `#[derive(GraphQLQuery)]` gera tipos e **falha a compilação** se um campo não existir — atende "não invente queries/campos".
- Trait de saída no domínio/aplicação (`RailwayGateway`) com métodos específicos (`list_projects`, `get_project`, `list_service_instances`, `get_service_instance`, `get_deployment`, `stop_deployment`, `redeploy_deployment`). Não existe método genérico `execute(query)`.
- Teste de guarda percorre os `.graphql` e falha se houver mutation fora de `{deploymentRemove, deploymentStop, deploymentRedeploy}`.
- Script `scripts/update-railway-schema.sh` para refazer a introspecção; mudanças no schema aparecem como diff revisável.
- **Alternativas**: `cynic` (também valida, API mais elaborada; sem ganho aqui); strings manuais com `serde_json` (como o script atual — sem validação, rejeitado).

### 3. Organização: Cargo workspace com crates por camada

```
backend/
  crates/domain          # entidades, value objects, estados, regras (sem I/O; sem tokio/sqlx/axum/reqwest)
  crates/application     # casos de uso, traits de porta (RailwayGateway, repositórios, Clock, CredentialCipher), orquestração
  crates/infrastructure  # railway (graphql_client+reqwest), sqlite (sqlx), crypto, rate limiter
  crates/api             # Axum: rotas, DTOs, extractors, erros HTTP, sessão
  crates/server          # binário: config, wiring, migrações, serve frontend
frontend/                # Vite + React + TS
```

Crates tornam a regra de dependência verificável pelo compilador (domain não pode importar sqlx). Quatro crates + binário é o mínimo para isso; não haverá crate por agregado.

### 4. Modelo de dados

```
credentials(id, kind[account|workspace], workspace_id?, ciphertext, nonce, key_version, label, masked_suffix, status, validated_at, created_at)
projects(id, credential_id→credentials, railway_project_id UNIQUE, name, display_name?, description?, created_at, last_synced_at?, sync_status)
environments(id, project_id→projects CASCADE, railway_environment_id UNIQUE, name, is_ephemeral)
services(id, project_id→projects CASCADE, railway_service_id, name, UNIQUE(project_id, railway_service_id))
service_instances(id, service_id→services CASCADE, environment_id→environments CASCADE, UNIQUE(service_id, environment_id),
                  observed_state, freshness, latest_deployment_id?, latest_deployment_status?, last_observed_at?, last_sync_error?)
operations(id, kind[start|stop], scope[instance|project|batch], trigger[manual], requested_by, plan_id UNIQUE, status, created_at, started_at?, finished_at?)
operation_items(id, operation_id→operations, service_instance_id? (SET NULL),
                project_name, railway_project_id, service_name, railway_service_id, environment_name, railway_environment_id,
                previous_state, desired_state, final_state?, deployment_id?, result, error_message?, started_at?, finished_at?, duration_ms?)
  -- UNIQUE INDEX (service_instance_id) WHERE result IN ('pending','running','verifying')  → bloqueio persistente de conflito
operation_plans(id, payload_json, expires_at, consumed_at?)
sessions(id_hash, created_at, expires_at)
```

- Instância = serviço × ambiente, como no Railway (`ServiceInstance`). Atende "um serviço pode ter deployments em vários ambientes".
- `credential_id` em `projects` já existe com uma única credencial — o suporte futuro a múltiplas contas não exige migração destrutiva.
- `operation_items` copia nomes/IDs (desnormalização intencional) para o histórico sobreviver à remoção local.
- `trigger` existe desde já (`manual`); o agendador futuro gravará `schedule`.

### 5. Estado observado (função pura no domínio)

Entrada: `latestDeployment.status`, `activeDeployments[].status`, `deletedAt`. Regra (primeiro que casar):
1. instância ausente/`deletedAt` → `unknown` (não encontrado);
2. algum ativo `SUCCESS` → `running`; algum ativo `SLEEPING` → `sleeping`;
3. latest em `QUEUED|WAITING|INITIALIZING|BUILDING|DEPLOYING|REMOVING` → `transitioning`;
4. latest `NEEDS_APPROVAL` → `awaiting_approval`;
5. latest `FAILED|CRASHED` → `failed`;
6. latest `REMOVED|SKIPPED` ou nenhum deployment ativo → `stopped`;
7. resto → `unknown`.
Frescor é calculado na leitura: `fresh` se `now - last_observed_at ≤ RM_STALE_AFTER` (padrão 5 min), `unavailable` se a última tentativa falhou, senão `stale`. Testado por tabela cobrindo todos os enums.

### 6. Fluxo plano → execução → verificação

1. `POST /api/operations/plan { kind, target }` lê o estado atual no Railway (por ambiente, uma chamada cada), calcula `will_stop|will_start|will_skip(motivo)` por instância e grava `operation_plans` com validade de 5 min. Retorna plano + `plan_id`.
2. `POST /api/operations { plan_id }` consome o plano atomicamente (`UPDATE … SET consumed_at WHERE consumed_at IS NULL AND expires_at > now`), cria `operations` + `operation_items` (`pending`) na mesma transação, retorna `202 { operation_id }`.
   Operação individual usa o mesmo caminho; o frontend cria e confirma o plano sem modal extra.
3. Worker (`tokio::spawn`) processa itens com `Semaphore(RM_MAX_CONCURRENCY, padrão 3)`. Por item: reler estado (pré-condição) → `skipped` ou mutation → `verifying` → *polling* (5 s com backoff até 15 s; timeout `RM_START_TIMEOUT` 10 min / `RM_STOP_TIMEOUT` 3 min) → resultado final. Falha num item é capturada e registrada; o loop continua.
4. `GET /api/operations/{id}` retorna progresso; o frontend consulta a cada 2–3 s enquanto não terminar.
5. Na inicialização, itens `pending|running|verifying` → `interrupted` (libera o índice único).

- **Por que plano persistido** e não só um diálogo no frontend: a confirmação passa a ser imposta pelo servidor; a lista exibida é exatamente a que será executada; e o reuso do plano bloqueia cliques duplos.
- **Alternativa**: fila durável (tabela de jobs + worker com retomada). Rejeitada na v1: mutations não são seguramente re-executáveis; marcar `interrupted` é mais seguro. O caso de uso `ExecutePowerOperation` fica isolado para o agendador futuro chamá-lo.

### 7. Concorrência e conflitos

Duas camadas: o índice único parcial em `operation_items` (fonte da verdade, sobrevive a corrida entre requisições) e, ao inserir, a violação vira `skipped: "operação em andamento"` em lote ou `409` em operação individual. Remoção de projeto/serviço verifica o mesmo índice. Não usamos lock em memória — SQLite com `BEGIN IMMEDIATE` já serializa as escritas, e um processo único é premissa da v1 (documentada).

### 8. Rate limiting e resiliência

Middleware no cliente Railway: token bucket (`RM_RAILWAY_RPS`, padrão 5) compartilhado por todas as chamadas; leitura dos cabeçalhos de cota; em `429`, pausa global até `Retry-After`. Retry com backoff + jitter **somente para queries** (máx. 3). Timeouts `reqwest`: conexão 5 s, requisição 20 s (configuráveis). Polling agrupado por ambiente (`environment.serviceInstances`) reduz chamadas: um lote de 10 instâncias no mesmo ambiente custa ~1 leitura por ciclo, não 10.

### 9. Credenciais

- `XChaCha20-Poly1305` (crate `chacha20poly1305`) com chave de 32 bytes em `RM_MASTER_KEY` (base64), nonce aleatório por gravação, `credential_id` como AAD, `key_version` para rotação futura.
- Token mantido em `secrecy::SecretString` na memória; `Debug`/`Display` não o imprimem; DTOs de saída não têm o campo. Teste de integração verifica que nenhuma resposta nem log capturado contém o token.
- **Alternativa**: keychain do SO — inviável em container no Railway. Variável de ambiente pura com o token — rejeitada porque a proposta exige cadastrar/substituir pela UI.

### 10. Acesso à aplicação

`RM_ADMIN_PASSWORD_HASH` (argon2; o binário oferece `railway-manager hash-password`) ou `RM_ADMIN_PASSWORD` para desenvolvimento. Sessão em cookie opaco; no banco só o hash do ID. Rate limit de login em memória. CSRF mitigado por `SameSite=Strict` + exigência de `Content-Type: application/json` nas mutações.

### 11. API HTTP (resumo)

`/api/session` (POST/DELETE) · `/api/credential` (GET/PUT/DELETE) · `/api/railway/projects` (descoberta) · `/api/projects` (CRUD local, `POST /{id}/sync`) · `/api/projects/{id}/environments` · `/api/projects/{id}/railway-instances` (descoberta) · `/api/projects/{id}/instances` (associar/remover) · `/api/operations/plan`, `/api/operations`, `/api/operations/{id}` · `/api/history` · `/api/dashboard` · `/healthz`. Erros em formato único `{ code, message, details? }` via um `AppError` → `IntoResponse` central.

### 12. Frontend

React + TS + Vite, `react-router`, `@tanstack/react-query` (cache, polling, invalidação), CSS próprio com tokens (sem kit genérico). Telas: Login · Dashboard (indicadores + projetos com instâncias por ambiente e chips de estado/frescor) · Projeto (ambientes, instâncias, ações, sincronizar) · Descoberta/Importação · Operação (plano/confirmação e progresso por item) · Histórico (filtros) · Configurações (credencial). Build em `frontend/dist` servido por `tower-http::ServeDir` com fallback SPA. Tipos dos DTOs mantidos em `frontend/src/api/types.ts`.

### 13. Empacotamento e legado

`Dockerfile.manager` multi-stage (node build → rust build → `debian:bookworm-slim` ou `distroless/cc`), volume em `/data` para o SQLite. `Dockerfile`/`railway.sh`/`startup.sh` permanecem para não quebrar quem usa o template; README passa a documentar o Railway Manager e mover o cron para "Legado". ADRs em `docs/adr/` para as decisões 1, 2, 3, 6 e 9.

## Risks / Trade-offs

- [`deploymentRemove` + redeploy depende da retenção de imagem do plano; desligado por muito tempo pode não voltar sem rebuild] → `canRedeploy` verificado no plano; item falha com motivo claro; README explica; spike avalia `deploymentStop`.
- [Semântica de `deploymentStop` não documentada] → não usado por padrão; spike + ADR antes de habilitar.
- [Rate limit baixo no plano Free (100 RPH) esgota com polling] → polling agrupado por ambiente, intervalo com backoff, pausa global em 429, estimativa de custo exibida no plano.
- [Schema do Railway muda sem aviso] → codegen falha no build após atualizar o snapshot; erros de validação em runtime (HTTP 400) classificados e exibidos.
- [Perda de `RM_MASTER_KEY` torna o token indecifrável] → sistema detecta, sinaliza e pede recadastro; o token é recuperável no Railway, então o impacto é só operacional.
- [Processo único / SQLite limita escala horizontal] → aceitável para ferramenta pessoal; repositórios atrás de traits permitem Postgres depois.
- [Reinício no meio de operação deixa estado incerto no Railway] → itens `interrupted` + próxima sincronização mostra o estado real; sem reexecução automática.
- [`activeDeployments` com mais de um deployment (ex.: overlap durante deploy)] → desligar remove todos; o plano lista quantos serão afetados.
- [Exposição pública da UI com token de alto privilégio] → login obrigatório, sem senha padrão, recomendação de workspace token com escopo mínimo.

## Migration Plan

1. Entregar backend + frontend em diretórios novos; nenhum arquivo do cron é alterado.
2. Quem usa o cron continua igual. Para migrar: implantar `Dockerfile.manager` (local ou serviço Railway com volume em `/data`), configurar `RM_MASTER_KEY` e senha, cadastrar token, importar projetos.
3. Rollback: parar o container do Manager; o cron legado não é afetado. O banco SQLite pode ser descartado sem consequência no Railway.
4. Remoção do legado fica para a change de agendamento nativo.

## Open Questions

- Resultado do spike `deploymentStop` (tarefa 2.6) pode trocar o default de `StopMechanism`; isso não altera specs nem tarefas.
- Valores padrão finais de timeouts e intervalo de polling serão calibrados no spike.
