## Why

A interface do Railway Manager tem todos os textos escritos diretamente em pt-BR nos componentes, páginas, toasts, console e rótulos de formatação. Isso impede o uso por quem não lê português e torna qualquer ajuste de texto uma caça por arquivos. Queremos suporte a inglês e uma única fonte para todos os textos visíveis.

## What Changes

- Adicionar `i18next` + `react-i18next` ao frontend (a opção mais difundida, com interpolação, plural e tipagem de chaves prontos) e inicializá-las em `app/main.tsx`.
- Criar catálogos de tradução `pt-BR` e `en` (um JSON por idioma, organizado por namespace de feature) e **mover para eles todo texto visível**: páginas, componentes, `shared/ui`, toasts (`useFeedbackMutation`), diálogos, placeholders, `aria-label`s, títulos, mensagens de validação, rótulos de `format.ts` e textos do console (ajuda, saídas e erros).
- Adicionar seletor de idioma (topbar/menu "Mais" no mobile e em Configurações). A escolha persiste no navegador (`rm:lang`); sem escolha, usa o idioma do navegador, com `pt-BR` como fallback.
- Formatação de datas, horas, números e duração passa a seguir o idioma ativo (`Intl` com o locale selecionado); `<html lang>` acompanha o idioma.
- Mensagens de erro da API: o frontend traduz por `code` (`ApiError.code`) e usa `message` do backend apenas como fallback para códigos sem tradução. O backend não muda.
- Impedir regressão: teste/lint que falha se houver literal de texto de usuário em JSX fora dos catálogos, e teste que garante paridade de chaves entre `pt-BR` e `en`.
- Testes existentes passam a rodar com i18n inicializado em `pt-BR` (asserções atuais continuam válidas).

## Capabilities

### New Capabilities
- `internationalization`: idioma selecionável (pt-BR e en), detecção/persistência da escolha, textos e formatações vindos exclusivamente dos catálogos, tradução de erros da API por código e proteções contra texto fixo e chaves faltantes.

### Modified Capabilities

## Impact

- `frontend/package.json`: novas dependências `i18next` e `react-i18next`.
- `frontend/src`: praticamente todos os componentes (≈10 mil linhas de TS/TSX), `shared/lib/format.ts`, `shared/api/client.ts`, `features/console/**`, `index.html` (`lang`), `test/**`.
- Novos arquivos: `frontend/src/shared/i18n/` (setup, hook de idioma, catálogos `pt-BR` e `en`).
- Backend (Rust) inalterado; mensagens de erro do backend continuam em pt-BR e aparecem apenas como fallback.
- `docs/console.md` continua em pt-BR (o teste de consistência com o registro de comandos depende dele); nomes de comandos e flags do console não são traduzidos.
