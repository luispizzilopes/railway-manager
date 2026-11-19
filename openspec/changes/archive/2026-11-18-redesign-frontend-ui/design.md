## Context

O frontend é React 19 + react-router + TanStack Query, com CSS puro: `styles/tokens.css` (116 linhas) e um `styles/app.css` único de ~1500 linhas com seletores globais e dependências implícitas entre telas. Não há biblioteca de componentes; botões, campos, tabelas e chips são classes soltas. Os testes (Vitest + Testing Library) dependem de textos, papéis ARIA e alguns `data-testid`. Motivação e escopo em `proposal.md`; requisitos testáveis em `specs/`.

## Goals / Non-Goals

**Goals:**
- Identidade visual própria, sóbria e densa, coerente em todas as telas e nos dois temas.
- Componentes base reutilizáveis que tornam o consistente o caminho mais fácil.
- Fluxos de uso mais rápidos: filtros, paleta de comandos, feedback, teclado.
- Migração incremental, com o app funcional e os testes verdes a cada etapa.

**Non-Goals:**
- Mudar API, backend, modelo de dados ou regras de negócio.
- Adotar biblioteca de UI pronta (MUI, shadcn, Mantine) ou framework CSS utilitário.
- Redesenhar o console além de apresentação (comandos e parser ficam como estão).
- Internacionalização para outros idiomas.

## Decisions

**1. CSS puro com camadas (`@layer`) e arquivos por componente, sem nova biblioteca de estilo.**
Ordem de camadas: `reset, tokens, base, components, pages, utilities`. Cada componente tem seu CSS ao lado (`Button.css`) importado pelo próprio componente; páginas só compõem. Alternativas: Tailwind (adiciona toolchain e empurra classes utilitárias ao JSX, o que dificulta o vocabulário de componentes), CSS Modules (bom, mas o escopo por hash atrapalha estilizar estados via atributos e os testes), CSS-in-JS (custo de runtime sem ganho). Camadas dão previsibilidade de especificidade sem tooling novo.

**2. Tokens em duas camadas: primitivos e semânticos.**
Primitivos (`--gray-*`, `--accent-*`, `--green-*`…) em OKLCH; semânticos (`--surface`, `--text-muted`, `--border`, `--state-ok`, `--state-fail`, `--accent`) mapeados por tema. Componentes só consomem semânticos. Tema escolhido por `data-theme` no `<html>`, com padrão em `prefers-color-scheme`; um script inline mínimo no `index.html` aplica a escolha salva antes da primeira pintura (evita flash). Alternativa: duplicar folhas por tema (difícil de manter).

**3. Direção visual própria, afastada do Railway e dos clichês de IA.**
- Neutros levemente frios e superfícies planas; hierarquia por tipografia, espaçamento e linhas de 1 px, não por cartões com sombra.
- Um único destaque (azul-tinta, tom ~245) usado em ação primária, foco e seleção; roxo e gradientes saem.
- Cor semântica só para estado; estado sempre com texto e ícone.
- Fontes: IBM Plex Sans (interface) e IBM Plex Mono (dados), empacotadas via `@fontsource` (peso 400/500/600) e servidas pelo próprio build, sem CDN. Alternativa: manter Inter, descartada por ser a escolha padrão que faz a interface parecer genérica.
- Densidade de ferramenta de operação: linhas de 36 px, cabeçalhos de seção em tamanho de texto normal e peso 600, sem caixa-alta espaçada.
- Ícones de traço de 1.5 px do conjunto interno já existente, ampliado para os novos casos (estado, filtro, busca, tema, copiar).

**4. Estrutura de navegação e layout.**
Barra lateral recolhível (ícones + rótulos) com marca discreta, topo com paleta de comandos (Ctrl K) e alternância de tema; o conteúdo usa grade de largura máxima fluida, com cabeçalho de página padronizado (título, descrição, ações). No celular a barra vira navegação inferior. A paleta reaproveita a lista de telas e abre o console existente para comandos.

**5. Visão geral orientada a tarefa.**
Ordem: faixa de atenção (falhas, aguardando aprovação, desatualizados) → resumo de saúde compacto (barra segmentada + contagens em texto) → barra de busca/filtros → lista densa agrupada por projeto e ambiente, em tabela com colunas fixas e ações na linha. Filtros ficam em parâmetros de URL (compartilháveis e preservados ao navegar). O painel de saúde com orbe e o indicador pulsante da iteração anterior são removidos.

**6. Feedback e estados.**
Provedor de toasts (região `aria-live`), componente `Skeleton` e `EmptyState`/`ErrorState` com ação. Mutations usam um hook que liga estado de carregamento do botão, toast e invalidação de cache em um só lugar. Diálogos passam a usar o elemento `<dialog>` nativo (foco preso, Esc e `inert` do fundo de graça), mantendo a API atual de `Modal`.

**7. Acessibilidade verificável.**
Contraste dos pares semânticos checado por um teste que lê os tokens e calcula a razão (AA); linting de a11y no CI não é adicionado, mas os testes de componente consultam por papel e nome. Movimento reduzido tratado centralmente com `@media (prefers-reduced-motion)` nos tokens de duração.

**8. Estratégia de migração.**
Construir a base (tokens, reset, componentes) ao lado do CSS antigo, migrar tela a tela da mais simples (login) à mais complexa (agendas, detalhe do projeto) e apagar o CSS legado ao final. Cada etapa mantém `tsc`, `oxlint` e `vitest` verdes; `data-testid` e textos usados pelos testes são preservados ou os testes são atualizados no mesmo commit.

## Risks / Trade-offs

- [Escopo grande e risco de regressão visual] → migração por tela, com verificação manual em desktop e 360 px nos dois temas ao fim de cada tela; testes de comportamento existentes como rede de segurança.
- [Sem testes visuais automatizados] → checklist de revisão por tela nas tarefas; captura de telas anexada à revisão. Adicionar regressão visual fica fora do escopo.
- [Duas folhas de estilo coexistindo durante a migração] → camadas `@layer` com a base nova primeiro; regra de apagar o legado como tarefa final explícita.
- [Nova dependência de fontes] → pacotes `@fontsource` são estáticos, sem runtime; peso adicional do bundle aceitável (apenas 3 pesos por família, `font-display: swap`).
- [Gosto visual é subjetivo] → direção documentada aqui e validada com a primeira tela migrada (login + visão geral) antes de seguir para as demais.

## Migration Plan

1. Entregar base e visão geral; revisar a direção visual com o administrador.
2. Migrar as demais telas em PRs/commits separados.
3. Remover o CSS legado e conferir que nenhum seletor antigo restou.
4. Rollback: cada etapa é um commit isolado e reversível; não há migração de dados nem mudança de API.

## Open Questions

- Preferência final de cor de destaque (azul-tinta proposto) pode ser ajustada nos tokens sem afetar specs nem tarefas.
- Barra lateral recolhível: manter apenas expandida na primeira entrega se o ganho de espaço não justificar o custo.
