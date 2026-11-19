## Context

Autenticação atual (`api/src/auth.rs`): uma senha única (`AdminPassword`, argon2 ou texto claro em dev), um `LoginLimiter` global, sessões opacas em `sessions(id_hash, created_at, expires_at)` e o middleware `require_session`, que só verifica se a sessão existe. A coluna `operations.requested_by` já existe. Ver `proposal.md` para a motivação e `specs/` para o contrato.

## Goals / Non-Goals

**Goals:**
- Master definido no ambiente (nome + senha) e usuários comuns no SQLite com hash argon2.
- Autorização por papel imposta no backend; o frontend apenas reflete o papel.
- Mudanças de papel/estado/senha valem de imediato.

**Non-Goals:**
- Auto-cadastro, recuperação de senha por e-mail, SSO/OIDC, 2FA.
- Permissões por projeto (papéis são globais).
- Papéis customizáveis (conjunto fixo de três).
- Trocar a própria senha pelo usuário comum (só o master redefine); pode vir depois.

## Decisions

**1. Sessão aponta para o usuário; master é `user_id` nulo.** Migração adiciona `sessions.user_id TEXT NULL REFERENCES users(id) ON DELETE CASCADE` e apaga as sessões existentes. Master = `user_id IS NULL`, nome vindo da config. Em cada requisição o middleware resolve `Principal { username, role }` com um join `sessions → users` (e lê `is_active`). Isso dá efeito imediato ao rebaixar, desativar ou remover (CASCADE derruba as sessões) sem cache a invalidar. *Alternativa:* gravar o papel na sessão — descartada, ficaria desatualizado.

**2. Tabela `users`.** `id` (uuid), `username`, `username_key` (minúsculo, `UNIQUE`), `password_hash`, `role CHECK IN ('viewer','operator','admin')`, `is_active`, `created_at`, `updated_at`. O papel `master` não é gravável no banco (CHECK), o que impede escalonar via API. Conflito com o nome do master é validado no caso de uso (a config é injetada).

**3. Autorização por papel em uma tabela única, negada por padrão.** `api::permissions::ROUTES` lista `(método, caminho, papel mínimo)`; o middleware `require_session` resolve o `Principal` (colocado nas extensions) e compara com `required_role`. Rota sem entrada na tabela só serve ao master, então uma rota nova esquecida falha fechada. Um teste de integração percorre a tabela com um usuário de cada papel e confere `403`/não-`403`. *Alternativa:* `route_layer` por grupo ou extractor por handler — espalham a decisão e é fácil esquecer.

**4. Domínio.** `domain::user::{Role, Username}` com `Role: Ord` (`Viewer < Operator < Admin < Master`) e `Role::allows(min)`. `application::users` com `UserRepository` (porta), validação (senha ≥ 8, nome 3–32 caracteres `[a-z0-9._-]` normalizado) e hash via porta `PasswordHasher` para manter o argon2 na infraestrutura/API, como hoje.

**5. Login.** `POST /api/session {username, password}`. Se `username` (case-insensitive) == nome do master → compara com `AdminPassword`; senão busca em `users`. Usuário inexistente executa verificação contra um hash fictício para igualar o tempo de resposta. Erro genérico idêntico nos casos de falha. `GET /api/session` passa a devolver `{authenticated, username, role}`.

**6. Limite de tentativas por usuário.** `LoginLimiter` vira um mapa `username_key → janela` (com limpeza de entradas vencidas e teto de chaves para não crescer sem limite com nomes aleatórios; acima do teto, nomes desconhecidos compartilham um balde). Mantém `429` + `Retry-After`.

**7. Auditoria.** O `requested_by` das operações manuais passa a receber `Principal.username` (hoje valor fixo). Não há FK para `users`, então o nome fica preservado após remoção do usuário. Operações de agenda continuam com o solicitante de sistema atual.

**8. Config.** `RM_ADMIN_USERNAME` obrigatória, não vazia, validada como nome de usuário. Mensagem de erro de inicialização cita a variável. README atualizado.

**9. Frontend.** `api.session()` carrega `role`; um contexto `useSession` expõe `can(permission)`. Botões de escrita ficam ocultos/desabilitados conforme o papel (a UI não é a barreira de segurança). Nova página "Usuários" visível só ao master (CRUD + redefinir senha). O `401` continua levando ao login; o `403` mostra mensagem de permissão.

## Risks / Trade-offs

- [Deploy existente quebra sem `RM_ADMIN_USERNAME`] → falha de inicialização com mensagem clara e nota **BREAKING** no README.
- [Todas as sessões são invalidadas na migração] → aceitável; é preciso logar de novo uma vez.
- [Join de sessão a cada requisição] → índice na PK de `sessions` e em `users.id`; volume é pequeno (ferramenta de equipe).
- [Rota nova sem nível de permissão] → teste de cobertura da tabela de rotas.
- [Limiter em memória é perdido no restart e é por processo] → mesmo comportamento atual, aceito.
- [Master é ponto único para gerir usuários] → intencional; recuperação é trocar a senha no ambiente.

## Migration Plan

1. Migração SQL: cria `users`, apaga `sessions` e adiciona `sessions.user_id`.
2. Deploy com `RM_ADMIN_USERNAME` definida; todos precisam logar novamente.
3. Rollback: voltar a versão anterior ignora a nova tabela; a coluna extra em `sessions` é inofensiva para o código antigo (a migração só adiciona).
