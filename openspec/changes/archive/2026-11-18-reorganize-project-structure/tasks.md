## 1. Linha de base

- [x] 1.1 Garantir árvore limpa e rodar `scripts/check.sh`; registrar que passa antes de mover qualquer arquivo
- [x] 1.2 Listar os caminhos citados em `docs/`, `README.md`, `scripts/` e nas changes ativas, para atualizar ao final (`rg` por `pages/`, `routes.rs`, `testkit`)

## 2. Frontend: base compartilhada

- [x] 2.1 Adicionar alias `@/` → `src/` em `tsconfig.app.json` e `vite.config.ts`; verificar com `npm run typecheck` e `npm run test`
- [x] 2.2 Mover `api/` para `shared/api/`, `components/ui/` para `shared/ui/`, componentes genéricos (Brand, Icon, Modal, StateChip, ThemeToggle, CommandPalette, OperationFlow, useFeedbackMutation) para `shared/components/`, e `format.ts`, `mobile.ts`, `theme.ts` (+ teste) para `shared/lib/`; ajustar imports e verificar typecheck e testes
- [x] 2.3 Manter `test/` na raiz de `src/` com imports atualizados; verificar que `npm run test` passa

## 3. Frontend: features

- [x] 3.1 Criar `features/auth/` com Login, ModeChooser, `session.ts` e `mode.ts`; verificar typecheck e testes
- [x] 3.2 Criar `features/dashboard/`, `features/history/`, `features/users/` e `features/settings/` movendo cada tela com seu teste; verificar typecheck e testes
- [x] 3.3 Criar `features/projects/` (Projects, ProjectDetail e testes) e `features/schedules/` (Schedules e teste); verificar typecheck e testes
- [x] 3.4 Mover `Logs.tsx` e seu teste para `features/logs/`; mover `CliApp.tsx` e `ConsolePage.tsx` para `features/console/`; ajustar o caminho de `../docs/console.md` em `docs.test.ts` e confirmar `fs.allow`; verificar testes
- [x] 3.5 Mover `App.tsx`, `main.tsx`, `Layout.tsx` (+ testes) para `app/` e atualizar o `<script>` de `index.html`; distribuir `forms.test.tsx` e `roles.test.tsx` na feature correspondente ou em `app/`; verificar `npm run build` e testes

## 4. Frontend: CSS por feature

- [x] 4.1 Dividir `styles/pages.css` em arquivos por feature ao lado dos componentes, em `@layer pages`; mover `console.css` e `logs.css` para suas features; manter `styles/index.css` só com camadas, tokens e base
- [x] 4.2 Verificar `npm run build` e `contrast.test.ts`, e comparar visualmente Dashboard, Projetos, Agendas, Logs e Console (claro/escuro, desktop/mobile) com a versão anterior

## 5. Backend `api`: rotas por assunto

- [x] 5.1 Criar `routes/` com `mod.rs` e `util.rs` (helpers `id`, `parse`, `date`, `non_empty`) e mover os handlers de sessão, credencial e projetos; verificar `cargo build -p api`
- [x] 5.2 Mover inventário, operações, histórico, logs e dashboard para seus módulos; verificar `cargo test -p api -p server`
- [x] 5.3 Mover agendas, ações agendadas e usuários; remover `routes.rs`; verificar `cargo clippy --workspace --all-targets -- -D warnings` e que nenhum arquivo de `routes/` passa de ~400 linhas

## 6. Backend `domain` e `application`

- [x] 6.1 Agrupar módulos de `domain` em subpastas por contexto com `pub use` mantendo os caminhos antigos; verificar `cargo test --workspace` e a checagem de dependências do domínio em `scripts/check.sh`
- [x] 6.2 Agrupar módulos de `application` da mesma forma; verificar `cargo test --workspace` sem mudar imports em `api`, `infrastructure`, `server` e testes
- [x] 6.3 Converter `testkit.rs` em `testing/` com um arquivo por porta e reexportação em `testing/mod.rs`; verificar `cargo test --workspace`

## 7. Documentação e fechamento

- [x] 7.1 Atualizar `docs/adr/001-camadas-e-crates.md` (ou criar ADR novo) e `README.md` com a nova estrutura de pastas do backend e do frontend
- [x] 7.2 Atualizar caminhos citados em `docs/`, `scripts/`, `Dockerfile.manager` e nas changes ativas levantados em 1.2; verificar com `rg` que não restam referências a caminhos antigos
- [x] 7.3 Rodar `scripts/check.sh` completo (passou) e `git diff --stat -M` mostra apenas movimentações e ajustes de import/caminho. `docker build` não foi executado: o daemon do Docker estava desligado; a imagem só copia `frontend/` e `backend/`, cujos builds passaram no `check.sh`
