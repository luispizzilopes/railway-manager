## Why

O `railway-service-cron` hoje é um container Alpine com `supercronic` que executa `railway.sh start|stop` em horários fixos, para uma lista de `SERVICES_ID` de **um único projeto e ambiente** (os IDs vêm de `RAILWAY_PROJECT_ID`/`RAILWAY_ENVIRONMENT_ID`, injetados porque o container precisa rodar *dentro* do projeto gerenciado). Não há interface, histórico, estado consultável, controle por projeto, múltiplos projetos, nem tratamento de erros além de `echo`. A necessidade agora é uma ferramenta central — **Railway Manager** — que gerencie vários projetos, ambientes e serviços, com operações manuais confiáveis e auditáveis, e uma base preparada para recuperar o agendamento de forma mais robusta no futuro.

## What Changes

- Novo backend em **Rust** (Tokio, Axum, Reqwest, Serde, SQLx/SQLite), organizado em camadas Domain / Application / Infrastructure / Presentation, como Cargo workspace em `backend/`.
- Novo frontend **React + TypeScript + Vite** em `frontend/`, servido pelo próprio backend (um único processo/container).
- Cliente GraphQL do Railway em Rust, com queries/mutations **validadas em tempo de compilação** contra um snapshot do schema oficial (`backboard.railway.com/graphql/v2`, obtido por introspecção).
- Cadastro seguro de token Railway (account ou workspace), criptografado em repouso, nunca devolvido pela API.
- Cadastro/importação de projetos, ambientes e serviços; o modelo distingue *serviço* de *instância de serviço* (serviço × ambiente), refletindo o modelo real do Railway.
- Controle de energia (desligar/iniciar) individual, por projeto e em lote multi-projeto, com plano de execução + confirmação, idempotência (pula quem já está no estado desejado), isolamento de falhas, concorrência limitada, bloqueio contra operações conflitantes e verificação de estado pós-operação consultando o Railway.
- Histórico de operações (auditoria) com filtros.
- Dashboard com indicadores e estados (incluindo "desatualizado"/"indisponível").
- Proteção de acesso à própria aplicação (senha de administrador), já que ela detém um token capaz de desligar infraestrutura.
- A lógica de start/stop do `railway.sh` é **portada** para o domínio Rust (mesmas regras: checar estado antes de agir, `deploymentRemove` para desligar, `deploymentRedeploy(usePreviousImageTag: true)` para iniciar), corrigindo suas limitações (só olha o último deployment, sem verificação, sem tratamento de erro).
- O `Dockerfile`, `railway.sh` e `startup.sh` atuais **permanecem intactos** nesta entrega (o template público do Railway aponta para eles). Eles ficam marcados como legado no README e serão removidos quando o agendamento nativo existir.
- Fora de escopo: criar/excluir projetos, serviços ou volumes; agendamento; notificações; múltiplas contas; custos.

## Capabilities

### New Capabilities
- `app-access`: proteção de acesso à interface e à API do Railway Manager (login de administrador, sessão).
- `railway-credentials`: cadastro, validação, substituição e remoção do token Railway, com armazenamento cifrado e não-exposição.
- `railway-api-integration`: comportamento da integração com a API pública do Railway — timeouts, rate limit, classificação de erros, indisponibilidade e restrição a operações não destrutivas.
- `project-management`: cadastro manual, descoberta, importação, edição, sincronização e remoção local de projetos.
- `service-inventory`: ambientes, serviços e instâncias de serviço (serviço × ambiente) — importação, associação manual, sincronização, remoção local e estado observado.
- `service-power-control`: desligar/iniciar instâncias individualmente, por projeto e em lote, com plano, confirmação, idempotência, concorrência, conflitos e verificação.
- `operation-audit`: registro persistente de cada operação e consulta filtrada do histórico.
- `dashboard`: visão geral com indicadores, projetos, serviços, estados, frescor dos dados e ações rápidas.

### Modified Capabilities
<!-- Nenhuma: o repositório não possui specs OpenSpec prévias. -->

## Impact

- **Código novo**: `backend/` (Cargo workspace), `frontend/` (Vite), `Dockerfile.manager`, `.env.example`, `docs/adr/`.
- **Código existente**: `Dockerfile`, `railway.sh`, `startup.sh` inalterados; `README.md` reescrito (Railway Manager + seção legado); `.gitignore` e `.dockerignore` ampliados (`target/`, `node_modules/`, `dist/`, `*.db`).
- **Dependências**: toolchain Rust estável, Node 20+ para build do frontend; crates `tokio`, `axum`, `tower-http`, `reqwest` (rustls), `serde`, `sqlx` (sqlite), `graphql_client`, `chacha20poly1305`/`aes-gcm`, `argon2`, `tracing`; frontend `react`, `react-router`, `@tanstack/react-query`.
- **API externa**: Railway Public API (`https://backboard.railway.com/graphql/v2`), sujeita a rate limit por plano (Free 100 RPH; Hobby 1000 RPH/10 RPS; Pro 10000 RPH/50 RPS).
- **Configuração nova**: `RM_ADMIN_PASSWORD` (ou hash), `RM_MASTER_KEY`, `RM_DATABASE_URL`, `RM_MAX_CONCURRENCY`, timeouts. Nenhum ID de projeto/serviço/ambiente fixo.
