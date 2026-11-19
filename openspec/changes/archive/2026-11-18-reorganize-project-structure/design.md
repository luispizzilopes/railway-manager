## Context

Veja `proposal.md` para a motivação. Estado atual relevante:

- Frontend (Vite + React + TS, `moduleResolution: bundler`): sem alias de path; imports são relativos. `src/logs/` e `src/console/` já são organizados por feature, `src/components/ui/` já tem CSS ao lado do componente. `styles/index.css` define `@layer reset, tokens, base, components, pages, utilities` e importa `pages.css`, `console.css`, `logs.css` na camada `pages`. O teste `console/docs.test.ts` lê `../docs/console.md` (liberado em `vite.config.ts`).
- Backend (workspace Rust com crates `domain`, `application`, `infrastructure`, `api`, `server`, ver ADR-001): `domain` não pode depender de crates de I/O (verificado em `scripts/check.sh`). `infrastructure/src/sqlite/` e `railway/` já estão em subpastas. Os testes de integração ficam em `crates/*/tests/*.rs` (cada arquivo é um binário de teste).
- Outras changes em andamento (`add-service-logs`, `command-console`, `redesign-frontend-ui`) ainda citam caminhos atuais.

## Goals / Non-Goals

**Goals:**
- Cada pasta responde a um único assunto; nenhum arquivo de código passa de ~500 linhas sem motivo.
- Mover primeiro, sem alterar lógica: diffs de `git mv` com histórico preservado.
- `scripts/check.sh` verde ao fim de cada grupo de tarefas.

**Non-Goals:**
- Mudar comportamento, nomes públicos de tipos/funções, rotas, JSON, SQL ou visual.
- Renomear crates ou mudar a regra de dependência entre camadas.
- Reescrever `schedule.rs`, `power.rs` etc. por dentro; só mudar onde ficam.
- Introduzir novas bibliotecas (ex.: gerenciador de estado, framework de CSS).

## Decisions

**1. Frontend por feature, com `shared/` e `app/`.**
Estrutura alvo:

```
src/
  app/        main.tsx, App.tsx, providers, rotas, Layout
  features/
    auth/       Login, ModeChooser, session, mode
    dashboard/  Dashboard (+ teste, css)
    projects/   Projects, ProjectDetail, formulários
    schedules/  Schedules
    history/    History
    logs/       (já existe; recebe Logs.tsx de pages/)
    console/    (já existe; recebe CliApp, ConsolePage)
    users/      Users
    settings/   Settings
  shared/
    api/        client, types
    ui/         Button, Dialog, Field, Table, Tabs, Toast, ... (hoje components/ui)
    components/ Brand, Icon, Modal, StateChip, ThemeToggle, CommandPalette, OperationFlow, useFeedbackMutation
    lib/        format, mobile, theme
  styles/     tokens.css, base.css, index.css
  test/       fixtures, setup, utils
```

Testes ficam ao lado do código que testam. Testes que cruzam telas (`forms.test.tsx`, `roles.test.tsx`) vão para a feature dominante ou para `app/`, conforme o que exercitam.
*Alternativas:* manter `pages/` e só extrair subpastas (resolve pouco: o acoplamento por tipo continua); organizar por tipo técnico (`hooks/`, `components/`), o que espalha uma funcionalidade por várias pastas.

**2. Alias `@/` para `src/`.**
Adicionar `paths` no `tsconfig.app.json` e `resolve.alias` no `vite.config.ts` (e equivalente no vitest, que reutiliza o config). Imports entre features e para `shared/` usam `@/…`; imports dentro da mesma feature continuam relativos. Evita cadeias `../../../` após o aninhamento.
*Alternativa:* só imports relativos; mais simples, porém frágeis a novas movimentações.

**3. CSS junto da feature, ordem de camadas preservada.**
`pages.css` é dividido em um `.css` por feature, importado pelo componente raiz da feature e declarado em `@layer pages { ... }` (ou importado com `layer(pages)`) para manter a precedência atual. `styles/index.css` mantém a declaração `@layer` e importa tokens e base. Seletores e valores não mudam; a divisão segue os blocos já existentes em `pages.css`.
*Risco ligado:* a ordem de importação do CSS no bundle pode mudar a cascata; mitigado pelas camadas explícitas.

