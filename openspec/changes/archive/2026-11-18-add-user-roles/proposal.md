## Why

Hoje o Railway Manager tem um único acesso: uma senha de administrador definida no ambiente. Para usar em equipe com segurança é preciso que cada pessoa tenha o próprio login e só consiga fazer o que o seu papel permite (por exemplo, apenas consultar), além de saber quem executou cada operação. Esta é a ideia 4 de `IDEIAS.md` (múltiplos usuários e papéis).

## What Changes

- Novo cadastro de **usuários comuns** no banco de dados, cada um com nome de usuário, senha armazenada apenas como hash argon2 e um **papel**: `viewer` (somente leitura), `operator` ou `admin`.
- O acesso atual por senha única passa a ser o **usuário master**: continua sendo definido no ambiente (senha em `RM_ADMIN_PASSWORD_HASH`/`RM_ADMIN_PASSWORD`), mas agora com um **nome** definido em nova variável `RM_ADMIN_USERNAME`. O master não existe no banco, tem todas as permissões e é o único que gerencia usuários.
- O login passa a receber `usuário` + `senha`; o limite de tentativas passa a ser por nome de usuário.
- Todas as rotas protegidas passam a checar o papel da sessão (`403` quando insuficiente).
- A sessão passa a identificar quem logou; o histórico registra o **nome do usuário** como solicitante.
- Frontend: campo de usuário no login, tela de gestão de usuários (só master) e controles de escrita ocultos/desabilitados conforme o papel.
- **BREAKING**: `RM_ADMIN_USERNAME` passa a ser obrigatória (o processo recusa iniciar sem ela); `POST /api/session` passa a exigir o campo `username`; sessões existentes são invalidadas na migração.

## Capabilities

### New Capabilities
- `user-management`: cadastro, edição, troca de senha, ativação e remoção de usuários comuns pelo master, e a matriz de permissões por papel.

### Modified Capabilities
- `app-access`: login com usuário + senha, identificação do master por nome vindo do ambiente, sessão associada a um usuário, limite de tentativas por usuário e autorização por papel.
- `operation-audit`: o solicitante registrado passa a ser o nome do usuário autenticado.

## Impact

- Backend: `api/src/auth.rs`, `api/src/routes.rs`, `api/src/lib.rs` (middleware de autorização por papel), `server/src/config.rs` (`RM_ADMIN_USERNAME`), novo repositório e casos de uso de usuários em `application`/`domain`, `infrastructure/src/sqlite` (tabela `users`, coluna de usuário em `sessions`), nova migração.
- Frontend: `Login.tsx`, `api/client.ts`, `Layout.tsx`, nova página de usuários, adaptação de páginas conforme papel.
- Documentação: README (variáveis de ambiente, implantação) e `IDEIAS.md` não precisam mudar além do README.
- Premissa registrada: "paies" no pedido foi interpretado como **papéis** (roles), conforme a ideia 4 de `IDEIAS.md`.
