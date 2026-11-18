## Why

O frontend cresceu por camadas (tokens do Railway, responsividade, uma camada "de monitoramento") sem uma direção visual única. O resultado tem os vícios típicos de interface gerada por IA: roxo com brilhos e gradientes, orbe luminoso, rótulos em caixa-alta espaçada, pontos pulsantes, cartões iguais empilhados e hierarquia fraca. Isso passa pouca confiança para uma ferramenta que liga e desliga infraestrutura de produção. A aplicação precisa de uma identidade própria, sóbria e densa em informação, desenhada em torno de como o administrador realmente a usa: bater o olho no estado, achar o que está errado, agir com segurança.

## What Changes

- Definir uma **identidade visual própria** (não derivada do Railway): superfícies planas com linhas finas, uma única cor de destaque, cor reservada para significar estado, tipografia com fonte monoespaçada apenas para dados (IDs, nomes de serviço, números, horários). Sem brilhos, gradientes decorativos, orbes, animações pulsantes ou texto em caixa-alta espaçada.
- Criar um **sistema de design** em camadas: tokens semânticos (cor, espaço, tipo, raio, elevação, movimento), tema **claro e escuro** (segue o sistema, com troca manual) e uma biblioteca de componentes base (botão, campo, tabela, badge de estado, abas, diálogo, toast, estado vazio, esqueleto de carregamento) usada por todas as telas, no lugar do CSS global único de ~1500 linhas.
- **Redesenhar todas as telas**: login e escolha de modo, visão geral, projetos, detalhe do projeto, agendas, histórico, configurações, console (página, painel e modo CLI) e os fluxos modais de operação.
- **Reorientar a visão geral para o fluxo de trabalho**: problemas primeiro (falhas e dados desatualizados no topo), lista de serviços densa e filtrável (busca, estado, projeto), ações em massa claras, resumo de saúde discreto em vez de painel decorativo.
- **Melhorar a experiência de uso**: estados de carregamento, vazio e erro consistentes; feedback imediato (toasts) para ações; confirmações de ações destrutivas com o impacto explícito; navegação por teclado completa e paleta de comandos (Ctrl K) integrada ao console; foco visível; textos curtos e consistentes.
- **Acessibilidade como requisito**: contraste mínimo WCAG AA, estado nunca indicado só por cor, respeito a `prefers-reduced-motion` e alvos de toque adequados no celular.
- Remover os elementos decorativos adicionados na última iteração (painel de saúde com orbe, indicador pulsante, gradientes nos cartões).
- Sem alterações na API, no backend ou no comportamento funcional; a lógica de negócio e os `data-testid` existentes são preservados.

## Capabilities

### New Capabilities
- `ui-design-system`: requisitos de identidade visual, tokens, temas claro/escuro, componentes base, acessibilidade, responsividade e consistência de feedback (carregamento, vazio, erro, sucesso) válidos para todas as telas.

### Modified Capabilities
- `dashboard`: a visão geral passa a priorizar problemas, oferecer busca e filtros sobre os serviços e apresentar um resumo de saúde; os requisitos de indicadores, frescor e ações rápidas continuam valendo.

## Impact

- **Código**: `frontend/src/styles/*` (reescrita), `frontend/src/components/*` (novos componentes base e ajuste dos existentes), todas as páginas em `frontend/src/pages/*`, `console/Console.tsx` e `console/output.tsx` (somente apresentação).
- **Dependências**: nenhuma obrigatória; fontes servidas localmente (sem CDN) e CSS puro com variáveis (decisão detalhada no design).
- **API/backend/banco**: nenhum impacto.
- **Testes**: testes de componente existentes devem continuar passando; serão adicionados testes para tema, filtros da visão geral e navegação por teclado.
- **Premissas registradas**: o tema claro é desejado além do escuro; o idioma permanece pt-BR; o suporte principal é desktop, com uso confortável em celular (já existe aviso de incompatibilidade para o console no celular).
