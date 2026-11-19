# Sistema de design do frontend

Identidade visual própria e sóbria: superfícies planas com linha fina, uma cor de destaque (azul-tinta) para ações e foco, e cor semântica **só** para estado (ok, atenção, falha, informação). Sem brilhos, gradientes decorativos, animações contínuas nem rótulos em caixa-alta espaçada. Fonte proporcional (IBM Plex Sans) para a interface e monoespaçada (IBM Plex Mono) apenas para dados: nomes de serviço, IDs, números e horários.

## Marca e ícones

- **Marca**: só o nome em texto (`shared/components/Brand.tsx`); não há logo nem favicon.
- **Ícones** (`shared/components/Icon.tsx`): Phosphor (`@phosphor-icons/react`, peso regular). Para um novo ícone, importe o glifo e registre-o em `ICONS`; os ícones de estado do `StatusBadge` são desenhos próprios, com formas distintas.

## Estrutura

```
frontend/src/styles/
  index.css     ordem das camadas e dos imports (a ordem define a cascata: não reordene)
  tokens.css    tokens semânticos dos temas claro e escuro (valores em OKLCH)
  base.css      reset, tipografia, painéis (.card) e utilitários
frontend/src/app/layout.css, mobile.css          layout da aplicação e regras de celular
frontend/src/features/<tela>/*.css               CSS de cada tela (dashboard, projects, auth, history, console, logs)
frontend/src/shared/components/*.css             CSS de componentes compartilhados (paleta de comandos, andamento de operação)
frontend/src/shared/ui/                          componentes base, cada um com o próprio CSS em `@layer components`
```

## Regras

- **Componentes só usam tokens semânticos** (`--surface`, `--text-2`, `--accent`, `--ok`, `--fail`…), nunca valores soltos. Trocar a cor de destaque ou o tema é mudar `tokens.css`.
- **Tema**: `data-theme` no `<html>`. Segue o sistema; a escolha manual fica em `localStorage` (`rm:theme`) e o script do `index.html` a aplica antes da primeira pintura. Lógica em `src/shared/lib/theme.ts`.
- **Contraste**: `src/styles/contrast.test.ts` lê `tokens.css` e exige WCAG AA (4,5:1) nos pares de texto/fundo e estado/fundo de ambos os temas. Ao criar um token de texto ou estado, inclua o par na lista do teste.
- **Estado nunca só por cor**: `StatusBadge` combina cor, ícone de forma própria e texto.
- **Movimento**: apenas transições curtas; `prefers-reduced-motion` desativa tudo centralmente.

## Componentes base (`shared/ui`)

| Componente | Uso |
| --- | --- |
| `Button` | `variant` primary/secondary/danger/ghost, `size` md/sm, `loading` (desabilita e evita envio duplicado) |
| `Field` + `Input`/`Select`/`Textarea` | rótulo, dica e erro ligados ao controle por ARIA; `Checkbox`, `RadioGroup` |
| `StatusBadge` | estado observado do serviço |
| `Table` | tabela densa com rolagem horizontal contida; colunas numéricas com `className="num"` |
| `Tabs` | abas com setas, Home e End |
| `Modal` / `ConfirmDialog` (`shared/components/Modal.tsx`) | sobre `<dialog>`: foco preso, Esc, foco devolvido a quem abriu |
| `ToastProvider` / `useToast` | avisos não bloqueantes (`aria-live`) |
| `Skeleton`, `EmptyState`, `ErrorState` | carregamento, vazio e erro com "Tentar novamente" |

`useFeedbackMutation` (`shared/components/useFeedbackMutation.ts`) é a forma padrão de chamar a API a partir de uma ação: liga o estado do botão, o aviso de sucesso/erro e a invalidação das consultas.

## Adicionar um componente

1. Criar `shared/ui/Nome.tsx` e `Nome.css` (todo o CSS dentro de `@layer components { … }`, só com tokens semânticos).
2. Cobrir os estados (padrão, foco, desabilitado, carregando, erro) e escrever o teste em `ui.test.tsx` consultando por papel e nome.
3. Exportar em `shared/ui/index.ts`.

## Atalhos

`Ctrl+K` abre a paleta de comandos (telas, console, tema, modo CLI); `Ctrl+`` abre o painel do console. Na página do console e no modo CLI, `Ctrl+K` apenas leva o foco à linha de comando.
