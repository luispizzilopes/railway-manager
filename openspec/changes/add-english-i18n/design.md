## Context

Frontend React 19 + Vite + Vitest, sem nenhuma lib de i18n. Os textos pt-BR estão espalhados em ~10 mil linhas de TS/TSX: componentes, `shared/ui`, `useFeedbackMutation` (toast padrão de erro), `format.ts` (mapas de rótulo e `Intl` fixo em `pt-BR`), `ApiError` (usa `message` do backend) e o console (`features/console`, com descrições de comandos, ajuda e saídas). Os testes atuais fazem asserções sobre textos em pt-BR. O backend Rust devolve `{ code, message, details? }` com `message` em pt-BR. Motivação em proposal.md.

## Goals / Non-Goals

**Goals:**
- Fonte única de textos, com troca de idioma em tempo de execução.
- Menor esforço de migração e manutenção; pt-BR continua idêntico ao atual.
- Falhar cedo (teste) quando faltar chave ou sobrar texto fixo.

**Non-Goals:**
- Traduzir mensagens do backend, `docs/console.md`, README ou specs.
- Traduzir nomes de comandos/opções do console.
- Mais idiomas além de pt-BR e en (a estrutura permite adicionar depois).
- Carregamento preguiçoso de catálogos (dois JSONs pequenos entram no bundle).

## Decisions

1. **`i18next` + `react-i18next`** em vez de `react-intl`, `lingui` ou solução própria. É a mais usada, tem hook `useTranslation`, interpolação, plural (`_one/_other`) e tipagem das chaves via `CustomTypeOptions`, sem etapa de build/compilação (Lingui exige CLI/macros; react-intl é mais verboso). Detector de idioma próprio de ~15 linhas (localStorage `rm:lang` → `navigator.language` → `pt-BR`) em vez de `i18next-browser-languagedetector`, seguindo o padrão de `shared/lib/theme.ts` e evitando dependência extra.

2. **Catálogos em TypeScript/JSON em `src/shared/i18n/locales/{pt-BR,en}/<namespace>.json`**, um namespace por feature (`common`, `dashboard`, `projects`, `schedules`, `history`, `logs`, `users`, `settings`, `auth`, `console`, `errors`). Importados estaticamente (sem fetch). Chaves tipadas a partir do JSON `pt-BR` (fonte da verdade) para o `t()` acusar chave inexistente em tempo de compilação.

3. **Textos fora de componentes viram chaves, não strings.** Mapas como `STATE_LABEL`, `RESULT_LABEL`, `RUN_LABEL`, `DAY_LABEL` e o `ApiError` passam a produzir/consumir chaves e traduzir na renderização (`t(\`state.${s}\`)`) ou via `i18n.t` em código sem React (toasts, console, `format.ts`). `format.ts` ganha o locale ativo (`i18n.language`) nos `Intl.*` e usa `Intl.RelativeTimeFormat`/chaves para o tempo relativo.

4. **Erros da API: tradução por `code`.** `errors.<code>` no catálogo; `ApiError` expõe um `localizedMessage()` que usa `i18n.exists` e cai em `message` do backend, depois em `errors.generic`. Alternativa descartada: backend localizar via `Accept-Language` — exige mexer em Rust e ainda deixaria mensagens em strings dispersas.

5. **Console:** as definições de comando (`CommandSource`) não têm texto; `defineCommands` anexa `summary`, `details` e a ajuda de argumentos/opções como getters que leem o catálogo (`console:cmd.<caminho>`, com fallback para `opt.*`/`arg.*`), então acompanham o idioma ativo sem recriar o registro. Placeholders da gramática (`<seletor>`, `usage`, valores de opção), nomes de grupo usados como id, exemplos, apelidos e palavras aceitas como entrada (`amanhã`, `seg`…) não são traduzidos: são sintaxe, não texto de interface. A palavra de confirmação de `all` passa a vir do catálogo (`tudo`/`all`). Saídas e `CommandError` usam `i18n.t`. Nomes e opções não mudam, então parsing, autocomplete e `docs.test.ts` seguem iguais. Saídas já impressas no histórico do console permanecem no idioma em que foram geradas.

6. **Seletor de idioma** (`LanguageSwitcher` em `shared/components`), usado na topbar/menu "Mais", em Configurações e na tela de login. Troca chama `i18n.changeLanguage`, grava `rm:lang` e atualiza `document.documentElement.lang`. O script inline do `index.html` aplica `lang` antes da primeira pintura, como já faz com o tema.

7. **Guardas automáticas:** (a) teste de paridade de chaves entre catálogos; (b) teste que varre `src/**/*.tsx` (excluindo testes) procurando texto literal em JSX e em props de texto (`placeholder`, `title`, `aria-label`, `alt`) e falha com a lista; (c) testes rodam com i18n em `pt-BR` via `test/setup.ts`, preservando as asserções atuais, e há testes novos em `en`.

## Risks / Trade-offs

- [Migração grande e mecânica → regressão de texto em pt-BR] → manter pt-BR idêntico ao atual, migrar por feature com a suíte existente verde a cada passo.
- [Texto fixo voltar com o tempo] → teste de varredura (decisão 7b) no `npm test`; falsos positivos tratados com lista de exceções explícita (ex.: símbolos, nomes de marca).
- [Erros do backend sem `code` mapeado aparecem em pt-BR com UI em inglês] → fallback aceitável; códigos existentes em `backend/crates/api/src/error.rs` são todos mapeados em `errors.*`.
- [Plural/gênero em frases montadas por concatenação] → usar interpolação e plural do i18next, nunca concatenar fragmentos traduzidos.
- [Saídas antigas do console ficam no idioma antigo após a troca] → comportamento aceito e documentado.
