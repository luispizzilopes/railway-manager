## 1. Domínio e persistência

- [x] 1.1 Criar `domain::user` (`Role` ordenável com `allows`, `Username` normalizado e validado) com testes unitários de ordenação, normalização e rejeição de nomes inválidos
- [x] 1.2 Migração SQL com tabela `users` (CHECK de papel sem `master`, `username_key` único), `sessions.user_id` com `ON DELETE CASCADE` e limpeza das sessões existentes; verificar no teste `migrations.rs`
- [x] 1.3 Porta `UserRepository` e implementação SQLite (criar, listar, buscar por nome, atualizar papel/estado/hash, remover) com testes em `infrastructure/tests`, incluindo conflito de nome sem diferenciar maiúsculas

## 2. Aplicação

- [x] 2.1 Caso de uso `application::users` (criar, listar, editar, redefinir senha, remover) com validação de senha ≥ 8 e conflito com o nome do master, e teste com repositório em memória (`testkit`)
- [x] 2.2 Estender `SessionRepository` para gravar `user_id` e resolver `Principal` (nome, papel, ativo) em uma consulta; testar que usuário desativado/removido e papel alterado têm efeito imediato

## 3. Configuração e autenticação

- [x] 3.1 Ler `RM_ADMIN_USERNAME` em `server/src/config.rs` (obrigatória, validada) e testar a falha de inicialização sem ela
- [x] 3.2 Refatorar `api/src/auth.rs`: login por `username` + senha (master do ambiente ou usuário do banco, verificação fictícia para nome inexistente, erro genérico) e `GET /api/session` devolvendo `username` e `role`; testes em `server/tests/http.rs`
- [x] 3.3 Trocar `LoginLimiter` por limite por nome de usuário com teto de chaves e verificar `429`/`Retry-After` por usuário nos testes unitários

## 4. Autorização por papel

- [x] 4.1 Implementar `require_role` e inserir `Principal` nas extensions; agrupar as rotas de `api/src/lib.rs` por nível (viewer/operator/admin/master) conforme a matriz da spec
- [x] 4.2 Teste que percorre todas as rotas protegidas e verifica `403` para papel insuficiente e sucesso para o papel mínimo, e falha se alguma rota não tiver nível declarado
- [x] 4.3 Passar `Principal.username` como `requested_by` nas operações manuais e verificar no histórico (`server/tests/power.rs`) e que o nome permanece após remover o usuário

## 5. API de usuários

- [x] 5.1 Rotas `GET/POST /api/users`, `PATCH/DELETE /api/users/{id}` e `POST /api/users/{id}/password`, só master, sem expor hash; testes de `server/tests` cobrindo criação, duplicado (`409`), validação (`400`) e `403` para admin

## 6. Frontend

- [x] 6.1 Atualizar `api/client.ts` e `Login.tsx` para usuário + senha e para o novo retorno de `session()`; ajustar testes de `App.test.tsx`
- [x] 6.2 Contexto `useSession` com `can(permission)` e ocultar/desabilitar ações de escrita em Dashboard, Projetos, Agendas, Console e Configurações conforme o papel, com testes por papel
- [x] 6.3 Página "Usuários" (listar, criar, editar papel/estado, redefinir senha, remover), visível só ao master, com testes de componente; tratar `403` com mensagem de permissão

## 7. Documentação

- [x] 7.1 Atualizar o README (variável `RM_ADMIN_USERNAME`, papéis e permissões, nota de **BREAKING**, passos de implantação) e conferir que `cargo test`, `cargo clippy` e os testes do frontend passam
