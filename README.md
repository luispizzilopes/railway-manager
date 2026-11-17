# Railway Manager

Ferramenta para gerenciar vários projetos do [Railway](https://railway.com) num só lugar:
ver o estado de cada serviço em cada ambiente e **desligar ou iniciar** serviços
individualmente, por projeto ou em lote, com plano de execução, confirmação, histórico
auditável e verificação do resultado no próprio Railway.

Um único processo serve a API (Rust) e a interface web (React). Os dados ficam num
arquivo SQLite; o token do Railway é guardado cifrado.

## O que ele faz

- **Projetos**: importa projetos da sua conta (todos os workspaces) ou cadastra pelo
  Railway Project ID. Editar ou remover um projeto aqui **nunca** altera o Railway.
- **Instâncias**: um serviço em um ambiente (ex.: `api` em `production` e `api` em
  `staging` são duas instâncias). Importa as que você escolher; ambientes efêmeros de PR
  ficam separados.
- **Desligar / iniciar**:
  - *Desligar* interrompe todos os deployments ativos da instância (`deploymentRemove`).
    Serviço, volumes, variáveis e configuração permanecem.
  - *Iniciar* cria um novo deployment a partir do último deployment parado, **com a mesma
    imagem** (`deploymentRedeploy` com `usePreviousImageTag: true`), sem rebuild. Se não
    houver deployment reaproveitável, o item falha com o motivo e nada é disparado.
  - Antes de executar, o sistema lê o estado atual e monta um **plano** (o que será
    desligado, iniciado ou ignorado, e por quê). Operações com mais de uma instância exigem
    confirmação; um plano vale 5 minutos e só pode ser executado uma vez.
  - Quem já está no estado desejado, em transição ou aguardando aprovação é ignorado.
    Falha em uma instância não interrompe as demais. Uma instância nunca participa de duas
    operações ao mesmo tempo.
  - Depois de cada mutation o resultado é **verificado** consultando o Railway até o
    estado desejado ou o prazo (`succeeded`, `failed`, `skipped`, `timed_out`).
- **Histórico**: cada instância de cada operação, com estado anterior e final, resultado,
  erro e duração; filtros por projeto, serviço, ambiente, tipo, resultado e período.
  Sobrevive à remoção do projeto do gerenciamento.
- **Visão geral**: indicadores, estados por ambiente com indicação de dado
  **desatualizado** ou **indisponível**, últimas operações e alertas (sem token, token
  recusado, rate limit).

Fora do escopo desta versão: agendamento, criar/excluir projetos ou serviços,
notificações, múltiplas contas, custos.

## Requisitos

- Um token do Railway de **workspace** (recomendado) ou de **conta**. Tokens de projeto
  não servem: valem para um único ambiente e não listam projetos.
- Para rodar localmente: Rust estável recente (testado com 1.100) e Node.js 20+.
- Ou Docker.

## Configuração

Toda a configuração vem de variáveis de ambiente; a lista completa e comentada está em
[`.env.example`](.env.example).

| Variável | Para quê | Padrão |
|---|---|---|
| `RM_ADMIN_PASSWORD_HASH` | Hash argon2 da senha de administrador (produção). Gere com `railway-manager hash-password`. | — |
| `RM_ADMIN_PASSWORD` | Senha em texto claro, só para desenvolvimento. Ignorada se houver hash. | — |
| `RM_MASTER_KEY` | 32 bytes em base64 que cifram o token (`openssl rand -base64 32`). Sem ela o servidor sobe, mas a integração fica inativa. | — |
| `RM_DATABASE_URL` | Arquivo SQLite. | `sqlite://railway-manager.db` |
| `RM_BIND_ADDR` | Endereço HTTP. Sem ele, se `PORT` existir (Railway), usa `0.0.0.0:$PORT`. | `0.0.0.0:8080` |
| `RM_FRONTEND_DIR` | Build do frontend. | `./frontend/dist` |
| `RM_COOKIE_SECURE` | Marca o cookie de sessão como `Secure` (ative atrás de HTTPS). | `false` |
| `RM_SESSION_TTL_SECS` | Duração da sessão. | `43200` |
| `RM_LOGIN_MAX_ATTEMPTS` / `RM_LOGIN_WINDOW_SECS` | Limite de tentativas de login falhas. | `5` / `300` |
| `RM_RAILWAY_RPS` | Requisições por segundo ao Railway (todas as chamadas). | `5` |
| `RM_RAILWAY_CONNECT_TIMEOUT_SECS` / `RM_RAILWAY_REQUEST_TIMEOUT_SECS` | Timeouts das chamadas. | `5` / `20` |
| `RM_RAILWAY_MAX_RETRIES` | Novas tentativas de **consultas** (mutations nunca são repetidas). | `3` |
| `RM_STOP_MECHANISM` | `remove` (`deploymentRemove`) ou `stop` (`deploymentStop`, ver ADR-003). | `remove` |
| `RM_MAX_CONCURRENCY` | Instâncias processadas ao mesmo tempo. | `3` |
| `RM_PLAN_TTL_SECS` | Validade de um plano. | `300` |
| `RM_START_TIMEOUT_SECS` / `RM_STOP_TIMEOUT_SECS` | Prazo para confirmar o resultado. | `600` / `180` |
| `RM_POLL_INTERVAL_SECS` / `RM_POLL_MAX_INTERVAL_SECS` | Polling de verificação (com backoff). | `5` / `15` |
| `RM_STALE_AFTER_SECS` | Idade a partir da qual um estado é "desatualizado". | `300` |
| `RM_LOG` | Filtro de log (`tracing`). | `info` |

O processo **não inicia** sem senha de administrador e recusa valores inválidos
(chave mestra malformada, números fora de faixa) com uma mensagem indicando a variável.

## Rodando localmente

```bash
# 1. Frontend
cd frontend
npm ci
npm run build
cd ..

# 2. Backend (serve a API e o frontend/dist)
cd backend
export RM_ADMIN_PASSWORD=troque-esta-senha
export RM_MASTER_KEY="$(openssl rand -base64 32)"   # guarde este valor!
export RM_FRONTEND_DIR=../frontend/dist
cargo run --release --bin railway-manager
```

Abra <http://localhost:8080>, entre com a senha e cadastre o token em **Configurações**.
Guarde a `RM_MASTER_KEY`: com outra chave o token salvo fica indecifrável e precisa ser
cadastrado de novo (projetos e histórico não se perdem).

Para desenvolver a interface com recarga automática, rode o backend como acima e, em
outro terminal, `cd frontend && npm run dev` (o Vite repassa `/api` para
`localhost:8080`; mude com `RM_BACKEND_URL`).

Senha para produção:

```bash
cd backend
cargo run --release --bin railway-manager -- hash-password   # digite a senha; imprime o hash
export RM_ADMIN_PASSWORD_HASH='$argon2id$v=19$...'
```

## Docker

```bash
docker build -f Dockerfile.manager -t railway-manager .
docker run -d --name railway-manager -p 8080:8080 -v railway-manager-data:/data \
  -e RM_ADMIN_PASSWORD_HASH='$argon2id$v=19$...' \
  -e RM_MASTER_KEY='...' \
  railway-manager
curl http://localhost:8080/healthz   # {"status":"ok"}
```

A imagem roda como usuário não-root e guarda o banco em `/data`
(`RM_DATABASE_URL=sqlite:///data/railway-manager.db`). Para gerar o hash da senha com a
imagem: `docker run --rm -i railway-manager hash-password`.

## Deploy no Railway

1. Crie um serviço a partir deste repositório.
2. Em **Variables**, defina `RAILWAY_DOCKERFILE_PATH=Dockerfile.manager`,
   `RM_ADMIN_PASSWORD_HASH`, `RM_MASTER_KEY` e `RM_COOKIE_SECURE=true`.
3. Adicione um **volume** montado em `/data` (sem ele o banco some a cada deploy).
4. Gere um domínio público e, se quiser, configure o health check em `/healthz`.

O servidor escuta na `PORT` injetada pelo Railway. Ele pode rodar em qualquer projeto
(inclusive num projeto só para ele): os projetos gerenciados vêm do token, não de IDs
fixos. Só existe um processo por banco; não escale para mais de uma réplica.

## Tokens do Railway

- **Workspace** (recomendado): escopo de um workspace; informe o ID do workspace no
  cadastro. Validado com a consulta `workspace(workspaceId)`.
- **Conta**: acesso a todos os workspaces do usuário. Validado com `me`.
- O token é validado antes de ser salvo, cifrado com XChaCha20-Poly1305 e nunca aparece
  em respostas da API, logs ou histórico — só os 4 últimos caracteres.
- Se o Railway recusar o token mais tarde (revogado), ele é marcado como inválido e a
  visão geral avisa.

## Limitações conhecidas

- **Rate limit do Railway** (por plano: Free 100 req/hora; Hobby 1000/hora e 10/s;
  Pro 10000/hora e 50/s). O cliente limita a taxa (`RM_RAILWAY_RPS`), lê os cabeçalhos
  de cota e, em HTTP 429, pausa todas as chamadas pelo tempo de `Retry-After`. No plano
  Free, operações grandes e atualização frequente esgotam a cota rápido; o plano mostra
  quantas mutations serão enviadas, e o polling é agrupado por ambiente.
- **Retenção de imagens**: iniciar reaproveita a imagem do último deployment. Se o
  serviço ficou desligado além da política de retenção do seu plano, o Railway não
  permite reimplantar (`canRedeploy = false`) e o item falha pedindo um novo deploy pelo
  Railway — o Manager não dispara builds.
- **`deploymentStop`**: a documentação do Railway não descreve o estado resultante nem
  como religar depois; por isso o padrão é `deploymentRemove` (ADR-003).
- **Reinício no meio de uma operação**: itens em andamento viram `interrupted` e não são
  reexecutados automaticamente; a próxima sincronização mostra o estado real.
- Um administrador, um token, um processo (SQLite).

## Desenvolvimento

```bash
scripts/check.sh        # fmt, clippy -D warnings, regra de dependências, testes (backend e frontend)
scripts/update-railway-schema.sh   # atualiza o snapshot do schema GraphQL do Railway
```

Estrutura:

```
backend/                 Cargo workspace
  crates/domain          entidades e regras puras (sem I/O)
  crates/application     casos de uso e portas
  crates/infrastructure  Railway (GraphQL validado em compilação), SQLite, criptografia
  crates/api             HTTP (Axum)
  crates/server          binário, configuração e composição
frontend/                React + TypeScript + Vite
docs/adr/                decisões de arquitetura
openspec/                especificação (proposta, design, specs, tarefas)
```

As decisões estão em [`docs/adr/`](docs/adr/README.md).
