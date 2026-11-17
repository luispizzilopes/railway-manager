## Why

Hoje toda ação no Railway Manager exige navegar por telas, selecionar projetos e instâncias e confirmar modais — lento para tarefas frequentes como "desligar tudo no fim do dia" ou "religar tudo de manhã". Um console de comandos dentro do próprio frontend permite fazer em uma linha o que hoje leva vários cliques, com recursos que a UI não oferece (seletores com curinga, exclusões, ações pontuais com hora marcada, reinício em lote).

## What Changes

- Novo **console de comandos** no frontend: página `/console` e painel acionável por atalho de teclado em qualquer tela, com histórico de comandos, autocompletar (comandos, opções, projetos, serviços e ambientes), saída formatada e `--json`.
- Comandos que cobrem **tudo que a UI faz**: sessão, credencial, projetos (descobrir, importar, cadastrar, editar, sincronizar, remover), instâncias (descobrir, importar, associar, remover), visão geral/estados, ligar/desligar, acompanhamento de operações, histórico com filtros e agendas recorrentes (criar, editar, pausar, retomar, excluir, execuções).
- **Seletores de alvo** expressivos: `all`, `projeto`, `projeto/serviço`, `projeto/serviço@ambiente`, curingas `*`, `--env`, `--except` e filtro por estado — permitindo `stop all` e `start all`.
- **Reiniciar** (`restart`): desligar e depois ligar as mesmas instâncias, orquestrado pelo console (duas operações no histórico, sem mudança no backend).
- **Ações agendadas pontuais** (`stop all --at 18:00`, `start loja --in 2h`): nova entidade no backend, persistida, executada pelo agendador existente, listável e cancelável pelo console e pela tela de Agendas.
- **Simulação e confirmação**: todo comando que liga/desliga mostra o plano e pede confirmação; `--dry-run` só mostra o plano; `-y` pula a confirmação.
- **Apelidos** (`alias`) definidos pelo usuário e encadeamento de comandos com `;`.
- **Documentação** completa: `help` e `help <comando>` no console gerados do mesmo registro de comandos, e referência em `docs/console.md` com todos os comandos, opções, seletores e exemplos.
- Backend: novo alvo de operação `instances` (lista de instâncias de qualquer projeto em um único plano) e nova origem de operação `scheduled_action` no histórico.

## Capabilities

### New Capabilities
- `command-console`: console de comandos no frontend — sintaxe, seletores, comandos, confirmação, reinício orquestrado, histórico, autocompletar, apelidos e documentação.
- `scheduled-actions`: ações pontuais de ligar/desligar marcadas para um instante futuro, com alvo resolvido na hora da execução, cancelamento e recuperação limitada.

### Modified Capabilities
- `service-power-control`: o requisito "Escopos de operação" passa a aceitar um conjunto arbitrário de instâncias de vários projetos em uma única operação.
- `power-schedules`: o requisito "Registro de execuções e origem" passa a incluir a origem `scheduled_action` no histórico e no filtro por origem.

## Impact

- **Frontend**: novo módulo `src/console/` (parser, seletores, registro de comandos, renderizadores), página `Console`, painel global no `Layout`, atalho de teclado, seção "Ações agendadas" na página de Agendas; tipos e cliente para os novos endpoints. Sem novas dependências.
- **Backend**: alvo `instances` em `POST /api/operations/plan`; endpoints `/api/scheduled-actions` (criar, listar, obter, cancelar); migração com a tabela `scheduled_actions` e reconstrução de `operations` para aceitar `trigger = 'scheduled_action'`; `SchedulerService::tick` passa a processar ações pontuais.
- **Documentação**: `docs/console.md`, README e novo ADR sobre o console no cliente e as ações pontuais.
- **Compatibilidade**: nenhuma mudança incompatível na API; valores novos em enums (`trigger`, tipo de alvo) são aditivos.
