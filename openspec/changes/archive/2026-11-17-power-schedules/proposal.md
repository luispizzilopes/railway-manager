## Why

Hoje o Railway Manager só liga e desliga serviços quando alguém clica. O objetivo original do projeto — economizar mantendo serviços ligados apenas nos horários de uso — depende de agendamento, e o template cron legado que fazia isso foi removido. É preciso que o próprio Manager ligue e desligue projetos inteiros ou serviços específicos em horários definidos pelo usuário, com mais de uma janela por dia (ex.: ligado das 7h às 12h e das 13h às 18h).

## What Changes

- Nova entidade **agenda**: nome, ativa/pausada, fuso horário, dias da semana e uma ou mais **janelas** (horário de início e de fim). Cada janela gera dois eventos: *iniciar* no início e *desligar* no fim.
- Alvo da agenda: **projeto inteiro** (todas as instâncias gerenciadas, opcionalmente só de um ambiente; instâncias adicionadas depois entram automaticamente) ou **instâncias selecionadas** de um projeto.
- Um **agendador** em segundo plano no backend avalia as agendas e, em cada evento, executa a operação pelo mesmo fluxo das operações manuais (plano → execução → verificação), com as mesmas regras de idempotência, concorrência, conflitos e escolha do deployment a reaproveitar.
- **Age só nos horários**: entre um evento e outro o agendador não interfere; ações manuais continuam valendo até o próximo evento.
- **Execução atrasada com limite**: se o servidor estava fora do ar no horário, ao voltar executa o evento perdido mais recente de cada agenda se ele tiver ocorrido há até `RM_SCHEDULE_CATCHUP_SECS` (padrão 30 min); os demais ficam registrados como perdidos. Cada evento é executado no máximo uma vez.
- Histórico: operações passam a registrar a **origem** (`manual` ou `schedule`) e a agenda que as disparou; o histórico ganha filtro por origem, e cada agenda mostra suas últimas execuções.
- Interface: tela de **Agendas** (criar, editar, pausar, excluir, ver próximas execuções e últimas execuções) e indicação, na visão geral, da próxima ação agendada de cada projeto.
- Validação: janelas de uma mesma agenda não podem se sobrepor; horários e fuso são validados; pelo menos um dia e uma janela.

## Capabilities

### New Capabilities
- `power-schedules`: agendas de ligar/desligar por projeto ou instâncias, com janelas múltiplas, dias da semana e fuso; execução automática no horário, recuperação limitada de eventos perdidos, conflitos entre agendas e com operações manuais, registro de execuções e exibição de próximas ações.

### Modified Capabilities
<!-- As capacidades `service-power-control`, `operation-audit` e `dashboard` vêm da change
     `railway-manager`, ainda não arquivada (openspec/specs/ está vazio). Os ajustes nelas
     (origem `schedule` nas operações, filtro por origem no histórico, próxima ação no
     dashboard) estão descritos como requisitos de `power-schedules` para não depender de
     specs base inexistentes. -->

## Impact

- **Backend**: domínio (agenda, janela, cálculo de eventos e próximas execuções com fuso e DST), novo caso de uso de agendas, worker do agendador iniciado pelo `server`, `OperationTrigger::Schedule`, migração SQLite (novas tabelas e reconstrução de `operations` para aceitar `trigger = 'schedule'` e `schedule_id`).
- **API**: `/api/schedules` (CRUD, pausar/retomar, próximas e últimas execuções); `/api/history` com filtro `trigger`; `/api/dashboard` com próxima ação por projeto.
- **Frontend**: tela Agendas, editor de janelas e dias, indicação de próxima ação na visão geral, filtro de origem no histórico.
- **Dependências**: `chrono-tz` (fusos IANA).
- **Configuração nova**: `RM_SCHEDULE_TIMEZONE` (fuso padrão, `America/Sao_Paulo`), `RM_SCHEDULE_CATCHUP_SECS` (padrão `1800`), `RM_SCHEDULER_TICK_SECS` (padrão `30`).
- **Railway API**: cada evento consome as mesmas chamadas de uma operação manual equivalente; agendas com muitas instâncias aumentam o uso do rate limit nos horários de evento.
- **Depende** da change `railway-manager` (operações de energia, histórico, dashboard).
