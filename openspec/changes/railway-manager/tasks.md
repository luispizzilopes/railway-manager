## 1. Fundação do repositório

- [x] 1.1 Criar Cargo workspace em `backend/` com crates `domain`, `application`, `infrastructure`, `api`, `server`; verificar com `cargo build --workspace` e `cargo tree -p domain` sem `tokio`/`sqlx`/`axum`/`reqwest`
- [x] 1.2 Configurar `rustfmt`, `clippy` (`-D warnings`) e `cargo test` em script `scripts/check.sh`; verificar que o script passa no workspace vazio
- [x] 1.3 Ampliar `.gitignore`/`.dockerignore` (`target/`, `node_modules/`, `dist/`, `*.db`, `.env`) e criar `.env.example` com todas as variáveis `RM_*` documentadas; verificar que `git status` não lista artefatos de build
- [x] 1.4 Criar `docs/adr/` com template e ADR-001 (camadas/crates); verificar presença dos arquivos
- [x] 1.5 Implementar carregamento de configuração no `server` (senha/hash, master key, banco, concorrência, RPS, timeouts, frescor) com validação na inicialização; verificar por teste que ausência de senha ou master key inválida encerra com mensagem clara

## 2. Cliente Railway (infraestrutura)

- [x] 2.1 Adicionar `scripts/update-railway-schema.sh` e versionar `railway.schema.json` obtido por introspecção; verificar que o script regenera o arquivo de forma determinística
- [x] 2.2 Escrever os `.graphql` das operações listadas no design (me, workspace, projects, project, environment.serviceInstances, serviceInstance, deployments, deployment, deploymentRemove, deploymentStop, deploymentRedeploy) com `graphql_client`; verificar que `cargo build` falha ao introduzir um campo inexistente (teste manual documentado no ADR-002)
- [x] 2.3 Implementar transporte `reqwest` (rustls) com timeouts configuráveis, cabeçalho `Authorization: Bearer`, `SecretString` para o token e classificação de erros (HTTP 200 com `errors`, 400, 401/403, 404 lógico, 429, 5xx, rede); verificar com testes `wiremock` para cada classe
- [x] 2.4 Implementar rate limiter (token bucket + leitura de `X-RateLimit-*` + pausa global por `Retry-After`) e retry com backoff/jitter só para queries; verificar por testes que mutations nunca são reenviadas e que 429 bloqueia novas chamadas pelo tempo indicado
- [x] 2.5 Implementar o adaptador `RailwayGateway` com paginação de conexões e mapeamento para tipos do domínio; adicionar teste de guarda que falha se algum `.graphql` contiver mutation fora de `{deploymentRemove, deploymentStop, deploymentRedeploy}`; verificar com `cargo test -p infrastructure`
- [ ] 2.6 Spike em conta real com projeto descartável: medir status após `deploymentRemove` e `deploymentStop`, valores de `deploymentStopped`/`canRedeploy`, comportamento de `deploymentRedeploy(usePreviousImageTag: true)` em cada caso, persistência de volume e tempos típicos; registrar em ADR-003 e definir default de `StopMechanism`; verificar com o ADR revisado
- [x] 2.7 Teste de logs: capturar `tracing` durante chamadas e verificar que token e cabeçalho de autorização nunca aparecem

## 3. Domínio

- [x] 3.1 Modelar entidades e value objects (IDs Railway validados, Project, Environment, Service, ServiceInstance, Credential metadata, Operation, OperationItem, Plan) com invariantes; verificar com testes unitários de construção inválida
- [x] 3.2 Implementar a função pura de estado observado e o cálculo de frescor; verificar com teste de tabela cobrindo todos os valores de `DeploymentStatus` e combinações de deployments ativos
- [x] 3.3 Implementar a decisão de ação por instância (`will_stop`/`will_start`/`will_skip` com motivo, incluindo sleeping, transição, aprovação, sem deployment reaproveitável); verificar com testes unitários por cenário da spec `service-power-control`
- [x] 3.4 Implementar a máquina de estados de `OperationItem` e o agregado do resultado da operação (`succeeded`/`partially_failed`/`failed`); verificar que transições inválidas são rejeitadas em teste

## 4. Persistência (SQLite)

- [x] 4.1 Criar migrações SQLx do modelo do design, incluindo FKs, `UNIQUE`s e índice único parcial de itens ativos; verificar com `sqlx migrate run` em banco novo e teste que `PRAGMA foreign_keys` está ativo
- [x] 4.2 Implementar repositórios (credenciais, projetos, inventário, planos, operações, histórico com filtros e paginação, sessões); verificar com testes de integração em SQLite em memória, incluindo duplicidade → erro de conflito e cascatas
- [x] 4.3 Implementar consumo atômico de plano e inserção de itens com detecção de conflito; verificar com teste concorrente (duas tasks consumindo o mesmo plano → apenas uma vence)
- [x] 4.4 Implementar a rotina de inicialização que marca itens não finalizados como `interrupted`; verificar com teste que libera o índice de conflito

## 5. Credenciais e acesso

