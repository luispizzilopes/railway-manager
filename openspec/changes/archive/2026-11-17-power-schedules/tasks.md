## 1. Domínio da agenda

- [x] 1.1 Adicionar `chrono-tz` ao `domain` e modelar `Schedule`, `Window`, `Weekdays`, `ScheduleTarget` e `ScheduleAction` com validação (nome, dias, janelas, duração zero, fuso IANA); verificar com testes unitários de construção inválida e `cargo tree -p domain` ainda sem crates de I/O
- [x] 1.2 Implementar detecção de sobreposição de janelas num ciclo de 7 dias (inclui janelas que atravessam a meia-noite e domingo → segunda); verificar com teste de tabela (07–12 × 11–15 conflita, 07–12 × 13–18 não, 22–02 × 01–03 conflita)
- [x] 1.3 Implementar `occurrences(schedule, from, to)` e `next_occurrences(schedule, now, n)` em UTC a partir do fuso local, com regras de DST (horário inexistente → primeiro instante válido; ambíguo → primeira ocorrência); verificar com testes dos cenários da spec (duas janelas, meia-noite, próximas 5 numa sexta 10:00) e de gap/overlap em `America/New_York`
- [x] 1.4 Implementar a seleção de eventos de um tick (intervalo `(desde, agora]`, `effective_from`, mais recente executa se dentro do limite, anteriores `missed`) e a resolução de conflito start × stop no mesmo instante; verificar com testes unitários dos cenários "volta dentro do limite", "volta fora do limite" e "iniciar prevalece"
- [x] 1.5 Adicionar `OperationTrigger::Schedule` e os campos de origem (`schedule_id`, `schedule_name`) em `Operation`; verificar com teste de roundtrip dos enums

## 2. Persistência

- [x] 2.1 Criar migração com `schedules`, `schedule_windows`, `schedule_instances`, `schedule_runs` (único por agenda+horário+ação) e `scheduler_state`; verificar com `sqlx migrate run` em banco novo e teste de FKs/cascatas (remover projeto remove agendas; remover instância sai da agenda)
- [x] 2.2 Criar migração `-- no-transaction` que reconstrói `operations` aceitando `trigger = 'schedule'` com `schedule_id`/`schedule_name`, seguindo o procedimento oficial do SQLite; verificar com teste que aplica a migração sobre um banco com operações e itens existentes e confere que nada foi apagado e `PRAGMA foreign_key_check` está limpo
- [x] 2.3 Implementar `ScheduleRepository` (CRUD, janelas, instâncias, pausa com motivo, `effective_from`) e `ScheduleRunRepository` (inserção idempotente, atualização, listagem paginada, `pending` → `failed` na inicialização) e o estado do agendador; verificar com testes em SQLite em memória, incluindo inserção duplicada ignorada
- [x] 2.4 Gravar e ler a origem nas operações e adicionar filtro `trigger` ao histórico; verificar com teste de repositório que filtra por `schedule` e mantém o nome da agenda após excluí-la

## 3. Casos de uso

- [x] 3.1 `ScheduleService`: criar, editar, pausar, retomar, excluir e listar agendas com próximas execuções e avisos (sobreposição com outras agendas ativas que compartilham instâncias; janela menor que `RM_START_TIMEOUT_SECS`); editar e retomar atualizam `effective_from`; verificar com testes usando SQLite em memória
- [x] 3.2 Pausar automaticamente agendas de instâncias selecionadas que ficaram sem alvo (motivo "sem instâncias no alvo"); verificar com teste que remove a única instância e confere a pausa
- [x] 3.3 Estender `PowerService` com execução de origem `schedule` (escopo `project`, `requested_by = "agendador"`, sem alterar o fluxo manual); verificar com teste que a operação gravada tem origem e agenda e que conflito vira `skipped`
- [x] 3.4 `SchedulerService::tick(now)`: avaliar agendas, gravar runs e `last_evaluated_at` numa transação, executar via `PowerService`, registrar `executed`/`late`/`skipped`/`missed`/`failed`; verificar com `FakeRailway` e relógio passado por parâmetro cobrindo: evento no horário, sem duplicação após "reinício", catch-up dentro/fora do limite, pausa sem recuperação, agenda sem credencial (`failed`, nada enviado), conflito entre agendas e instância em operação manual

## 4. Servidor e API

- [x] 4.1 Ler `RM_SCHEDULE_TIMEZONE`, `RM_SCHEDULE_CATCHUP_SECS` e `RM_SCHEDULER_TICK_SECS` com validação e documentar em `.env.example`; verificar com testes de configuração (fuso inválido encerra com mensagem clara)
- [x] 4.2 Iniciar o worker do agendador no `server` (tick periódico, marcar runs `pending` órfãos como `failed` ao subir, parar no desligamento gracioso); verificar com teste que sobe o estado completo e observa um tick processando um evento
- [x] 4.3 Rotas `/api/schedules` (CRUD, pause/resume, runs paginados) com `400` e `details.conflicts` na validação, `warnings` e `next_runs` nas respostas; verificar com testes HTTP
- [x] 4.4 `trigger` em `/api/history` e `next_action` por projeto em `/api/dashboard`; verificar com testes HTTP do filtro e do cenário "Desligar às 18:00" da spec

## 5. Frontend

- [x] 5.1 Tipos e cliente para agendas; item "Agendas" na navegação e tela de lista (projeto, alvo, dias, janelas, próxima execução, ativa/pausada com alternância); verificar com `npm run typecheck` e teste de componente da lista
- [x] 5.2 Editor de agenda em modal (projeto, alvo projeto/ambiente ou instâncias, fuso com os comuns + busca, dias como botões, janelas com adicionar/remover e `input type=time`), exibindo erros de validação e avisos do backend; verificar com testes de componente (sobreposição exibida, nada enviado com formulário inválido)
- [x] 5.3 Detalhe da agenda com próximas 5 e últimas execuções (situação e link para a operação); verificar com teste de componente
- [x] 5.4 Próxima ação agendada no card do projeto na visão geral e filtro "Origem" no histórico; verificar com testes de componente e `npm run build`

## 6. Documentação e verificação final

- [x] 6.1 Atualizar README (agendas, variáveis novas, comportamento "age só nos horários", catch-up, backup do banco antes de atualizar) e escrever ADR-006 (agendador por varredura e exatamente-uma-vez); verificar presença e links
- [x] 6.2 Executar `scripts/check.sh` (backend e frontend); verificar que tudo passa
- [x] 6.3 Validação manual com projeto descartável: agenda com duas janelas próximas (minutos à frente), observar iniciar/desligar no horário, reiniciar o servidor no meio e conferir catch-up e ausência de duplicação no histórico; registrar o resultado