**4. `routes.rs` vira o módulo `routes/` com um arquivo por assunto.**
`routes/{mod,session,credentials,projects,inventory,operations,history,logs,dashboard,schedules,scheduled_actions,users}.rs`. DTOs e conversores privados (`schedule_spec`, `plan_dto`, `UserDto`, ...) ficam no arquivo do seu assunto; helpers comuns (`id`, `parse`, `date`, `non_empty`) vão para `routes/util.rs`. `mod.rs` reexporta os handlers usados por `lib.rs`, de modo que `build_router` mude pouco.

**5. `domain` e `application` agrupados por contexto, com reexportação.**
Subpastas por contexto (nomes finais a confirmar ao aplicar, a partir do que cada módulo importa de fato):

| Contexto | `domain` | `application` |
|---|---|---|
| operations | `operation`, `power`, `state`, `deployment` | `power`, `history` |
| scheduling | `schedule`, `scheduled_action` | `schedules`, `scheduled_actions` |
| catalog | `catalog`, `ids`, `logs` | `projects`, `inventory`, `dashboard`, `logs`, `railway` |
| access | `credential`, `user` | `credentials`, `users` |

`lib.rs` mantém `pub use` dos módulos movidos com os caminhos antigos (`domain::schedule`, `application::power`, ...). Assim `api`, `infrastructure`, `server` e os testes não mudam de import, e a regra de dependência do domínio segue intacta. Reduzir os reexports para caminhos novos fica como evolução opcional.
*Alternativa:* reescrever todos os `use` para os novos caminhos; diff muito maior sem ganho de comportamento.

**6. `testkit.rs` → `testing/` por porta.**
Dividir os fakes em `testing/{mod,clock,credentials,projects,inventory,operations,schedules,railway,users}.rs`, mantendo a mesma gate de compilação atual (feature/`cfg` de `lib.rs:15`). `testing::*` reexporta tudo, então os testes continuam usando o mesmo nome.

**7. Testes de integração permanecem planos.**
Cada `tests/*.rs` é um binário de teste do Cargo; agrupá-los em subpastas exigiria arquivos-ponte sem ganho claro. Só ficam como estão (já agrupados por assunto pelo nome).

**8. Ordem de execução:** (a) frontend `shared/` + alias, (b) features uma a uma, (c) CSS, (d) `routes/`, (e) `domain`/`application`, (f) `testing/`, (g) docs e referências. Um commit por grupo.

## Ajustes feitos na aplicação

- **CSS**: `pages.css` foi dividido em arquivos ao lado de cada tela/componente, mas todos continuam importados em `styles/index.css`, na ordem original, em vez de cada componente importar o seu. Isso preserva a cascata byte a byte (o CSS compilado tem o mesmo hash de antes).
- **`testkit`**: o módulo manteve o nome (`testkit/`, com `railway`, `clock` e `users`), porque é nome de feature do Cargo usado por outras crates.
- **`domain`/`application`**: grupos `access`, `operations`, `scheduling` (e `catalog` só na `application`); `ids`, `catalog` e `logs` do domínio e `error`, `ports`, `railway` da aplicação ficam na raiz.

## Risks / Trade-offs

- [Conflito com changes em andamento (`add-service-logs`, `command-console`, `redesign-frontend-ui`, `add-user-roles`)] → aplicar com a árvore limpa e sem outro trabalho aberto; ao final, atualizar caminhos citados nos artefatos dessas changes ou anotar o mapeamento antigo→novo.
- [Cascata de CSS muda ao dividir `pages.css`] → manter tudo em `@layer pages`, preservar a ordem de importação e comparar visualmente as telas principais (claro/escuro, mobile).
- [Quebra de imports em massa] → mover por grupo, rodar `npm run typecheck` e testes a cada grupo; usar `git mv` para manter histórico.
- [Teste `docs.test.ts` depende do caminho `../docs/console.md`] → ajustar o caminho relativo ao novo local do teste e conferir `fs.allow` em `vite.config.ts`.
- [Reexports escondem a estrutura real no backend] → documentar o mapeamento em `docs/adr/001-camadas-e-crates.md` (ou ADR novo) e deixar o `lib.rs` comentado por contexto.
- [Revisão difícil de diff grande] → commits pequenos por grupo, sem mistura de renomeação e edição de lógica.

## Migration Plan

Não há migração de dados nem de deploy: o binário e a imagem resultantes são equivalentes. Reversão: `git revert` dos commits da change. O build do Docker usa `frontend/` e `backend/` inteiros, então não depende de caminhos internos.

## Open Questions

- Nomes finais das subpastas de `domain`/`application` (tabela da decisão 5) podem ser ajustados durante a aplicação sem alterar o escopo.