- [x] 5.1 Implementar `CredentialCipher` com XChaCha20-Poly1305 (AAD = id, `key_version`); verificar por testes de round-trip, chave errada → erro "indecifrável" e ausência do token em texto claro no arquivo do banco
- [x] 5.2 Casos de uso cadastrar/validar/substituir/remover credencial (account via `me`, workspace via `workspace`, rejeição de token de projeto) e marcação de inválida em falha de autenticação; verificar com gateway fake
- [x] 5.3 Implementar login (argon2), sessão por cookie (`HttpOnly`, `SameSite=Strict`, `Secure` configurável), logout, rate limit de tentativas e comando `hash-password`; verificar com testes HTTP (401 sem sessão, 429 após excesso, logout invalida)

## 6. Projetos e inventário (casos de uso + API)

- [x] 6.1 Casos de uso de projetos: descobrir (todas as páginas e workspaces, marcando já gerenciados), cadastrar manual, importar em lote, editar local, remover (recusa com operação ativa) e sincronizar (`ok`/`failed`/`not_found`); verificar com testes usando gateway fake
- [x] 6.2 Casos de uso de inventário: listar ambientes e instâncias do Railway, importar seletivamente, associar manual (validando pertencimento ao projeto), remover associação, sincronizar estados agrupando por ambiente; verificar com testes usando gateway fake
- [x] 6.3 Expor rotas Axum de credencial, descoberta, projetos e instâncias com validação de entrada e `AppError` central; verificar com testes de integração HTTP (inclui garantia de que nenhuma resposta contém o token)

## 7. Controle de energia

- [x] 7.1 Caso de uso `PlanPowerOperation` (escopos instância/projeto com filtro de ambiente/lote multi-projeto; lê estado atual; persiste plano com validade); verificar com testes para cada escopo e para itens ignorados com motivo
- [x] 7.2 Caso de uso `ExecutePowerOperation` com semáforo de concorrência, pré-condição relida, mutation conforme `StopMechanism`, isolamento de falhas e tratamento de "resultado incerto" em timeout de mutation; verificar com gateway fake programável (falha em 1 de 5, limite de concorrência respeitado medido por contador)
- [x] 7.3 Verificador de estado pós-operação (polling agrupado por ambiente, backoff, timeouts de start/stop, `succeeded`/`failed`/`timed_out`) atualizando `service_instances`; verificar com `tokio::time::pause` e gateway fake simulando transições
- [x] 7.4 Rotas `/api/operations/plan`, `/api/operations`, `/api/operations/{id}` (400 sem plano, 410 expirado, 409 reutilizado/conflito, 202 com id); verificar com testes HTTP
- [x] 7.5 Teste de integração ponta a ponta com servidor `wiremock` simulando o Railway: desligar projeto com 3 instâncias (1 já parada), iniciar de volta, e conferir chamadas exatas enviadas, histórico e estados finais

## 8. Histórico e dashboard (backend)

- [x] 8.1 Rota `/api/history` com filtros combináveis, período validado e paginação; verificar com testes de integração sobre dados semeados
- [x] 8.2 Rota `/api/dashboard` com indicadores, projetos/instâncias por ambiente, frescor, últimas operações e alertas (sem credencial, inválida, rate limit); verificar com teste de integração para o cenário de contagens da spec

## 9. Frontend

- [x] 9.1 Criar `frontend/` (Vite + React + TS, `react-router`, `@tanstack/react-query`), cliente HTTP tipado e tokens de design (claro/escuro); verificar com `npm run build` e `npm run typecheck`
- [x] 9.2 Telas de login e configurações de credencial (cadastro, máscara, substituir, remover, estado de validação); verificar manualmente e com teste de componente que o valor do token não é mantido após envio
- [x] 9.3 Dashboard: indicadores, lista de projetos com instâncias por ambiente, chips de estado e frescor, atualização manual/automática e ações rápidas; verificar com testes de componente para estados `stale`/`unavailable`
- [x] 9.4 Projeto, descoberta e importação (projetos e instâncias), associação manual e remoção local com confirmação; verificar com testes de componente dos formulários e validações
- [x] 9.5 Fluxo de operação: modal de plano (afetados/ignorados com motivo), confirmação, progresso por item e resumo agrupado por projeto; seleção múltipla de projetos para lote; verificar com teste de componente que nada é enviado sem confirmação
- [x] 9.6 Tela de histórico com filtros (projeto, serviço, ambiente, tipo, resultado, período) e paginação; verificar com teste de componente dos filtros na querystring
- [x] 9.7 Servir `frontend/dist` pelo Axum com fallback SPA; verificar com teste HTTP que `/` e rotas internas retornam `index.html` e `/api/*` não

## 10. Empacotamento, documentação e verificação final

- [ ] 10.1 `Dockerfile.manager` multi-stage com volume `/data` e usuário não-root; verificar com `docker build` e `docker run` respondendo `/healthz`
- [x] 10.2 Reescrever `README.md` (o que é, requisitos, variáveis, instalação local e Docker, deploy no Railway, tipos de token recomendados, limitações da API e de retenção de imagem, seção "Legado: railway-service-cron") e concluir ADRs 002, 004 (fluxo plano/execução) e 005 (credenciais); verificar seguindo o README do zero em diretório limpo
- [x] 10.3 Executar `scripts/check.sh` (fmt, clippy, testes backend) e testes/build do frontend; verificar que tudo passa
- [ ] 10.4 Validação manual contra conta real (projeto descartável): cadastrar token, importar, desligar/iniciar individual, por projeto e em lote, conferir histórico e dashboard; registrar resultado no PR
