## 1. Fundação do sistema de design

- [x] 1.1 Adicionar fontes IBM Plex Sans/Mono via `@fontsource` (400/500/600) e importá-las no ponto de entrada; verificar com `npm run build` que as fontes saem no bundle sem requisições externas
- [x] 1.2 Criar `styles/` em camadas (`reset`, `tokens`, `base`, `utilities`) com tokens primitivos e semânticos em OKLCH para tema claro e escuro; verificar que o app compila e as telas atuais continuam renderizando
- [x] 1.3 Implementar seleção de tema (`data-theme`, padrão do sistema, persistência) e o script inline anti-flash no `index.html`; verificar com teste de unidade que preferência salva vence o sistema
- [x] 1.4 Escrever teste que calcula a razão de contraste dos pares semânticos de texto/fundo e estado/fundo nos dois temas e falha abaixo de AA (4.5:1)
- [x] 1.5 Definir tokens de movimento e regra central de `prefers-reduced-motion`; verificar inspecionando que nenhuma animação contínua existe no CSS novo

## 2. Componentes base

- [x] 2.1 Criar `Button` (primário, secundário, perigo, fantasma; tamanhos; carregando/desabilitado) com testes de variantes e de bloqueio de clique duplo
- [x] 2.2 Criar `Field`, `Input`, `Select`, `Checkbox`, `RadioGroup` com rótulo, dica e erro associados por ARIA; testar associação rótulo-campo e `aria-invalid`
- [x] 2.3 Criar `StatusBadge` com ícone + texto + cor para todos os estados observados, substituindo `StateChip`; testar que cada estado tem texto e ícone distintos
- [x] 2.4 Criar `Table` densa (cabeçalho fixo opcional, colunas numéricas tabulares, linha selecionável) e `Tabs`; testar navegação por teclado nas abas
- [x] 2.5 Reescrever `Modal` sobre `<dialog>` mantendo a API atual; testar foco inicial, retorno do foco e fechamento por Esc
- [x] 2.6 Criar `ToastProvider` (região `aria-live`), `Skeleton`, `EmptyState` e `ErrorState` com ação de tentar novamente; testar aparecimento e remoção automática do toast
- [x] 2.7 Criar hook de mutation com feedback (estado do botão + toast + invalidação) e aplicá-lo em um fluxo piloto; verificar com teste que não há envio duplicado
- [x] 2.8 Estender o conjunto de ícones (estado, filtro, busca, tema, copiar, chevron) e verificar visualmente em ambos os temas

## 3. Estrutura da aplicação

- [x] 3.1 Reescrever `Layout`: barra lateral, topo com alternância de tema, cabeçalho de página padronizado e navegação inferior no celular; verificar em 360 px e em desktop sem rolagem horizontal
- [x] 3.2 Implementar a paleta de comandos (Ctrl K) para navegar entre telas e abrir o console; testar abertura, filtro por digitação e navegação com Enter
- [x] 3.3 Garantir foco visível e ordem de tabulação na estrutura; testar com Testing Library a ordem dos primeiros elementos focáveis

## 4. Telas de entrada

- [x] 4.1 Redesenhar `Login` e `ModeChooser` com os componentes base; verificar que os testes de login existentes passam
- [ ] 4.2 Validar a direção visual com o administrador (login + visão geral) antes de migrar as demais telas

## 5. Visão geral

- [x] 5.1 Remover o painel de saúde decorativo e o indicador pulsante; criar a faixa "Requer atenção" (falhas, aguardando aprovação, desatualizados, indisponíveis) e verificar com teste de componente
- [x] 5.2 Criar o resumo de saúde compacto (barra segmentada + contagens em texto) e testar as proporções do cenário da spec
- [x] 5.3 Implementar busca por nome e filtros de estado, projeto e ambiente em parâmetros de URL, com contagem de resultados e "limpar filtros"; testar filtros combinados e o estado sem resultados
- [x] 5.4 Reconstruir a lista de serviços como tabela densa por projeto/ambiente, com `StatusBadge`, frescor em texto e ações na linha; verificar que os testes do dashboard (frescor, ações desabilitadas sem credencial, indicadores) passam
- [x] 5.5 Aplicar esqueleto de carregamento, estado vazio e estado de erro com nova tentativa; testar cada um

## 6. Demais telas

- [x] 6.1 Redesenhar `Projects` (importação e seleção) com tabela, filtros e estados vazios; verificar testes de formulários e projetos
- [x] 6.2 Redesenhar `ProjectDetail` com abas (serviços, ambientes, agendas) e ações destrutivas confirmadas com impacto explícito; testar o diálogo de confirmação
- [x] 6.3 Redesenhar `Schedules` (lista e formulário de agenda/ação pontual) com a nova grade de campos; verificar `Schedules.test.tsx`
- [x] 6.4 Redesenhar `History` com filtros, tabela densa e detalhe expansível; verificar `History.test.tsx`
- [x] 6.5 Redesenhar `Settings` (token, senha, preferências incluindo tema) com feedback por toast; verificar `Settings.test.tsx`
- [x] 6.6 Redesenhar `OperationFlow` (plano, progresso, resultado) com linha do tempo por item; verificar `OperationFlow.test.tsx`
- [x] 6.7 Redesenhar o console (página, painel e modo CLI) apenas na apresentação, mantendo a fonte monoespaçada; verificar `Console.test.tsx` e `commands.test.ts`

## 7. Fechamento

- [x] 7.1 Revisar todos os textos da interface para vocabulário único e mensagens de erro acionáveis; verificar com busca no código que não restam sinônimos de "serviço", "projeto" e "agenda"
- [x] 7.2 Remover o CSS legado (`app.css`) e confirmar com busca que nenhum seletor antigo é referenciado
- [ ] 7.3 Passar por cada tela em 360 px, 768 px e desktop nos temas claro e escuro, e com movimento reduzido ativado; registrar o resultado
- [x] 7.4 Rodar `npm run typecheck`, `npm run lint`, `npm test` e `npm run build` e confirmar que passam
- [x] 7.5 Atualizar `README`/docs com a descrição do sistema de design e como adicionar componentes
