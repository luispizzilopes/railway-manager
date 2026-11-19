## 1. Infraestrutura de i18n

- [x] 1.1 Instalar `i18next` e `react-i18next` no frontend e verificar que `npm run typecheck` segue passando
- [x] 1.2 Criar `src/shared/i18n/` (init, detecção `rm:lang` → `navigator.language` → `pt-BR`, `changeLanguage` que grava `rm:lang` e atualiza `document.documentElement.lang`) e inicializar em `app/main.tsx`; verificar com teste unitário dos três cenários de detecção (salvo, `en-US`, `fr-FR`)
- [x] 1.3 Criar catálogos `locales/{pt-BR,en}/*.json` por namespace e tipar as chaves a partir do `pt-BR`; verificar que `t('chave.inexistente')` falha no typecheck
- [x] 1.4 Inicializar i18n em `pt-BR` em `test/setup.ts` e `test/utils.tsx` e verificar que a suíte atual continua verde
- [x] 1.5 Ajustar `index.html` para aplicar `lang` salvo antes da primeira pintura e verificar manualmente sem flash de idioma

## 2. Guardas automáticas

- [x] 2.1 Teste de paridade de chaves entre `pt-BR` e `en` (incluindo plurais); verificar que remover uma chave de `en` faz o teste falhar
- [x] 2.2 Teste de varredura que falha com a lista de arquivos com texto literal em JSX e em `placeholder`/`title`/`aria-label`/`alt` fora dos catálogos, com lista explícita de exceções; verificar que um literal de exemplo é detectado

## 3. Núcleo compartilhado

- [x] 3.1 Migrar `shared/lib/format.ts` (rótulos de estado/resultado/status/execução, dias, tempo relativo, duração) para chaves e `Intl` com o locale ativo; verificar com testes em `pt-BR` ("há 5 min") e `en` ("5 min ago")
- [x] 3.2 Migrar `shared/ui`, `shared/components` (Brand, ThemeToggle, CommandPalette, Modal, OperationFlow, StateChip) e `Layout`/menu "Mais"; verificar que os testes existentes passam
- [x] 3.3 Traduzir erros da API: `errors.<code>` para todos os `code` de `backend/crates/api/src/error.rs`, `ApiError` com fallback para `message` e depois `errors.generic`, e `useFeedbackMutation` usando isso; verificar com testes de código conhecido, desconhecido e `validation` (mantém `message`)
- [x] 3.4 Criar `LanguageSwitcher` e posicioná-lo na topbar/menu "Mais" mobile, em Configurações e no login; verificar com teste que a troca atualiza os textos sem recarregar

## 4. Migração das features (uma por vez, suíte verde a cada uma)

- [x] 4.1 `auth` (Login, ModeChooser) e `settings`; verificar testes existentes e que o texto não está mais no componente
- [x] 4.2 `dashboard`; verificar testes existentes
- [x] 4.3 `projects` (lista e detalhe); verificar testes existentes
- [x] 4.4 `schedules` (inclui validações, resumos de dias e plural); verificar testes existentes
- [x] 4.5 `history` e `logs`; verificar `npm test`
- [x] 4.6 `users`; verificar testes de papéis (`roles.test.tsx`)

## 5. Console

- [x] 5.1 Trocar descrições de comandos/opções por chaves (`descriptionKey`) e gerar a ajuda traduzindo em tempo de renderização; verificar que `docs.test.ts` segue verde (nomes inalterados)
- [x] 5.2 Migrar saídas, `CommandError`, dicas e textos de `Console`/`ConsolePage`/`output.tsx`/`time.ts` para `i18n.t`; verificar `Console.test.tsx` e `commands.test.ts`
- [x] 5.3 Teste de que `help` em `en` mostra descrições em inglês e os mesmos nomes de comando

## 6. Inglês e verificação final

- [x] 6.1 Preencher o catálogo `en` completo (sem copiar texto pt-BR) e verificar que o teste de paridade passa
- [x] 6.2 Adicionar testes em `en` para ao menos login, dashboard, um toast de sucesso e um erro da API
- [x] 6.3 Rodar `npm run typecheck`, `npm run lint`, `npm test` e `npm run build`, e navegar pelas telas principais nos dois idiomas conferindo textos, datas e toasts
