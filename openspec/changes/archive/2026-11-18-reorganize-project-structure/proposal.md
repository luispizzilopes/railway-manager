## Why

Os diretórios do projeto cresceram sem agrupamento por assunto. No frontend, `src/pages/` mistura 10+ telas, testes, formulários e utilitários; `src/` tem arquivos soltos (`session.ts`, `mode.ts`, `mobile.ts`, `format.ts`, `theme.ts`) e `styles/pages.css` concentra ~900 linhas de todas as telas. No backend, `api/src/routes.rs` (~1100 linhas) reúne todos os handlers e DTOs, e as crates `domain` e `application` listam de 10 a 15 módulos no mesmo nível. Isso dificulta achar código, revisar diffs e evoluir uma funcionalidade sem esbarrar nas demais.

## What Changes

- **Frontend**: reorganizar `frontend/src/` em `app/` (bootstrap, rotas, providers), `features/<assunto>/` (tela, componentes, hooks, testes e CSS de cada funcionalidade), `shared/` (cliente de API, componentes de UI, utilitários, tema) e `test/`.
- **Frontend**: quebrar `styles/pages.css` em CSS por feature, ao lado do componente; `styles/` mantém só tokens, base e a ordem de camadas.
- **Backend `api`**: dividir `routes.rs` em um módulo por assunto (`routes/session.rs`, `routes/projects.rs`, `routes/schedules.rs`, ...), cada um com seus handlers e DTOs, e um `routes/mod.rs` que só monta o `Router`.
- **Backend `domain` e `application`**: agrupar módulos em subpastas por contexto (ex.: agendamento, operações/energia, catálogo/inventário, acesso), mantendo as estruturas públicas acessíveis por reexportação para limitar o impacto nos chamadores.
- **Backend `application`**: mover `testkit.rs` (~950 linhas) para um módulo `testing/` dividido em fakes por porta.
- Atualizar referências em `Dockerfile.manager`, `scripts/check.sh`, `docs/` e `README.md` quando apontarem para caminhos movidos.
- Nenhuma mudança de comportamento, de API HTTP, de esquema de banco ou de aparência.

## Capabilities

### New Capabilities
<!-- Nenhuma: refatoração estrutural sem mudança de comportamento. -->

### Modified Capabilities
<!-- Nenhuma: nenhum requisito de spec muda. A change usa `skip_specs: true`. -->

## Impact

- **Código movido**: quase todo `frontend/src/` (imports relativos reescritos), `backend/crates/api/src/routes.rs`, módulos de `domain` e `application`, `application/src/testkit.rs`.
- **Sem impacto externo**: rotas HTTP, JSON, migrations, variáveis `RM_*` e a imagem Docker permanecem iguais.
- **Changes ativas**: `add-service-logs`, `command-console`, `redesign-frontend-ui` e `add-user-roles` têm tarefas ou arquivos que citam caminhos atuais; os caminhos citados nelas podem ficar desatualizados após a movimentação (ver `design.md`).
- **Validação**: `scripts/check.sh` (fmt, clippy, regra de dependência do domínio, testes Rust, typecheck, testes e build do frontend) deve passar antes e depois, sem alterar testes além de caminhos de import.
